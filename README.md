# codex-bridge

**English** · [中文文档](./README.zh-CN.md)

Evidence layer for Claude + Codex collaboration.

Claude plans and reviews. Codex writes code. codex-bridge captures what the filesystem actually changed — independent of what Codex reports.

```
Claude Code ──[MCP]──▶ codex-bridge ──▶ Codex CLI
                            │
                      run-scoped git diff
                      sensitive file filtering
                      async task recovery
```

## The problem

Claude + Codex is a powerful workflow, but five things break in practice:

| Problem | What happens |
|---------|-------------|
| **No independent verification** | Codex reports "fixed auth, updated tests." Claude has no mechanism to verify this against actual file changes. |
| **Long tasks drop** | Codex runs 10+ minutes. Claude Code session disconnects. Changes exist on disk but are unreachable. |
| **Sensitive files leak** | Codex copies `.env` content into `config/defaults.txt`. Without content-aware filtering, this surfaces in the review. |
| **Resume breaks silently** | Claude requests a session resume. Codex starts a new session instead. The context switch goes undetected. |
| **Blind execution** | Codex runs for minutes with no progress signal. Claude and the user wait without visibility. |

codex-bridge addresses each of these.

## Quick start

```bash
npm install -g @codex-bridge/core
claude mcp add codex-bridge -- npx codex-bridge
```

Verify: ask Claude to `run codex_sessions doctor`.

Then: `"Use codex to implement user authentication in ~/my-project"`

## How it works

Every `codex_exec` returns a **review packet** — structured evidence of what changed:

```json
{
  "status": "completed",
  "git_diff": {
    "summary": "3 files changed, 42(+), 5(-)",
    "files": [{"status": "M", "path": "src/auth.ts"}],
    "diff_preview": "...",
    "sensitive_diff_omitted": [".env -> config.txt (matches_sensitive_content)"]
  },
  "partial_changes": false,
  "warnings": []
}
```

### Evidence guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| **Diff scoped to this run** | Git tree snapshots before and after, in an isolated object directory. Pre-existing dirty files are excluded. |
| **Sensitive content filtered** | `.env` / `.pem` / `.key` stripped via pathspec. Content fingerprinting detects copies under any filename. Code referencing sensitive paths flagged in `risk_flags`. |
| **Resume verified** | Thread ID checked on every resume. Mismatch marks the entire run as failed. |
| **Timeout state preserved** | `partial_changes: true` when Codex timed out after modifying files. State is always explicit. |
| **Long tasks survive disconnects** | Detached worker process continues independently. Results recoverable via `run_id` after reconnect. |
| **Cross-process safe** | File lock with run-scoped PID verification. Multiple Claude instances operate without conflict. |

### Long-running tasks

Tasks under 3 minutes return the full review packet inline. Longer tasks switch automatically:

```
codex_exec → detached worker → wait up to 180s
  ├─ done in time  → full review packet (same as short tasks)
  └─ still running → run_id handle (poll with codex_sessions get)
```

The worker runs independently of the MCP server. Results persist to disk regardless of session state.

### Network detection

Three-layer system for environments with unstable connectivity:

| Layer | When | Signal |
|-------|------|--------|
| **Real-time** | 30s with zero JSONL events from Codex | Progress: "No JSONL events from Codex after 30s" |
| **Post-failure** | Codex exits with connection errors | Review packet: `failure_hint: "network"` |
| **On-demand** | `codex_sessions doctor` | `network.reachable` via TCP probe to api.openai.com |

### Status line

```bash
codex-bridge install-statusline
```

Live progress in Claude Code's status bar:

```
Codex 8f1c running 06:21  Running: npm test
Codex 8f1c done 11:03  3 files changed, 42(+) 5(-)
```

## Tools

| Tool | Purpose | Key params |
|------|---------|------------|
| `codex_exec` | Start a task | `task`, `cwd`, `sandbox`, `timeout`, `execution_mode` |
| `codex_resume` | Continue a session | `session_id`, `task` |
| `codex_sessions` | Manage runs | `list` · `get` · `stop` · `doctor` |

## Workflows

**Basic loop** — Claude plans → Codex executes → Claude reviews diff → Codex fixes → done.

**Plan critique** — Codex reviews Claude's plan in `read-only` mode before any files are touched.

**Parallel review** — Multiple read-only sessions (architecture, security, performance) → Claude synthesizes → one write session executes.

## Architecture

```
src/
├── types.ts        Shared types, constants, terminal status model
├── evidence.ts     Git snapshots, diff, sentinel, alias, lock, process helpers
├── progress.ts     Durable state: ~/.codex-bridge/runs/, sessions/, projects/
├── worker.ts       Detached worker: lock → snapshot → Codex → snapshot → review
├── index.ts        MCP server: tool handlers, session hydrate, network probe
└── statusline.ts   Status line command + install
```

Design document: [V2-DESIGN.md](./V2-DESIGN.md)

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

**Protected:** Git diff, patch files, review previews. Sensitive paths and content aliases are stripped from all evidence output.

**Not protected:** Codex's raw text output (stdout, stderr, final message). These contain unfiltered execution output. Avoid requesting Codex to display credentials or secrets.

**Cooperative assumption:** The diff assumes exclusive workspace access during a run. codex-bridge prevents concurrent bridge write sessions on the same repo, but does not block external processes.

## Troubleshooting

| Symptom | Resolution |
|---------|------------|
| "Another codex-bridge process is writing" | `codex_sessions list` → find active run → `codex_sessions stop` with `run_id` |
| `~/.codex-bridge` growing large | Auto-cleans runs older than 7 days. Manual: `rm -rf ~/.codex-bridge/runs/*` |
| Long task completed, Claude missed it | Poll with `codex_sessions get --run_id <id>` |
| Resume returns "Unknown session" | MCP server restarted. Pass `cwd` explicitly in `codex_resume` |
| Codex fails immediately | Run `codex_sessions doctor` — check `network.reachable` and Codex CLI version |

## Requirements

Node.js ≥ 18 · Git ≥ 2.30 · [Codex CLI](https://github.com/openai/codex)

## License

MIT
