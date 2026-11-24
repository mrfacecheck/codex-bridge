---
name: codex-bridge
description: Delegate implementation, multi-file edits, test authoring, or second-opinion review to OpenAI Codex CLI via the codex-bridge MCP server with isolated snapshot repos, out-of-band Git tree evidence, private 3-way merge apply, and wait-any orchestration. Use when collaborating with Codex or orchestrating Codex workers.
---

# codex-bridge v3.0 Workflow

`codex-bridge` is a run-scoped MCP execution & evidence kernel between the planning/review agent and OpenAI Codex CLI (`codex_exec`, `codex_resume`, `codex_sessions`).

## 1. Pre-flight

On first use in a session or after any environment error, run:
```json
codex_sessions({ "action": "doctor" })
```
Verify `codex_version.ok`, `codex_auth.ok`, `git_version.ok`, `cli_probe.mcpListSupported`, and `bridge_home_writable`.

## 2. Launching Work (`codex_exec`)

- **Self-contained `task`**: Codex has zero memory of the current chat. Include file paths, constraints, exact goals, and verification commands.
- **Structured contract**: Always fill `acceptance` (concrete checks Codex must run before finishing) and `non_goals` (explicit boundaries).
- **`cwd`**: Absolute path to the repository root.
- **Prefer `isolation: "worktree"`** for write tasks: creates an isolated standalone snapshot repository + out-of-band `evidence.git` (immutable `origin_tree → before_tree → after_tree`; immune to agent `git commit`/`reset` or `.gitignore` tampering).
  - Default `base: "HEAD"` starts from a clean commit.
  - Pass `base: "working_tree"` explicitly when you want uncommitted parent edits frozen as `origin_tree` for Codex to build on.
- **Optional model-free `prepare`**: Pass `prepare: { command, args, timeout_seconds }` to install/link dependencies deterministically inside the workspace before Codex runs (fails fast with zero model tokens spent if setup fails).
- **Idempotency (`idempotency_key`)**: Pass a unique `idempotency_key` on retryable calls for at-most-once admission across MCP disconnects.
- **Attention-only default (no silent auto-kill)**: Both `timeout` and `idle_timeout` default to `null` (never auto-kill a healthy reasoning turn). By default, `idle_attention_seconds: 900` raises a 1-shot `attention` signal (and `repeated_failure` fires after 3 identical command failures) waking `wait_for="terminal"` so you decide whether to continue or `stop`. Pass explicit `idle_timeout` or `timeout` only when you want an unattended hard budget.
- **Model & effort**: Omit `model` / `effort` by default so the shadow `CODEX_HOME` inherits `~/.codex/config.toml` defaults cleanly.
- **Security (`grants_mcp`)**: Leave omitted (zero MCP surface by default; project `.codex/config.toml` injections are rejected fail-closed).

### Execution Mode Matrix

| Task Type | `execution_mode` | `wait_budget_seconds` | `return_view` | `idle_timeout` | `timeout` |
| --- | --- | ---: | --- | --- | --- |
| Read-only audit / focused lookup | `auto` | `45` | `summary` | omit (`null`) | omit (`null`) |
| Small single-file patch | `auto` | `60` | `summary` | omit (`null`) | omit (`null`) |
| Feature implementation / test run | `async` | — | — | omit (`null`) | omit (`null`) |
| Unattended cost-capped batch job | `async` | — | — | explicit (e.g. `900`) | explicit (e.g. `1800`) |

## 3. Waiting on Async Runs (Single & Parallel Wait-Any)

- **Single worker**:
  ```json
  codex_sessions({ "action": "get", "run_id": "<run_id>", "view": "summary", "wait_seconds": 240 })
  ```
  Defaults to `wait_for: "terminal"` — wakes on completion/failure, `liveness: "unknown"`, first unacked `attention`, or wait deadline.
- **Parallel workers (native wait-any multiplexer)**:
  ```json
  codex_sessions({
    "action": "get",
    "run_ids": ["<r1>", "<r2>", "<r3>"],
    "cursor": { "<r1>": 12, "<r2>": 7 },
    "view": "summary",
    "wait_seconds": 240
  })
  ```
  Returns `ready` (all runs matching predicate), updated `cursor` (pass back on next wait so already-consumed terminal states/attentions do not re-wake), and per-run views without a single missing ID failing the batch.
- Pass `"view": "status", "wait_for": "progress", "since_seq": <last_seq>` only when streaming live step ticks.
- If `liveness: "unknown"`, the worker died while Codex may still be writing: **do not** force-cleanup or resume; wait or call `action="stop"` first. Once writer exits, reconcile automatically salvages direct-FD logs, `session_id`, and disk changes.

## 4. Progressive Review & Recoverable 3-Way Apply

Once `review_ready: true`:
1. **`view: "summary"`**: inspect `status`, `outcome`, `evidence`, `git_diff.files`, `risk_flags`, `warnings`, `attention`, `commands`, `reported_usage`, `output_tail`, and `next_action`.
2. **`view: "diff"`** (`max_chars: 60000`) / **`view: "output"`** (`max_chars: 10000`) on demand.
3. **Preview & apply via private-store 3-way merge (`merge-tree`) + crash-recoverable materialization**:
   ```json
   codex_sessions({ "action": "apply", "run_id": "<run_id>", "dry_run": true })
   codex_sessions({ "action": "apply", "run_id": "<run_id>", "cleanup": true })
   ```
   - Preserves parent `.git/index` (staged changes) and merges disjoint parent edits cleanly; conflicts leave zero writes in parent.
   - Multi-turn `codex_resume` applies track a per-target watermark so Turn 2 merges only the incremental delta since Turn 1's applied tree.
   - Rejects symlinks, gitlinks, `.git`/`..` escapes, and sensitive files/aliases automatically. Re-run project verification in parent afterward.

## 5. Multi-Turn Iteration (`codex_resume`)

- Use `codex_resume` with `session_id` (not `run_id`) to continue in the same isolated workspace with inherited `evidence.git`, `origin_tree`, `effort`, budgets, and shadow `CODEX_HOME`.
- Start an unrelated task with a fresh `codex_exec`.
