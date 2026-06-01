# codex-bridge v2.0 架构设计

## 核心变更

从同步阻塞模式升级为 **bounded sync + async worker** 模式。

### v1（当前）
```
codex_exec → await Codex (可能 20 分钟) → 返回 review packet
问题：Claude Code session 超时断连
```

### v2（目标）
```
codex_exec → spawn detached worker → 等最多 180s
  → 如果 180s 内完成：返回完整 review packet（和 v1 体验一样）
  → 如果没完成：返回 running packet + run_id（Claude 轮询）
```

## 文件结构

```
codex-bridge/
├── bin/codex-bridge.mjs          ← npx 入口（已有）
├── src/
│   ├── index.ts                  ← MCP server（重构：拆出 worker 逻辑）
│   ├── worker.ts                 ← 独立 worker 进程（新增）
│   ├── evidence.ts               ← Git snapshot / diff / sentinel / alias（从 index.ts 抽出）
│   ├── progress.ts               ← 进度管理 + durable state（新增）
│   ├── statusline.ts             ← status line 命令（新增）
│   └── types.ts                  ← 共享类型（新增）
├── package.json
├── tsconfig.json
├── README.md / README.zh-CN.md
├── LICENSE
└── .gitignore
```

## Durable Run State

```
~/.codex-bridge/
├── runs/
│   └── <run_id>/
│       ├── run.json              ← run 元数据（cwd, sandbox, task, pids, status）
│       ├── progress.json         ← 最新进度（status line 读这个）
│       ├── progress.jsonl        ← 进度历史
│       ├── codex.stdout.jsonl    ← Codex 原始 JSONL 事件流
│       ├── codex.stderr.log     
│       ├── final-message.md      ← -o 输出
│       ├── review.json           ← 完成后的 review packet
│       ├── changes.patch         ← diff patch 文件
│       └── sensitive-omitted.txt ← 被排除的敏感文件列表（如有）
├── projects/
│   └── <project_hash>.json       ← 项目最近 run 指针（status line 用）
└── sessions/
    └── <session_hash>.json       ← session → run 映射（async resume 用）
```

## codex_exec 新参数

```typescript
// 新增
execution_mode?: "auto" | "sync" | "async"  // default: "auto"
wait_budget_seconds?: number                 // default: 180, max: 240

// auto: 启动 worker，等 wait_budget。完成则返回 packet，没完成返回 running handle
// sync: 保持旧行为，硬上限 240s
// async: 立即返回 running handle
```

## 返回结构

### 同步完成（和 v1 一样）
```json
{
  "run_id": "8f1c...",
  "async": false,
  "status": "completed",
  "git_diff": { ... },
  "fs_sentinel": { ... },
  ...全部 v1 字段
}
```

### 异步进行中
```json
{
  "run_id": "8f1c...",
  "async": true,
  "status": "running",
  "session_id": "019e79f1...",
  "cwd": "/repo",
  "git_root": "/repo",
  "progress": {
    "phase": "running",
    "message": "Running: npm test",
    "updated_at": "2026-05-30T23:40:12Z",
    "seq": 42
  },
  "poll_with": "codex_sessions get --run_id 8f1c..."
}
```

## Worker 生命周期

```
MCP handler (index.ts)                    Worker (worker.ts)
│                                          │
├─ create runDir                           │
├─ write run.json                          │
├─ spawn worker (detached, unref)          │
│                                          ├─ read run.json
├─ wait: poll progress.json ───────────────├─ acquire write lock
│   (最多 wait_budget 秒)                  ├─ before tree snapshot → /tmp (isolated object dir)
│                                          ├─ fs sentinel before
│   如果 review.json 出现 → 读取返回       ├─ spawn Codex → stdout→file, stderr→file
│   如果超时 → 读 progress.json 返回       ├─ tail JSONL → update progress.json
│                                          ├─ Codex 完成
│                                          ├─ after tree snapshot → /tmp (isolated object dir)
│                                          ├─ fs sentinel after
│                                          ├─ build review packet → review.json
│                                          ├─ release write lock
│                                          └─ exit
```

### 关键：Worker 不依赖 MCP server 存活

- Worker 是 detached 进程，MCP server 死了它继续跑
- Codex stdout 写到文件（不是 pipe 给 parent），pipe 断不影响
- 写锁由 worker 持有，记录 worker PID + Codex child PID
- review.json 由 worker 生成，MCP server 只负责读取

## codex_sessions 升级

```typescript
action: "list" | "get" | "stop" | "doctor"
session_id?: string
run_id?: string      // 新增：支持 run_id 查询
```

### get by run_id（运行中）
```json
{
  "run_id": "8f1c",
  "status": "running",
  "async": true,
  "progress": {
    "phase": "testing",
    "message": "Running: npm test",
    "seq": 42
  },
  "review_ready": false
}
```

### get by run_id（已完成）
```json
{
  "run_id": "8f1c",
  "status": "completed",
  "review_ready": true,
  "review_packet": { ...完整 v1 格式 }
}
```

## Status Line

### 安装
```bash
codex-bridge install-statusline
```

写入 `~/.claude/settings.json`：
```json
{
  "statusLine": {
    "type": "command",
    "command": "codex-bridge statusline",
    "refreshInterval": 2
  }
}
```

### 输出
```
Codex 8f1c running 06:21  Running: npm test
Codex 8f1c done 11:03  3 files changed, 42(+) 5(-)
Codex idle
```

### 逻辑
1. 从 stdin 读 Claude Code session JSON（包含 workspace 信息）
2. 用 cwd 找 gitRoot → hash → `~/.codex-bridge/projects/<hash>.json`
3. 找到最近 active run → 读 `progress.json`
4. 输出一行

## Project Brief 自动注入

codex_exec 启动时，bridge 快速读取项目元信息，拼到 task 前面：

```
Project context:
- Git root: /repo
- Package manager: pnpm (from pnpm-lock.yaml)
- Main dirs: src/, app/, tests/
- Tech: TypeScript (from tsconfig.json)
- Avoid: full filesystem scans, node_modules inspection
---
[用户的 task]
```

减少 Codex 的环境探查时间。可通过 `project_brief: false` 关闭。

## CLAUDE.md 更新

```markdown
### 长任务处理

codex_exec 可能返回 async: true + status: "running"。
这时 Codex 在后台执行，不会因为 Claude Code session 超时而丢失。

Claude 的行为：
1. 告诉用户 Codex 在后台运行
2. 每 15-20 秒用 codex_sessions get + run_id 轮询
3. review_ready=true 时审查 review packet
4. 不要在同一个仓库同时启动第二个 write session
```

## 实现顺序

### Phase 1：async worker + durable state
1. 抽出 evidence.ts（git snapshot/diff/sentinel/alias 逻辑）
2. 抽出 types.ts（共享类型）
3. 实现 worker.ts（独立进程，完整 evidence 流程）
4. 实现 progress.ts（durable state 读写）
5. 重构 index.ts 的 codex_exec：spawn worker + wait budget
6. 升级 codex_sessions：支持 run_id 查询

### Phase 2：status line
7. 实现 statusline.ts
8. bin/codex-bridge.mjs 增加子命令路由（mcp-server / statusline / install-statusline / watch）

### Phase 3：polish
9. project brief 自动注入
10. CLAUDE.md 更新
11. README 更新
12. 压测

## 保留的 v1 能力

以下全部保留，不重写：
- Git tree snapshot (isolated object dir)
- Sensitive 五层保护
- Resume thread_id 校验
- Resume cwd/sandbox 覆盖拒绝
- Cross-process write lock (childPid)
- JSONL parsing + health check
- Smart diff preview
- Progress 脱敏
- Env 白名单
- Untracked guard
- RunDir TTL cleanup
- Doctor

这些只是从 index.ts 抽到 evidence.ts/types.ts，逻辑不变。
