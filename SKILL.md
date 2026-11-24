---
name: codex-bridge
description: Delegate implementation, multi-file edits, test authoring, or second-opinion review to OpenAI Codex CLI via the codex-bridge MCP server with isolated snapshot repos, out-of-band Git tree evidence, private 3-way merge apply, wait-any orchestration, and macOS Seatbelt kernel browser protection. Use when collaborating with Codex or orchestrating Codex workers.
---

# codex-bridge v3.1 Workflow

`codex-bridge` is a run-scoped MCP execution and evidence kernel between a planning/review agent and OpenAI Codex CLI (`codex_exec`, `codex_resume`, `codex_sessions`).

## 0. Scope & Triage

- **Use `codex-bridge`** for parallel multi-worker runs, multi-file isolated writes, long background tasks, second-opinion reviews requiring verified filesystem diffs, or shared multi-session hosts.
- **Skip `codex-bridge`** for trivial one-line shell checks or pure live-browser/UI verification (run browser QA on the host via `browse` / browser tools outside Seatbelt).

## 1. Pre-flight (`doctor`)

On first use in a session or after any environment error, run:

```json
codex_sessions({ "action": "doctor" })
```

Verify:
- `codex_version.ok`, `codex_auth.ok`, `git_version.ok`, `cli_probe.mcpListSupported`, and `bridge_home_writable`.
- On **macOS**, check `darwin_exec_deny_enforced`:
  - `true`: bridge-private patched `codex` (`~/.codex-bridge/bin/codex`) is active and enforces XNU Seatbelt `deny process-exec` for GUI browsers.
  - `false`: only bridge-layer P0/P2 mitigations (contract + `rules/` + `sandbox_gui_crash` attention) are active; install the prebuilt private kernel binary via `scripts/install-patched-codex.sh` (or build from source via `scripts/build-patched-codex.sh`) when full kernel blocking is required.

## 2. Launching Work (`codex_exec`)

- **Self-contained `task`**: Codex has zero memory of the current chat. Include exact file paths, constraints, target behavior, and verification commands.
- **Explicit contract**: Always fill `acceptance` (concrete checks Codex must run before finishing) and `non_goals` (hard scope boundaries).
- **`cwd`**: Absolute path to the repository root.
- **Prefer `isolation: "worktree"`** for write tasks: creates a standalone snapshot repository + out-of-band `evidence.git` (immutable `origin_tree → before_tree → after_tree`; immune to agent `git commit`, `git reset`, or `.gitignore` tampering).
  - Default `base: "HEAD"` starts from a clean commit.
  - Pass `base: "working_tree"` when you explicitly want current uncommitted parent edits frozen as `origin_tree`.
- **Optional model-free `prepare`**: Pass `prepare: { command, args, timeout_seconds }` to install/link workspace dependencies deterministically before invoking Codex (fails fast with zero model tokens spent if setup fails).
- **Idempotency (`idempotency_key`)**: Pass a unique `idempotency_key` on retryable calls for at-most-once admission across MCP disconnects.
- **Attention-only default (no silent auto-kill)**: Both `timeout` and `idle_timeout` default to `null` (never auto-kill a healthy reasoning turn). By default, `idle_attention_seconds: 900` raises a 1-shot `attention` signal (alongside `repeated_failure`, `no_response`, and `sandbox_gui_crash`) waking `wait_for="terminal"` so you decide whether to continue or `stop`. Pass explicit `idle_timeout` or `timeout` only for unattended hard budgets.
- **Model & effort**: Omit `model` / `effort` by default so the shadow `CODEX_HOME` inherits `~/.codex/config.toml` defaults cleanly.
- **Zero-MCP security (`grants_mcp`)**: Leave omitted unless explicitly needed (zero MCP surface by default; repo-injected `.codex/config.toml` servers are rejected fail-closed).
- **macOS browser / visual QA boundary**: Sandboxed macOS workers (`read-only` / `workspace-write`) do **not** provide GUI browser or live screenshot execution (Seatbelt blocks `HIServices` / LaunchServices; unpatched Chrome aborts with `SIGABRT 134` and triggers desktop crash dialogs; the patched kernel binary blocks browser `execve` with `EPERM`). Never ask a sandboxed macOS worker to run Chrome, Safari, Playwright, or Puppeteer screenshots; if a worker reports `HOST_VISUAL_QA_REQUIRED` or raises `sandbox_gui_crash`, take over visual QA on the host and never retry inside the sandbox.

### Execution Mode Matrix

| Task Type | `execution_mode` | `wait_budget_seconds` | `return_view` | `idle_timeout` | `timeout` |
| --- | --- | ---: | --- | --- | --- |
| Read-only audit / focused lookup | `auto` | `45` | `summary` | omit (`null`) | omit (`null`) |
| Small single-file patch | `auto` | `60` | `summary` | omit (`null`) | omit (`null`) |
| Feature implementation / test run | `async` | — | — | omit (`null`) | omit (`null`) |
| Unattended cost-capped batch job | `async` | — | — | explicit (e.g. `900`) | explicit (e.g. `1800`) |

## 3. Waiting & Parallel Orchestration (`action="get"`)

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
  Returns `ready` (all runs matching predicate), updated `cursor` (pass back on next wait so already-consumed terminal states/attentions do not re-wake), and per-run views with per-item missing-run isolation.
- Stream live step ticks only when needed via `"view": "status", "wait_for": "progress", "since_seq": <last_seq>`.

### Attention & Recovery Matrix

| Signal | Meaning | Coordinator Action |
| --- | --- | --- |
| `attention.code = "idle_silence"` | Observed active silence hit `idle_attention_seconds` (host sleep excluded) | Inspect `view: "status"` / `commands`; keep waiting if legitimately reasoning, else `stop` |
| `attention.code = "repeated_failure"` | Identical command failed 3+ times with same exit code | Inspect failure via `view: "status"` / `output`; steer via `stop` + `codex_resume` |
| `attention.code = "no_response"` | Zero Codex JSONL events after 30s | Check API connectivity / proxy / auth (`doctor`), then `stop` if wedged |
| `attention.code = "sandbox_gui_crash"` | Sandboxed macOS worker hit browser execution denial or `SIGABRT` | Non-retryable — do not retry browser flags; finish code review and run visual QA on host |
| `liveness = "unknown"` | Worker exited while Codex child may still be writing | Do **not** force-cleanup or resume; wait or call `action="stop"` first. Reconcile auto-salvages logs, `session_id`, and disk tree once writer exits |

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
   - Rejects symlinks, gitlinks, `.git`/`..` escapes, case-folding collisions, and sensitive files/aliases automatically. Re-run project verification in parent afterward.

## 5. Multi-Turn Iteration (`codex_resume`)

- Pass `session_id` (not `run_id`) to continue in the same isolated workspace with inherited `evidence.git`, `origin_tree`, `effort`, budgets, and shadow `CODEX_HOME`.
- Start an unrelated task with a fresh `codex_exec`.
