import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
  statSync, renameSync, chmodSync, openSync, closeSync, fsyncSync, unlinkSync,
} from "fs";
import { execFile, execFileSync } from "child_process";
import { createHash, randomBytes, randomUUID } from "crypto";
import { homedir } from "os";
import path from "path";
import type {
  ApplyIntent, IdempotencyRecord, LeaseRecord, Liveness, RunMeta,
  SessionRecord, StartedRecord, TombstoneRecord, WorkspaceMeta,
} from "./types.js";

// ── Directory Roots ──────────────────────────────────────────────
export const BASE_DIR = process.env.CODEX_BRIDGE_HOME ?? path.join(homedir(), ".codex-bridge");
export const RUNS_DIR = path.join(BASE_DIR, "runs");
export const PROJECTS_DIR = path.join(BASE_DIR, "projects");
export const SESSIONS_DIR = path.join(BASE_DIR, "sessions");
export const WORKSPACES_DIR = path.join(BASE_DIR, "workspaces");
export const LOCKS_DIR = path.join(BASE_DIR, "locks");
export const APPLIES_DIR = path.join(BASE_DIR, "applies");
export const IDEMPOTENCY_DIR = path.join(BASE_DIR, "idempotency");
export const TOMBSTONES_DIR = path.join(BASE_DIR, "tombstones");
export const WT_DIR = path.join(BASE_DIR, "wt"); // legacy linked-worktree dir

// ── Filesystem & Durability Primitives ───────────────────────────
export function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try { chmodSync(d, 0o700); } catch {}
}

export function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* Directory fsync not supported on all platforms/FS */ }
}

/**
 * Durable atomic JSON publication:
 *   write temp file (0600) → fsync file → close → rename → best-effort dir fsync.
 * Use for durability boundaries: request, started, session, review, workspace, apply intent, lease.
 */
export function writeJsonDurable(fp: string, data: unknown): void {
  ensureDir(path.dirname(fp));
  const tmp = `${fp}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(data, null, 2) + "\n";
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
  } catch (e) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, fp);
  fsyncDirBestEffort(path.dirname(fp));
}

/**
 * Fast atomic JSON replacement without fsync.
 * Use ONLY for rebuildable high-frequency projections (progress.json heartbeats).
 */
export function writeJsonFast(fp: string, data: unknown): void {
  ensureDir(path.dirname(fp));
  const tmp = `${fp}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, fp);
}

export function readJson<T>(fp: string): T | null {
  try { return JSON.parse(readFileSync(fp, "utf8")) as T; } catch { return null; }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function requestDigest(payload: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(payload)));
}

// ── Boot Identity (cached once per process) ──────────────────────
let cachedBootId: string | undefined;
export function currentBootId(): string {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    if (process.platform === "linux" && existsSync("/proc/sys/kernel/random/boot_id")) {
      cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return cachedBootId;
    }
    if (process.platform === "darwin") {
      const out = execFileSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
      if (out) {
        cachedBootId = sha256Hex(out).slice(0, 24);
        return cachedBootId;
      }
    }
  } catch {}
  cachedBootId = "unknown-boot";
  return cachedBootId;
}

// ── Process Probing (Honest EPERM + Async Cold-Path) ─────────────
export function pidExistsState(pid: number): "alive" | "gone" | "eperm" {
  if (!Number.isInteger(pid) || pid <= 0) return "gone";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e: any) {
    if (e?.code === "ESRCH") return "gone";
    if (e?.code === "EPERM") return "eperm";
    return "gone";
  }
}

export function psCommandSync(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8192,
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

export function psCommandAsync(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      maxBuffer: 8192,
      timeout: 3000,
    }, (err, stdout) => {
      if (err) resolve(null);
      else resolve((stdout || "").trim());
    });
  });
}

export function commandMatchesWorker(cmd: string, runId?: string): boolean {
  if (!cmd) return false;
  const looksWorker = cmd.includes("codex-bridge") || cmd.includes("worker.js") || cmd.includes("worker.ts");
  return looksWorker && (!runId || cmd.includes(runId));
}

export function commandMatchesCodex(cmd: string, runId?: string): boolean {
  if (!cmd) return false;
  const looksCodex = cmd.includes("codex") || cmd.includes("stub-codex");
  return looksCodex && (!runId || cmd.includes(runId));
}

/**
 * Determine honest liveness of a recorded PID given bootId & identity predicate.
 * - Different bootId (both non-unknown) → strong proof process is `gone`.
 * - ESRCH → `gone`.
 * - EPERM → `unknown` (never treated as gone!).
 * - Alive PID with command NOT matching expected process → PID was reused → `gone`.
 * - Alive PID whose command cannot be read → `unknown`.
 */
export function probePidLivenessSync(
  pid: number | undefined,
  bootId: string | undefined,
  matcher: (cmd: string) => boolean,
): Liveness {
  if (!pid) return "gone";
  const curBoot = currentBootId();
  if (bootId && bootId !== "unknown-boot" && curBoot !== "unknown-boot" && bootId !== curBoot) {
    return "gone";
  }
  const st = pidExistsState(pid);
  if (st === "gone") return "gone";
  if (st === "eperm") return "unknown";
  const cmd = psCommandSync(pid);
  if (cmd === null) return "unknown";
  if (!cmd) return "gone";
  return matcher(cmd) ? "alive" : "gone";
}

export async function probePidLivenessAsync(
  pid: number | undefined,
  bootId: string | undefined,
  matcher: (cmd: string) => boolean,
): Promise<Liveness> {
  if (!pid) return "gone";
  const curBoot = currentBootId();
  if (bootId && bootId !== "unknown-boot" && curBoot !== "unknown-boot" && bootId !== curBoot) {
    return "gone";
  }
  const st = pidExistsState(pid);
  if (st === "gone") return "gone";
  if (st === "eperm") return "unknown";
  const cmd = await psCommandAsync(pid);
  if (cmd === null) return "unknown";
  if (!cmd) return "gone";
  return matcher(cmd) ? "alive" : "gone";
}

// ── Idempotency & Tombstones (At-Most-Once Admission) ────────────
function idempotencyHash(namespace: "exec" | "resume" | "apply", key: string): string {
  return sha256Hex(`${namespace}:${key}`).slice(0, 32);
}

export type IdempotencyClaimResult =
  | { kind: "claimed"; record: IdempotencyRecord }
  | { kind: "existing"; record: IdempotencyRecord }
  | { kind: "conflict"; record: IdempotencyRecord }
  | { kind: "tombstone"; record: TombstoneRecord };

export function claimIdempotency(
  namespace: "exec" | "resume" | "apply",
  key: string,
  digest: string,
  ids: { runId?: string; operationId?: string },
): IdempotencyClaimResult {
  ensureDir(IDEMPOTENCY_DIR);
  ensureDir(TOMBSTONES_DIR);
  const h = idempotencyHash(namespace, key);
  const tombFp = path.join(TOMBSTONES_DIR, `${h}.json`);
  const tomb = readJson<TombstoneRecord>(tombFp);
  if (tomb) return { kind: "tombstone", record: tomb };

  const fp = path.join(IDEMPOTENCY_DIR, `${h}.json`);
  const rec: IdempotencyRecord = {
    namespace,
    key,
    requestDigest: digest,
    runId: ids.runId,
    operationId: ids.operationId,
    createdAt: new Date().toISOString(),
  };
  try {
    const fd = openSync(fp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(rec, null, 2) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirBestEffort(IDEMPOTENCY_DIR);
    return { kind: "claimed", record: rec };
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    const existing = readJson<IdempotencyRecord>(fp);
    if (!existing) throw new Error(`Corrupt idempotency record for key ${key}`);
    if (existing.requestDigest === digest) return { kind: "existing", record: existing };
    return { kind: "conflict", record: existing };
  }
}

export function releaseUnstartedIdempotency(namespace: "exec" | "resume" | "apply", key: string, runId?: string): void {
  const h = idempotencyHash(namespace, key);
  const fp = path.join(IDEMPOTENCY_DIR, `${h}.json`);
  const existing = readJson<IdempotencyRecord>(fp);
  if (!existing) return;
  if (runId && existing.runId !== runId) return;
  try { unlinkSync(fp); } catch {}
}

export function recycleIdempotencyToTombstone(namespace: "exec" | "resume" | "apply", key: string): void {
  const h = idempotencyHash(namespace, key);
  const fp = path.join(IDEMPOTENCY_DIR, `${h}.json`);
  const existing = readJson<IdempotencyRecord>(fp);
  if (!existing) return;
  const tomb: TombstoneRecord = {
    namespace: existing.namespace,
    key: existing.key,
    requestDigest: existing.requestDigest,
    runId: existing.runId,
    recycledAt: new Date().toISOString(),
  };
  writeJsonDurable(path.join(TOMBSTONES_DIR, `${h}.json`), tomb);
  try { unlinkSync(fp); } catch {}
}

// ── One-Shot Launch Claim & Started / Early Session Records ──────
export function claimRunLaunch(runDir: string): boolean {
  const claimDir = path.join(runDir, "launch.claim");
  try {
    mkdirSync(claimDir, { mode: 0o700 });
    fsyncDirBestEffort(runDir);
    return true;
  } catch (e: any) {
    if (e?.code === "EEXIST") return false;
    throw e;
  }
}

export function hasLaunchClaim(runDir: string): boolean {
  return existsSync(path.join(runDir, "launch.claim"));
}

export function writeStartedRecord(runDir: string, record: StartedRecord): void {
  writeJsonDurable(path.join(runDir, "started.json"), record);
}

export function readStartedRecord(runDir: string): StartedRecord | null {
  return readJson<StartedRecord>(path.join(runDir, "started.json"));
}

export interface RunSessionFile {
  sessionId: string;
  recordedAt: string;
  source: "live" | "replayed";
}

export function writeRunSessionRecord(runDir: string, sessionId: string, source: "live" | "replayed" = "live"): void {
  writeJsonDurable(path.join(runDir, "session.json"), {
    sessionId,
    recordedAt: new Date().toISOString(),
    source,
  } satisfies RunSessionFile);
}

export function readRunSessionRecord(runDir: string): RunSessionFile | null {
  return readJson<RunSessionFile>(path.join(runDir, "session.json"));
}

export interface CancelIntent {
  ownerNonce?: string;
  operationId: string;
  requestedAt: string;
}

export function writeCancelIntent(runDir: string, ownerNonce?: string): CancelIntent {
  const intent: CancelIntent = {
    ownerNonce,
    operationId: randomUUID(),
    requestedAt: new Date().toISOString(),
  };
  writeJsonDurable(path.join(runDir, "cancel.json"), intent);
  // Keep legacy cancel.requested file for compatibility with existing checks/tests
  try { writeFileSync(path.join(runDir, "cancel.requested"), intent.requestedAt + "\n", { mode: 0o600 }); } catch {}
  return intent;
}

export function readCancelIntent(runDir: string): CancelIntent | null {
  return readJson<CancelIntent>(path.join(runDir, "cancel.json"));
}

// ── Owner-Nonce Leases (Never TTL-Stolen!) ───────────────────────
export function resourceKey(resourcePath: string): string {
  return sha256Hex(resourcePath).slice(0, 24);
}

function leaseFilePath(key: string): string {
  return path.join(LOCKS_DIR, `${key}.json`);
}

export function readLease(key: string): LeaseRecord | null {
  return readJson<LeaseRecord>(leaseFilePath(key));
}

export function inspectLeaseLivenessSync(lease: LeaseRecord | null): Liveness {
  if (!lease) return "gone";
  const workerState = probePidLivenessSync(lease.workerPid, lease.bootId, (c) => commandMatchesWorker(c, lease.runId));
  if (workerState === "alive") return "alive";
  const codexState = lease.codexPid
    ? probePidLivenessSync(lease.codexPid, lease.bootId, (c) => commandMatchesCodex(c, lease.runId))
    : "gone";
  if (codexState === "alive" || codexState === "unknown" || workerState === "unknown") return "unknown";
  return "gone";
}

export async function inspectLeaseLivenessAsync(lease: LeaseRecord | null): Promise<Liveness> {
  if (!lease) return "gone";
  const workerState = await probePidLivenessAsync(lease.workerPid, lease.bootId, (c) => commandMatchesWorker(c, lease.runId));
  if (workerState === "alive") return "alive";
  const codexState = lease.codexPid
    ? await probePidLivenessAsync(lease.codexPid, lease.bootId, (c) => commandMatchesCodex(c, lease.runId))
    : "gone";
  if (codexState === "alive" || codexState === "unknown" || workerState === "unknown") return "unknown";
  return "gone";
}

export interface OwnedLease {
  record: LeaseRecord;
  attachCodexPid: (pid: number) => void;
  release: () => void;
}

export function acquireLease(resourcePath: string, runId: string, ownerNonce: string): OwnedLease {
  ensureDir(LOCKS_DIR);
  const key = resourceKey(resourcePath);
  const fp = leaseFilePath(key);
  const rec: LeaseRecord = {
    resourceKey: key,
    resourcePath,
    runId,
    ownerNonce,
    bootId: currentBootId(),
    workerPid: process.pid,
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(fp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(rec, null, 2) + "\n", "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirBestEffort(LOCKS_DIR);
      return {
        record: rec,
        attachCodexPid(pid: number) {
          const cur = readLease(key);
          if (cur && cur.ownerNonce === ownerNonce && cur.runId === runId) {
            writeJsonDurable(fp, { ...cur, codexPid: pid });
          }
        },
        release() {
          const cur = readLease(key);
          if (cur && cur.ownerNonce === ownerNonce && cur.runId === runId) {
            try { unlinkSync(fp); } catch {}
          }
        },
      };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const existing = readLease(key);
      const live = inspectLeaseLivenessSync(existing);
      if (live === "gone") {
        // Reclaim ONLY when BOTH worker and codex writer are proven gone.
        try { unlinkSync(fp); continue; } catch {}
      }
      if (live === "unknown") {
        throw new Error(`Writer liveness unknown for ${resourcePath} (run: ${existing?.runId ?? "unknown"}). Refusing to steal lease; wait or stop writer first.`);
      }
      throw new Error(`Another codex-bridge process holds lease on ${resourcePath} (run: ${existing?.runId ?? "unknown"})`);
    }
  }
  throw new Error(`Could not acquire lease on ${resourcePath}`);
}

export function checkLeaseConflictSync(resourcePath: string): { conflict: false } | { conflict: true; liveness: "alive" | "unknown"; runId?: string; message: string } {
  const key = resourceKey(resourcePath);
  const existing = readLease(key);
  if (!existing) return { conflict: false };
  const live = inspectLeaseLivenessSync(existing);
  if (live === "gone") {
    try { unlinkSync(leaseFilePath(key)); } catch {}
    return { conflict: false };
  }
  return {
    conflict: true,
    liveness: live,
    runId: existing.runId,
    message: live === "unknown"
      ? `Writer liveness is unknown on ${resourcePath} (run: ${existing.runId}). Refusing to proceed until writer exits.`
      : `Another codex-bridge process is writing: ${resourcePath} (run: ${existing.runId})`,
  };
}

export function forceReleaseLeaseIfGone(resourcePath: string, expectedRunId: string): boolean {
  const key = resourceKey(resourcePath);
  const existing = readLease(key);
  if (!existing || existing.runId !== expectedRunId) return false;
  if (inspectLeaseLivenessSync(existing) !== "gone") return false;
  try { unlinkSync(leaseFilePath(key)); return true; } catch { return false; }
}

// ── Workspaces ───────────────────────────────────────────────────
export function workspaceDir(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, workspaceId);
}

export function writeWorkspaceMeta(meta: WorkspaceMeta): void {
  const dir = workspaceDir(meta.workspaceId);
  ensureDir(dir);
  writeJsonDurable(path.join(dir, "workspace.json"), meta);
}

export function readWorkspaceMeta(workspaceId: string): WorkspaceMeta | null {
  return readJson<WorkspaceMeta>(path.join(workspaceDir(workspaceId), "workspace.json"));
}

export function updateWorkspaceMeta(workspaceId: string, patch: Partial<WorkspaceMeta>): WorkspaceMeta | null {
  const existing = readWorkspaceMeta(workspaceId);
  if (!existing) return null;
  const next: WorkspaceMeta = { ...existing, ...patch };
  writeWorkspaceMeta(next);
  return next;
}

export function listWorkspaceMetas(): WorkspaceMeta[] {
  ensureDir(WORKSPACES_DIR);
  const out: WorkspaceMeta[] = [];
  try {
    for (const name of readdirSync(WORKSPACES_DIR)) {
      const m = readWorkspaceMeta(name);
      if (m) out.push(m);
    }
  } catch {}
  return out;
}

// ── Sessions ─────────────────────────────────────────────────────
export function sessionFileHash(sessionId: string): string {
  return sha256Hex(sessionId).slice(0, 24);
}

export function readSessionRecord(sessionId: string): SessionRecord | null {
  return readJson<SessionRecord>(path.join(SESSIONS_DIR, `${sessionFileHash(sessionId)}.json`));
}

export function upsertSessionRecord(
  sessionId: string,
  runId: string,
  extra?: Partial<Omit<SessionRecord, "sessionId" | "latestRunId" | "runIds" | "createdAt" | "updatedAt">>,
): SessionRecord {
  ensureDir(SESSIONS_DIR);
  const fp = path.join(SESSIONS_DIR, `${sessionFileHash(sessionId)}.json`);
  const existing = readJson<SessionRecord & { runId?: string }>(fp);
  const now = new Date().toISOString();
  const prevRunIds = existing?.runIds ?? (existing?.runId ? [existing.runId] : []);
  const runIds = prevRunIds.includes(runId) ? prevRunIds : [...prevRunIds, runId];
  const next: SessionRecord = {
    sessionId,
    latestRunId: runId,
    runIds,
    workspaceId: extra?.workspaceId ?? existing?.workspaceId,
    mcpHome: extra?.mcpHome ?? existing?.mcpHome,
    cwd: extra?.cwd ?? existing?.cwd,
    parentGitRoot: extra?.parentGitRoot !== undefined ? extra.parentGitRoot : existing?.parentGitRoot,
    sandbox: extra?.sandbox ?? existing?.sandbox,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  // Also preserve legacy `runId` field for any external reader expecting v2 pointer shape
  writeJsonDurable(fp, { ...next, runId });
  return next;
}

export function listSessionRecords(): SessionRecord[] {
  ensureDir(SESSIONS_DIR);
  const out: SessionRecord[] = [];
  try {
    for (const name of readdirSync(SESSIONS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const rec = readJson<SessionRecord & { runId?: string }>(path.join(SESSIONS_DIR, name));
      if (!rec?.sessionId) continue;
      out.push({
        ...rec,
        latestRunId: rec.latestRunId || rec.runId || "",
        runIds: rec.runIds ?? (rec.runId ? [rec.runId] : []),
      });
    }
  } catch {}
  return out;
}

// ── Apply Intents ────────────────────────────────────────────────
export function writeApplyIntent(intent: ApplyIntent): void {
  ensureDir(APPLIES_DIR);
  writeJsonDurable(path.join(APPLIES_DIR, `${intent.operationId}.json`), intent);
}

export function readApplyIntent(operationId: string): ApplyIntent | null {
  return readJson<ApplyIntent>(path.join(APPLIES_DIR, `${operationId}.json`));
}

export function listApplyIntents(): ApplyIntent[] {
  ensureDir(APPLIES_DIR);
  const out: ApplyIntent[] = [];
  try {
    for (const name of readdirSync(APPLIES_DIR)) {
      if (!name.endsWith(".json")) continue;
      const rec = readJson<ApplyIntent>(path.join(APPLIES_DIR, name));
      if (rec?.operationId) out.push(rec);
    }
  } catch {}
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export function findPendingAppliesForTarget(targetHash: string): ApplyIntent[] {
  return listApplyIntents().filter(
    (a) => a.targetHash === targetHash && (a.status === "PREPARED" || a.status === "CONFLICT_DURING_RECOVERY"),
  );
}

// ── Session-Rooted Garbage Collection ────────────────────────────
export interface GcSummary {
  removedRuns: number;
  removedWorkspaces: number;
  preservedRoots: { activeRuns: number; workspaces: number; pendingApplies: number };
}

export function runRootedGc(maxAgeMs = 7 * 24 * 60 * 60 * 1000): GcSummary {
  ensureDir(RUNS_DIR);
  const now = Date.now();

  const protectedRuns = new Set<string>();
  const protectedWorkspaces = new Set<string>();
  const protectedMcpHomes = new Set<string>();
  let activeRuns = 0;

  // Root 1: Pending applies protect their run & workspace unconditionally
  const pendingApplies = listApplyIntents().filter((a) => a.status === "PREPARED" || a.status === "CONFLICT_DURING_RECOVERY");
  for (const a of pendingApplies) {
    protectedRuns.add(a.runId);
    protectedWorkspaces.add(a.workspaceId);
  }

  // Root 2: Active or unknown leases protect their run
  try {
    ensureDir(LOCKS_DIR);
    for (const name of readdirSync(LOCKS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const lease = readJson<LeaseRecord>(path.join(LOCKS_DIR, name));
      if (!lease) continue;
      const live = inspectLeaseLivenessSync(lease);
      if (live === "alive" || live === "unknown") {
        protectedRuns.add(lease.runId);
        activeRuns++;
      }
    }
  } catch {}

  // Root 3: Resumable sessions with live workspaces protect their workspace & mcpHome
  const sessions = listSessionRecords();
  for (const s of sessions) {
    if (s.workspaceId) {
      const ws = readWorkspaceMeta(s.workspaceId);
      if (ws && !ws.cleanedAt && existsSync(ws.srcDir)) {
        protectedWorkspaces.add(s.workspaceId);
        if (s.latestRunId) protectedRuns.add(s.latestRunId);
        if (s.mcpHome) protectedMcpHomes.add(s.mcpHome);
      }
    }
  }

  // Sweep expired runs that are NOT rooted and NOT active/unknown
  let removedRuns = 0;
  try {
    for (const name of readdirSync(RUNS_DIR)) {
      const runDir = path.join(RUNS_DIR, name);
      if (protectedRuns.has(name)) continue;
      let st;
      try { st = statSync(runDir); } catch { continue; }
      if (!st.isDirectory()) continue;

      const hasReview = existsSync(path.join(runDir, "review.json"));
      const meta = readJson<RunMeta>(path.join(runDir, "run.json"));
      const started = readStartedRecord(runDir);
      if (!hasReview) {
        // Never GC an unsealed run unless both worker & codex are proven gone AND older than maxAgeMs
        const wLive = probePidLivenessSync(started?.workerPid ?? meta?.workerPid, started?.bootId, (c) => commandMatchesWorker(c, name));
        const cLive = probePidLivenessSync(started?.codexPid ?? meta?.codexPid, started?.bootId, (c) => commandMatchesCodex(c, name));
        if (wLive !== "gone" || cLive !== "gone") {
          protectedRuns.add(name);
          if (meta?.workspaceId) protectedWorkspaces.add(meta.workspaceId);
          activeRuns++;
          continue;
        }
      }

      // Protect any run whose mcp-home is still referenced by a live session
      if (meta?.mcpHome && protectedMcpHomes.has(meta.mcpHome)) continue;

      if (now - st.mtimeMs > maxAgeMs) {
        if (meta?.idempotencyKey) {
          recycleIdempotencyToTombstone(meta.resumeSessionId ? "resume" : "exec", meta.idempotencyKey);
        }
        try { rmSync(runDir, { recursive: true, force: true }); removedRuns++; } catch {}
      } else if (meta?.workspaceId) {
        // Retained recent run keeps its workspace evidence reachable
        protectedWorkspaces.add(meta.workspaceId);
      }
    }
  } catch {}

  // Sweep expired cleaned/unreferenced workspaces
  let removedWorkspaces = 0;
  for (const ws of listWorkspaceMetas()) {
    if (protectedWorkspaces.has(ws.workspaceId)) continue;
    const dir = workspaceDir(ws.workspaceId);
    try {
      const st = statSync(dir);
      if (ws.cleanedAt || now - st.mtimeMs > maxAgeMs) {
        rmSync(dir, { recursive: true, force: true });
        removedWorkspaces++;
      }
    } catch {}
  }

  return {
    removedRuns,
    removedWorkspaces,
    preservedRoots: {
      activeRuns,
      workspaces: protectedWorkspaces.size,
      pendingApplies: pendingApplies.length,
    },
  };
}

// ── Sleep-Immune Effective Observation Clock (Pure, Testable) ────
export interface ObserverClockState {
  lastHrNs: bigint;
  lastWallMs: number;
  observedActiveMs: number;
  idleActiveMs: number;
  observerGaps: number;
  normalTicksSinceGap: number;
  sampleIntervalMs: number;
}

export interface ObserverTickResult {
  gapDetected: boolean;
  canEvaluateBudgets: boolean;
  observedActiveMs: number;
  idleActiveMs: number;
  observerGaps: number;
}

export function createObserverClock(
  nowHrNs: bigint = process.hrtime.bigint(),
  nowWallMs: number = Date.now(),
  sampleIntervalMs = 2000,
): ObserverClockState {
  return {
    lastHrNs: nowHrNs,
    lastWallMs: nowWallMs,
    observedActiveMs: 0,
    idleActiveMs: 0,
    observerGaps: 0,
    normalTicksSinceGap: 2,
    sampleIntervalMs,
  };
}

export function recordObserverActivity(clock: ObserverClockState): void {
  clock.idleActiveMs = 0;
}

/**
 * Advance the sleep-immune observation clock.
 * Detects sleep/suspend, clock skew, or scheduler stalls when:
 *   - monotonic delta dm > 5 * sampleIntervalMs, OR
 *   - wall clock jumps backward (dw < -1000ms), OR
 *   - |dw - dm| > 5 * sampleIntervalMs.
 * On any anomaly: records an `observer_gap`, does NOT charge the anomalous interval to
 * `observedActiveMs` or `idleActiveMs`, resets sampling baselines, and requires 2 normal
 * samples before budget/silence verdicts resume.
 */
export function sampleObserverClock(
  clock: ObserverClockState,
  nowHrNs: bigint = process.hrtime.bigint(),
  nowWallMs: number = Date.now(),
): ObserverTickResult {
  const dm = Number(nowHrNs - clock.lastHrNs) / 1e6;
  const dw = nowWallMs - clock.lastWallMs;
  clock.lastHrNs = nowHrNs;
  clock.lastWallMs = nowWallMs;

  const gapLimit = clock.sampleIntervalMs * 5;
  const gapDetected = dm < 0 || dm > gapLimit || dw < -1000 || Math.abs(dw - dm) > gapLimit;

  if (gapDetected) {
    clock.observerGaps += 1;
    clock.normalTicksSinceGap = 0;
    return {
      gapDetected: true,
      canEvaluateBudgets: false,
      observedActiveMs: Math.round(clock.observedActiveMs),
      idleActiveMs: Math.round(clock.idleActiveMs),
      observerGaps: clock.observerGaps,
    };
  }

  clock.normalTicksSinceGap += 1;
  clock.observedActiveMs += dm;
  clock.idleActiveMs += dm;

  return {
    gapDetected: false,
    canEvaluateBudgets: clock.normalTicksSinceGap >= 2,
    observedActiveMs: Math.round(clock.observedActiveMs),
    idleActiveMs: Math.round(clock.idleActiveMs),
    observerGaps: clock.observerGaps,
  };
}
