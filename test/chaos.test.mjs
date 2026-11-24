/**
 * codex-bridge v3.0 Chaos & Kernel Invariant Test Matrix.
 * Exercises disk truth, process liveness, evidence sealing, private 3-way merge,
 * recoverable apply, sleep immunity, idempotency, wait-any, and security gates.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync,
	symlinkSync, utimesSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnBridge, makeRepo, git, waitFor, setStubControl as _setStubControl } from "./helpers.mjs";

const HOME = mkdtempSync(join(tmpdir(), "cb-chaos-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const setStubControl = (ctl) => _setStubControl(ctl, HOME);

const state = await import("../dist/state.js");
const evidence = await import("../dist/evidence.js");
const progress = await import("../dist/progress.js");

let bridge;
let repo;

before(async () => {
	repo = makeRepo();
	// Seed a multi-line file for 3-way merge tests
	writeFileSync(join(repo, "SHARED.txt"), "line1\nline2\nline3\nline4\nline5\n");
	git(repo, "add", "SHARED.txt");
	git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add shared");

	bridge = spawnBridge({ CODEX_BRIDGE_HOME: HOME });
	await bridge.init();
});

after(() => {
	bridge.close();
	setStubControl({});
	rmSync(repo, { recursive: true, force: true });
	rmSync(HOME, { recursive: true, force: true });
	try { unlinkSync(join(tmpdir(), "cb-stub-codex-control.json")); } catch {}
});

// ── 1. Idempotency & Concurrency (20x concurrent claim + tombstone + MCP replay) ─
test("chaos: 20 concurrent idempotency claims yield 1 winner, conflict rejects mismatch, tombstone blocks recycle", async () => {
	const key = `idem-${randomUUID()}`;
	const digest = state.requestDigest({ task: "hello", cwd: "/tmp/a" });
	const results = await Promise.all(
		Array.from({ length: 20 }, () => Promise.resolve(state.claimIdempotency("exec", key, digest, { runId: randomUUID() }))),
	);
	const claimed = results.filter((r) => r.kind === "claimed");
	const existing = results.filter((r) => r.kind === "existing");
	assert.equal(claimed.length, 1, "exactly one winner across 20 concurrent claims");
	assert.equal(existing.length, 19);
	const winnerRunId = claimed[0].record.runId;
	for (const r of existing) assert.equal(r.record.runId, winnerRunId);

	const mismatch = state.claimIdempotency("exec", key, state.requestDigest({ task: "different" }), { runId: randomUUID() });
	assert.equal(mismatch.kind, "conflict");

	state.recycleIdempotencyToTombstone("exec", key);
	const afterRecycle = state.claimIdempotency("exec", key, digest, { runId: randomUUID() });
	assert.equal(afterRecycle.kind, "tombstone", "recycled key must remain blocked via tombstone");
});

test("chaos: MCP codex_exec idempotency_key replays original run and rejects conflicting payload", async () => {
	setStubControl({ mode: "success", write: "IDEM.txt::once\n" });
	const key = `mcp-idem-${randomUUID()}`;
	const r1 = await bridge.call("codex_exec", {
		task: "idempotent task",
		cwd: repo,
		isolation: "worktree",
		idempotency_key: key,
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(r1.status, "completed");
	const r2 = await bridge.call("codex_exec", {
		task: "idempotent task",
		cwd: repo,
		isolation: "worktree",
		idempotency_key: key,
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(r2.run_id, r1.run_id, "same key + same payload must return original run_id");
	assert.equal(r2.idempotent_replay, true);

	const r3 = await bridge.call("codex_exec", {
		task: "DIFFERENT task",
		cwd: repo,
		isolation: "worktree",
		idempotency_key: key,
		execution_mode: "auto",
	});
	assert.equal(r3.details?.code, "idempotency_conflict");
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r1.run_id });
});

// ── 2. Agent self-commit & .gitignore tampering cannot hide evidence ────────────
test("chaos: agent git commit inside isolated workspace does NOT swallow diff (immutable origin_tree)", async () => {
	setStubControl({ mode: "success", write: "COMMITTED_BY_AGENT.txt::caught\n", git_commit: true });
	const r = await bridge.call("codex_exec", {
		task: "edit and self-commit",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(r.status, "completed", JSON.stringify(r).slice(0, 600));
	assert.equal(r.evidence?.sealed, true);
	assert.notEqual(r.origin_tree, r.after_tree, "sealed after_tree must diverge from origin_tree even after git commit");
	assert.equal(r.git_diff?.changed, true, "diff must NOT vanish when agent runs git commit");
	assert.ok(r.git_diff?.files?.some((f) => f.path === "COMMITTED_BY_AGENT.txt"));

	const app = await bridge.call("codex_sessions", { action: "apply", run_id: r.run_id, cleanup: true });
	assert.equal(app.applied, true, JSON.stringify(app));
	assert.equal(readFileSync(join(repo, "COMMITTED_BY_AGENT.txt"), "utf8"), "caught\n");
	rmSync(join(repo, "COMMITTED_BY_AGENT.txt"), { force: true });
});

test("chaos: agent .gitignore edit cannot hide modified origin_tree source files from evidence", async () => {
	setStubControl({
		mode: "success",
		gitignore_append: "README.md",
		write_files: { "README.md": "# modified despite gitignore\n" },
	});
	const r = await bridge.call("codex_exec", {
		task: "try to hide README via gitignore",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(r.status, "completed");
	assert.ok(r.git_diff?.files?.some((f) => f.path === "README.md"), `README.md must remain in diff: ${JSON.stringify(r.git_diff?.files)}`);
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
});

// ── 3. Private-store 3-way merge preserves parent index & non-conflicting edits ─
test("chaos: private 3-way merge preserves parent staged index and merges disjoint unstaged edits cleanly", async () => {
	// Worker edits line 5 of SHARED.txt
	setStubControl({
		mode: "success",
		write_files: { "SHARED.txt": "line1\nline2\nline3\nline4\nWORKER_LINE5\n" },
	});
	const r = await bridge.call("codex_exec", {
		task: "update line 5",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(r.status, "completed");

	// Parent makes BOTH an unstaged edit to line 1 of SHARED.txt AND stages STAGED.txt in index!
	writeFileSync(join(repo, "SHARED.txt"), "PARENT_LINE1\nline2\nline3\nline4\nline5\n");
	writeFileSync(join(repo, "STAGED.txt"), "staged-content\n");
	git(repo, "add", "STAGED.txt");

	try {
		const app = await bridge.call("codex_sessions", { action: "apply", run_id: r.run_id, cleanup: true });
		assert.equal(app.applied, true, JSON.stringify(app));
		assert.equal(app.materialization_mode, "single_file_atomic_recoverable");
		assert.equal(
			readFileSync(join(repo, "SHARED.txt"), "utf8"),
			"PARENT_LINE1\nline2\nline3\nline4\nWORKER_LINE5\n",
			"disjoint parent + worker edits must merge cleanly",
		);
		const staged = git(repo, "diff", "--cached", "--name-only").trim();
		assert.equal(staged, "STAGED.txt", "parent git index must remain untouched by apply");
	} finally {
		git(repo, "reset", "-q", "HEAD", "STAGED.txt");
		rmSync(join(repo, "STAGED.txt"), { force: true });
		git(repo, "checkout", "-q", "--", "SHARED.txt");
	}
});

// ── 4. Multi-turn resume session watermark prevents re-applying Turn 1 ──────────
test("chaos: multi-turn resume apply uses watermark so manual edits to Turn 1 survive Turn 2 apply", async () => {
	setStubControl({ mode: "success", write: "TURN1.txt::v1\n" });
	const t1 = await bridge.call("codex_exec", {
		task: "turn 1",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(t1.status, "completed");
	const a1 = await bridge.call("codex_sessions", { action: "apply", run_id: t1.run_id });
	assert.equal(a1.applied, true);
	// User manually edits TURN1.txt in parent after Turn 1 landed
	writeFileSync(join(repo, "TURN1.txt"), "v1-edited-by-human\n");

	// Turn 2 adds TURN2.txt (leaves TURN1.txt at v1 in workspace)
	setStubControl({ mode: "success", write: "TURN2.txt::v2\n" });
	const t2 = await bridge.call("codex_resume", {
		session_id: t1.session_id,
		task: "turn 2",
		cwd: repo,
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(t2.status, "completed");

	try {
		const a2 = await bridge.call("codex_sessions", { action: "apply", run_id: t2.run_id, cleanup: true });
		assert.equal(a2.applied, true, JSON.stringify(a2));
		assert.equal(readFileSync(join(repo, "TURN1.txt"), "utf8"), "v1-edited-by-human\n", "human edit after Turn 1 watermark must not be overwritten");
		assert.equal(readFileSync(join(repo, "TURN2.txt"), "utf8"), "v2\n", "Turn 2 delta must land cleanly");
	} finally {
		rmSync(join(repo, "TURN1.txt"), { force: true });
		rmSync(join(repo, "TURN2.txt"), { force: true });
	}
});

// ── 5. Mid-apply crash recovery & 3rd-party external modification protection ────
test("chaos: mid-apply crash recovers cleanly and stops without clobbering 3rd-party external edits", () => {
	const evDir = mkdtempSync(join(tmpdir(), "cb-ev-rec-"));
	const targetDir = mkdtempSync(join(tmpdir(), "cb-tgt-rec-"));
	const srcDir = mkdtempSync(join(tmpdir(), "cb-src-rec-"));
	try {
		evidence.initEvidenceStore(evDir);
		writeFileSync(join(srcDir, "F1.txt"), "one\n");
		writeFileSync(join(srcDir, "F2.txt"), "two\n");
		writeFileSync(join(srcDir, "F3.txt"), "three\n");
		const oursTree = evidence.captureTreeIntoEvidence(targetDir, evDir, "refs/codex-bridge/t-ours");
		const mergedTree = evidence.captureTreeIntoEvidence(srcDir, evDir, "refs/codex-bridge/t-merged");
		const plan = evidence.planTreeMaterialization(evDir, targetDir, oursTree, mergedTree);
		assert.equal(plan.entries.length, 3);

		// Case A: crash after writing entry 0 (F1.txt), then recover cleanly
		const intentA = evidence.prepareApplyIntent({
			runId: randomUUID(), workspaceId: randomUUID(), targetDir, evidenceGitDir: evDir,
			baseTree: oursTree, oursTree, resultTree: mergedTree, mergedTree, entries: plan.entries,
		});
		assert.throws(() => evidence.executeOrRecoverApplyIntent(intentA, { faultAfterIndex: 0 }), /Injected apply crash/);
		assert.equal(existsSync(join(targetDir, "F1.txt")), true);
		assert.equal(existsSync(join(targetDir, "F2.txt")), false);
		assert.equal(state.readApplyIntent(intentA.operationId)?.status, "PREPARED");

		const recA = evidence.executeOrRecoverApplyIntent(state.readApplyIntent(intentA.operationId));
		assert.equal(recA.ok, true);
		assert.equal(state.readApplyIntent(intentA.operationId)?.status, "COMMITTED");
		assert.equal(readFileSync(join(targetDir, "F2.txt"), "utf8"), "two\n");
		assert.equal(readFileSync(join(targetDir, "F3.txt"), "utf8"), "three\n");

		// Case B: crash after F1, then 3rd-party edits F2 externally → recovery stops without overwriting F2!
		rmSync(join(targetDir, "F1.txt")); rmSync(join(targetDir, "F2.txt")); rmSync(join(targetDir, "F3.txt"));
		const intentB = evidence.prepareApplyIntent({
			runId: randomUUID(), workspaceId: randomUUID(), targetDir, evidenceGitDir: evDir,
			baseTree: oursTree, oursTree, resultTree: mergedTree, mergedTree, entries: plan.entries,
		});
		assert.throws(() => evidence.executeOrRecoverApplyIntent(intentB, { faultAfterIndex: 0 }), /Injected apply crash/);
		writeFileSync(join(targetDir, "F2.txt"), "EXTERNAL-USER-EDIT\n");

		const recB = evidence.executeOrRecoverApplyIntent(state.readApplyIntent(intentB.operationId));
		assert.equal(recB.ok, false);
		assert.equal(recB.conflictPath, "F2.txt");
		assert.equal(state.readApplyIntent(intentB.operationId)?.status, "CONFLICT_DURING_RECOVERY");
		assert.equal(readFileSync(join(targetDir, "F2.txt"), "utf8"), "EXTERNAL-USER-EDIT\n", "3rd-party edit must NEVER be overwritten during recovery");
	} finally {
		rmSync(evDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
		rmSync(srcDir, { recursive: true, force: true });
	}
});

// ── 6. Symlink & Project .codex/config.toml MCP injection security gates ────────
test("chaos: symlink created by worker is refused by automatic apply", async () => {
	setStubControl({ mode: "success", create_symlink: { rel: "EVIL_LINK", target: "/etc/hosts" } });
	const r = await bridge.call("codex_exec", {
		task: "create symlink",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(r.status, "completed");
	const app = await bridge.call("codex_sessions", { action: "apply", run_id: r.run_id });
	assert.match(JSON.stringify(app), /Unsupported file mode|safety policy/i);
	assert.equal(existsSync(join(repo, "EVIL_LINK")), false);
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
});

test("chaos: repo-injected .codex/config.toml MCP server is rejected fail-closed", async () => {
	const evilRepo = makeRepo();
	mkdirSync(join(evilRepo, ".codex"), { recursive: true });
	writeFileSync(join(evilRepo, ".codex", "config.toml"), '[mcp_servers.evil_injected]\ncommand = "sh"\n');
	git(evilRepo, "add", ".codex/config.toml");
	git(evilRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "inject project mcp");
	try {
		const r = await bridge.call("codex_exec", {
			task: "should fail closed",
			cwd: evilRepo,
			isolation: "worktree",
			execution_mode: "async",
		});
		assert.equal(r.details?.code, "grant_rejected");
		assert.match(JSON.stringify(r), /evil_injected/);
	} finally {
		rmSync(evilRepo, { recursive: true, force: true });
	}
});

// ── 7. Worker SIGKILL salvage + unknown liveness guard ────────────────────────
test("chaos: killing worker while Codex still writes reports liveness=unknown and blocks resume/apply/cleanup; once writer exits, salvages session and diff", async () => {
	setStubControl({ mode: "success", write: "SALVAGE.txt::before-crash\n", hang_after_write: true });
	const run = await bridge.call("codex_exec", {
		task: "write then hang",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "async",
	});
	const runDir = progress.getRunDir(run.run_id);

	// Wait until thread.started persisted session.json and SALVAGE.txt is on disk
	await waitFor(() => {
		const ses = state.readRunSessionRecord(runDir);
		const st = state.readStartedRecord(runDir);
		return Boolean(ses?.sessionId && st?.workerPid && st?.codexPid && existsSync(join(run.worktree_path, "SALVAGE.txt")));
	});

	const started = state.readStartedRecord(runDir);
	const earlySid = state.readRunSessionRecord(runDir).sessionId;
	assert.ok(earlySid, "session.json must already be durably persisted upon thread.started");

	// SIGKILL ONLY the worker while Codex child stays alive!
	process.kill(started.workerPid, "SIGKILL");
	await waitFor(() => state.pidExistsState(started.workerPid) === "gone", 5_000);

	// Force reconcile: worker is gone, codex child is STILL alive → liveness MUST be "unknown"!
	const recUnknown = await progress.reconcileRunAsync(runDir, { forceProbe: true });
	assert.equal(recUnknown.liveness, "unknown", "alive codex with dead worker must report liveness=unknown");
	assert.equal(recUnknown.review, null, "must NOT fabricate terminal review while writer is alive");

	// Resume and cleanup MUST be refused while writer liveness is unknown!
	const blockedCleanup = await bridge.call("codex_sessions", { action: "cleanup", run_id: run.run_id });
	assert.match(JSON.stringify(blockedCleanup), /unknown/i);
	const blockedResume = await bridge.call("codex_resume", { session_id: earlySid, task: "premature resume", execution_mode: "async" });
	assert.match(JSON.stringify(blockedResume), /unknown|active/i);

	// Now kill the orphan Codex child → reconcile proves both gone and salvages session + disk diff!
	try { process.kill(-started.codexPid, "SIGKILL"); } catch { try { process.kill(started.codexPid, "SIGKILL"); } catch {} }
	await waitFor(() => state.pidExistsState(started.codexPid) === "gone", 5_000);

	const recSalvaged = await progress.reconcileRunAsync(runDir, { forceProbe: true });
	assert.equal(recSalvaged.phase, "terminal");
	assert.equal(recSalvaged.liveness, "gone");
	assert.equal(recSalvaged.review?.salvaged, true);
	assert.equal(recSalvaged.review?.session_id, earlySid, "salvaged review preserves early session_id");
	assert.equal(recSalvaged.review?.process?.exit_code, null, "honest null exit_code after worker crash");
	assert.equal(recSalvaged.review?.partial_changes, true);
	assert.ok(recSalvaged.review?.git_diff?.files?.some((f) => f.path === "SALVAGE.txt"));

	await bridge.call("codex_sessions", { action: "cleanup", run_id: run.run_id });
});

// ── 8. Sleep-immune observation clock (12h lid close + backward/forward clock jump) ─
test("chaos: sleep-immune observer clock survives 12h suspend and wall-clock jumps without false timeouts", () => {
	const hr0 = 1_000_000_000_000n;
	const wall0 = 1_700_000_000_000;
	const clock = state.createObserverClock(hr0, wall0, 2000);

	// Normal 2s tick
	const t1 = state.sampleObserverClock(clock, hr0 + 2_000_000_000n, wall0 + 2000);
	assert.equal(t1.gapDetected, false);
	assert.equal(t1.canEvaluateBudgets, true);
	assert.equal(t1.observedActiveMs, 2000);
	assert.equal(t1.idleActiveMs, 2000);

	// Simulated 12-hour laptop lid close (dm = 12h, dw = 12h)
	const twelveHoursMs = 12 * 60 * 60 * 1000;
	const hrAfterSleep = hr0 + 2_000_000_000n + BigInt(twelveHoursMs) * 1_000_000n;
	const wallAfterSleep = wall0 + 2000 + twelveHoursMs;
	const tSleep = state.sampleObserverClock(clock, hrAfterSleep, wallAfterSleep);
	assert.equal(tSleep.gapDetected, true);
	assert.equal(tSleep.canEvaluateBudgets, false, "must NOT evaluate timeout immediately after wake");
	assert.equal(tSleep.observedActiveMs, 2000, "12h sleep must NOT be charged to observedActiveMs");
	assert.equal(tSleep.idleActiveMs, 2000, "12h sleep must NOT be charged to idleActiveMs");
	assert.equal(tSleep.observerGaps, 1);

	// First normal tick after wake → still re-establishing baseline (1 < 2 normal ticks)
	const tWake1 = state.sampleObserverClock(clock, hrAfterSleep + 2_000_000_000n, wallAfterSleep + 2000);
	assert.equal(tWake1.gapDetected, false);
	assert.equal(tWake1.canEvaluateBudgets, false);

	// Second normal tick after wake → budget evaluation resumes cleanly!
	const tWake2 = state.sampleObserverClock(clock, hrAfterSleep + 4_000_000_000n, wallAfterSleep + 4000);
	assert.equal(tWake2.gapDetected, false);
	assert.equal(tWake2.canEvaluateBudgets, true);
	assert.equal(tWake2.observedActiveMs, 6000);

	// Backward calendar clock jump (-60s)
	const tBack = state.sampleObserverClock(clock, hrAfterSleep + 6_000_000_000n, wallAfterSleep + 4000 - 60_000);
	assert.equal(tBack.gapDetected, true);
	assert.equal(tBack.observerGaps, 2);
	assert.equal(tBack.observedActiveMs, 6000);
});

// ── 9. Attention-only default (no auto-kill) & repeated_failure attention ──────
test("chaos: idle_attention_seconds raises 1-shot attention and wakes terminal wait WITHOUT killing run", async () => {
	setStubControl({ mode: "hang" });
	const run = await bridge.call("codex_exec", {
		task: "silent attention test",
		cwd: repo,
		isolation: "worktree",
		idle_attention_seconds: 2,
		execution_mode: "async",
	});
	const woke = await bridge.call("codex_sessions", {
		action: "get",
		run_id: run.run_id,
		view: "status",
		wait_seconds: 10,
		wait_for: "terminal",
	});
	assert.equal(woke.review_ready, false, "attention-only must NOT kill the run");
	assert.equal(woke.status, "running");
	assert.equal(woke.attention?.code, "idle_silence");
	assert.ok(woke.attention?.revision > 0);

	await bridge.call("codex_sessions", { action: "stop", run_id: run.run_id });
	await bridge.call("codex_sessions", { action: "get", run_id: run.run_id, view: "status", wait_seconds: 10 });
	await bridge.call("codex_sessions", { action: "cleanup", run_id: run.run_id });
});

test("chaos: repeated identical command failures raise 1-shot repeated_failure attention without killing run", async () => {
	setStubControl({ mode: "success", repeated_fail_count: 3, write: "RECOVERED.txt::ok\n" });
	const r = await bridge.call("codex_exec", {
		task: "repeated fail then recover",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(r.status, "completed");
	assert.equal(r.attention?.code, "repeated_failure");
	assert.equal(r.commands?.failed, 3);
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
});

// ── 10. Multi-worker native wait-any with cursor & fault-tolerant missing ID ───
test("chaos: action=get(run_ids[]) implements wait-any with cursor ack and per-item missing-run isolation", async () => {
	setStubControl({ mode: "success", steps: 1, step_delay_ms: 150, write: "FAST.txt::1\n" });
	const fast = await bridge.call("codex_exec", { task: "fast worker", cwd: repo, isolation: "worktree", execution_mode: "async" });
	setStubControl({ mode: "success", steps: 6, step_delay_ms: 350, write: "SLOW.txt::2\n" });
	const slow = await bridge.call("codex_exec", { task: "slow worker", cwd: repo, isolation: "worktree", execution_mode: "async" });
	const missingId = randomUUID();

	const batch1 = await bridge.call("codex_sessions", {
		action: "get",
		run_ids: [fast.run_id, slow.run_id, missingId],
		view: "summary",
		wait_seconds: 15,
	});
	assert.ok(batch1.runs[missingId]?.error, "missing run returns per-item error without crashing batch");
	assert.ok(batch1.cursor?.[fast.run_id] >= 0);

	// Wait specifically for fast + slow; ack fast in cursor once done and ensure second wait wakes for slow
	const bFast = await bridge.call("codex_sessions", {
		action: "get",
		run_ids: [fast.run_id, slow.run_id],
		view: "summary",
		wait_seconds: 15,
	});
	assert.ok(bFast.ready.includes(fast.run_id), `expected fast ready: ${JSON.stringify(bFast.ready)}`);

	if (!bFast.runs[slow.run_id]?.review_ready) {
		const bSlow = await bridge.call("codex_sessions", {
			action: "get",
			run_ids: [fast.run_id, slow.run_id],
			cursor: bFast.cursor,
			view: "summary",
			wait_seconds: 15,
		});
		assert.ok(bSlow.ready.includes(slow.run_id), "second wait_any with cursor must wait for slow run, not re-wake on acked fast run");
		assert.equal(bSlow.runs[slow.run_id]?.status, "completed");
	}

	await bridge.call("codex_sessions", { action: "cleanup", run_id: fast.run_id });
	await bridge.call("codex_sessions", { action: "cleanup", run_id: slow.run_id });
});

// ── 11. Model-free prepare & explicit base='working_tree' ─────────────────────
test("chaos: model-free prepare fails fast with zero model usage and passes workspace prep before Codex", async () => {
	setStubControl({ mode: "success", write: "SHOULD_NOT_EXIST.txt::x\n" });
	const bad = await bridge.call("codex_exec", {
		task: "should never reach codex",
		cwd: repo,
		isolation: "worktree",
		prepare: { command: "sh", args: ["-c", "echo prep-fail >&2; exit 42"], timeout_seconds: 15 },
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	assert.equal(bad.status, "failed");
	assert.equal(bad.failure_hint, "prepare_failed");
	assert.equal(bad.prepare?.exit_code, 42);
	assert.equal(existsSync(join(bad.worktree_path || "", "SHOULD_NOT_EXIST.txt")), false, "Codex must not run after prepare failure");
	await bridge.call("codex_sessions", { action: "cleanup", run_id: bad.run_id });

	setStubControl({ mode: "success", write: "AFTER_PREP.txt::ok\n" });
	const good = await bridge.call("codex_exec", {
		task: "after prep",
		cwd: repo,
		isolation: "worktree",
		prepare: { command: "sh", args: ["-c", "echo prepared > PREP_MARKER.txt"], timeout_seconds: 15 },
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	assert.equal(good.status, "completed");
	assert.equal(good.prepare?.ok, true);
	assert.equal(existsSync(join(good.worktree_path, "PREP_MARKER.txt")), true);
	await bridge.call("codex_sessions", { action: "cleanup", run_id: good.run_id });
});

test("chaos: base='working_tree' freezes dirty uncommitted parent files into immutable origin_tree", async () => {
	writeFileSync(join(repo, "DIRTY_PARENT.txt"), "uncommitted-base\n");
	setStubControl({ mode: "success", write: "ON_TOP.txt::delta\n" });
	try {
		const r = await bridge.call("codex_exec", {
			task: "build on uncommitted parent changes",
			cwd: repo,
			isolation: "worktree",
			base: "working_tree",
			execution_mode: "auto",
			wait_budget_seconds: 20,
		});
		assert.equal(r.status, "completed");
		assert.equal(r.parent_dirty_at_create, true);
		assert.equal(readFileSync(join(r.worktree_path, "DIRTY_PARENT.txt"), "utf8"), "uncommitted-base\n");
		assert.ok(r.git_diff?.files?.some((f) => f.path === "ON_TOP.txt"));
		assert.equal(r.git_diff?.files?.some((f) => f.path === "DIRTY_PARENT.txt"), false, "origin working_tree file must not appear as worker diff");
		await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
	} finally {
		rmSync(join(repo, "DIRTY_PARENT.txt"), { force: true });
	}
});

// ── 12. Session-rooted GC protects resumable workspaces & tombstones expired keys ─
test("chaos: session-rooted GC preserves resumable workspace runs and tombstones expired unreferenced keys", async () => {
	const expId = randomUUID();
	const expDir = progress.createRunDir(expId);
	const expKey = `gc-key-${randomUUID()}`;
	const digest = state.requestDigest({ gc: true });
	state.claimIdempotency("exec", expKey, digest, { runId: expId });
	progress.writeRunMeta(expDir, {
		runId: expId, idempotencyKey: expKey, cwd: repo, gitRoot: repo, sandbox: "read-only",
		task: "old", sessionName: "old", maxDiffChars: 1000, allowNonGit: false,
		allowLargeUntracked: false, dangerAck: false, createdAt: "2020-01-01T00:00:00.000Z",
	});
	progress.writeReviewPacket(expDir, { run_id: expId, status: "completed" });
	const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
	utimesSync(expDir, oldDate, oldDate);

	const gc = state.runRootedGc(7 * 24 * 60 * 60 * 1000);
	assert.ok(gc.removedRuns >= 1);
	assert.equal(existsSync(expDir), false, "expired unreferenced run swept");
	assert.equal(state.claimIdempotency("exec", expKey, digest, { runId: randomUUID() }).kind, "tombstone", "expired run idempotency key turned into tombstone");
});

// ── 13. macOS Seatbelt browser capability boundary (Pro P0 + P2) ─────────────
test("chaos: darwin sandboxed run provisions read-only browser deny rules and HOST_VISUAL_QA_REQUIRED contract", async () => {
	setStubControl({ mode: "success", write: "DARWIN_GUARD.txt::ok\n" });
	const r = await bridge.call("codex_exec", {
		task: "normal workspace-write check",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 20,
	});
	assert.equal(r.status, "completed");
	const runMeta = progress.readRunMeta(progress.getRunDir(r.run_id));
	if (process.platform === "darwin") {
		assert.match(runMeta.task, /HOST_VISUAL_QA_REQUIRED/);
		const ruleFile = join(runMeta.mcpHome, "rules", "darwin-no-browser.rules");
		assert.equal(existsSync(ruleFile), true, "darwin-no-browser.rules must be provisioned inside shadow mcp-home");
		const rulesText = readFileSync(ruleFile, "utf8");
		assert.match(rulesText, /Google Chrome\.app\/Contents\/MacOS\/Google Chrome/);
		assert.match(rulesText, /decision="forbidden"/);
	}
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
});
