import { spawnSync, execFileSync, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, lstatSync,
  realpathSync, readdirSync, readlinkSync, symlinkSync, copyFileSync, chmodSync,
  openSync, closeSync, readSync, fsyncSync, unlinkSync, renameSync,
  accessSync, constants as fsConstants,
} from "fs";
import { homedir, tmpdir } from "os";
import { createHash, randomBytes, randomUUID } from "crypto";
import path from "path";
import {
  MAX_GIT_BUFFER, TRUNCATED_TAIL_MARKER, TRUNCATED_HEAD_MARKER, EMPTY_TREE_OID,
  DIFF_DETECT_ARGS, DIFF_RENDER_ARGS, SENSITIVE_HASH_MAX, SENSITIVE_RE,
  SENSITIVE_PATHSPECS, LOW_VALUE_RE, KNOWN_JSONL_TYPES, SAFE_ENV,
  PRIMARY_PREVIEW_FILE_LIMIT, SECONDARY_PREVIEW_FILE_LIMIT, LOW_VALUE_HEADER_LIMIT,
  type ExecContext, type LockPayload, type WriteLock, type StatusFile,
  type TreeSnapshot, type FsSentinelResult, type FileFingerprint, type FsSentinelSnapshot,
  type FsSentinelChange, type AliasReason, type SensitiveAlias, type DiffFile,
  type GitDiffResult, type NoGitResult, type EventSummary,
  type WorkspaceMeta, type ApplyIntent, type ApplyIntentEntry, type FileObjectRef,
} from "./types.js";
import {
  ensureDir, fsyncDirBestEffort, workspaceDir, writeWorkspaceMeta,
  writeApplyIntent, resourceKey,
} from "./state.js";

// ── Codex Binary ──────────────────────────────────────────────────
function isExecutableFile(p: string): boolean {
  try {
    if (!existsSync(p) || !statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.CODEX_BINARY && existsSync(env.CODEX_BINARY)) return env.CODEX_BINARY;
  const candidates = [
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".codex", "packages", "standalone", "current", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(home, ".npm-global", "bin", "codex"),
    path.join(home, ".volta", "bin", "codex"),
    path.join(home, ".bun", "bin", "codex"),
  ];
  for (const c of candidates) {
    if (isExecutableFile(c)) return c;
  }
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "codex");
    if (isExecutableFile(candidate)) return candidate;
  }
  return "codex";
}
export const CODEX_BINARY = resolveCodexBinary();
export const CODEX_BINARY_REALPATH: string | undefined = (() => {
  try { return path.isAbsolute(CODEX_BINARY) ? realpathSync(CODEX_BINARY) : undefined; }
  catch { return undefined; }
})();

// ── Env ──────────────────────────────────────────────────────────
export function buildSafeEnv(keys: Set<string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const k of keys) { if (process.env[k]) e[k] = process.env[k]; }
  e.PATH ||= "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return e;
}
function prependPathDirs(currentPath: string, dirs: string[]): string {
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  const existing = new Set(parts);
  const additions: string[] = [];
  for (const d of dirs) {
    if (d && !existing.has(d)) { existing.add(d); additions.push(d); }
  }
  return [...additions, ...parts].join(path.delimiter);
}
export function buildCodexEnv(): NodeJS.ProcessEnv {
  const e = buildSafeEnv(SAFE_ENV);
  const extraDirs: string[] = [];
  if (path.isAbsolute(CODEX_BINARY)) extraDirs.push(path.dirname(CODEX_BINARY));
  if (CODEX_BINARY_REALPATH) extraDirs.push(path.dirname(CODEX_BINARY_REALPATH));
  if (extraDirs.length && e.PATH) e.PATH = prependPathDirs(e.PATH, extraDirs);
  const httpProxy = e.HTTP_PROXY || e.HTTPS_PROXY || e.http_proxy || e.https_proxy;
  if (httpProxy) {
    e.HTTP_PROXY  ||= httpProxy;
    e.HTTPS_PROXY ||= httpProxy;
    e.ALL_PROXY   ||= httpProxy;
    e.WS_PROXY    ||= httpProxy;
    e.WSS_PROXY   ||= httpProxy;
    e.http_proxy  ||= httpProxy;
    e.https_proxy ||= httpProxy;
    e.all_proxy   ||= httpProxy;
    e.ws_proxy    ||= httpProxy;
    e.wss_proxy   ||= httpProxy;
  }
  const noProxy = e.NO_PROXY || e.no_proxy;
  if (noProxy) {
    e.NO_PROXY ||= noProxy;
    e.no_proxy ||= noProxy;
  }
  return e;
}
export function buildGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e = buildSafeEnv(SAFE_ENV);
  e.GIT_EXTERNAL_DIFF = "";
  e.GIT_PAGER = "cat";
  e.GIT_OPTIONAL_LOCKS = "0";
  e.GIT_TERMINAL_PROMPT = "0";
  return { ...e, ...extra };
}

function buildEvidenceGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return buildGitEnv({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "codex-bridge",
    GIT_AUTHOR_EMAIL: "codex-bridge@local",
    GIT_COMMITTER_NAME: "codex-bridge",
    GIT_COMMITTER_EMAIL: "codex-bridge@local",
    ...extra,
  });
}

// Safe flags disabling hooks, textconv, external diff, and smudge/clean filters on private evidence store calls.
const EVIDENCE_GIT_FLAGS = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.autocrlf=false",
  "-c", "core.safecrlf=false",
  "-c", "diff.external=",
];

// ── cwd / Git Root ───────────────────────────────────────────────
export function normalizeCwd(input: string): string {
  if (!path.isAbsolute(input)) throw new Error(`cwd must be absolute: ${input}`);
  const r = realpathSync(input);
  if (!statSync(r).isDirectory()) throw new Error(`cwd must be a directory: ${input}`);
  return r;
}
export function git(cwd: string, args: string[], envExtra: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_GIT_BUFFER, env: buildGitEnv(envExtra), stdio: ["ignore", "pipe", "pipe"] });
}
export function gitBare(gitDir: string, args: string[], opts?: { input?: string | Buffer; env?: Record<string, string> }): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", [...EVIDENCE_GIT_FLAGS, "--git-dir", gitDir, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
    env: buildEvidenceGitEnv(opts?.env),
    input: opts?.input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
export function gitBareBuffer(gitDir: string, args: string[], envExtra: Record<string, string> = {}): Buffer {
  const r = spawnSync("git", [...EVIDENCE_GIT_FLAGS, "--git-dir", gitDir, ...args], {
    maxBuffer: MAX_GIT_BUFFER,
    env: buildEvidenceGitEnv(envExtra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.slice(0, 3).join(" ")} failed (${r.status}): ${(r.stderr || "").toString("utf8").trim()}`);
  }
  return r.stdout as Buffer;
}
export function isGitRepo(cwd: string): boolean {
  try { return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
}
export function getGitRoot(cwd: string): string {
  return normalizeCwd(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
}
export function getGitDir(cwd: string): string {
  const r = git(cwd, ["rev-parse", "--git-dir"]).trim();
  return path.isAbsolute(r) ? r : path.resolve(cwd, r);
}
export function getRepoObjectDir(cwd: string): string {
  const r = git(cwd, ["rev-parse", "--git-path", "objects"]).trim();
  return path.isAbsolute(r) ? r : path.resolve(cwd, r);
}
export function resolveExecContext(cwd: string): ExecContext {
  const g = isGitRepo(cwd);
  return { runCwd: cwd, gitRoot: g ? getGitRoot(cwd) : cwd, gitRepo: g };
}

// ── Legacy Write Lock (preserved for inplace compat & unit tests) ─
export function lockKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}
export function readLock(lp: string): LockPayload | undefined {
  try { return JSON.parse(readFileSync(lp, "utf8")); } catch { return undefined; }
}
export function writeAtomic(fp: string, p: unknown) {
  const t = `${fp}.${process.pid}.tmp`;
  writeFileSync(t, JSON.stringify(p), { mode: 0o600 });
  renameSync(t, fp);
}
export function lockAlive(p: LockPayload | undefined): boolean {
  if (!p) return false;
  if (typeof p.bridgePid === "number" && pidAlive(p.bridgePid) && pidLooksLikeBridgeWorker(p.bridgePid, p.runId)) return true;
  if (typeof p.childPid === "number" && pidAlive(p.childPid) && pidLooksLikeCodexForRun(p.childPid, p.runId)) return true;
  return false;
}
export function acquireWriteLock(cwd: string, runId: string): WriteLock {
  const lp = path.join(tmpdir(), `codex-bridge-write-${lockKey(cwd)}.lock`);
  const pl: LockPayload = { bridgePid: process.pid, runId, cwd, createdAt: new Date().toISOString() };
  for (let a = 0; a < 2; a++) {
    try {
      const fd = openSync(lp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(pl)); } finally { closeSync(fd); }
      return {
        lockPath: lp, runId,
        attachChildPid(cp: number) {
          try { const c = readLock(lp); if (c?.bridgePid === process.pid && c?.runId === runId) writeAtomic(lp, { ...c, childPid: cp }); } catch {}
        },
        release() { try { const c = readLock(lp); if (c?.bridgePid === process.pid && c?.runId === runId) unlinkSync(lp); } catch {} },
      };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (!lockAlive(readLock(lp))) { try { unlinkSync(lp); continue; } catch {} }
      throw new Error(`Another codex-bridge process is writing: ${cwd}`);
    }
  }
  throw new Error(`Could not acquire write lock: ${cwd}`);
}
export function checkWriteLockConflict(cwd: string): string | undefined {
  const lp = path.join(tmpdir(), `codex-bridge-write-${lockKey(cwd)}.lock`);
  const p = readLock(lp);
  if (!p) return undefined;
  if (lockAlive(p)) return `Another codex-bridge process is writing: ${cwd} (run: ${p.runId})`;
  try { unlinkSync(lp); } catch {}
  return undefined;
}

// ── Git Helpers ──────────────────────────────────────────────────
export function getWorktreeStatus(cwd: string): StatusFile[] {
  try {
    const r = git(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
    const p = r.split("\0").filter(Boolean);
    const f: StatusFile[] = [];
    for (let i = 0; i < p.length; i++) {
      const xy = p[i].slice(0, 2);
      const pp = p[i].slice(3);
      if (xy.includes("R") || xy.includes("C")) i++;
      f.push({ xy, path: pp });
    }
    return f;
  } catch { return []; }
}
export function getUntrackedStats(cwd: string, limit = Infinity): { count: number; totalBytes: number; largest: { path: string; bytes: number }[]; stoppedEarly: boolean } {
  let r = "";
  try { r = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]); }
  catch (e: any) { throw new Error(`Unable to enumerate untracked files; snapshot safety cannot be verified. ${String(e?.message || e).slice(0, 300)}`); }
  const fs = r.split("\0").filter(Boolean);
  let tb = 0; let se = false;
  const lg: { path: string; bytes: number }[] = [];
  for (const p of fs) {
    try {
      const s = statSync(path.join(cwd, p));
      if (!s.isFile()) continue;
      tb += s.size;
      lg.push({ path: p, bytes: s.size });
      if (tb > limit) { se = true; break; }
    } catch {}
  }
  lg.sort((a, b) => b.bytes - a.bytes);
  return { count: fs.length, totalBytes: tb, largest: lg.slice(0, 10), stoppedEarly: se };
}
export function assertSnapshotSafe(cwd: string, maxMb: number, maxFiles = 20_000) {
  const l = maxMb * 1024 * 1024;
  const s = getUntrackedStats(cwd, l);
  if (s.count > maxFiles) throw new Error(`Untracked file count ${s.count} exceeds ${maxFiles}. Add to .gitignore or set allow_large_untracked_snapshot=true.`);
  if (s.totalBytes > l) throw new Error(`Untracked files exceed ${maxMb}MB. Add to .gitignore or set allow_large_untracked_snapshot=true. Largest: ${s.largest.slice(0, 3).map((x) => `${x.path}(${Math.round(x.bytes / 1024 / 1024)}MB)`).join(", ")}`);
}

// ── v3 Out-of-Band Evidence Store & Independent Snapshot Repo ────
export function initEvidenceStore(evidenceGitDir: string): void {
  ensureDir(evidenceGitDir);
  const init = gitBare(evidenceGitDir, ["init", "--bare", "-q"]);
  if (init.status !== 0) throw new Error(`initEvidenceStore failed: ${init.stderr.trim()}`);
  gitBare(evidenceGitDir, ["config", "core.fsync", "loose-object,pack,derived-metadata"]);
  gitBare(evidenceGitDir, ["config", "core.fsyncMethod", "fsync"]);
  gitBare(evidenceGitDir, ["config", "gc.auto", "0"]);
}

function walkPlainFiles(rootDir: string, prefix = ""): string[] {
  const out: string[] = [];
  const cur = prefix ? path.join(rootDir, prefix) : rootDir;
  let entries;
  try { entries = readdirSync(cur, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkPlainFiles(rootDir, rel));
    else out.push(rel);
  }
  return out;
}

function enumerateCapturePaths(dir: string, extraForcePaths: string[] = []): string[] {
  const pathSet = new Set<string>();
  if (isGitRepo(dir)) {
    const r = spawnSync("git", ["-C", dir, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8", maxBuffer: MAX_GIT_BUFFER, env: buildGitEnv(), stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status === 0 && r.stdout) {
      for (const p of r.stdout.split("\0")) {
        if (p && p !== ".git" && !p.startsWith(".git/")) pathSet.add(p);
      }
    } else {
      for (const p of walkPlainFiles(dir)) pathSet.add(p);
    }
  } else {
    for (const p of walkPlainFiles(dir)) pathSet.add(p);
  }
  // Never allow executor edits to .gitignore to make known origin source files vanish from evidence.
  for (const p of extraForcePaths) {
    if (!p || p === ".git" || p.startsWith(".git/")) continue;
    try {
      lstatSync(path.join(dir, p));
      pathSet.add(p);
    } catch {}
  }
  return [...pathSet].sort();
}

export function listTreePaths(evidenceGitDir: string, treeOid: string): string[] {
  if (treeOid === EMPTY_TREE_OID) return [];
  const r = gitBare(evidenceGitDir, ["ls-tree", "-r", "-z", "--name-only", treeOid]);
  if (r.status !== 0) return [];
  return r.stdout.split("\0").filter(Boolean);
}

/**
 * Capture raw bytes of `srcDir` into the protected bare `evidenceGitDir` using `--no-filters`.
 * Immune to executor git commits, resets, branch switches, `.gitattributes`, or `.gitignore` hiding origin files.
 * Pins the captured tree under `pinRef` so GC cannot prune it.
 */
export function captureTreeIntoEvidence(
  srcDir: string,
  evidenceGitDir: string,
  pinRef: string,
  extraForcePaths: string[] = [],
): string {
  const relPaths = enumerateCapturePaths(srcDir, extraForcePaths);
  const regularSimple: Array<{ rel: string; abs: string; mode: string }> = [];
  const regularSpecial: Array<{ rel: string; abs: string; mode: string }> = [];
  const symlinks: Array<{ rel: string; target: string }> = [];

  for (const rel of relPaths) {
    const abs = path.join(srcDir, rel);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) {
      symlinks.push({ rel, target: readlinkSync(abs) });
    } else if (st.isFile()) {
      const mode = (st.mode & 0o111) !== 0 ? "100755" : "100644";
      if (abs.includes("\n") || abs.startsWith('"')) regularSpecial.push({ rel, abs, mode });
      else regularSimple.push({ rel, abs, mode });
    }
  }

  let treeOid = EMPTY_TREE_OID;
  if (regularSimple.length > 0 || regularSpecial.length > 0 || symlinks.length > 0) {
    const indexLines: string[] = [];

    if (regularSimple.length > 0) {
      const batch = gitBare(evidenceGitDir, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
        input: regularSimple.map((f) => f.abs).join("\n") + "\n",
      });
      if (batch.status !== 0) throw new Error(`hash-object batch failed: ${batch.stderr.trim()}`);
      const oids = batch.stdout.trim().split("\n").filter(Boolean);
      if (oids.length !== regularSimple.length) {
        throw new Error(`hash-object batch count mismatch: expected ${regularSimple.length}, got ${oids.length}`);
      }
      for (let i = 0; i < regularSimple.length; i++) {
        indexLines.push(`${regularSimple[i].mode} ${oids[i]}\t${regularSimple[i].rel}\0`);
      }
    }

    for (const f of regularSpecial) {
      const h = gitBare(evidenceGitDir, ["hash-object", "-w", "--no-filters", "--", f.abs]);
      if (h.status !== 0) throw new Error(`hash-object failed for ${f.rel}: ${h.stderr.trim()}`);
      indexLines.push(`${f.mode} ${h.stdout.trim()}\t${f.rel}\0`);
    }

    for (const s of symlinks) {
      const h = gitBare(evidenceGitDir, ["hash-object", "-w", "--stdin"], { input: s.target });
      if (h.status !== 0) throw new Error(`hash-object symlink failed for ${s.rel}: ${h.stderr.trim()}`);
      indexLines.push(`120000 ${h.stdout.trim()}\t${s.rel}\0`);
    }

    const tmpIdx = path.join(evidenceGitDir, `tmp-idx-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      const u = gitBare(evidenceGitDir, ["update-index", "-z", "--index-info"], {
        input: indexLines.join(""),
        env: { GIT_INDEX_FILE: tmpIdx },
      });
      if (u.status !== 0) throw new Error(`update-index failed: ${u.stderr.trim()}`);
      const wt = gitBare(evidenceGitDir, ["write-tree"], { env: { GIT_INDEX_FILE: tmpIdx } });
      if (wt.status !== 0) throw new Error(`write-tree failed: ${wt.stderr.trim()}`);
      treeOid = wt.stdout.trim();
    } finally {
      try { unlinkSync(tmpIdx); } catch {}
    }
  }

  pinTreeInEvidence(evidenceGitDir, treeOid, pinRef);
  return treeOid;
}

export function pinTreeInEvidence(evidenceGitDir: string, treeOid: string, pinRef: string): void {
  const c = gitBare(evidenceGitDir, ["commit-tree", treeOid, "-m", pinRef]);
  if (c.status !== 0) throw new Error(`commit-tree pin failed: ${c.stderr.trim()}`);
  const commitOid = c.stdout.trim();
  const u = gitBare(evidenceGitDir, ["update-ref", pinRef, commitOid]);
  if (u.status !== 0) throw new Error(`update-ref pin failed: ${u.stderr.trim()}`);
}

function copyFileCowOrRegular(src: string, dst: string): void {
  ensureDir(path.dirname(dst));
  try {
    copyFileSync(src, dst, fsConstants.COPYFILE_FICLONE);
  } catch {
    copyFileSync(src, dst);
  }
}

/**
 * Create an isolated standalone snapshot repository + out-of-band `evidence.git`.
 * Zero shared `.git/refs`, zero shared `.git/config`, zero parent hooks/remotes/alternates.
 * Supports `baseSpec = "working_tree"` (copies current dirty parent checkout excluding sensitive files)
 * or any git ref (default `"HEAD"`).
 */
export function createSnapshotWorkspace(
  parentGitRoot: string,
  workspaceId: string,
  baseSpec = "HEAD",
): WorkspaceMeta {
  const wsRoot = workspaceDir(workspaceId);
  const srcDir = path.join(wsRoot, "src");
  const evidenceGitDir = path.join(wsRoot, "evidence.git");
  ensureDir(wsRoot);
  ensureDir(srcDir);

  const parentDirtyAtCreate = getWorktreeStatus(parentGitRoot).length > 0;
  let originCommit: string | null = null;
  try {
    const refToResolve = baseSpec === "working_tree" ? "HEAD" : baseSpec;
    originCommit = git(parentGitRoot, ["rev-parse", "--verify", `${refToResolve}^{commit}`]).trim();
  } catch (e: any) {
    if (baseSpec !== "working_tree") {
      rmSync(wsRoot, { recursive: true, force: true });
      throw new Error(`Invalid base ref '${baseSpec}': ${String(e?.message || e).trim()}`);
    }
  }

  try {
    if (baseSpec === "working_tree") {
      const relPaths = enumerateCapturePaths(parentGitRoot);
      for (const rel of relPaths) {
        if (isSensitivePath(rel)) continue;
        const src = path.join(parentGitRoot, rel);
        const dst = path.join(srcDir, rel);
        let st;
        try { st = lstatSync(src); } catch { continue; }
        if (st.isSymbolicLink()) {
          ensureDir(path.dirname(dst));
          symlinkSync(readlinkSync(src), dst);
        } else if (st.isFile()) {
          copyFileCowOrRegular(src, dst);
          try { chmodSync(dst, (st.mode & 0o111) !== 0 ? 0o755 : 0o644); } catch {}
        }
      }
    } else if (originCommit) {
      const parentGitDir = getGitDir(parentGitRoot);
      const tmpIdx = path.join(wsRoot, `checkout-idx-${process.pid}-${randomBytes(4).toString("hex")}`);
      try {
        const rt = spawnSync("git", ["-C", parentGitRoot, "read-tree", originCommit], {
          encoding: "utf8",
          env: buildGitEnv({ GIT_INDEX_FILE: tmpIdx }),
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (rt.status !== 0) throw new Error(`read-tree ${originCommit} failed: ${(rt.stderr || "").trim()}`);
        const co = spawnSync("git", ["--git-dir", parentGitDir, "--work-tree", srcDir, "checkout-index", "-a", "-f"], {
          encoding: "utf8",
          env: buildGitEnv({ GIT_INDEX_FILE: tmpIdx }),
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (co.status !== 0) throw new Error(`checkout-index failed: ${(co.stderr || "").trim()}`);
      } finally {
        try { unlinkSync(tmpIdx); } catch {}
      }
    }

    // Initialize standalone Git metadata inside srcDir so Codex's own `git status/diff` works cleanly.
    git(srcDir, ["init", "-q"]);
    git(srcDir, ["config", "user.email", "codex-bridge@local"]);
    git(srcDir, ["config", "user.name", "codex-bridge"]);
    git(srcDir, ["config", "commit.gpgsign", "false"]);
    git(srcDir, ["config", "core.autocrlf", "false"]);
    git(srcDir, ["add", "-A"]);
    git(srcDir, ["commit", "-qm", "codex-bridge snapshot base", "--allow-empty"]);

    // Initialize out-of-band durable evidence object store and seal immutable origin_tree.
    initEvidenceStore(evidenceGitDir);
    const originTree = captureTreeIntoEvidence(srcDir, evidenceGitDir, "refs/codex-bridge/origin");

    const meta: WorkspaceMeta = {
      workspaceId,
      kind: "snapshot",
      parentGitRoot,
      srcDir: realpathSync(srcDir),
      evidenceGitDir: realpathSync(evidenceGitDir),
      baseSpec,
      originCommit,
      originTree,
      parentDirtyAtCreate,
      appliedWatermarks: {},
      createdAt: new Date().toISOString(),
    };
    writeWorkspaceMeta(meta);
    return meta;
  } catch (e) {
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// ── Tree Snapshot (in-place / legacy compat) ─────────────────────
export function snapshotWorktreeTree(cwd: string): TreeSnapshot {
  const d = mkdtempSync(path.join(tmpdir(), "codex-bridge-tree-"));
  const ip = path.join(d, "index");
  const od = path.join(d, "objects");
  mkdirSync(od, { recursive: true });
  const ro = getRepoObjectDir(cwd);
  const env = { GIT_INDEX_FILE: ip, GIT_OBJECT_DIRECTORY: od, GIT_ALTERNATE_OBJECT_DIRECTORIES: ro };
  try {
    try { git(cwd, ["read-tree", "HEAD"], env); } catch { git(cwd, ["read-tree", "--empty"], env); }
    git(cwd, ["add", "-A", "--", "."], env);
    return { tree: git(cwd, ["write-tree"], env).trim(), objectDir: od, cleanupDir: d };
  } catch (e) { rmSync(d, { recursive: true, force: true }); throw e; }
}
export function cleanupSnapshots(...ss: Array<TreeSnapshot | undefined>) {
  for (const s of ss) { if (s) rmSync(s.cleanupDir, { recursive: true, force: true }); }
}
export function treeDiffEnv(cwd: string, b: TreeSnapshot, a: TreeSnapshot): Record<string, string> {
  return { GIT_ALTERNATE_OBJECT_DIRECTORIES: [getRepoObjectDir(cwd), b.objectDir, a.objectDir].join(path.delimiter) };
}

// ── FS Sentinel ──────────────────────────────────────────────────
export function isSensitivePath(p?: string): boolean { return Boolean(p && SENSITIVE_RE.test(p)); }
export function sha256File(ap: string, max = SENSITIVE_HASH_MAX): { sha256: string; truncated: boolean } {
  const fd = openSync(ap, "r");
  try {
    const h = createHash("sha256");
    const b = Buffer.alloc(65536);
    let t = 0;
    while (t < max) { const n = readSync(fd, b, 0, Math.min(b.length, max - t), t); if (n <= 0) break; h.update(b.subarray(0, n)); t += n; }
    const s = statSync(ap);
    return { sha256: h.digest("hex"), truncated: s.size > max };
  } finally { closeSync(fd); }
}
export function fingerprintFile(ap: string): FileFingerprint {
  try {
    const s = statSync(ap);
    if (!s.isFile()) return { exists: true, size: s.size, mtimeMs: s.mtimeMs };
    const h = sha256File(ap);
    return { exists: true, size: s.size, mtimeMs: s.mtimeMs, sha256: h.sha256, hashTruncated: h.truncated };
  } catch { return { exists: false }; }
}
export function snapshotFsSentinel(cwd: string): FsSentinelResult {
  let r = "";
  try { r = git(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...SENSITIVE_PATHSPECS]); }
  catch (e: any) { return { snapshot: {}, warnings: [`Sentinel scan failed; sensitive alias detection may be incomplete: ${String(e?.message || e).slice(0, 300)}`] }; }
  const o: FsSentinelSnapshot = {};
  for (const p of r.split("\0").filter(Boolean)) { if (!isSensitivePath(p)) continue; o[p] = fingerprintFile(path.join(cwd, p)); }
  return { snapshot: o, warnings: [] };
}
export function diffFsSentinel(b: FsSentinelSnapshot, a: FsSentinelSnapshot): FsSentinelChange[] {
  const ks = new Set([...Object.keys(b), ...Object.keys(a)]);
  const ch: FsSentinelChange[] = [];
  for (const p of ks) {
    const x = b[p] || { exists: false };
    const y = a[p] || { exists: false };
    if (!x.exists && y.exists) ch.push({ path: p, kind: "created" });
    else if (x.exists && !y.exists) ch.push({ path: p, kind: "deleted" });
    else if (x.exists && y.exists && (x.size !== y.size || x.sha256 !== y.sha256 || x.mtimeMs !== y.mtimeMs)) ch.push({ path: p, kind: "modified" });
  }
  return ch;
}
export function hasTruncatedSensitiveFp(s: FsSentinelSnapshot): boolean {
  return Object.values(s).some((fp) => fp.exists && fp.hashTruncated);
}

// ── Sensitive Content Alias Detection ────────────────────────────
function fpKey(fp: FileFingerprint | undefined): string | undefined {
  if (!fp?.exists || !fp.sha256 || fp.hashTruncated || fp.size === undefined) return undefined;
  return `${fp.size}:${fp.sha256}`;
}
export function isSensitiveDiffFile(f: DiffFile): boolean { return isSensitivePath(f.path) || isSensitivePath(f.from); }
export function sensitiveDisplayName(f: DiffFile): string { return f.from ? `${f.from} -> ${f.path}` : f.path; }
function buildSensitiveIndex(cwd: string, files: DiffFile[], fsB: FsSentinelSnapshot, fsA: FsSentinelSnapshot): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  function add(src: string, fp: FileFingerprint | undefined) { const k = fpKey(fp); if (!k) return; const a = idx.get(k) || []; a.push(src); idx.set(k, a); }
  for (const [p, fp] of Object.entries(fsB)) add(p, fp);
  for (const [p, fp] of Object.entries(fsA)) add(p, fp);
  for (const f of files) { if (!isSensitiveDiffFile(f)) continue; for (const p of [f.path, f.from].filter(Boolean) as string[]) add(p, fingerprintFile(path.join(cwd, p))); }
  return idx;
}
function buildOversizedIndex(cwd: string, files: DiffFile[], fsB: FsSentinelSnapshot, fsA: FsSentinelSnapshot): Map<number, string[]> {
  const idx = new Map<number, string[]>();
  function add(src: string, fp: FileFingerprint | undefined) { if (!fp?.exists || !fp.hashTruncated || fp.size === undefined) return; const a = idx.get(fp.size) || []; a.push(src); idx.set(fp.size, a); }
  for (const [p, fp] of Object.entries(fsB)) add(p, fp);
  for (const [p, fp] of Object.entries(fsA)) add(p, fp);
  for (const f of files) { if (!isSensitiveDiffFile(f)) continue; for (const p of [f.path, f.from].filter(Boolean) as string[]) add(p, fingerprintFile(path.join(cwd, p))); }
  return idx;
}
export function detectAliases(cwd: string, files: DiffFile[], fsB: FsSentinelSnapshot, fsA: FsSentinelSnapshot): SensitiveAlias[] {
  const exactIdx = buildSensitiveIndex(cwd, files, fsB, fsA);
  const oversizedIdx = buildOversizedIndex(cwd, files, fsB, fsA);
  if (exactIdx.size === 0 && oversizedIdx.size === 0) return [];
  const aliases: SensitiveAlias[] = []; const seen = new Set<string>();
  function push(p: string, src: string, reason: AliasReason) { const id = `${src}\0${p}\0${reason}`; if (seen.has(id)) return; seen.add(id); aliases.push({ path: p, source: src, reason }); }
  for (const f of files) {
    if (isSensitiveDiffFile(f) || f.status.startsWith("D")) continue;
    const abs = path.join(cwd, f.path);
    try {
      const sz = statSync(abs);
      if (!sz.isFile()) continue;
      if (sz.size > SENSITIVE_HASH_MAX) { const osrc = oversizedIdx.get(sz.size); if (osrc?.length) push(f.path, osrc[0], "matches_oversized_sensitive_size"); continue; }
    } catch { continue; }
    const k = fpKey(fingerprintFile(abs)); if (!k) continue;
    const srcs = exactIdx.get(k); if (!srcs?.length) continue;
    push(f.path, srcs[0], "matches_sensitive_content");
  }
  return aliases;
}
export function aliasDisplay(a: SensitiveAlias): string { return `${a.source} -> ${a.path} (${a.reason})`; }

// ── Git Diff (Worktree & Evidence Store) ─────────────────────────
export function parseNameStatusZ(raw: string): DiffFile[] {
  const p = raw.split("\0").filter(Boolean); const f: DiffFile[] = [];
  for (let i = 0; i < p.length;) {
    const s = p[i++]; if (!s) break;
    if (s.startsWith("R") || s.startsWith("C")) { const fr = p[i++]; const to = p[i++]; if (!fr || !to) break; f.push({ status: s, from: fr, path: to }); }
    else { const pp = p[i++]; if (!pp) break; f.push({ status: s, path: pp }); }
  }
  return f;
}
export function gitDiffToFile(cwd: string, args: string[], out: string, envExtra: Record<string, string> = {}) {
  const fd = openSync(out, "w", 0o600);
  try {
    const r = spawnSync("git", args, { cwd, env: buildGitEnv(envExtra), stdio: ["ignore", fd, "pipe"], encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) { const se = typeof r.stderr === "string" ? r.stderr.trim() : ""; throw new Error(`git ${args.slice(0, 3).join(" ")} failed (${r.status})${se ? `: ${se}` : ""}`); }
  } finally { closeSync(fd); }
}
function gitBareDiffToFile(evidenceGitDir: string, args: string[], out: string) {
  const fd = openSync(out, "w", 0o600);
  try {
    const r = spawnSync("git", [...EVIDENCE_GIT_FLAGS, "--git-dir", evidenceGitDir, ...args], {
      env: buildEvidenceGitEnv(), stdio: ["ignore", fd, "pipe"], encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) { const se = typeof r.stderr === "string" ? r.stderr.trim() : ""; throw new Error(`git ${args.slice(0, 3).join(" ")} failed (${r.status})${se ? `: ${se}` : ""}`); }
  } finally { closeSync(fd); }
}
export function readUtf8Prefix(fp: string, max: number): string {
  const fd = openSync(fp, "r");
  try { const b = Buffer.alloc(max + 4); const n = readSync(fd, b, 0, b.length, 0); const d = new StringDecoder("utf8"); return d.write(b.subarray(0, n)) + d.end(); }
  finally { closeSync(fd); }
}
export function appendBounded(cur: string, add: string, max: number): { text: string; full: boolean } {
  if (cur.length >= max) return { text: cur, full: true };
  const room = max - cur.length;
  return { text: cur + add.slice(0, room), full: add.length > room };
}
function buildSmartPreviewCommon(
  renderFileDiff: (f: DiffFile) => string,
  files: DiffFile[],
  diffPath: string,
  maxC: number,
  aliases: SensitiveAlias[] = [],
): { text: string; truncated: boolean; mode: "full" | "review-prioritized" } {
  const fullB = statSync(diffPath).size;
  const aliasSet = new Set(aliases.map((a) => a.path));
  const isOmit = (f: DiffFile) => isSensitiveDiffFile(f) || aliasSet.has(f.path) || Boolean(f.from && aliasSet.has(f.from));
  const omitDisp = [...files.filter(isSensitiveDiffFile).map(sensitiveDisplayName), ...aliases.map(aliasDisplay)];
  const omitted = files.filter(isOmit); const nonOmit = files.filter((f) => !isOmit(f));

  if (fullB === 0 && omitted.length > 0 && nonOmit.length === 0) return { text: `Only sensitive files changed. Content intentionally omitted.\nSensitive files: ${omitDisp.join(", ")}`, truncated: false, mode: "review-prioritized" };
  if (fullB <= maxC) { let t = readUtf8Prefix(diffPath, maxC + 16); if (omitDisp.length > 0) t += `\n\n[Sensitive file content omitted: ${omitDisp.join(", ")}]`; return { text: t, truncated: false, mode: "full" }; }

  const primary = nonOmit.filter((f) => !LOW_VALUE_RE.test(f.path)); const secondary = nonOmit.filter((f) => LOW_VALUE_RE.test(f.path));
  let out = ""; let hit = false;
  function add(s: string) { const r = appendBounded(out, s, maxC); out = r.text; hit = hit || r.full; }
  add([`Diff is large (${fullB} bytes). Review-prioritized preview.`, `Full patch: ${diffPath}`, omitDisp.length ? `Sensitive (content omitted): ${omitDisp.join(", ")}` : "", secondary.length && primary.length ? `Low-value deprioritized: ${secondary.slice(0, LOW_VALUE_HEADER_LIMIT).map((f) => f.path).join(", ")}` : "", ""].filter(Boolean).join("\n"));
  function addFile(f: DiffFile) { if (hit || isOmit(f)) return; add(`\n===== ${f.status} ${f.from ? `${f.from} → ` : ""}${f.path} =====\n`); if (hit) return; try { add(renderFileDiff(f) || "[no textual diff]\n"); } catch { add("[per-file diff unavailable]\n"); } }
  for (const f of primary.slice(0, PRIMARY_PREVIEW_FILE_LIMIT)) addFile(f);
  if (primary.length === 0 && secondary.length > 0) { add("\nNo primary source diff. Showing low-value changes.\n"); for (const f of secondary.slice(0, SECONDARY_PREVIEW_FILE_LIMIT)) addFile(f); }
  if (primary.length === 0 && secondary.length === 0 && omitted.length > 0) add("\nOnly sensitive files changed. Content intentionally omitted.\n");
  const notice = `\n\n...(preview truncated; full patch: ${diffPath})`; if (hit) { if (out.length + notice.length <= maxC) out += notice; else out = out.slice(0, Math.max(0, maxC - notice.length)) + notice; }
  return { text: out, truncated: hit, mode: "review-prioritized" };
}
export function buildSmartDiffPreview(cwd: string, bT: string, aT: string, files: DiffFile[], diffPath: string, maxC: number, envExtra: Record<string, string> = {}, aliases: SensitiveAlias[] = []): { text: string; truncated: boolean; mode: "full" | "review-prioritized" } {
  return buildSmartPreviewCommon(
    (f) => git(cwd, ["diff", "--no-ext-diff", ...DIFF_RENDER_ARGS, bT, aT, "--", ...(f.from ? [f.from, f.path] : [f.path])], envExtra),
    files, diffPath, maxC, aliases,
  );
}
const SENSITIVE_REF_RE = /(["'`])(?:\.\/)?(?:\.env(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+\.env(?:\.[A-Za-z0-9_-]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519|[^"'`\s]+\.(pem|key|p12|pfx|crt))\1/g;

export function detectSensitivePathRefs(diffPath: string, maxBytes = 1_000_000): string[] {
  let text: string;
  try { text = readUtf8Prefix(diffPath, maxBytes); } catch { return []; }
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = SENSITIVE_REF_RE.exec(text))) {
    refs.add(m[0].slice(1, -1));
    if (refs.size >= 20) break;
  }
  return [...refs];
}

export function buildRiskFlags(files: DiffFile[], fullB: number, aliases: SensitiveAlias[] = [], diffPath?: string): string[] {
  const fl: string[] = []; if (fullB > 1_000_000) fl.push("large_diff_over_1mb");
  const s = [...files.filter(isSensitiveDiffFile).map(sensitiveDisplayName), ...aliases.map(aliasDisplay)]; if (s.length) fl.push(`sensitive_paths:${s.join(",")}`);
  const l = files.filter((f) => LOW_VALUE_RE.test(f.path)).map((f) => f.path); if (l.length) fl.push(`lockfile_or_generated:${l.slice(0, 5).join(",")}`);
  if (diffPath) { const refs = detectSensitivePathRefs(diffPath); if (refs.length) fl.push(`sensitive_path_references:${refs.slice(0, 5).join(",")}`); }
  return fl;
}

export function collectDiff(cwd: string, before: TreeSnapshot, after: TreeSnapshot, runDir: string, maxPreview: number, preDirtyCount: number, fsB: FsSentinelSnapshot = {}, fsA: FsSentinelSnapshot = {}): GitDiffResult {
  if (before.tree === after.tree) return { is_git_repo: true, changed: false, summary: "No changes detected", files: [], diff_preview: "", diff_preview_mode: "full", diff_truncated: false, full_diff_bytes: 0, preexisting_dirty_files: preDirtyCount, risk_flags: [] };
  const env = treeDiffEnv(cwd, before, after); const dp = path.join(runDir, "changes.patch");
  const summary = git(cwd, ["diff", "--no-ext-diff", "--stat", ...DIFF_RENDER_ARGS, before.tree, after.tree, "--"], env).trim();
  const files = parseNameStatusZ(git(cwd, ["diff", "--no-ext-diff", "--name-status", "-z", ...DIFF_DETECT_ARGS, before.tree, after.tree, "--"], env));
  const aliases = detectAliases(cwd, files, fsB, fsA);
  const sensitiveFiles = files.filter(isSensitiveDiffFile); const spSet = new Set<string>();
  for (const f of sensitiveFiles) { if (f.from) spSet.add(f.from); spSet.add(f.path); }
  for (const a of aliases) spSet.add(a.path);
  const sp = [...spSet]; const excl = sp.length > 0 ? [".", ...sp.map((p) => `:(exclude,literal)${p}`)] : [];
  const allDisp = [...sensitiveFiles.map(sensitiveDisplayName), ...aliases.map(aliasDisplay)];
  if (excl.length > 1) { gitDiffToFile(cwd, ["diff", "--binary", "--no-ext-diff", ...DIFF_RENDER_ARGS, before.tree, after.tree, "--", ...excl], dp, env); writeFileSync(path.join(runDir, "sensitive-omitted.txt"), allDisp.join("\n") + "\n", { mode: 0o600 }); }
  else { gitDiffToFile(cwd, ["diff", "--binary", "--no-ext-diff", ...DIFF_RENDER_ARGS, before.tree, after.tree, "--"], dp, env); }
  const fullB = statSync(dp).size; const preview = buildSmartDiffPreview(cwd, before.tree, after.tree, files, dp, maxPreview, env, aliases);
  return { is_git_repo: true, changed: true, summary: summary || `${files.length} files changed`, files, diff_preview: preview.text, diff_preview_mode: preview.mode, diff_truncated: preview.truncated, diff_path: dp, full_diff_bytes: fullB, preexisting_dirty_files: preDirtyCount, risk_flags: buildRiskFlags(files, fullB, aliases, dp), sensitive_diff_omitted: allDisp.length > 0 ? allDisp : undefined };
}

/**
 * Collect run diff directly from sealed trees inside the out-of-band `evidence.git`.
 * Completely immune to executor git commit/reset/checkout inside `workDir`.
 */
export function collectEvidenceDiff(
  evidenceGitDir: string,
  workDir: string,
  beforeTree: string,
  afterTree: string,
  runDir: string,
  maxPreview: number,
  preDirtyCount: number,
  fsB: FsSentinelSnapshot = {},
  fsA: FsSentinelSnapshot = {},
): GitDiffResult {
  if (beforeTree === afterTree) {
    return { is_git_repo: true, changed: false, summary: "No changes detected", files: [], diff_preview: "", diff_preview_mode: "full", diff_truncated: false, full_diff_bytes: 0, preexisting_dirty_files: preDirtyCount, risk_flags: [] };
  }
  const dp = path.join(runDir, "changes.patch");
  const statRes = gitBare(evidenceGitDir, ["diff-tree", "--no-ext-diff", "-r", "--stat", ...DIFF_RENDER_ARGS, beforeTree, afterTree, "--"]);
  const summary = statRes.stdout.trim();
  const nsRes = gitBare(evidenceGitDir, ["diff-tree", "--no-ext-diff", "-r", "--name-status", "-z", ...DIFF_DETECT_ARGS, beforeTree, afterTree, "--"]);
  const files = parseNameStatusZ(nsRes.stdout);
  const aliases = existsSync(workDir) ? detectAliases(workDir, files, fsB, fsA) : [];
  const sensitiveFiles = files.filter(isSensitiveDiffFile);
  const spSet = new Set<string>();
  for (const f of sensitiveFiles) { if (f.from) spSet.add(f.from); spSet.add(f.path); }
  for (const a of aliases) spSet.add(a.path);
  const sp = [...spSet];
  const excl = sp.length > 0 ? [".", ...sp.map((p) => `:(exclude,literal)${p}`)] : [];
  const allDisp = [...sensitiveFiles.map(sensitiveDisplayName), ...aliases.map(aliasDisplay)];
  if (excl.length > 1) {
    gitBareDiffToFile(evidenceGitDir, ["diff-tree", "-p", "--binary", "--no-ext-diff", "-r", ...DIFF_RENDER_ARGS, beforeTree, afterTree, "--", ...excl], dp);
    writeFileSync(path.join(runDir, "sensitive-omitted.txt"), allDisp.join("\n") + "\n", { mode: 0o600 });
  } else {
    gitBareDiffToFile(evidenceGitDir, ["diff-tree", "-p", "--binary", "--no-ext-diff", "-r", ...DIFF_RENDER_ARGS, beforeTree, afterTree, "--"], dp);
  }
  const fullB = statSync(dp).size;
  const preview = buildSmartPreviewCommon(
    (f) => gitBare(evidenceGitDir, ["diff-tree", "-p", "--no-ext-diff", "-r", ...DIFF_RENDER_ARGS, beforeTree, afterTree, "--", ...(f.from ? [f.from, f.path] : [f.path])]).stdout,
    files, dp, maxPreview, aliases,
  );
  return {
    is_git_repo: true, changed: true, summary: summary || `${files.length} files changed`,
    files, diff_preview: preview.text, diff_preview_mode: preview.mode, diff_truncated: preview.truncated,
    diff_path: dp, full_diff_bytes: fullB, preexisting_dirty_files: preDirtyCount,
    risk_flags: buildRiskFlags(files, fullB, aliases, dp),
    sensitive_diff_omitted: allDisp.length > 0 ? allDisp : undefined,
  };
}

// ── v3 Private-Store 3-Way Merge (Git 2.38+ compatible) ──────────
export type ThreeWayMergeResult =
  | { ok: true; mergedTree: string }
  | { ok: false; conflicts: string[]; message: string };

export function computeThreeWayMerge(
  evidenceGitDir: string,
  baseTree: string,
  oursTree: string,
  theirsTree: string,
): ThreeWayMergeResult {
  if (baseTree === theirsTree) return { ok: true, mergedTree: oursTree };
  if (baseTree === oursTree) return { ok: true, mergedTree: theirsTree };
  if (oursTree === theirsTree) return { ok: true, mergedTree: oursTree };

  const cb = gitBare(evidenceGitDir, ["commit-tree", baseTree, "-m", "merge-base"]);
  if (cb.status !== 0) throw new Error(`commit-tree base failed: ${cb.stderr.trim()}`);
  const cbOid = cb.stdout.trim();

  const co = gitBare(evidenceGitDir, ["commit-tree", oursTree, "-p", cbOid, "-m", "merge-ours"]);
  if (co.status !== 0) throw new Error(`commit-tree ours failed: ${co.stderr.trim()}`);
  const coOid = co.stdout.trim();

  const cr = gitBare(evidenceGitDir, ["commit-tree", theirsTree, "-p", cbOid, "-m", "merge-theirs"]);
  if (cr.status !== 0) throw new Error(`commit-tree theirs failed: ${cr.stderr.trim()}`);
  const crOid = cr.stdout.trim();

  // Exit code is the SOLE arbiter: 0 = clean merge, 1 = conflict (parent untouched), other = error.
  const m = gitBare(evidenceGitDir, ["merge-tree", "--write-tree", coOid, crOid]);
  if (m.status === 0) {
    const mergedTree = m.stdout.trim().split("\n")[0]?.trim();
    if (!mergedTree || !/^[0-9a-f]{40}$/i.test(mergedTree)) {
      throw new Error(`merge-tree returned invalid tree OID: ${JSON.stringify(m.stdout)}`);
    }
    return { ok: true, mergedTree };
  }
  if (m.status === 1) {
    const conflicts = new Set<string>();
    for (const line of m.stdout.split("\n")) {
      const stageMatch = line.match(/^[0-7]{6} [0-9a-f]{40} [123]\t(.+)$/);
      if (stageMatch) conflicts.add(stageMatch[1]);
      const msgMatch = line.match(/^CONFLICT \([^)]+\): .*?\bin\s+(.+)$/);
      if (msgMatch) conflicts.add(msgMatch[1].trim());
    }
    return {
      ok: false,
      conflicts: [...conflicts],
      message: m.stdout.split("\n").filter((l) => l.startsWith("CONFLICT") || l.startsWith("Auto-merging")).join("\n") || "3-way merge conflict",
    };
  }
  throw new Error(`git merge-tree failed (exit ${m.status}): ${(m.stderr || m.stdout).trim()}`);
}

// ── v3 Safe Delta Planning & Recoverable File Materialization ────
interface TreeEntry { mode: number; type: string; oid: string; path: string }

function parseLsTreeZ(evidenceGitDir: string, treeOid: string): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  if (treeOid === EMPTY_TREE_OID) return map;
  const r = gitBare(evidenceGitDir, ["ls-tree", "-r", "-z", treeOid]);
  if (r.status !== 0) throw new Error(`ls-tree ${treeOid} failed: ${r.stderr.trim()}`);
  for (const rec of r.stdout.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const header = rec.slice(0, tab).split(" ");
    const p = rec.slice(tab + 1);
    if (header.length < 3 || !p) continue;
    map.set(p, { mode: parseInt(header[0], 8), type: header[1], oid: header[2], path: p });
  }
  return map;
}

const ALLOWED_FILE_MODES = new Set([0o100644, 0o100755]);

function assertSafeRelativePath(rel: string): void {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error(`Unsafe target path rejected: ${JSON.stringify(rel)}`);
  }
  const parts = rel.split("/");
  for (const seg of parts) {
    if (!seg || seg === "." || seg === ".." || seg.toLowerCase() === ".git") {
      throw new Error(`Unsafe path segment rejected in ${JSON.stringify(rel)}`);
    }
  }
}

function assertNoSymlinkEscape(targetDir: string, rel: string): void {
  const parts = rel.split("/");
  let cur = targetDir;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = lstatSync(cur); } catch { break; }
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to materialize through symlink: ${parts.slice(0, i + 1).join("/")}`);
    }
    if (i < parts.length - 1 && !st.isDirectory()) {
      throw new Error(`Refusing file/directory type swap at ancestor: ${parts.slice(0, i + 1).join("/")}`);
    }
    if (i === parts.length - 1 && st.isDirectory()) {
      throw new Error(`Refusing directory/file type swap at target: ${rel}`);
    }
  }
}

export function gitBlobOidOfFile(absPath: string): FileObjectRef | null {
  let st;
  try { st = lstatSync(absPath); } catch { return null; }
  if (st.isSymbolicLink() || !st.isFile()) return null;
  const buf = readFileSync(absPath);
  const sha1 = createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
  const mode = (st.mode & 0o111) !== 0 ? 0o100755 : 0o100644;
  return { blob: sha1, mode };
}

function refsMatch(a: FileObjectRef | null, b: FileObjectRef | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.blob === b.blob && a.mode === b.mode;
}

export interface MaterializationPlan {
  entries: ApplyIntentEntry[];
  files: DiffFile[];
  sensitiveOmitted: string[];
}

export function planTreeMaterialization(
  evidenceGitDir: string,
  targetDir: string,
  oursTree: string,
  mergedTree: string,
): MaterializationPlan {
  const oursMap = parseLsTreeZ(evidenceGitDir, oursTree);
  const mergedMap = parseLsTreeZ(evidenceGitDir, mergedTree);
  const allPaths = [...new Set([...oursMap.keys(), ...mergedMap.keys()])].sort();

  const entries: ApplyIntentEntry[] = [];
  const files: DiffFile[] = [];
  const sensitiveOmitted: string[] = [];
  const lowerSeen = new Map<string, string>();

  // Check case-folding collisions across all target paths
  for (const p of mergedMap.keys()) {
    const low = p.toLowerCase();
    const prev = lowerSeen.get(low);
    if (prev && prev !== p) {
      throw new Error(`Case-folding path collision rejected: ${prev} vs ${p}`);
    }
    lowerSeen.set(low, p);
  }

  for (const p of allPaths) {
    const o = oursMap.get(p) ?? null;
    const m = mergedMap.get(p) ?? null;
    if (o && m && o.oid === m.oid && o.mode === m.mode) continue;

    assertSafeRelativePath(p);
    assertNoSymlinkEscape(targetDir, p);

    if (o && !ALLOWED_FILE_MODES.has(o.mode)) {
      throw new Error(`Unsupported file mode (0${o.mode.toString(8)}) for automatic apply: ${p}`);
    }
    if (m && !ALLOWED_FILE_MODES.has(m.mode)) {
      throw new Error(`Unsupported file mode (0${m.mode.toString(8)}) for automatic apply: ${p}`);
    }
    if (isSensitivePath(p)) {
      sensitiveOmitted.push(p);
    }

    const status = !o && m ? "A" : o && !m ? "D" : "M";
    files.push({ status, path: p });
    entries.push({
      path: p,
      old: o ? { blob: o.oid, mode: o.mode } : null,
      next: m ? { blob: m.oid, mode: m.mode } : null,
    });
  }

  // Also check content aliases against targetDir's ignored sensitive files!
  if (entries.length > 0 && isGitRepo(targetDir)) {
    const fsTarget = snapshotFsSentinel(targetDir).snapshot;
    const exactHashes = new Map<string, string>();
    for (const [sp, fp] of Object.entries(fsTarget)) {
      if (fp.exists && fp.sha256 && !fp.hashTruncated && fp.size !== undefined) {
        exactHashes.set(`${fp.size}:${fp.sha256}`, sp);
      }
    }
    if (exactHashes.size > 0) {
      for (const entry of entries) {
        if (!entry.next || isSensitivePath(entry.path)) continue;
        const raw = gitBareBuffer(evidenceGitDir, ["cat-file", "blob", entry.next.blob]);
        const h = createHash("sha256").update(raw).digest("hex");
        const src = exactHashes.get(`${raw.length}:${h}`);
        if (src) sensitiveOmitted.push(`${src} -> ${entry.path} (matches_sensitive_content)`);
      }
    }
  }

  return { entries, files, sensitiveOmitted };
}

function materializeOneEntry(evidenceGitDir: string, targetDir: string, entry: ApplyIntentEntry): void {
  const abs = path.join(targetDir, entry.path);
  assertSafeRelativePath(entry.path);
  assertNoSymlinkEscape(targetDir, entry.path);

  if (entry.next === null) {
    try { unlinkSync(abs); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
    // Prune empty parent directories up to targetDir
    let dir = path.dirname(abs);
    while (dir.startsWith(targetDir) && dir !== targetDir) {
      try {
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: false });
        else break;
      } catch { break; }
      dir = path.dirname(dir);
    }
    return;
  }

  const content = gitBareBuffer(evidenceGitDir, ["cat-file", "blob", entry.next.blob]);
  const parentDir = path.dirname(abs);
  mkdirSync(parentDir, { recursive: true });
  const tmp = `${abs}.cb-apply.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fileMode = entry.next.mode === 0o100755 ? 0o755 : 0o644;
  const fd = openSync(tmp, "wx", fileMode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } catch (e) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  closeSync(fd);
  try { chmodSync(tmp, fileMode); } catch {}
  renameSync(tmp, abs);
  fsyncDirBestEffort(parentDir);
}

/**
 * Execute or recover a persisted `ApplyIntent`.
 * - Single-file atomic replacement (temp file → fsync → rename).
 * - Multi-file crash-recoverable: on recovery, entries matching `next` are skipped,
 *   entries matching `old` are completed, and any unexpected 3rd-party modification stops
 *   immediately with `CONFLICT_DURING_RECOVERY` without overwriting external edits.
 */
export function executeOrRecoverApplyIntent(
  intent: ApplyIntent,
  opts?: { faultAfterIndex?: number },
): { ok: true; intent: ApplyIntent } | { ok: false; intent: ApplyIntent; conflictPath?: string; error: string } {
  if (intent.status === "COMMITTED") return { ok: true, intent };

  for (let i = 0; i < intent.entries.length; i++) {
    const entry = intent.entries[i];
    const abs = path.join(intent.targetDir, entry.path);
    const current = gitBlobOidOfFile(abs);

    if (refsMatch(current, entry.next)) continue;

    if (!refsMatch(current, entry.old)) {
      const failed: ApplyIntent = {
        ...intent,
        status: "CONFLICT_DURING_RECOVERY",
        conflictPath: entry.path,
        error: `External modification detected on ${entry.path} during apply/recovery; refusing to overwrite.`,
        updatedAt: new Date().toISOString(),
      };
      writeApplyIntent(failed);
      return { ok: false, intent: failed, conflictPath: entry.path, error: failed.error! };
    }

    materializeOneEntry(intent.evidenceGitDir, intent.targetDir, entry);

    // Deterministic chaos fault hook for testing mid-apply crash recovery
    if (opts?.faultAfterIndex !== undefined && i === opts.faultAfterIndex) {
      throw new Error(`Injected apply crash after entry ${i} (${entry.path})`);
    }
  }

  // Final verification pass: confirm every entry matches `next`
  for (const entry of intent.entries) {
    const abs = path.join(intent.targetDir, entry.path);
    const current = gitBlobOidOfFile(abs);
    if (!refsMatch(current, entry.next)) {
      const failed: ApplyIntent = {
        ...intent,
        status: "CONFLICT_DURING_RECOVERY",
        conflictPath: entry.path,
        error: `Post-write verification mismatch on ${entry.path}.`,
        updatedAt: new Date().toISOString(),
      };
      writeApplyIntent(failed);
      return { ok: false, intent: failed, conflictPath: entry.path, error: failed.error! };
    }
  }

  const committed: ApplyIntent = {
    ...intent,
    status: "COMMITTED",
    updatedAt: new Date().toISOString(),
  };
  writeApplyIntent(committed);
  return { ok: true, intent: committed };
}

export function prepareApplyIntent(params: {
  runId: string;
  workspaceId: string;
  targetDir: string;
  evidenceGitDir: string;
  baseTree: string;
  oursTree: string;
  resultTree: string;
  mergedTree: string;
  entries: ApplyIntentEntry[];
}): ApplyIntent {
  const now = new Date().toISOString();
  const intent: ApplyIntent = {
    operationId: randomUUID(),
    runId: params.runId,
    workspaceId: params.workspaceId,
    targetDir: params.targetDir,
    targetHash: resourceKey(params.targetDir),
    evidenceGitDir: params.evidenceGitDir,
    status: "PREPARED",
    baseTree: params.baseTree,
    oursTree: params.oursTree,
    resultTree: params.resultTree,
    mergedTree: params.mergedTree,
    entries: params.entries,
    createdAt: now,
    updatedAt: now,
  };
  // Pin merged tree before persisting intent so objects remain durable across crashes
  pinTreeInEvidence(params.evidenceGitDir, params.mergedTree, `refs/codex-bridge/applies/${intent.operationId}`);
  writeApplyIntent(intent);
  return intent;
}

export function exportWorktreePatch(worktreePath: string, outPath: string): { changed: boolean; files: DiffFile[]; sensitiveOmitted: string[] } {
  const after = snapshotWorktreeTree(worktreePath);
  try {
    let headTree: string;
    try { headTree = git(worktreePath, ["rev-parse", "HEAD^{tree}"]).trim(); }
    catch { headTree = EMPTY_TREE_OID; }
    if (headTree === after.tree) return { changed: false, files: [], sensitiveOmitted: [] };
    const env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: [getRepoObjectDir(worktreePath), after.objectDir].join(path.delimiter) };
    const files = parseNameStatusZ(git(worktreePath, ["diff", "--no-ext-diff", "--name-status", "-z", ...DIFF_DETECT_ARGS, headTree, after.tree, "--"], env));
    const fsA = snapshotFsSentinel(worktreePath).snapshot;
    const aliases = detectAliases(worktreePath, files, {}, fsA);
    const sensitiveFiles = files.filter(isSensitiveDiffFile);
    const sensitiveOmitted = [...sensitiveFiles.map(sensitiveDisplayName), ...aliases.map(aliasDisplay)];
    if (sensitiveOmitted.length > 0) return { changed: true, files, sensitiveOmitted };
    gitDiffToFile(worktreePath, ["diff", "--binary", "--no-ext-diff", ...DIFF_RENDER_ARGS, headTree, after.tree, "--"], outPath, env);
    return { changed: true, files, sensitiveOmitted: [] };
  } finally {
    cleanupSnapshots(after);
  }
}

// ── Process ──────────────────────────────────────────────────────
export function killTree(proc: ChildProcess, sig: NodeJS.Signals = "SIGTERM") {
  if (!proc.pid) return;
  try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} }
}
export function killPidTree(pid: number, sig: NodeJS.Signals = "SIGTERM") {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

export function pidParent(pid: number): number | undefined {
  try {
    const s = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4096 }).trim();
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

export function pidDescendantOf(pid: number, ancestorPid: number, maxDepth = 10): boolean {
  let cur = pid;
  for (let i = 0; i < maxDepth; i++) {
    const p = pidParent(cur);
    if (!p || p === cur) return false;
    if (p === ancestorPid) return true;
    cur = p;
  }
  return false;
}
export function pidCommand(pid: number): string {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4096 }).trim(); } catch { return ""; }
}
export function pidLooksLikeCodex(pid: number): boolean {
  const cmd = pidCommand(pid);
  if (!cmd) return false;
  return cmd.includes(CODEX_BINARY)
    || Boolean(CODEX_BINARY_REALPATH && cmd.includes(CODEX_BINARY_REALPATH))
    || cmd.includes("/Codex.app/Contents/Resources/codex")
    || /(?:^|\s)codex(?:\s|$)/i.test(cmd);
}
export function pidLooksLikeCodexForRun(pid: number, runIdOrRunDir: string): boolean {
  const cmd = pidCommand(pid);
  if (!cmd) return false;
  const isCodex = cmd.includes(CODEX_BINARY)
    || Boolean(CODEX_BINARY_REALPATH && cmd.includes(CODEX_BINARY_REALPATH))
    || cmd.includes("/Codex.app/Contents/Resources/codex")
    || /(?:^|\s)codex(?:\s|$)/i.test(cmd);
  return isCodex && cmd.includes(runIdOrRunDir);
}
export function pidLooksLikeBridgeWorker(pid: number, runId?: string): boolean {
  const cmd = pidCommand(pid);
  if (!cmd) return false;
  const looksLikeWorker = cmd.includes("codex-bridge") || cmd.includes("worker.js") || cmd.includes("worker.ts");
  return looksLikeWorker && (!runId || cmd.includes(runId));
}
export function sanitize(msg: string): string {
  return msg
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-***")
    .replace(/ghp_[A-Za-z0-9_]{20,}/g, "ghp_***")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
    .replace(/xox[baprs]-[A-Za-z0-9-]{20,}/g, "xox*-***")
    .replace(/AKIA[0-9A-Z]{16}/g, "AKIA***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(/(OPENAI_API_KEY|CODEX_API_KEY|GITHUB_TOKEN|API_KEY|SECRET|TOKEN|PASSWORD)=\S+/gi, "$1=***")
    .slice(0, 500);
}

// ── JSONL Utilities ──────────────────────────────────────────────
export function pushCap<T>(a: T[], v: T, m: number) { a.push(v); if (a.length > m) a.splice(0, a.length - m); }
export function pushUniqCap(a: string[], v: string, m: number) { if (!a.includes(v)) a.push(v); if (a.length > m) a.splice(0, a.length - m); }
export function appendCap(cur: string, next: string, max: number): { text: string; truncated: boolean } {
  const c = cur + next; if (c.length <= max) return { text: c, truncated: false };
  const r = Math.max(0, max - TRUNCATED_TAIL_MARKER.length);
  return { text: TRUNCATED_TAIL_MARKER + c.slice(-r), truncated: true };
}
export function checkJsonlHealth(ev: EventSummary, sessionId: string): string | undefined {
  const total = Object.values(ev.counts).reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;
  const known = [...KNOWN_JSONL_TYPES].reduce((a, t) => a + (ev.counts[t] || 0), 0);
  const unknownRatio = 1 - known / total;
  if (!sessionId && total > 0) return `Codex JSONL schema may have changed: no thread.started received (${total} events, ${known} recognized).`;
  if (unknownRatio > 0.5 && total >= 5) return `Codex JSONL schema may have changed: ${Math.round(unknownRatio * 100)}% of ${total} events are unrecognized types.`;
  return undefined;
}

// ── Helpers ──────────────────────────────────────────────────────
export function readCapped(p: string, max: number): { text: string; truncated: boolean } | undefined {
  try {
    if (!existsSync(p)) return undefined;
    const s = statSync(p);
    if (s.size <= max) return { text: readUtf8Prefix(p, max), truncated: false };
    const r = Math.max(0, max - TRUNCATED_HEAD_MARKER.length);
    return { text: readUtf8Prefix(p, r) + TRUNCATED_HEAD_MARKER, truncated: true };
  } catch { return undefined; }
}
export function cmdOk(c: string, a: string[] = [], opts?: { env?: NodeJS.ProcessEnv; timeout?: number }) {
  try {
    const r = spawnSync(c, a, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      timeout: opts?.timeout ?? 10_000,
      ...(opts?.env ? { env: opts.env } : {}),
    });
    if (r.error) return { ok: false, error: r.error.message || String(r.error) };
    if (r.status !== 0) return { ok: false, error: (r.stderr || "").trim() || (r.stdout || "").trim() || `exit ${r.status}` };
    return { ok: true, output: (r.stdout || "").trim() || (r.stderr || "").trim() };
  } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}
export function cleanOldTmpDirs(max = 7 * 24 * 60 * 60 * 1000) {
  try {
    const now = Date.now();
    for (const n of readdirSync(tmpdir())) {
      if (!n.startsWith("codex-bridge-") || n.startsWith("codex-bridge-write-")) continue;
      const p = path.join(tmpdir(), n);
      try { const s = statSync(p); if (s.isDirectory() && now - s.mtimeMs > max) rmSync(p, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}
