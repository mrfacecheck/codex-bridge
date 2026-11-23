/** Unit tests for src/evidence.ts pure/fs-local helpers. All fs side effects live in mkdtemp dirs. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, realpathSync, renameSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
	resolveCodexBinary, buildSafeEnv, buildCodexEnv, buildGitEnv, cmdOk, normalizeCwd, isGitRepo, resolveExecContext, lockKey, pidAlive,
	readLock, writeAtomic, lockAlive, acquireWriteLock, checkWriteLockConflict,
	getWorktreeStatus, getUntrackedStats,
} from "../dist/evidence.js";

const dirs = [];
const tmp = (p = "cb-ev-") => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function makeRepo() {
	const d = tmp("cb-ev-repo-");
	g(d, "init", "-q");
	g(d, "config", "user.email", "t@t"); g(d, "config", "user.name", "t"); g(d, "config", "commit.gpgsign", "false");
	writeFileSync(join(d, "README.md"), "hi\n");
	g(d, "add", "."); g(d, "commit", "-qm", "init");
	return d;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("buildSafeEnv copies only whitelisted keys and defaults PATH", () => {
	process.env.CB_EV_TEST_KEY = "v1";
	const e = buildSafeEnv(new Set(["CB_EV_TEST_KEY", "CB_EV_MISSING"]));
	assert.equal(e.CB_EV_TEST_KEY, "v1");
	assert.equal("CB_EV_MISSING" in e, false);
	assert.equal(e.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
	delete process.env.CB_EV_TEST_KEY;
});

test("buildGitEnv pins non-interactive git settings and merges extras", () => {
	const e = buildGitEnv({ CB_EXTRA: "x", GIT_PAGER: "less" });
	assert.equal(e.GIT_EXTERNAL_DIFF, "");
	assert.equal(e.GIT_OPTIONAL_LOCKS, "0");
	assert.equal(e.GIT_TERMINAL_PROMPT, "0");
	assert.equal(e.CB_EXTRA, "x");
	assert.equal(e.GIT_PAGER, "less", "extras override defaults");
	assert.equal(buildGitEnv().GIT_PAGER, "cat");
});

test("normalizeCwd: rejects relative and non-directory, returns realpath", () => {
	assert.throws(() => normalizeCwd("relative/dir"), /cwd must be absolute/);
	const d = tmp();
	const f = join(d, "file.txt"); writeFileSync(f, "x");
	assert.throws(() => normalizeCwd(f), /cwd must be a directory/);
	assert.equal(normalizeCwd(d), realpathSync(d));
	assert.throws(() => normalizeCwd(join(d, "nope")));
});

test("isGitRepo / resolveExecContext on non-repo vs repo", () => {
	const plain = tmp();
	assert.equal(isGitRepo(plain), false);
	assert.deepEqual(resolveExecContext(plain), { runCwd: plain, gitRoot: plain, gitRepo: false });
	const repo = makeRepo();
	assert.equal(isGitRepo(repo), true);
	const ctx = resolveExecContext(repo);
	assert.equal(ctx.gitRepo, true);
	assert.equal(ctx.gitRoot, repo);
});

test("lockKey is deterministic 24-hex and path-sensitive", () => {
	const a = lockKey("/a/b");
	assert.match(a, /^[0-9a-f]{24}$/);
	assert.equal(lockKey("/a/b"), a);
	assert.notEqual(lockKey("/a/c"), a);
});

test("pidAlive / lockAlive basics", () => {
	assert.equal(pidAlive(process.pid), true);
	assert.equal(pidAlive(2 ** 22 + 12345), false);
	assert.equal(lockAlive(undefined), false);
	assert.equal(lockAlive({ bridgePid: 2 ** 22 + 12345, runId: "r", cwd: "/x", createdAt: "" }), false);
});

test("writeAtomic writes 0600 JSON without leftover tmp; readLock tolerates garbage", () => {
	const d = tmp();
	const fp = join(d, "lock.json");
	writeAtomic(fp, { runId: "r1", n: 2 });
	assert.deepEqual(readLock(fp), { runId: "r1", n: 2 });
	assert.equal(statSync(fp).mode & 0o777, 0o600);
	assert.equal(existsSync(`${fp}.${process.pid}.tmp`), false);
	writeFileSync(fp, "{not json");
	assert.equal(readLock(fp), undefined);
	assert.equal(readLock(join(d, "missing")), undefined);
});

test("acquireWriteLock creates lock in tmpdir, attachChildPid, release removes it", () => {
	const cwd = tmp();
	const lk = acquireWriteLock(cwd, "run-A");
	assert.equal(lk.lockPath, join(tmpdir(), `codex-bridge-write-${lockKey(cwd)}.lock`));
	assert.equal(lk.runId, "run-A");
	const p = readLock(lk.lockPath);
	assert.equal(p.bridgePid, process.pid);
	assert.equal(p.cwd, cwd);
	lk.attachChildPid(4242);
	assert.equal(readLock(lk.lockPath).childPid, 4242);
	lk.release();
	assert.equal(existsSync(lk.lockPath), false);
});

test("stale lock (dead pids) is reclaimed by checkWriteLockConflict and acquireWriteLock", () => {
	const cwd = tmp();
	const lp = join(tmpdir(), `codex-bridge-write-${lockKey(cwd)}.lock`);
	const dead = { bridgePid: 2 ** 22 + 12345, runId: "old", cwd, createdAt: "" };
	writeFileSync(lp, JSON.stringify(dead));
	assert.equal(checkWriteLockConflict(cwd), undefined);
	assert.equal(existsSync(lp), false, "stale lock removed");
	assert.equal(checkWriteLockConflict(cwd), undefined, "no lock -> no conflict");
	writeFileSync(lp, JSON.stringify(dead));
	const lk = acquireWriteLock(cwd, "new");
	assert.equal(readLock(lp).runId, "new");
	lk.release();
});

test("getWorktreeStatus parses porcelain -z incl. untracked, modified, rename", () => {
	const repo = makeRepo();
	assert.deepEqual(getWorktreeStatus(repo), []);
	writeFileSync(join(repo, "README.md"), "changed\n");
	writeFileSync(join(repo, "new.txt"), "n\n");
	let s = getWorktreeStatus(repo);
	assert.deepEqual(s.find((x) => x.path === "README.md")?.xy, " M");
	assert.deepEqual(s.find((x) => x.path === "new.txt")?.xy, "??");
	g(repo, "checkout", "-q", "--", "README.md"); rmSync(join(repo, "new.txt"));
	g(repo, "mv", "README.md", "RENAMED.md");
	s = getWorktreeStatus(repo);
	assert.equal(s.length, 1, "rename source entry consumed, not emitted separately");
	assert.equal(s[0].xy[0], "R");
	assert.equal(s[0].path, "RENAMED.md");
	assert.deepEqual(getWorktreeStatus(tmp()), [], "non-repo -> []");
});

test("getUntrackedStats counts bytes, sorts largest, stops early at limit", () => {
	const repo = makeRepo();
	writeFileSync(join(repo, "small.txt"), "a".repeat(10));
	writeFileSync(join(repo, "big.txt"), "b".repeat(1000));
	const st = getUntrackedStats(repo);
	assert.equal(st.count, 2);
	assert.equal(st.totalBytes, 1010);
	assert.equal(st.largest[0].path, "big.txt");
	assert.equal(st.stoppedEarly, false);
	assert.equal(getUntrackedStats(repo, 5).stoppedEarly, true);
	assert.throws(() => getUntrackedStats(tmp()), /Unable to enumerate untracked files/);
});

test("resolveCodexBinary prefers env override, then home ~/.local/bin, then PATH", () => {
	const fakeHome = tmp("cb-ev-home-");
	const override = join(fakeHome, "custom-codex");
	writeFileSync(override, "#!/bin/sh\n"); chmodSync(override, 0o755);
	assert.equal(resolveCodexBinary({ CODEX_BINARY: override }, fakeHome), override);

	const localBin = join(fakeHome, ".local", "bin");
	mkdirSync(localBin, { recursive: true });
	const localCodex = join(localBin, "codex");
	writeFileSync(localCodex, "#!/bin/sh\n"); chmodSync(localCodex, 0o755);
	// Only assert ~/.local/bin resolution when /Applications/Codex.app is absent
	if (!existsSync("/Applications/Codex.app/Contents/Resources/codex")) {
		assert.equal(resolveCodexBinary({ PATH: "" }, fakeHome), localCodex);
	}

	const pathDir = tmp("cb-ev-path-");
	const pathCodex = join(pathDir, "codex");
	writeFileSync(pathCodex, "#!/bin/sh\n"); chmodSync(pathCodex, 0o755);
	const emptyHome = tmp("cb-ev-emptyhome-");
	if (!existsSync("/Applications/Codex.app/Contents/Resources/codex")
		&& !existsSync("/opt/homebrew/bin/codex")
		&& !existsSync("/usr/local/bin/codex")) {
		assert.equal(resolveCodexBinary({ PATH: pathDir }, emptyHome), pathCodex);
	}
});

test("cmdOk respects custom env, falls back to stderr on exit 0, and returns ok:false for missing command", () => {
	const ok = cmdOk(process.execPath, ["-e", "console.log(process.env.CB_CMD_OK)"], { env: { ...process.env, CB_CMD_OK: "yes" } });
	assert.equal(ok.ok, true);
	assert.equal(ok.output, "yes");
	const errOut = cmdOk(process.execPath, ["-e", "console.error('logged-in-stderr')"]);
	assert.equal(errOut.ok, true);
	assert.equal(errOut.output, "logged-in-stderr");
	const bad = cmdOk("/nonexistent/codex-bridge-test-bin", ["--version"]);
	assert.equal(bad.ok, false);
});

test("buildCodexEnv always includes a non-empty PATH", () => {
	const env = buildCodexEnv();
	assert.equal(typeof env.PATH, "string");
	assert.ok(env.PATH.length > 0);
});
