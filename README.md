# codex-bridge

**English** · [中文文档](./README.zh-CN.md)

Not a Codex wrapper. Not a chat bridge. Not a review-only plugin. Not a multi-agent terminal.

codex-bridge is an **evidence layer**: Codex executes, your MCP agent (Antigravity, Claude Code, Cursor, etc.) plans and reviews, and the handoff is grounded in run-scoped filesystem diff.

```
MCP Client (Antigravity / Claude Code / ...) ──[MCP]──▶ codex-bridge ──▶ Codex CLI
                                                             │
                                                       run-scoped git diff
                                                       worktree isolation
                                                       zero-MCP shadow home
                                                       progressive retrieval
```

## Quick start

Canonical distribution is GitHub (npm registry is stale at 2.2.7):

```bash
npm install -g github:mrfacecheck/codex-bridge
```

Or clone and build locally:

```bash
git clone https://github.com/mrfacecheck/codex-bridge.git
cd codex-bridge && npm install && npm run build
```

Verify from your MCP client: run `codex_sessions` with `{"action": "doctor"}`.

## Architecture

```
codex_exec / codex_resume
  → detached worker (survives MCP disconnect)
    → git snapshot (before)
    → spawn Codex CLI
    → git snapshot (after)
    → review packet (run-scoped diff + sensitive filtering)

codex_sessions get
  → view=status: lightweight poll (fs.watch long-poll)
  → view=summary: file stats + warnings + output tail
  → view=diff / output / review: on-demand detail
```

Core decisions:
- **Worker is detached** — MCP server crash or session disconnect doesn't kill Codex.
- **Isolated snapshot repos + out-of-band Git tree evidence (v3)** — Each isolated workspace freezes an immutable `origin_tree` into a private `evidence.git` object store; even if Codex commits or edits `.gitignore` inside the workspace, every changed byte stays captured.
- **Private 3-way merge-tree & recoverable apply (v3)** — `codex_sessions(action="apply", run_id=..., dry_run?, cleanup?)` merges via `git merge-tree --write-tree` with watermark tracking across multi-turn `codex_resume` sessions and atomic intent recovery, preserving parent staged/unstaged edits.
- **Views are progressive** — Caller never loads full packet by default. `status → summary → diff` on demand.
- **Wait-any & sleep-immune attention (v3)** — `codex_sessions(action="get", run_ids=[...], wait_seconds=...)` multiplexes multiple runs in one shared call. Both `timeout` and `idle_timeout` default to `null` (no silent auto-kill); sleep-immune `idle_attention_seconds` (default `900s`), `repeated_failure`, and `sandbox_gui_crash` raise 1-shot `attention` signals waking `wait_for="terminal"`.
- **macOS Seatbelt kernel browser boundary (v3.1)** — Sandboxed macOS workers cannot safely launch GUI `.app` browsers (`HIServices._RegisterApplication` aborts with `SIGABRT 134` and floods the desktop with crash dialogs). The bridge enforces a `HOST_VISUAL_QA_REQUIRED` contract, shadow `rules/darwin-no-browser.rules`, 1-shot `sandbox_gui_crash` attention, and optional 100% kernel-level `deny process-exec` via a bridge-private patched `codex` binary (`scripts/build-patched-codex.sh` + `patches/codex-rs-v0.166.0-darwin-deny-exec.patch`, installed to `~/.codex-bridge/bin/codex` without touching `~/.local/bin/codex`, verified live by `doctor`'s `darwin_exec_deny_enforced`).

## Evidence guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| Diff scoped to this run | Isolated git tree snapshots, pre-existing dirty excluded |
| Sensitive content filtered | Pathspec strip + content fingerprint + risk_flags for references |
| Resume verified | Thread ID mismatch → entire run marked failed |
| Timeout state explicit | `idle_timeout` vs `wall_timeout` hints; `partial_changes: true` when files modified before termination |
| Cross-process safe | File lock with run-scoped PID verification; active worktree cleanup guard |

## Tools

| Tool | Purpose |
|------|---------|
| `codex_exec` | Start task. Params: `task`, `cwd`, `sandbox`, `idle_timeout` (default 900s, 0 disables), `timeout` (opt-in wall cap), `execution_mode`, `wait_budget_seconds`, `return_view` (`full`\|`summary`), `isolation` (`inplace`\|`worktree`), `base`, `model`, `effort`, `acceptance`, `non_goals`, `output_schema`, `grants_mcp` |
| `codex_resume` | Continue session (preserves worktree, `effort`, `idle_timeout`, & shadow home). Params: `session_id`, `task`, `effort`, `idle_timeout`, `timeout`, `acceptance`, `non_goals`, `return_view` |
| `codex_sessions` | Manage runs. Actions: `list`, `get`, `stop`, `doctor`, `apply`, `cleanup`. Get params: `view`, `wait_seconds`, `wait_for` (`terminal`\|`progress`), `since_seq`, `max_chars`. Apply params: `dry_run`, `cleanup`, `scope` (`auto`\|`worktree`\|`run`), `allow_partial` |

## Source

```
src/
├── index.ts        MCP server, instructions, view system, smart long-poll, worktree apply
├── worker.ts       Detached worker: lock → snapshot → Codex (idle watchdog) → snapshot → review
├── evidence.ts     Codex binary discovery, git ops, diff/patch export, sensitive detection, proxy env
├── grants.ts       Shadow CODEX_HOME (zero-MCP default + safe model/provider defaults)
├── progress.ts     Durable state (~/.codex-bridge/ or CODEX_BRIDGE_HOME), incremental events
├── types.ts        Shared types and constants
└── statusline.ts   Terminal status bar (CLI mode only)
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
|----------|---------|
| `CODEX_BINARY` | Explicit path to `codex` CLI (auto-discovered from `~/.codex-bridge/bin/codex`, `Codex.app`, `~/.local/bin`, standalone, Homebrew, and `PATH` by default) |
| `CODEX_BRIDGE_HOME` | Override durable state root (default `~/.codex-bridge`) |
| `CODEX_BRIDGE_MAX_WAIT_SECONDS` | Clamp max long-poll / sync wait seconds (`10..600`, default `240`) for clients with tighter MCP timeouts |
| `CODEX_BRIDGE_DEFAULT_IDLE_TIMEOUT` | Override default activity-based `idle_timeout` in seconds (`0` disables, `10..7200`, default `null`) |
| `CODEX_BRIDGE_DENY_EXEC_SUBPATHS` | macOS only: override colon-delimited browser bundle/cache subpaths denied at XNU Seatbelt `process-exec` level by the bridge-private patched `codex` binary |
| `CODEX_BRIDGE_EXTRA_DENY_EXEC_SUBPATHS` | macOS only: append additional colon-delimited absolute subpaths to the default browser deny-exec list |

## Boundaries

**Protected:** Git diff, patch files, review previews — sensitive paths/content stripped.

**Not protected:** Codex raw stdout/stderr. Don't ask Codex to print secrets.

**Cooperative:** Diff assumes exclusive workspace during a run. Bridge prevents concurrent write sessions but not external editors.

## Requirements

Node.js ≥ 18 · Git ≥ 2.30 · [Codex CLI](https://github.com/openai/codex)

## License

MIT
