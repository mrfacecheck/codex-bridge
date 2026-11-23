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
- **Diff is run-scoped** — Isolated git object directory. Pre-existing dirty files excluded.
- **Views are progressive** — Claude never loads full packet by default. `status → summary → diff` on demand.
- **Long-poll is event-driven** — `fs.watch` + fallback timer. Returns immediately on progress change.
- **Timeout is dynamic** — read-only=300s, write=900s, async=1200s. No 300s one-size-fits-all.
- **Stall detection is semantic** — `lastActivityAt` tracks real Codex events, not bridge housekeeping writes. `suggested_action` guides Claude's next step.

## Evidence guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| Diff scoped to this run | Isolated git tree snapshots, pre-existing dirty excluded |
| Sensitive content filtered | Pathspec strip + content fingerprint + risk_flags for references |
| Resume verified | Thread ID mismatch → entire run marked failed |
| Timeout state explicit | `partial_changes: true` when files modified before timeout |
| Cross-process safe | File lock with run-scoped PID verification |

## Tools

| Tool | Purpose |
|------|---------|
| `codex_exec` | Start task. Params: `task`, `cwd`, `sandbox`, `timeout`, `execution_mode`, `wait_budget_seconds`, `return_view` (`full`\|`summary`), `isolation` (`inplace`\|`worktree`), `base`, `model`, `effort`, `acceptance`, `non_goals`, `output_schema`, `grants_mcp` |
| `codex_resume` | Continue session (preserves worktree & shadow home). Params: `session_id`, `task`, `effort`, `acceptance`, `non_goals`, `return_view` |
| `codex_sessions` | Manage runs. Actions: `list`, `get`, `stop`, `doctor`, `cleanup`. Get params: `view`, `wait_seconds`, `since_seq`, `max_chars` |

## Source

```
src/
├── index.ts        MCP server, instructions, view system, long-poll, dynamic timeout
├── worker.ts       Detached worker: lock → snapshot → Codex → snapshot → review
├── evidence.ts     Codex binary discovery, git ops, diff, sensitive detection, proxy env
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
| `CODEX_BINARY` | Explicit path to `codex` CLI (auto-discovered from `Codex.app`, `~/.local/bin`, standalone, Homebrew, and `PATH` by default) |
| `CODEX_BRIDGE_HOME` | Override durable state root (default `~/.codex-bridge`) |
| `CODEX_BRIDGE_MAX_WAIT_SECONDS` | Clamp max long-poll / sync wait seconds (`10..240`, default `240`) for clients with tighter MCP timeouts |

## Boundaries

**Protected:** Git diff, patch files, review previews — sensitive paths/content stripped.

**Not protected:** Codex raw stdout/stderr. Don't ask Codex to print secrets.

**Cooperative:** Diff assumes exclusive workspace during a run. Bridge prevents concurrent write sessions but not external editors.

## Requirements

Node.js ≥ 18 · Git ≥ 2.30 · [Codex CLI](https://github.com/openai/codex)

## License

MIT
