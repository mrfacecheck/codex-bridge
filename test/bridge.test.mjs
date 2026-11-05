/** Deterministic offline regression suite for codex-bridge via stub-codex. */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBridge, makeRepo, git, waitFor, setStubControl } from "./helpers.mjs";

let bridge;
let repo;

before(async () => {
	repo = makeRepo();
	bridge = spawnBridge();
	await bridge.init();
});

beforeEach(() => setStubControl({ mode: "success", write: "OUT.txt::hello-from-stub\n" }));

after(() => {
	bridge.close();
	setStubControl({});
	rmSync(repo, { recursive: true, force: true });
	try { unlinkSync(join(tmpdir(), "cb-stub-codex-control.json")); } catch {}
});

test("doctor reports healthy with stub codex", async () => {
	const r = await bridge.call("codex_sessions", { action: "doctor" });
	assert.match(JSON.stringify(r), /stub|0\.166/i);
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
