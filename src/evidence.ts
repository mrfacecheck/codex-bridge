import { spawnSync, execFileSync, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync,
  realpathSync, readdirSync, openSync, closeSync, readSync, unlinkSync, renameSync,
} from "fs";
import { tmpdir } from "os";
import { createHash } from "crypto";
import path from "path";
import {
  MAX_GIT_BUFFER, TRUNCATED_TAIL_MARKER, TRUNCATED_HEAD_MARKER,
  DIFF_DETECT_ARGS, DIFF_RENDER_ARGS, SENSITIVE_HASH_MAX, SENSITIVE_RE,
  SENSITIVE_PATHSPECS, LOW_VALUE_RE, KNOWN_JSONL_TYPES, SAFE_ENV,
  PRIMARY_PREVIEW_FILE_LIMIT, SECONDARY_PREVIEW_FILE_LIMIT, LOW_VALUE_HEADER_LIMIT,
  type ExecContext, type LockPayload, type WriteLock, type StatusFile,
  type TreeSnapshot, type FsSentinelResult, type FileFingerprint, type FsSentinelSnapshot,
  type FsSentinelChange, type AliasReason, type SensitiveAlias, type DiffFile,
  type GitDiffResult, type NoGitResult, type EventSummary,
} from "./types.js";

// ── Codex Binary ──────────────────────────────────────────────────
export function resolveCodexBinary(): string {
  if (process.env.CODEX_BINARY && existsSync(process.env.CODEX_BINARY)) return process.env.CODEX_BINARY;
  const p = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(p)) return p;
  return "codex";
}
export const CODEX_BINARY = resolveCodexBinary();

// ── Env ──────────────────────────────────────────────────────────
export function buildSafeEnv(keys: Set<string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const k of keys) { if (process.env[k]) e[k] = process.env[k]; }
  e.PATH ||= "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return e;
}
export function buildCodexEnv(): NodeJS.ProcessEnv {
  const e = buildSafeEnv(SAFE_ENV);
  // Mirror proxy env vars: derive missing variants from what's available.
  // Codex CLI reads uppercase for its own API connection (HTTP CONNECT → WSS),
  // Codex network-proxy reads both cases for sandbox child processes.
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
export function isGitRepo(cwd: string): boolean {
  try { return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"; } catch { return false; }
}
export function getGitRoot(cwd: string): string {
  return normalizeCwd(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
}
export function getRepoObjectDir(cwd: string): string {
  const r = git(cwd, ["rev-parse", "--git-path", "objects"]).trim();
  return path.isAbsolute(r) ? r : path.resolve(cwd, r);
}
export function resolveExecContext(cwd: string): ExecContext {
  const g = isGitRepo(cwd);
  return { runCwd: cwd, gitRoot: g ? getGitRoot(cwd) : cwd, gitRepo: g };
}

// ── Write Lock ───────────────────────────────────────────────────
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

// ── Tree Snapshot ────────────────────────────────────────────────
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

// ── Git Diff ─────────────────────────────────────────────────────
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
export function buildSmartDiffPreview(cwd: string, bT: string, aT: string, files: DiffFile[], diffPath: string, maxC: number, envExtra: Record<string, string> = {}, aliases: SensitiveAlias[] = []): { text: string; truncated: boolean; mode: "full" | "review-prioritized" } {
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
  function addFile(f: DiffFile) { if (hit || isOmit(f)) return; add(`\n===== ${f.status} ${f.from ? `${f.from} → ` : ""}${f.path} =====\n`); if (hit) return; try { add(git(cwd, ["diff", "--no-ext-diff", ...DIFF_RENDER_ARGS, bT, aT, "--", ...(f.from ? [f.from, f.path] : [f.path])], envExtra) || "[no textual diff]\n"); } catch { add("[per-file diff unavailable]\n"); } }
  for (const f of primary.slice(0, PRIMARY_PREVIEW_FILE_LIMIT)) addFile(f);
  if (primary.length === 0 && secondary.length > 0) { add("\nNo primary source diff. Showing low-value changes.\n"); for (const f of secondary.slice(0, SECONDARY_PREVIEW_FILE_LIMIT)) addFile(f); }
  if (primary.length === 0 && secondary.length === 0 && omitted.length > 0) add("\nOnly sensitive files changed. Content intentionally omitted.\n");
  const notice = `\n\n...(preview truncated; full patch: ${diffPath})`; if (hit) { if (out.length + notice.length <= maxC) out += notice; else out = out.slice(0, Math.max(0, maxC - notice.length)) + notice; }
  return { text: out, truncated: hit, mode: "review-prioritized" };
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
  if (excl.length > 1) { gitDiffToFile(cwd, ["diff", "--no-ext-diff", ...DIFF_RENDER_ARGS, before.tree, after.tree, "--", ...excl], dp, env); writeFileSync(path.join(runDir, "sensitive-omitted.txt"), allDisp.join("\n") + "\n", { mode: 0o600 }); }
  else { gitDiffToFile(cwd, ["diff", "--no-ext-diff", ...DIFF_RENDER_ARGS, before.tree, after.tree, "--"], dp, env); }
  const fullB = statSync(dp).size; const preview = buildSmartDiffPreview(cwd, before.tree, after.tree, files, dp, maxPreview, env, aliases);
  return { is_git_repo: true, changed: true, summary: summary || `${files.length} files changed`, files, diff_preview: preview.text, diff_preview_mode: preview.mode, diff_truncated: preview.truncated, diff_path: dp, full_diff_bytes: fullB, preexisting_dirty_files: preDirtyCount, risk_flags: buildRiskFlags(files, fullB, aliases, dp), sensitive_diff_omitted: allDisp.length > 0 ? allDisp : undefined };
}

// ── Process ──────────────────────────────────────────────────────
export function killTree(proc: ChildProcess, sig: NodeJS.Signals = "SIGTERM") {
  if (!proc.pid) return;
  try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} }
}
export function killPidTree(pid: number, sig: NodeJS.Signals = "SIGTERM") {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}
export function pidCommand(pid: number): string {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4096 }).trim(); } catch { return ""; }
}
export function pidLooksLikeCodex(pid: number): boolean {
  const cmd = pidCommand(pid);
  if (!cmd) return false;
  return cmd.includes(CODEX_BINARY) || cmd.includes("/Codex.app/Contents/Resources/codex") || /(?:^|\s)codex(?:\s|$)/i.test(cmd);
}
export function pidLooksLikeCodexForRun(pid: number, runIdOrRunDir: string): boolean {
  const cmd = pidCommand(pid);
  if (!cmd) return false;
  const isCodex = cmd.includes(CODEX_BINARY) || cmd.includes("/Codex.app/Contents/Resources/codex") || /(?:^|\s)codex(?:\s|$)/i.test(cmd);
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
export function cmdOk(c: string, a: string[] = []) {
  try { return { ok: true, output: execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 }).trim() }; }
  catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
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
