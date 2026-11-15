/**
 * statusline.ts is a top-level script (no exports; runs on import), so it is tested as a
 * subprocess of dist/statusline.js. HOME and CODEX_BRIDGE_HOME point at mkdtemp dirs so
 * ~/.claude/settings.json and run state never touch real user data.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "statusline.js");
const dirs = [];
const tmp = (p = "cb-sl-") => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function run(args, { input = "", cwd } = {}) {
	const home = tmp("cb-sl-home-");
	const bridgeHome = tmp("cb-sl-bh-");
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		input, cwd: cwd ?? tmp(), encoding: "utf8",
		env: { ...process.env, HOME: home, CODEX_BRIDGE_HOME: bridgeHome },
	});
	return { ...r, home };
}
function runWithHome(home, args) {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		input: "", cwd: tmp(), encoding: "utf8",
		env: { ...process.env, HOME: home, CODEX_BRIDGE_HOME: tmp("cb-sl-bh-") },
	});
}
const EXPECTED_SL = { type: "command", command: "codex-bridge statusline", refreshInterval: 2 };

test("install: creates ~/.claude/settings.json (0600, dir 0700) with statusLine config", () => {
	const r = run(["install"]);
	assert.equal(r.status, 0, r.stderr);
	const sp = join(r.home, ".claude", "settings.json");
	assert.equal(r.stdout, `Wrote statusLine config to ${sp}\n`);
	const s = JSON.parse(readFileSync(sp, "utf8"));
	assert.deepEqual(s, { statusLine: EXPECTED_SL });
	assert.equal(statSync(sp).mode & 0o777, 0o600);
	assert.equal(statSync(join(r.home, ".claude")).mode & 0o777, 0o700);
	assert.ok(readFileSync(sp, "utf8").endsWith("}\n"), "pretty JSON with trailing newline");
});

test("install: preserves existing settings keys and overwrites prior statusLine", () => {
	const home = tmp("cb-sl-home-");
	mkdirSync(join(home, ".claude"));
	const sp = join(home, ".claude", "settings.json");
	writeFileSync(sp, JSON.stringify({ theme: "dark", statusLine: { type: "old" } }));
	const r = runWithHome(home, ["install"]);
	assert.equal(r.status, 0, r.stderr);
	const s = JSON.parse(readFileSync(sp, "utf8"));
	assert.equal(s.theme, "dark");
	assert.deepEqual(s.statusLine, EXPECTED_SL);
});

test("install: corrupt settings.json is replaced rather than crashing", () => {
	const home = tmp("cb-sl-home-");
	mkdirSync(join(home, ".claude"));
	const sp = join(home, ".claude", "settings.json");
	writeFileSync(sp, "{not json");
	const r = runWithHome(home, ["install"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(readFileSync(sp, "utf8")), { statusLine: EXPECTED_SL });
});

test("statusline: non-git cwd from stdin JSON -> 'Codex idle'", () => {
	const d = tmp();
	for (const payload of [{ cwd: d }, { current_dir: d }, { workspace: { current_dir: d } }, { workspace: { project_dir: d } }]) {
		const r = run([], { input: JSON.stringify(payload) });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "Codex idle\n", JSON.stringify(payload));
	}
});

test("statusline: invalid / empty stdin falls back to process.cwd()", () => {
	assert.equal(run([], { input: "{garbage" }).stdout, "Codex idle\n");
	assert.equal(run([], { input: "" }).stdout, "Codex idle\n");
});

test("statusline: git repo with no recorded runs -> 'Codex idle' and writes nothing to HOME", () => {
	const repo = tmp("cb-sl-repo-");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	const r = run([], { input: JSON.stringify({ cwd: repo }) });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout, "Codex idle\n");
	assert.throws(() => statSync(join(r.home, ".claude")), /ENOENT/);
});

// Not covered (see STATE.md key_decisions): running / completed / review-packet output lines
// need the on-disk run layout from progress.ts (getLatestRunForProject/readProgress), which
// has not been read yet; formatElapsed is module-private and only reachable through those paths.
