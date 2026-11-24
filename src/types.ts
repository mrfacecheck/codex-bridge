import type { ChildProcess } from "child_process";

// ── Constants ────────────────────────────────────────────────────
export const MAX_GIT_BUFFER = 100 * 1024 * 1024;
export const TRUNCATED_TAIL_MARKER = "\n...[truncated; showing tail]...\n";
export const TRUNCATED_HEAD_MARKER = "\n...[truncated; showing head]...\n";
export const DIFF_DETECT_ARGS = ["--find-renames", "--find-copies", "--find-copies-harder"];
export const DIFF_RENDER_ARGS = ["--find-renames"];
export const SENSITIVE_HASH_MAX = 256 * 1024 * 1024;
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const SAFE_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM",
  "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "WS_PROXY", "WSS_PROXY", "ws_proxy", "wss_proxy",
]);

export const SENSITIVE_RE = /(^|\/)(.*\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|.*\.(pem|key|p12|pfx|crt))$/i;

export const SENSITIVE_PATHSPECS = [
  ":(icase,glob).env", ":(icase,glob).env.*", ":(icase,glob)**/.env", ":(icase,glob)**/.env.*",
  ":(icase,glob)*.env", ":(icase,glob)**/*.env", ":(icase,glob)*.env.*", ":(icase,glob)**/*.env.*",
  ":(icase,glob).npmrc", ":(icase,glob)**/.npmrc", ":(icase,glob).pypirc", ":(icase,glob)**/.pypirc",
  ":(icase,glob).netrc", ":(icase,glob)**/.netrc",
  ":(icase,glob)id_rsa", ":(icase,glob)**/id_rsa", ":(icase,glob)id_ed25519", ":(icase,glob)**/id_ed25519",
  ":(icase,glob)*.pem", ":(icase,glob)**/*.pem", ":(icase,glob)*.key", ":(icase,glob)**/*.key",
  ":(icase,glob)*.p12", ":(icase,glob)**/*.p12", ":(icase,glob)*.pfx", ":(icase,glob)**/*.pfx",
  ":(icase,glob)*.crt", ":(icase,glob)**/*.crt",
];

export const LOW_VALUE_RE = /(^|\/)(\.DS_Store|Thumbs\.db|Desktop\.ini|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|dist\/|build\/|coverage\/|\.next\/|node_modules\/)|(\.min\.js$)|(\.snap$)/i;

export const KNOWN_JSONL_TYPES = new Set([
  "thread.started", "turn.started", "turn.completed", "turn.failed",
  "error", "item.started", "item.completed",
]);

// ── Limits ───────────────────────────────────────────────────────
export const RECENT_RUN_LOOKUP_LIMIT = 50;
export const ACTIVE_SESSION_SCAN_LIMIT = 100;
export const PRIMARY_PREVIEW_FILE_LIMIT = 20;
export const SECONDARY_PREVIEW_FILE_LIMIT = 5;
export const LOW_VALUE_HEADER_LIMIT = 10;
// v3: default idle watchdog raises a 1-shot attention signal instead of silently auto-killing.
// Callers who want unattended cost/time enforcement pass explicit idle_timeout or timeout.
export const DEFAULT_IDLE_ATTENTION = 900;
export const DEFAULT_IDLE_TIMEOUT: number | null = null;
export const HEARTBEAT_STALE_MS = 15_000;

// ── v3 Lifecycle / Liveness / Attention Model ────────────────────
export type Phase = "accepted" | "preparing" | "running" | "sealing" | "terminal";
export type Outcome = "succeeded" | "failed" | "cancelled" | "interrupted";
export type Liveness = "alive" | "gone" | "unknown";
export type AttentionCode = "idle_silence" | "repeated_failure" | "no_response" | "observer_gap" | "sandbox_gui_crash";

export interface AttentionState {
  code: AttentionCode;
  revision: number;
  message: string;
  raisedAt: string;
}

export interface CommandStats {
  completed: number;
  failed: number;
  inflight: number;
}

export interface PrepareSpec {
  command: string;
  args?: string[];
  timeout_seconds?: number;
}

export const TERMINAL_STATUSES = ["completed", "failed", "timeout", "cancelled"] as const;
export type TerminalStatus = typeof TERMINAL_STATUSES[number];

export type ActivePhase = "starting" | "preparing" | "snapshot-before" | "running" | "cancelling" | "snapshot-after" | "building-review" | "sealing";
export type ProgressPhase = ActivePhase | TerminalStatus;

export function isTerminal(status?: string): status is TerminalStatus {
  return Boolean(status && (TERMINAL_STATUSES as readonly string[]).includes(status));
}

export function statusToPhase(status?: string): Phase {
  if (!status) return "accepted";
  if (isTerminal(status)) return "terminal";
  if (status === "preparing" || status === "snapshot-before") return "preparing";
  if (status === "snapshot-after" || status === "building-review" || status === "sealing") return "sealing";
  if (status === "starting") return "accepted";
  return "running";
}

// ── Git / Evidence Types ─────────────────────────────────────────
export interface ExecContext { runCwd: string; gitRoot: string; gitRepo: boolean }
export interface StatusFile { xy: string; path: string }
export interface TreeSnapshot { tree: string; objectDir: string; cleanupDir: string }

export interface FileFingerprint { exists: boolean; size?: number; mtimeMs?: number; sha256?: string; hashTruncated?: boolean }
export type FsSentinelSnapshot = Record<string, FileFingerprint>;
export interface FsSentinelResult { snapshot: FsSentinelSnapshot; warnings: string[] }
export interface FsSentinelChange { path: string; kind: "created" | "deleted" | "modified" }

export type AliasReason = "matches_sensitive_content" | "matches_oversized_sensitive_size";
export interface SensitiveAlias { path: string; source: string; reason: AliasReason }

export interface DiffFile { status: string; path: string; from?: string }
export interface GitDiffResult {
  is_git_repo: true; changed: boolean; summary: string; files: DiffFile[];
  diff_preview: string; diff_preview_mode: "full" | "review-prioritized";
  diff_truncated: boolean; diff_path?: string; full_diff_bytes: number;
  preexisting_dirty_files: number; risk_flags: string[]; sensitive_diff_omitted?: string[];
}
export interface NoGitResult { is_git_repo: false; changed: boolean; summary: string }

// ── Lock & v3 Lease ──────────────────────────────────────────────
export interface LockPayload { bridgePid: number; childPid?: number; runId: string; cwd: string; createdAt: string; ownerNonce?: string; bootId?: string }
export interface WriteLock { lockPath: string; runId: string; release: () => void; attachChildPid: (pid: number) => void }

export interface StartedRecord {
  runId: string;
  ownerNonce: string;
  bootId: string;
  workerPid: number;
  codexPid?: number;
  codexVersion?: string;
  startedAt: string;
}

export interface LeaseRecord {
  resourceKey: string;
  resourcePath: string;
  runId: string;
  ownerNonce: string;
  bootId: string;
  workerPid: number;
  codexPid?: number;
  createdAt: string;
}

export interface SessionRecord {
  sessionId: string;
  latestRunId: string;
  runIds: string[];
  workspaceId?: string;
  mcpHome?: string;
  cwd?: string;
  parentGitRoot?: string | null;
  sandbox?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMeta {
  workspaceId: string;
  kind: "snapshot" | "worktree" | "inplace";
  parentGitRoot: string | null;
  srcDir: string;
  evidenceGitDir: string | null;
  baseSpec: string;
  originCommit: string | null;
  originTree: string | null;
  parentDirtyAtCreate?: boolean;
  appliedWatermarks: Record<string, string>;
  createdAt: string;
  cleanedAt?: string;
}

export interface FileObjectRef { blob: string; mode: number }
export interface ApplyIntentEntry {
  path: string;
  old: FileObjectRef | null;
  next: FileObjectRef | null;
}

export interface ApplyIntent {
  operationId: string;
  runId: string;
  workspaceId: string;
  targetDir: string;
  targetHash: string;
  evidenceGitDir: string;
  status: "PREPARED" | "COMMITTED" | "ABORTED" | "CONFLICT_DURING_RECOVERY";
  baseTree: string;
  oursTree: string;
  resultTree: string;
  mergedTree: string;
  entries: ApplyIntentEntry[];
  createdAt: string;
  updatedAt: string;
  conflictPath?: string;
  error?: string;
}

export interface IdempotencyRecord {
  namespace: "exec" | "resume" | "apply";
  key: string;
  requestDigest: string;
  runId?: string;
  operationId?: string;
  createdAt: string;
}

export interface TombstoneRecord {
  namespace: "exec" | "resume" | "apply";
  key: string;
  requestDigest: string;
  runId?: string;
  recycledAt: string;
}

// ── Codex Runner ─────────────────────────────────────────────────
export type RunStatus = TerminalStatus;
export interface TokenUsage { input: number; output: number; cached: number; reasoning: number }
export interface EventSummary { counts: Record<string, number>; file_changes: string[]; commands: string[]; errors: string[] }
export interface CodexResult {
  runId: string; sessionId: string; status: RunStatus; exitCode: number | null;
  signal: NodeJS.Signals | null; output: string; outputTruncated: boolean;
  stderr: string; stderrTruncated: boolean; tokenUsage: TokenUsage;
  events: EventSummary; durationMs: number;
}
export interface RunningCodex { runId: string; process: ChildProcess; promise: Promise<CodexResult>; cancel: () => void }

// ── Session (in-memory, v1/v2 compat) ────────────────────────────
export interface Session {
  latestRunId: string; runIds: string[]; sessionId?: string; name: string;
  status: "running" | TerminalStatus;
  cwd: string; gitRoot?: string; sandbox: string;
  startedAt: number; lastActiveAt: number; filesChanged: string[];
  output?: string; diffPath?: string; tokenUsage?: TokenUsage;
  process?: ChildProcess; cancel?: () => void;
}

// ── Execution Mode ───────────────────────────────────────────────
export type ExecutionMode = "auto" | "sync" | "async";

// ── Durable Run State ────────────────────────────────────────────
export interface RunMeta {
  runId: string;
  ownerNonce?: string;
  idempotencyKey?: string;
  cwd: string;
  gitRoot: string | null;
  sandbox: string;
  task: string;
  model?: string;
  timeout?: number | null;
  idleTimeout?: number | null;
  idleAttentionSeconds?: number | null;
  sessionName: string;
  maxDiffChars: number;
  allowNonGit: boolean;
  allowLargeUntracked: boolean;
  dangerAck: boolean;
  createdAt: string;
  workerPid?: number;
  codexPid?: number;
  resumeSessionId?: string;
  resumeContextVerified?: boolean;
  projectBrief?: boolean;
  isolation?: "inplace" | "worktree";
  workspaceId?: string;
  workspaceKind?: "snapshot" | "worktree" | "inplace";
  worktreePath?: string;
  parentGitRoot?: string | null;
  evidenceGitDir?: string | null;
  originTree?: string | null;
  beforeTree?: string | null;
  baseSpec?: string;
  parentDirtyAtCreate?: boolean;
  prepare?: PrepareSpec;
  effort?: string;
  outputSchema?: string;
  resolvedModel?: string | null;
  modelSource?: "flag" | "config" | "unknown";
  resolvedEffort?: string | null;
  effortSource?: "flag" | "config" | "unknown";
  codexVersion?: string;
  mcpHome?: string;
  grants?: { mcp?: string[] };
}

export interface ProgressState {
  status: ProgressPhase;
  phase?: Phase;
  liveness?: Liveness;
  message: string;
  updatedAt: string;
  seq: number;
  revision?: number;
  heartbeatSeq?: number;
  heartbeatAt?: string;
  sessionId?: string;
  elapsedMs?: number;
  observedActiveMs?: number;
  idleActiveMs?: number;
  observerGaps?: number;
  commands?: CommandStats;
  reportedUsage?: TokenUsage | null;
  attention?: AttentionState | null;
  evidenceSealed?: boolean;
  error?: string;
  lastActivityAt?: string;
}

export type RunHandleStatus = "running" | "failed" | "timeout" | "cancelled" | "unknown";

export interface RunHandle {
  run_id: string;
  async: true;
  status: RunHandleStatus;
  phase?: Phase;
  liveness?: Liveness;
  session_id?: string;
  workspace_id?: string;
  cwd: string;
  git_root?: string;
  worktree_path?: string;
  parent_dirty_at_create?: boolean;
  progress: ProgressState;
  poll_with: string;
}

// ── Review Packet ────────────────────────────────────────────────
export interface ReviewPacketLike {
  run_id?: string;
  async?: boolean;
  session_id?: string;
  session_name?: string;
  status?: RunStatus | string;
  phase?: Phase;
  outcome?: Outcome;
  liveness?: Liveness;
  salvaged?: boolean;
  status_detail?: string;
  failure_hint?: string;
  partial_changes?: boolean;
  cwd?: string;
  git_root?: string;
  workspace_id?: string;
  workspace_kind?: "snapshot" | "worktree" | "inplace";
  duration_ms?: number;
  observed_active_ms?: number;
  observer_gaps?: number;
  output?: string;
  output_source?: string;
  output_truncated?: boolean;
  stderr?: string;
  stderr_truncated?: boolean;
  process?: { exit_code: number | null; signal: string | null };
  token_usage?: TokenUsage;
  reported_usage?: TokenUsage | null;
  events?: EventSummary;
  commands?: CommandStats;
  attention?: AttentionState | null;
  evidence?: {
    sealed: boolean;
    origin_tree?: string;
    before_tree?: string;
    after_tree?: string;
    error?: string;
  };
  origin_tree?: string;
  before_tree?: string;
  after_tree?: string;
  parent_dirty_at_create?: boolean;
  prepare?: { ok: boolean; duration_ms: number; exit_code: number | null; log_path?: string; error?: string };
  git_diff?: {
    is_git_repo?: boolean;
    changed?: boolean;
    files?: Array<{ path: string; status?: string; from?: string }>;
    diff_path?: string;
    diff_preview?: string;
    diff_preview_mode?: string;
    diff_truncated?: boolean;
    summary?: string;
    full_diff_bytes?: number;
    preexisting_dirty_files?: number;
    risk_flags?: string[];
    sensitive_diff_omitted?: string[];
  };
  fs_sentinel?: unknown;
  warnings?: string[];
  isolation?: "inplace" | "worktree";
  worktree_path?: string;
  parent_git_root?: string;
  timeout?: number | null;
  idle_timeout?: number | null;
  idle_attention_seconds?: number | null;
  worktree_escape?: { paths: string[]; evidence: string[] };
  concurrent_parent_changes?: { count: number; paths: string[] };
  resume_attached?: boolean;
  resume_context_verified?: boolean;
  requested_session_id?: string;
  actual_session_id?: string;
  sandbox?: string;
  model?: string | null;
  model_source?: string;
  effort?: string | null;
  effort_source?: string;
  codex_version?: string;
}
