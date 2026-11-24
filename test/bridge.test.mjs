/** Deterministic offline regression suite for codex-bridge via stub-codex. */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, unlinkSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBridge, makeRepo, git, waitFor, setStubControl } from "./helpers.mjs";

let bridge;
let bridgeHome;
let initResult;
let repo;

before(async () => {
	repo = makeRepo();
	bridgeHome = mkdtempSync(join(tmpdir(), "cb-bridgehome-"));
	bridge = spawnBridge({ CODEX_BRIDGE_HOME: bridgeHome });
	initResult = await bridge.init();
});

beforeEach(() => setStubControl({ mode: "success", write: "OUT.txt::hello-from-stub\n" }));

after(() => {
	bridge.close();
	setStubControl({});
	rmSync(repo, { recursive: true, force: true });
	rmSync(bridgeHome, { recursive: true, force: true });
	try { unlinkSync(join(tmpdir(), "cb-stub-codex-control.json")); } catch {}
});

test("initialize exposes client-agnostic server instructions and described tool schemas", async () => {
	assert.equal(typeof initResult?.instructions, "string");
	assert.match(initResult.instructions, /worktree/i);
	assert.match(initResult.instructions, /summary/i);
	const list = await bridge.listTools();
	const execTool = list.tools.find((t) => t.name === "codex_exec");
	const resumeTool = list.tools.find((t) => t.name === "codex_resume");
	assert.ok(execTool?.inputSchema?.properties?.return_view?.description, "codex_exec.return_view documented");
	assert.ok(resumeTool?.inputSchema?.properties?.effort?.description, "codex_resume.effort documented");
});

test("doctor reports healthy with stub codex", async () => {
	const r = await bridge.call("codex_sessions", { action: "doctor" });
	assert.match(JSON.stringify(r), /stub|0\.166/i);
	assert.equal(r.codex_auth?.ok, true);
	assert.equal(r.bridge_home, bridgeHome);
	assert.equal(r.bridge_home_writable, true);
	assert.equal(typeof r.active_worktrees, "number");
	assert.equal(r.max_wait_seconds, 240);
	assert.equal(r.default_idle_timeout_seconds, 900);
	assert.equal(r.default_wall_timeout_seconds, null);
});

test("codex_exec worktree: completes, isolates changes, parent stays clean", async () => {
	const r = await bridge.call("codex_exec", {
		task: "write hello file",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
	});
	assert.equal(r.status, "completed", JSON.stringify(r).slice(0, 600));
	assert.ok(r.run_id);
	assert.equal(git(repo, "status", "--porcelain").trim(), "", "parent repo must stay clean");
	const wt = r.worktree ?? r.cwd;
	assert.ok(existsSync(join(wt, "README.md")), "worktree exists with repo content");
	assert.ok(existsSync(join(wt, "OUT.txt")), "stub file landed inside worktree");
});

test("codex_exec inplace mode: writes into repo, diff captured", async () => {
	const r = await bridge.call("codex_exec", {
		task: "add file",
		cwd: repo,
		isolation: "inplace",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
	});
	assert.equal(r.status, "completed", JSON.stringify(r).slice(0, 600));
	assert.ok(existsSync(join(repo, "OUT.txt")), "inplace write landed in repo");
	rmSync(join(repo, "OUT.txt"), { force: true });
});

test("worktree escape is detected and flagged", async () => {
	const escapePath = join(repo, "ESCAPED.txt");
	setStubControl({ mode: "escape", escape_path: escapePath });
	const r = await bridge.call("codex_exec", {
		task: "try to write outside worktree",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
	});
	assert.ok(existsSync(escapePath), "stub should have written the escape file");
	assert.match(JSON.stringify(r), /escape/i, `expected WORKTREE ESCAPE warning: ${JSON.stringify(r).slice(0, 800)}`);
	rmSync(escapePath, { force: true });
});

test("async exec + long-poll wakes before wait_seconds elapses", async () => {
	const r = await bridge.call("codex_exec", {
		task: "slow task",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "async",
		timeout: 120,
	});
	assert.ok(r.run_id);
	const t0 = Date.now();
	const s = await bridge.call("codex_sessions", {
		action: "get",
		run_id: r.run_id,
		view: "status",
		wait_seconds: 30,
	});
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 29_500, `poll took ${elapsed}ms — regression to full-wait burn`);
	const st = s.status ?? s.run?.status ?? s.progress?.status;
	assert.equal(typeof st, "string", JSON.stringify(s).slice(0, 400));
});

test("progress events: since_seq cursor returns earliest unseen without loss", async () => {
	const r = await bridge.call("codex_exec", {
		task: "multi event",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "async",
		timeout: 120,
	});
	await waitFor(async () => {
		const s = await bridge.call("codex_sessions", { action: "get", run_id: r.run_id, view: "status" });
		return (s.status ?? s.progress?.status) === "completed" || s.review_ready;
	});
	// fetch events from seq=0 — must see ordered events with no gaps
	const s = await bridge.call("codex_sessions", { action: "get", run_id: r.run_id, view: "status", since_seq: 0 });
	const evs = s.progress_events ?? [];
	assert.ok(evs.length >= 3, `expected >=3 progress events, got ${evs.length}`);
	for (let i = 1; i < evs.length; i++) assert.ok(evs[i].seq > evs[i - 1].seq, "seqs must be ordered");
});

test("cancel a hung run terminates cleanly", async () => {
	setStubControl({ mode: "hang" });
	const r = await bridge.call("codex_exec", {
		task: "hang forever",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "async",
		timeout: 600,
	});
	await waitFor(async () => {
		const s = await bridge.call("codex_sessions", { action: "get", run_id: r.run_id, view: "status" });
		return (s.progress?.seq ?? 0) >= 2;
	});
	const stop = await bridge.call("codex_sessions", { action: "stop", run_id: r.run_id });
	assert.match(JSON.stringify(stop), /stop|cancel|terminat|ok/i);
	const s = await bridge.call("codex_sessions", { action: "get", run_id: r.run_id, view: "status", wait_seconds: 15 });
	assert.match(JSON.stringify(s), /cancel|stop|fail|terminat/i);
});

test("failed codex run surfaces error, not silence", async () => {
	setStubControl({ mode: "fail" });
	const r = await bridge.call("codex_exec", {
		task: "will fail",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
	});
	assert.match(JSON.stringify(r), /fail|error/i);
});

test("resume attaches to existing session", async () => {
	const r = await bridge.call("codex_exec", {
		task: "initial work",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
	});
	const sid = r.session_id ?? r.sessionId;
	assert.ok(sid, "expected session_id in exec result");
	const rr = await bridge.call("codex_resume", {
		session_id: sid,
		task: "follow-up",
		cwd: repo,
		wait_budget_seconds: 30,
		timeout: 60,
	});
	assert.match(JSON.stringify(rr), /completed|resume/i);
});

test("cleanup removes worktree", async () => {
	const r = await bridge.call("codex_exec", {
		task: "make worktree",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
	});
	const wt = r.worktree;
	const c = await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
	assert.match(JSON.stringify(c), /clean|remov|ok|true/i);
	if (wt) assert.ok(!existsSync(wt), "worktree should be removed");
});

test("model resolution: config.toml, flag override, and honest unknown", async () => {
	const cfgHome = mkdtempSync(join(tmpdir(), "cb-codexhome-"));
	writeFileSync(join(cfgHome, "config.toml"), 'model = "fixture-gpt"\nmodel_reasoning_effort = "low"\n');
	const b = spawnBridge({ CODEX_HOME: cfgHome, CODEX_BRIDGE_HOME: bridgeHome });
	await b.init();
	try {
		setStubControl({ mode: "success" });
		const r1 = await b.call("codex_exec", {
			task: "x", cwd: repo, isolation: "inplace",
			execution_mode: "auto", wait_budget_seconds: 30, timeout: 60,
		});
		const st1 = await b.call("codex_sessions", { action: "get", run_id: r1.run_id });
		assert.equal(st1.model, "fixture-gpt");
		assert.equal(st1.model_source, "config");
		assert.equal(st1.effort, "low");
		assert.equal(st1.effort_source, "config");
		assert.ok(st1.codex_version, "codex_version recorded");
		const sum1 = await b.call("codex_sessions", { action: "get", run_id: r1.run_id, view: "summary" });
		assert.equal(sum1.model, "fixture-gpt", "review packet carries model");

		const r2 = await b.call("codex_exec", {
			task: "x", cwd: repo, isolation: "inplace", model: "flag-model-x",
			execution_mode: "auto", wait_budget_seconds: 30, timeout: 60,
		});
		const st2 = await b.call("codex_sessions", { action: "get", run_id: r2.run_id });
		assert.equal(st2.model, "flag-model-x");
		assert.equal(st2.model_source, "flag");
	} finally {
		b.close();
		rmSync(cfgHome, { recursive: true, force: true });
	}

	const emptyHome = mkdtempSync(join(tmpdir(), "cb-codexhome-empty-"));
	const b2 = spawnBridge({ CODEX_HOME: emptyHome, CODEX_BRIDGE_HOME: bridgeHome });
	await b2.init();
	try {
		setStubControl({ mode: "success" });
		const r3 = await b2.call("codex_exec", {
			task: "x", cwd: repo, isolation: "inplace",
			execution_mode: "auto", wait_budget_seconds: 30, timeout: 60,
		});
		const st3 = await b2.call("codex_sessions", { action: "get", run_id: r3.run_id });
		assert.equal(st3.model, null);
		assert.equal(st3.model_source, "unknown");
	} finally {
		b2.close();
		rmSync(emptyHome, { recursive: true, force: true });
	}
	rmSync(join(repo, "OUT.txt"), { force: true });
});

test("worktree exec trusts worktree in shadow config, points brief at worktree, and supports return_view=summary", async () => {
	const r = await bridge.call("codex_exec", {
		task: "write summary test",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
		return_view: "summary",
	});
	assert.equal(r.status, "completed", JSON.stringify(r).slice(0, 600));
	assert.equal(r.isolation, "worktree");
	assert.ok(r.worktree_path, "summary view exposes worktree_path");
	assert.equal("diff_preview" in (r.git_diff ?? {}), false, "summary view omits full diff_preview");
	assert.ok(r.next_action, "summary view exposes next_action");

	const meta = JSON.parse(readFileSync(join(bridgeHome, "runs", r.run_id, "run.json"), "utf8"));
	assert.ok(meta.task.includes(`- Git root: ${r.worktree_path}`), "project brief points at worktree, not parent checkout");
	const shadowCfg = readFileSync(join(meta.mcpHome, "config.toml"), "utf8");
	assert.ok(shadowCfg.includes(`[projects.${JSON.stringify(r.worktree_path)}]`), "shadow config trusts worktree path");

	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
	assert.equal(existsSync(r.worktree_path), false, "cleanup removed worktree");
});

test("worktree exec rolls back runDir and worktree on grant rejection", async () => {
	const runsBefore = existsSync(join(bridgeHome, "runs")) ? readdirSync(join(bridgeHome, "runs")).length : 0;
	const wtBefore = existsSync(join(bridgeHome, "wt")) ? readdirSync(join(bridgeHome, "wt")).length : 0;
	const r = await bridge.call("codex_exec", {
		task: "should be rejected",
		cwd: repo,
		isolation: "worktree",
		grants_mcp: ["computer-use"],
		execution_mode: "async",
	});
	assert.match(JSON.stringify(r), /grant_rejected|forbidden/i);
	const runsAfter = existsSync(join(bridgeHome, "runs")) ? readdirSync(join(bridgeHome, "runs")).length : 0;
	const wtAfter = existsSync(join(bridgeHome, "wt")) ? readdirSync(join(bridgeHome, "wt")).length : 0;
	assert.equal(runsAfter, runsBefore, "rejected exec leaves no orphan runDir");
	assert.equal(wtAfter, wtBefore, "rejected exec leaves no orphan worktree");
});

test("worktree resume stays inside worktree, preserves effort, and fails cleanly after cleanup", async () => {
	setStubControl({ mode: "success", write: "STEP1.txt::one\n" });
	const r1 = await bridge.call("codex_exec", {
		task: "step 1",
		cwd: repo,
		isolation: "worktree",
		effort: "medium",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
	});
	assert.equal(r1.status, "completed");
	assert.ok(r1.session_id && r1.worktree_path);

	setStubControl({ mode: "success", write: "STEP2.txt::two\n" });
	const r2 = await bridge.call("codex_resume", {
		session_id: r1.session_id,
		task: "step 2",
		cwd: repo,
		effort: "high",
		execution_mode: "auto",
		wait_budget_seconds: 30,
		timeout: 60,
		return_view: "summary",
	});
	assert.equal(r2.status, "completed", JSON.stringify(r2).slice(0, 600));
	assert.equal(r2.worktree_path, r1.worktree_path);
	assert.equal(r2.effort, "high");
	assert.equal(r2.effort_source, "flag");
	assert.ok(existsSync(join(r1.worktree_path, "STEP2.txt")), "resume wrote inside worktree");
	assert.equal(git(repo, "status", "--porcelain").trim(), "", "parent checkout stays untouched during worktree resume");

	await bridge.call("codex_sessions", { action: "cleanup", run_id: r2.run_id });
	const r3 = await bridge.call("codex_resume", {
		session_id: r1.session_id,
		task: "step 3 after cleanup",
		execution_mode: "auto",
	});
	assert.match(JSON.stringify(r3), /worktree was already cleaned up/i);
});

test("CODEX_BRIDGE_MAX_WAIT_SECONDS caps doctor max_wait_seconds and poll suggestions", async () => {
	const b = spawnBridge({ CODEX_BRIDGE_HOME: bridgeHome, CODEX_BRIDGE_MAX_WAIT_SECONDS: "45" });
	await b.init();
	try {
		const doc = await b.call("codex_sessions", { action: "doctor" });
		assert.equal(doc.max_wait_seconds, 45);
		setStubControl({ mode: "hang" });
		const run = await b.call("codex_exec", { task: "hang briefly", cwd: repo, isolation: "worktree", execution_mode: "async" });
		const st = await b.call("codex_sessions", { action: "get", run_id: run.run_id, view: "status" });
		assert.ok(st.next_poll_after_seconds <= 45, `expected <=45, got ${st.next_poll_after_seconds}`);
		await b.call("codex_sessions", { action: "stop", run_id: run.run_id });
		await waitFor(async () => {
			const s = await b.call("codex_sessions", { action: "get", run_id: run.run_id, view: "status" });
			return s.review_ready;
		});
		await b.call("codex_sessions", { action: "cleanup", run_id: run.run_id });
	} finally {
		b.close();
	}
});

test("idle_timeout kills genuinely silent run even under continuous stderr noise without polluting progress", async () => {
	setStubControl({ mode: "hang", stderr_spam: true, stderr_spam_ms: 200 });
	const r = await bridge.call("codex_exec", {
		task: "silent hang with stderr noise",
		cwd: repo,
		isolation: "worktree",
		idle_timeout: 2,
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	assert.equal(r.status, "timeout", JSON.stringify(r).slice(0, 600));
	assert.equal(r.status_detail, "idle_timeout_clean");
	assert.equal(r.failure_hint, "idle_timeout");
	assert.equal(r.timeout, null, "wall timeout defaults to null (unlimited)");
	assert.equal(r.idle_timeout, 2);
	assert.match(r.stderr || "", /codex_models_manager/, "stderr is still captured in review.stderr");

	const st = await bridge.call("codex_sessions", { action: "get", run_id: r.run_id, view: "status", since_seq: 0 });
	const evMsgs = (st.progress_events ?? []).map((e) => e.message);
	assert.equal(evMsgs.some((m) => /\[stderr\]|codex_models_manager/i.test(m)), false, `stderr must not pollute progress_events: ${JSON.stringify(evMsgs)}`);
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
});

test("active run with no wall timeout survives beyond idle_timeout when emitting JSONL events", async () => {
	setStubControl({ mode: "success", steps: 4, step_delay_ms: 750, write: "ACTIVE.txt::still-going\n" });
	const r = await bridge.call("codex_exec", {
		task: "long active multi-step run",
		cwd: repo,
		isolation: "worktree",
		idle_timeout: 2,
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	assert.equal(r.status, "completed", JSON.stringify(r).slice(0, 600));
	assert.equal(r.timeout, null);
	assert.equal(r.idle_timeout, 2);
	assert.ok(r.duration_ms >= 2800, `expected duration >= 2800ms (> 2s idle_timeout), got ${r.duration_ms}ms`);
	assert.ok(existsSync(join(r.worktree_path, "ACTIVE.txt")));
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
});

test("command_execution started+completed events are deduplicated and non-zero exits surface cleanly", async () => {
	setStubControl({ mode: "success", started_and_completed_cmd: true, write: "DEDUP.txt::ok\n" });
	const r = await bridge.call("codex_exec", {
		task: "dedup command events",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	assert.equal(r.status, "completed", JSON.stringify(r).slice(0, 600));
	const npmMatches = (r.events?.commands ?? []).filter((c) => c === "npm test -- --run");
	assert.equal(npmMatches.length, 1, `expected command recorded once, got ${JSON.stringify(r.events?.commands)}`);
	const st = await bridge.call("codex_sessions", { action: "get", run_id: r.run_id, view: "status", since_seq: 0 });
	const msgs = (st.progress_events ?? []).map((e) => e.message);
	assert.equal(msgs.filter((m) => m === "Running: npm test -- --run").length, 1, `expected one Running progress line: ${JSON.stringify(msgs)}`);
	assert.ok(msgs.some((m) => m.includes("Command exited 2: lint --check")), `expected non-zero exit notice: ${JSON.stringify(msgs)}`);
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
});

test("parallel coordinator edit in parent repo does not trigger false-positive WORKTREE ESCAPE", async () => {
	setStubControl({ mode: "success", steps: 3, step_delay_ms: 400, write: "WT_ONLY.txt::worker\n" });
	const run = await bridge.call("codex_exec", {
		task: "edit only worktree",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "async",
	});
	await waitFor(async () => {
		const s = await bridge.call("codex_sessions", { action: "get", run_id: run.run_id, view: "status" });
		return s.status === "running" && (s.progress?.seq ?? 0) >= 3;
	});
	const parentFile = join(repo, "PARENT_UI.txt");
	writeFileSync(parentFile, "coordinator-edit\n");
	try {
		// Default wait_for="terminal" on view="summary" waits through intermediate ticks and returns summary in one call
		const sum = await bridge.call("codex_sessions", {
			action: "get",
			run_id: run.run_id,
			view: "summary",
			wait_seconds: 15,
		});
		assert.equal(sum.status, "completed", JSON.stringify(sum).slice(0, 600));
		assert.equal(sum.review_ready, true);
		assert.equal(sum.worktree_escape, undefined, "parallel parent edit must not trigger worktree_escape");
		const warnItems = sum.warnings?.items ?? [];
		assert.equal(warnItems.some((w) => /WORKTREE ESCAPE/i.test(w)), false, `unexpected escape warning: ${JSON.stringify(warnItems)}`);
		assert.ok(sum.concurrent_parent_changes?.paths?.includes("PARENT_UI.txt"), `expected concurrent_parent_changes: ${JSON.stringify(sum.concurrent_parent_changes)}`);
	} finally {
		rmSync(parentFile, { force: true });
		await bridge.call("codex_sessions", { action: "cleanup", run_id: run.run_id });
	}
});

test("smart long-poll: wait_for=progress wakes on intermediate tick, wait_for=terminal waits for summary", async () => {
	setStubControl({ mode: "success", steps: 4, step_delay_ms: 400, write: "POLL.txt::ok\n" });
	const run = await bridge.call("codex_exec", {
		task: "multi-step poll test",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "async",
	});
	const tick = await bridge.call("codex_sessions", {
		action: "get",
		run_id: run.run_id,
		view: "status",
		wait_seconds: 10,
		wait_for: "progress",
		since_seq: 0,
	});
	assert.equal(tick.review_ready, false, "wait_for=progress should wake before run finishes");
	const summary = await bridge.call("codex_sessions", {
		action: "get",
		run_id: run.run_id,
		view: "summary",
		wait_seconds: 15,
	});
	assert.equal(summary.review_ready, true, "default wait_for=terminal should wait until review is ready");
	assert.equal(summary.status, "completed");
	assert.ok(summary.git_diff?.files?.items?.some((f) => f.path === "POLL.txt"));
	await bridge.call("codex_sessions", { action: "cleanup", run_id: run.run_id });
});

test("action=apply supports dry_run, atomic apply+cleanup, multi-turn resume, conflict rejection, and active cleanup guard", async () => {
	// 1. Single-turn dry_run + apply(cleanup=true)
	setStubControl({ mode: "success", write: "HARVEST.txt::clean-land\n" });
	const r1 = await bridge.call("codex_exec", {
		task: "create harvest file",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	assert.equal(r1.status, "completed");
	const dry = await bridge.call("codex_sessions", { action: "apply", run_id: r1.run_id, dry_run: true });
	assert.equal(dry.applied, false);
	assert.equal(dry.dry_run, true);
	assert.equal(dry.check_ok, true);
	assert.equal(existsSync(join(repo, "HARVEST.txt")), false, "dry_run must not modify parent repo");

	const applied = await bridge.call("codex_sessions", { action: "apply", run_id: r1.run_id, cleanup: true });
	assert.equal(applied.applied, true, JSON.stringify(applied));
	assert.equal(applied.cleaned, true);
	assert.equal(readFileSync(join(repo, "HARVEST.txt"), "utf8"), "clean-land\n");
	assert.equal(existsSync(r1.worktree_path), false, "cleanup=true removed worktree");
	rmSync(join(repo, "HARVEST.txt"), { force: true });

	// 2. Conflict check fails atomically without modifying parent repo
	setStubControl({ mode: "success", write: "CONFLICT.txt::from-worker\n" });
	const rc = await bridge.call("codex_exec", {
		task: "create conflicting file",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	writeFileSync(join(repo, "CONFLICT.txt"), "parent-original\n");
	try {
		const bad = await bridge.call("codex_sessions", { action: "apply", run_id: rc.run_id });
		assert.equal(bad.applied, false);
		assert.equal(bad.check_ok, false);
		assert.equal(readFileSync(join(repo, "CONFLICT.txt"), "utf8"), "parent-original\n", "failed apply must leave parent untouched");
	} finally {
		rmSync(join(repo, "CONFLICT.txt"), { force: true });
		await bridge.call("codex_sessions", { action: "cleanup", run_id: rc.run_id });
	}

	// 3. Multi-turn worktree resume apply harvests full cumulative diff (turn 1 + turn 2)
	setStubControl({ mode: "success", write: "MULTI_1.txt::v1\n" });
	const m1 = await bridge.call("codex_exec", {
		task: "turn 1",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	setStubControl({ mode: "success", write: "MULTI_2.txt::v2\n" });
	const m2 = await bridge.call("codex_resume", {
		session_id: m1.session_id,
		task: "turn 2",
		cwd: repo,
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	const mApply = await bridge.call("codex_sessions", { action: "apply", run_id: m2.run_id, cleanup: true });
	assert.equal(mApply.applied, true, JSON.stringify(mApply));
	assert.equal(mApply.scope, "worktree", "resumed worktree run defaults to cumulative worktree scope");
	assert.equal(mApply.cleaned, true);
	assert.equal(readFileSync(join(repo, "MULTI_1.txt"), "utf8"), "v1\n", "turn 1 file landed");
	assert.equal(readFileSync(join(repo, "MULTI_2.txt"), "utf8"), "v2\n", "turn 2 file landed");
	rmSync(join(repo, "MULTI_1.txt"), { force: true });
	rmSync(join(repo, "MULTI_2.txt"), { force: true });

	// 4. Cleanup refuses to delete an active worktree until stopped
	setStubControl({ mode: "hang" });
	const active = await bridge.call("codex_exec", {
		task: "hang while testing cleanup guard",
		cwd: repo,
		isolation: "worktree",
		execution_mode: "async",
	});
	await waitFor(async () => {
		const s = await bridge.call("codex_sessions", { action: "get", run_id: active.run_id, view: "status" });
		return s.status === "running";
	});
	const blockedCleanup = await bridge.call("codex_sessions", { action: "cleanup", run_id: active.run_id });
	assert.match(JSON.stringify(blockedCleanup), /Cannot cleanup worktree while run is active/i);
	await bridge.call("codex_sessions", { action: "stop", run_id: active.run_id });
	await bridge.call("codex_sessions", { action: "get", run_id: active.run_id, view: "status", wait_seconds: 15 });
	const okCleanup = await bridge.call("codex_sessions", { action: "cleanup", run_id: active.run_id });
	assert.equal(okCleanup.cleaned, true);
});

test("explicit opt-in wall timeout still caps active runs with wall_timeout hint", async () => {
	setStubControl({ mode: "success", steps: 10, step_delay_ms: 500 });
	const r = await bridge.call("codex_exec", {
		task: "active run exceeding opt-in wall cap",
		cwd: repo,
		isolation: "worktree",
		timeout: 2,
		idle_timeout: 60,
		execution_mode: "auto",
		wait_budget_seconds: 15,
	});
	assert.equal(r.status, "timeout", JSON.stringify(r).slice(0, 600));
	assert.equal(r.status_detail, "timeout_clean");
	assert.equal(r.failure_hint, "wall_timeout");
	assert.equal(r.timeout, 2);
	assert.equal(r.idle_timeout, 60);
	await bridge.call("codex_sessions", { action: "cleanup", run_id: r.run_id });
});
