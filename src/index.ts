import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, execFileSync } from "child_process";
import { connect as tcpConnect } from "net";
import { existsSync, statSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { isTerminal, RECENT_RUN_LOOKUP_LIMIT, ACTIVE_SESSION_SCAN_LIMIT, type RunMeta, type ProgressState, type RunHandle, type RunHandleStatus, type Session, type ReviewPacketLike, type TokenUsage } from "./types.js";
import {
  CODEX_BINARY, normalizeCwd, resolveExecContext,
  checkWriteLockConflict, cmdOk, cleanOldTmpDirs, pidAlive, killPidTree, pidLooksLikeCodexForRun,
} from "./evidence.js";
import {
  createRunDir, writeRunMeta, readRunMeta, readProgress, readReviewPacket, writeReviewPacket,
  pollForCompletion, updateProjectPointer, getRunDir, runDirExists,
  listRuns, cleanOldRuns, requestCancel, markWorkerDeadIfNeeded,
  assertRunId, updateProgress as updateProgressFile,
  getLatestRunForSession, durableStateStats,
} from "./progress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_EXT = path.extname(__filename); // ".ts" in dev, ".js" in compiled
const WORKER_SCRIPT = path.join(__dirname, `worker${WORKER_EXT}`);

const DEFAULT_WAIT_BUDGET = 60;
const MAX_WAIT_BUDGET = 240;

function defaultTimeoutFor(sandbox: string, mode: string): number {
  if (sandbox === "read-only") return 300;
  if (mode === "async") return 1200;
  return 900;
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
  const child = spawn(command, args, { stdio: "ignore", detached: true, env: process.env });
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
    progress: progress || INITIAL_PROGRESS,
    poll_with: `codex_sessions get --run_id ${runId}`,
  };
}

// ── Project Brief ────────────────────────────────────────────────
function buildProjectBrief(cwd: string, gitRoot: string | null): string | null {
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

function statusView(runId: string, progress: ProgressState | null, review: ReviewPacketLike | null, meta: RunMeta | null) {
  return {
    run_id: runId,
    async: true,
    status: review?.status || progress?.status || "unknown",
    status_detail: review?.status_detail,
    failure_hint: review?.failure_hint,
    review_ready: Boolean(review),
    session_id: review?.session_id || progress?.sessionId,
    progress: progress ? {
      status: progress.status, message: progress.message,
      updatedAt: progress.updatedAt, seq: progress.seq, elapsedMs: progress.elapsedMs,
    } : undefined,
    cwd: meta?.cwd,
    git_root: meta?.gitRoot || undefined,
    next_poll_after_seconds: review ? undefined : 20,
  };
}

function compactReviewSummary(runId: string, review: ReviewPacketLike, maxChars: number) {
  const gd = review.git_diff;
  const gdCompact = gd && gd.is_git_repo ? {
    changed: gd.changed, summary: gd.summary, files: gd.files,
    diff_truncated: gd.diff_truncated, diff_preview_mode: gd.diff_preview_mode,
    full_diff_bytes: gd.full_diff_bytes, preexisting_dirty_files: gd.preexisting_dirty_files,
    risk_flags: gd.risk_flags, sensitive_diff_omitted: gd.sensitive_diff_omitted,
    diff_path: gd.diff_path,
  } : gd;
  return {
    run_id: runId, async: true, review_ready: true,
    status: review.status, status_detail: review.status_detail,
    failure_hint: review.failure_hint, partial_changes: review.partial_changes,
    session_id: review.session_id, session_name: review.session_name,
    duration_ms: review.duration_ms,
    token_usage: review.token_usage,
    git_diff: gdCompact,
    fs_sentinel: review.fs_sentinel,
    warnings: review.warnings || [],
    output_tail: tailText(review.output, Math.min(maxChars, 2000)),
    output_source: review.output_source,
    process: review.process,
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
    changed: gd.changed, summary: gd.summary, files: gd.files,
    risk_flags: gd.risk_flags, sensitive_diff_omitted: gd.sensitive_diff_omitted,
    diff_preview: tailText(gd.diff_preview, maxChars),
    diff_truncated: gd.diff_truncated, diff_path: gd.diff_path,
    full_diff_bytes: gd.full_diff_bytes,
  };
}

function waitForProgressOrReview(runDir: string, sinceSeq: number | undefined, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      markWorkerDeadIfNeeded(runDir);
      if (readReviewPacket(runDir)) return resolve();
      const progress = readProgress(runDir);
      if (sinceSeq !== undefined && progress && progress.seq > sinceSeq) return resolve();
      if (Date.now() >= deadline) return resolve();
      const t = setTimeout(check, 1000); t.unref();
    };
    check();
  });
}

// ── MCP Server ───────────────────────────────────────────────────
const server = new McpServer({ name: "codex-bridge", version: "2.2.0" });
const SB = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const EM = z.enum(["auto", "sync", "async"]);

server.tool("codex_exec", "Start Codex session. Run-scoped diff from repo root, isolated object dir, sensitive content alias detection, smart preview.", {
  task: z.string().min(1),
  cwd: z.string(),
  model: z.string().optional(),
  sandbox: SB.optional().default("workspace-write"),
  timeout: z.number().int().min(10).max(7200).optional(),
  session_name: z.string().optional(),
  max_diff_chars: z.number().int().min(1000).max(200000).optional().default(30000),
  allow_non_git: z.boolean().optional().default(false),
  allow_large_untracked_snapshot: z.boolean().optional().default(false),
  danger_ack: z.boolean().optional().default(false),
  execution_mode: EM.optional().default("auto"),
  wait_budget_seconds: z.number().int().min(0).max(MAX_WAIT_BUDGET).optional().default(DEFAULT_WAIT_BUDGET),
  project_brief: z.boolean().optional().default(true),
}, async (args) => {
  const { task, model, sandbox, session_name, max_diff_chars, allow_non_git, allow_large_untracked_snapshot, danger_ack, execution_mode, wait_budget_seconds, project_brief } = args;
  const timeout = args.timeout ?? defaultTimeoutFor(sandbox, execution_mode);

  let cwd: string;
  try { cwd = normalizeCwd(args.cwd); } catch (e: any) { return toolError(e.message); }
  if (sandbox === "danger-full-access" && !danger_ack) return toolError("danger-full-access requires danger_ack=true.");

  const { runCwd, gitRoot, gitRepo } = resolveExecContext(cwd);
  if (!gitRepo && !allow_non_git) return toolError("Not a Git repo. Set allow_non_git=true.", { cwd: runCwd });

  if (sandbox !== "read-only") {
    const conflict = checkWriteLockConflict(gitRepo ? gitRoot : runCwd);
    if (conflict) return toolError(conflict);
  }

  const runId = randomUUID();
  const runDir = createRunDir(runId);

  let finalTask = task;
  if (project_brief) {
    const brief = buildProjectBrief(runCwd, gitRepo ? gitRoot : null);
    if (brief) finalTask = brief + task;
  }

  const meta: RunMeta = {
    runId, cwd: runCwd, gitRoot: gitRepo ? gitRoot : null, sandbox, task: finalTask,
    model, timeout, sessionName: session_name || `run-${runId.slice(0, 8)}`,
    maxDiffChars: max_diff_chars, allowNonGit: allow_non_git,
    allowLargeUntracked: allow_large_untracked_snapshot, dangerAck: danger_ack,
    createdAt: new Date().toISOString(),
  };
  writeRunMeta(runDir, meta);

  const w = startWorker(runDir, meta);
  if (!w.ok) return toolError(w.error, { run_id: runId });

  // Update project pointer after confirmed spawn so statusline can show running state
  if (gitRepo) updateProjectPointer(gitRoot, runId);

  const ses: Session = {
    latestRunId: runId, runIds: [runId],
    name: meta.sessionName, status: "running",
    cwd: runCwd, gitRoot: gitRepo ? gitRoot : undefined, sandbox,
    startedAt: Date.now(), lastActiveAt: Date.now(), filesChanged: [],
  };
  byRunId.set(runId, ses);

  if (execution_mode === "async") {
    const progress = readProgress(runDir);
    return toolJson(buildRunHandle(runId, meta, progress));
  }

  const waitMs = (execution_mode === "sync" ? MAX_WAIT_BUDGET : wait_budget_seconds) * 1000;
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
    return toolJson(packet);
  }

  const progress = markWorkerDeadIfNeeded(runDir);
  const failPacket = readReviewPacket(runDir);
  if (failPacket) {
    const p = failPacket as Record<string, unknown>;
    ses.status = (p.status as Session["status"]) || "failed";
    ses.lastActiveAt = Date.now();
    return toolJson(failPacket);
  }

  return toolJson(buildRunHandle(runId, meta, progress));
});

server.tool("codex_resume", "Resume Codex session. Verifies thread_id, detects sensitive content aliases, run-scoped diff from repo root.", {
  session_id: z.string().min(1),
  task: z.string().min(1),
  cwd: z.string().optional(),
  sandbox: SB.optional(),
  model: z.string().optional(),
  timeout: z.number().int().min(10).max(7200).optional(),
  max_diff_chars: z.number().int().min(1000).max(200000).optional().default(30000),
  allow_non_git: z.boolean().optional().default(false),
  allow_large_untracked_snapshot: z.boolean().optional().default(false),
  danger_ack: z.boolean().optional().default(false),
  execution_mode: EM.optional().default("auto"),
  wait_budget_seconds: z.number().int().min(0).max(MAX_WAIT_BUDGET).optional().default(DEFAULT_WAIT_BUDGET),
  project_brief: z.boolean().optional().default(true),
}, async (args) => {
  const { session_id, task, cwd: cwdArg, max_diff_chars, allow_non_git, allow_large_untracked_snapshot, danger_ack, execution_mode, wait_budget_seconds, project_brief } = args;

  const ex = lookupWithDurable(session_id);
  const rsid = ex?.sessionId || session_id;
  if (byRunId.has(session_id) && !ex?.sessionId) return toolError("Cannot resume by run_id. Pass Codex session_id.", { run_id: session_id });

  if (ex && cwdArg) { try { if (normalizeCwd(cwdArg) !== ex.cwd) return toolError("codex_resume cannot override cwd (Codex CLI resume has no -C). Use original session cwd.", { requested: cwdArg, session_cwd: ex.cwd, session_id }); } catch (e: any) { return toolError(e.message); } }
  if (ex && args.sandbox && args.sandbox !== ex.sandbox) return toolError("codex_resume cannot override sandbox (Codex CLI resume has no -s). Use original session sandbox.", { requested: args.sandbox, session_sandbox: ex.sandbox, session_id });
  if (!ex && args.sandbox) return toolError("codex_resume cannot enforce sandbox for an unknown external session. Omit sandbox or resume a bridge-created session.", { requested_sandbox: args.sandbox, assumed_sandbox: "workspace-write", session_id });

  const rawCwd = ex?.cwd || cwdArg;
  if (!rawCwd) return toolError("Unknown session. Provide cwd for evidence capture.", { session_id });
  let cwd: string; try { cwd = normalizeCwd(rawCwd); } catch (e: any) { return toolError(e.message); }

  const effectiveSandbox = ex?.sandbox || "workspace-write";
  if (effectiveSandbox === "danger-full-access" && !danger_ack) return toolError("Resuming danger-full-access session requires danger_ack=true.");

  const { runCwd, gitRoot, gitRepo } = resolveExecContext(cwd);
  if (!gitRepo && !allow_non_git) return toolError("Not a Git repo. Set allow_non_git=true.", { cwd: runCwd });

  if (effectiveSandbox !== "read-only") {
    const conflict = checkWriteLockConflict(gitRepo ? gitRoot : runCwd);
    if (conflict) return toolError(conflict);
  }

  // Session-level active guard: prevent concurrent resume of same Codex thread
  const activeRun = findActiveRunForSession(rsid);
  if (activeRun) return toolError("Codex session already has an active run. Wait for it to finish or stop it before resuming.", { session_id: rsid, active_run_id: activeRun.runId, status: activeRun.status });

  const timeout = args.timeout ?? defaultTimeoutFor(effectiveSandbox, execution_mode);

  const runId = randomUUID();
  const runDir = createRunDir(runId);
  const resumeContextVerified = Boolean(ex);

  let finalTask = task;
  if (project_brief) {
    const brief = buildProjectBrief(runCwd, gitRepo ? gitRoot : null);
    if (brief) finalTask = brief + task;
  }

  const meta: RunMeta = {
    runId, cwd: runCwd, gitRoot: gitRepo ? gitRoot : null, sandbox: effectiveSandbox,
    task: finalTask, model: args.model, timeout,
    sessionName: ex?.name || `resumed-${rsid.slice(0, 8)}`,
    maxDiffChars: max_diff_chars, allowNonGit: allow_non_git,
    allowLargeUntracked: allow_large_untracked_snapshot, dangerAck: danger_ack,
    createdAt: new Date().toISOString(), resumeSessionId: rsid,
    resumeContextVerified,
  };
  writeRunMeta(runDir, meta);

  const w = startWorker(runDir, meta);
  if (!w.ok) return toolError(w.error, { run_id: runId });

  if (gitRepo) updateProjectPointer(gitRoot, runId);

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

  const waitMs = (execution_mode === "sync" ? MAX_WAIT_BUDGET : wait_budget_seconds) * 1000;
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
    return toolJson(packet);
  }

  const progress = markWorkerDeadIfNeeded(runDir);
  const failPacket = readReviewPacket(runDir);
  if (failPacket) {
    const p = failPacket as Record<string, unknown>;
    ses.status = (p.status as Session["status"]) || "failed";
    ses.lastActiveAt = Date.now();
    if (!ex && p.resume_attached === false) byRunId.delete(runId);
    return toolJson(failPacket);
  }

  return toolJson(buildRunHandle(runId, meta, progress));
});

const RunIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional();

const VIEW = z.enum(["status", "summary", "review", "diff", "output"]);

server.tool("codex_sessions", "List, inspect, stop, or diagnose.", {
  action: z.enum(["list", "get", "stop", "doctor"]),
  session_id: z.string().optional(),
  run_id: RunIdSchema,
  view: VIEW.optional().default("status"),
  max_chars: z.number().int().min(1000).max(200000).optional().default(20000),
  wait_seconds: z.number().int().min(0).max(60).optional().default(0),
  since_seq: z.number().int().min(0).optional(),
}, async (args) => {
  const { action, session_id: sid, run_id: rid, view, max_chars, wait_seconds, since_seq } = args;

  if (action === "doctor") {
    const stats = durableStateStats();
    const connectivity = await tcpProbe("api.openai.com", 443, 5000);
    return toolJson({
      bridge_version: "2.2.0", codex_binary: CODEX_BINARY,
      codex_version: cmdOk(CODEX_BINARY, ["--version"]),
      git_version: cmdOk("git", ["--version"]),
      node: process.version, platform: process.platform, arch: process.arch,
      env: { has_HOME: Boolean(process.env.HOME), has_CODEX_HOME: Boolean(process.env.CODEX_HOME), has_OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY), has_proxy: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY) },
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
        return {
          run_id: r.runId,
          session_name: r.meta.sessionName,
          status: (review?.status as string) || progress?.status || "unknown",
          cwd: r.meta.cwd,
          git_root: r.meta.gitRoot,
          sandbox: r.meta.sandbox,
          created_at: r.meta.createdAt,
          session_id: progress?.sessionId || (review?.session_id as string),
          message: progress?.message,
        };
      }),
    });
  }

  // ── GET ────────────────────────────────────────────────────────
  if (action === "get") {
    if (rid) return getByRunId(rid, view, max_chars, wait_seconds, since_seq);
    if (sid) {
      const runId = findRunIdBySessionId(sid);
      if (runId) return getByRunId(runId, view, max_chars, wait_seconds, since_seq);
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
) {
  const runDir = getRunDir(rid);
  if (!runDirExists(rid)) return toolError("Run not found.", { run_id: rid });

  // Long-poll: wait for progress change or review completion
  if (waitSeconds > 0) await waitForProgressOrReview(runDir, sinceSeq, waitSeconds * 1000);

  markWorkerDeadIfNeeded(runDir);
  const meta = readRunMeta(runDir);
  const progress = readProgress(runDir);
  const review = readReviewPacket(runDir) as ReviewPacketLike | null;

  // Hydrate session into memory so subsequent resume can find it
  if (review) hydrateSessionFromRun(rid);

  // status: always lightweight, even when review is ready
  if (view === "status") {
    return toolJson(statusView(rid, progress, review, meta));
  }

  // Other views need review to be ready
  if (!review) {
    return toolJson({
      ...statusView(rid, progress, review, meta),
      message: "Review not ready. Use view='status' with wait_seconds to poll.",
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

function stopByRunId(rid: string) {
  const runDir = getRunDir(rid);
  const meta = readRunMeta(runDir);
  if (!meta) return toolError("Run not found.", { run_id: rid });

  markWorkerDeadIfNeeded(runDir);
  const progress = readProgress(runDir);
  const review = readReviewPacket(runDir) as ReviewPacketLike | null;

  const codexAlive = Boolean(meta.codexPid) && pidAlive(meta.codexPid!) && pidLooksLikeCodexForRun(meta.codexPid!, rid);

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
  process.stderr.write("codex-bridge v2.2.0 stable\n");
  const t = new StdioServerTransport();
  await server.connect(t);
}
main().catch((e) => { process.stderr.write(`codex-bridge fatal: ${e.message}\n`); process.exit(1); });
