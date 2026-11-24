import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, execFileSync, spawnSync } from "child_process";
import { connect as tcpConnect } from "net";
import { existsSync, statSync, readFileSync, mkdirSync, openSync, closeSync, watch as fsWatch, rmSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { isTerminal, DEFAULT_IDLE_TIMEOUT, RECENT_RUN_LOOKUP_LIMIT, ACTIVE_SESSION_SCAN_LIMIT, type RunMeta, type ProgressState, type RunHandle, type RunHandleStatus, type Session, type ReviewPacketLike, type TokenUsage } from "./types.js";
import {
  CODEX_BINARY, CODEX_BINARY_REALPATH, buildCodexEnv, buildGitEnv, normalizeCwd, resolveExecContext,
  acquireWriteLock, checkWriteLockConflict, exportWorktreePatch, cmdOk, cleanOldTmpDirs, pidAlive, killPidTree, pidLooksLikeCodexForRun, pidDescendantOf,
} from "./evidence.js";
import {
  createRunDir, writeRunMeta, readRunMeta, readProgress, readProgressEventsSince,
  readReviewPacket, writeReviewPacket,
  pollForCompletion, updateProjectPointer, getRunDir, runDirExists,
  listRuns, cleanOldRuns, requestCancel, markWorkerDeadIfNeeded,
  assertRunId, updateProgress as updateProgressFile,
  getLatestRunForSession, durableStateStats, BASE_DIR, RUNS_DIR,
} from "./progress.js";
import { GrantRejection, normalizeGrants, resolveMcpHome } from "./grants.js";

const WT_DIR = path.join(path.dirname(RUNS_DIR), "wt");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_EXT = path.extname(__filename); // ".ts" in dev, ".js" in compiled
const WORKER_SCRIPT = path.join(__dirname, `worker${WORKER_EXT}`);

// Read version from package.json once at startup — no more hardcoding
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
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_TIMEOUT;
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

function cleanupFailedRunSetup(runDir: string, gitRoot: string | null, worktreePath?: string) {
  if (worktreePath && gitRoot) {
    try {
      spawnSync("git", ["-C", gitRoot, "worktree", "remove", "--force", worktreePath], { encoding: "utf8", env: buildGitEnv() });
    } catch {}
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
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

function countActiveWorktrees(): number {
  try {
    if (!existsSync(WT_DIR)) return 0;
    return readdirSync(WT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
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
// Codex JSONL emits no model field, so resolve what Codex itself will use:
// explicit -m/-c flags first, then the same config.toml Codex reads.
// Unknown stays unknown — never guess.
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

// ── In-memory session tracking ───────────────────────────────────
const byRunId = new Map<string, Session>();
const byCodexId = new Map<string, Session>();
function lookupMemory(id: string) { return byCodexId.get(id) || byRunId.get(id); }

// ── Session hydrate: pure parse + explicit cache ─────────────────
function sessionFromRun(runId: string): Session | undefined {
  const runDir = getRunDir(runId);
  const meta = readRunMeta(runDir);
  if (!meta) return undefined;
  const progress = readProgress(runDir);
  const review = readReviewPacket(runDir) as ReviewPacketLike | null;
  if (review?.resume_attached === false) return undefined;
  const sessionId = review?.session_id || progress?.sessionId;
  const status: Session["status"] = (review?.status as Session["status"]) || (progress?.status as Session["status"]) || "running";
  return {
    latestRunId: runId, runIds: [runId], sessionId,
    name: meta.sessionName, status, cwd: meta.cwd,
    gitRoot: meta.gitRoot || undefined, sandbox: meta.sandbox,
    startedAt: Date.parse(meta.createdAt), lastActiveAt: Date.now(),
    filesChanged: review?.git_diff?.files?.map((f) => f.path) ?? [],
    output: review?.output, diffPath: review?.git_diff?.diff_path,
    tokenUsage: review?.token_usage,
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
  // O(1): try by run_id directly
  if (runDirExists(id)) return hydrateSessionFromRun(id);
  // O(1): try session pointer index (skip if run was cleaned up)
  const runIdFromPointer = getLatestRunForSession(id);
  if (runIdFromPointer && runDirExists(runIdFromPointer)) {
    const hydrated = hydrateSessionFromRun(runIdFromPointer);
    if (hydrated) return hydrated;
  }
  // O(n) fallback: scan recent runs (covers gap before session pointer existed)
  for (const r of listRuns().slice(0, RECENT_RUN_LOOKUP_LIMIT)) {
    const runDir = getRunDir(r.runId);
    const review = readReviewPacket(runDir) as ReviewPacketLike | null;
    if (r.progress?.sessionId === id || review?.session_id === id) {
      return hydrateSessionFromRun(r.runId);
    }
  }
  return undefined;
}

// ── Session Active Guard ─────────────────────────────────────────
function runBelongsToSession(meta: RunMeta, progress: ProgressState | null, review: ReviewPacketLike | null, sessionId: string): boolean {
  if (meta.resumeSessionId === sessionId) return true;
  if (progress?.sessionId === sessionId) return true;
  if (review?.session_id === sessionId) return true;
  return false;
}

function runStatusFromState(review: ReviewPacketLike | null, progress: ProgressState | null): string | undefined {
  return review?.status || progress?.status;
}

function findActiveRunForSession(sessionId: string): { runId: string; status: string } | undefined {
  // Fast path: check session pointer (skip if run was cleaned up)
  const pointerRunId = getLatestRunForSession(sessionId);
  if (pointerRunId && runDirExists(pointerRunId)) {
    const runDir = getRunDir(pointerRunId);
    markWorkerDeadIfNeeded(runDir);
    const review = readReviewPacket(runDir) as ReviewPacketLike | null;
    const progress = readProgress(runDir);
    const status = runStatusFromState(review, progress);
    if (!isTerminal(status)) return { runId: pointerRunId, status: status || "unknown" };
  }
  // Scan recent runs — checks meta.resumeSessionId to catch the startup window
  // Only call markWorkerDeadIfNeeded on runs that belong to this session (avoid mass ps forks)
  for (const r of listRuns().slice(0, ACTIVE_SESSION_SCAN_LIMIT)) {
    const runDir = getRunDir(r.runId);
    const meta = readRunMeta(runDir);
    if (!meta) continue;
    const progress = readProgress(runDir);
    const review = readReviewPacket(runDir) as ReviewPacketLike | null;
    if (!runBelongsToSession(meta, progress, review, sessionId)) continue;
    markWorkerDeadIfNeeded(runDir);
    const freshProgress = readProgress(runDir);
    const freshReview = readReviewPacket(runDir) as ReviewPacketLike | null;
    const status = runStatusFromState(freshReview, freshProgress);
    if (!isTerminal(status)) return { runId: r.runId, status: status || "unknown" };
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
  // Redirect worker stdout/stderr to runDir/worker.log instead of a black hole —
  // crash diagnostics need somewhere to land.
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
    updateProgressFile(runDir, { status: "failed", message: "Failed to spawn worker process", error: "spawn returned no PID" });
    writeReviewPacket(runDir, { run_id: meta.runId, async: false, status: "failed", status_detail: "worker_spawn_failed", error: "Failed to spawn worker process", cwd: meta.cwd, git_root: meta.gitRoot || undefined });
    return { ok: false, error: "Failed to spawn worker process" };
  }
  // Write workerPid from parent immediately so liveness detection works even if worker crashes before self-registering
  writeRunMeta(runDir, { ...meta, workerPid });
  return { ok: true, workerPid };
}

// ── Build running handle ─────────────────────────────────────────
function runHandleStatus(progress: ProgressState | null): RunHandleStatus {
  switch (progress?.status) {
    case "failed": case "timeout": case "cancelled": return progress.status;
    default: return "running";
  }
}

const INITIAL_PROGRESS: ProgressState = { status: "starting", message: "Worker starting", updatedAt: new Date().toISOString(), seq: 0 };

function buildRunHandle(runId: string, meta: RunMeta, progress: ProgressState | null): RunHandle {
  return {
    run_id: runId,
    async: true,
    status: runHandleStatus(progress),
    session_id: progress?.sessionId,
    cwd: meta.cwd,
    git_root: meta.gitRoot || undefined,
    worktree_path: meta.worktreePath,
    progress: progress || INITIAL_PROGRESS,
    poll_with: `codex_sessions get --run_id ${runId}`,
  };
}

// ── Project Brief ────────────────────────────────────────────────
function buildProjectBrief(cwd: string, gitRoot: string | null, isWorktree = false): string | null {
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

  if (isWorktree) {
    parts.push("- Isolated git worktree: gitignored dependencies (e.g. node_modules/.venv) are not copied here; do not install packages into or modify the parent checkout");
  }
  parts.push("- Avoid: full filesystem scans, node_modules inspection");
  parts.push("- Do not start dev servers or network listeners unless explicitly requested");
  parts.push("- Do not read .agents/skills or unrelated agent instruction packs");
  parts.push("- Prefer build/lint/test commands over interactive dev servers");

  if (parts.length <= 2) return null;
  return `Project context:\n${parts.join("\n")}\n---\n`;
}

// ── View Helpers ────────────────────────────────────────────────
function tailText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value.length <= maxChars) return value;
  return "...[truncated; showing tail]...\n" + value.slice(-maxChars);
}

const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function isActiveRun(progress: ProgressState | null, review: ReviewPacketLike | null): boolean {
  if (review) return false;
  if (!progress) return false;
  return !isTerminal(progress.status);
}

function statusView(runId: string, progress: ProgressState | null, review: ReviewPacketLike | null, meta: RunMeta | null, progressEvents: ProgressState[] = []) {
  const active = isActiveRun(progress, review);
  // Use lastActivityAt (real Codex activity) over updatedAt (bridge progress write)
  const activityAt = progress?.lastActivityAt || progress?.updatedAt;
  const secondsSinceActivity = active && activityAt
    ? Math.max(0, Math.round((Date.now() - new Date(activityAt).getTime()) / 1000))
    : undefined;
  const stale = active && secondsSinceActivity !== undefined && secondsSinceActivity * 1000 > STALL_THRESHOLD_MS;
  return {
    run_id: runId,
    // async mirrors the completed packet's flag once review exists; a live run is by definition on the async path.
    async: review?.async ?? true,
    status: review?.status || progress?.status || "unknown",
    status_detail: review?.status_detail,
    failure_hint: review?.failure_hint,
    review_ready: Boolean(review),
    session_id: review?.session_id || progress?.sessionId,
    progress: progress ? {
      status: progress.status, message: progress.message,
      updatedAt: progress.updatedAt, seq: progress.seq, elapsedMs: progress.elapsedMs,
    } : undefined,
    ...(progressEvents.length > 0 && {
      progress_events: progressEvents.map((e) => ({ seq: e.seq, status: e.status, message: e.message, elapsedMs: e.elapsedMs })),
    }),
    seconds_since_last_activity: secondsSinceActivity,
    stale,
    ...(stale && { stale_warning: "No Codex activity for 5+ minutes. Ask the user whether to keep waiting or stop this run." }),
    cwd: meta?.cwd,
    git_root: meta?.gitRoot || undefined,
    worktree_path: meta?.worktreePath,
    isolation: meta?.isolation,
    sandbox: meta?.sandbox,
    timeout: meta?.timeout ?? null,
    idle_timeout: meta?.idleTimeout ?? null,
    model: meta?.resolvedModel ?? meta?.model ?? null,
    model_source: meta?.modelSource,
    effort: meta?.resolvedEffort ?? meta?.effort ?? null,
    effort_source: meta?.effortSource,
    codex_version: meta?.codexVersion,
    suggested_action: review ? "read_summary" : stale ? "ask_user_whether_to_continue_or_stop" : "continue_polling",
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
    status: review.status, status_detail: review.status_detail,
    failure_hint: review.failure_hint, partial_changes: review.partial_changes,
    session_id: review.session_id, session_name: review.session_name,
    duration_ms: review.duration_ms,
    timeout: review.timeout ?? null,
    idle_timeout: review.idle_timeout ?? null,
    isolation: review.isolation,
    worktree_path: review.worktree_path,
    parent_git_root: review.parent_git_root,
    ...(review.worktree_escape ? { worktree_escape: review.worktree_escape } : {}),
    ...(review.concurrent_parent_changes ? { concurrent_parent_changes: review.concurrent_parent_changes } : {}),
    model: review.model, model_source: review.model_source,
    effort: review.effort, effort_source: review.effort_source,
    codex_version: review.codex_version,
    token_usage: review.token_usage,
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
  };
}

function isProgressStale(progress: ProgressState | null): boolean {
  if (!progress || isTerminal(progress.status)) return false;
  const activityAt = progress.lastActivityAt || progress.updatedAt;
  if (!activityAt) return false;
  return Date.now() - new Date(activityAt).getTime() > STALL_THRESHOLD_MS;
}

function waitForProgressOrReview(
  runDir: string,
  sinceSeq: number | undefined,
  timeoutMs: number,
  waitFor: "terminal" | "progress" = "terminal",
): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const initialProgress = readProgress(runDir);
    const baseline = sinceSeq ?? initialProgress?.seq ?? 0;
    const staleAtStart = isProgressStale(initialProgress);
    let done = false;
    let watcher: ReturnType<typeof fsWatch> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      try { watcher?.close(); } catch {}
      if (fallbackTimer) clearTimeout(fallbackTimer);
      resolve();
    };

    const changed = () => {
      markWorkerDeadIfNeeded(runDir);
      if (readReviewPacket(runDir)) return true;
      const progress = readProgress(runDir);
      if (progress && isTerminal(progress.status)) return true;
      if (waitFor === "progress" && progress && progress.seq > baseline) return true;
      if (waitFor === "terminal" && !staleAtStart && isProgressStale(progress)) return true;
      return Date.now() >= deadline;
    };

    const scheduleFallback = () => {
      if (done) return;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      const remaining = deadline - Date.now();
      fallbackTimer = setTimeout(check, Math.min(2000, Math.max(250, remaining)));
      fallbackTimer.unref?.();
    };

    const check = () => {
      if (changed()) return finish();
      scheduleFallback();
    };

    // Event-driven: watch runDir for progress.json / review.json changes
    try {
      watcher = fsWatch(runDir, { persistent: false }, (_event, filename) => {
        if (done || !filename) return;
        const f = String(filename);
        if (f === "review.json" || f.startsWith("review.json.") || f === "progress.json" || f.startsWith("progress.json.")) {
          check();
        }
      });
      watcher.on("error", () => {
        try { watcher?.close(); } catch {}
        watcher = undefined;
        scheduleFallback();
      });
    } catch {
      // fs.watch unavailable — fallback only
    }

    check();
  });
}

// ── MCP Server ───────────────────────────────────────────────────
const SERVER_INSTRUCTIONS = [
  "codex-bridge is a run-scoped MCP evidence layer for delegating execution to OpenAI Codex CLI.",
  "",
  "Recommended workflow:",
  "1. Write tasks: prefer isolation='worktree' so the caller's checkout stays clean and parallel runs are safe. Preview or harvest finished worktree changes with codex_sessions(action='apply', run_id=..., dry_run=true|false, cleanup=true), or remove unused worktrees with action='cleanup'.",
  "2. Long or multi-file tasks: runs have NO arbitrary wall-clock cutoff by default — they are protected by an activity-based idle_timeout (default 900s with zero Codex JSONL output; pass timeout only if you want a hard wall cap). Use execution_mode='async' and wait with codex_sessions(action='get', run_id=..., view='summary', wait_seconds=240) (defaults to wait_for='terminal', waking on completion/failure/stale instead of every intermediate tick).",
  "3. Context economy: use return_view='summary' on sync/auto calls or read view='summary' first after completion; fetch view='diff' or view='output' only on demand. Pass wait_for='progress' with since_seq only when streaming live step ticks.",
  "4. Follow-ups on the same task: use codex_resume with session_id (inherits worktree, effort, idle_timeout, and shadow CODEX_HOME). Start an unrelated task with codex_exec.",
  "5. Always provide self-contained task specs (Codex has no prior chat context); include acceptance and non_goals for clear verification.",
].join("\n");

const server = new McpServer(
  { name: "codex-bridge", version: PKG_VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);
const SB = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const EM = z.enum(["auto", "sync", "async"]);
const RV = z.enum(["full", "summary"]);

server.tool("codex_exec", "Start a Codex run with run-scoped git diff, sensitive-content filtering, activity-based idle watchdog, and optional git worktree isolation. Use execution_mode='async' for multi-file/test work, and return_view='summary' for compact sync responses.", {
  task: z.string().min(1).describe("Self-contained task specification (Codex has no prior conversation context)."),
  cwd: z.string().describe("Absolute path to the target project/repository directory."),
  model: z.string().optional().describe("Optional Codex model override (defaults to user's Codex config)."),
  sandbox: SB.optional().default("workspace-write").describe("Codex sandbox mode: read-only, workspace-write (default), or danger-full-access."),
  timeout: z.number().int().min(0).max(86400).optional().describe("Optional hard wall-clock timeout in seconds. Omit or set 0 for unlimited wall time governed by idle_timeout."),
  idle_timeout: z.number().int().min(0).max(7200).optional().describe("Activity-based idle watchdog in seconds with zero real Codex JSONL stdout events (default 900; 0 disables)."),
  session_name: z.string().optional().describe("Optional human-readable label for this run/session."),
  max_diff_chars: z.number().int().min(1000).max(200000).optional().default(30000).describe("Maximum characters in diff_preview."),
  allow_non_git: z.boolean().optional().default(false).describe("Allow running in a non-git directory (disables diff capture)."),
  allow_large_untracked_snapshot: z.boolean().optional().default(false).describe("Bypass the 256MB untracked-file safety check."),
  danger_ack: z.boolean().optional().default(false).describe("Required true when sandbox='danger-full-access'."),
  execution_mode: EM.optional().default("auto").describe("auto (wait up to wait_budget_seconds then return async handle), sync, or async (return run_id immediately)."),
  wait_budget_seconds: z.number().int().min(0).max(MAX_WAIT_BUDGET).optional().default(DEFAULT_WAIT_BUDGET).describe("Seconds to wait in auto mode before returning an async handle (clamped by CODEX_BRIDGE_MAX_WAIT_SECONDS)."),
  project_brief: z.boolean().optional().default(true).describe("Prepend compact auto-detected project context (package manager, tech stack, main dirs)."),
  isolation: z.enum(["inplace", "worktree"]).optional().default("inplace").describe("inplace edits cwd directly (serialized by write lock); worktree creates an isolated git worktree under CODEX_BRIDGE_HOME/wt/<run_id>."),
  base: z.string().optional().describe("Git ref to base the worktree on when isolation='worktree' (default HEAD)."),
  effort: z.string().optional().describe("Optional reasoning effort override (e.g. low, medium, high, xhigh)."),
  acceptance: z.string().optional().describe("Explicit acceptance criteria appended to the prompt for Codex to self-verify."),
  non_goals: z.string().optional().describe("Explicit out-of-scope constraints appended to the prompt."),
  output_schema: z.string().optional().describe("Optional JSON Schema string enforced via Codex --output-schema."),
  grants_mcp: z.array(z.string()).optional().describe("Whitelist of MCP server names from ~/.codex/config.toml to expose inside the worker's shadow CODEX_HOME (default empty = zero MCP surface)."),
  return_view: RV.optional().default("full").describe("Response shape if the run completes within wait_budget_seconds: full (default) or summary (compact diff stats + tail)."),
}, async (args) => {
  const { task, model, sandbox, session_name, max_diff_chars, allow_non_git, allow_large_untracked_snapshot, danger_ack, execution_mode, wait_budget_seconds, project_brief, isolation, base, effort, acceptance, non_goals, output_schema, grants_mcp, return_view } = args;
  const timeout = resolveWallTimeout(args.timeout);
  const idleTimeout = resolveIdleTimeout(args.idle_timeout);

  let cwd: string;
  try { cwd = normalizeCwd(args.cwd); } catch (e: any) { return toolError(e.message); }
  if (sandbox === "danger-full-access" && !danger_ack) return toolError("danger-full-access requires danger_ack=true.");

  const { runCwd, gitRoot, gitRepo } = resolveExecContext(cwd);
  if (!gitRepo && !allow_non_git) return toolError("Not a Git repo. Set allow_non_git=true.", { cwd: runCwd });
  if (isolation === "worktree" && !gitRepo) return toolError("isolation=worktree requires a git repo.");

  const useWorktree = isolation === "worktree" && sandbox !== "read-only";
  if (sandbox !== "read-only" && !useWorktree) {
    const conflict = checkWriteLockConflict(gitRepo ? gitRoot : runCwd);
    if (conflict) return toolError(conflict);
  }

  const runId = randomUUID();
  const runDir = createRunDir(runId);

  let worktreePath: string | undefined;
  let effectiveCwd = runCwd;
  if (useWorktree) {
    worktreePath = path.join(WT_DIR, runId);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    const add = spawnSync("git", ["-C", gitRoot as string, "worktree", "add", "--detach", worktreePath, base ?? "HEAD"], { encoding: "utf8", env: buildGitEnv() });
    if (add.status !== 0) {
      cleanupFailedRunSetup(runDir, null);
      return toolError(`worktree add failed: ${(add.stderr || add.stdout || "").trim()}`, { worktree: worktreePath });
    }
    effectiveCwd = worktreePath;
  }

  let finalTask = task;
  if (project_brief) {
    const brief = buildProjectBrief(effectiveCwd, useWorktree ? effectiveCwd : (gitRepo ? gitRoot : null), useWorktree);
    if (brief) finalTask = brief + task;
  }
  if (acceptance) finalTask += `\n\nAcceptance criteria (verify before finishing):\n${acceptance}`;
  if (non_goals) finalTask += `\n\nNon-goals (do NOT do these):\n${non_goals}`;
  if (useWorktree) finalTask += `\n\nConstraints: your ONLY writable directory is ${worktreePath}. The checkout at ${gitRoot} is read-only context — do not create, modify, or delete files there or anywhere outside your worktree. Do not commit, do not push.`;

  // cx137/capability-surface §G3: workers run in a shadow CODEX_HOME with a
  // zero-MCP default; only grants_mcp servers are provisioned there (whitelist,
  // fail-closed — plugin servers and ungranted config are absent by design).
  let mcpHome: string | undefined;
  try {
    mcpHome = resolveMcpHome(normalizeGrants({ mcp: grants_mcp ?? [] }), effectiveCwd, runDir).codexHome;
  } catch (e: any) {
    cleanupFailedRunSetup(runDir, gitRepo ? gitRoot : null, worktreePath);
    const details = e instanceof GrantRejection ? e.toDetails() : undefined;
    return toolError(e?.message ?? String(e), details);
  }

  const meta: RunMeta = {
    runId, cwd: effectiveCwd, gitRoot: gitRepo ? gitRoot : null, sandbox, task: finalTask,
    model, timeout, idleTimeout, sessionName: session_name || `run-${runId.slice(0, 8)}`,
    maxDiffChars: max_diff_chars, allowNonGit: allow_non_git,
    allowLargeUntracked: allow_large_untracked_snapshot, dangerAck: danger_ack,
    createdAt: new Date().toISOString(),
    isolation, worktreePath, parentGitRoot: useWorktree ? gitRoot : undefined,
    effort, outputSchema: output_schema,
    mcpHome, grants: { mcp: grants_mcp ?? [] },
    ...resolveCodexRunConfig(model, effort),
  };
  writeRunMeta(runDir, meta);

  const w = startWorker(runDir, meta);
  if (!w.ok) return toolError(w.error, { run_id: runId });

  // Update project pointer after confirmed spawn so statusline can show running state
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
    const p = packet as Record<string, unknown>;
    ses.status = (p.status as Session["status"]) || "completed";
    ses.lastActiveAt = Date.now();
    ses.output = p.output as string | undefined;
    ses.filesChanged = ((p.git_diff as any)?.files || []).map((f: any) => f.path);
    ses.diffPath = (p.git_diff as any)?.diff_path;
    ses.tokenUsage = p.token_usage as any;
    if (p.session_id) { ses.sessionId = p.session_id as string; byCodexId.set(ses.sessionId, ses); }
    return toolJson(return_view === "summary" ? compactReviewSummary(runId, packet as ReviewPacketLike, 20000) : packet);
  }

  const progress = markWorkerDeadIfNeeded(runDir);
  const failPacket = readReviewPacket(runDir);
  if (failPacket) {
    const p = failPacket as Record<string, unknown>;
    ses.status = (p.status as Session["status"]) || "failed";
    ses.lastActiveAt = Date.now();
    return toolJson(return_view === "summary" ? compactReviewSummary(runId, failPacket as ReviewPacketLike, 20000) : failPacket);
  }

  return toolJson(buildRunHandle(runId, meta, progress));
});

server.tool("codex_resume", "Resume an existing Codex session for follow-up fixes or iterations. Preserves thread_id verification, worktree isolation, effort, idle_timeout, and shadow CODEX_HOME.", {
  session_id: z.string().min(1).describe("Codex session_id (thread_id) from a prior codex_exec run."),
  task: z.string().min(1).describe("Follow-up instructions for the existing Codex session."),
  cwd: z.string().optional().describe("Optional working directory (must match the original session cwd or parent repo for worktree runs)."),
  sandbox: SB.optional().describe("Cannot override original session sandbox; omit unless matching."),
  model: z.string().optional().describe("Optional model override for this resumed turn."),
  effort: z.string().optional().describe("Optional reasoning effort override (inherits parent run effort if omitted)."),
  timeout: z.number().int().min(0).max(86400).optional().describe("Optional hard wall-clock timeout in seconds (inherits parent run timeout if omitted; 0 disables)."),
  idle_timeout: z.number().int().min(0).max(7200).optional().describe("Activity-based idle watchdog in seconds (inherits parent run idle_timeout if omitted; 0 disables)."),
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
  const { session_id, task, cwd: cwdArg, max_diff_chars, allow_non_git, allow_large_untracked_snapshot, danger_ack, execution_mode, wait_budget_seconds, project_brief, acceptance, non_goals, return_view } = args;

  const ex = lookupWithDurable(session_id);
  const rsid = ex?.sessionId || session_id;
  if (byRunId.has(session_id) && !ex?.sessionId) return toolError("Cannot resume by run_id. Pass Codex session_id.", { run_id: session_id });

  // cx141 ruling §1: a resumed run must reuse the parent run's shadow
  // CODEX_HOME — the session file lives inside it. Falling back to the real
  // home would lose the session AND re-widen the MCP surface; fail closed.
  const parentRunId = ex?.latestRunId;
  const parentMeta = parentRunId && runDirExists(parentRunId) ? readRunMeta(getRunDir(parentRunId)) : null;
  const isParentWorktree = Boolean(parentMeta?.isolation === "worktree" && parentMeta.worktreePath);

  if (isParentWorktree && !existsSync(parentMeta!.worktreePath!)) {
    return toolError("Cannot resume: worktree was already cleaned up.", { session_id, worktree_path: parentMeta!.worktreePath });
  }

  if (ex && cwdArg) {
    try {
      const requestedCwd = normalizeCwd(cwdArg);
      const allowedCwds = new Set<string>([ex.cwd]);
      if (parentMeta?.worktreePath && existsSync(parentMeta.worktreePath)) allowedCwds.add(normalizeCwd(parentMeta.worktreePath));
      if (parentMeta?.parentGitRoot && existsSync(parentMeta.parentGitRoot)) allowedCwds.add(normalizeCwd(parentMeta.parentGitRoot));
      if (!allowedCwds.has(requestedCwd)) {
        return toolError("codex_resume cannot override cwd (Codex CLI resume has no -C). Use original session cwd.", { requested: cwdArg, session_cwd: ex.cwd, session_id });
      }
    } catch (e: any) { return toolError(e.message); }
  }
  if (ex && args.sandbox && args.sandbox !== ex.sandbox) return toolError("codex_resume cannot override sandbox (Codex CLI resume has no -s). Use original session sandbox.", { requested: args.sandbox, session_sandbox: ex.sandbox, session_id });
  if (!ex && args.sandbox) return toolError("codex_resume cannot enforce sandbox for an unknown external session. Omit sandbox or resume a bridge-created session.", { requested_sandbox: args.sandbox, assumed_sandbox: "workspace-write", session_id });

  const rawCwd = isParentWorktree ? parentMeta!.worktreePath! : (ex?.cwd || cwdArg);
  if (!rawCwd) return toolError("Unknown session. Provide cwd for evidence capture.", { session_id });
  let cwd: string; try { cwd = normalizeCwd(rawCwd); } catch (e: any) { return toolError(e.message); }

  const effectiveSandbox = ex?.sandbox || "workspace-write";
  if (effectiveSandbox === "danger-full-access" && !danger_ack) return toolError("Resuming danger-full-access session requires danger_ack=true.");

  const { runCwd, gitRoot, gitRepo } = resolveExecContext(cwd);
  if (!gitRepo && !allow_non_git) return toolError("Not a Git repo. Set allow_non_git=true.", { cwd: runCwd });

  if (!parentMeta?.mcpHome) {
    return toolError("cannot resume: no parent run with a shadow CODEX_HOME to inherit (pre-grants or external session). Fail closed — start a fresh codex_exec.", { session_id, parent_run_id: parentRunId ?? null });
  }

  if (effectiveSandbox !== "read-only") {
    const conflict = checkWriteLockConflict(gitRepo ? gitRoot : runCwd);
    if (conflict) return toolError(conflict);
  }

  // Session-level active guard: prevent concurrent resume of same Codex thread
  const activeRun = findActiveRunForSession(rsid);
  if (activeRun) return toolError("Codex session already has an active run. Wait for it to finish or stop it before resuming.", { session_id: rsid, active_run_id: activeRun.runId, status: activeRun.status });

  const timeout = args.timeout !== undefined ? resolveWallTimeout(args.timeout) : (parentMeta.timeout ?? null);
  const idleTimeout = resolveIdleTimeout(args.idle_timeout, parentMeta.idleTimeout);

  const runId = randomUUID();
  const runDir = createRunDir(runId);
  const resumeContextVerified = Boolean(ex);

  let finalTask = task;
  if (project_brief) {
    const brief = buildProjectBrief(runCwd, isParentWorktree ? runCwd : (gitRepo ? gitRoot : null), isParentWorktree);
    if (brief) finalTask = brief + task;
  }
  if (acceptance) finalTask += `\n\nAcceptance criteria (verify before finishing):\n${acceptance}`;
  if (non_goals) finalTask += `\n\nNon-goals (do NOT do these):\n${non_goals}`;
  if (isParentWorktree && parentMeta.parentGitRoot) {
    finalTask += `\n\nConstraints: your ONLY writable directory is ${parentMeta.worktreePath}. The checkout at ${parentMeta.parentGitRoot} is read-only context — do not create, modify, or delete files there or anywhere outside your worktree. Do not commit, do not push.`;
  }

  const mcpHome = parentMeta.mcpHome;
  const inheritedGrants = parentMeta.grants ?? { mcp: [] };
  const effectiveEffort = args.effort ?? parentMeta.effort;

  const meta: RunMeta = {
    runId, cwd: runCwd, gitRoot: gitRepo ? gitRoot : null, sandbox: effectiveSandbox,
    task: finalTask, model: args.model, timeout, idleTimeout,
    sessionName: ex?.name || `resumed-${rsid.slice(0, 8)}`,
    maxDiffChars: max_diff_chars, allowNonGit: allow_non_git,
    allowLargeUntracked: allow_large_untracked_snapshot, dangerAck: danger_ack,
    createdAt: new Date().toISOString(), resumeSessionId: rsid,
    resumeContextVerified,
    isolation: parentMeta.isolation,
    worktreePath: isParentWorktree ? parentMeta.worktreePath : undefined,
    parentGitRoot: isParentWorktree ? parentMeta.parentGitRoot : undefined,
    effort: effectiveEffort,
    mcpHome, grants: inheritedGrants,
    ...resolveCodexRunConfig(args.model, effectiveEffort),
  };
  writeRunMeta(runDir, meta);

  const w = startWorker(runDir, meta);
  if (!w.ok) return toolError(w.error, { run_id: runId });

  if (gitRepo) updateProjectPointer(isParentWorktree && parentMeta.parentGitRoot ? parentMeta.parentGitRoot : gitRoot, runId);

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
  // Only index by Codex session id for bridge-known sessions; unknown external sessions must be verified by worker first
  if (ex) byCodexId.set(rsid, ses);

  if (execution_mode === "async") {
    const progress = readProgress(runDir);
    return toolJson(buildRunHandle(runId, meta, progress));
  }

  const waitMs = clampWaitSeconds(execution_mode === "sync" ? MAX_WAIT_BUDGET : wait_budget_seconds) * 1000;
  const packet = await pollForCompletion(runDir, waitMs);

  if (packet) {
    const p = packet as Record<string, unknown>;
    ses.status = (p.status as Session["status"]) || "completed";
    ses.lastActiveAt = Date.now();
    ses.output = p.output as string | undefined;
    ses.filesChanged = [...new Set([...ses.filesChanged, ...((p.git_diff as any)?.files || []).map((f: any) => f.path)])];
    ses.tokenUsage = p.token_usage as any;
    const attached = p.resume_attached !== false;
    const sessionId = p.session_id as string | undefined;
    if (sessionId && attached) { ses.sessionId = sessionId; byCodexId.set(sessionId, ses); }
    if (!attached && !ex) byRunId.delete(runId);
    return toolJson(return_view === "summary" ? compactReviewSummary(runId, packet as ReviewPacketLike, 20000) : packet);
  }

  const progress = markWorkerDeadIfNeeded(runDir);
  const failPacket = readReviewPacket(runDir);
  if (failPacket) {
    const p = failPacket as Record<string, unknown>;
    ses.status = (p.status as Session["status"]) || "failed";
    ses.lastActiveAt = Date.now();
    if (!ex && p.resume_attached === false) byRunId.delete(runId);
    return toolJson(return_view === "summary" ? compactReviewSummary(runId, failPacket as ReviewPacketLike, 20000) : failPacket);
  }

  return toolJson(buildRunHandle(runId, meta, progress));
});

const RunIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional();

const VIEW = z.enum(["status", "summary", "review", "diff", "output"]);

server.tool("codex_sessions", "List, inspect, wait on, stop, apply/clean up worktrees, or run doctor diagnostics. Long-poll with wait_seconds and view='summary' (wait_for='terminal' default) to wait cleanly for completion in one call.", {
  action: z.enum(["list", "get", "stop", "doctor", "cleanup", "apply"]).describe("list recent runs, get run status/summary/diff/output/review, stop an active run, doctor environment check, apply a completed worktree run's diff into the parent checkout, or cleanup a worktree."),
  session_id: z.string().optional().describe("Codex session_id (alternative to run_id for get/stop)."),
  run_id: RunIdSchema.describe("UUID of a codex-bridge run (required for cleanup/apply; preferred for get/stop)."),
  view: VIEW.optional().default("status").describe("For action='get': status (lightweight poll), summary (compact files/warnings/tail), diff, output, or review."),
  max_chars: z.number().int().min(1000).max(200000).optional().default(20000).describe("Character cap for diff/output/review views."),
  wait_seconds: z.number().int().min(0).max(600).optional().default(0).describe("Event-driven long-poll duration in seconds for action='get' (works with any view; clamped by CODEX_BRIDGE_MAX_WAIT_SECONDS)."),
  wait_for: z.enum(["terminal", "progress"]).optional().default("terminal").describe("For wait_seconds > 0: 'terminal' (default) waits until completion/failure/stale/deadline; 'progress' wakes on each new progress event."),
  verbose: z.boolean().optional().default(false).describe("Include git_root, sandbox, model, and progress message in action='list'."),
  since_seq: z.number().int().min(0).optional().describe("Return incremental progress_events with seq > since_seq."),
  dry_run: z.boolean().optional().default(false).describe("For action='apply': run git apply --check without modifying the parent checkout."),
  cleanup: z.boolean().optional().default(false).describe("For action='apply': remove the worktree automatically after a clean apply."),
  allow_partial: z.boolean().optional().default(false).describe("For action='apply': allow applying partial changes from a non-completed run after manual inspection."),
  scope: z.enum(["auto", "worktree", "run"]).optional().default("auto").describe("For action='apply': 'auto' (default) applies the full worktree diff from HEAD for multi-turn resumed sessions and changes.patch for single-turn runs; 'worktree' forces full worktree diff; 'run' forces this single turn's changes.patch."),
}, async (args) => {
  const { action, session_id: sid, run_id: rid, view, max_chars, wait_seconds, wait_for, verbose, since_seq, dry_run, cleanup, allow_partial, scope } = args;

  if (action === "doctor") {
    const stats = durableStateStats();
    const connectivity = await tcpProbe("api.openai.com", 443, 5000);
    const codexEnv = buildCodexEnv();
    const gitEnv = buildGitEnv();
    const codexVersion = cmdOk(CODEX_BINARY, ["--version"], { env: codexEnv, timeout: 10_000 });
    const codexAuth = cmdOk(CODEX_BINARY, ["login", "status"], { env: codexEnv, timeout: 10_000 });
    const gitVersion = cmdOk("git", ["--version"], { env: gitEnv, timeout: 10_000 });
    return toolJson({
      bridge_version: PKG_VERSION,
      codex_binary: CODEX_BINARY,
      ...(CODEX_BINARY_REALPATH && CODEX_BINARY_REALPATH !== CODEX_BINARY ? { codex_binary_realpath: CODEX_BINARY_REALPATH } : {}),
      codex_version: codexVersion,
      codex_auth: codexAuth,
      git_version: gitVersion,
      node: process.version, platform: process.platform, arch: process.arch,
      bridge_home: BASE_DIR,
      bridge_home_writable: isBridgeHomeWritable(),
      active_worktrees: countActiveWorktrees(),
      max_wait_seconds: MAX_CLIENT_WAIT_SECONDS,
      default_idle_timeout_seconds: CONFIGURED_DEFAULT_IDLE_TIMEOUT,
      default_wall_timeout_seconds: null,
      env: { has_HOME: Boolean(process.env.HOME), has_CODEX_HOME: Boolean(process.env.CODEX_HOME), has_CODEX_BRIDGE_HOME: Boolean(process.env.CODEX_BRIDGE_HOME), has_OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY), has_proxy: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY) },
      network: { ...connectivity, probe: "direct_tcp", host: "api.openai.com", port: 443, note: "Direct TCP probe. Proxy/VPN/PAC environments may differ from actual Codex connectivity." },
      durable_state: { run_count: stats.runCount, session_pointers: stats.sessionPointerCount, disk_bytes: stats.totalBytes, disk_mb: Math.round(stats.totalBytes / 1024 / 1024 * 10) / 10, oldest_run: stats.oldestRun, cleanup_policy: "7 days, triggered on startup and hourly during use" },
    });
  }

  if (action === "list") {
    const durableRuns = listRuns().slice(0, 50);
    return toolJson({
      sessions: durableRuns.map((r) => {
        const rd = getRunDir(r.runId);
        markWorkerDeadIfNeeded(rd);
        const progress = readProgress(rd);
        const review = readReviewPacket(rd) as Record<string, unknown> | null;
        const compact = {
          run_id: r.runId,
          session_name: r.meta.sessionName,
          status: (review?.status as string) || progress?.status || "unknown",
          cwd: r.meta.cwd,
          isolation: r.meta.isolation,
          ...(r.meta.worktreePath ? { worktree_exists: existsSync(r.meta.worktreePath) } : {}),
          created_at: r.meta.createdAt,
          session_id: progress?.sessionId || (review?.session_id as string),
        };
        if (!verbose) return compact;
        return {
          ...compact,
          git_root: r.meta.gitRoot,
          sandbox: r.meta.sandbox,
          model: r.meta.resolvedModel ?? r.meta.model ?? null,
          model_source: r.meta.modelSource,
          message: progress?.message,
        };
      }),
    });
  }

  // ── GET ────────────────────────────────────────────────────────
  if (action === "get") {
    if (rid) return getByRunId(rid, view, max_chars, wait_seconds, since_seq, wait_for);
    if (sid) {
      const runId = findRunIdBySessionId(sid);
      if (runId) return getByRunId(runId, view, max_chars, wait_seconds, since_seq, wait_for);
      return toolError("Session not found. Pass cwd to codex_resume.", { session_id: sid });
    }
    return toolError("session_id or run_id required for get");
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

  // ── CLEANUP (worktree runs) ───────────────────────────────────
  if (action === "cleanup") {
    if (!rid) return toolError("run_id required for cleanup");
    return cleanupWorktreeByRunId(rid);
  }

  // ── APPLY (harvest worktree diff into parent checkout) ────────
  if (action === "apply") {
    if (!rid) return toolError("run_id required for apply");
    return applyByRunId(rid, dry_run, cleanup, allow_partial, scope);
  }

  return toolError("Unknown action");
});

// ── Session → Run lookup (unified for get/stop/resume) ──────────
function findRunIdBySessionId(sessionId: string): string | undefined {
  const memory = lookupMemory(sessionId);
  if (memory) return memory.latestRunId;
  const pointerRunId = getLatestRunForSession(sessionId);
  if (pointerRunId && runDirExists(pointerRunId)) return pointerRunId;
  for (const r of listRuns().slice(0, RECENT_RUN_LOOKUP_LIMIT)) {
    const runDir = getRunDir(r.runId);
    const review = readReviewPacket(runDir) as ReviewPacketLike | null;
    if (r.progress?.sessionId === sessionId || review?.session_id === sessionId) return r.runId;
  }
  return undefined;
}

// ── Action helpers ───────────────────────────────────────────────
async function getByRunId(
  rid: string,
  view: "status" | "summary" | "review" | "diff" | "output" = "status",
  maxChars: number = 20000,
  waitSeconds: number = 0,
  sinceSeq?: number,
  waitFor: "terminal" | "progress" = "terminal",
) {
  const runDir = getRunDir(rid);
  if (!runDirExists(rid)) return toolError("Run not found.", { run_id: rid });

  // Event-driven long-poll: waits until completion/failure/stale/deadline (or next tick if wait_for='progress')
  const effectiveWait = clampWaitSeconds(waitSeconds);
  if (effectiveWait > 0) await waitForProgressOrReview(runDir, sinceSeq, effectiveWait * 1000, waitFor);

  markWorkerDeadIfNeeded(runDir);
  const meta = readRunMeta(runDir);
  const progress = readProgress(runDir);
  const review = readReviewPacket(runDir) as ReviewPacketLike | null;

  // Hydrate session into memory so subsequent resume can find it
  if (review) hydrateSessionFromRun(rid);

  // status: always lightweight, even when review is ready
  if (view === "status") {
    const progressEvents = sinceSeq !== undefined
      ? readProgressEventsSince(runDir, sinceSeq, 20, "after")
      : readProgressEventsSince(runDir, 0, 3, "recent"); // first poll: show recent 3 events
    return toolJson(statusView(rid, progress, review, meta, progressEvents));
  }

  // Other views need review to be ready
  if (!review) {
    const progressEvents = sinceSeq !== undefined
      ? readProgressEventsSince(runDir, sinceSeq, 20, "after")
      : readProgressEventsSince(runDir, 0, 3, "recent");
    return toolJson({
      ...statusView(rid, progress, review, meta, progressEvents),
      message: "Run still in progress; retry action='get' with wait_seconds to wait for completion.",
    });
  }

  if (view === "summary") return toolJson(compactReviewSummary(rid, review, maxChars));
  if (view === "review") return toolJson(limitReviewPacket(review, maxChars));
  if (view === "diff") return toolJson(diffOnlyView(rid, review, maxChars));
  if (view === "output") {
    return toolJson({
      run_id: rid, status: review.status,
      output: tailText(review.output, maxChars),
      output_source: review.output_source,
      output_truncated: review.output_truncated,
      stderr: tailText(review.stderr, Math.min(maxChars, 20000)),
      stderr_truncated: review.stderr_truncated,
    });
  }

  return toolJson(statusView(rid, progress, review, meta));
}

function removeWorktreeDir(meta: RunMeta): { cleaned: boolean; worktree: string; note?: string; stderr?: string } {
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

function cleanupWorktreeByRunId(rid: string) {
  if (!runDirExists(rid)) return toolError("Run not found.", { run_id: rid });
  const rd = getRunDir(rid);
  markWorkerDeadIfNeeded(rd);
  const meta = readRunMeta(rd);
  if (!meta?.worktreePath) return toolJson({ cleaned: false, reason: "Run did not use isolation=worktree." });
  const review = readReviewPacket(rd);
  const progress = readProgress(rd);
  if (!review && !isTerminal(progress?.status)) {
    return toolError("Cannot cleanup worktree while run is active. Stop the run first.", {
      run_id: rid, status: progress?.status ?? "unknown", worktree: meta.worktreePath,
    });
  }
  return toolJson(removeWorktreeDir(meta));
}

function applyByRunId(rid: string, dryRun: boolean, shouldCleanup: boolean, allowPartial: boolean, scope: "auto" | "worktree" | "run" = "auto") {
  if (!runDirExists(rid)) return toolError("Run not found.", { run_id: rid });
  const rd = getRunDir(rid);
  markWorkerDeadIfNeeded(rd);
  const meta = readRunMeta(rd);
  if (!meta || meta.isolation !== "worktree" || !meta.parentGitRoot) {
    return toolError("action='apply' only supports isolation='worktree' runs.", { run_id: rid, isolation: meta?.isolation ?? "unknown" });
  }
  if (!existsSync(meta.parentGitRoot)) {
    return toolError("Parent git repository no longer exists.", { run_id: rid, parent_git_root: meta.parentGitRoot });
  }
  const review = readReviewPacket(rd) as ReviewPacketLike | null;
  const progress = readProgress(rd);
  if (!review) {
    return toolError("Cannot apply worktree run before completion.", { run_id: rid, status: progress?.status ?? "unknown" });
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

  const effectiveScope: "worktree" | "run" = scope === "auto"
    ? (meta.resumeSessionId ? "worktree" : "run")
    : scope;

  let patchPath: string;
  let files: Array<{ status?: string; path: string; from?: string }> = [];

  if (effectiveScope === "worktree") {
    if (!meta.worktreePath || !existsSync(meta.worktreePath)) {
      return toolError("Worktree no longer exists; pass scope='run' to apply only this turn's changes.patch.", {
        run_id: rid, worktree_path: meta.worktreePath,
      });
    }
    patchPath = path.join(rd, "worktree.patch");
    let exported;
    try {
      exported = exportWorktreePatch(meta.worktreePath, patchPath);
    } catch (e: any) {
      return toolError(`Failed to generate worktree patch: ${e?.message ?? String(e)}`, { run_id: rid, worktree_path: meta.worktreePath });
    }
    if (!exported.changed) {
      return toolJson({ applied: false, dry_run: dryRun, scope: effectiveScope, run_id: rid, reason: "No changes to apply." });
    }
    if (exported.sensitiveOmitted.length > 0) {
      return toolError("Refusing to apply: worktree contains sensitive file changes. Inspect and apply manually.", {
        run_id: rid, sensitive_diff_omitted: exported.sensitiveOmitted,
      });
    }
    files = exported.files;
  } else {
    const gd = review.git_diff;
    if (!gd || !gd.is_git_repo || !gd.changed) {
      return toolJson({ applied: false, dry_run: dryRun, scope: effectiveScope, run_id: rid, reason: "No changes to apply." });
    }
    if (gd.sensitive_diff_omitted && gd.sensitive_diff_omitted.length > 0) {
      return toolError("Refusing to apply: run omitted sensitive files from changes.patch. Inspect and apply manually.", {
        run_id: rid, sensitive_diff_omitted: gd.sensitive_diff_omitted,
      });
    }
    if (!gd.diff_path || !existsSync(gd.diff_path)) {
      return toolError("Run patch file (changes.patch) is missing.", { run_id: rid, patch_path: gd.diff_path });
    }
    patchPath = gd.diff_path;
    files = gd.files ?? [];
  }

  if (statSync(patchPath).size === 0) {
    return toolJson({ applied: false, dry_run: dryRun, scope: effectiveScope, run_id: rid, reason: "Patch file is empty; nothing to apply." });
  }

  const conflict = checkWriteLockConflict(meta.parentGitRoot);
  if (conflict) return toolError(conflict, { run_id: rid, parent_git_root: meta.parentGitRoot });

  const gitEnv = buildGitEnv();
  const check = spawnSync("git", ["-C", meta.parentGitRoot, "apply", "--check", patchPath], { encoding: "utf8", env: gitEnv });
  if (check.status !== 0) {
    return toolJson({
      applied: false,
      dry_run: dryRun,
      scope: effectiveScope,
      check_ok: false,
      run_id: rid,
      parent_git_root: meta.parentGitRoot,
      patch_path: patchPath,
      error: (check.stderr || check.stdout || "git apply --check failed").trim(),
    });
  }
  if (dryRun) {
    return toolJson({
      applied: false,
      dry_run: true,
      scope: effectiveScope,
      check_ok: true,
      run_id: rid,
      parent_git_root: meta.parentGitRoot,
      files,
      patch_path: patchPath,
    });
  }

  let wl;
  try {
    wl = acquireWriteLock(meta.parentGitRoot, `apply-${rid}`);
  } catch (e: any) {
    return toolError(e?.message ?? String(e), { run_id: rid, parent_git_root: meta.parentGitRoot });
  }
  let applyRes;
  try {
    applyRes = spawnSync("git", ["-C", meta.parentGitRoot, "apply", patchPath], { encoding: "utf8", env: gitEnv });
  } finally {
    wl.release();
  }
  if (applyRes.status !== 0) {
    return toolError(`git apply failed: ${(applyRes.stderr || applyRes.stdout || "unknown error").trim()}`, {
      run_id: rid, parent_git_root: meta.parentGitRoot, patch_path: patchPath,
    });
  }

  let cleanupRes: { cleaned: boolean; worktree: string; note?: string; stderr?: string } | undefined;
  if (shouldCleanup && meta.worktreePath) {
    cleanupRes = removeWorktreeDir(meta);
  }
  return toolJson({
    applied: true,
    dry_run: false,
    scope: effectiveScope,
    check_ok: true,
    run_id: rid,
    parent_git_root: meta.parentGitRoot,
    files,
    patch_path: patchPath,
    ...(cleanupRes ? {
      cleaned: cleanupRes.cleaned,
      worktree: cleanupRes.worktree,
      ...(cleanupRes.note ? { cleanup_note: cleanupRes.note } : {}),
      ...(cleanupRes.stderr ? { cleanup_stderr: cleanupRes.stderr } : {}),
    } : {}),
  });
}

function stopByRunId(rid: string) {
  const runDir = getRunDir(rid);
  const meta = readRunMeta(runDir);
  if (!meta) return toolError("Run not found.", { run_id: rid });

  markWorkerDeadIfNeeded(runDir);
  const progress = readProgress(runDir);
  const review = readReviewPacket(runDir) as ReviewPacketLike | null;

  const codexAlive = Boolean(meta.codexPid) && pidAlive(meta.codexPid!)
    && (pidLooksLikeCodexForRun(meta.codexPid!, rid)
        || (meta.workerPid ? pidDescendantOf(meta.codexPid!, meta.workerPid) : false));

  if ((review || isTerminal(progress?.status)) && !codexAlive) {
    return toolJson({ cancellation_requested: false, run_id: rid, status: review?.status || progress?.status, reason: "Run is not active." });
  }

  requestCancel(runDir);

  const killed: number[] = [];
  if (codexAlive && meta.codexPid) {
    killPidTree(meta.codexPid, "SIGTERM");
    killed.push(meta.codexPid);
    const pid = meta.codexPid;
    const hardKill = setTimeout(() => {
      if (pidAlive(pid) && pidLooksLikeCodexForRun(pid, rid)) killPidTree(pid, "SIGKILL");
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
      ? "SIGTERM sent to orphan Codex child. SIGKILL follows in 5s if still alive."
      : "Cancellation requested. Worker will stop Codex when possible and finalize review packet.",
  });
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  cleanOldTmpDirs();
  cleanOldRuns();
  process.stderr.write(`codex-bridge v${PKG_VERSION} stable\n`);
  const t = new StdioServerTransport();
  await server.connect(t);
}
main().catch((e) => { process.stderr.write(`codex-bridge fatal: ${e.message}\n`); process.exit(1); });
