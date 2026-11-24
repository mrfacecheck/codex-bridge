import {
  existsSync, readdirSync, statSync, readFileSync, appendFileSync, openSync, closeSync, readSync, watch, type FSWatcher,
} from "fs";
import { createHash } from "crypto";
import path from "path";
import {
  HEARTBEAT_STALE_MS, EMPTY_TREE_OID, isTerminal, statusToPhase,
  type RunMeta, type ProgressState, type ProgressPhase, type Liveness, type Phase,
  type ReviewPacketLike, type EventSummary, type TokenUsage, type CommandStats,
} from "./types.js";
import {
  BASE_DIR, RUNS_DIR, PROJECTS_DIR, SESSIONS_DIR,
  ensureDir, writeJsonDurable, writeJsonFast, readJson,
  hasLaunchClaim, readStartedRecord, readRunSessionRecord, writeRunSessionRecord,
  writeCancelIntent, upsertSessionRecord, readSessionRecord, sessionFileHash,
  probePidLivenessSync, probePidLivenessAsync, commandMatchesWorker, commandMatchesCodex,
  forceReleaseLeaseIfGone, runRootedGc, readWorkspaceMeta,
} from "./state.js";
import {
  captureTreeIntoEvidence, collectEvidenceDiff, listTreePaths, pushCap, pushUniqCap, appendCap, sanitize,
} from "./evidence.js";

export { BASE_DIR, RUNS_DIR, PROJECTS_DIR };

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

// ── Run Meta (Durable) ───────────────────────────────────────────
export function writeRunMeta(runDir: string, meta: RunMeta) {
  writeJsonDurable(path.join(runDir, "run.json"), meta);
}

export function readRunMeta(runDir: string): RunMeta | null {
  return readJson<RunMeta>(path.join(runDir, "run.json"));
}

export function updateRunMeta(runDir: string, patch: Partial<RunMeta>) {
  const existing = readRunMeta(runDir);
  if (!existing) return;
  writeJsonDurable(path.join(runDir, "run.json"), { ...existing, ...patch });
}

// ── Progress (Rebuildable Projection) ────────────────────────────
function shouldPreserveStatus(existing: ProgressPhase | undefined, incoming: ProgressPhase | undefined): boolean {
  if (!existing || !incoming) return false;
  if (existing === "cancelling" && incoming === "running") return true;
  return false;
}

export function updateProgress(runDir: string, state: Partial<ProgressState>): ProgressState {
  const fp = path.join(runDir, "progress.json");
  const existing = readJson<ProgressState>(fp);
  const status = shouldPreserveStatus(existing?.status, state.status)
    ? existing!.status
    : (state.status ?? existing?.status ?? "starting");
  const now = new Date().toISOString();
  const nextSeq = (existing?.seq ?? 0) + 1;
  const nextRev = (existing?.revision ?? existing?.seq ?? 0) + 1;
  const next: ProgressState = {
    status,
    phase: state.phase ?? statusToPhase(status),
    liveness: state.liveness ?? existing?.liveness ?? (isTerminal(status) ? "gone" : "alive"),
    message: state.message ?? existing?.message ?? "",
    updatedAt: now,
    seq: nextSeq,
    revision: nextRev,
    heartbeatSeq: state.heartbeatSeq ?? existing?.heartbeatSeq ?? 0,
    heartbeatAt: state.heartbeatAt ?? now,
    sessionId: state.sessionId ?? existing?.sessionId,
    elapsedMs: state.elapsedMs ?? existing?.elapsedMs,
    observedActiveMs: state.observedActiveMs ?? existing?.observedActiveMs,
    idleActiveMs: state.idleActiveMs ?? existing?.idleActiveMs,
    observerGaps: state.observerGaps ?? existing?.observerGaps,
    commands: state.commands ?? existing?.commands,
    reportedUsage: state.reportedUsage !== undefined ? state.reportedUsage : existing?.reportedUsage,
    attention: state.attention !== undefined ? state.attention : existing?.attention,
    evidenceSealed: state.evidenceSealed ?? existing?.evidenceSealed,
    error: state.error ?? existing?.error,
    lastActivityAt: state.lastActivityAt ?? existing?.lastActivityAt,
  };
  writeJsonFast(fp, next);
  try { appendFileSync(path.join(runDir, "progress.jsonl"), JSON.stringify(next) + "\n", { mode: 0o600 }); } catch {}
  return next;
}

export function readProgress(runDir: string): ProgressState | null {
  return readJson<ProgressState>(path.join(runDir, "progress.json"));
}

/**
 * Update liveness timestamps/heartbeats in progress.json WITHOUT incrementing seq/revision
 * or growing progress.jsonl. Heartbeats never spuriously wake wait_for='terminal'.
 */
export function touchActivity(
  runDir: string,
  elapsedMs?: number,
  extra?: Partial<Pick<ProgressState, "observedActiveMs" | "idleActiveMs" | "observerGaps" | "commands" | "reportedUsage" | "liveness" | "heartbeatSeq" | "lastActivityAt">>,
) {
  const fp = path.join(runDir, "progress.json");
  const existing = readJson<ProgressState>(fp);
  if (!existing) return;
  const now = new Date().toISOString();
  writeJsonFast(fp, {
    ...existing,
    updatedAt: now,
    heartbeatAt: now,
    heartbeatSeq: extra?.heartbeatSeq ?? ((existing.heartbeatSeq ?? 0) + 1),
    lastActivityAt: extra?.lastActivityAt ?? now,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(extra?.observedActiveMs !== undefined ? { observedActiveMs: extra.observedActiveMs } : {}),
    ...(extra?.idleActiveMs !== undefined ? { idleActiveMs: extra.idleActiveMs } : {}),
    ...(extra?.observerGaps !== undefined ? { observerGaps: extra.observerGaps } : {}),
    ...(extra?.commands !== undefined ? { commands: extra.commands } : {}),
    ...(extra?.reportedUsage !== undefined ? { reportedUsage: extra.reportedUsage } : {}),
    ...(extra?.liveness !== undefined ? { liveness: extra.liveness } : {}),
  });
}

/**
 * Update only heartbeat & observed/idle counters without bumping lastActivityAt, seq, or revision.
 */
export function writeHeartbeat(
  runDir: string,
  stats: { elapsedMs: number; observedActiveMs: number; idleActiveMs: number; observerGaps: number; commands?: CommandStats },
) {
  const fp = path.join(runDir, "progress.json");
  const existing = readJson<ProgressState>(fp);
  if (!existing) return;
  const now = new Date().toISOString();
  writeJsonFast(fp, {
    ...existing,
    updatedAt: now,
    heartbeatAt: now,
    heartbeatSeq: (existing.heartbeatSeq ?? 0) + 1,
    elapsedMs: stats.elapsedMs,
    observedActiveMs: stats.observedActiveMs,
    idleActiveMs: stats.idleActiveMs,
    observerGaps: stats.observerGaps,
    ...(stats.commands ? { commands: stats.commands } : {}),
  });
}

const PROGRESS_TAIL_BYTES = 128 * 1024;

export function readProgressEventsSince(runDir: string, sinceSeq: number = 0, limit: number = 20, mode: "after" | "recent" = "after"): ProgressState[] {
  const fp = path.join(runDir, "progress.jsonl");
  let text = "";
  try {
    const stat = statSync(fp);
    if (stat.size <= PROGRESS_TAIL_BYTES) {
      text = readFileSync(fp, "utf8");
    } else {
      const fd = openSync(fp, "r");
      const buf = Buffer.alloc(PROGRESS_TAIL_BYTES);
      readSync(fd, buf, 0, PROGRESS_TAIL_BYTES, stat.size - PROGRESS_TAIL_BYTES);
      closeSync(fd);
      text = buf.toString("utf8");
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
  } catch { return []; }
  const out: ProgressState[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as ProgressState;
      if (p.seq > sinceSeq) out.push(p);
    } catch {}
  }
  return mode === "after" ? out.slice(0, limit) : out.slice(-limit);
}

// ── Cancel Protocol ──────────────────────────────────────────────
export function cancelPath(runDir: string): string {
  return path.join(runDir, "cancel.requested");
}

export function requestCancel(runDir: string, ownerNonce?: string) {
  writeCancelIntent(runDir, ownerNonce);
  updateProgress(runDir, { status: "cancelling", phase: "running", message: "Cancellation requested" });
}

export function isCancelRequested(runDir: string): boolean {
  return existsSync(path.join(runDir, "cancel.json")) || existsSync(cancelPath(runDir));
}

// ── Review Packet (Durable) ──────────────────────────────────────
export function writeReviewPacket(runDir: string, packet: unknown) {
  writeJsonDurable(path.join(runDir, "review.json"), packet);
}

export function readReviewPacket(runDir: string): unknown | null {
  return readJson(path.join(runDir, "review.json"));
}

export function reviewReady(runDir: string): boolean {
  return existsSync(path.join(runDir, "review.json"));
}

// ── Replay Direct-FD Codex JSONL Log (Crash Salvage) ─────────────
export interface ReplayedLogFacts {
  sessionId: string;
  output: string;
  outputTruncated: boolean;
  reportedUsage: TokenUsage | null;
  events: EventSummary;
  commands: CommandStats;
  turnCompleted: boolean;
  lineCount: number;
}

export function replayCodexStdoutLog(runDir: string): ReplayedLogFacts {
  const fp = path.join(runDir, "codex.stdout.jsonl");
  const events: EventSummary = { counts: {}, file_changes: [], commands: [], errors: [] };
  const commands: CommandStats = { completed: 0, failed: 0, inflight: 0 };
  let sessionId = "";
  let output = "";
  let outputTruncated = false;
  let reportedUsage: TokenUsage | null = null;
  let turnCompleted = false;
  let lineCount = 0;

  if (!existsSync(fp)) {
    return { sessionId, output, outputTruncated, reportedUsage, events, commands, turnCompleted, lineCount };
  }

  let raw = "";
  try {
    const st = statSync(fp);
    // Cap replay read at 16MB to stay bounded on huge runs
    const maxRead = 16 * 1024 * 1024;
    if (st.size <= maxRead) {
      raw = readFileSync(fp, "utf8");
    } else {
      // Read head (first 256KB for thread.started) + tail (last 4MB for latest messages/usage)
      const fd = openSync(fp, "r");
      try {
        const headBuf = Buffer.alloc(256 * 1024);
        const hN = readSync(fd, headBuf, 0, headBuf.length, 0);
        const tailBuf = Buffer.alloc(4 * 1024 * 1024);
        const tN = readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, st.size - tailBuf.length));
        raw = headBuf.subarray(0, hN).toString("utf8") + "\n" + tailBuf.subarray(0, tN).toString("utf8");
      } finally { closeSync(fd); }
    }
  } catch {
    return { sessionId, output, outputTruncated, reportedUsage, events, commands, turnCompleted, lineCount };
  }

  const inflightIds = new Set<string>();
  const lines = raw.split("\n");
  // Ignore incomplete trailing line when file does not end with newline
  const completeCount = raw.endsWith("\n") ? lines.length : Math.max(0, lines.length - 1);
  for (let i = 0; i < completeCount; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    lineCount++;
    const tp = e.type || "unknown";
    events.counts[tp] = (events.counts[tp] || 0) + 1;
    const u = e.usage || e.item?.usage;
    if (u) {
      const prev = reportedUsage as TokenUsage | null;
      reportedUsage = {
        input: u.input_tokens ?? prev?.input ?? 0,
        output: u.output_tokens ?? prev?.output ?? 0,
        cached: u.cached_input_tokens ?? prev?.cached ?? 0,
        reasoning: u.reasoning_output_tokens ?? prev?.reasoning ?? 0,
      };
    }
    if (tp === "thread.started" && e.thread_id) {
      sessionId = String(e.thread_id);
    } else if (tp === "turn.completed") {
      turnCompleted = true;
    } else if (tp === "error" || tp === "turn.failed") {
      const m = e.message || e.error?.message || JSON.stringify(e);
      pushCap(events.errors, String(m).slice(0, 1000), 50);
    } else if (e.item) {
      const it = e.item;
      if (tp === "item.completed" && it.type === "agent_message" && it.text) {
        const r = appendCap(output, String(it.text) + "\n", 160_000);
        output = r.text;
        outputTruncated = outputTruncated || r.truncated;
      } else if (it.type === "file_change") {
        for (const c of (it.changes || [])) {
          if (c?.path) pushUniqCap(events.file_changes, String(c.path), 200);
        }
      } else if (it.type === "command_execution" || it.type === "shell_command" || it.type === "tool_call") {
        const cmd = it.command || it.name || it.tool || "";
        const itemId = typeof it.id === "string" && it.id ? it.id : null;
        if (cmd) {
          const cl = sanitize(Array.isArray(cmd) ? cmd.join(" ") : String(cmd));
          if (tp === "item.started") {
            if (itemId) inflightIds.add(itemId);
            pushCap(events.commands, cl, 100);
          } else if (tp === "item.completed") {
            if (itemId && inflightIds.has(itemId)) inflightIds.delete(itemId);
            else if (!itemId) pushCap(events.commands, cl, 100);
            commands.completed++;
            if (typeof it.exit_code === "number" && it.exit_code !== 0) commands.failed++;
          }
        }
      }
    }
  }
  commands.inflight = inflightIds.size;
  return { sessionId, output: output.trim(), outputTruncated, reportedUsage, events, commands, turnCompleted, lineCount };
}

// ── Unified On-Demand Reconciliation (Zero-Spawn Hot Path!) ──────
export interface ReconcileResult {
  phase: Phase;
  liveness: Liveness;
  progress: ProgressState | null;
  review: ReviewPacketLike | null;
}

function ensureReviewForTerminal(runDir: string, progress: ProgressState, meta: RunMeta): ReviewPacketLike {
  const existing = readReviewPacket(runDir) as ReviewPacketLike | null;
  if (existing) return existing;
  const message = progress.error || progress.message || `Run ended with status ${progress.status} before review was written.`;
  const packet: ReviewPacketLike = {
    run_id: meta.runId, async: true,
    status: progress.status === "completed" ? "failed" : progress.status,
    phase: "terminal",
    outcome: progress.status === "cancelled" ? "cancelled" : "interrupted",
    liveness: "gone",
    salvaged: true,
    status_detail: `${progress.status}_without_review`,
    cwd: meta.cwd, git_root: meta.gitRoot || undefined,
    session_id: progress.sessionId || readRunSessionRecord(runDir)?.sessionId,
    process: { exit_code: null, signal: null },
    warnings: [message, "No review packet was produced before exit. Evidence may be incomplete."],
  };
  writeReviewPacket(runDir, packet);
  return packet;
}

function salvageAfterConfirmedWriterExit(runDir: string, meta: RunMeta, progress: ProgressState | null): ReviewPacketLike {
  const replayed = replayCodexStdoutLog(runDir);
  const earlySession = readRunSessionRecord(runDir)?.sessionId;
  const sessionId = earlySession || replayed.sessionId || progress?.sessionId || undefined;

  if (sessionId) {
    if (!earlySession) writeRunSessionRecord(runDir, sessionId, "replayed");
    upsertSessionRecord(sessionId, meta.runId, {
      workspaceId: meta.workspaceId,
      mcpHome: meta.mcpHome,
      cwd: meta.cwd,
      parentGitRoot: meta.parentGitRoot,
      sandbox: meta.sandbox,
    });
  }

  let afterTree: string | undefined;
  let gd: ReviewPacketLike["git_diff"] = { is_git_repo: false, changed: false, summary: "Evidence unavailable during salvage" };
  let evidenceSealed = false;
  let evidenceError: string | undefined;

  if (meta.evidenceGitDir && existsSync(meta.evidenceGitDir) && existsSync(meta.cwd)) {
    try {
      const ws = meta.workspaceId ? readWorkspaceMeta(meta.workspaceId) : null;
      const originTree = meta.originTree ?? ws?.originTree ?? EMPTY_TREE_OID;
      const beforeTree = meta.beforeTree ?? originTree;
      const originPaths = listTreePaths(meta.evidenceGitDir, originTree);
      afterTree = captureTreeIntoEvidence(meta.cwd, meta.evidenceGitDir, `refs/codex-bridge/runs/${meta.runId}/salvage`, originPaths);
      gd = collectEvidenceDiff(meta.evidenceGitDir, meta.cwd, beforeTree, afterTree, runDir, meta.maxDiffChars, 0);
      evidenceSealed = true;
    } catch (e: any) {
      evidenceError = e?.message || String(e);
    }
  }

  const partialChanges = Boolean(gd?.is_git_repo && gd.changed);
  const warnings = [
    replayed.turnCompleted
      ? "Worker exited unexpectedly after Codex emitted turn.completed. Salvaged log facts and disk tree; exit_code is unknown (null)."
      : "Worker exited unexpectedly before finalizing review.json. Salvaged available log facts and disk tree.",
  ];
  if (evidenceError) warnings.push(`Evidence salvage failed: ${evidenceError}`);

  const packet: ReviewPacketLike = {
    run_id: meta.runId,
    async: true,
    session_id: sessionId,
    session_name: meta.sessionName,
    status: "failed",
    phase: "terminal",
    outcome: "interrupted",
    liveness: "gone",
    salvaged: true,
    status_detail: replayed.turnCompleted ? "worker_crashed_after_turn_completed" : "worker_crashed_salvaged",
    partial_changes: partialChanges,
    cwd: meta.cwd,
    git_root: meta.gitRoot || undefined,
    workspace_id: meta.workspaceId,
    workspace_kind: meta.workspaceKind,
    isolation: meta.isolation,
    worktree_path: meta.worktreePath,
    parent_git_root: meta.parentGitRoot ?? undefined,
    output: replayed.output || undefined,
    output_source: replayed.output ? "replayed-jsonl" : undefined,
    output_truncated: replayed.outputTruncated,
    process: { exit_code: null, signal: null },
    reported_usage: replayed.reportedUsage,
    ...(replayed.reportedUsage ? { token_usage: replayed.reportedUsage } : {}),
    events: replayed.events,
    commands: replayed.commands,
    origin_tree: meta.originTree ?? undefined,
    before_tree: meta.beforeTree ?? undefined,
    after_tree: afterTree,
    evidence: {
      sealed: evidenceSealed,
      origin_tree: meta.originTree ?? undefined,
      before_tree: meta.beforeTree ?? undefined,
      after_tree: afterTree,
      ...(evidenceError ? { error: evidenceError } : {}),
    },
    git_diff: gd,
    warnings,
    model: meta.resolvedModel ?? meta.model ?? null,
    model_source: meta.modelSource,
    effort: meta.resolvedEffort ?? meta.effort ?? null,
    effort_source: meta.effortSource,
    codex_version: meta.codexVersion,
  };

  writeReviewPacket(runDir, packet);
  updateProgress(runDir, {
    status: "failed",
    phase: "terminal",
    liveness: "gone",
    sessionId,
    evidenceSealed,
    message: warnings[0],
    error: warnings[0],
  });

  // Release the dead lease ONLY now that BOTH worker and codex writer are proven gone.
  const leaseTarget = meta.workspaceId ? `workspace:${meta.workspaceId}` : (meta.gitRoot || meta.cwd);
  forceReleaseLeaseIfGone(leaseTarget, meta.runId);
  return packet;
}

function isHeartbeatFresh(progress: ProgressState | null, meta: RunMeta | null): boolean {
  const hb = progress?.heartbeatAt || progress?.updatedAt;
  if (hb) {
    const age = Date.now() - Date.parse(hb);
    if (Number.isFinite(age) && age >= 0 && age < HEARTBEAT_STALE_MS) return true;
  }
  if (!progress && meta?.createdAt) {
    const age = Date.now() - Date.parse(meta.createdAt);
    if (Number.isFinite(age) && age >= 0 && age < 5_000) return true;
  }
  return false;
}

function resolveDeadWorkerOutcome(
  runDir: string,
  meta: RunMeta,
  progress: ProgressState | null,
  workerLive: Liveness,
  codexLive: Liveness,
  hasStarted: boolean,
): ReconcileResult {
  if (workerLive === "alive") {
    return { phase: progress?.phase ?? statusToPhase(progress?.status), liveness: "alive", progress, review: null };
  }

  // Worker is NOT alive. Check if Codex writer could still be running!
  const inAmbiguousLaunchWindow = !hasStarted && hasLaunchClaim(runDir)
    && (Date.now() - Date.parse(meta.createdAt) < 10_000);
  if (workerLive === "unknown" || codexLive === "alive" || codexLive === "unknown" || inAmbiguousLaunchWindow) {
    // Salvage session ID read-only from direct-FD log if thread.started already landed
    const early = readRunSessionRecord(runDir);
    if (!early) {
      const replayed = replayCodexStdoutLog(runDir);
      if (replayed.sessionId) {
        writeRunSessionRecord(runDir, replayed.sessionId, "replayed");
        upsertSessionRecord(replayed.sessionId, meta.runId, {
          workspaceId: meta.workspaceId, mcpHome: meta.mcpHome, cwd: meta.cwd,
          parentGitRoot: meta.parentGitRoot, sandbox: meta.sandbox,
        });
      }
    }
    const nextProgress = progress?.liveness === "unknown"
      ? progress
      : updateProgress(runDir, {
          status: progress?.status ?? "running",
          phase: "running",
          liveness: "unknown",
          message: "Worker exited while Codex writer may still be active; preserving workspace until writer exits.",
        });
    return { phase: "running", liveness: "unknown", progress: nextProgress, review: null };
  }

  // Both worker and codex writer are proven gone → salvage facts & seal!
  const salvaged = salvageAfterConfirmedWriterExit(runDir, meta, progress);
  return { phase: "terminal", liveness: "gone", progress: readProgress(runDir), review: salvaged };
}

export function reconcileRunSync(runDir: string, opts?: { forceProbe?: boolean }): ReconcileResult {
  const existingReview = readReviewPacket(runDir) as ReviewPacketLike | null;
  if (existingReview) {
    return { phase: "terminal", liveness: "gone", progress: readProgress(runDir), review: existingReview };
  }

  const progress = readProgress(runDir);
  const meta = readRunMeta(runDir);
  if (progress && isTerminal(progress.status)) {
    const rev = meta ? ensureReviewForTerminal(runDir, progress, meta) : null;
    return { phase: "terminal", liveness: "gone", progress, review: rev };
  }

  if (!meta) {
    return { phase: "accepted", liveness: "unknown", progress, review: null };
  }

  // Zero-spawn hot path: fresh heartbeat proves owner alive without forking `ps`!
  if (!opts?.forceProbe && isHeartbeatFresh(progress, meta) && progress?.liveness !== "unknown") {
    return { phase: progress?.phase ?? statusToPhase(progress?.status), liveness: "alive", progress, review: null };
  }

  const started = readStartedRecord(runDir);
  const workerPid = started?.workerPid ?? meta.workerPid;
  const codexPid = started?.codexPid ?? meta.codexPid;
  const bootId = started?.bootId;

  if (!workerPid && !hasLaunchClaim(runDir)) {
    return { phase: "accepted", liveness: "alive", progress, review: null };
  }

  const workerLive = probePidLivenessSync(workerPid, bootId, (c) => commandMatchesWorker(c, meta.runId));
  const codexLive = codexPid
    ? probePidLivenessSync(codexPid, bootId, (c) => commandMatchesCodex(c, meta.runId))
    : "gone";

  return resolveDeadWorkerOutcome(runDir, meta, progress, workerLive, codexLive, Boolean(started));
}

export async function reconcileRunAsync(runDir: string, opts?: { forceProbe?: boolean }): Promise<ReconcileResult> {
  const existingReview = readReviewPacket(runDir) as ReviewPacketLike | null;
  if (existingReview) {
    return { phase: "terminal", liveness: "gone", progress: readProgress(runDir), review: existingReview };
  }

  const progress = readProgress(runDir);
  const meta = readRunMeta(runDir);
  if (progress && isTerminal(progress.status)) {
    const rev = meta ? ensureReviewForTerminal(runDir, progress, meta) : null;
    return { phase: "terminal", liveness: "gone", progress, review: rev };
  }

  if (!meta) {
    return { phase: "accepted", liveness: "unknown", progress, review: null };
  }

  // Zero-spawn hot path
  if (!opts?.forceProbe && isHeartbeatFresh(progress, meta) && progress?.liveness !== "unknown") {
    return { phase: progress?.phase ?? statusToPhase(progress?.status), liveness: "alive", progress, review: null };
  }

  const started = readStartedRecord(runDir);
  const workerPid = started?.workerPid ?? meta.workerPid;
  const codexPid = started?.codexPid ?? meta.codexPid;
  const bootId = started?.bootId;

  if (!workerPid && !hasLaunchClaim(runDir)) {
    return { phase: "accepted", liveness: "alive", progress, review: null };
  }

  const workerLive = await probePidLivenessAsync(workerPid, bootId, (c) => commandMatchesWorker(c, meta.runId));
  const codexLive = codexPid
    ? await probePidLivenessAsync(codexPid, bootId, (c) => commandMatchesCodex(c, meta.runId))
    : "gone";

  return resolveDeadWorkerOutcome(runDir, meta, progress, workerLive, codexLive, Boolean(started));
}

/** Backwards-compatible wrapper used by sync paths & unit tests. */
export function markWorkerDeadIfNeeded(runDir: string): ProgressState | null {
  return reconcileRunSync(runDir, { forceProbe: true }).progress;
}

// ── Project & Session Pointers ───────────────────────────────────
export function projectHash(gitRoot: string): string {
  return createHash("sha256").update(gitRoot).digest("hex").slice(0, 16);
}

export function updateProjectPointer(gitRoot: string, runId: string) {
  ensureDir(PROJECTS_DIR);
  const fp = path.join(PROJECTS_DIR, `${projectHash(gitRoot)}.json`);
  writeJsonFast(fp, { gitRoot, runId, updatedAt: new Date().toISOString() });
}

export function getLatestRunForProject(gitRoot: string): { runId: string; runDir: string } | null {
  const fp = path.join(PROJECTS_DIR, `${projectHash(gitRoot)}.json`);
  const data = readJson<{ runId: string }>(fp);
  if (!data?.runId) return null;
  const runDir = getRunDir(data.runId);
  if (!existsSync(path.join(runDir, "run.json"))) return null;
  return { runId: data.runId, runDir };
}

export function sessionHash(sessionId: string): string {
  return sessionFileHash(sessionId);
}

export function updateSessionPointer(sessionId: string, runId: string) {
  upsertSessionRecord(sessionId, runId);
}

export function getLatestRunForSession(sessionId: string): string | undefined {
  const rec = readSessionRecord(sessionId) as (ReturnType<typeof readSessionRecord> & { runId?: string }) | null;
  return rec?.latestRunId || rec?.runId || undefined;
}

// ── List / Query (Zero-Spawn Hot Path) ───────────────────────────
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

// ── Cleanup (Session-Rooted GC) ──────────────────────────────────
export function cleanOldRuns(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  runRootedGc(maxAgeMs);
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
  try { sessionPointerCount = readdirSync(SESSIONS_DIR).length; } catch {}
  return { totalBytes, runCount, sessionPointerCount, oldestRun };
}

// ── Shared Directory Watch Multiplexer (Anti-Lost-Wakeup) ────────
interface DirWatchEntry {
  watcher: FSWatcher;
  listeners: Set<() => void>;
}
const sharedDirWatchers = new Map<string, DirWatchEntry>();

function subscribeRunDir(runDir: string, listener: () => void): () => void {
  let entry = sharedDirWatchers.get(runDir);
  if (!entry) {
    try {
      const listeners = new Set<() => void>();
      const watcher = watch(runDir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const f = String(filename);
        if (f === "review.json" || f.startsWith("review.json.") || f === "progress.json" || f.startsWith("progress.json.")) {
          for (const fn of [...listeners]) { try { fn(); } catch {} }
        }
      });
      watcher.on("error", () => {
        const cur = sharedDirWatchers.get(runDir);
        if (cur?.watcher === watcher) sharedDirWatchers.delete(runDir);
        try { watcher.close(); } catch {}
      });
      entry = { watcher, listeners };
      sharedDirWatchers.set(runDir, entry);
    } catch {
      return () => {};
    }
  }
  entry.listeners.add(listener);
  return () => {
    const cur = sharedDirWatchers.get(runDir);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      sharedDirWatchers.delete(runDir);
      try { cur.watcher.close(); } catch {}
    }
  };
}

export interface WaitRunsOptions {
  runIds: string[];
  timeoutMs: number;
  waitFor: "terminal" | "progress";
  cursor?: Record<string, number>;
  wakeOnAttention?: boolean;
}

/**
 * Race-free shared multi-run wait multiplexer (wait-any semantics):
 *   1. Read predicate
 *   2. Register shared dir watchers
 *   3. Re-read predicate (closes lost-wakeup window!)
 *   4. Wait for watcher wakeup or fallback tick (zero `ps` in hot path!)
 *   5. Return all currently ready run IDs (or empty on deadline).
 */
export async function waitForRuns(opts: WaitRunsOptions): Promise<string[]> {
  const uniqueIds = [...new Set(opts.runIds)];
  if (uniqueIds.length === 0) return [];

  const initialSeq: Record<string, number> = {};
  const initialAttentionRev: Record<string, number> = {};
  for (const rid of uniqueIds) {
    if (!runDirExists(rid)) continue;
    const p = readProgress(getRunDir(rid));
    initialSeq[rid] = opts.cursor?.[rid] ?? p?.seq ?? 0;
    initialAttentionRev[rid] = opts.cursor?.[rid] ?? p?.attention?.revision ?? -1;
  }

  const evaluateReady = async (): Promise<string[]> => {
    const ready: string[] = [];
    for (const rid of uniqueIds) {
      if (!runDirExists(rid)) {
        ready.push(rid);
        continue;
      }
      const rd = getRunDir(rid);
      // Zero-spawn hot reconcile (only probes asynchronously if heartbeat stale)
      const rec = await reconcileRunAsync(rd);
      const cursorVal = opts.cursor?.[rid];
      const curRev = rec.progress?.revision ?? rec.progress?.seq ?? 0;

      if (rec.review) {
        // In cursor mode (multi-run wait_any), skip terminal runs already acked at >= current revision
        if (cursorVal !== undefined && curRev <= cursorVal && uniqueIds.length > 1) continue;
        ready.push(rid);
        continue;
      }

      if (rec.liveness === "unknown") {
        if (cursorVal !== undefined && curRev <= cursorVal && uniqueIds.length > 1) continue;
        ready.push(rid);
        continue;
      }

      if (rec.progress && isTerminal(rec.progress.status)) {
        if (cursorVal !== undefined && curRev <= cursorVal && uniqueIds.length > 1) continue;
        ready.push(rid);
        continue;
      }

      // 1-shot attention wakeup (consumed via cursor/initialAttentionRev so it never fires twice!)
      const att = rec.progress?.attention;
      if (opts.wakeOnAttention !== false && att && att.revision > (initialAttentionRev[rid] ?? -1)) {
        ready.push(rid);
        continue;
      }

      if (opts.waitFor === "progress" && rec.progress && rec.progress.seq > (initialSeq[rid] ?? 0)) {
        ready.push(rid);
      }
    }
    return ready;
  };

  // Step 1: initial predicate check
  const first = await evaluateReady();
  if (first.length > 0 || opts.timeoutMs <= 0) return first;

  return new Promise<string[]>((resolve) => {
    const deadline = Date.now() + opts.timeoutMs;
    let done = false;
    let checking = false;
    let recheckQueued = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubs: Array<() => void> = [];

    const finish = (ids: string[]) => {
      if (done) return;
      done = true;
      for (const u of unsubs) u();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      resolve(ids);
    };

    const scheduleFallback = () => {
      if (done) return;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      const remaining = deadline - Date.now();
      if (remaining <= 0) { finish([]); return; }
      fallbackTimer = setTimeout(triggerCheck, Math.min(1000, Math.max(100, remaining)));
      fallbackTimer.unref?.();
    };

    const triggerCheck = () => {
      if (done) return;
      if (checking) { recheckQueued = true; return; }
      checking = true;
      evaluateReady().then((ready) => {
        checking = false;
        if (done) return;
        if (ready.length > 0) { finish(ready); return; }
        if (Date.now() >= deadline) { finish([]); return; }
        if (recheckQueued) { recheckQueued = false; triggerCheck(); return; }
        scheduleFallback();
      }).catch(() => {
        checking = false;
        if (!done) scheduleFallback();
      });
    };

    // Step 2: subscribe to shared directory watchers
    for (const rid of uniqueIds) {
      if (runDirExists(rid)) {
        unsubs.push(subscribeRunDir(getRunDir(rid), triggerCheck));
      }
    }

    // Step 3: re-read predicate after registering watchers (anti-lost-wakeup!)
    triggerCheck();
  });
}

// ── Single-Run Poll (v2 compat, powered by shared multiplexer) ───
export async function pollForCompletion(runDir: string, timeoutMs: number, _intervalMs = 250): Promise<unknown | null> {
  const existing = readReviewPacket(runDir);
  if (existing) return existing;
  const meta = readRunMeta(runDir);
  if (!meta?.runId) return null;
  await waitForRuns({ runIds: [meta.runId], timeoutMs, waitFor: "terminal", wakeOnAttention: false });
  const rec = await reconcileRunAsync(runDir);
  return rec.review;
}
