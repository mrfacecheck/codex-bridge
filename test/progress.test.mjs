import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Isolation: progress.ts resolves BASE_DIR from CODEX_BRIDGE_HOME at module load,
// so the env must be set BEFORE the dynamic import. Never touch ~/.codex-bridge.
const HOME = mkdtempSync(path.join(tmpdir(), "cb-progress-test-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const p = await import("../dist/progress.js");
if (!p.RUNS_DIR.startsWith(HOME)) throw new Error(`isolation failed: RUNS_DIR=${p.RUNS_DIR}`);
after(() => rmSync(HOME, { recursive: true, force: true }));

const freshRun = () => { const id = randomUUID(); return { id, dir: p.createRunDir(id) }; };

test("isolation: RUNS_DIR lives under the temp CODEX_BRIDGE_HOME", () => {
  assert.equal(p.RUNS_DIR, path.join(HOME, "runs"));
  assert.equal(p.PROJECTS_DIR, path.join(HOME, "projects"));
});

test("assertRunId accepts UUIDs (any case) and rejects everything else", () => {
  const id = randomUUID();
  assert.equal(p.assertRunId(id), id);
  assert.equal(p.assertRunId(id.toUpperCase()), id.toUpperCase());
  for (const bad of ["", "abc", "../etc/passwd", `${id}/..`, id.replace(/-/g, ""), `${id}x`, "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"]) {
    assert.throws(() => p.assertRunId(bad), /Invalid run_id/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("createRunDir/getRunDir/runDirExists lifecycle", () => {
  const id = randomUUID();
  assert.equal(p.runDirExists(id), false);
  const dir = p.createRunDir(id);
  assert.equal(dir, path.join(p.RUNS_DIR, id));
  assert.equal(p.getRunDir(id), dir);
  assert.ok(existsSync(dir));
  assert.equal(p.runDirExists(id), false, "dir without run.json is not a run");
  p.writeRunMeta(dir, { runId: id, cwd: "/tmp" });
  assert.equal(p.runDirExists(id), true);
  assert.equal(p.runDirExists("../not-a-uuid"), false, "invalid id returns false, no throw");
  assert.throws(() => p.getRunDir("nope"), /Invalid run_id/);
  assert.throws(() => p.createRunDir("../escape"), /Invalid run_id/);
});

test("writeRunMeta + readRunMeta round-trip, updateRunMeta partial patch", () => {
  const { id, dir } = freshRun();
  const meta = { runId: id, cwd: "/tmp/proj", gitRoot: "/tmp/proj", workerPid: 4242, createdAt: "2026-01-01T00:00:00.000Z" };
  p.writeRunMeta(dir, meta);
  assert.deepEqual(p.readRunMeta(dir), meta);
  p.updateRunMeta(dir, { workerPid: 7 });
  assert.deepEqual(p.readRunMeta(dir), { ...meta, workerPid: 7 }, "patch merges, other fields kept");
});

test("updateRunMeta is a no-op when run.json is missing", () => {
  const { dir } = freshRun();
  p.updateRunMeta(dir, { cwd: "/x" });
  assert.equal(p.readRunMeta(dir), null);
  assert.equal(existsSync(path.join(dir, "run.json")), false);
});

test("updateProgress/readProgress: defaults, seq increments, partial merge", () => {
  const { dir } = freshRun();
  assert.equal(p.readProgress(dir), null);
  p.updateProgress(dir, {});
  let s = p.readProgress(dir);
  assert.equal(s.status, "starting");
  assert.equal(s.message, "");
  assert.equal(s.seq, 1);
  assert.ok(!Number.isNaN(Date.parse(s.updatedAt)));
  p.updateProgress(dir, { status: "running", message: "a", sessionId: "sess-1" });
  p.updateProgress(dir, { message: "b" });
  s = p.readProgress(dir);
  assert.equal(s.seq, 3);
  assert.equal(s.status, "running", "status kept when patch omits it");
  assert.equal(s.message, "b");
  assert.equal(s.sessionId, "sess-1", "sessionId kept across partial patch");
});

test("readProgressEventsSince: since_seq / limit / mode pagination", () => {
  const { dir } = freshRun();
  assert.deepEqual(p.readProgressEventsSince(dir), [], "missing jsonl -> []");
  for (let i = 1; i <= 5; i++) p.updateProgress(dir, { status: "running", message: `m${i}` });
  const seqs = (evs) => evs.map((e) => e.seq);
  assert.deepEqual(seqs(p.readProgressEventsSince(dir)), [1, 2, 3, 4, 5], "defaults: since 0, limit 20, after");
  assert.deepEqual(seqs(p.readProgressEventsSince(dir, 0, 2, "after")), [1, 2]);
  assert.deepEqual(seqs(p.readProgressEventsSince(dir, 2, 2, "after")), [3, 4], "cursor pagination is lossless");
  assert.deepEqual(seqs(p.readProgressEventsSince(dir, 4, 2, "after")), [5]);
  assert.deepEqual(seqs(p.readProgressEventsSince(dir, 0, 2, "recent")), [4, 5], "recent returns the tail");
  assert.deepEqual(p.readProgressEventsSince(dir, 5), []);
  assert.equal(p.readProgressEventsSince(dir, 2, 1)[0].message, "m3");
});

test("readProgressEventsSince skips corrupt jsonl lines", () => {
  const { dir } = freshRun();
  p.updateProgress(dir, { message: "ok1" });
  appendFileSync(path.join(dir, "progress.jsonl"), "{garbage\n\n");
  p.updateProgress(dir, { message: "ok2" });
  assert.deepEqual(p.readProgressEventsSince(dir).map((e) => e.message), ["ok1", "ok2"]);
});

test("requestCancel/isCancelRequested and cancelling status is sticky vs running", () => {
  const { dir } = freshRun();
  p.updateProgress(dir, { status: "running", message: "work" });
  assert.equal(p.isCancelRequested(dir), false);
  p.requestCancel(dir);
  assert.equal(p.isCancelRequested(dir), true);
  assert.equal(p.cancelPath(dir), path.join(dir, "cancel.requested"));
  assert.equal(p.readProgress(dir).status, "cancelling");
  p.updateProgress(dir, { status: "running", message: "late heartbeat" });
  assert.equal(p.readProgress(dir).status, "cancelling", "running must not overwrite cancelling");
  p.updateProgress(dir, { status: "cancelled" });
  assert.equal(p.readProgress(dir).status, "cancelled");
});

test("writeReviewPacket/readReviewPacket/reviewReady", () => {
  const { id, dir } = freshRun();
  assert.equal(p.reviewReady(dir), false);
  assert.equal(p.readReviewPacket(dir), null);
  const pkt = { run_id: id, status: "completed", files: [{ path: "a.ts", added: 3 }] };
  p.writeReviewPacket(dir, pkt);
  assert.equal(p.reviewReady(dir), true);
  assert.deepEqual(p.readReviewPacket(dir), pkt);
});

test("corrupt JSON files read as null instead of throwing", () => {
  const { dir } = freshRun();
  for (const f of ["run.json", "progress.json", "review.json"]) writeFileSync(path.join(dir, f), "{not json");
  assert.equal(p.readRunMeta(dir), null);
  assert.equal(p.readProgress(dir), null);
  assert.equal(p.readReviewPacket(dir), null);
  assert.doesNotThrow(() => p.updateRunMeta(dir, { cwd: "/x" }));
  assert.doesNotThrow(() => p.updateProgress(dir, { message: "recover" }));
  assert.equal(p.readProgress(dir).seq, 1, "corrupt progress resets seq");
});

test("projectHash is stable for identical input and differs for different input", () => {
  assert.equal(typeof p.projectHash, "function");
  const a = p.projectHash("/tmp/some/project");
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0);
  assert.equal(p.projectHash("/tmp/some/project"), a);
  assert.notEqual(p.projectHash("/tmp/other/project"), a);
});
