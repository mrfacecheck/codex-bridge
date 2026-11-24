# codex-bridge Maintainer & Agent Guide

`codex-bridge` v3.1 is a run-scoped MCP execution and evidence kernel bridging MCP coding agents (Antigravity, Claude Code, Cursor) and OpenAI Codex CLI.

## Core Invariants (Never Regress)

1. **Out-of-band Git evidence**: Isolated runs (`isolation: "worktree"`) execute inside a standalone snapshot repository with an immutable `origin_tree` sealed into private `evidence.git`. Agent `git commit`, `git reset`, or `.gitignore` edits must never hide diff evidence.
2. **Safe 3-way apply**: `codex_sessions(action="apply")` computes merges inside `evidence.git` via `git merge-tree --write-tree`, persists a `PREPARED → COMMITTED` `ApplyIntent`, preserves parent `.git/index`, tracks multi-turn watermarks, and rejects symlinks, gitlinks, escapes, and sensitive paths before touching parent files.
3. **Attention-only default + honest liveness**: `timeout` and `idle_timeout` default to `null` (never silently auto-kill healthy turns). Observed active silence uses a sleep-immune clock (`idle_attention_seconds: 900`). Owner-nonce leases are never stolen by heartbeat timeout; uncertain writers report `liveness: "unknown"` until safe salvage.
4. **Zero-MCP default surface**: Workers run inside a shadow `CODEX_HOME` exposing only explicitly granted MCP servers; repo-level `.codex/config.toml` MCP injections fail closed.
5. **macOS Seatbelt browser boundary**: Never ask sandboxed macOS workers to run GUI `.app` browsers or Playwright/Puppeteer screenshots. `codex-bridge` layers:
   - **P0**: `HOST_VISUAL_QA_REQUIRED` contract injected into macOS sandboxed tasks.
   - **P1**: Bridge-private patched `codex` suite (`~/.codex-bridge/bin/`, built via `scripts/build-patched-codex.sh` + `patches/codex-rs-v0.166.0-darwin-deny-exec.patch`) enforcing XNU Seatbelt `deny process-exec` via `CODEX_BRIDGE_DENY_EXEC_SUBPATHS` and verified live by `doctor.darwin_exec_deny_enforced`.
   - **P2**: Shadow `rules/darwin-no-browser.rules` + 1-shot `sandbox_gui_crash` attention in `src/worker.ts`.

## Repository Layout

```
src/
├── index.ts        MCP server, protocol instructions, progressive views, wait-any, 3-way apply
├── worker.ts       Detached worker: lease → prepare → snapshot → Codex → seal → review packet
├── evidence.ts     Codex discovery, snapshot repos, evidence.git, 3-way merge-tree, proxy/deny env
├── grants.ts       Shadow CODEX_HOME, darwin rules, cached capability & kernel exec-deny probe
├── state.ts        Idempotency/tombstones, owner-nonce leases, ApplyIntent, observer clock, GC
├── progress.ts     Durable run state, atomic writes, incremental progress events
├── types.ts        Shared types and constants
└── statusline.ts   CLI terminal statusline
bin/
└── codex-bridge.mjs  Entrypoint (prefers compiled dist/, falls back to tsx for dev)
patches/
└── codex-rs-v0.166.0-darwin-deny-exec.patch  Minimal Seatbelt process-exec deny patch
scripts/
└── build-patched-codex.sh  Reproducible builder for ~/.codex-bridge/bin/ private codex suite
test/               91 deterministic unit, bridge, grants, worker, and chaos tests
SKILL.md            Operational agent playbook
```

## Development Commands

```bash
pnpm build                       # Compile TypeScript to dist/
pnpm test                        # Run full 91-test suite (offline deterministic + chaos)
pnpm exec tsc --noEmit           # Type-check without emitting
./scripts/build-patched-codex.sh # macOS: build/update bridge-private kernel-patched codex
```

## Release & Commit Hygiene

- Use Conventional Commits (`feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`).
- Never commit personal hostnames, SSH keys, local paths, or test scratch files (e.g. `OUT.txt`).
- Keep `SKILL.md`, `README.md`, `README.zh-CN.md`, `CHANGELOG.md`, and `SERVER_INSTRUCTIONS` in `src/index.ts` aligned whenever behavior or defaults change.
- Tag milestone releases (`v3.1.0`, etc.) after `pnpm build && pnpm test` pass cleanly.
