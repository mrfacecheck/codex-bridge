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
