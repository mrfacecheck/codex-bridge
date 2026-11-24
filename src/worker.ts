#!/usr/bin/env npx tsx
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import { writeFileSync, openSync, closeSync, readSync, statSync, existsSync, watch } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import {
  DEFAULT_IDLE_ATTENTION, EMPTY_TREE_OID,
  type RunMeta, type RunStatus, type Outcome, type TokenUsage, type EventSummary,
  type GitDiffResult, type NoGitResult, type TreeSnapshot, type WriteLock,
  type AttentionState, type CommandStats, type PrepareSpec,
} from "./types.js";
import {
  claimRunLaunch, writeStartedRecord, readStartedRecord, writeRunSessionRecord,
  upsertSessionRecord, acquireLease, currentBootId, readWorkspaceMeta, readCancelIntent,
  createObserverClock, sampleObserverClock, recordObserverActivity, type OwnedLease,
} from "./state.js";
import {
  CODEX_BINARY, buildCodexEnv, normalizeCwd, resolveExecContext,
  acquireWriteLock, assertSnapshotSafe, snapshotWorktreeTree, cleanupSnapshots,
  captureTreeIntoEvidence, collectEvidenceDiff, listTreePaths,
  snapshotFsSentinel, diffFsSentinel, hasTruncatedSensitiveFp, getWorktreeStatus,
  collectDiff, readCapped, checkJsonlHealth, sanitize, killTree,
  pushCap, pushUniqCap, appendCap,
} from "./evidence.js";
import {
  readRunMeta, updateRunMeta, updateProgress, readProgress, touchActivity, writeHeartbeat,
  writeReviewPacket, updateProjectPointer, isCancelRequested,
} from "./progress.js";

// Harden: restrict file creation permissions
process.umask(0o077);

const runDir = process.argv[2];
if (!runDir) { process.stderr.write("worker: runDir argument required\n"); process.exit(1); }

async function main() {
  const meta = readRunMeta(runDir);
  if (!meta) { process.stderr.write(`worker: run.json not found in ${runDir}\n`); process.exit(1); }

  // At-most-once launch claim: only a single winning worker may execute this run.
  if (!claimRunLaunch(runDir)) {
    process.stderr.write(`worker: launch already claimed for ${meta.runId}\n`);
    process.exit(0);
  }

  const ownerNonce = meta.ownerNonce || randomUUID();
  const bootId = currentBootId();
  writeStartedRecord(runDir, {
    runId: meta.runId,
    ownerNonce,
    bootId,
    workerPid: process.pid,
    codexVersion: meta.codexVersion,
    startedAt: new Date().toISOString(),
  });
  updateRunMeta(runDir, { workerPid: process.pid, ownerNonce });
  updateProgress(runDir, { status: "starting", phase: "accepted", liveness: "alive", message: "Worker started" });

  const {
    runId, cwd: rawCwd, sandbox, task, model, maxDiffChars,
    allowNonGit, allowLargeUntracked, resumeSessionId,
  } = meta;

  const wallTimeout = typeof meta.timeout === "number" && meta.timeout > 0 ? meta.timeout : null;
  const idleTimeout = typeof meta.idleTimeout === "number" && meta.idleTimeout > 0 ? meta.idleTimeout : null;
  const idleAttentionSeconds = meta.idleAttentionSeconds === null || meta.idleAttentionSeconds === 0
    ? null
    : (typeof meta.idleAttentionSeconds === "number" && meta.idleAttentionSeconds > 0
        ? meta.idleAttentionSeconds
        : DEFAULT_IDLE_ATTENTION);

  let cwd: string;
  try { cwd = normalizeCwd(rawCwd); } catch (e: any) { fail(e.message, meta); return; }

  const { runCwd, gitRoot, gitRepo } = resolveExecContext(cwd);
  const isWrite = sandbox !== "read-only";
  const useEvidenceStore = Boolean(meta.evidenceGitDir && existsSync(meta.evidenceGitDir));

  let lease: OwnedLease | undefined;
  let wl: WriteLock | undefined;
  let bT: TreeSnapshot | undefined;
  let aT: TreeSnapshot | undefined;

  try {
    // Acquire exclusive owner-nonce lease on workspace (or inplace git root)
    if (isWrite || meta.workspaceId) {
      const leaseTarget = meta.workspaceId ? `workspace:${meta.workspaceId}` : gitRoot;
      try {
        lease = acquireLease(leaseTarget, runId, ownerNonce);
      } catch (e: any) {
        fail(e.message, meta);
        return;
      }
    }
    if (isWrite && !meta.workspaceId) {
      try { wl = acquireWriteLock(gitRoot, runId); } catch (e: any) { fail(e.message, meta); return; }
    }

    // Optional model-free prepare step (runs before Codex; zero model tokens spent on failure!)
    let prepareResult: { ok: boolean; duration_ms: number; exit_code: number | null; log_path?: string; error?: string } | undefined;
    if (meta.prepare) {
      updateProgress(runDir, { status: "preparing", phase: "preparing", message: `Preparing workspace: ${meta.prepare.command}` });
      prepareResult = await runPrepareStep(meta.prepare, runCwd, runDir);
      if (!prepareResult.ok) {
        const msg = `Workspace prepare failed (${prepareResult.error || `exit ${prepareResult.exit_code}`}). Codex was not invoked.`;
        // Seal review packet BEFORE terminal progress so fs.watch waiters never observe terminal status without review-packet.json.
        writeReviewPacket(runDir, {
          run_id: runId, async: false, status: "failed", phase: "terminal", outcome: "failed", liveness: "gone",
          status_detail: "prepare_failed", failure_hint: "prepare_failed",
          cwd: runCwd, git_root: gitRepo ? gitRoot : undefined,
          workspace_id: meta.workspaceId, workspace_kind: meta.workspaceKind,
          prepare: prepareResult, error: msg, warnings: [msg],
        });
        updateProgress(runDir, { status: "failed", phase: "terminal", liveness: "gone", message: msg, error: msg });
        return;
      }
    }

    if (gitRepo && !allowLargeUntracked) {
      try { assertSnapshotSafe(gitRoot, 256); } catch (e: any) { fail(e.message, meta); return; }
    }

    updateProgress(runDir, { status: "snapshot-before", phase: "preparing", message: "Taking before snapshot" });
    const sw: string[] = [];
    const fsBR = gitRepo ? snapshotFsSentinel(gitRoot) : { snapshot: {}, warnings: [] };
    const fsB = fsBR.snapshot;
    sw.push(...fsBR.warnings);
    const pd = gitRepo ? getWorktreeStatus(gitRoot) : [];

    let originTree = meta.originTree ?? null;
    let originPaths: string[] = [];
    let beforeTreeOid: string | null = null;
    if (useEvidenceStore && meta.evidenceGitDir) {
      const ws = meta.workspaceId ? readWorkspaceMeta(meta.workspaceId) : null;
      originTree = originTree ?? ws?.originTree ?? EMPTY_TREE_OID;
      originPaths = listTreePaths(meta.evidenceGitDir, originTree);
      beforeTreeOid = captureTreeIntoEvidence(runCwd, meta.evidenceGitDir, `refs/codex-bridge/runs/${runId}/before`, originPaths);
      updateRunMeta(runDir, { originTree, beforeTree: beforeTreeOid });
    } else if (gitRepo) {
      bT = snapshotWorktreeTree(gitRoot);
      beforeTreeOid = bT.tree;
    }

    // Escape detection: in isolated mode also snapshot parent checkout's status.
    const parentStatusBefore = meta.parentGitRoot ? getWorktreeStatus(meta.parentGitRoot) : [];

    updateProgress(runDir, { status: "running", phase: "running", message: "Starting Codex" });

    const fmp = path.join(runDir, "final-message.md");
    ensurePrivateFile(fmp);
    let outputSchemaPath: string | undefined;
    if (meta.outputSchema) {
      outputSchemaPath = path.join(runDir, "output-schema.json");
      try { writeFileSync(outputSchemaPath, meta.outputSchema, { mode: 0o600 }); } catch { outputSchemaPath = undefined; }
    }
    const ca = buildCodexArgs(runCwd, sandbox, model, fmp, gitRepo, allowNonGit, resumeSessionId, meta.effort, outputSchemaPath);

    const result = await runCodexWorker({
      runId, ownerNonce, args: ca, cwd: runCwd, wallTimeout, idleTimeout, idleAttentionSeconds,
      stdin: task, workerRunDir: runDir, meta, lease, wl, mcpHome: meta.mcpHome,
    });

    if (gitRepo && !allowLargeUntracked) {
      try { assertSnapshotSafe(gitRoot, 256); } catch (e: any) {
        writeReviewPacket(runDir, {
          run_id: runId, async: false, status: "failed", phase: "terminal", outcome: "failed", liveness: "gone",
          error: `Codex created large untracked files. ${e.message}`, cwd: runCwd, git_root: gitRoot,
        });
        updateProgress(runDir, { status: "failed", phase: "terminal", liveness: "gone", message: e.message, error: e.message });
        return;
      }
    }

    updateProgress(runDir, { status: "snapshot-after", phase: "sealing", message: "Sealing after snapshot" });
    let afterTreeOid: string | undefined;
    let evidenceSealed = false;
    let evidenceError: string | undefined;
    let gd: GitDiffResult | NoGitResult;

    const fsAR = gitRepo ? snapshotFsSentinel(gitRoot) : { snapshot: {}, warnings: [] };
    const fsA = fsAR.snapshot;
    sw.push(...fsAR.warnings);
    const fsc = gitRepo ? diffFsSentinel(fsB, fsA) : [];
    const fpTrunc = gitRepo ? (hasTruncatedSensitiveFp(fsB) || hasTruncatedSensitiveFp(fsA)) : false;

    updateProgress(runDir, { status: "building-review", phase: "sealing", message: "Building review packet" });

    if (useEvidenceStore && meta.evidenceGitDir && beforeTreeOid) {
      try {
        afterTreeOid = captureTreeIntoEvidence(runCwd, meta.evidenceGitDir, `refs/codex-bridge/runs/${runId}/after`, originPaths);
        gd = collectEvidenceDiff(meta.evidenceGitDir, runCwd, beforeTreeOid, afterTreeOid, runDir, maxDiffChars, pd.length, fsB, fsA);
        evidenceSealed = true;
      } catch (e: any) {
        evidenceError = e?.message || String(e);
        gd = { is_git_repo: false, changed: false, summary: `Evidence sealing failed: ${evidenceError}` };
      }
    } else if (gitRepo && bT) {
      try {
        aT = snapshotWorktreeTree(gitRoot);
        afterTreeOid = aT.tree;
        gd = collectDiff(gitRoot, bT, aT, runDir, maxDiffChars, pd.length, fsB, fsA);
        evidenceSealed = true;
      } catch (e: any) {
        evidenceError = e?.message || String(e);
        gd = { is_git_repo: false, changed: false, summary: `Evidence sealing failed: ${evidenceError}` };
      }
    } else {
      gd = { is_git_repo: false, changed: false, summary: "Non-git directory" };
      evidenceSealed = true;
    }

    const fm = readCapped(fmp, 160_000);
    const ft = fm?.text.trim();
    const output = ft || result.output;
    const oT = ft ? Boolean(fm?.truncated) : result.outputTruncated;

    const w: string[] = [...sw];
    if (evidenceError) w.push(`Evidence capture failed: ${evidenceError}`);

    let worktreeEscape: { paths: string[]; evidence: string[] } | undefined;
    let concurrentParentChanges: { count: number; paths: string[] } | undefined;
    if (meta.parentGitRoot) {
      const before = new Set(parentStatusBefore.map((f) => `${f.xy}:${f.path}`));
      const newlyDirty = getWorktreeStatus(meta.parentGitRoot).filter((f) => !before.has(`${f.xy}:${f.path}`));
      const parentRoots = new Set<string>([meta.parentGitRoot]);
      try { parentRoots.add(normalizeCwd(meta.parentGitRoot)); } catch {}
      for (const pr of [...parentRoots]) {
        if (pr.startsWith("/private/")) parentRoots.add(pr.slice("/private".length));
      }
      const cmdEvidence: string[] = [];
      for (const cmd of result.events.commands) {
        const isPureRead = /^\s*(?:(?:\/bin\/)?(?:z|ba|da)?sh\s+-[a-z]*c\s+['"]?)?(?:cat|head|tail|less|more|rg|grep|git\s+(?:status|diff|log|show)|ls|stat|wc|file)\b/.test(cmd)
          && !/(?:>|>>|\btee\b)/.test(cmd);
        const directFileHit = !isPureRead && newlyDirty.some((f) => {
          for (const pr of parentRoots) {
            if (cmd.includes(path.join(pr, f.path))) return true;
          }
          return cmd.includes("..") && cmd.includes(f.path);
        });
        if (directFileHit) {
          pushUniqCap(cmdEvidence, cmd.slice(0, 140), 5);
          continue;
        }
        const mentionsParent = [...parentRoots].some((pr) => cmd.includes(pr));
        if (mentionsParent && newlyDirty.length > 0) {
          const onlyDepLink = /\bln\s+-[a-z]*s/.test(cmd) && /(?:node_modules|\.venv)/.test(cmd) && !newlyDirty.some((f) => cmd.includes(f.path));
          const looksWrite = /(?:>|>>|\b(?:rm|mv|cp|touch|tee|install|mkdir|apply_patch|patch|sed\s+-i)\b)/.test(cmd);
          if (!onlyDepLink && looksWrite) pushUniqCap(cmdEvidence, cmd.slice(0, 140), 5);
        }
      }
      const unsandboxed = sandbox === "danger-full-access";
      const confirmedEscape = result.outsideFileChanges.length > 0
        || (newlyDirty.length > 0 && (cmdEvidence.length > 0 || unsandboxed));
      if (confirmedEscape) {
        const escapedPaths = [...new Set([
          ...result.outsideFileChanges.map((p) => path.relative(meta.parentGitRoot!, p)),
          ...newlyDirty.map((f) => f.path),
        ])];
        const evidence: string[] = [];
        if (result.outsideFileChanges.length > 0) evidence.push("codex_file_change_outside_worktree");
        if (cmdEvidence.length > 0) evidence.push("codex_command_targeted_parent");
        if (unsandboxed && newlyDirty.length > 0) evidence.push("unsandboxed_parent_mutation");
        worktreeEscape = { paths: escapedPaths.slice(0, 20), evidence };
        w.push(`WORKTREE ESCAPE: worker modified ${escapedPaths.length} path(s) in the parent checkout (${meta.parentGitRoot}): ${escapedPaths.slice(0, 10).join(", ")}. These changes are OUTSIDE the run diff.`);
        if ("is_git_repo" in gd && gd.is_git_repo && !gd.risk_flags.includes("worktree_escape")) {
          gd.risk_flags.push("worktree_escape");
        }
      } else if (newlyDirty.length > 0) {
        concurrentParentChanges = {
          count: newlyDirty.length,
          paths: newlyDirty.map((f) => f.path).slice(0, 20),
        };
      }
    }
    if (!gitRepo) w.push("Non-git directory: no diff captured.");
    if (pd.length > 0 && !useEvidenceStore) w.push(`Worktree had ${pd.length} pre-existing dirty file(s); diff is scoped to this run.`);
    if (fsc.length > 0) w.push(`Ignored sensitive file(s) changed: ${fsc.map((c) => `${c.kind}:${c.path}`).join(", ")}`);
    if (fpTrunc) w.push("Oversized sensitive file(s) exceeded exact hash limit; same-size candidates conservatively omitted, partial-copy detection out of scope.");
    const jh = checkJsonlHealth(result.events, result.sessionId);
    if (jh) w.push(jh);

    // `succeeded` requires trusted exit, protocol success, resume attachment (if any), AND sealed evidence.
    const attached = resumeSessionId ? result.sessionId === resumeSessionId : true;
    let packetStatus: RunStatus = resumeSessionId ? (attached ? result.status : "failed") : result.status;
    if (packetStatus === "completed" && !evidenceSealed) packetStatus = "failed";

    const outcome: Outcome = packetStatus === "completed"
      ? "succeeded"
      : packetStatus === "cancelled"
        ? "cancelled"
        : packetStatus === "timeout"
          ? "interrupted"
          : "failed";

    const partialChanges = packetStatus !== "completed" && "is_git_repo" in gd && gd.changed;
    if (partialChanges) w.push(`${packetStatus} but changes detected on disk. Review git_diff before retrying or reverting.`);

    if (resumeSessionId && !attached) {
      w.push(result.sessionId ? `Resume verification failed: requested ${resumeSessionId}, got ${result.sessionId}.` : `Resume verification failed: no thread.started emitted.`);
    }
    if (meta.resumeContextVerified === false) {
      w.push("Resume context is user-provided; cwd/sandbox were not verified from a bridge-created session.");
    }

    if ("is_git_repo" in gd && gd.is_git_repo) {
      const refFlag = gd.risk_flags.find((x) => x.startsWith("sensitive_path_references:"));
      if (refFlag) w.push(`Code references sensitive path(s): ${refFlag.split(":").slice(1).join(":")}`);
    }

    if (packetStatus !== "completed" && !result.reportedUsage) {
      w.push("Token usage unknown: Codex did not emit final turn.completed before termination.");
    }

    if (result.jsonlOverflowCount > 0) {
      w.push(`Codex emitted ${result.jsonlOverflowCount} overlong JSONL line(s) exceeding 2MB; content omitted from parsed output.`);
    }

    const NETWORK_MARKERS = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "fetch failed", "socket hang up", "network", "EPROTO"];
    let failureHint: string | undefined;
    if (packetStatus === "timeout") {
      if (result.timeoutKind === "idle") {
        failureHint = "idle_timeout";
        w.push(`Codex emitted no JSONL activity for ${idleTimeout}s of observed active time (idle_timeout).`);
      } else {
        failureHint = "wall_timeout";
        w.push(`Run reached explicit wall-clock timeout (${wallTimeout}s) while active.`);
      }
    } else if (packetStatus === "failed") {
      if (!evidenceSealed) {
        failureHint = "evidence_sealing_failed";
      } else {
        const combined = (result.stderr + " " + result.events.errors.join(" ")).toLowerCase();
        if (NETWORK_MARKERS.some((m) => combined.includes(m.toLowerCase()))) {
          failureHint = "network";
          w.push("Failure appears to be network-related. Check VPN/proxy connectivity before retrying.");
        } else if (!result.sessionId && Object.values(result.events.counts).reduce((a, b) => a + b, 0) === 0) {
          failureHint = "no_response";
          w.push("Codex produced no events. Possible causes: network unreachable, API key invalid, or Codex CLI not functional.");
        }
      }
    }

    const statusDetail = packetStatus === "timeout"
      ? (result.timeoutKind === "idle"
          ? (partialChanges ? "idle_timeout_with_changes" : "idle_timeout_clean")
          : (partialChanges ? "timeout_with_changes" : "timeout_clean"))
      : packetStatus;

    const packet: Record<string, unknown> = {
      run_id: runId,
      async: false,
      session_id: result.sessionId || undefined,
      session_name: meta.sessionName,
      status: packetStatus,
      phase: "terminal",
      outcome,
      liveness: "gone",
      status_detail: statusDetail,
      failure_hint: failureHint,
      partial_changes: partialChanges,
      cwd: runCwd,
      git_root: gitRepo ? gitRoot : undefined,
      workspace_id: meta.workspaceId,
      workspace_kind: meta.workspaceKind,
      parent_dirty_at_create: meta.parentDirtyAtCreate,
      duration_ms: result.durationMs,
      observed_active_ms: result.observedActiveMs,
      observer_gaps: result.observerGaps,
      timeout: wallTimeout,
      idle_timeout: idleTimeout,
      idle_attention_seconds: idleAttentionSeconds,
      output,
      output_source: ft ? "output-last-message" : "jsonl-agent-message",
      output_truncated: oT,
      stderr: result.stderr || undefined,
      stderr_truncated: result.stderrTruncated,
      process: { exit_code: result.exitCode, signal: result.signal },
      reported_usage: result.reportedUsage,
      ...(result.reportedUsage ? { token_usage: result.reportedUsage } : {}),
      events: result.events,
      commands: result.commands,
      attention: result.attention,
      origin_tree: originTree ?? undefined,
      before_tree: beforeTreeOid ?? undefined,
      after_tree: afterTreeOid,
      evidence: {
        sealed: evidenceSealed,
        origin_tree: originTree ?? undefined,
        before_tree: beforeTreeOid ?? undefined,
        after_tree: afterTreeOid,
        ...(evidenceError ? { error: evidenceError } : {}),
      },
      ...(prepareResult ? { prepare: prepareResult } : {}),
      git_diff: gd,
      fs_sentinel: fsc.length > 0 ? { watched: "ignored sensitive files", changes: fsc } : undefined,
      warnings: w,
      ...(worktreeEscape ? { worktree_escape: worktreeEscape } : {}),
      ...(concurrentParentChanges ? { concurrent_parent_changes: concurrentParentChanges } : {}),
      isolation: meta.isolation,
      worktree_path: meta.worktreePath,
      parent_git_root: meta.parentGitRoot ?? undefined,
      model: meta.resolvedModel ?? meta.model ?? null,
      model_source: meta.modelSource,
      effort: meta.resolvedEffort ?? meta.effort ?? null,
      effort_source: meta.effortSource,
      codex_version: meta.codexVersion,
    };

    if (resumeSessionId) {
      packet.requested_session_id = resumeSessionId;
      packet.actual_session_id = result.sessionId || undefined;
      packet.resume_attached = attached;
      packet.resume_context_verified = Boolean(meta.resumeContextVerified);
      packet.sandbox = sandbox;
    }

    // Seal result durably FIRST, then update pointers and terminal progress, THEN release lease.
    writeReviewPacket(runDir, packet);
    if (gitRepo) updateProjectPointer(meta.parentGitRoot || gitRoot, runId);
    if (result.sessionId) {
      upsertSessionRecord(result.sessionId, runId, {
        workspaceId: meta.workspaceId,
        mcpHome: meta.mcpHome,
        cwd: runCwd,
        parentGitRoot: meta.parentGitRoot,
        sandbox,
      });
    }

    updateProgress(runDir, {
      status: packetStatus,
      phase: "terminal",
      liveness: "gone",
      message: packetStatus === "completed" ? "Completed" : `Finished: ${packetStatus}`,
      sessionId: result.sessionId || undefined,
      elapsedMs: result.durationMs,
      observedActiveMs: result.observedActiveMs,
      observerGaps: result.observerGaps,
      commands: result.commands,
      reportedUsage: result.reportedUsage,
      attention: result.attention,
      evidenceSealed,
    });
  } finally {
    cleanupSnapshots(bT, aT);
    wl?.release();
    lease?.release();
  }
}

function fail(message: string, meta?: RunMeta | null) {
  writeReviewPacket(runDir, {
    run_id: meta?.runId ?? readRunMeta(runDir)?.runId,
    async: false, status: "failed", phase: "terminal", outcome: "failed", liveness: "gone",
    error: message,
  });
  updateProgress(runDir, { status: "failed", phase: "terminal", liveness: "gone", message, error: message });
}

function ensurePrivateFile(fp: string) {
  const fd = openSync(fp, "a", 0o600);
  closeSync(fd);
}

function runPrepareStep(
  spec: PrepareSpec,
  cwd: string,
  workerRunDir: string,
): Promise<{ ok: boolean; duration_ms: number; exit_code: number | null; log_path?: string; error?: string }> {
  const t0 = Date.now();
  const logPath = path.join(workerRunDir, "prepare.log");
  const timeoutMs = Math.max(5, Math.min(3600, spec.timeout_seconds ?? 120)) * 1000;
  const logFd = openSync(logPath, "a", 0o600);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(spec.command, spec.args ?? [], {
      cwd,
      stdio: ["ignore", logFd, logFd],
      env: buildCodexEnv(),
      detached: process.platform !== "win32",
    });
    try { closeSync(logFd); } catch {}

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    const finish = (ok: boolean, exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, duration_ms: Date.now() - t0, exit_code: exitCode, log_path: logPath, error });
    };

    child.on("error", (e) => finish(false, null, e.message));
    child.on("close", (code) => {
      if (timedOut) finish(false, code, `prepare timed out after ${Math.round(timeoutMs / 1000)}s`);
      else if (code === 0) finish(true, 0);
      else finish(false, code, `prepare exited ${code}`);
    });
  });
}

function buildCodexArgs(runCwd: string, sandbox: string, model: string | undefined, fmp: string, gitRepo: boolean, allowNonGit: boolean, resumeSessionId?: string, effort?: string, outputSchemaPath?: string): string[] {
  if (resumeSessionId) {
    const ca = ["exec", "resume", resumeSessionId, "--json", "-c", 'approval_policy="never"', "-o", fmp];
    if (!gitRepo && allowNonGit) ca.push("--skip-git-repo-check");
    if (model) ca.push("-m", model);
    if (effort) ca.push("-c", `model_reasoning_effort="${effort}"`);
    ca.push("-");
    return ca;
  }
  const ca = ["exec", "--json", "--color", "never", "-C", runCwd, "-s", sandbox, "-c", 'approval_policy="never"', "-o", fmp];
  if (!gitRepo && allowNonGit) ca.push("--skip-git-repo-check");
  if (model) ca.push("-m", model);
  if (effort) ca.push("-c", `model_reasoning_effort="${effort}"`);
  if (outputSchemaPath) ca.push("--output-schema", outputSchemaPath);
  ca.push("-");
  return ca;
}

interface WorkerCodexParams {
  runId: string;
  ownerNonce: string;
  args: string[];
  cwd: string;
  wallTimeout: number | null;
  idleTimeout: number | null;
  idleAttentionSeconds: number | null;
  stdin: string;
  workerRunDir: string;
  meta: RunMeta;
  lease?: OwnedLease;
  wl?: WriteLock;
  mcpHome?: string;
}

interface WorkerCodexResult {
  sessionId: string; status: RunStatus; exitCode: number | null; signal: NodeJS.Signals | null;
  output: string; outputTruncated: boolean; stderr: string; stderrTruncated: boolean;
  reportedUsage: TokenUsage | null; events: EventSummary; commands: CommandStats;
  attention: AttentionState | null; durationMs: number; observedActiveMs: number; observerGaps: number;
  jsonlOverflowCount: number; timeoutKind: "wall" | "idle" | null; outsideFileChanges: string[];
}

function runCodexWorker(params: WorkerCodexParams): Promise<WorkerCodexResult> {
  const {
    runId, ownerNonce, args, cwd, wallTimeout, idleTimeout, idleAttentionSeconds,
    stdin, workerRunDir, meta, lease, wl, mcpHome,
  } = params;
  const t0 = Date.now();
  const stdoutPath = path.join(workerRunDir, "codex.stdout.jsonl");
  const stderrPath = path.join(workerRunDir, "codex.stderr.log");

  // Direct-FD stdio: Codex writes straight to private disk files!
  // If worker dies unexpectedly, Codex does NOT receive EPIPE and already-written events remain salvageable.
  const stdoutFd = openSync(stdoutPath, "a", 0o600);
  const stderrFd = openSync(stderrPath, "a", 0o600);

  const codexEnv = buildCodexEnv({ sandbox: meta.sandbox });
  const proc = spawn(CODEX_BINARY, args, {
    cwd,
    stdio: ["pipe", stdoutFd, stderrFd],
    env: mcpHome ? { ...codexEnv, CODEX_HOME: mcpHome } : codexEnv,
    detached: process.platform !== "win32",
  });
  try { closeSync(stdoutFd); } catch {}
  try { closeSync(stderrFd); } catch {}

  if (proc.pid) {
    lease?.attachCodexPid(proc.pid);
    wl?.attachChildPid(proc.pid);
    updateRunMeta(workerRunDir, { codexPid: proc.pid });
    const started = readStartedRecord(workerRunDir);
    if (started) writeStartedRecord(workerRunDir, { ...started, codexPid: proc.pid });
  }

  return new Promise<WorkerCodexResult>((resolve) => {
    let sid = ""; let sidPersisted = false;
    let out = ""; let outT = false;
    let buf = "";
    let stdoutOffset = 0;
    let cancelReq = false; let timeoutReq = false; let timeoutKind: "wall" | "idle" | null = null;
    let settled = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;

    // Usage stays honestly `null` until Codex reports usage (e.g. turn.completed)
    let reportedUsage: TokenUsage | null = null;
    const ev: EventSummary = { counts: {}, file_changes: [], commands: [], errors: [] };
    const commands: CommandStats = { completed: 0, failed: 0, inflight: 0 };
    const outsideFileChanges: string[] = [];
    const seenCmdIds = new Set<string>();
    const inflightCmdIds = new Set<string>();
    const failureCounts = new Map<string, number>();
    let lastStartedCmd: string | null = null;
    let currentAttention: AttentionState | null = null;
    let idleAttentionRaised = false;
    let noResponseRaised = false;
    let repeatedFailRaisedFor = new Set<string>();

    const sod = new StringDecoder("utf8");
    const MAX_JSONL_LINE_CHARS = 2 * 1024 * 1024;
    let jsonlEventCount = 0;
    let jsonlLineOverflow = false;
    let jsonlOverflowCount = 0;

    // Sleep-immune observation clock (2s sampling)
    const SAMPLE_INTERVAL_MS = 2000;
    const clock = createObserverClock(process.hrtime.bigint(), Date.now(), SAMPLE_INTERVAL_MS);

    function scheduleHardKill() {
      if (hardKillTimer) return;
      hardKillTimer = setTimeout(() => { killTree(proc, "SIGKILL"); }, 5000);
      hardKillTimer.unref?.();
    }
    function clearHardKill() {
      if (hardKillTimer) { clearTimeout(hardKillTimer); hardKillTimer = undefined; }
    }

    function raiseAttention(code: AttentionState["code"], message: string) {
      const cur = readProgress(workerRunDir);
      const nextRev = (cur?.revision ?? cur?.seq ?? 0) + 1;
      const att: AttentionState = {
        code,
        revision: nextRev,
        message: sanitize(message),
        raisedAt: new Date().toISOString(),
      };
      currentAttention = att;
      updateProgress(workerRunDir, {
        status: cancelReq ? "cancelling" : "running",
        phase: "running",
        message: att.message,
        attention: att,
        sessionId: sid || undefined,
        elapsedMs: Date.now() - t0,
        observedActiveMs: Math.round(clock.observedActiveMs),
        idleActiveMs: Math.round(clock.idleActiveMs),
        observerGaps: clock.observerGaps,
        commands: { ...commands },
        reportedUsage,
      });
    }

    function onP(m: string, isRealActivity = true) {
      if (isRealActivity) {
        recordObserverActivity(clock);
        idleAttentionRaised = false;
      }
      updateProgress(workerRunDir, {
        status: cancelReq ? "cancelling" : "running",
        phase: "running",
        message: sanitize(m),
        sessionId: sid || undefined,
        elapsedMs: Date.now() - t0,
        observedActiveMs: Math.round(clock.observedActiveMs),
        idleActiveMs: Math.round(clock.idleActiveMs),
        observerGaps: clock.observerGaps,
        commands: { ...commands },
        reportedUsage,
        ...(isRealActivity ? { lastActivityAt: new Date().toISOString() } : {}),
      });
    }

    function ao(t: string) {
      const r = appendCap(out, t, 160_000);
      out = r.text;
      if (r.truncated) outT = true;
    }

    function updateUsage(e: any) {
      const u = e.usage || e.item?.usage;
      if (!u) return;
      reportedUsage = {
        input: u.input_tokens ?? reportedUsage?.input ?? 0,
        output: u.output_tokens ?? reportedUsage?.output ?? 0,
        cached: u.cached_input_tokens ?? reportedUsage?.cached ?? 0,
        reasoning: u.reasoning_output_tokens ?? reportedUsage?.reasoning ?? 0,
      };
    }

    function persistSessionEarly(sessionId: string) {
      if (!sessionId || sidPersisted) return;
      sidPersisted = true;
      writeRunSessionRecord(workerRunDir, sessionId, "live");
      upsertSessionRecord(sessionId, runId, {
        workspaceId: meta.workspaceId,
        mcpHome: meta.mcpHome,
        cwd,
        parentGitRoot: meta.parentGitRoot,
        sandbox: meta.sandbox,
      });
    }

    function pl(line: string) {
      let e: any;
      try { e = JSON.parse(line); } catch { ao(line + "\n"); return; }
      jsonlEventCount++;
      recordObserverActivity(clock);
      idleAttentionRaised = false;

      const tp = e.type || "unknown";
      ev.counts[tp] = (ev.counts[tp] || 0) + 1;
      updateUsage(e);

      if (tp === "thread.started") {
        sid = e.thread_id || "";
        // Durable early session persistence on first thread.started!
        if (sid) persistSessionEarly(sid);
        onP(`Session started: ${sid}`, true);
      } else if (tp === "error" || tp === "turn.failed") {
        const m = e.message || e.error?.message || JSON.stringify(e);
        pushCap(ev.errors, String(m).slice(0, 1000), 50);
        onP(`Error: ${m}`, true);
      } else if (tp === "turn.completed") {
        const u = reportedUsage;
        onP(u ? `Done (${u.input} in → ${u.output} out, ${u.cached} cached)` : "Turn completed", true);
      } else if (e.item) {
        const it = e.item;
        if (tp === "item.completed" && it.type === "agent_message") {
          ao((it.text || "") + "\n");
          onP(it.text || "", true);
        } else if (it.type === "file_change") {
          const ps: string[] = [];
          for (const c of (it.changes || [])) {
            const raw = c?.path || "";
            if (!raw) continue;
            const rawAbs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
            let normAbs = rawAbs;
            try { normAbs = normalizeCwd(rawAbs); }
            catch { try { normAbs = path.join(normalizeCwd(path.dirname(rawAbs)), path.basename(rawAbs)); } catch {} }
            const rel = path.relative(cwd, normAbs);
            if (rel.startsWith("..") || path.isAbsolute(rel)) pushUniqCap(outsideFileChanges, normAbs, 50);
            ps.push(rel);
            pushUniqCap(ev.file_changes, rel, 200);
          }
          if (ps.length) onP(`${tp === "item.completed" ? "Saved" : "Editing"}: ${ps.slice(0, 5).join(", ")}`, true);
        } else if (it.type === "command_execution" || it.type === "shell_command" || it.type === "tool_call") {
          const cmd = it.command || it.name || it.tool || "";
          if (cmd) {
            const cl = sanitize(Array.isArray(cmd) ? cmd.join(" ") : String(cmd));
            const itemId = typeof it.id === "string" && it.id ? it.id : null;
            if (tp === "item.started") {
              if (itemId) { seenCmdIds.add(itemId); inflightCmdIds.add(itemId); }
              commands.inflight = inflightCmdIds.size;
              lastStartedCmd = cl;
              pushCap(ev.commands, cl, 100);
              onP(`Running: ${cl}`, true);
            } else if (tp === "item.completed") {
              const alreadySeen = (itemId !== null && seenCmdIds.has(itemId)) || (itemId === null && lastStartedCmd === cl);
              if (itemId) inflightCmdIds.delete(itemId);
              commands.inflight = inflightCmdIds.size;
              commands.completed++;
              const failedExit = typeof it.exit_code === "number" && it.exit_code !== 0;
              if (failedExit) commands.failed++;
              if (lastStartedCmd === cl) lastStartedCmd = null;

              if (!alreadySeen) {
                pushCap(ev.commands, cl, 100);
                onP(`Running: ${cl}`, true);
              } else if (failedExit) {
                onP(`Command exited ${it.exit_code}: ${cl}`, true);
              } else {
                touchActivity(workerRunDir, Date.now() - t0, {
                  observedActiveMs: Math.round(clock.observedActiveMs),
                  idleActiveMs: 0,
                  observerGaps: clock.observerGaps,
                  commands: { ...commands },
                  reportedUsage,
                });
              }

              // Low-noise 1-shot repeated_failure attention (never auto-kills!)
              if (failedExit) {
                const aggOut = typeof it.aggregated_output === "string" ? it.aggregated_output : "";
                const combinedBrowserText = `${cl}\n${aggOut}`;
                const mentionsDarwinGuiBrowser = /\/Applications\/[^"'`\s]*\.app|Google Chrome|Brave Browser|Microsoft Edge|Safari\.app|Chromium\.app|ms-playwright|\.cache\/puppeteer|HOST_VISUAL_QA_REQUIRED/i.test(combinedBrowserText);
                const hasAbortOrExecDenyFingerprint = it.exit_code === 134
                  || /\bSIGABRT\b|Abort trap: 6|_RegisterApplication|Operation not permitted|Permission denied|\bEPERM\b/i.test(aggOut);
                const isDarwinGuiBrowserDenial = process.platform === "darwin"
                  && meta.sandbox !== "danger-full-access"
                  && mentionsDarwinGuiBrowser
                  && (hasAbortOrExecDenyFingerprint || aggOut.includes("HOST_VISUAL_QA_REQUIRED"));
                if (isDarwinGuiBrowserDenial && !repeatedFailRaisedFor.has("sandbox_gui_crash")) {
                  repeatedFailRaisedFor.add("sandbox_gui_crash");
                  raiseAttention(
                    "sandbox_gui_crash",
                    `HOST_VISUAL_QA_REQUIRED (non-retryable): macOS sandboxed worker cannot execute GUI browsers (exit ${it.exit_code}): ${cl.slice(0, 160)}`,
                  );
                }
                const fp = `${cl}:${it.exit_code}`;
                const cnt = (failureCounts.get(fp) ?? 0) + 1;
                failureCounts.set(fp, cnt);
                if (cnt >= 3 && !repeatedFailRaisedFor.has(fp)) {
                  repeatedFailRaisedFor.add(fp);
                  raiseAttention("repeated_failure", `Command failed ${cnt} times (exit ${it.exit_code}): ${cl}`);
                }
              }
            }
          }
        } else {
          touchActivity(workerRunDir, Date.now() - t0, {
            observedActiveMs: Math.round(clock.observedActiveMs),
            idleActiveMs: 0,
            observerGaps: clock.observerGaps,
            commands: { ...commands },
            reportedUsage,
          });
        }
      } else {
        touchActivity(workerRunDir, Date.now() - t0, {
          observedActiveMs: Math.round(clock.observedActiveMs),
          idleActiveMs: 0,
          observerGaps: clock.observerGaps,
          commands: { ...commands },
          reportedUsage,
        });
      }
    }

    function omitOverflowedJsonlLine() {
      jsonlOverflowCount++;
      ao(`\n...[overlong JSONL line omitted; exceeded ${MAX_JSONL_LINE_CHARS} chars]...\n`);
      buf = "";
      jsonlLineOverflow = false;
    }

    function feed(t: string) {
      const parts = t.split("\n");
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const hasNewline = i < parts.length - 1;
        if (jsonlLineOverflow) {
          if (hasNewline) omitOverflowedJsonlLine();
          continue;
        }
        if (buf.length + part.length > MAX_JSONL_LINE_CHARS) {
          jsonlLineOverflow = true;
          if (hasNewline) omitOverflowedJsonlLine();
          continue;
        }
        buf += part;
        if (hasNewline) {
          if (buf.trim()) pl(buf);
          buf = "";
        }
      }
    }

    // Tail direct-FD stdout JSONL cleanly by byte cursor (complete lines only until EOF)
    function drainStdoutFile(finalFlush = false) {
      let size = 0;
      try { size = statSync(stdoutPath).size; } catch { return; }
      if (size > stdoutOffset) {
        const fd = openSync(stdoutPath, "r");
        try {
          const chunkBuf = Buffer.alloc(65536);
          while (stdoutOffset < size) {
            const toRead = Math.min(chunkBuf.length, size - stdoutOffset);
            const n = readSync(fd, chunkBuf, 0, toRead, stdoutOffset);
            if (n <= 0) break;
            stdoutOffset += n;
            feed(sod.write(chunkBuf.subarray(0, n)));
          }
        } finally {
          closeSync(fd);
        }
      }
      if (finalFlush) {
        const rem = sod.end();
        if (rem) feed(rem);
        if (jsonlLineOverflow) omitOverflowedJsonlLine();
        else if (buf.trim()) { pl(buf); buf = ""; }
      }
    }

    function checkCancel() {
      if (cancelReq || settled) return;
      if (!isCancelRequested(workerRunDir)) return;
      const intent = readCancelIntent(workerRunDir);
      if (intent?.ownerNonce && intent.ownerNonce !== ownerNonce) return;
      cancelReq = true;
      onP("Cancellation requested", false);
      killTree(proc, "SIGTERM");
      scheduleHardKill();
    }

    // Watch runDir for direct-FD stdout appends AND cancel files
    let dirWatcher: ReturnType<typeof watch> | undefined;
    try {
      dirWatcher = watch(workerRunDir, { persistent: false }, (_ev, filename) => {
        if (settled || !filename) return;
        const f = String(filename);
        if (f === "codex.stdout.jsonl") drainStdoutFile(false);
        else if (f === "cancel.json" || f === "cancel.requested") checkCancel();
      });
      dirWatcher.on("error", () => { try { dirWatcher?.close(); } catch {} dirWatcher = undefined; });
    } catch {}

    // Fast fallback tail + cancel poll (150ms)
    const tailTimer = setInterval(() => {
      if (settled) return;
      drainStdoutFile(false);
      checkCancel();
    }, 150);
    tailTimer.unref?.();

    // Sleep-immune 2s observer + heartbeat + attention / explicit idle budget timer
    // Use faster check when caller sets a very small explicit idle budget/attention (e.g. 2s in tests).
    const smallestBudget = Math.min(idleTimeout ?? Infinity, idleAttentionSeconds ?? Infinity);
    const effectiveSampleMs = smallestBudget < 10 ? 500 : SAMPLE_INTERVAL_MS;
    clock.sampleIntervalMs = effectiveSampleMs;
    const observerTimer = setInterval(() => {
      if (settled) return;
      // Always read newly landed logs BEFORE evaluating silence or budgets
      drainStdoutFile(false);
      const tick = sampleObserverClock(clock);

      writeHeartbeat(workerRunDir, {
        elapsedMs: Date.now() - t0,
        observedActiveMs: tick.observedActiveMs,
        idleActiveMs: tick.idleActiveMs,
        observerGaps: tick.observerGaps,
        commands: { ...commands },
      });

      if (!tick.canEvaluateBudgets) return;

      // 30s initial no-response attention
      if (jsonlEventCount === 0 && !noResponseRaised && tick.observedActiveMs >= 30_000) {
        noResponseRaised = true;
        raiseAttention("no_response", "No JSONL events from Codex after 30s. Possible network/API issue — check VPN/proxy.");
      }

      // Explicit caller idle_timeout budget (sleep-immune!)
      if (idleTimeout !== null && tick.idleActiveMs >= idleTimeout * 1000) {
        timeoutReq = true;
        timeoutKind = "idle";
        onP(`Idle timeout after ${idleTimeout}s without Codex activity`, false);
        killTree(proc, "SIGTERM");
        scheduleHardKill();
        return;
      }

      // Default attention-only silence notice (1-shot per silence streak; NEVER auto-kills!)
      if (idleAttentionSeconds !== null && !idleAttentionRaised && tick.idleActiveMs >= idleAttentionSeconds * 1000) {
        idleAttentionRaised = true;
        const mins = Math.max(1, Math.round(tick.idleActiveMs / 60_000));
        raiseAttention("idle_silence", `No Codex JSONL events for ${mins}min (${Math.round(tick.idleActiveMs / 1000)}s active observation). Decide whether to keep waiting or stop.`);
      }
    }, effectiveSampleMs);
    observerTimer.unref?.();

    // Optional explicit wall-clock cap (explicitly documented as wall time incl. sleep)
    if (wallTimeout !== null) {
      wallTimer = setTimeout(() => {
        if (settled) return;
        timeoutReq = true;
        timeoutKind = "wall";
        onP(`Wall-clock timeout after ${wallTimeout}s`, false);
        killTree(proc, "SIGTERM");
        scheduleHardKill();
      }, wallTimeout * 1000);
    }

    function wasCancelled(): boolean { return cancelReq || isCancelRequested(workerRunDir); }

    function fin(s: RunStatus, ec: number | null, sg: NodeJS.Signals | null) {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      clearInterval(tailTimer);
      clearInterval(observerTimer);
      clearHardKill();
      try { dirWatcher?.close(); } catch {}

      drainStdoutFile(true);
      const stderrRead = readCapped(stderrPath, 80_000);

      resolve({
        sessionId: sid,
        status: wasCancelled() ? "cancelled" : s,
        exitCode: ec,
        signal: sg,
        output: out.trim(),
        outputTruncated: outT,
        stderr: stderrRead?.text.trim() ?? "",
        stderrTruncated: Boolean(stderrRead?.truncated),
        reportedUsage,
        events: ev,
        commands,
        attention: currentAttention,
        durationMs: Date.now() - t0,
        observedActiveMs: Math.round(clock.observedActiveMs),
        observerGaps: clock.observerGaps,
        jsonlOverflowCount,
        timeoutKind,
        outsideFileChanges,
      });
    }

    proc.stdin?.on("error", () => {});
    proc.stdin?.end(stdin);

    proc.on("error", (e) => { pushCap(ev.errors, e.message, 50); fin("failed", null, null); });
    proc.on("close", (code, sig) => {
      drainStdoutFile(true);
      const finalStatus: RunStatus = timeoutReq
        ? "timeout"
        : (code === 0 && ev.errors.length === 0 ? "completed" : "failed");
      fin(finalStatus, code, sig);
    });
  });
}

main().catch((e) => {
  const message = e?.message || String(e);
  try {
    const meta = readRunMeta(runDir);
    writeReviewPacket(runDir, {
      run_id: meta?.runId, async: false, status: "failed", phase: "terminal", outcome: "failed", liveness: "gone",
      status_detail: "worker_failed_before_review", cwd: meta?.cwd,
      git_root: meta?.gitRoot || undefined, error: message,
      warnings: ["Worker failed before review packet was finalized. Evidence may be incomplete."],
    });
    updateProgress(runDir, { status: "failed", phase: "terminal", liveness: "gone", message, error: message });
  } catch {}
  process.stderr.write(`worker fatal: ${message}\n`);
  process.exit(1);
});
