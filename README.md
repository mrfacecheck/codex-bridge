# codex-bridge

**English** · [中文文档](./README.zh-CN.md)

Not a Codex wrapper. Not a chat bridge. Not a review-only plugin. Not a multi-agent terminal.

`codex-bridge` v3.1 is a **run-scoped MCP execution and evidence kernel**: Codex executes inside isolated snapshot repositories, your MCP agent (Antigravity, Claude Code, Cursor, etc.) plans and reviews, and every handoff is grounded in out-of-band Git tree evidence and recoverable 3-way merges.

```
MCP Client (Antigravity / Claude Code / Cursor)
   ──[MCP stdio]──▶ codex-bridge v3.1 ──▶ Codex CLI (or private kernel-patched binary)
                         │
                         ├─ isolated snapshot repo + out-of-band evidence.git
                         ├─ private 3-way merge-tree & crash-recoverable apply
                         ├─ zero-MCP shadow CODEX_HOME (fail-closed grants)
                         ├─ sleep-immune attention + multi-worker wait-any
                         └─ macOS Seatbelt kernel browser exec-deny boundary
```

## Quick start

Clone from GitHub and build locally:

```bash
git clone https://github.com/mrfacecheck/codex-bridge.git
cd codex-bridge && pnpm install && pnpm build
```

Verify from your MCP client by running `codex_sessions` with `{"action": "doctor"}`.

## Architecture

```
codex_exec / codex_resume
  → idempotency claim + owner-nonce lease + optional model-free prepare
  → detached worker (survives MCP disconnect; direct-FD JSONL stdout/stderr)
    → freeze origin_tree / before_tree in private evidence.git
    → spawn Codex CLI inside zero-MCP shadow CODEX_HOME
    → seal after_tree + generate review packet (sensitive paths/aliases filtered)

codex_sessions get (single run_id or parallel run_ids[] wait-any)
  → view=status:  lightweight poll (shared fs.watch multiplexer)
  → view=summary: file stats, evidence OIDs, attention, warnings, output tail
  → view=diff / output / review: on-demand detail

codex_sessions apply
  → private git merge-tree --write-tree inside evidence.git (preserves parent index)
  → durable PREPARED → COMMITTED ApplyIntent with atomic per-file replacement
```

Core decisions:
- **Worker is detached** — MCP server crash or session disconnect never kills Codex; direct-FD logs allow automatic post-crash salvage once the writer exits.
- **Isolated snapshot repos + out-of-band `evidence.git`** — `isolation="worktree"` creates a standalone snapshot repo with an immutable `origin_tree` sealed into private `evidence.git`. Even if Codex runs `git commit`, `git reset`, or edits `.gitignore`, every modified byte remains captured. Supports `base="HEAD"` (default) and `base="working_tree"`.
- **Private 3-way `merge-tree` & recoverable apply** — `codex_sessions(action="apply", run_id=..., dry_run?, cleanup?)` merges inside `evidence.git`, preserves parent `.git/index` and disjoint parent edits, tracks multi-turn `codex_resume` watermarks, and leaves zero parent writes on conflict.
- **Progressive views & native `wait-any`** — Callers inspect `status → summary → diff` on demand and can wait across parallel workers in one call via `action="get"` with `run_ids` + `cursor`.
- **Attention-only default + sleep-immune clock** — Both `timeout` and `idle_timeout` default to `null` (no silent auto-kill). A 2-second monotonic/wall sampler excludes host sleep from active budgets and raises 1-shot `attention` signals (`idle_silence`, `repeated_failure`, `no_response`, `sandbox_gui_crash`) waking `wait_for="terminal"`.
- **macOS Seatbelt kernel browser boundary** — Sandboxed macOS workers enforce a `HOST_VISUAL_QA_REQUIRED` contract, shadow `rules/darwin-no-browser.rules`, 1-shot `sandbox_gui_crash` attention, and optional 100% XNU kernel-level `deny process-exec` via a bridge-private patched `codex` binary.

## Evidence & safety guarantees

| Guarantee | Mechanism |
| --- | --- |
| Diff immune to workspace tampering | Standalone snapshot repo + immutable `origin_tree` sealed in out-of-band `evidence.git` |
| Safe parent merge & recovery | Private `git merge-tree --write-tree`, durable `ApplyIntent`, atomic file replace, symlink/gitlink/escape rejection |
| Sensitive content filtered | Pathspec strip + content fingerprint + `risk_flags` on references and aliases |
| Zero-MCP default surface | Shadow `CODEX_HOME` whitelist; repo-injected `.codex/config.toml` MCP servers rejected fail-closed |
| Honest liveness & salvage | Owner-nonce + host `bootId` leases; dead worker with live writer reports `liveness: "unknown"` until safe salvage |
| macOS browser crash immunity | 3-layer boundary: capability contract + shadow rules + XNU Seatbelt `deny process-exec` (`EPERM` before `ChromeMain`) |

## macOS kernel browser hardening (recommended on macOS)

On macOS, launching `/Applications/Google Chrome.app` (even `--headless`) or Playwright browsers inside Codex's Seatbelt sandbox aborts in `HIServices._RegisterApplication()` (`SIGABRT 134`) and floods the desktop with macOS crash dialogs.

`codex-bridge` ships a minimal, auditable patch ([patches/codex-rs-v0.166.0-darwin-deny-exec.patch](./patches/codex-rs-v0.166.0-darwin-deny-exec.patch)) and reproducible builder ([scripts/build-patched-codex.sh](./scripts/build-patched-codex.sh)) that narrows `(allow process-exec)` inside Codex's own Seatbelt profile to deny configured GUI browser bundles and Playwright/Puppeteer caches at the XNU `mac_vnode_check_exec` boundary:

```bash
./scripts/build-patched-codex.sh
```

- Installs a bridge-private binary suite into `~/.codex-bridge/bin/` (`codex`, `codex-exec-server`, `codex-code-mode-host`) — **never overwrites `~/.local/bin/codex`**.
- `resolveCodexBinary()` automatically prefers `~/.codex-bridge/bin/codex` (while `CODEX_BINARY` still overrides explicitly).
- Verify enforcement live via `codex_sessions({ "action": "doctor" })` → `darwin_exec_deny_enforced: true`.
- To revert to stock Codex at any time, delete `~/.codex-bridge/bin/`.

## Tools

| Tool | Purpose & key parameters |
| --- | --- |
| `codex_exec` | Start a run. Params: `task`, `cwd`, `sandbox`, `isolation` (`inplace`\|`worktree`), `base` (ref or `working_tree`), `prepare`, `idempotency_key`, `idle_attention_seconds` (default `900`), `idle_timeout` (default `null`), `timeout` (default `null`), `execution_mode`, `wait_budget_seconds`, `return_view` (`full`\|`summary`), `model`, `effort`, `acceptance`, `non_goals`, `output_schema`, `grants_mcp` |
| `codex_resume` | Continue an existing session by `session_id` (inherits snapshot workspace, `evidence.git`, `effort`, budgets, and shadow `CODEX_HOME`). Params: `session_id`, `task`, `idempotency_key`, `effort`, `idle_attention_seconds`, `idle_timeout`, `timeout`, `acceptance`, `non_goals`, `return_view` |
| `codex_sessions` | Orchestrate and inspect runs. Actions: `list`, `get`, `stop`, `doctor`, `apply`, `cleanup`. `get` params: `run_id` or `run_ids[]`, `cursor`, `view` (`status`\|`summary`\|`diff`\|`output`\|`review`), `wait_seconds`, `wait_for` (`terminal`\|`progress`), `since_seq`, `max_chars`. `apply` params: `run_id`, `dry_run`, `cleanup`, `scope` (`auto`\|`worktree`\|`run`), `allow_partial`, `idempotency_key` |

## Repository structure

```
src/
├── index.ts        MCP server, protocol instructions, progressive views, wait-any, 3-way apply
├── worker.ts       Detached worker: lease → prepare → snapshot → Codex → seal → review packet
├── evidence.ts     Codex binary discovery, snapshot repos, evidence.git, 3-way merge-tree, proxy/deny env
├── grants.ts       Shadow CODEX_HOME (zero-MCP default, darwin rules, cached capability + kernel probe)
├── state.ts        Idempotency, tombstones, owner-nonce leases, ApplyIntent, observer clock, session-rooted GC
├── progress.ts     Durable run state (~/.codex-bridge/), atomic writes, incremental progress events
├── types.ts        Shared types, schemas, and constants
└── statusline.ts   Terminal status bar (CLI mode only)
bin/
└── codex-bridge.mjs  Entrypoint (MCP stdio server + statusline/watch subcommands)
patches/
└── codex-rs-v0.166.0-darwin-deny-exec.patch  Minimal Seatbelt process-exec deny patch for openai/codex
scripts/
└── build-patched-codex.sh  Reproducible builder for ~/.codex-bridge/bin/ private codex suite
test/               91 deterministic unit, bridge, grants, worker, and chaos tests
SKILL.md            Agent operational playbook (compatible with Antigravity / Claude Code / Codex skills)
```

## Setup

**Antigravity** — add to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/codex-bridge/dist/index.js"],
      "env": {
        "CODEX_BRIDGE_MAX_WAIT_SECONDS": "60"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add codex-bridge -- node /absolute/path/to/codex-bridge/dist/index.js
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "codex-bridge": { "command": "node", "args": ["/absolute/path/to/codex-bridge/dist/index.js"] } } }
```

### Environment overrides

| Variable | Purpose |
| --- | --- |
| `CODEX_BINARY` | Explicit path to `codex` CLI (auto-discovered from `~/.codex-bridge/bin/codex`, `Codex.app`, `~/.local/bin`, standalone, Homebrew, and `PATH` by default) |
| `CODEX_BRIDGE_HOME` | Override durable state root (default `~/.codex-bridge`) |
| `CODEX_BRIDGE_MAX_WAIT_SECONDS` | Clamp max long-poll / sync wait seconds (`10..600`, default `240`) for clients with tighter MCP timeouts |
| `CODEX_BRIDGE_DEFAULT_IDLE_TIMEOUT` | Override default activity-based `idle_timeout` in seconds (`0` disables, `10..7200`, default `null`) |
| `CODEX_BRIDGE_DEFAULT_IDLE_ATTENTION` | Override default observed-silence `idle_attention_seconds` (`0` disables, `10..7200`, default `900`) |
| `CODEX_BRIDGE_DENY_EXEC_SUBPATHS` | macOS only: override colon-delimited browser bundle/cache subpaths denied at XNU Seatbelt `process-exec` level |
| `CODEX_BRIDGE_EXTRA_DENY_EXEC_SUBPATHS` | macOS only: append additional colon-delimited absolute subpaths to the default browser deny-exec list |

## Boundaries

- **Protected:** Git diff, patch files, 3-way apply targets, and review previews — sensitive paths, aliases, symlinks, and gitlinks are stripped or rejected.
- **Not protected:** Raw Codex stdout/stderr. Never ask Codex to print secrets.
- **Cooperative:** `inplace` mode serializes writes per repo via lease; `worktree` mode isolates workers completely and checks parent conflicts atomically during `apply`.

## Requirements

Node.js ≥ 18 · Git ≥ 2.38 (for `git merge-tree --write-tree`) · [Codex CLI](https://github.com/openai/codex)

## License

MIT
