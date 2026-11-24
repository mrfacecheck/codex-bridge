import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, execFileSync, spawnSync } from "child_process";
import { connect as tcpConnect } from "net";
import {
  existsSync, statSync, readFileSync, mkdirSync, openSync, closeSync,
  rmSync, readdirSync, writeFileSync, unlinkSync,
} from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import {
  isTerminal, statusToPhase, DEFAULT_IDLE_ATTENTION, DEFAULT_IDLE_TIMEOUT,
  EMPTY_TREE_OID, RECENT_RUN_LOOKUP_LIMIT, ACTIVE_SESSION_SCAN_LIMIT,
  type RunMeta, type ProgressState, type RunHandle, type RunHandleStatus,
  type Session, type ReviewPacketLike, type WorkspaceMeta,
} from "./types.js";
import {
  BASE_DIR, RUNS_DIR, WT_DIR,
  claimIdempotency, releaseUnstartedIdempotency, requestDigest,
  acquireLease, checkLeaseConflictSync, readStartedRecord, readRunSessionRecord,
  readWorkspaceMeta, updateWorkspaceMeta, listWorkspaceMetas, workspaceDir,
  readSessionRecord, findPendingAppliesForTarget, listApplyIntents, resourceKey,
  probePidLivenessAsync, commandMatchesWorker, commandMatchesCodex,
} from "./state.js";
import {
  CODEX_BINARY, CODEX_BINARY_REALPATH, buildCodexEnv, buildGitEnv, normalizeCwd,
  resolveExecContext, acquireWriteLock, checkWriteLockConflict, exportWorktreePatch,
  createSnapshotWorkspace, captureTreeIntoEvidence, computeThreeWayMerge,
  planTreeMaterialization, prepareApplyIntent, executeOrRecoverApplyIntent,
  cmdOk, cleanOldTmpDirs, killPidTree,
} from "./evidence.js";
import {
  createRunDir, writeRunMeta, readRunMeta, readProgress, readProgressEventsSince,
  readReviewPacket, writeReviewPacket, pollForCompletion, waitForRuns,
  updateProjectPointer, getRunDir, runDirExists, listRuns, cleanOldRuns,
  requestCancel, reconcileRunAsync, reconcileRunSync, assertRunId,
  updateProgress as updateProgressFile, getLatestRunForSession, durableStateStats,
} from "./progress.js";
import { GrantRejection, normalizeGrants, resolveMcpHome, ensureDarwinNoBrowserRules, probeCodexCapabilities } from "./grants.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_EXT = path.extname(__filename); // ".ts" in dev, ".js" in compiled
const WORKER_SCRIPT = path.join(__dirname, `worker${WORKER_EXT}`);

const PKG_VERSION: string = (() => {
  try { return JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version; }
  catch { return "0.0.0"; }
})();

const DEFAULT_WAIT_BUDGET = 60;
const MAX_WAIT_BUDGET = 240;
const MAX_CLIENT_WAIT_SECONDS = (() => {
  const raw = Number(process.env.CODEX_BRIDGE_MAX_WAIT_SECONDS);
  if (Number.isFinite(raw) && raw >= 10 && raw <= 600) return Math.floor(raw);
  return MAX_WAIT_BUDGET;
})();

const CONFIGURED_DEFAULT_IDLE_TIMEOUT: number | null = (() => {
  const raw = process.env.CODEX_BRIDGE_DEFAULT_IDLE_TIMEOUT;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(7200, Math.max(10, Math.floor(n)));
})();

const CONFIGURED_DEFAULT_IDLE_ATTENTION: number | null = (() => {
  const raw = process.env.CODEX_BRIDGE_DEFAULT_IDLE_ATTENTION;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_ATTENTION;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_ATTENTION;
  if (n === 0) return null;
  return Math.min(7200, Math.max(10, Math.floor(n)));
})();

function clampWaitSeconds(requested: number): number {
  return Math.max(0, Math.min(requested, MAX_CLIENT_WAIT_SECONDS));
}

function resolveWallTimeout(requested?: number | null): number | null {
  if (requested === undefined || requested === null || requested === 0) return null;
  return requested;
}

function resolveIdleTimeout(requested?: number | null, inherited?: number | null): number | null {
  if (requested !== undefined) return requested === null || requested === 0 ? null : requested;
  if (inherited !== undefined) return inherited === null || inherited === 0 ? null : inherited;
  return CONFIGURED_DEFAULT_IDLE_TIMEOUT;
}

function resolveIdleAttention(requested?: number | null, inherited?: number | null): number | null {
  if (requested !== undefined) return requested === null || requested === 0 ? null : requested;
  if (inherited !== undefined) return inherited === null || inherited === 0 ? null : inherited;
  return CONFIGURED_DEFAULT_IDLE_ATTENTION;
}

function cleanupFailedRunSetup(runDir: string, wsId?: string, legacyGitRoot?: string | null, legacyWtPath?: string) {
  if (wsId) {
    try { rmSync(workspaceDir(wsId), { recursive: true, force: true }); } catch {}
  } else if (legacyWtPath && legacyGitRoot) {
    try { spawnSync("git", ["-C", legacyGitRoot, "worktree", "remove", "--force", legacyWtPath], { encoding: "utf8", env: buildGitEnv() }); } catch {}
    try { rmSync(legacyWtPath, { recursive: true, force: true }); } catch {}
  }
  try { rmSync(runDir, { recursive: true, force: true }); } catch {}
}

function isBridgeHomeWritable(): boolean {
  try {
    mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
    const probe = path.join(BASE_DIR, `.doctor-write-probe.${process.pid}.${Date.now()}`);
    writeFileSync(probe, "ok\n", { mode: 0o600 });
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function countActiveWorkspaces(): number {
  let count = 0;
  for (const ws of listWorkspaceMetas()) {
    if (!ws.cleanedAt && existsSync(ws.srcDir)) count++;
  }
  try {
    if (existsSync(WT_DIR)) {
      count += readdirSync(WT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    }
  } catch {}
  return count;
}

// ── Network Probe ────────────────────────────────────────────────
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = tcpConnect({ host, port, timeout: timeoutMs });
    sock.on("connect", () => { sock.destroy(); resolve({ reachable: true, latencyMs: Date.now() - t0 }); });
    sock.on("timeout", () => { sock.destroy(); resolve({ reachable: false, latencyMs: Date.now() - t0, error: "timeout" }); });
    sock.on("error", (e: Error) => { sock.destroy(); resolve({ reachable: false, latencyMs: Date.now() - t0, error: e.message }); });
  });
}

// ── Codex model/effort resolution ────────────────────────────────
function readCodexConfigKey(key: string): string | null {
  try {
    const home = process.env.CODEX_HOME || path.join(process.env.HOME ?? "", ".codex");
    const txt = readFileSync(path.join(home, "config.toml"), "utf8");
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
    return m ? m[1] : null;
  } catch { return null; }
}

let cachedCodexVersion: string | undefined;
function resolveCodexRunConfig(model?: string, effort?: string) {
  const cfgModel = readCodexConfigKey("model");
  const cfgEffort = readCodexConfigKey("model_reasoning_effort");
  if (cachedCodexVersion === undefined) {
    const v = cmdOk(CODEX_BINARY, ["--version"], { env: buildCodexEnv(), timeout: 10_000 });
    cachedCodexVersion = v.ok ? v.output : undefined;
  }
  return {
    resolvedModel: model ?? cfgModel,
    modelSource: (model ? "flag" : cfgModel ? "config" : "unknown") as "flag" | "config" | "unknown",
    resolvedEffort: effort ?? cfgEffort,
    effortSource: (effort ? "flag" : cfgEffort ? "config" : "unknown") as "flag" | "config" | "unknown",
    codexVersion: cachedCodexVersion,
  };
}

// ── MCP Response Helpers ─────────────────────────────────────────
function toolJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
function toolError(message: string, details?: unknown) {
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: message, details }, null, 2) }] };
}

// ── In-memory session cache (purely rebuildable from disk) ───────
const byRunId = new Map<string, Session>();
const byCodexId = new Map<string, Session>();
function lookupMemory(id: string) { return byCodexId.get(id) || byRunId.get(id); }

function sessionFromRun(runId: string): Session | undefined {
  const runDir = getRunDir(runId);
  const meta = readRunMeta(runDir);
  if (!meta) return undefined;
  const progress = readProgress(runDir);
  const review = readReviewPacket(runDir) as ReviewPacketLike | null;
  if (review?.resume_attached === false) return undefined;
  const sessionId = review?.session_id || readRunSessionRecord(runDir)?.sessionId || progress?.sessionId;
  const status: Session["status"] = (review?.status as Session["status"]) || (progress?.status as Session["status"]) || "running";
  return {
    latestRunId: runId, runIds: [runId], sessionId,
    name: meta.sessionName, status, cwd: meta.cwd,
    gitRoot: meta.gitRoot || undefined, sandbox: meta.sandbox,
    startedAt: Date.parse(meta.createdAt), lastActiveAt: Date.now(),
    filesChanged: review?.git_diff?.files?.map((f) => f.path) ?? [],
    output: review?.output, diffPath: review?.git_diff?.diff_path,
    tokenUsage: review?.token_usage ?? review?.reported_usage ?? undefined,
  };
}

function cacheSession(runId: string, session: Session): Session {
  byRunId.set(runId, session);
  if (session.sessionId) byCodexId.set(session.sessionId, session);
  return session;
}

function hydrateSessionFromRun(runId: string): Session | undefined {
  const session = sessionFromRun(runId);
  return session ? cacheSession(runId, session) : undefined;
}

function lookupWithDurable(id: string): Session | undefined {
  const inMemory = lookupMemory(id);
  if (inMemory) return inMemory;
  if (runDirExists(id)) return hydrateSessionFromRun(id);
  const runIdFromPointer = getLatestRunForSession(id);
  if (runIdFromPointer && runDirExists(runIdFromPointer)) {
    const hydrated = hydrateSessionFromRun(runIdFromPointer);
    if (hydrated) return hydrated;
  }
  for (const r of listRuns().slice(0, RECENT_RUN_LOOKUP_LIMIT)) {
    const runDir = getRunDir(r.runId);
    const review = readReviewPacket(runDir) as ReviewPacketLike | null;
    const earlySid = readRunSessionRecord(runDir)?.sessionId;
    if (earlySid === id || r.progress?.sessionId === id || review?.session_id === id) {
      return hydrateSessionFromRun(r.runId);
    }
  }
  return undefined;
}

// ── Session Active Guard (Async Cold-Path Reconcile) ─────────────
function runBelongsToSession(meta: RunMeta, progress: ProgressState | null, review: ReviewPacketLike | null, earlySid: string | undefined, sessionId: string): boolean {
  return meta.resumeSessionId === sessionId || earlySid === sessionId || progress?.sessionId === sessionId || review?.session_id === sessionId;
}

async function findActiveRunForSession(sessionId: string): Promise<{ runId: string; status: string; liveness: string } | undefined> {
  const checked = new Set<string>();
  const checkOne = async (rid: string) => {
    if (checked.has(rid) || !runDirExists(rid)) return undefined;
    checked.add(rid);
    const rd = getRunDir(rid);
    const rec = await reconcileRunAsync(rd, { forceProbe: true });
    if (rec.liveness === "unknown") return { runId: rid, status: "unknown", liveness: "unknown" };
    const status = rec.review?.status || rec.progress?.status;
    if (!isTerminal(status)) return { runId: rid, status: status || "running", liveness: rec.liveness };
    return undefined;
  };

  const pointerRunId = getLatestRunForSession(sessionId);
  if (pointerRunId) {
    const hit = await checkOne(pointerRunId);
    if (hit) return hit;
  }

  for (const r of listRuns().slice(0, ACTIVE_SESSION_SCAN_LIMIT)) {
    if (checked.has(r.runId)) continue;
    const rd = getRunDir(r.runId);
    const review = readReviewPacket(rd) as ReviewPacketLike | null;
    const earlySid = readRunSessionRecord(rd)?.sessionId;
    if (!runBelongsToSession(r.meta, r.progress, review, earlySid, sessionId)) continue;
    const hit = await checkOne(r.runId);
    if (hit) return hit;
  }
  return undefined;
}

// ── Worker spawning ──────────────────────────────────────────────
interface WorkerCommand { command: string; args: string[] }

function resolveTsx(): string {
  const localTsx = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");
  if (existsSync(localTsx)) return localTsx;
  try { execFileSync("which", ["tsx"], { stdio: "ignore" }); return "tsx"; } catch {}
  throw new Error("tsx not found. Install it: npm install tsx");
}

function workerCommand(runDir: string): WorkerCommand {
  if (WORKER_EXT === ".ts") return { command: resolveTsx(), args: [WORKER_SCRIPT, runDir] };
  return { command: process.execPath, args: [WORKER_SCRIPT, runDir] };
}

function spawnWorker(runDir: string): number | undefined {
  const { command, args } = workerCommand(runDir);
  let outFd: number | "ignore" = "ignore";
  try { outFd = openSync(path.join(runDir, "worker.log"), "a", 0o600); } catch {}
  const stdio: Array<number | "ignore"> = ["ignore", outFd, outFd];
  const child = spawn(command, args, { stdio, detached: true, env: process.env });
  if (outFd !== "ignore") { try { closeSync(outFd); } catch {} }
  child.unref();
  return child.pid;
}

function startWorker(runDir: string, meta: RunMeta): { ok: true; workerPid: number } | { ok: false; error: string } {
  const workerPid = spawnWorker(runDir);
  if (!workerPid) {
    updateProgressFile(runDir, { status: "failed", phase: "terminal", liveness: "gone", message: "Failed to spawn worker process", error: "spawn returned no PID" });
    writeReviewPacket(runDir, {
      run_id: meta.runId, async: false, status: "failed", phase: "terminal", outcome: "failed", liveness: "gone",
      status_detail: "worker_spawn_failed", error: "Failed to spawn worker process", cwd: meta.cwd, git_root: meta.gitRoot || undefined,
    });
    return { ok: false, error: "Failed to spawn worker process" };
  }
  writeRunMeta(runDir, { ...meta, workerPid });
  return { ok: true, workerPid };
}

// ── Build running handle ─────────────────────────────────────────
function runHandleStatus(progress: ProgressState | null): RunHandleStatus {
  if (progress?.liveness === "unknown") return "unknown";
  switch (progress?.status) {
    case "failed": case "timeout": case "cancelled": return progress.status;
    default: return "running";
  }
}

const INITIAL_PROGRESS: ProgressState = {
  status: "starting", phase: "accepted", liveness: "alive",
  message: "Worker starting", updatedAt: new Date().toISOString(), seq: 0, revision: 0,
};

function buildRunHandle(runId: string, meta: RunMeta, progress: ProgressState | null): RunHandle {
  return {
    run_id: runId,
    async: true,
    status: runHandleStatus(progress),
    phase: progress?.phase ?? statusToPhase(progress?.status),
    liveness: progress?.liveness ?? "alive",
    session_id: progress?.sessionId || readRunSessionRecord(getRunDir(runId))?.sessionId,
    workspace_id: meta.workspaceId,
    cwd: meta.cwd,
    git_root: meta.gitRoot || undefined,
    worktree_path: meta.worktreePath,
    ...(meta.parentDirtyAtCreate !== undefined ? { parent_dirty_at_create: meta.parentDirtyAtCreate } : {}),
    progress: progress || INITIAL_PROGRESS,
    poll_with: `codex_sessions get --run_id ${runId}`,
  };
}

// ── Project Brief ────────────────────────────────────────────────
function buildProjectBrief(cwd: string, gitRoot: string | null, isIsolated = false): string | null {
  const root = gitRoot || cwd;
  const parts: string[] = [];
  parts.push(`- Git root: ${root}`);

  if (existsSync(path.join(root, "pnpm-lock.yaml"))) parts.push("- Package manager: pnpm");
  else if (existsSync(path.join(root, "yarn.lock"))) parts.push("- Package manager: yarn");
  else if (existsSync(path.join(root, "bun.lockb"))) parts.push("- Package manager: bun");
  else if (existsSync(path.join(root, "package-lock.json"))) parts.push("- Package manager: npm");

  const dirs: string[] = [];
  for (const d of ["src", "app", "lib", "tests", "test", "packages"]) {
    try { if (statSync(path.join(root, d)).isDirectory()) dirs.push(`${d}/`); } catch {}
  }
  if (dirs.length) parts.push(`- Main dirs: ${dirs.join(", ")}`);

  if (existsSync(path.join(root, "tsconfig.json"))) parts.push("- Tech: TypeScript");
  else if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "setup.py"))) parts.push("- Tech: Python");
  else if (existsSync(path.join(root, "go.mod"))) parts.push("- Tech: Go");
  else if (existsSync(path.join(root, "Cargo.toml"))) parts.push("- Tech: Rust");

  if (isIsolated) {
    parts.push("- Isolated snapshot repository: gitignored dependencies (e.g. node_modules/.venv) are not copied by default; do not install packages into or modify the parent checkout");
  }
  parts.push("- Avoid: full filesystem scans, node_modules inspection");
  parts.push("- Do not start dev servers or network listeners unless explicitly requested");
  parts.push("- Do not read .agents/skills or unrelated agent instruction packs");
  parts.push("- Prefer build/lint/test commands over interactive dev servers");

  if (parts.length <= 2) return null;
  return `Project context:\n${parts.join("\n")}\n---\n`;
}

function buildDarwinSandboxConstraint(sandbox: string): string | null {
  if (process.platform !== "darwin" || sandbox === "danger-full-access") return null;
  return [
    "macOS sandbox capability boundary (enforced by codex-bridge):",
    "- This worker does NOT provide macOS browser execution or live screenshot capability (Seatbelt blocks HIServices/LaunchServices; launching .app browsers aborts with SIGABRT 134 and triggers desktop crash dialogs).",
    "- Complete code changes, builds, and non-browser tests normally.",
    "- When real visual/browser verification is needed, report HOST_VISUAL_QA_REQUIRED with the target URLs, viewports, and checklist so the parent/host runs it outside the sandbox.",
    "- Browser execution denials are non-retryable: NEVER retry with alternate flags (--headless=new, --no-sandbox, --disable-gpu), alternate runtimes (Node/Python child_process spawn), or by downloading/installing browsers.",
  ].join("\n");
}

// ── View Helpers ─────────────────────────────────────────────────
function tailText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value.length <= maxChars) return value;
  return "...[truncated; showing tail]...\n" + value.slice(-maxChars);
}

const STALL_THRESHOLD_MS = 5 * 60 * 1000;

function isActiveRun(progress: ProgressState | null, review: ReviewPacketLike | null): boolean {
  if (review) return false;
  if (!progress) return false;
  return !isTerminal(progress.status);
}

function statusView(runId: string, progress: ProgressState | null, review: ReviewPacketLike | null, meta: RunMeta | null, progressEvents: ProgressState[] = []) {
  const active = isActiveRun(progress, review);
  const liveness = review ? "gone" : (progress?.liveness ?? "alive");
  const phase = review ? "terminal" : (progress?.phase ?? statusToPhase(progress?.status));
  const activityAt = progress?.lastActivityAt || progress?.updatedAt;
  const secondsSinceActivity = active && activityAt
    ? Math.max(0, Math.round((Date.now() - new Date(activityAt).getTime()) / 1000))
    : undefined;
  const stale = active && (
    progress?.attention?.code === "idle_silence"
    || (secondsSinceActivity !== undefined && secondsSinceActivity * 1000 > STALL_THRESHOLD_MS)
  );
  const earlySid = runDirExists(runId) ? readRunSessionRecord(getRunDir(runId))?.sessionId : undefined;
  return {
    run_id: runId,
    revision: progress?.revision ?? progress?.seq ?? 0,
    async: review?.async ?? true,
    status: review?.status || (liveness === "unknown" ? "unknown" : (progress?.status || "unknown")),
    phase,
    outcome: review?.outcome,
    liveness,
    salvaged: review?.salvaged,
    status_detail: review?.status_detail,
    failure_hint: review?.failure_hint,
    review_ready: Boolean(review),
    session_id: review?.session_id || earlySid || progress?.sessionId,
    workspace_id: meta?.workspaceId,
    workspace_kind: meta?.workspaceKind,
    observed_active_ms: review?.observed_active_ms ?? progress?.observedActiveMs,
    idle_active_ms: active ? progress?.idleActiveMs : undefined,
    observer_gaps: review?.observer_gaps ?? progress?.observerGaps,
    commands: review?.commands ?? progress?.commands,
    reported_usage: review?.reported_usage !== undefined ? review.reported_usage : (progress?.reportedUsage ?? null),
    attention: review?.attention ?? progress?.attention ?? null,
    evidence: review?.evidence ?? { sealed: Boolean(progress?.evidenceSealed) },
    progress: progress ? {
      status: progress.status, message: progress.message,
      updatedAt: progress.updatedAt, seq: progress.seq, revision: progress.revision, elapsedMs: progress.elapsedMs,
    } : undefined,
    ...(progressEvents.length > 0 && {
      progress_events: progressEvents.map((e) => ({ seq: e.seq, status: e.status, message: e.message, elapsedMs: e.elapsedMs })),
    }),
    seconds_since_last_activity: secondsSinceActivity,
    stale,
    ...(stale && { stale_warning: "No Codex activity recently. Decide whether to keep waiting or stop this run." }),
    cwd: meta?.cwd,
    git_root: meta?.gitRoot || undefined,
    worktree_path: meta?.worktreePath,
    isolation: meta?.isolation,
    parent_dirty_at_create: meta?.parentDirtyAtCreate,
    sandbox: meta?.sandbox,
    timeout: meta?.timeout ?? null,
    idle_timeout: meta?.idleTimeout ?? null,
    idle_attention_seconds: meta?.idleAttentionSeconds ?? null,
    model: meta?.resolvedModel ?? meta?.model ?? null,
    model_source: meta?.modelSource,
    effort: meta?.resolvedEffort ?? meta?.effort ?? null,
    effort_source: meta?.effortSource,
    codex_version: meta?.codexVersion,
    suggested_action: review
      ? "read_summary"
      : liveness === "unknown"
        ? "writer_liveness_unknown_wait_or_stop"
        : progress?.attention
          ? "inspect_attention_and_decide"
          : stale
            ? "ask_user_whether_to_continue_or_stop"
            : "continue_polling",
    next_poll_after_seconds: review ? undefined : Math.min(stale ? 120 : 60, MAX_CLIENT_WAIT_SECONDS),
  };
}

const SUMMARY_FILE_LIMIT = 40;
const SUMMARY_LIST_LIMIT = 20;

function capList<T>(items: T[] | undefined, limit: number): { items: T[]; total: number; truncated: boolean } {
  const arr = items ?? [];
  return { items: arr.slice(0, limit), total: arr.length, truncated: arr.length > limit };
}

function compactFiles(files: Array<{ path: string; status?: string; from?: string }> | undefined) {
  const arr = files ?? [];
  const byStatus: Record<string, number> = {};
  for (const f of arr) { const k = f.status || "?"; byStatus[k] = (byStatus[k] || 0) + 1; }
  return { total: arr.length, by_status: byStatus, items: arr.slice(0, SUMMARY_FILE_LIMIT), truncated: arr.length > SUMMARY_FILE_LIMIT };
}

function nextActionForReview(review: ReviewPacketLike): string {
  if (review.partial_changes) return "inspect_diff_before_retry_or_revert";
  if (review.status !== "completed") return "inspect_summary_then_decide_resume_or_restart";
  if (review.git_diff?.risk_flags?.length) return "inspect_diff";
  if (review.warnings?.length) return "read_warnings_then_decide";
  if (review.git_diff?.diff_truncated) return "request_diff_view_if_needed";
  return "review_summary_may_be_enough";
}

function compactReviewSummary(runId: string, review: ReviewPacketLike, maxChars: number) {
  const gd = review.git_diff;
  const gdCompact = gd && gd.is_git_repo ? {
    changed: gd.changed, summary: gd.summary,
    files: compactFiles(gd.files as Array<{ path: string; status?: string; from?: string }>),
    diff_truncated: gd.diff_truncated, diff_preview_mode: gd.diff_preview_mode,
    full_diff_bytes: gd.full_diff_bytes, preexisting_dirty_files: gd.preexisting_dirty_files,
    risk_flags: capList(gd.risk_flags, SUMMARY_LIST_LIMIT),
    sensitive_diff_omitted: capList(gd.sensitive_diff_omitted, SUMMARY_LIST_LIMIT),
    diff_path: gd.diff_path,
  } : gd;
  return {
    run_id: runId, async: true, review_ready: true,
    status: review.status, phase: review.phase ?? "terminal", outcome: review.outcome, liveness: review.liveness ?? "gone",
    salvaged: review.salvaged,
    status_detail: review.status_detail,
    failure_hint: review.failure_hint, partial_changes: review.partial_changes,
    session_id: review.session_id, session_name: review.session_name,
    workspace_id: review.workspace_id, workspace_kind: review.workspace_kind,
    duration_ms: review.duration_ms,
    observed_active_ms: review.observed_active_ms,
    observer_gaps: review.observer_gaps,
    timeout: review.timeout ?? null,
    idle_timeout: review.idle_timeout ?? null,
    idle_attention_seconds: review.idle_attention_seconds ?? null,
    isolation: review.isolation,
    worktree_path: review.worktree_path,
    parent_git_root: review.parent_git_root,
    parent_dirty_at_create: review.parent_dirty_at_create,
    ...(review.worktree_escape ? { worktree_escape: review.worktree_escape } : {}),
    ...(review.concurrent_parent_changes ? { concurrent_parent_changes: review.concurrent_parent_changes } : {}),
    model: review.model, model_source: review.model_source,
    effort: review.effort, effort_source: review.effort_source,
    codex_version: review.codex_version,
    reported_usage: review.reported_usage ?? review.token_usage ?? null,
    ...(review.token_usage ? { token_usage: review.token_usage } : {}),
    commands: review.commands,
    attention: review.attention ?? null,
    evidence: review.evidence,
    origin_tree: review.origin_tree,
    before_tree: review.before_tree,
    after_tree: review.after_tree,
    ...(review.prepare ? { prepare: review.prepare } : {}),
    git_diff: gdCompact,
    fs_sentinel: review.fs_sentinel,
    warnings: capList(review.warnings, SUMMARY_LIST_LIMIT),
    output_tail: tailText(review.output, Math.min(maxChars, 2000)),
    output_source: review.output_source,
    process: review.process,
    next_action: nextActionForReview(review),
  };
}

function limitReviewPacket(review: ReviewPacketLike, maxChars: number) {
  const gd = review.git_diff;
  const gdLimited = gd && gd.is_git_repo && gd.diff_preview
    ? { ...gd, diff_preview: tailText(gd.diff_preview, maxChars) }
    : gd;
  return {
    ...review,
    output: tailText(review.output, maxChars),
    stderr: tailText(review.stderr, Math.min(maxChars, 20000)),
    git_diff: gdLimited,
  };
}

function diffOnlyView(runId: string, review: ReviewPacketLike, maxChars: number) {
  const gd = review.git_diff;
  if (!gd || !gd.is_git_repo) {
    return { run_id: runId, status: review.status, git_diff: gd };
  }
  return {
    run_id: runId, status: review.status,
    changed: gd.changed, summary: gd.summary,
    files: compactFiles(gd.files as Array<{ path: string; status?: string; from?: string }>),
    risk_flags: gd.risk_flags, sensitive_diff_omitted: gd.sensitive_diff_omitted,
    diff_preview: tailText(gd.diff_preview, maxChars),
    diff_truncated: gd.diff_truncated, diff_path: gd.diff_path,
    full_diff_bytes: gd.full_diff_bytes,
    origin_tree: review.origin_tree, before_tree: review.before_tree, after_tree: review.after_tree,
  };
}

function renderRunView(
  rid: string,
  view: "status" | "summary" | "review" | "diff" | "output",
  maxChars: number,
  sinceSeq?: number,
) {
  const runDir = getRunDir(rid);
  const meta = readRunMeta(runDir);
  const progress = readProgress(runDir);
  const review = readReviewPacket(runDir) as ReviewPacketLike | null;
  if (review) hydrateSessionFromRun(rid);

  if (view === "status") {
    const progressEvents = sinceSeq !== undefined
      ? readProgressEventsSince(runDir, sinceSeq, 20, "after")
      : readProgressEventsSince(runDir, 0, 3, "recent");
    return statusView(rid, progress, review, meta, progressEvents);
  }
  if (!review) {
    const progressEvents = sinceSeq !== undefined
      ? readProgressEventsSince(runDir, sinceSeq, 20, "after")
      : readProgressEventsSince(runDir, 0, 3, "recent");
    return {
      ...statusView(rid, progress, review, meta, progressEvents),
      message: "Run still in progress; retry action='get' with wait_seconds to wait for completion.",
    };
  }
  if (view === "summary") return compactReviewSummary(rid, review, maxChars);
  if (view === "review") return limitReviewPacket(review, maxChars);
  if (view === "diff") return diffOnlyView(rid, review, maxChars);
  return {
    run_id: rid, status: review.status,
    output: tailText(review.output, maxChars),
    output_source: review.output_source,
    output_truncated: review.output_truncated,
    stderr: tailText(review.stderr, Math.min(maxChars, 20000)),
    stderr_truncated: review.stderr_truncated,
  };
}

// ── MCP Server ───────────────────────────────────────────────────
const SERVER_INSTRUCTIONS = [
  "codex-bridge v3.1 is a run-scoped MCP execution & evidence kernel for OpenAI Codex CLI.",
  "",
  "Recommended workflow:",
  "1. Write tasks: prefer isolation='worktree' (backed by an isolated snapshot repository + out-of-band evidence.git with immutable origin_tree). Pass base='working_tree' if you explicitly want uncommitted parent edits snapshotted as origin; default base='HEAD'. Harvest finished changes cleanly with codex_sessions(action='apply', run_id=..., dry_run=true|false, cleanup=true) — uses private-store 3-way merge-tree and single-file atomic, multi-file crash-recoverable materialization without touching parent git index/HEAD.",
  "2. Long or multi-file tasks: runs have NO default wall-clock or idle auto-kill (default raises a 1-shot attention after 900s observed silence; pass explicit timeout or idle_timeout for unattended hard budgets). Use execution_mode='async' and wait with codex_sessions(action='get', run_id=..., view='summary', wait_seconds=240) — or pass run_ids=[...] + cursor={...} for native wait-any orchestration across parallel workers.",
  "3. Idempotency & crash recovery: pass idempotency_key on codex_exec/codex_resume/apply for at-most-once admission across retries. If a worker dies unexpectedly, reconcile salvages direct-FD JSONL logs, session ID, and disk tree automatically once the writer exits (or reports liveness='unknown' while preserving the workspace).",
  "4. Follow-ups on the same task: use codex_resume with session_id (reuses workspace, evidence.git, effort, budgets, and shadow CODEX_HOME). Start an unrelated task with codex_exec.",
  "5. Always provide self-contained task specs (Codex has no prior chat context); include acceptance, non_goals, and optional model-free prepare={command,args} for dependency setup.",
  "6. macOS browser/screenshot tasks: sandboxed macOS workers do NOT provide GUI browser execution (blocked at contract, rules, and optional XNU Seatbelt kernel level). If a worker reports HOST_VISUAL_QA_REQUIRED or raises sandbox_gui_crash, run visual QA on the host instead of retrying inside the sandbox.",
].join("\n");

const server = new McpServer(
  { name: "codex-bridge", version: PKG_VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);
const SB = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const EM = z.enum(["auto", "sync", "async"]);
const RV = z.enum(["full", "summary"]);
const PrepareSchema = z.object({
  command: z.string().min(1).describe("Executable to run inside the workspace before invoking Codex (model-free)."),
  args: z.array(z.string()).optional().describe("Arguments passed to prepare.command."),
  timeout_seconds: z.number().int().min(5).max(3600).optional().describe("Timeout in seconds for prepare (default 120)."),
}).optional();

server.tool("codex_exec", "Start a Codex run with isolated snapshot repository + out-of-band evidence.git, idempotency_key admission, sleep-immune attention/budgets, and optional model-free prepare. Use execution_mode='async' for multi-file/test work, and return_view='summary' for compact sync responses.", {
  task: z.string().min(1).describe("Self-contained task specification (Codex has no prior conversation context)."),
  cwd: z.string().describe("Absolute path to the target project/repository directory."),
  model: z.string().optional().describe("Optional Codex model override (defaults to user's Codex config)."),
  sandbox: SB.optional().default("workspace-write").describe("Codex sandbox mode: read-only, workspace-write (default), or danger-full-access."),
  timeout: z.number().int().min(0).max(86400).optional().describe("Optional hard wall-clock timeout in seconds (includes host sleep). Omit or 0 for unlimited."),
  idle_timeout: z.number().int().min(0).max(7200).optional().describe("Optional explicit idle auto-kill budget in seconds of observed active time (default null = attention-only, never auto-kills)."),
  idle_attention_seconds: z.number().int().min(0).max(7200).optional().describe("Seconds of observed active silence before raising a 1-shot idle_silence attention signal (default 900; 0 disables)."),
  idempotency_key: z.string().min(1).max(200).optional().describe("Optional idempotency key for at-most-once admission across retries."),
  session_name: z.string().optional().describe("Optional human-readable label for this run/session."),
  max_diff_chars: z.number().int().min(1000).max(200000).optional().default(30000).describe("Maximum characters in diff_preview."),
  allow_non_git: z.boolean().optional().default(false).describe("Allow running in a non-git directory (disables diff capture)."),
  allow_large_untracked_snapshot: z.boolean().optional().default(false).describe("Bypass the 256MB untracked-file safety check."),
  danger_ack: z.boolean().optional().default(false).describe("Required true when sandbox='danger-full-access'."),
  execution_mode: EM.optional().default("auto").describe("auto (wait up to wait_budget_seconds then return async handle), sync, or async (return run_id immediately)."),
  wait_budget_seconds: z.number().int().min(0).max(MAX_WAIT_BUDGET).optional().default(DEFAULT_WAIT_BUDGET).describe("Seconds to wait in auto mode before returning an async handle (clamped by CODEX_BRIDGE_MAX_WAIT_SECONDS)."),
  project_brief: z.boolean().optional().default(true).describe("Prepend compact auto-detected project context (package manager, tech stack, main dirs)."),
  isolation: z.enum(["inplace", "worktree"]).optional().default("inplace").describe("inplace edits cwd directly (serialized by lease); worktree creates an isolated standalone snapshot repository + out-of-band evidence.git."),
  base: z.string().optional().describe("Snapshot base when isolation='worktree': git ref (default 'HEAD') or 'working_tree' to freeze current uncommitted parent edits as immutable origin_tree."),
  prepare: PrepareSchema.describe("Optional explicit model-free preparation command executed inside workspace before Codex starts."),
  effort: z.string().optional().describe("Optional reasoning effort override (e.g. low, medium, high, xhigh)."),
  acceptance: z.string().optional().describe("Explicit acceptance criteria appended to the prompt for Codex to self-verify."),
  non_goals: z.string().optional().describe("Explicit out-of-scope constraints appended to the prompt."),
  output_schema: z.string().optional().describe("Optional JSON Schema string enforced via Codex --output-schema."),
  grants_mcp: z.array(z.string()).optional().describe("Whitelist of MCP server names from ~/.codex/config.toml to expose inside the worker's shadow CODEX_HOME (default empty = zero MCP surface)."),
  return_view: RV.optional().default("full").describe("Response shape if the run completes within wait_budget_seconds: full (default) or summary (compact diff stats + tail)."),
}, async (args) => {
  const {
    task, model, sandbox, session_name, max_diff_chars, allow_non_git,
    allow_large_untracked_snapshot, danger_ack, execution_mode, wait_budget_seconds,
    project_brief, isolation, base, prepare, effort, acceptance, non_goals,
    output_schema, grants_mcp, return_view, idempotency_key,
  } = args;
  const timeout = resolveWallTimeout(args.timeout);
  const idleTimeout = resolveIdleTimeout(args.idle_timeout);
  const idleAttentionSeconds = resolveIdleAttention(args.idle_attention_seconds);

  let cwd: string;
  try { cwd = normalizeCwd(args.cwd); } catch (e: any) { return toolError(e.message); }
  if (sandbox === "danger-full-access" && !danger_ack) return toolError("danger-full-access requires danger_ack=true.");

  const { runCwd, gitRoot, gitRepo } = resolveExecContext(cwd);
  if (!gitRepo && !allow_non_git) return toolError("Not a Git repo. Set allow_non_git=true.", { cwd: runCwd });
  if (isolation === "worktree" && !gitRepo) return toolError("isolation=worktree requires a git repo.");

  const useIsolatedSnapshot = isolation === "worktree" && sandbox !== "read-only";

  // At-most-once admission check when idempotency_key is provided
  const candidateRunId = randomUUID();
  if (idempotency_key) {
    const digest = requestDigest({
      namespace: "exec", cwd: runCwd, task, model, sandbox, isolation,
      base: base ?? "HEAD", effort, acceptance, non_goals, grants_mcp: grants_mcp ?? [], prepare,
    });
    const claim = claimIdempotency("exec", idempotency_key, digest, { runId: candidateRunId });
    if (claim.kind === "tombstone") {
      return toolError("Idempotency key was already executed and recycled; supply a fresh idempotency_key for a new run.", {
        code: "idempotency_tombstone", idempotency_key, prior_run_id: claim.record.runId,
      });
    }
    if (claim.kind === "conflict") {
      return toolError("Idempotency key already used with different request parameters.", {
        code: "idempotency_conflict", idempotency_key, existing_run_id: claim.record.runId,
      });
    }
    if (claim.kind === "existing" && claim.record.runId) {
      const existingRunId = claim.record.runId;
      if (runDirExists(existingRunId)) {
        const rd = getRunDir(existingRunId);
        const rec = await reconcileRunAsync(rd);
        if (rec.review) {
          const viewOut = return_view === "summary" ? compactReviewSummary(existingRunId, rec.review, 20000) : rec.review;
          return toolJson({ ...(viewOut as Record<string, unknown>), idempotent_replay: true });
        }
        const metaExisting = readRunMeta(rd)!;
        return toolJson({ ...buildRunHandle(existingRunId, metaExisting, rec.progress), idempotent_replay: true });
      }
      return toolError("Idempotent run record exists but run directory is missing.", {
        code: "idempotency_missing_run", idempotency_key, existing_run_id: existingRunId,
      });
    }
  }

  const releaseKeyIfSetupFails = () => {
    if (idempotency_key) releaseUnstartedIdempotency("exec", idempotency_key, candidateRunId);
  };

  if (sandbox !== "read-only" && !useIsolatedSnapshot) {
    const target = gitRepo ? gitRoot : runCwd;
    const leaseConf = checkLeaseConflictSync(target);
    if (leaseConf.conflict) { releaseKeyIfSetupFails(); return toolError(leaseConf.message, { liveness: leaseConf.liveness, active_run_id: leaseConf.runId }); }
    const legacyConf = checkWriteLockConflict(target);
    if (legacyConf) { releaseKeyIfSetupFails(); return toolError(legacyConf); }
  }

  const runId = candidateRunId;
  const runDir = createRunDir(runId);

  let workspaceMeta: WorkspaceMeta | undefined;
  let effectiveCwd = runCwd;
  if (useIsolatedSnapshot) {
    const wsId = randomUUID();
    try {
      workspaceMeta = createSnapshotWorkspace(gitRoot, wsId, base ?? "HEAD");
      effectiveCwd = workspaceMeta.srcDir;
    } catch (e: any) {
      cleanupFailedRunSetup(runDir, wsId);
      releaseKeyIfSetupFails();
      return toolError(`Snapshot workspace setup failed: ${e?.message ?? String(e)}`, { base: base ?? "HEAD" });
    }
  }

  let finalTask = task;
  if (project_brief) {
    const brief = buildProjectBrief(effectiveCwd, useIsolatedSnapshot ? effectiveCwd : (gitRepo ? gitRoot : null), useIsolatedSnapshot);
    if (brief) finalTask = brief + task;
  }
  if (acceptance) finalTask += `\n\nAcceptance criteria (verify before finishing):\n${acceptance}`;
  if (non_goals) finalTask += `\n\nNon-goals (do NOT do these):\n${non_goals}`;
  if (useIsolatedSnapshot && workspaceMeta) {
    finalTask += `\n\nConstraints: your ONLY writable directory is ${workspaceMeta.srcDir}. The checkout at ${gitRoot} is read-only context — do not create, modify, or delete files there or anywhere outside your isolated workspace. Do not push.`;
  }
  const darwinConstraint = buildDarwinSandboxConstraint(sandbox);
  if (darwinConstraint) finalTask += `\n\n${darwinConstraint}`;

  // Provision shadow CODEX_HOME (lives inside workspaceDir for isolated runs so old-run GC never breaks resume!)
  let mcpHome: string | undefined;
  try {
    const mcpParentDir = workspaceMeta ? workspaceDir(workspaceMeta.workspaceId) : runDir;
    mcpHome = resolveMcpHome(normalizeGrants({ mcp: grants_mcp ?? [] }), effectiveCwd, mcpParentDir, { sandbox }).codexHome;
  } catch (e: any) {
    cleanupFailedRunSetup(runDir, workspaceMeta?.workspaceId);
    releaseKeyIfSetupFails();
    const details = e instanceof GrantRejection ? e.toDetails() : undefined;
    return toolError(e?.message ?? String(e), details);
  }

  const ownerNonce = randomUUID();
  const meta: RunMeta = {
    runId,
    ownerNonce,
    idempotencyKey: idempotency_key,
    cwd: effectiveCwd,
    gitRoot: gitRepo ? (useIsolatedSnapshot ? effectiveCwd : gitRoot) : null,
    sandbox,
    task: finalTask,
    model,
    timeout,
    idleTimeout,
    idleAttentionSeconds,
    sessionName: session_name || `run-${runId.slice(0, 8)}`,
    maxDiffChars: max_diff_chars,
    allowNonGit: allow_non_git,
    allowLargeUntracked: allow_large_untracked_snapshot,
    dangerAck: danger_ack,
    createdAt: new Date().toISOString(),
    isolation,
    workspaceId: workspaceMeta?.workspaceId,
    workspaceKind: workspaceMeta ? "snapshot" : "inplace",
    worktreePath: workspaceMeta?.srcDir,
    parentGitRoot: useIsolatedSnapshot ? gitRoot : undefined,
    evidenceGitDir: workspaceMeta?.evidenceGitDir ?? null,
    originTree: workspaceMeta?.originTree ?? null,
    baseSpec: workspaceMeta?.baseSpec,
    parentDirtyAtCreate: workspaceMeta?.parentDirtyAtCreate,
    prepare,
    effort,
    outputSchema: output_schema,
    mcpHome,
    grants: { mcp: grants_mcp ?? [] },
    ...resolveCodexRunConfig(model, effort),
  };
  writeRunMeta(runDir, meta);

  const w = startWorker(runDir, meta);
  if (!w.ok) return toolError(w.error, { run_id: runId });

  if (gitRepo) updateProjectPointer(gitRoot, runId);

  const ses: Session = {
    latestRunId: runId, runIds: [runId],
    name: meta.sessionName, status: "running",
    cwd: effectiveCwd, gitRoot: gitRepo ? gitRoot : undefined, sandbox,
    startedAt: Date.now(), lastActiveAt: Date.now(), filesChanged: [],
  };
  byRunId.set(runId, ses);

  if (execution_mode === "async") {
    const progress = readProgress(runDir);
    return toolJson(buildRunHandle(runId, meta, progress));
  }

  const waitMs = clampWaitSeconds(execution_mode === "sync" ? MAX_WAIT_BUDGET : wait_budget_seconds) * 1000;
  const packet = await pollForCompletion(runDir, waitMs);

  if (packet) {
    const p = packet as ReviewPacketLike;
    ses.status = (p.status as Session["status"]) || "completed";
    ses.lastActiveAt = Date.now();
    ses.output = p.output;
    ses.filesChanged = (p.git_diff?.files || []).map((f) => f.path);
    ses.diffPath = p.git_diff?.diff_path;
    ses.tokenUsage = p.token_usage ?? p.reported_usage ?? undefined;
    if (p.session_id) { ses.sessionId = p.session_id; byCodexId.set(ses.sessionId, ses); }
    return toolJson(return_view === "summary" ? compactReviewSummary(runId, p, 20000) : p);
  }

  const rec = await reconcileRunAsync(runDir);
  if (rec.review) {
    ses.status = (rec.review.status as Session["status"]) || "failed";
    ses.lastActiveAt = Date.now();
    return toolJson(return_view === "summary" ? compactReviewSummary(runId, rec.review, 20000) : rec.review);
  }

  return toolJson(buildRunHandle(runId, meta, rec.progress));
});

server.tool("codex_resume", "Resume an existing Codex session for follow-up fixes or iterations. Reuses isolated workspace, immutable origin_tree in evidence.git, effort, budgets, and shadow CODEX_HOME. Refuses while previous writer is alive or unknown.", {
  session_id: z.string().min(1).describe("Codex session_id (thread_id) from a prior codex_exec run."),
  task: z.string().min(1).describe("Follow-up instructions for the existing Codex session."),
  cwd: z.string().optional().describe("Optional working directory (must match the original session cwd or parent repo)."),
  sandbox: SB.optional().describe("Cannot override original session sandbox; omit unless matching."),
  model: z.string().optional().describe("Optional model override for this resumed turn."),
  effort: z.string().optional().describe("Optional reasoning effort override (inherits parent run effort if omitted)."),
  timeout: z.number().int().min(0).max(86400).optional().describe("Optional hard wall-clock timeout in seconds (inherits parent if omitted; 0 disables)."),
  idle_timeout: z.number().int().min(0).max(7200).optional().describe("Optional explicit idle auto-kill budget in seconds (inherits parent if omitted; 0 disables)."),
  idle_attention_seconds: z.number().int().min(0).max(7200).optional().describe("Optional idle silence attention threshold in seconds (inherits parent if omitted; 0 disables)."),
  idempotency_key: z.string().min(1).max(200).optional().describe("Optional idempotency key for at-most-once admission across retries."),
  max_diff_chars: z.number().int().min(1000).max(200000).optional().default(30000).describe("Maximum characters in diff_preview."),
  allow_non_git: z.boolean().optional().default(false).describe("Allow running in a non-git directory."),
  allow_large_untracked_snapshot: z.boolean().optional().default(false).describe("Bypass the 256MB untracked-file safety check."),
  danger_ack: z.boolean().optional().default(false).describe("Required true when resuming a danger-full-access session."),
  execution_mode: EM.optional().default("auto").describe("auto, sync, or async."),
  wait_budget_seconds: z.number().int().min(0).max(MAX_WAIT_BUDGET).optional().default(DEFAULT_WAIT_BUDGET).describe("Seconds to wait in auto mode before returning an async handle."),
  project_brief: z.boolean().optional().default(true).describe("Prepend compact auto-detected project context."),
  acceptance: z.string().optional().describe("Optional acceptance criteria appended to the follow-up prompt."),
  non_goals: z.string().optional().describe("Optional out-of-scope constraints appended to the follow-up prompt."),
  return_view: RV.optional().default("full").describe("Response shape if the resumed run completes within wait_budget_seconds: full (default) or summary."),
}, async (args) => {
  const {
    session_id, task, cwd: cwdArg, max_diff_chars, allow_non_git,
    allow_large_untracked_snapshot, danger_ack, execution_mode, wait_budget_seconds,
    project_brief, acceptance, non_goals, return_view, idempotency_key,
  } = args;

  const ex = lookupWithDurable(session_id);
  const durableSes = readSessionRecord(ex?.sessionId || session_id);
  const rsid = ex?.sessionId || durableSes?.sessionId || session_id;
  if (byRunId.has(session_id) && !ex?.sessionId) return toolError("Cannot resume by run_id. Pass Codex session_id.", { run_id: session_id });

  const parentRunId = ex?.latestRunId || durableSes?.latestRunId;
  const parentMeta = parentRunId && runDirExists(parentRunId) ? readRunMeta(getRunDir(parentRunId)) : null;
  const workspaceId = parentMeta?.workspaceId || durableSes?.workspaceId;
  const ws = workspaceId ? readWorkspaceMeta(workspaceId) : null;
  const isParentIsolated = Boolean(
    (parentMeta?.isolation === "worktree" && (parentMeta.worktreePath || ws?.srcDir))
    || ws?.kind === "snapshot",
  );
  const isolatedSrcDir = ws?.srcDir ?? parentMeta?.worktreePath;

  if (isParentIsolated && (!isolatedSrcDir || ws?.cleanedAt || !existsSync(isolatedSrcDir))) {
    return toolError("Cannot resume: worktree was already cleaned up.", { session_id, worktree_path: isolatedSrcDir, workspace_id: workspaceId });
  }

  if (ex && cwdArg) {
    try {
      const requestedCwd = normalizeCwd(cwdArg);
      const allowedCwds = new Set<string>([ex.cwd]);
      if (isolatedSrcDir && existsSync(isolatedSrcDir)) allowedCwds.add(normalizeCwd(isolatedSrcDir));
      const parentGit = ws?.parentGitRoot ?? parentMeta?.parentGitRoot;
      if (parentGit && existsSync(parentGit)) allowedCwds.add(normalizeCwd(parentGit));
      if (!allowedCwds.has(requestedCwd)) {
        return toolError("codex_resume cannot override cwd (Codex CLI resume has no -C). Use original session cwd.", { requested: cwdArg, session_cwd: ex.cwd, session_id });
      }
    } catch (e: any) { return toolError(e.message); }
  }
  const effectiveSandbox = ex?.sandbox || durableSes?.sandbox || "workspace-write";
  if ((ex || durableSes) && args.sandbox && args.sandbox !== effectiveSandbox) {
    return toolError("codex_resume cannot override sandbox (Codex CLI resume has no -s). Use original session sandbox.", { requested: args.sandbox, session_sandbox: effectiveSandbox, session_id });
  }
  if (!ex && !durableSes && args.sandbox) {
    return toolError("codex_resume cannot enforce sandbox for an unknown external session. Omit sandbox or resume a bridge-created session.", { requested_sandbox: args.sandbox, assumed_sandbox: "workspace-write", session_id });
  }

  const rawCwd = isParentIsolated ? isolatedSrcDir! : (ex?.cwd || durableSes?.cwd || cwdArg);
  if (!rawCwd) return toolError("Unknown session. Provide cwd for evidence capture.", { session_id });
  let cwd: string; try { cwd = normalizeCwd(rawCwd); } catch (e: any) { return toolError(e.message); }

  if (effectiveSandbox === "danger-full-access" && !danger_ack) return toolError("Resuming danger-full-access session requires danger_ack=true.");

  const { runCwd, gitRoot, gitRepo } = resolveExecContext(cwd);
  if (!gitRepo && !allow_non_git) return toolError("Not a Git repo. Set allow_non_git=true.", { cwd: runCwd });

  const mcpHome = parentMeta?.mcpHome || durableSes?.mcpHome;
  if (!mcpHome || !existsSync(mcpHome)) {
    return toolError("cannot resume: no parent run with a shadow CODEX_HOME to inherit (pre-grants or external session). Fail closed — start a fresh codex_exec.", { session_id, parent_run_id: parentRunId ?? null });
  }

  // Re-verify session-level active/unknown writer guard BEFORE claiming anything!
  const activeRun = await findActiveRunForSession(rsid);
  if (activeRun) {
    return toolError(
      activeRun.liveness === "unknown"
        ? "Previous writer liveness is unknown; refusing to resume or steal workspace lease until writer exits."
        : "Codex session already has an active run. Wait for it to finish or stop it before resuming.",
      { session_id: rsid, active_run_id: activeRun.runId, status: activeRun.status, liveness: activeRun.liveness },
    );
  }

  const leaseTarget = workspaceId ? `workspace:${workspaceId}` : (gitRepo ? gitRoot : runCwd);
  if (effectiveSandbox !== "read-only" || workspaceId) {
    const lc = checkLeaseConflictSync(leaseTarget);
    if (lc.conflict) return toolError(lc.message, { liveness: lc.liveness, active_run_id: lc.runId });
    if (!workspaceId && effectiveSandbox !== "read-only") {
      const legacy = checkWriteLockConflict(gitRepo ? gitRoot : runCwd);
      if (legacy) return toolError(legacy);
    }
  }

  const candidateRunId = randomUUID();
  if (idempotency_key) {
    const digest = requestDigest({ namespace: "resume", session_id: rsid, task, model: args.model, effort: args.effort, acceptance, non_goals });
    const claim = claimIdempotency("resume", idempotency_key, digest, { runId: candidateRunId });
    if (claim.kind === "tombstone") {
      return toolError("Idempotency key was already executed and recycled.", { code: "idempotency_tombstone", idempotency_key, prior_run_id: claim.record.runId });
    }
    if (claim.kind === "conflict") {
      return toolError("Idempotency key already used with different resume parameters.", { code: "idempotency_conflict", idempotency_key, existing_run_id: claim.record.runId });
    }
    if (claim.kind === "existing" && claim.record.runId && runDirExists(claim.record.runId)) {
      const existingRunId = claim.record.runId;
      const rd = getRunDir(existingRunId);
      const rec = await reconcileRunAsync(rd);
      if (rec.review) {
        const viewOut = return_view === "summary" ? compactReviewSummary(existingRunId, rec.review, 20000) : rec.review;
        return toolJson({ ...(viewOut as Record<string, unknown>), idempotent_replay: true });
      }
      return toolJson({ ...buildRunHandle(existingRunId, readRunMeta(rd)!, rec.progress), idempotent_replay: true });
    }
  }

  const timeout = args.timeout !== undefined ? resolveWallTimeout(args.timeout) : (parentMeta?.timeout ?? null);
  const idleTimeout = resolveIdleTimeout(args.idle_timeout, parentMeta?.idleTimeout);
  const idleAttentionSeconds = resolveIdleAttention(args.idle_attention_seconds, parentMeta?.idleAttentionSeconds);

  const runId = candidateRunId;
  const runDir = createRunDir(runId);
  const resumeContextVerified = Boolean(ex || durableSes);

  let finalTask = task;
  if (project_brief) {
    const brief = buildProjectBrief(runCwd, isParentIsolated ? runCwd : (gitRepo ? gitRoot : null), isParentIsolated);
    if (brief) finalTask = brief + task;
  }
  if (acceptance) finalTask += `\n\nAcceptance criteria (verify before finishing):\n${acceptance}`;
  if (non_goals) finalTask += `\n\nNon-goals (do NOT do these):\n${non_goals}`;
  const parentGitRoot = ws?.parentGitRoot ?? parentMeta?.parentGitRoot ?? undefined;
  if (isParentIsolated && parentGitRoot && isolatedSrcDir) {
    finalTask += `\n\nConstraints: your ONLY writable directory is ${isolatedSrcDir}. The checkout at ${parentGitRoot} is read-only context — do not create, modify, or delete files there or anywhere outside your isolated workspace. Do not push.`;
  }
  const darwinResumeConstraint = buildDarwinSandboxConstraint(effectiveSandbox);
  if (darwinResumeConstraint) finalTask += `\n\n${darwinResumeConstraint}`;
  ensureDarwinNoBrowserRules(mcpHome, effectiveSandbox);

  const inheritedGrants = parentMeta?.grants ?? { mcp: [] };
  const effectiveEffort = args.effort ?? parentMeta?.effort;
  const ownerNonce = randomUUID();

  const meta: RunMeta = {
    runId,
    ownerNonce,
    idempotencyKey: idempotency_key,
    cwd: runCwd,
    gitRoot: gitRepo ? gitRoot : null,
    sandbox: effectiveSandbox,
    task: finalTask,
    model: args.model,
    timeout,
    idleTimeout,
    idleAttentionSeconds,
    sessionName: ex?.name || parentMeta?.sessionName || `resumed-${rsid.slice(0, 8)}`,
    maxDiffChars: max_diff_chars,
    allowNonGit: allow_non_git,
    allowLargeUntracked: allow_large_untracked_snapshot,
    dangerAck: danger_ack,
    createdAt: new Date().toISOString(),
    resumeSessionId: rsid,
    resumeContextVerified,
    isolation: parentMeta?.isolation ?? (isParentIsolated ? "worktree" : "inplace"),
    workspaceId,
    workspaceKind: ws?.kind ?? parentMeta?.workspaceKind ?? "inplace",
    worktreePath: isParentIsolated ? isolatedSrcDir : undefined,
    parentGitRoot: isParentIsolated ? parentGitRoot : undefined,
    evidenceGitDir: ws?.evidenceGitDir ?? parentMeta?.evidenceGitDir ?? null,
    originTree: ws?.originTree ?? parentMeta?.originTree ?? null,
    effort: effectiveEffort,
    mcpHome,
    grants: inheritedGrants,
    ...resolveCodexRunConfig(args.model, effectiveEffort),
  };
  writeRunMeta(runDir, meta);

  const w = startWorker(runDir, meta);
  if (!w.ok) return toolError(w.error, { run_id: runId });

  if (gitRepo) updateProjectPointer(isParentIsolated && parentGitRoot ? parentGitRoot : gitRoot, runId);

  const ses: Session = ex || {
    latestRunId: runId, runIds: [], sessionId: rsid,
    name: meta.sessionName, status: "running",
    cwd: runCwd, gitRoot: gitRepo ? gitRoot : undefined, sandbox: effectiveSandbox,
    startedAt: Date.now(), lastActiveAt: Date.now(), filesChanged: [],
  };
  ses.status = "running"; ses.lastActiveAt = Date.now();
  if (!ses.runIds.includes(runId)) ses.runIds.push(runId);
  ses.latestRunId = runId;
  byRunId.set(runId, ses);
  if (ex || durableSes) byCodexId.set(rsid, ses);

  if (execution_mode === "async") {
    const progress = readProgress(runDir);
    return toolJson(buildRunHandle(runId, meta, progress));
  }

  const waitMs = clampWaitSeconds(execution_mode === "sync" ? MAX_WAIT_BUDGET : wait_budget_seconds) * 1000;
  const packet = await pollForCompletion(runDir, waitMs);

  if (packet) {
    const p = packet as ReviewPacketLike;
    ses.status = (p.status as Session["status"]) || "completed";
    ses.lastActiveAt = Date.now();
    ses.output = p.output;
    ses.filesChanged = [...new Set([...ses.filesChanged, ...(p.git_diff?.files || []).map((f) => f.path)])];
    ses.tokenUsage = p.token_usage ?? p.reported_usage ?? undefined;
    const attached = p.resume_attached !== false;
    if (p.session_id && attached) { ses.sessionId = p.session_id; byCodexId.set(p.session_id, ses); }
    if (!attached && !ex) byRunId.delete(runId);
    return toolJson(return_view === "summary" ? compactReviewSummary(runId, p, 20000) : p);
  }

  const rec = await reconcileRunAsync(runDir);
  if (rec.review) {
    ses.status = (rec.review.status as Session["status"]) || "failed";
    ses.lastActiveAt = Date.now();
    if (!ex && rec.review.resume_attached === false) byRunId.delete(runId);
    return toolJson(return_view === "summary" ? compactReviewSummary(runId, rec.review, 20000) : rec.review);
  }

  return toolJson(buildRunHandle(runId, meta, rec.progress));
});

const RunIdStr = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const VIEW = z.enum(["status", "summary", "review", "diff", "output"]);

server.tool("codex_sessions", "List, inspect, wait on (single or multi-run wait-any), stop, apply (private-store 3-way merge + recoverable file materialization), clean up workspaces, or run doctor diagnostics.", {
  action: z.enum(["list", "get", "stop", "doctor", "cleanup", "apply"]).describe("list recent runs, get run(s) status/summary/diff/output/review, stop an active run, doctor diagnostics, apply isolated workspace changes via private 3-way merge, or cleanup workspace."),
  session_id: z.string().optional().describe("Codex session_id (alternative to run_id for get/stop)."),
  run_id: RunIdStr.optional().describe("UUID of a codex-bridge run (required for cleanup/apply; preferred for single-run get/stop)."),
  run_ids: z.array(RunIdStr).min(1).max(32).optional().describe("For action='get': wait-any across multiple run IDs in one shared event-driven call (returns all ready runs without failing batch on a single missing ID)."),
  cursor: z.record(z.string(), z.number().int().min(0)).optional().describe("For action='get' with run_ids: per-run last-seen revision so already-acknowledged terminal states or attention signals do not wake repeatedly."),
  view: VIEW.optional().default("status").describe("For action='get': status (lightweight), summary (compact files/warnings/tail), diff, output, or review."),
  max_chars: z.number().int().min(1000).max(200000).optional().default(20000).describe("Character cap for diff/output/review views."),
  wait_seconds: z.number().int().min(0).max(600).optional().default(0).describe("Event-driven long-poll duration in seconds for action='get' (shared directory watcher multiplexer; clamped by CODEX_BRIDGE_MAX_WAIT_SECONDS)."),
  wait_for: z.enum(["terminal", "progress"]).optional().default("terminal").describe("For wait_seconds > 0: 'terminal' (default) waits for completion/failure/unknown/1-shot attention/deadline; 'progress' wakes on each new progress event."),
  verbose: z.boolean().optional().default(false).describe("Include git_root, sandbox, model, and progress message in action='list'."),
  since_seq: z.number().int().min(0).optional().describe("Return incremental progress_events with seq > since_seq."),
  dry_run: z.boolean().optional().default(false).describe("For action='apply': compute private 3-way merge & validate paths without modifying parent checkout."),
  cleanup: z.boolean().optional().default(false).describe("For action='apply': remove isolated workspace src after COMMITTED apply."),
  allow_partial: z.boolean().optional().default(false).describe("For action='apply': allow applying partial changes from a non-completed run after manual inspection."),
  scope: z.enum(["auto", "worktree", "run"]).optional().default("auto").describe("For action='apply': 'auto' (default) merges from session watermark (or immutable origin_tree); 'worktree' forces full origin_tree→after_tree; 'run' forces this turn's before_tree→after_tree."),
  idempotency_key: z.string().min(1).max(200).optional().describe("Optional idempotency key for action='apply'."),
}, async (args) => {
  const {
    action, session_id: sid, run_id: rid, run_ids: rids, cursor, view, max_chars,
    wait_seconds, wait_for, verbose, since_seq, dry_run, cleanup, allow_partial, scope, idempotency_key,
  } = args;

  if (action === "doctor") {
    const stats = durableStateStats();
    const connectivity = await tcpProbe("api.openai.com", 443, 5000);
    const codexEnv = buildCodexEnv();
    const gitEnv = buildGitEnv();
    const codexVersion = cmdOk(CODEX_BINARY, ["--version"], { env: codexEnv, timeout: 10_000 });
    const codexAuth = cmdOk(CODEX_BINARY, ["login", "status"], { env: codexEnv, timeout: 10_000 });
    const gitVersion = cmdOk("git", ["--version"], { env: gitEnv, timeout: 10_000 });
    const cliProbe = probeCodexCapabilities();
    const pendingApplies = listApplyIntents().filter((a) => a.status === "PREPARED" || a.status === "CONFLICT_DURING_RECOVERY");
    const activeWorkspaces = countActiveWorkspaces();
    return toolJson({
      bridge_version: PKG_VERSION,
      codex_binary: CODEX_BINARY,
      ...(CODEX_BINARY_REALPATH && CODEX_BINARY_REALPATH !== CODEX_BINARY ? { codex_binary_realpath: CODEX_BINARY_REALPATH } : {}),
      darwin_exec_deny_enforced: cliProbe.darwinExecDenyEnforced,
      codex_version: codexVersion,
      codex_auth: codexAuth,
      cli_probe: cliProbe,
      git_version: gitVersion,
      node: process.version, platform: process.platform, arch: process.arch,
      bridge_home: BASE_DIR,
      bridge_home_writable: isBridgeHomeWritable(),
      active_workspaces: activeWorkspaces,
      active_worktrees: activeWorkspaces, // backwards-compat alias
      pending_applies: pendingApplies.length,
      max_wait_seconds: MAX_CLIENT_WAIT_SECONDS,
      default_idle_timeout_seconds: CONFIGURED_DEFAULT_IDLE_TIMEOUT,
      default_idle_attention_seconds: CONFIGURED_DEFAULT_IDLE_ATTENTION,
      default_wall_timeout_seconds: null,
      env: { has_HOME: Boolean(process.env.HOME), has_CODEX_HOME: Boolean(process.env.CODEX_HOME), has_CODEX_BRIDGE_HOME: Boolean(process.env.CODEX_BRIDGE_HOME), has_OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY), has_proxy: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY) },
      network: { ...connectivity, probe: "direct_tcp", host: "api.openai.com", port: 443, note: "Direct TCP probe. Proxy/VPN/PAC environments may differ from actual Codex connectivity." },
      durable_state: { run_count: stats.runCount, session_pointers: stats.sessionPointerCount, disk_bytes: stats.totalBytes, disk_mb: Math.round(stats.totalBytes / 1024 / 1024 * 10) / 10, oldest_run: stats.oldestRun, cleanup_policy: "session-rooted GC (7 days for unreferenced runs)" },
    });
  }

  if (action === "list") {
    const durableRuns = listRuns().slice(0, 50);
    const sessions = await Promise.all(durableRuns.map(async (r) => {
      const rd = getRunDir(r.runId);
      // Zero-spawn hot reconcile: never forks `ps` for completed runs or fresh heartbeats!
      const rec = await reconcileRunAsync(rd);
      const progress = rec.progress;
      const review = rec.review;
      const compact = {
        run_id: r.runId,
        session_name: r.meta.sessionName,
        status: review?.status || (rec.liveness === "unknown" ? "unknown" : (progress?.status || "unknown")),
        phase: rec.phase,
        liveness: rec.liveness,
        cwd: r.meta.cwd,
        isolation: r.meta.isolation,
        workspace_id: r.meta.workspaceId,
        ...(r.meta.worktreePath ? { worktree_exists: existsSync(r.meta.worktreePath) } : {}),
        created_at: r.meta.createdAt,
        session_id: review?.session_id || readRunSessionRecord(rd)?.sessionId || progress?.sessionId,
      };
      if (!verbose) return compact;
      return {
        ...compact,
        git_root: r.meta.gitRoot,
        sandbox: r.meta.sandbox,
        model: r.meta.resolvedModel ?? r.meta.model ?? null,
        model_source: r.meta.modelSource,
        message: progress?.message,
        attention: progress?.attention ?? null,
      };
    }));
    return toolJson({ sessions });
  }

  // ── GET (single-run OR multi-run wait-any) ────────────────────
  if (action === "get") {
    if (rids && rids.length > 0) {
      return getMultipleRuns(rids, view, max_chars, wait_seconds, wait_for, cursor, since_seq);
    }
    if (rid) return getByRunId(rid, view, max_chars, wait_seconds, since_seq, wait_for);
    if (sid) {
      const runId = findRunIdBySessionId(sid);
      if (runId) return getByRunId(runId, view, max_chars, wait_seconds, since_seq, wait_for);
      return toolError("Session not found. Pass cwd to codex_resume.", { session_id: sid });
    }
    return toolError("session_id, run_id, or run_ids required for get");
  }

  // ── STOP ───────────────────────────────────────────────────────
  if (action === "stop") {
    if (rid) return stopByRunId(rid);
    if (sid) {
      const runId = findRunIdBySessionId(sid);
      if (runId) return stopByRunId(runId);
    }
    return toolError("session_id or run_id required for stop");
  }

  // ── CLEANUP ────────────────────────────────────────────────────
  if (action === "cleanup") {
    if (!rid) return toolError("run_id required for cleanup");
    return cleanupWorkspaceByRunId(rid);
  }

  // ── APPLY ──────────────────────────────────────────────────────
  if (action === "apply") {
    if (!rid) return toolError("run_id required for apply");
    return applyByRunId(rid, dry_run, cleanup, allow_partial, scope, idempotency_key);
  }

  return toolError("Unknown action");
});

// ── Session → Run lookup ─────────────────────────────────────────
function findRunIdBySessionId(sessionId: string): string | undefined {
  const memory = lookupMemory(sessionId);
  if (memory) return memory.latestRunId;
  const pointerRunId = getLatestRunForSession(sessionId);
  if (pointerRunId && runDirExists(pointerRunId)) return pointerRunId;
  for (const r of listRuns().slice(0, RECENT_RUN_LOOKUP_LIMIT)) {
    const runDir = getRunDir(r.runId);
    const review = readReviewPacket(runDir) as ReviewPacketLike | null;
    const earlySid = readRunSessionRecord(runDir)?.sessionId;
    if (earlySid === sessionId || r.progress?.sessionId === sessionId || review?.session_id === sessionId) return r.runId;
  }
  return undefined;
}

// ── Action Helpers ───────────────────────────────────────────────
async function getByRunId(
  rid: string,
  view: "status" | "summary" | "review" | "diff" | "output" = "status",
  maxChars: number = 20000,
  waitSeconds: number = 0,
  sinceSeq?: number,
  waitFor: "terminal" | "progress" = "terminal",
) {
  if (!runDirExists(rid)) return toolError("Run not found.", { run_id: rid });
  const runDir = getRunDir(rid);

  const effectiveWait = clampWaitSeconds(waitSeconds);
  if (effectiveWait > 0) {
    await waitForRuns({
      runIds: [rid],
      timeoutMs: effectiveWait * 1000,
      waitFor,
      cursor: sinceSeq !== undefined ? { [rid]: sinceSeq } : undefined,
    });
  }

  await reconcileRunAsync(runDir);
  return toolJson(renderRunView(rid, view, maxChars, sinceSeq));
}

async function getMultipleRuns(
  rids: string[],
  view: "status" | "summary" | "review" | "diff" | "output",
  maxChars: number,
  waitSeconds: number,
  waitFor: "terminal" | "progress",
  cursor?: Record<string, number>,
  sinceSeq?: number,
) {
  const uniqueIds = [...new Set(rids)];
  const effectiveWait = clampWaitSeconds(waitSeconds);
  const ready = await waitForRuns({
    runIds: uniqueIds,
    timeoutMs: effectiveWait * 1000,
    waitFor,
    cursor,
  });

  const runs: Record<string, unknown> = {};
  const nextCursor: Record<string, number> = { ...(cursor ?? {}) };

  for (const id of uniqueIds) {
    if (!runDirExists(id)) {
      runs[id] = { run_id: id, error: "Run not found." };
      continue;
    }
    const rd = getRunDir(id);
    const rec = await reconcileRunAsync(rd);
    const rev = rec.progress?.revision ?? rec.progress?.seq ?? 0;
    nextCursor[id] = Math.max(nextCursor[id] ?? 0, rev);
    runs[id] = renderRunView(id, view, maxChars, sinceSeq);
  }

  return toolJson({
    ready,
    timed_out: ready.length === 0 && effectiveWait > 0,
    cursor: nextCursor,
    runs,
  });
}

function removeWorkspaceSrc(meta: RunMeta): { cleaned: boolean; worktree: string; note?: string; stderr?: string } {
  if (meta.workspaceId) {
    const ws = readWorkspaceMeta(meta.workspaceId);
    const src = ws?.srcDir ?? meta.worktreePath ?? "";
    if (!src || !existsSync(src)) {
      if (ws && !ws.cleanedAt) updateWorkspaceMeta(meta.workspaceId, { cleanedAt: new Date().toISOString() });
      return { cleaned: true, worktree: src, note: "Workspace already gone." };
    }
    rmSync(src, { recursive: true, force: true });
    if (ws) updateWorkspaceMeta(meta.workspaceId, { cleanedAt: new Date().toISOString() });
    return { cleaned: true, worktree: src };
  }

  // Legacy linked-worktree cleanup fallback
  const wt = meta.worktreePath!;
  const base = meta.parentGitRoot ?? meta.gitRoot;
  if (!existsSync(wt)) {
    if (base && existsSync(base)) {
      try { spawnSync("git", ["-C", base, "worktree", "prune"], { encoding: "utf8", env: buildGitEnv() }); } catch {}
    }
    return { cleaned: true, worktree: wt, note: "Worktree already gone." };
  }
  const r = spawnSync("git", ["-C", base as string, "worktree", "remove", "--force", wt], { encoding: "utf8", env: buildGitEnv() });
  return { cleaned: r.status === 0, worktree: wt, stderr: (r.stderr || "").trim() || undefined };
}

async function cleanupWorkspaceByRunId(rid: string) {
  if (!runDirExists(rid)) return toolError("Run not found.", { run_id: rid });
  const rd = getRunDir(rid);
  const rec = await reconcileRunAsync(rd, { forceProbe: true });
  const meta = readRunMeta(rd);
  if (!meta?.worktreePath && !meta?.workspaceId) {
    return toolJson({ cleaned: false, reason: "Run did not use isolation=worktree." });
  }
  if (rec.liveness === "unknown") {
    return toolError("Cannot cleanup workspace while writer liveness is unknown. Wait or stop writer first.", {
      run_id: rid, liveness: "unknown", worktree: meta.worktreePath,
    });
  }
  if (!rec.review && !isTerminal(rec.progress?.status)) {
    return toolError("Cannot cleanup worktree while run is active. Stop the run first.", {
      run_id: rid, status: rec.progress?.status ?? "unknown", worktree: meta.worktreePath,
    });
  }
  if (meta.workspaceId) {
    const pending = listApplyIntents().find(
      (a) => a.workspaceId === meta.workspaceId && (a.status === "PREPARED" || a.status === "CONFLICT_DURING_RECOVERY"),
    );
    if (pending) {
      return toolError("Cannot cleanup workspace while an uncommitted apply intent references it.", {
        run_id: rid, workspace_id: meta.workspaceId, operation_id: pending.operationId, apply_status: pending.status,
      });
    }
  }
  return toolJson(removeWorkspaceSrc(meta));
}

async function applyByRunId(
  rid: string,
  dryRun: boolean,
  shouldCleanup: boolean,
  allowPartial: boolean,
  scope: "auto" | "worktree" | "run" = "auto",
  idempotencyKey?: string,
) {
  if (!runDirExists(rid)) return toolError("Run not found.", { run_id: rid });
  const rd = getRunDir(rid);
  const rec = await reconcileRunAsync(rd, { forceProbe: true });
  const meta = readRunMeta(rd);
  if (!meta || meta.isolation !== "worktree" || !meta.parentGitRoot) {
    return toolError("action='apply' only supports isolation='worktree' runs.", { run_id: rid, isolation: meta?.isolation ?? "unknown" });
  }
  if (!existsSync(meta.parentGitRoot)) {
    return toolError("Parent git repository no longer exists.", { run_id: rid, parent_git_root: meta.parentGitRoot });
  }
  if (rec.liveness === "unknown") {
    return toolError("Refusing to apply while writer liveness is unknown. Wait or stop writer first.", { run_id: rid, liveness: "unknown" });
  }
  const review = rec.review;
  if (!review) {
    return toolError("Cannot apply worktree run before completion.", { run_id: rid, status: rec.progress?.status ?? "unknown" });
  }
  if (review.status !== "completed" && !allowPartial) {
    return toolError("Refusing to apply changes from a non-completed run. Inspect diff first or pass allow_partial=true.", {
      run_id: rid, status: review.status, status_detail: review.status_detail, partial_changes: review.partial_changes,
    });
  }
  if (review.worktree_escape) {
    return toolError("Refusing to apply: worktree escape was detected on this run. Inspect diff and parent checkout manually.", {
      run_id: rid, worktree_escape: review.worktree_escape,
    });
  }

  // Optional idempotency check for non-dry-run apply
  const applyOpIdCandidate = randomUUID();
  if (idempotencyKey && !dryRun) {
    const digest = requestDigest({ namespace: "apply", run_id: rid, scope, allow_partial: allowPartial, cleanup: shouldCleanup });
    const claim = claimIdempotency("apply", idempotencyKey, digest, { runId: rid, operationId: applyOpIdCandidate });
    if (claim.kind === "conflict") {
      return toolError("Idempotency key already used for a different apply request.", { code: "idempotency_conflict", idempotency_key: idempotencyKey });
    }
    if (claim.kind === "existing" || claim.kind === "tombstone") {
      return toolJson({
        applied: true, dry_run: false, idempotent_replay: true, run_id: rid,
        operation_id: "operationId" in claim.record ? claim.record.operationId : undefined,
      });
    }
  }

  // ── v3 Snapshot + Private-Store 3-Way Merge + Recoverable Apply ─
  if (meta.workspaceId && meta.evidenceGitDir && existsSync(meta.evidenceGitDir)) {
    const ws = readWorkspaceMeta(meta.workspaceId);
    if (!ws) return toolError("Workspace metadata missing.", { run_id: rid, workspace_id: meta.workspaceId });
    if (!review.after_tree) {
      return toolError("Run evidence has no sealed after_tree; cannot apply safely.", { run_id: rid });
    }

    const parentRoot = normalizeCwd(meta.parentGitRoot);
    const targetHash = resourceKey(parentRoot);
    const effectiveScope: "worktree" | "run" = scope === "auto"
      ? (meta.resumeSessionId ? "worktree" : "run")
      : scope;

    // Determine merge baseline:
    // - scope='run' → this turn's before_tree
    // - scope='worktree'/'auto' → session's last applied watermark (if previously applied to this target), else immutable origin_tree!
    const watermark = ws.appliedWatermarks[targetHash];
    const baseTree = scope === "run"
      ? (review.before_tree ?? ws.originTree ?? EMPTY_TREE_OID)
      : scope === "worktree"
        ? (watermark ?? ws.originTree ?? EMPTY_TREE_OID)
        : (watermark ?? (meta.resumeSessionId ? (ws.originTree ?? EMPTY_TREE_OID) : (review.before_tree ?? ws.originTree ?? EMPTY_TREE_OID)));
    const resultTree = review.after_tree;

    if (baseTree === resultTree) {
      if (idempotencyKey && !dryRun) releaseUnstartedIdempotency("apply", idempotencyKey, rid);
      return toolJson({ applied: false, dry_run: dryRun, scope: effectiveScope, run_id: rid, reason: "No changes to apply." });
    }

    // Refuse if workspace has an active or unknown writer lease
    const wsLeaseConflict = checkLeaseConflictSync(`workspace:${meta.workspaceId}`);
    if (wsLeaseConflict.conflict) {
      if (idempotencyKey && !dryRun) releaseUnstartedIdempotency("apply", idempotencyKey, rid);
      return toolError(wsLeaseConflict.message, { run_id: rid, liveness: wsLeaseConflict.liveness });
    }

    // Acquire exclusive target lease on parent checkout (serializes multi-worker applies!)
    const applyNonce = randomUUID();
    let targetLease;
    try {
      targetLease = acquireLease(parentRoot, `apply-${rid}`, applyNonce);
    } catch (e: any) {
      if (idempotencyKey && !dryRun) releaseUnstartedIdempotency("apply", idempotencyKey, rid);
      return toolError(e?.message ?? String(e), { run_id: rid, parent_git_root: parentRoot });
    }

    try {
      // Step 1: Recover any previously interrupted PREPARED apply on this target before proceeding
      const pending = findPendingAppliesForTarget(targetHash);
      for (const pIntent of pending) {
        if (pIntent.status === "CONFLICT_DURING_RECOVERY") {
          return toolError(`Unresolved prior apply recovery conflict on ${pIntent.conflictPath}; resolve manually before applying new changes.`, {
            run_id: rid, blocking_operation_id: pIntent.operationId, conflict_path: pIntent.conflictPath,
          });
        }
        const recRes = executeOrRecoverApplyIntent(pIntent);
        if (!recRes.ok) {
          return toolError(`Prior interrupted apply recovery hit external modification: ${recRes.error}`, {
            run_id: rid, blocking_operation_id: pIntent.operationId, conflict_path: recRes.conflictPath,
          });
        }
      }

      // Step 2: Capture current parent checkout working directory `O` into evidence.git (index/HEAD untouched!)
      const oursTree = captureTreeIntoEvidence(parentRoot, meta.evidenceGitDir, `refs/codex-bridge/ours/${rid}`);

      // Step 3: Private-store 3-way merge (`CB`, `CO`, `CR` → `M`)
      const merge = computeThreeWayMerge(meta.evidenceGitDir, baseTree, oursTree, resultTree);
      if (!merge.ok) {
        if (idempotencyKey && !dryRun) releaseUnstartedIdempotency("apply", idempotencyKey, rid);
        return toolJson({
          applied: false,
          dry_run: dryRun,
          scope: effectiveScope,
          check_ok: false,
          run_id: rid,
          parent_git_root: parentRoot,
          conflicts: merge.conflicts,
          error: merge.message,
        });
      }

      // Step 4: Plan & security-validate `O → M` file materialization
      let plan;
      try {
        plan = planTreeMaterialization(meta.evidenceGitDir, parentRoot, oursTree, merge.mergedTree);
      } catch (e: any) {
        if (idempotencyKey && !dryRun) releaseUnstartedIdempotency("apply", idempotencyKey, rid);
        return toolError(`Apply rejected by safety policy: ${e?.message ?? String(e)}`, { run_id: rid, parent_git_root: parentRoot });
      }

      if (plan.sensitiveOmitted.length > 0) {
        if (idempotencyKey && !dryRun) releaseUnstartedIdempotency("apply", idempotencyKey, rid);
        return toolError("Refusing to apply: candidate changes include sensitive files or sensitive content aliases. Inspect and apply manually.", {
          run_id: rid, sensitive_diff_omitted: plan.sensitiveOmitted,
        });
      }

      if (plan.entries.length === 0) {
        return toolJson({
          applied: false, dry_run: dryRun, scope: effectiveScope, check_ok: true,
          run_id: rid, parent_git_root: parentRoot, reason: "Parent checkout already matches candidate changes.",
        });
      }

      if (dryRun) {
        return toolJson({
          applied: false,
          dry_run: true,
          scope: effectiveScope,
          check_ok: true,
          run_id: rid,
          parent_git_root: parentRoot,
          base_tree: baseTree,
          merged_tree: merge.mergedTree,
          files: plan.files,
          materialization_mode: "single_file_atomic_recoverable",
        });
      }

      // Step 5: Persist PREPARED intent, execute recoverable materialization, verify & mark COMMITTED!
      const intent = prepareApplyIntent({
        runId: rid,
        workspaceId: meta.workspaceId,
        targetDir: parentRoot,
        evidenceGitDir: meta.evidenceGitDir,
        baseTree,
        oursTree,
        resultTree,
        mergedTree: merge.mergedTree,
        entries: plan.entries,
      });

      const execRes = executeOrRecoverApplyIntent(intent);
      if (!execRes.ok) {
        return toolError(execRes.error, {
          run_id: rid, operation_id: intent.operationId, conflict_path: execRes.conflictPath,
        });
      }

      // Advance session watermark so subsequent resume turns apply cleanly as incremental deltas!
      updateWorkspaceMeta(meta.workspaceId, {
        appliedWatermarks: { ...ws.appliedWatermarks, [targetHash]: resultTree },
      });

      // Only cleanup AFTER COMMITTED receipt is durably published!
      let cleanupRes: { cleaned: boolean; worktree: string; note?: string; stderr?: string } | undefined;
      if (shouldCleanup) {
        cleanupRes = removeWorkspaceSrc(meta);
      }

      return toolJson({
        applied: true,
        dry_run: false,
        scope: effectiveScope,
        check_ok: true,
        run_id: rid,
        operation_id: intent.operationId,
        parent_git_root: parentRoot,
        base_tree: baseTree,
        merged_tree: merge.mergedTree,
        files: plan.files,
        materialization_mode: "single_file_atomic_recoverable",
        ...(cleanupRes ? {
          cleaned: cleanupRes.cleaned,
          worktree: cleanupRes.worktree,
          ...(cleanupRes.note ? { cleanup_note: cleanupRes.note } : {}),
          ...(cleanupRes.stderr ? { cleanup_stderr: cleanupRes.stderr } : {}),
        } : {}),
      });
    } finally {
      targetLease.release();
    }
  }

  // ── Legacy v2 linked-worktree patch apply fallback ──────────────
  const effectiveScope: "worktree" | "run" = scope === "auto" ? (meta.resumeSessionId ? "worktree" : "run") : scope;
  let patchPath: string;
  let files: Array<{ status?: string; path: string; from?: string }> = [];
  if (effectiveScope === "worktree") {
    if (!meta.worktreePath || !existsSync(meta.worktreePath)) {
      return toolError("Worktree no longer exists; pass scope='run' to apply only this turn's changes.patch.", { run_id: rid });
    }
    patchPath = path.join(rd, "worktree.patch");
    const exported = exportWorktreePatch(meta.worktreePath, patchPath);
    if (!exported.changed) return toolJson({ applied: false, dry_run: dryRun, scope: effectiveScope, run_id: rid, reason: "No changes to apply." });
    if (exported.sensitiveOmitted.length > 0) return toolError("Refusing to apply: worktree contains sensitive file changes.", { run_id: rid, sensitive_diff_omitted: exported.sensitiveOmitted });
    files = exported.files;
  } else {
    const gd = review.git_diff;
    if (!gd || !gd.is_git_repo || !gd.changed) return toolJson({ applied: false, dry_run: dryRun, scope: effectiveScope, run_id: rid, reason: "No changes to apply." });
    if (gd.sensitive_diff_omitted?.length) return toolError("Refusing to apply: run omitted sensitive files from changes.patch.", { run_id: rid, sensitive_diff_omitted: gd.sensitive_diff_omitted });
    if (!gd.diff_path || !existsSync(gd.diff_path)) return toolError("Run patch file (changes.patch) is missing.", { run_id: rid });
    patchPath = gd.diff_path;
    files = gd.files ?? [];
  }
  if (statSync(patchPath).size === 0) return toolJson({ applied: false, dry_run: dryRun, scope: effectiveScope, run_id: rid, reason: "Patch file is empty." });
  const gitEnv = buildGitEnv();
  const check = spawnSync("git", ["-C", meta.parentGitRoot, "apply", "--check", patchPath], { encoding: "utf8", env: gitEnv });
  if (check.status !== 0) {
    return toolJson({ applied: false, dry_run: dryRun, scope: effectiveScope, check_ok: false, run_id: rid, parent_git_root: meta.parentGitRoot, patch_path: patchPath, error: (check.stderr || check.stdout || "git apply --check failed").trim() });
  }
  if (dryRun) return toolJson({ applied: false, dry_run: true, scope: effectiveScope, check_ok: true, run_id: rid, parent_git_root: meta.parentGitRoot, files, patch_path: patchPath });
  const wl = acquireWriteLock(meta.parentGitRoot, `apply-${rid}`);
  let applyRes;
  try { applyRes = spawnSync("git", ["-C", meta.parentGitRoot, "apply", patchPath], { encoding: "utf8", env: gitEnv }); }
  finally { wl.release(); }
  if (applyRes.status !== 0) return toolError(`git apply failed: ${(applyRes.stderr || applyRes.stdout || "unknown error").trim()}`, { run_id: rid });
  const cleanupRes = shouldCleanup && meta.worktreePath ? removeWorkspaceSrc(meta) : undefined;
  return toolJson({ applied: true, dry_run: false, scope: effectiveScope, check_ok: true, run_id: rid, parent_git_root: meta.parentGitRoot, files, patch_path: patchPath, ...(cleanupRes ? { cleaned: cleanupRes.cleaned, worktree: cleanupRes.worktree } : {}) });
}

async function stopByRunId(rid: string) {
  const runDir = getRunDir(rid);
  const meta = readRunMeta(runDir);
  if (!meta) return toolError("Run not found.", { run_id: rid });

  const rec = await reconcileRunAsync(runDir, { forceProbe: true });
  const started = readStartedRecord(runDir);
  const workerPid = started?.workerPid ?? meta.workerPid;
  const codexPid = started?.codexPid ?? meta.codexPid;
  const bootId = started?.bootId;

  const workerLive = await probePidLivenessAsync(workerPid, bootId, (c) => commandMatchesWorker(c, rid));
  const codexLive = codexPid ? await probePidLivenessAsync(codexPid, bootId, (c) => commandMatchesCodex(c, rid)) : "gone";

  if ((rec.review || isTerminal(rec.progress?.status)) && workerLive === "gone" && codexLive === "gone") {
    return toolJson({ cancellation_requested: false, run_id: rid, status: rec.review?.status || rec.progress?.status, reason: "Run is not active." });
  }

  requestCancel(runDir, started?.ownerNonce ?? meta.ownerNonce);

  const killed: number[] = [];
  // Only send direct OS signal from MCP when worker itself is gone and codex child is proven to belong to this run!
  // When worker is alive, worker receives cancel.json via dir watch and terminates its own direct child cleanly.
  if (workerLive !== "alive" && codexLive === "alive" && codexPid) {
    killPidTree(codexPid, "SIGTERM");
    killed.push(codexPid);
    const pid = codexPid;
    const hardKill = setTimeout(() => {
      probePidLivenessAsync(pid, bootId, (c) => commandMatchesCodex(c, rid)).then((st) => {
        if (st === "alive") killPidTree(pid, "SIGKILL");
      }).catch(() => {});
    }, 5000);
    hardKill.unref();
  }

  const ses = byRunId.get(rid);
  if (ses) { ses.status = "cancelled"; ses.lastActiveAt = Date.now(); }

  return toolJson({
    cancellation_requested: true,
    signal_sent: killed.length > 0,
    run_id: rid,
    killed_codex_pids: killed,
    message: killed.length > 0
      ? "SIGTERM sent to verified orphan Codex child. SIGKILL follows in 5s if still alive."
      : "Cancellation intent written with owner nonce. Worker will stop Codex and seal evidence.",
  });
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  cleanOldTmpDirs();
  cleanOldRuns();
  // On startup, opportunistically reconcile any stale/unsealed runs asynchronously
  for (const r of listRuns().slice(0, 20)) {
    if (!readReviewPacket(getRunDir(r.runId))) {
      try { reconcileRunSync(getRunDir(r.runId)); } catch {}
    }
  }
  process.stderr.write(`codex-bridge v${PKG_VERSION} stable\n`);
  const t = new StdioServerTransport();
  await server.connect(t);
}
main().catch((e) => { process.stderr.write(`codex-bridge fatal: ${e.message}\n`); process.exit(1); });
