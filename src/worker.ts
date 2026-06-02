#!/usr/bin/env npx tsx
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { writeFileSync, openSync, closeSync, createWriteStream } from "fs";
import path from "path";
import type { RunMeta, RunStatus, TokenUsage, EventSummary, GitDiffResult, NoGitResult, TreeSnapshot, WriteLock } from "./types.js";
import {
  CODEX_BINARY, buildCodexEnv, normalizeCwd, resolveExecContext,
  acquireWriteLock, assertSnapshotSafe, snapshotWorktreeTree, cleanupSnapshots,
  snapshotFsSentinel, diffFsSentinel, hasTruncatedSensitiveFp, getWorktreeStatus,
  collectDiff, readCapped, checkJsonlHealth, sanitize, killTree,
  pushCap, pushUniqCap, appendCap,
} from "./evidence.js";
import { readRunMeta, updateRunMeta, updateProgress, writeReviewPacket, updateProjectPointer, updateSessionPointer, isCancelRequested } from "./progress.js";

// Harden: restrict file creation permissions
process.umask(0o077);

const runDir = process.argv[2];
if (!runDir) { process.stderr.write("worker: runDir argument required\n"); process.exit(1); }

async function main() {
  const meta = readRunMeta(runDir);
  if (!meta) { process.stderr.write(`worker: run.json not found in ${runDir}\n`); process.exit(1); }

  updateRunMeta(runDir, { workerPid: process.pid });
  updateProgress(runDir, { status: "starting", message: "Worker started" });

  const { runId, cwd: rawCwd, sandbox, task, model, timeout, maxDiffChars, allowNonGit, allowLargeUntracked, resumeSessionId } = meta;
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

    updateProgress(runDir, { status: "running", message: "Starting Codex" });

    const fmp = path.join(runDir, "final-message.md");
    ensurePrivateFile(fmp);
    const ca = buildCodexArgs(runCwd, sandbox, model, fmp, gitRepo, allowNonGit, resumeSessionId);

    const result = await runCodexWorker(runId, ca, runCwd, timeout, task, runDir, wl);

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
    if (packetStatus === "failed") {
      const combined = (result.stderr + " " + result.events.errors.join(" ")).toLowerCase();
      if (NETWORK_MARKERS.some((m) => combined.includes(m.toLowerCase()))) {
        failureHint = "network";
        w.push("Failure appears to be network-related. Check VPN/proxy connectivity before retrying.");
      } else if (!result.sessionId && Object.values(result.events.counts).reduce((a, b) => a + b, 0) === 0) {
        failureHint = "no_response";
        w.push("Codex produced no events. Possible causes: network unreachable, API key invalid, or Codex CLI not functional.");
      }
    }

    const packet: Record<string, unknown> = {
      run_id: runId,
      async: false,
      session_id: result.sessionId || undefined,
      session_name: meta.sessionName,
      status: packetStatus,
      status_detail: packetStatus === "timeout" ? (partialChanges ? "timeout_with_changes" : "timeout_clean") : packetStatus,
      failure_hint: failureHint,
      partial_changes: partialChanges,
      cwd: runCwd,
      git_root: gitRepo ? gitRoot : undefined,
      duration_ms: result.durationMs,
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

function buildCodexArgs(runCwd: string, sandbox: string, model: string | undefined, fmp: string, gitRepo: boolean, allowNonGit: boolean, resumeSessionId?: string): string[] {
  if (resumeSessionId) {
    const ca = ["exec", "resume", resumeSessionId, "--json", "-c", 'approval_policy="never"', "-o", fmp];
    if (!gitRepo && allowNonGit) ca.push("--skip-git-repo-check");
    if (model) ca.push("-m", model);
    ca.push("-");
    return ca;
  }
  const ca = ["exec", "--json", "--color", "never", "-C", runCwd, "-s", sandbox, "-c", 'approval_policy="never"', "-o", fmp];
  if (!gitRepo && allowNonGit) ca.push("--skip-git-repo-check");
  if (model) ca.push("-m", model);
  ca.push("-");
  return ca;
}

interface WorkerCodexResult {
  sessionId: string; status: RunStatus; exitCode: number | null; signal: NodeJS.Signals | null;
  output: string; outputTruncated: boolean; stderr: string; stderrTruncated: boolean;
  tokenUsage: TokenUsage; events: EventSummary; durationMs: number; jsonlOverflowCount: number;
}

function runCodexWorker(runId: string, args: string[], cwd: string, timeout: number, stdin: string, workerRunDir: string, wl?: WriteLock): Promise<WorkerCodexResult> {
  const t0 = Date.now();
  const stdoutPath = path.join(workerRunDir, "codex.stdout.jsonl");
  const stderrPath = path.join(workerRunDir, "codex.stderr.log");
  const stdoutStream = createWriteStream(stdoutPath, { flags: "a", mode: 0o600 });
  const stderrStream = createWriteStream(stderrPath, { flags: "a", mode: 0o600 });

  const proc = spawn(CODEX_BINARY, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: buildCodexEnv(), detached: process.platform !== "win32" });
  if (wl && proc.pid) wl.attachChildPid(proc.pid);
  updateRunMeta(workerRunDir, { codexPid: proc.pid });

  return new Promise<WorkerCodexResult>((resolve) => {
    let sid = ""; let out = ""; let outT = false; let err = ""; let errT = false; let buf = "";
    let cancelReq = false; let timeoutReq = false; let settled = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const tu: TokenUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };
    const ev: EventSummary = { counts: {}, file_changes: [], commands: [], errors: [] };
    const sod = new StringDecoder("utf8"); const sed = new StringDecoder("utf8");
    let progressSeq = 0;

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

    // Stall detection: if no new JSONL events for 5 minutes mid-run, flag as stale
    const STALL_THRESHOLD_MS = 5 * 60 * 1000;
    let lastEventAt = Date.now();
    let stallWarned = false;
    const stallTimer = setInterval(() => {
      if (settled || jsonlEventCount === 0) return; // skip if not started yet or already done
      const gap = Date.now() - lastEventAt;
      if (gap >= STALL_THRESHOLD_MS && !stallWarned) {
        stallWarned = true;
        updateProgress(workerRunDir, { status: "running", message: `No new events for ${Math.round(gap / 60000)}min. Codex may be stuck.`, sessionId: sid || undefined, elapsedMs: Date.now() - t0 });
      }
    }, 30_000);
    stallTimer.unref();

    function isImportantProgress(m: string): boolean {
      return m.startsWith("Session started") || m.startsWith("Error") || m.startsWith("Done")
        || m.startsWith("Running:") || m.startsWith("Editing:") || m.startsWith("Saved:")
        || m.startsWith("Timeout") || m.startsWith("Cancellation");
    }

    function onP(m: string) {
      progressSeq++;
      lastEventAt = Date.now();
      stallWarned = false;
      if (noResponseTimer && !noResponseFired) { clearTimeout(noResponseTimer); noResponseTimer = undefined; }
      if (progressSeq % 3 === 0 || isImportantProgress(m)) {
        updateProgress(workerRunDir, { status: cancelReq ? "cancelling" : "running", message: sanitize(m), sessionId: sid || undefined, elapsedMs: Date.now() - t0, lastActivityAt: new Date().toISOString() });
      }
    }

    // Cancel protocol: poll cancel.requested file
    const cancelTimer = setInterval(() => {
      if (!cancelReq && isCancelRequested(workerRunDir)) {
        cancelReq = true;
        onP("Cancellation requested");
        killTree(proc, "SIGTERM");
        scheduleHardKill();
      }
    }, 500);
    cancelTimer.unref();

    function wasCancelled(): boolean { return cancelReq || isCancelRequested(workerRunDir); }

    function fin(s: RunStatus, ec: number | null, sg: NodeJS.Signals | null) {
      if (settled) return; settled = true; clearTimeout(tt); clearInterval(cancelTimer); clearInterval(stallTimer); clearHardKill();
      if (noResponseTimer) clearTimeout(noResponseTimer);
      stdoutStream.end(); stderrStream.end();
      resolve({ sessionId: sid, status: wasCancelled() ? "cancelled" : s, exitCode: ec, signal: sg, output: out.trim(), outputTruncated: outT, stderr: err.trim(), stderrTruncated: errT, tokenUsage: tu, events: ev, durationMs: Date.now() - t0, jsonlOverflowCount });
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
      const tp = e.type || "unknown"; ev.counts[tp] = (ev.counts[tp] || 0) + 1;
      updateUsage(e);
      if (tp === "thread.started") { sid = e.thread_id || ""; onP(`Session started: ${sid}`); }
      else if (tp === "error" || tp === "turn.failed") { const m = e.message || e.error?.message || JSON.stringify(e); pushCap(ev.errors, String(m).slice(0, 1000), 50); onP(`Error: ${m}`); }
      else if (tp === "turn.completed") { onP(`Done (${tu.input} in → ${tu.output} out, ${tu.cached} cached)`); }
      else if (e.item) {
        const it = e.item;
        if (tp === "item.completed" && it.type === "agent_message") { ao((it.text || "") + "\n"); onP(it.text || ""); }
        else if (it.type === "file_change") { const ps = (it.changes || []).map((c: any) => c.path || "").filter(Boolean).map((p: string) => path.isAbsolute(p) ? path.relative(cwd, p) : p); for (const p of ps) pushUniqCap(ev.file_changes, p, 200); if (ps.length) onP(`${tp === "item.completed" ? "Saved" : "Editing"}: ${ps.slice(0, 5).join(", ")}`); }
        else if (it.type === "command_execution" || it.type === "shell_command" || it.type === "tool_call") { const cmd = it.command || it.name || it.tool || ""; if (cmd) { const cl = sanitize(Array.isArray(cmd) ? cmd.join(" ") : String(cmd)); pushCap(ev.commands, cl, 100); onP(`Running: ${cl}`); } }
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

    const tt = setTimeout(() => { timeoutReq = true; onP(`Timeout after ${timeout}s`); killTree(proc, "SIGTERM"); scheduleHardKill(); }, timeout * 1000);

    proc.stdin?.on("error", () => {}); proc.stdin?.end(stdin);

    // Backpressure-aware stdout/stderr handling
    proc.stdout?.on("data", (c: Buffer) => {
      if (!stdoutStream.write(c)) { proc.stdout?.pause(); stdoutStream.once("drain", () => proc.stdout?.resume()); }
      feed(sod.write(c));
    });
    proc.stdout?.on("end", () => { const r = sod.end(); if (r) feed(r); });
    proc.stderr?.on("data", (c: Buffer) => {
      if (!stderrStream.write(c)) { proc.stderr?.pause(); stderrStream.once("drain", () => proc.stderr?.resume()); }
      const t = sed.write(c); ae(t); if (t.trim()) onP(`[stderr] ${sanitize(t.trim())}`);
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
