# codex-bridge

[English](./README.md) · **中文文档**

不是 Codex 包装器。不是聊天桥接。不是只读审查插件。不是多 agent 终端。

codex-bridge 是一个**证据层**：Codex 执行，Claude 审查，交接基于 run-scoped 文件系统 diff。

```
Claude Code ──[MCP]──▶ codex-bridge ──▶ Codex CLI
                            │
                      run-scoped git diff
                      敏感文件过滤
                      渐进取证
```

## 快速开始

```bash
npm install -g @codex-bridge/core
claude mcp add codex-bridge -- npx codex-bridge
```

验证：让 Claude 执行 `codex_sessions doctor`。

## 架构

```
codex_exec / codex_resume
  → 独立 worker 进程（MCP 断连不影响）
    → git 快照（执行前）
    → 启动 Codex CLI
    → git 快照（执行后）
    → 生成 review packet（run-scoped diff + 敏感文件过滤）

codex_sessions get
  → view=status: 轻量轮询（fs.watch 事件驱动）
  → view=summary: 文件统计 + 警告 + 输出尾部
  → view=diff / output / review: 按需加载细节
```

核心设计：
- **Worker 独立进程** — MCP 崩溃或 session 断连不会杀死 Codex。
- **Diff 限定本次运行** — 隔离的 git object 目录，排除已有的 dirty 文件。
- **视图渐进加载** — Claude 默认不加载完整 packet。`status → summary → diff` 按需获取。
- **Long-poll 事件驱动** — `fs.watch` + 兜底定时器，有进展立即返回。
- **超时动态推算** — read-only=300s, write=900s, async=1200s。
- **卡死检测语义化** — `lastActivityAt` 追踪真实 Codex 事件，`suggested_action` 指导 Claude 下一步。

## 证据保证

| 保证 | 机制 |
|------|------|
| Diff 限定本次运行 | 隔离 git tree 快照，排除已有 dirty 文件 |
| 敏感内容过滤 | pathspec 剥离 + 内容指纹 + risk_flags 标记引用 |
| Resume 校验 | Thread ID 不匹配 → 整次运行标记失败 |
| 超时状态显式 | `partial_changes: true` 表示超时前已修改文件 |
| 跨进程安全 | 文件锁 + run-scoped PID 校验 |

## 工具

| 工具 | 用途 |
|------|------|
| `codex_exec` | 启动任务。参数：`task`, `cwd`, `sandbox`, `timeout`, `execution_mode`, `wait_budget_seconds` |
| `codex_resume` | 继续会话。参数：`session_id`, `task` |
| `codex_sessions` | 管理运行。动作：`list`, `get`, `stop`, `doctor`。get 参数：`view`, `wait_seconds`, `since_seq`, `max_chars` |

## 源码结构

```
src/
├── index.ts        MCP server、view 系统、long-poll、动态超时
├── worker.ts       独立 worker：加锁 → 快照 → Codex → 快照 → review
├── evidence.ts     Git 操作、diff、敏感检测、代理环境、进程管理
├── progress.ts     持久化状态（~/.codex-bridge/）、增量事件
├── types.ts        共享类型和常量
└── statusline.ts   终端状态栏（仅 CLI 模式）
```

## 安装

**Claude Code：**
```bash
claude mcp add codex-bridge -- npx codex-bridge
```

**Claude Desktop** — 加入 `claude_desktop_config.json`：
```json
{ "mcpServers": { "codex-bridge": { "command": "npx", "args": ["codex-bridge"] } } }
```

## 边界

**受保护：** Git diff、patch 文件、review 预览 — 敏感路径/内容已剥离。

**不受保护：** Codex 原始 stdout/stderr。不要让 Codex 打印密钥。

**协作假设：** Diff 假设运行期间独占工作区。Bridge 阻止并发写 session，但不阻止外部编辑器。

## 环境要求

Node.js ≥ 18 · Git ≥ 2.30 · [Codex CLI](https://github.com/openai/codex)

## 许可证

MIT
