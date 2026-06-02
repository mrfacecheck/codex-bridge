# Changelog

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
