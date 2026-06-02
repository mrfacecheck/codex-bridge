# codex-bridge

**English** · [中文文档](./README.zh-CN.md)

Not a Codex wrapper. Not a chat bridge. Not a review-only plugin. Not a multi-agent terminal.

codex-bridge is an **evidence layer**: Codex executes, Claude reviews, and the handoff is grounded in run-scoped filesystem diff.

```
Claude Code ──[MCP]──▶ codex-bridge ──▶ Codex CLI
                            │
                      run-scoped git diff
                      sensitive file filtering
                      progressive retrieval
```

## Quick start

```bash
npm install -g @codex-bridge/core
claude mcp add codex-bridge -- npx codex-bridge
```

Verify: ask Claude to `run codex_sessions doctor`.

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
| `codex_exec` | Start task. Params: `task`, `cwd`, `sandbox`, `timeout`, `execution_mode`, `wait_budget_seconds` |
| `codex_resume` | Continue session. Params: `session_id`, `task` |
| `codex_sessions` | Manage runs. Actions: `list`, `get`, `stop`, `doctor`. Get params: `view`, `wait_seconds`, `since_seq`, `max_chars` |

## Source

```
src/
├── index.ts        MCP server, view system, long-poll, dynamic timeout
├── worker.ts       Detached worker: lock → snapshot → Codex → snapshot → review
├── evidence.ts     Git ops, diff, sensitive detection, proxy env, process mgmt
├── progress.ts     Durable state (~/.codex-bridge/), incremental events
├── types.ts        Shared types and constants
└── statusline.ts   Terminal status bar (CLI mode only)
```

## Setup

**Claude Code:**
```bash
claude mcp add codex-bridge -- npx codex-bridge
```

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{ "mcpServers": { "codex-bridge": { "command": "npx", "args": ["codex-bridge"] } } }
```

## Boundaries

**Protected:** Git diff, patch files, review previews — sensitive paths/content stripped.

**Not protected:** Codex raw stdout/stderr. Don't ask Codex to print secrets.

**Cooperative:** Diff assumes exclusive workspace during a run. Bridge prevents concurrent write sessions but not external editors.

## Requirements

Node.js ≥ 18 · Git ≥ 2.30 · [Codex CLI](https://github.com/openai/codex)

## License

MIT
