import type { ChildProcess } from "child_process";

// ── Constants ────────────────────────────────────────────────────
export const MAX_GIT_BUFFER = 100 * 1024 * 1024;
export const TRUNCATED_TAIL_MARKER = "\n...[truncated; showing tail]...\n";
export const TRUNCATED_HEAD_MARKER = "\n...[truncated; showing head]...\n";
export const DIFF_DETECT_ARGS = ["--find-renames", "--find-copies", "--find-copies-harder"];
export const DIFF_RENDER_ARGS = ["--find-renames"];
export const SENSITIVE_HASH_MAX = 256 * 1024 * 1024;

export const SAFE_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM",
  "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
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

// ── Status Model ─────────────────────────────────────────────────
export const TERMINAL_STATUSES = ["completed", "failed", "timeout", "cancelled"] as const;
export type TerminalStatus = typeof TERMINAL_STATUSES[number];

export type ActivePhase = "starting" | "snapshot-before" | "running" | "cancelling" | "snapshot-after" | "building-review";
export type ProgressPhase = ActivePhase | TerminalStatus;

export function isTerminal(status?: string): status is TerminalStatus {
  return Boolean(status && (TERMINAL_STATUSES as readonly string[]).includes(status));
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

// ── Lock ─────────────────────────────────────────────────────────
export interface LockPayload { bridgePid: number; childPid?: number; runId: string; cwd: string; createdAt: string }
export interface WriteLock { lockPath: string; runId: string; release: () => void; attachChildPid: (pid: number) => void }

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

// ── Session (in-memory, v1 compat) ──────────────────────────────
export interface Session {
  latestRunId: string; runIds: string[]; sessionId?: string; name: string;
  status: "running" | TerminalStatus;
  cwd: string; gitRoot?: string; sandbox: string;
  startedAt: number; lastActiveAt: number; filesChanged: string[];
  output?: string; diffPath?: string; tokenUsage?: TokenUsage;
  process?: ChildProcess; cancel?: () => void;
}

// ── v2: Execution Mode ───────────────────────────────────────────
export type ExecutionMode = "auto" | "sync" | "async";

// ── v2: Durable Run State ────────────────────────────────────────
export interface RunMeta {
  runId: string;
  cwd: string;
  gitRoot: string | null;
  sandbox: string;
  task: string;
  model?: string;
  timeout: number;
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
}

export interface ProgressState {
  status: ProgressPhase;
  message: string;
  updatedAt: string;
  seq: number;
  sessionId?: string;
  elapsedMs?: number;
  error?: string;
}

export type RunHandleStatus = "running" | "failed" | "timeout" | "cancelled";

export interface RunHandle {
  run_id: string;
  async: true;
  status: RunHandleStatus;
  session_id?: string;
  cwd: string;
  git_root?: string;
  progress: ProgressState;
  poll_with: string;
}

// ── v2: Review Packet (typed subset for in-process use) ──────────
export interface ReviewPacketLike {
  run_id?: string;
  session_id?: string;
  status?: RunStatus;
  status_detail?: string;
  output?: string;
  token_usage?: TokenUsage;
  resume_attached?: boolean;
  partial_changes?: boolean;
  git_diff?: {
    is_git_repo?: boolean;
    changed?: boolean;
    files?: Array<{ path: string }>;
    diff_path?: string;
    summary?: string;
  };
}
