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
- **Prefer `isolation: "worktree"`** for write tasks: keeps the caller's working tree untouched, allows parallel runs on the same repo, and produces a pure run-scoped diff. Always clean up finished worktrees with `codex_sessions(action="cleanup", run_id=...)` after reviewing/applying changes.
- **Model & effort**: Omit `model` / `effort` by default so the shadow `CODEX_HOME` inherits the user's configured defaults from `~/.codex/config.toml` (including `model_provider`). Override explicitly only when routing a specific tier.
- **Security (`grants_mcp`)**: Leave omitted (zero MCP surface by default). Only grant vetted servers if the task genuinely needs them.

### Execution Mode Matrix

| Task Type | `execution_mode` | `wait_budget_seconds` | `return_view` | `timeout` |
| --- | --- | ---: | --- | ---: |
| Read-only audit / focused lookup | `auto` | `45` | `summary` | `300` |
| Small single-file patch | `auto` | `60` | `summary` | `600` |
| Feature implementation / test run | `async` | — | — | `1200` |
| Large refactor / multi-file migration | `async` | — | — | `1800` |

## 3. Polling Async Runs

When `codex_exec` returns `async: true` or `status: "running"`:

1. Keep the `run_id` and do not start a second `inplace` write run on the same repo.
2. Long-poll with `view: "status"` and `since_seq`:
   ```json
   codex_sessions({
     "action": "get",
     "run_id": "<run_id>",
     "view": "status",
     "wait_seconds": 60,
     "since_seq": 0
   })
   ```
3. Never tight-loop with `wait_seconds: 0`. Respect `next_poll_after_seconds` and `CODEX_BRIDGE_MAX_WAIT_SECONDS`.
4. If `stale: true` (5+ minutes without real Codex events), inform the user before calling `stop`.

## 4. Progressive Review (Context Economy)

Never pull the full `review` packet by default. Follow this sequence once `review_ready: true`:

1. **`view: "summary"`** (if not already returned via `return_view: "summary"`): inspect `status`, `worktree_path`, `git_diff.files`, `risk_flags`, `warnings`, `output_tail`, and `next_action`.
2. **`view: "diff"`** (`max_chars: 60000`): inspect the actual patch on demand (or read `git_diff.diff_path` directly).
3. **`view: "output"`** (`max_chars: 10000`): inspect Codex's full explanation/test output only when needed.
4. For `isolation: "worktree"` runs whose diff passes review, apply `git_diff.diff_path` (or copy approved files) into the main workspace, re-run verification, and call `codex_sessions(action="cleanup", run_id=...)`.

## 5. Multi-Turn Iteration (`codex_resume`)

- For fixes or follow-up changes to the same task, use `codex_resume` with `session_id` (not `run_id`). It automatically continues inside the same worktree and inherits `effort` and shadow `CODEX_HOME`.
- For an unrelated task, start a fresh `codex_exec`.
