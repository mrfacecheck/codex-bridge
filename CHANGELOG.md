# Changelog

## v3.0.0

Architectural kernel rewrite grounded in first-principles systems invariants (ownership, durability, evidence sealing, and honest uncertainty).

### Breaking-free Architectural Shifts
- **Independent Snapshot Repository + Out-of-Band `evidence.git`** (replaces shared-metadata linked worktrees for `isolation="worktree"`):
  - Isolates `.git` completely from the parent repo (no shared refs, hooks, remotes, alternates, or `.git/config`).
  - Seals immutable `origin_tree`, `before_tree`, and `after_tree` directly into a protected bare `evidence.git` (`core.fsyncMethod=fsync`, `hash-object --no-filters`).
  - Completely immune to Codex running `git commit`, `git reset`, `git checkout`, or modifying `.gitignore` to hide existing origin source files.
  - Supports explicit `base: "working_tree"` (in addition to git refs like `"HEAD"`) to freeze uncommitted parent edits into immutable `origin_tree` when delegating mid-edit work.
- **Private-Store 3-Way Merge (`git merge-tree --write-tree`) + Recoverable File Materialization**:
  - Replaces fragile `git apply` with Git 2.38+-compatible 3-way tree merges computed entirely inside `evidence.git` — preserves parent `.git/index` (staged changes) and merges disjoint parent edits without ever polluting the working tree on conflict.
  - Persists a durable `PREPARED → COMMITTED` `ApplyIntent` (`applies/<opId>.json`) with per-file atomic replacement (`tmp → fsync → rename`) and crash recovery that skips already-landed files, finishes remaining files, and halts cleanly (`CONFLICT_DURING_RECOVERY`) if a 3rd-party external edit touched an incomplete target.
  - Rejects unsafe paths (`..`, `.git`, case-folding collisions, symlinks, gitlinks, directory/file swaps, sensitive paths/aliases) before touching a single parent file.
  - Tracks per-target session `appliedWatermarks` so multi-turn resumed applies merge only the incremental delta since the last applied turn.
- **Attention-Only Default + Sleep-Immune Effective Observation Clock**:
  - Cancels default silent idle auto-kill (`default_idle_timeout_seconds: null`); replaces it with a 1-shot cursor-acked **`attention`** signal (`default_idle_attention_seconds: 900`, plus `repeated_failure` after 3 identical non-zero exits and 30s `no_response`). Unattended cost-capped runs pass explicit `idle_timeout` or `timeout`.
  - 2-second monotonic/wall delta sampler detects host sleep, lid-close suspend, or clock skew as `observer_gap`, excluding anomalous intervals from `observed_active_ms` / `idle_active_ms` and requiring 2 normal ticks before budget verdicts resume.
  - Honest usage reporting: `reported_usage` stays `null` until Codex actually emits usage (never fake zeros mid-run).
- **Direct-FD Logs + Early `thread.started` Durability + At-Most-Once Admission + `unknown` Liveness**:
  - Codex stdout/stderr write directly to private file descriptors (`codex.stdout.jsonl` / `codex.stderr.log`), preventing EPIPE on worker death and enabling automatic post-crash log & disk-tree salvage (`salvaged: true`, honest `exit_code: null`).
  - First `thread.started` immediately fsyncs `session.json` and updates the session index.
  - `idempotency_key` on `codex_exec` / `codex_resume` / `apply` enforces at-most-once admission via atomic exclusive file creation + post-GC `tombstones/`.
  - Owner-nonce leases (`locks/`) with host `bootId` are NEVER stolen by heartbeat timeout; if a worker dies while its Codex child may still be writing, reconciliation reports `liveness: "unknown"` and blocks `resume` / `apply` / `cleanup` until writer exit is proven.
- **Zero-Spawn Hot Path + Native Multi-Worker `wait-any` (`codex_sessions.get(run_ids[])`)**:
  - Eliminates synchronous `ps` forks on normal `get` / `list` hot paths via fresh heartbeat checks + shared directory-watch multiplexer (`read → watch → re-read` anti-lost-wakeup protocol).
  - `action="get"` accepts `run_ids: string[]` + `cursor: Record<string, number>` for single-call wait-any across parallel workers with per-item error isolation.
- **Defense-in-Depth Security & Model-Free `prepare`**:
  - `grants.ts` rejects project-level `.codex/config.toml` ungranted MCP server injection fail-closed and runs `codex mcp list --json` inside `runCwd`, plus cached binary-identity capability probing.
  - Optional `prepare: { command, args, timeout_seconds }` runs inside the workspace before invoking Codex (zero model tokens spent on setup failures).
  - Session-rooted GC preserves active/unknown runs, resumable session workspaces & shadow `CODEX_HOME`, pending `PREPARED` applies, and recycles expired keys into tombstones.

## v2.4.0

First-principles reliability and ergonomics overhaul driven by telemetry from multi-file `gpt-6.2-sol` (`xhigh`) production runs.

### Changed (Breaking-free Paradigm Shifts)
- **No arbitrary wall-clock cutoff by default → Activity-based `idle_timeout` watchdog**:
  - `codex_exec` and `codex_resume` no longer impose arbitrary 300s / 900s / 1200s wall-clock deadlines that killed healthy long-running reasoning turns seconds from completion.
  - Runs are now governed by an activity-based **`idle_timeout`** watchdog (default `900s` = 15 min of zero real Codex JSONL stdout events, configurable via `idle_timeout` parameter or `CODEX_BRIDGE_DEFAULT_IDLE_TIMEOUT`, or disabled with `0`).
  - Wall-clock **`timeout`** is now strictly opt-in (`null` by default; pass `timeout > 0` only when you explicitly want a hard wall cap).
  - Review packets cleanly distinguish `idle_timeout_clean` / `idle_timeout_with_changes` (`failure_hint: "idle_timeout"`) vs `timeout_clean` / `timeout_with_changes` (`failure_hint: "wall_timeout"`), and expose both `timeout` and `idle_timeout`.
- **Smart event-driven long-poll (`wait_for: "terminal"` default)**:
  - `codex_sessions(action="get", wait_seconds=...)` now works uniformly across ALL views (`status`, `summary`, `diff`, `output`, `review`) and defaults to **`wait_for: "terminal"`** (wakes on completion/failure, worker crash, first transition into `stale`, or wait deadline — NOT on every intermediate progress tick).
  - Eliminates noisy polling loops: callers can invoke `codex_sessions(action="get", run_id=..., view="summary", wait_seconds=240)` and receive the final compact summary in a single round-trip. Pass `wait_for: "progress"` with `since_seq` to stream live intermediate events.
  - Raised `CODEX_BRIDGE_MAX_WAIT_SECONDS` env cap to `600` (default remains `240`).

### Added
- **First-class worktree harvest (`codex_sessions action="apply"`)**:
  - Atomically previews (`dry_run: true`) or applies a completed worktree run's diff into the parent checkout via `git apply --check` + parent write lock + `git apply`, with optional `cleanup: true` for 1-call harvest + teardown.
  - Supports multi-turn resumed worktree sessions automatically via `scope: "auto" | "worktree" | "run"` (`auto` exports cumulative `HEAD..worktree` patch with full sensitive-file/alias redaction for resumed runs, and uses `changes.patch` for single-turn runs).
  - Fail-closed guards: refuses active runs, non-completed runs (unless `allow_partial: true`), confirmed `worktree_escape`, omitted sensitive files, or write-lock conflicts; conflict failures touch zero parent files.
  - `changes.patch` now includes `--binary` so binary assets apply faithfully.
- **Active worktree cleanup guard**: `codex_sessions(action="cleanup")` now refuses to remove a worktree while its worker is still active (stop the run first).
- **Doctor & List metadata**: `doctor` reports `default_idle_timeout_seconds` and `default_wall_timeout_seconds`; `list` includes `isolation` and `worktree_exists`.

### Fixed
- **Zero stderr pollution in progress & liveness**: Codex CLI background stderr noise (e.g. `codex_models_manager::manager: failed to refresh available models`) is preserved in `codex.stderr.log` and `review.stderr`, but NO LONGER written into `progress.json` / `progress.jsonl`, so it never falsely resets `lastActivityAt` / `idle_timeout` or aborts long-polls. Internal bridge notices (stall warning, cancel, timeout) also preserve true `lastActivityAt`.
- **True worktree escape attribution (zero parallel false positives)**: Under `workspace-write`, parent checkout edits performed concurrently by the coordinator no longer trigger false `WORKTREE ESCAPE` warnings — they are transparently noted in `concurrent_parent_changes`. Real escapes are still caught via Codex `file_change` path bounds (symlink-normalized), command targeting attribution (ignoring read-only inspections and benign `node_modules`/`.venv` symlinks), and conservative full detection under `danger-full-access`.
- **Deduplicated command events**: `item.started` + `item.completed` pairs for `command_execution` / `shell_command` / `tool_call` no longer emit duplicate `Running:` entries in `progress.jsonl` or `events.commands`; non-zero exit codes surface explicitly as `Command exited <code>: ...`, while clean completions refresh `lastActivityAt` via `touchActivity()` without bumping `seq`.
- **Worktree dependency guidance in Project Brief**: Isolated worktrees note that gitignored `node_modules`/`.venv` are not copied and must not be installed into the parent checkout.

## v2.3.7

Multi-client MCP ergonomics, shadow `CODEX_HOME` fidelity, and worktree lifecycle fixes (Antigravity, Claude Code, and any standard Stdio MCP client).

### Added
- **Native MCP server `instructions` & rich Zod parameter descriptions**: Protocol-level guidance for progressive retrieval (`status → summary → diff`), `isolation="worktree"`, `codex_resume`, and context economy — works out of the box across MCP clients without client-specific prompt files.
- **Auto-discovery of `codex` binary**: `resolveCodexBinary()` now probes `CODEX_BINARY`, `/Applications/Codex.app/...`, `~/.local/bin/codex`, `~/.codex/packages/standalone/current/bin/codex`, Homebrew, npm-global, Volta, Bun, and `PATH`; `buildCodexEnv()` prepends the binary's directory (and realpath dir) so sibling helpers (e.g. `codex-code-mode-host`) resolve even under minimal GUI `PATH`.
- **`return_view` (`full` | `summary`)** on `codex_exec` and `codex_resume`: lets fast sync/auto completions return the compact summary directly instead of dumping full diffs into context.
- **`CODEX_BRIDGE_MAX_WAIT_SECONDS`**: Optional server-side wait ceiling (`10..240`) to keep long-poll / sync budgets within strict MCP client timeouts.
- **`codex_resume` parity**: Added `effort`, `acceptance`, and `non_goals` parameters; inherits parent run `effort` when omitted.
- **Enhanced `codex_sessions doctor`**: Reports `codex_binary_realpath`, `codex_auth` (`codex login status`), `bridge_home`, `bridge_home_writable`, `active_worktrees`, and `max_wait_seconds`.
- **`summary` view worktree metadata**: Includes `isolation`, `worktree_path`, and `parent_git_root`.

### Fixed
- **Shadow `CODEX_HOME` model/provider inheritance & 275× faster zero-grant startup**: `extractSafeCodexDefaults()` preserves allowlisted non-capability keys (`model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `service_tier`, `model_provider`) and only the referenced `[model_providers.<name>]` block into shadow `config.toml` while continuing to strip plugins, marketplaces, `notify`, sandbox overrides, and ungranted MCP servers. Zero-grant (`grants_mcp=[]`) runs skip probing the real `~/.codex` MCP list while keeping the fail-closed post-write shadow probe.
- **Worktree trust & project brief alignment**: `codex_exec` in `isolation="worktree"` now trusts `worktreePath` (not parent repo) in shadow `config.toml`, points `- Git root:` in the project brief at `worktreePath`, uses `buildGitEnv()` for `git worktree add/remove`, and rolls back `runDir` + `worktreePath` on setup/grant failures.
- **Worktree `codex_resume` continuity**: Resuming a worktree session continues inside the existing worktree (accepting either the repo root or worktree path as `cwd`), preserves parent-checkout escape detection, and fails clearly if the worktree was already cleaned up.

## v2.3.6

- Fixed `grants.ts` `extractServerBlocks()` with a unified char-level TOML string/comment lexer so multi-line `"""` / `'''` strings cannot leak `[` bracket depth across lines.
- Expanded unit test coverage across `progress`, `evidence`, `statusline`, and `worker` modules.

## v2.3.5

- Added `CODEX_BRIDGE_HOME` environment variable override to redirect durable state (`runs/`, `projects/`, `sessions/`, `wt/`) for sandboxed environments.
- Added worker MCP capability grants (`grants_mcp`) enforced via a fail-closed shadow `CODEX_HOME` (zero MCP surface by default).

## v2.3.4

- Context-economy pass on `codex_sessions`: `wait_seconds` ceiling raised 60 → 240 (one long-poll covers up to 4 minutes of a quiet run, cutting model round-trips ~4×), and `action:"list"` now returns compact rows by default (`verbose: true` restores the full field set) — real sessions produced 6.4k-token truncated list dumps.
- Poll-cadence guidance updated: `next_poll_after_seconds` suggests 60s/120s instead of 20s/60s, tool description and CLAUDE.md document the 240s ceiling.

## v2.3.3

- Deterministic model evidence: every run records `model`/`model_source` (flag|config|unknown), `effort`/`effort_source`, and `codex_version`. Codex JSONL emits no model field, so resolution reads the same config.toml Codex reads; unknown stays unknown. Surfaced in status, list, summary, and review views.
- New regression test covering the resolution matrix (config.toml, flag override, honest unknown).

## 2.3.1

### Fixed
- **Worktree escape detection**: in `isolation=worktree` mode the worker snapshots the parent checkout's `git status` before and after the run; any paths the worker modified outside its worktree surface as `WORKTREE ESCAPE` warnings, since the run-scoped diff cannot see them. Codex's workspace-write boundary is the repo family, not the worktree dir, so prompt-level discipline is required — the exec contract now names the worktree as the only writable path and the parent checkout as read-only.
- **`async` flag consistency**: `statusView`/`get` now mirror the completed packet's `async` value instead of always reporting `true`.

## 2.3.0

### Added
- **`isolation=worktree`**: Runs execute inside a dedicated `git worktree` under `~/.codex-bridge/wt/<run_id>` instead of the live checkout. Workers no longer touch the caller's working tree, runs on the same repo can proceed in parallel (the write-lock is per-worktree), and the run-scoped diff is by construction free of pre-existing dirty files. `base` selects the starting ref (default `HEAD`).
- **`codex_sessions cleanup`**: Removes a run's worktree (`git worktree remove --force`).
- **`effort` param**: Passed through to Codex as `-c model_reasoning_effort="<value>"` on both exec and resume, enabling per-run reasoning-tier routing.
- **`output_schema` param**: JSON schema written to the run dir and passed via `--output-schema`, forcing a structured final message from the worker.
- **`acceptance` / `non_goals` params**: Rendered into the task as an explicit contract block (acceptance criteria to verify, non-goals to avoid) — aligns the worker prompt with spec-driven delegation.
- **`worker.log`**: Worker stdout/stderr now captured per run under the run dir. Previously `stdio:"ignore"` made worker crashes invisible.
- **Review/status fields**: `isolation`, `worktree_path`, `parent_git_root` are now reported in the run handle, status view, and review packet.

### Fixed
- **Long-poll first-call stall**: `waitForProgressOrReview` now baselines the seq cursor at call time when `since_seq` is absent. Previously a poll without a cursor could only be woken by `review.json` or the deadline, so every first poll silently burned the full `wait_seconds`.
- **Silent event loss**: `readProgressEventsSince` returned the *tail* `limit` events after the cursor, permanently skipping intermediate events. Cursor pagination now returns the *earliest* unseen events; tail semantics kept for the no-cursor "recent N" display.
- **Progress thinning**: The worker persisted only every 3rd progress event, causing long silent stretches that looked like stalls. Every parsed Codex event now reaches `progress.jsonl`/`progress.json`.
- **Completion latency**: `pollForCompletion` replaced the flat 500ms `setTimeout` loop with `fs.watch` + short fallback, so sync waits resolve the moment `review.json` lands.
- **ps truncation false-negative**: `pidLooksLikeCodexForRun` could fail on long argv (`ps -o command=` truncates), making `stop` report "not active" while Codex kept running. Liveness now also accepts `codexPid` being a descendant of the verified `workerPid` via the ppid chain.
- **Event tail window**: `PROGRESS_TAIL_BYTES` raised 32KB → 128KB to reduce cursor-unreachable history on chatty runs.

## 2.2.7

### Fixed
- **fs.watch error handler**: `waitForProgressOrReview` watcher now listens for `error` event and falls back to timer polling. Prevents MCP server crash on filesystem errors during long-poll.
- **JSONL overflow warning**: Overlong line omissions are counted and reported in review packet `warnings`, visible in summary view.
- **Progress write frequency**: Important events (`Running:`, `Editing:`, `Saved:`, `Timeout`, `Cancellation`) now always trigger progress write with `lastActivityAt`, improving long-poll real-time accuracy.

## 2.2.6

### Fixed
- **JSONL line buffer cap**: `feed()` parser buffer capped at 2MB. Overlong non-newline stdout chunks are omitted with a marker instead of growing indefinitely. (Co-authored-by: Codex)

## 2.2.5

### Fixed
- **Stale semantic precision**: Separate `lastActivityAt` (real Codex activity) from `updatedAt` (bridge progress write). Stall timer warning no longer resets activity timestamp, so `stale: true` triggers correctly even after worker writes "Codex may be stuck" message.
- **nextAction priority**: `partial_changes` now checked before `status !== "completed"`, matching real decision order.
- **diff view files cap**: `diffOnlyView` uses `compactFiles()` to limit file list, consistent with summary view.
- **README timing**: Updated from "180s / 3 minutes" to "60s" to match v2.2 default `wait_budget_seconds`.

### Added
- **suggested_action in status**: Returns `continue_polling` / `ask_user_whether_to_continue_or_stop` / `read_summary` to guide Claude behavior.
- **First-poll events**: Status view returns recent 3 progress events even without `since_seq`, so first poll shows context.
- **Stale poll interval**: Changed from 0 (aggressive) to 60s when stale — stops Claude from tight-looping on stuck runs.

## 2.2.3

### Fixed
- **ESM compatibility**: `waitForProgressOrReview` used `require("fs")` which fails in ESM. Replaced with static `import { watch as fsWatch }`. (Codex review finding)
- **Timer stacking**: fs.watch events could stack multiple fallback timers. Now clears previous timer before scheduling next.
- **Memory safety**: `readProgressEventsSince` reads only tail 32KB of progress.jsonl instead of full file load. Prevents OOM on long runs.

## 2.2.2

### Fixed
- **Stale false positive**: `statusView` no longer flags completed/terminal runs as stale. `stale` and `seconds_since_last_activity` only appear for active runs.

### Added
- **Summary budget control**: `compactReviewSummary` caps files (40), warnings (20), risk_flags (20) with `{items, total, truncated}` structure. Returns `next_action` hint for Claude's next step.
- **Event-driven long-poll**: `waitForProgressOrReview` uses `fs.watch` on runDir with 2s fallback timer, replacing pure 1s file polling.
- **Incremental progress events**: `status` view returns `progress_events` (from progress.jsonl) when `since_seq` is provided. Claude sees continuous activity log instead of single latest message.

## 2.2.0

Interaction protocol upgrade: view-based progressive retrieval, long-poll, dynamic timeout.

### Added
- **View system**: `codex_sessions get` now supports `view` parameter (`status`|`summary`|`review`|`diff`|`output`). Default is `status` — lightweight JSON for polling. `summary` returns diff stats + warnings + output tail without full diff. `review`/`diff`/`output` return specific slices.
- **Long-poll**: `wait_seconds` parameter (0-60) lets Claude wait for progress changes or completion in a single call instead of sleep+poll cycles. `since_seq` parameter triggers early return when progress advances.
- **Dynamic timeout**: `timeout` no longer defaults to 300s for all tasks. read-only→300s, async→1200s, write→900s. Eliminates most premature kills on complex tasks.
- **`max_chars` control**: Limits output/diff/stderr size in responses. Default 20000. Prevents context window pollution.

### Changed
- **Default `wait_budget_seconds`**: 180→60. Users see async handle within 1 minute instead of waiting 3 minutes.
- **`getByRunId` rewritten**: Now accepts view/maxChars/waitSeconds/sinceSeq. Returns view-appropriate response instead of always dumping full review packet.
- `ReviewPacketLike` type expanded to cover all fields worker actually writes (failure_hint, duration_ms, events, fs_sentinel, warnings, etc.).

## 2.1.1

### Fixed
- **Proxy env completeness**: `buildCodexEnv()` now mirrors all proxy variables to both cases and derives `ALL_PROXY`/`all_proxy` from `HTTP_PROXY`. Previously only passed uppercase `HTTP_PROXY`/`HTTPS_PROXY` and derived `WS_PROXY`/`WSS_PROXY`, missing lowercase variants and `ALL_PROXY` that Codex CLI's internal network-proxy module expects.

## 2.1.0

Architecture upgrade from synchronous blocking to bounded sync + async worker.

### Added
- **Async worker**: long tasks (>3 min) automatically switch to detached background worker. Results recoverable via `run_id` after Claude Code disconnects.
- **Status line**: `codex-bridge install-statusline` shows live Codex progress in Claude Code's status bar.
- **Project brief**: automatic project context injection (package manager, tech stack, directory structure) reduces Codex cold-start exploration.
- **Network detection**: three-layer system — 30s no-response real-time signal, post-failure error code classification (`failure_hint`), and `doctor` TCP connectivity probe.
- **Session pointer index**: O(1) session-to-run lookup for async resume, replacing O(n) filesystem scan.
- **Durable state stats**: `codex_sessions doctor` reports run count, session pointers, disk usage, and cleanup policy.
- `execution_mode` parameter: `auto` (default) / `sync` / `async`.
- `wait_budget_seconds` parameter: configurable sync wait window (default 180s, max 240s).
- `project_brief` parameter: toggle project context injection.
- `run_id` parameter on `codex_sessions get/stop` for async polling.
- Sensitive path reference detection in diff (`risk_flags`).

### Changed
- Worker holds write lock (not MCP handler) — survives MCP server disconnects.
- PID verification upgraded to run-scoped: `pidLooksLikeCodexForRun` and `pidLooksLikeBridgeWorker` check command line against run ID, preventing PID reuse false positives.
- Stop uses cancel file protocol — kills Codex, lets worker finalize review packet with after-snapshot. SIGTERM followed by 5s SIGKILL fallback for orphan Codex.
- Session active guard prevents concurrent resume of the same Codex thread.
- Stale session pointers (pointing to cleaned-up runs) are safely skipped.
- Durable state directories hardened to 0700, files to 0600. Worker sets `umask(0o077)`.
- `cleanOldRuns` triggered on startup and throttled hourly during use, not just on restart.
- `.DS_Store` / `Thumbs.db` added to low-value diff filter.

### Fixed
- Worker spawn via `npx tsx` caused PID mismatch — `npx` intermediate process exited immediately, triggering false `worker_crashed` detection. Fixed by resolving tsx binary directly.
- `codex_sessions stop` with existing `review.json` refused to kill orphan Codex child. Fixed: checks `codexAlive` before returning "not active".
- Terminal progress without review.json left runs in limbo. Fixed: `markWorkerDeadIfNeeded` and `ensureReviewForTerminal` guarantee every terminal state has a review packet.
- `run_id` path traversal vulnerability. Fixed: UUID regex validation at schema and runtime.
- Unknown external resume silently ignored `sandbox` parameter. Fixed: explicit rejection.
- `buildRunHandle` always returned `status: "running"` even for failed/timeout states. Fixed: status-aware.

## 1.4.1

Sealed v1 release. Single-file MCP server (~413 lines). Synchronous Codex execution with run-scoped git diff, sensitive content alias detection, smart preview, resume thread verification, cross-process write lock, JSONL health check.
