# Changelog

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
