---
name: codex-bridge
description: Delegate implementation, multi-file edits, test authoring, or second-opinion review to OpenAI Codex CLI via the codex-bridge MCP server with run-scoped git diffs, worktree isolation, and progressive evidence retrieval. Use when collaborating with Codex or orchestrating Codex workers.
---

# codex-bridge Workflow

`codex-bridge` is a run-scoped MCP evidence layer between the planning/review agent and OpenAI Codex CLI (`codex_exec`, `codex_resume`, `codex_sessions`).

## 1. Pre-flight

On first use in a session or after any environment error, run:
```json
codex_sessions({ "action": "doctor" })
```
Verify `codex_version.ok`, `codex_auth.ok`, `git_version.ok`, and `bridge_home_writable`.

## 2. Launching Work (`codex_exec`)

- **Self-contained `task`**: Codex has zero memory of the current chat. Include file paths, constraints, exact goals, and verification commands.
- **Structured contract**: Always fill `acceptance` (concrete checks Codex must run before finishing) and `non_goals` (explicit boundaries).
- **`cwd`**: Absolute path to the repository root.
- **Prefer `isolation: "worktree"`** for write tasks: keeps the caller's working tree untouched, allows parallel runs (even while the coordinator edits unrelated files in the parent checkout), and produces a pure run-scoped diff. Harvest approved changes in one call with `codex_sessions(action="apply", run_id=..., dry_run=true|false, cleanup=true)` or discard unused worktrees with `action="cleanup"`.
- **No arbitrary wall-clock cutoff**: Omit `timeout` by default — runs are governed by an activity-based `idle_timeout` watchdog (default `900s` of zero real Codex JSONL stdout events; `0` disables). Only pass `timeout` when you explicitly want a hard wall-clock ceiling.
- **Model & effort**: Omit `model` / `effort` by default so the shadow `CODEX_HOME` inherits the user's configured defaults from `~/.codex/config.toml` (including `model_provider`). Override explicitly only when routing a specific tier.
- **Security (`grants_mcp`)**: Leave omitted (zero MCP surface by default). Only grant vetted servers if the task genuinely needs them.

### Execution Mode Matrix

| Task Type | `execution_mode` | `wait_budget_seconds` | `return_view` | `idle_timeout` | `timeout` |
| --- | --- | ---: | --- | ---: | --- |
| Read-only audit / focused lookup | `auto` | `45` | `summary` | default (`900`) | omit (`null`) |
| Small single-file patch | `auto` | `60` | `summary` | default (`900`) | omit (`null`) |
| Feature implementation / test run | `async` | — | — | default (`900`) | omit (`null`) |
| Large refactor / deep `xhigh` reasoning | `async` | — | — | default (`900`) or `1200` | omit (`null`) |

## 3. Waiting on Async Runs

When `codex_exec` returns `async: true` or `status: "running"`:

1. Keep the `run_id` and do not start a second `inplace` write run on the same repo (parallel `isolation: "worktree"` runs are safe).
2. Wait cleanly for completion in one call with `view: "summary"` and `wait_seconds` (`wait_for` defaults to `"terminal"`, waking on completion/failure/stale/deadline instead of every intermediate step):
   ```json
   codex_sessions({
     "action": "get",
     "run_id": "<run_id>",
     "view": "summary",
     "wait_seconds": 240
   })
   ```
   Pass `"view": "status", "wait_for": "progress", "since_seq": <last_seq>` only when you explicitly want live intermediate step ticks.
3. Never tight-loop with `wait_seconds: 0`. Respect `next_poll_after_seconds` and `CODEX_BRIDGE_MAX_WAIT_SECONDS`.
4. If `stale: true` (5+ minutes without real Codex JSONL events), inform the user before calling `stop`.

## 4. Progressive Review & Worktree Harvest (Context Economy)

Never pull the full `review` packet by default. Follow this sequence once `review_ready: true`:

1. **`view: "summary"`** (returned directly by `wait_for="terminal"` or `return_view="summary"`): inspect `status`, `worktree_path`, `git_diff.files`, `risk_flags`, `warnings`, `concurrent_parent_changes`, `output_tail`, and `next_action`.
2. **`view: "diff"`** (`max_chars: 60000`): inspect the actual patch on demand (or read `git_diff.diff_path` directly).
3. **`view: "output"`** (`max_chars: 10000`): inspect Codex's full explanation/test output only when needed.
4. For `isolation: "worktree"` runs whose diff passes review, preview and land changes atomically into the parent checkout:
   ```json
   codex_sessions({ "action": "apply", "run_id": "<run_id>", "dry_run": true })
   codex_sessions({ "action": "apply", "run_id": "<run_id>", "cleanup": true })
   ```
   Multi-turn `codex_resume` worktree sessions automatically apply the cumulative worktree diff from `HEAD` (`scope: "auto"`). Re-run verification in the main workspace afterward.

## 5. Multi-Turn Iteration (`codex_resume`)

- For fixes or follow-up changes to the same task, use `codex_resume` with `session_id` (not `run_id`). It automatically continues inside the same worktree and inherits `effort`, `idle_timeout`, and shadow `CODEX_HOME`.
- For an unrelated task, start a fresh `codex_exec`.
