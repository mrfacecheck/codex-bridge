import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync, appendFileSync, renameSync, chmodSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import path from "path";
import type { RunMeta, ProgressState, ProgressPhase } from "./types.js";
import { pidAlive, pidLooksLikeBridgeWorker } from "./evidence.js";

const BASE_DIR = path.join(homedir(), ".codex-bridge");
const RUNS_DIR = path.join(BASE_DIR, "runs");
const PROJECTS_DIR = path.join(BASE_DIR, "projects");

export { RUNS_DIR, PROJECTS_DIR };

// ── Filesystem helpers (permissions hardened) ────────────────────
function ensureDir(d: string) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try { chmodSync(d, 0o700); } catch {}
}

function writeJsonAtomic(fp: string, data: unknown) {
  const tmp = `${fp}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, fp);
}

function readJson<T>(fp: string): T | null {
  try { return JSON.parse(readFileSync(fp, "utf8")); } catch { return null; }
}

// ── Run ID Validation ────────────────────────────────────────────
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`Invalid run_id: ${runId}`);
  return runId;
}

// ── Throttled Cleanup ────────────────────────────────────────────
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let lastCleanupAt = 0;

function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  cleanOldRuns();
}

// ── Run Directory ────────────────────────────────────────────────
export function createRunDir(runId: string): string {
  assertRunId(runId);
  ensureDir(BASE_DIR);
  ensureDir(RUNS_DIR);
  maybeCleanup();
  const d = path.join(RUNS_DIR, runId);
  ensureDir(d);
  return d;
}

export function getRunDir(runId: string): string {
  return path.join(RUNS_DIR, assertRunId(runId));
}

export function runDirExists(runId: string): boolean {
  try { assertRunId(runId); } catch { return false; }
  return existsSync(path.join(RUNS_DIR, runId, "run.json"));
}

// ── Run Meta ─────────────────────────────────────────────────────
export function writeRunMeta(runDir: string, meta: RunMeta) {
  writeJsonAtomic(path.join(runDir, "run.json"), meta);
}

export function readRunMeta(runDir: string): RunMeta | null {
  return readJson<RunMeta>(path.join(runDir, "run.json"));
}

export function updateRunMeta(runDir: string, patch: Partial<RunMeta>) {
  const existing = readRunMeta(runDir);
  if (!existing) return;
  writeJsonAtomic(path.join(runDir, "run.json"), { ...existing, ...patch });
}

// ── Progress ─────────────────────────────────────────────────────
function shouldPreserveStatus(existing: ProgressPhase | undefined, incoming: ProgressPhase | undefined): boolean {
  if (!existing || !incoming) return false;
  if (existing === "cancelling" && incoming === "running") return true;
  return false;
}

export function updateProgress(runDir: string, state: Partial<ProgressState>) {
  const fp = path.join(runDir, "progress.json");
  const existing = readJson<ProgressState>(fp);
  const status = shouldPreserveStatus(existing?.status, state.status)
    ? existing!.status
    : (state.status ?? existing?.status ?? "starting");
  const next: ProgressState = {
    status,
    message: state.message ?? existing?.message ?? "",
    updatedAt: new Date().toISOString(),
    seq: (existing?.seq ?? 0) + 1,
    sessionId: state.sessionId ?? existing?.sessionId,
    elapsedMs: state.elapsedMs ?? existing?.elapsedMs,
    error: state.error ?? existing?.error,
  };
  writeJsonAtomic(fp, next);
  try { appendFileSync(path.join(runDir, "progress.jsonl"), JSON.stringify(next) + "\n", { mode: 0o600 }); } catch {}
}

export function readProgress(runDir: string): ProgressState | null {
  return readJson<ProgressState>(path.join(runDir, "progress.json"));
}

// ── Cancel Protocol ──────────────────────────────────────────────
export function cancelPath(runDir: string): string {
  return path.join(runDir, "cancel.requested");
}

export function requestCancel(runDir: string) {
  writeFileSync(cancelPath(runDir), new Date().toISOString() + "\n", { mode: 0o600 });
  updateProgress(runDir, { status: "cancelling", message: "Cancellation requested" });
}

export function isCancelRequested(runDir: string): boolean {
  return existsSync(cancelPath(runDir));
}

// ── Review Packet ────────────────────────────────────────────────
export function writeReviewPacket(runDir: string, packet: unknown) {
  writeJsonAtomic(path.join(runDir, "review.json"), packet);
}

export function readReviewPacket(runDir: string): unknown | null {
  return readJson(path.join(runDir, "review.json"));
}

export function reviewReady(runDir: string): boolean {
  return existsSync(path.join(runDir, "review.json"));
}

// ── Worker Liveness ──────────────────────────────────────────────
function ensureReviewForTerminal(runDir: string, progress: ProgressState, meta: RunMeta) {
  if (readReviewPacket(runDir)) return;
  const message = progress.error || progress.message || `Run ended with status ${progress.status} before review was written.`;
  writeReviewPacket(runDir, {
    run_id: meta.runId, async: true,
    status: progress.status === "completed" ? "failed" : progress.status,
    status_detail: `${progress.status}_without_review`,
    cwd: meta.cwd, git_root: meta.gitRoot || undefined,
    error: message, warnings: ["No review packet was produced. Evidence may be incomplete."],
  });
}

export function markWorkerDeadIfNeeded(runDir: string): ProgressState | null {
  if (readReviewPacket(runDir)) return readProgress(runDir);

  const progress = readProgress(runDir);
  const meta = readRunMeta(runDir);
  const terminal: ProgressPhase[] = ["completed", "failed", "timeout", "cancelled"];

  if (progress && terminal.includes(progress.status)) {
    if (meta) ensureReviewForTerminal(runDir, progress, meta);
    return progress;
  }

  if (meta?.workerPid && !(pidAlive(meta.workerPid) && pidLooksLikeBridgeWorker(meta.workerPid, meta.runId))) {
    const message = "Worker process exited before writing review.json. Evidence may be incomplete.";
    updateProgress(runDir, { status: "failed", message, error: message });
    writeReviewPacket(runDir, {
      run_id: meta.runId, async: true, status: "failed",
      status_detail: "worker_crashed", cwd: meta.cwd,
      git_root: meta.gitRoot || undefined, warnings: [message],
    });
    return readProgress(runDir);
  }

  return progress;
}

// ── Project Pointer ──────────────────────────────────────────────
export function projectHash(gitRoot: string): string {
  return createHash("sha256").update(gitRoot).digest("hex").slice(0, 16);
}

export function updateProjectPointer(gitRoot: string, runId: string) {
  ensureDir(PROJECTS_DIR);
  const fp = path.join(PROJECTS_DIR, `${projectHash(gitRoot)}.json`);
  writeJsonAtomic(fp, { gitRoot, runId, updatedAt: new Date().toISOString() });
}

export function getLatestRunForProject(gitRoot: string): { runId: string; runDir: string } | null {
  const fp = path.join(PROJECTS_DIR, `${projectHash(gitRoot)}.json`);
  const data = readJson<{ runId: string }>(fp);
  if (!data?.runId) return null;
  const runDir = getRunDir(data.runId);
  if (!existsSync(path.join(runDir, "run.json"))) return null;
  return { runId: data.runId, runDir };
}

// ── Session Pointer ──────────────────────────────────────────────
const SESSIONS_DIR = path.join(BASE_DIR, "sessions");

export function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

export function updateSessionPointer(sessionId: string, runId: string) {
  ensureDir(SESSIONS_DIR);
  writeJsonAtomic(path.join(SESSIONS_DIR, `${sessionHash(sessionId)}.json`), {
    sessionId, runId, updatedAt: new Date().toISOString(),
  });
}

export function getLatestRunForSession(sessionId: string): string | undefined {
  const fp = path.join(SESSIONS_DIR, `${sessionHash(sessionId)}.json`);
  return readJson<{ runId: string }>(fp)?.runId;
}

// ── List / Query ─────────────────────────────────────────────────
export function listRuns(): { runId: string; meta: RunMeta; progress: ProgressState | null }[] {
  ensureDir(RUNS_DIR);
  const result: { runId: string; meta: RunMeta; progress: ProgressState | null }[] = [];
  try {
    for (const name of readdirSync(RUNS_DIR)) {
      const runDir = path.join(RUNS_DIR, name);
      const meta = readRunMeta(runDir);
      if (!meta) continue;
      result.push({ runId: name, meta, progress: readProgress(runDir) });
    }
  } catch {}
  result.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
  return result;
}

// ── Cleanup ──────────────────────────────────────────────────────
export function cleanOldRuns(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  ensureDir(RUNS_DIR);
  const now = Date.now();
  try {
    for (const name of readdirSync(RUNS_DIR)) {
      const runDir = path.join(RUNS_DIR, name);
      try {
        const s = statSync(runDir);
        if (s.isDirectory() && now - s.mtimeMs > maxAgeMs) rmSync(runDir, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

// ── Stats (for doctor) ───────────────────────────────────────────
export function durableStateStats(): { totalBytes: number; runCount: number; sessionPointerCount: number; oldestRun?: string } {
  let totalBytes = 0; let runCount = 0; let sessionPointerCount = 0; let oldestRun: string | undefined;
  try {
    const runs = readdirSync(RUNS_DIR);
    runCount = runs.length;
    for (const name of runs) {
      const runDir = path.join(RUNS_DIR, name);
      try { const entries = readdirSync(runDir); for (const e of entries) { try { totalBytes += statSync(path.join(runDir, e)).size; } catch {} } } catch {}
    }
    if (runs.length > 0) { const sorted = runs.sort(); oldestRun = sorted[0]; }
  } catch {}
  try { sessionPointerCount = readdirSync(path.join(BASE_DIR, "sessions")).length; } catch {}
  return { totalBytes, runCount, sessionPointerCount, oldestRun };
}

// ── Poll ─────────────────────────────────────────────────────────
export function pollForCompletion(runDir: string, timeoutMs: number, intervalMs = 500): Promise<unknown | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      const packet = readReviewPacket(runDir);
      if (packet) { resolve(packet); return; }

      const progress = markWorkerDeadIfNeeded(runDir);
      if (progress && (progress.status === "failed" || progress.status === "timeout" || progress.status === "cancelled")) {
        const failPacket = readReviewPacket(runDir);
        resolve(failPacket);
        return;
      }

      if (Date.now() >= deadline) { resolve(null); return; }
      const t = setTimeout(check, intervalMs);
      t.unref();
    }
    check();
  });
}
