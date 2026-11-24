#!/usr/bin/env npx tsx
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { writeFileSync, openSync, closeSync, createWriteStream } from "fs";
import path from "path";
import { DEFAULT_IDLE_TIMEOUT, type RunMeta, type RunStatus, type TokenUsage, type EventSummary, type GitDiffResult, type NoGitResult, type TreeSnapshot, type WriteLock } from "./types.js";
import {
  CODEX_BINARY, buildCodexEnv, normalizeCwd, resolveExecContext,
  acquireWriteLock, assertSnapshotSafe, snapshotWorktreeTree, cleanupSnapshots,
  snapshotFsSentinel, diffFsSentinel, hasTruncatedSensitiveFp, getWorktreeStatus,
  collectDiff, readCapped, checkJsonlHealth, sanitize, killTree,
  pushCap, pushUniqCap, appendCap,
} from "./evidence.js";
import { readRunMeta, updateRunMeta, updateProgress, touchActivity, writeReviewPacket, updateProjectPointer, updateSessionPointer, isCancelRequested } from "./progress.js";

// Harden: restrict file creation permissions
process.umask(0o077);

const runDir = process.argv[2];
if (!runDir) { process.stderr.write("worker: runDir argument required\n"); process.exit(1); }

async function main() {
  const meta = readRunMeta(runDir);
  if (!meta) { process.stderr.write(`worker: run.json not found in ${runDir}\n`); process.exit(1); }

  updateRunMeta(runDir, { workerPid: process.pid });
  updateProgress(runDir, { status: "starting", message: "Worker started" });

  const { runId, cwd: rawCwd, sandbox, task, model, maxDiffChars, allowNonGit, allowLargeUntracked, resumeSessionId } = meta;
  const wallTimeout = typeof meta.timeout === "number" && meta.timeout > 0 ? meta.timeout : null;
  const idleTimeout = meta.idleTimeout === null || meta.idleTimeout === 0
    ? null
    : (typeof meta.idleTimeout === "number" && meta.idleTimeout > 0 ? meta.idleTimeout : DEFAULT_IDLE_TIMEOUT);
  let cwd: string;
  try { cwd = normalizeCwd(rawCwd); } catch (e: any) { fail(e.message); return; }

  const { runCwd, gitRoot, gitRepo } = resolveExecContext(cwd);
  const isWrite = sandbox !== "read-only";

  let wl: WriteLock | undefined;
  let bT: TreeSnapshot | undefined;
  let aT: TreeSnapshot | undefined;

  try {
    if (isWrite) {
      try { wl = acquireWriteLock(gitRoot, runId); } catch (e: any) { fail(e.message); return; }
    }

    if (gitRepo && !allowLargeUntracked) {
      try { assertSnapshotSafe(gitRoot, 256); } catch (e: any) { fail(e.message); return; }
    }

    updateProgress(runDir, { status: "snapshot-before", message: "Taking before snapshot" });
    const sw: string[] = [];
    const fsBR = gitRepo ? snapshotFsSentinel(gitRoot) : { snapshot: {}, warnings: [] };
    const fsB = fsBR.snapshot;
    sw.push(...fsBR.warnings);
    const pd = gitRepo ? getWorktreeStatus(gitRoot) : [];
    bT = gitRepo ? snapshotWorktreeTree(gitRoot) : undefined;
    // Escape detection: in worktree mode also snapshot the parent checkout's
    // status so writes outside the worktree are caught, not silently missed.
    const parentStatusBefore = meta.parentGitRoot ? getWorktreeStatus(meta.parentGitRoot) : [];

    updateProgress(runDir, { status: "running", message: "Starting Codex" });

    const fmp = path.join(runDir, "final-message.md");
    ensurePrivateFile(fmp);
    let outputSchemaPath: string | undefined;
    if (meta.outputSchema) {
      outputSchemaPath = path.join(runDir, "output-schema.json");
      try { writeFileSync(outputSchemaPath, meta.outputSchema, { mode: 0o600 }); } catch { outputSchemaPath = undefined; }
    }
    const ca = buildCodexArgs(runCwd, sandbox, model, fmp, gitRepo, allowNonGit, resumeSessionId, meta.effort, outputSchemaPath);

    const result = await runCodexWorker(runId, ca, runCwd, wallTimeout, idleTimeout, task, runDir, wl, meta.mcpHome);

    if (gitRepo && !allowLargeUntracked) {
      try { assertSnapshotSafe(gitRoot, 256); } catch (e: any) {
        updateProgress(runDir, { status: "failed", message: e.message, error: e.message });
        writeReviewPacket(runDir, { run_id: runId, async: false, status: "failed", error: `Codex created large untracked files. ${e.message}`, cwd: runCwd, git_root: gitRoot });
        return;
      }
    }

    updateProgress(runDir, { status: "snapshot-after", message: "Taking after snapshot" });
    aT = gitRepo ? snapshotWorktreeTree(gitRoot) : undefined;
    const fsAR = gitRepo ? snapshotFsSentinel(gitRoot) : { snapshot: {}, warnings: [] };
    const fsA = fsAR.snapshot;
    sw.push(...fsAR.warnings);
    const fsc = gitRepo ? diffFsSentinel(fsB, fsA) : [];
    const fpTrunc = gitRepo ? (hasTruncatedSensitiveFp(fsB) || hasTruncatedSensitiveFp(fsA)) : false;

    updateProgress(runDir, { status: "building-review", message: "Building review packet" });

    let gd: GitDiffResult | NoGitResult;
    if (gitRepo && bT && aT) {
      gd = collectDiff(gitRoot, bT, aT, runDir, maxDiffChars, pd.length, fsB, fsA);
    } else {
      gd = { is_git_repo: false, changed: false, summary: "Non-git directory" };
    }

    const fm = readCapped(fmp, 160_000);
    const ft = fm?.text.trim();
    const output = ft || result.output;
    const oT = ft ? Boolean(fm?.truncated) : result.outputTruncated;

    const w: string[] = [...sw];
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
        // Catch writes aimed at parentRoot outside benign read-only deps symlinks (node_modules / .venv)
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
    if (pd.length > 0) w.push(`Worktree had ${pd.length} pre-existing dirty file(s); diff is scoped to this run.`);
    if (fsc.length > 0) w.push(`Ignored sensitive file(s) changed: ${fsc.map((c) => `${c.kind}:${c.path}`).join(", ")}`);
    if (fpTrunc) w.push("Oversized sensitive file(s) exceeded exact hash limit; same-size candidates conservatively omitted, partial-copy detection out of scope.");
    const jh = checkJsonlHealth(result.events, result.sessionId);
    if (jh) w.push(jh);

    // Determine actual packet status
    const attached = resumeSessionId ? result.sessionId === resumeSessionId : true;
    const packetStatus: RunStatus = resumeSessionId ? (attached ? result.status : "failed") : result.status;
    const partialChanges = packetStatus !== "completed" && "is_git_repo" in gd && gd.changed;
    if (partialChanges) w.push(`${packetStatus} but changes detected on disk. Review git_diff before retrying or reverting.`);

    if (resumeSessionId && !attached) {
      w.push(result.sessionId ? `Resume verification failed: requested ${resumeSessionId}, got ${result.sessionId}.` : `Resume verification failed: no thread.started emitted.`);
    }
    if (meta.resumeContextVerified === false) {
      w.push("Resume context is user-provided; cwd/sandbox were not verified from a bridge-created session.");
    }

    // Sensitive path reference warning
    if ("is_git_repo" in gd && gd.is_git_repo) {
      const refFlag = gd.risk_flags.find((x) => x.startsWith("sensitive_path_references:"));
      if (refFlag) w.push(`Code references sensitive path(s): ${refFlag.split(":").slice(1).join(":")}`);
    }

    // Token usage incomplete warning
    if (packetStatus !== "completed" && result.tokenUsage.input === 0) {
      w.push("Token usage may be incomplete: Codex did not emit final turn.completed before termination.");
    }

    // JSONL overflow warning
    if (result.jsonlOverflowCount > 0) {
      w.push(`Codex emitted ${result.jsonlOverflowCount} overlong JSONL line(s) exceeding 2MB; content omitted from parsed output.`);
    }

    // Failure classification using stable Node.js error codes
    const NETWORK_MARKERS = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "fetch failed", "socket hang up", "network", "EPROTO"];
    let failureHint: string | undefined;
    if (packetStatus === "timeout") {
      if (result.timeoutKind === "idle") {
        failureHint = "idle_timeout";
        w.push(`Codex emitted no JSONL activity for ${idleTimeout}s (idle_timeout).`);
      } else {
        failureHint = "wall_timeout";
        w.push(`Run reached explicit wall-clock timeout (${wallTimeout}s) while active. Omit timeout to rely on activity-based idle_timeout.`);
      }
    } else if (packetStatus === "failed") {
      const combined = (result.stderr + " " + result.events.errors.join(" ")).toLowerCase();
      if (NETWORK_MARKERS.some((m) => combined.includes(m.toLowerCase()))) {
        failureHint = "network";
        w.push("Failure appears to be network-related. Check VPN/proxy connectivity before retrying.");
      } else if (!result.sessionId && Object.values(result.events.counts).reduce((a, b) => a + b, 0) === 0) {
        failureHint = "no_response";
        w.push("Codex produced no events. Possible causes: network unreachable, API key invalid, or Codex CLI not functional.");
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
      status_detail: statusDetail,
      failure_hint: failureHint,
      partial_changes: partialChanges,
      cwd: runCwd,
      git_root: gitRepo ? gitRoot : undefined,
      duration_ms: result.durationMs,
      timeout: wallTimeout,
      idle_timeout: idleTimeout,
      output,
      output_source: ft ? "output-last-message" : "jsonl-agent-message",
      output_truncated: oT,
      stderr: result.stderr || undefined,
      stderr_truncated: result.stderrTruncated,
      process: { exit_code: result.exitCode, signal: result.signal },
      token_usage: result.tokenUsage,
      events: result.events,
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

    writeReviewPacket(runDir, packet);
    if (gitRepo) updateProjectPointer(gitRoot, runId);
    if (result.sessionId) updateSessionPointer(result.sessionId, runId);

    updateProgress(runDir, {
      status: packetStatus === "completed" ? "completed" : packetStatus === "timeout" ? "timeout" : packetStatus === "cancelled" ? "cancelled" : "failed",
      message: packetStatus === "completed" ? "Completed" : `Finished: ${packetStatus}`,
      sessionId: result.sessionId,
      elapsedMs: result.durationMs,
    });

  } finally {
    cleanupSnapshots(bT, aT);
    wl?.release();
  }
}

function fail(message: string) {
  updateProgress(runDir, { status: "failed", message, error: message });
  writeReviewPacket(runDir, { run_id: readRunMeta(runDir)?.runId, async: false, status: "failed", error: message });
}

function ensurePrivateFile(fp: string) {
  const fd = openSync(fp, "a", 0o600);
  closeSync(fd);
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

interface WorkerCodexResult {
  sessionId: string; status: RunStatus; exitCode: number | null; signal: NodeJS.Signals | null;
  output: string; outputTruncated: boolean; stderr: string; stderrTruncated: boolean;
  tokenUsage: TokenUsage; events: EventSummary; durationMs: number; jsonlOverflowCount: number;
  timeoutKind: "wall" | "idle" | null; outsideFileChanges: string[];
}

function runCodexWorker(runId: string, args: string[], cwd: string, wallTimeout: number | null, idleTimeout: number | null, stdin: string, workerRunDir: string, wl?: WriteLock, mcpHome?: string): Promise<WorkerCodexResult> {
  const t0 = Date.now();
  const stdoutPath = path.join(workerRunDir, "codex.stdout.jsonl");
  const stderrPath = path.join(workerRunDir, "codex.stderr.log");
  const stdoutStream = createWriteStream(stdoutPath, { flags: "a", mode: 0o600 });
  const stderrStream = createWriteStream(stderrPath, { flags: "a", mode: 0o600 });

  const proc = spawn(CODEX_BINARY, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: mcpHome ? { ...buildCodexEnv(), CODEX_HOME: mcpHome } : buildCodexEnv(), detached: process.platform !== "win32" });
  if (wl && proc.pid) wl.attachChildPid(proc.pid);
  updateRunMeta(workerRunDir, { codexPid: proc.pid });

  return new Promise<WorkerCodexResult>((resolve) => {
    let sid = ""; let out = ""; let outT = false; let err = ""; let errT = false; let buf = "";
    let cancelReq = false; let timeoutReq = false; let timeoutKind: "wall" | "idle" | null = null; let settled = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const tu: TokenUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };
    const ev: EventSummary = { counts: {}, file_changes: [], commands: [], errors: [] };
    const outsideFileChanges: string[] = [];
    const seenCmdIds = new Set<string>();
    let lastStartedCmd: string | null = null;
    const sod = new StringDecoder("utf8"); const sed = new StringDecoder("utf8");

    function scheduleHardKill() { if (hardKillTimer) return; hardKillTimer = setTimeout(() => { killTree(proc, "SIGKILL"); }, 5000); hardKillTimer.unref?.(); }
    function clearHardKill() { if (hardKillTimer) { clearTimeout(hardKillTimer); hardKillTimer = undefined; } }

    // No-response detection: if Codex emits zero JSONL events for 30s, likely network issue
    const NO_RESPONSE_THRESHOLD_MS = 30_000;
    const MAX_JSONL_LINE_CHARS = 2 * 1024 * 1024;
    let noResponseTimer: ReturnType<typeof setTimeout> | undefined;
    let noResponseFired = false;
    let jsonlEventCount = 0;
    let jsonlLineOverflow = false;
    let jsonlOverflowCount = 0;

    function startNoResponseTimer() {
      noResponseTimer = setTimeout(() => {
        if (jsonlEventCount === 0 && !settled && !noResponseFired) {
          noResponseFired = true;
          updateProgress(workerRunDir, { status: "running", message: "No JSONL events from Codex after 30s. Possible network/API issue — check VPN/proxy.", elapsedMs: Date.now() - t0 });
        }
      }, NO_RESPONSE_THRESHOLD_MS);
      noResponseTimer.unref();
    }
    startNoResponseTimer();

    // Activity-driven idle watchdog: terminates genuinely stuck runs without killing healthy long reasoning turns
    let lastEventAt = Date.now();
    let stallWarned = false;
    function resetIdleTimer() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
      if (idleTimeout === null || settled) return;
      idleTimer = setTimeout(() => {
        if (settled) return;
        timeoutReq = true;
        timeoutKind = "idle";
        onP(`Idle timeout after ${idleTimeout}s without Codex activity`, false);
        killTree(proc, "SIGTERM");
        scheduleHardKill();
      }, idleTimeout * 1000);
    }
    resetIdleTimer();

    // Optional explicit wall-clock cap (only when caller explicitly specifies timeout > 0)
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

    // Stall notice: if no new JSONL events for 5 minutes mid-run, flag as stale
    const STALL_THRESHOLD_MS = 5 * 60 * 1000;
    const stallTimer = setInterval(() => {
      if (settled || jsonlEventCount === 0) return;
      const gap = Date.now() - lastEventAt;
      if (gap >= STALL_THRESHOLD_MS && !stallWarned) {
        stallWarned = true;
        onP(`No new events for ${Math.round(gap / 60000)}min. Codex may be stuck.`, false);
      }
    }, 30_000);
    stallTimer.unref();

    function markJsonlActivity() {
      lastEventAt = Date.now();
      stallWarned = false;
      if (noResponseTimer && !noResponseFired) { clearTimeout(noResponseTimer); noResponseTimer = undefined; }
      resetIdleTimer();
    }

    function onP(m: string, isRealActivity = true) {
      if (isRealActivity) markJsonlActivity();
      updateProgress(workerRunDir, {
        status: cancelReq ? "cancelling" : "running",
        message: sanitize(m),
        sessionId: sid || undefined,
        elapsedMs: Date.now() - t0,
        ...(isRealActivity ? { lastActivityAt: new Date().toISOString() } : {}),
      });
    }

    // Cancel protocol: poll cancel.requested file
    const cancelTimer = setInterval(() => {
      if (!cancelReq && isCancelRequested(workerRunDir)) {
        cancelReq = true;
        onP("Cancellation requested", false);
        killTree(proc, "SIGTERM");
        scheduleHardKill();
      }
    }, 500);
    cancelTimer.unref();

    function wasCancelled(): boolean { return cancelReq || isCancelRequested(workerRunDir); }

    function fin(s: RunStatus, ec: number | null, sg: NodeJS.Signals | null) {
      if (settled) return; settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(cancelTimer); clearInterval(stallTimer); clearHardKill();
      if (noResponseTimer) clearTimeout(noResponseTimer);
      stdoutStream.end(); stderrStream.end();
      resolve({
        sessionId: sid, status: wasCancelled() ? "cancelled" : s, exitCode: ec, signal: sg,
        output: out.trim(), outputTruncated: outT, stderr: err.trim(), stderrTruncated: errT,
        tokenUsage: tu, events: ev, durationMs: Date.now() - t0, jsonlOverflowCount,
        timeoutKind, outsideFileChanges,
      });
    }
    function ao(t: string) { const r = appendCap(out, t, 160_000); out = r.text; if (r.truncated) outT = true; }
    function ae(t: string) { const r = appendCap(err, t, 80_000); err = r.text; if (r.truncated) errT = true; }

    function updateUsage(e: any) {
      const u = e.usage || e.item?.usage;
      if (!u) return;
      tu.input = u.input_tokens ?? tu.input;
      tu.output = u.output_tokens ?? tu.output;
      tu.cached = u.cached_input_tokens ?? tu.cached;
      tu.reasoning = u.reasoning_output_tokens ?? tu.reasoning;
    }

    function pl(line: string) {
      let e: any; try { e = JSON.parse(line); } catch { ao(line + "\n"); return; }
      jsonlEventCount++;
      markJsonlActivity();
      const tp = e.type || "unknown"; ev.counts[tp] = (ev.counts[tp] || 0) + 1;
      updateUsage(e);
      if (tp === "thread.started") { sid = e.thread_id || ""; onP(`Session started: ${sid}`, true); }
      else if (tp === "error" || tp === "turn.failed") { const m = e.message || e.error?.message || JSON.stringify(e); pushCap(ev.errors, String(m).slice(0, 1000), 50); onP(`Error: ${m}`, true); }
      else if (tp === "turn.completed") { onP(`Done (${tu.input} in → ${tu.output} out, ${tu.cached} cached)`, true); }
      else if (e.item) {
        const it = e.item;
        if (tp === "item.completed" && it.type === "agent_message") { ao((it.text || "") + "\n"); onP(it.text || "", true); }
        else if (it.type === "file_change") {
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
        }
        else if (it.type === "command_execution" || it.type === "shell_command" || it.type === "tool_call") {
          const cmd = it.command || it.name || it.tool || "";
          if (cmd) {
            const cl = sanitize(Array.isArray(cmd) ? cmd.join(" ") : String(cmd));
            const itemId = typeof it.id === "string" && it.id ? it.id : null;
            if (tp === "item.started") {
              if (itemId) seenCmdIds.add(itemId);
              lastStartedCmd = cl;
              pushCap(ev.commands, cl, 100);
              onP(`Running: ${cl}`, true);
            } else if (tp === "item.completed") {
              const alreadySeen = (itemId !== null && seenCmdIds.has(itemId)) || (itemId === null && lastStartedCmd === cl);
              if (lastStartedCmd === cl) lastStartedCmd = null;
              if (!alreadySeen) {
                pushCap(ev.commands, cl, 100);
                onP(`Running: ${cl}`, true);
              } else if (typeof it.exit_code === "number" && it.exit_code !== 0) {
                onP(`Command exited ${it.exit_code}: ${cl}`, true);
              } else {
                touchActivity(workerRunDir, Date.now() - t0);
              }
            }
          }
        } else {
          touchActivity(workerRunDir, Date.now() - t0);
        }
      } else {
        touchActivity(workerRunDir, Date.now() - t0);
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

    proc.stdin?.on("error", () => {}); proc.stdin?.end(stdin);

    // Backpressure-aware stdout/stderr handling.
    // Stderr goes to codex.stderr.log and review.stderr only — never pollutes progress.json or resets idle liveness.
    proc.stdout?.on("data", (c: Buffer) => {
      if (!stdoutStream.write(c)) { proc.stdout?.pause(); stdoutStream.once("drain", () => proc.stdout?.resume()); }
      feed(sod.write(c));
    });
    proc.stdout?.on("end", () => { const r = sod.end(); if (r) feed(r); });
    proc.stderr?.on("data", (c: Buffer) => {
      if (!stderrStream.write(c)) { proc.stderr?.pause(); stderrStream.once("drain", () => proc.stderr?.resume()); }
      ae(sed.write(c));
    });
    proc.stderr?.on("end", () => { const r = sed.end(); if (r) ae(r); });
    proc.on("error", (e) => { pushCap(ev.errors, e.message, 50); fin("failed", null, null); });
    proc.on("close", (code, sig) => { if (jsonlLineOverflow) omitOverflowedJsonlLine(); else if (buf.trim()) pl(buf); fin(timeoutReq ? "timeout" : code === 0 && ev.errors.length === 0 ? "completed" : "failed", code, sig); });
  });
}

main().catch((e) => {
  const message = e?.message || String(e);
  try {
    const meta = readRunMeta(runDir);
    updateProgress(runDir, { status: "failed", message, error: message });
    writeReviewPacket(runDir, {
      run_id: meta?.runId, async: false, status: "failed",
      status_detail: "worker_failed_before_review", cwd: meta?.cwd,
      git_root: meta?.gitRoot || undefined, error: message,
      warnings: ["Worker failed before review packet was finalized. Evidence may be incomplete."],
    });
  } catch {}
  process.stderr.write(`worker fatal: ${message}\n`);
  process.exit(1);
});
