/**
 * worker.ts is a top-level script (no exports; argv[2] = runDir, runs main() on import),
 * so only its process-level guard paths are tested here as subprocesses of dist/worker.js.
 * CODEX_BRIDGE_HOME is redirected to mkdtemp.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "worker.js");
const dirs = [];
const tmp = (p = "cb-wk-") => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const runWorker = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
	encoding: "utf8", cwd: tmp(), timeout: 20000,
	env: { ...process.env, CODEX_BRIDGE_HOME: tmp("cb-wk-bh-"), CODEX_BINARY: "/nonexistent/codex" },
});

test("worker without runDir argument exits 1 with usage error", () => {
	const r = runWorker([]);
	assert.equal(r.status, 1);
	assert.equal(r.stderr, "worker: runDir argument required\n");
	assert.equal(r.stdout, "");
});

test("worker with runDir lacking run.json exits 1 and leaves runDir untouched", () => {
	const runDir = tmp("cb-wk-run-");
	const r = runWorker([runDir]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /worker: run\.json not found in /);
	assert.ok(r.stderr.includes(runDir));
	assert.equal(r.stdout, "");
	assert.deepEqual(readdirSync(runDir), [], "no progress/meta written before meta validated");
});

// Not covered (see STATE.md key_decisions): buildCodexArgs / runCodexWorker / fail() are
// module-private in a script with top-level side effects; the full lifecycle needs a valid
// run.json in the progress.ts layout plus test/stub-codex.mjs and is already exercised
// end-to-end by bridge.test.mjs.
