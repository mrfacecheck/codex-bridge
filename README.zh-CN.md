# codex-bridge

[English](./README.md) · **中文文档**

不是 Codex 包装器。不是聊天桥接。不是只读审查插件。不是多 agent 终端。

codex-bridge 是一个**证据层**：Codex 执行，上层 MCP 智能体（Antigravity、Claude Code、Cursor 等）规划与审查，交接基于 run-scoped 文件系统 diff。

```
MCP 客户端 (Antigravity / Claude Code / ...) ──[MCP]──▶ codex-bridge ──▶ Codex CLI
                                                              │
                                                        run-scoped git diff
                                                        worktree 隔离
                                                        零 MCP 影子主目录
                                                        渐进取证
```

## 快速开始

推荐直接从 GitHub 安装或本地构建（npm registry 仍停在 2.2.7）：

```bash
npm install -g github:mrfacecheck/codex-bridge
# 或本地构建：
git clone https://github.com/mrfacecheck/codex-bridge.git
cd codex-bridge && npm install && npm run build
```

验证：在客户端中调用 `codex_sessions`，参数 `{"action": "doctor"}`。

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
- **Diff 限定本次运行** — 隔离的 git object 目录，排除已有的 dirty 文件，支持 `--binary` 完整补丁。
- **视图渐进加载** — 调用方默认不加载完整 packet。`status → summary → diff` 按需获取。
- **智能事件驱动长轮询** — `fs.watch` + 兜底定时器；`wait_for="terminal"`（默认）通用于所有视图（`summary`/`status`/`diff`/`output`/`review`），仅在终态、卡死或等待窗口结束时唤醒，告别逐条事件空转。
- **基于活性的 `idle_timeout`（默认无墙钟硬超时）** — 取消 300s/900s/1200s 墙钟误杀（`timeout` 默认 `null`，仅按需显式开启），改由真实 Codex JSONL stdout 驱动的 `idle_timeout` 看门狗（默认 `900s`）清理真正卡死的任务。
- **干净的活性信号与真实越界归因** — 后台 CLI `stderr` 噪声只进日志不污染进度或重置活性；`workspace-write` 下主工作区并行编辑记入 `concurrent_parent_changes`，不再误报 `WORKTREE ESCAPE`。
- **一键 worktree 成果落盘** — `codex_sessions(action="apply", run_id=..., dry_run?, cleanup?)` 通过 `git apply --check` + 写锁原子落盘（多轮 `codex_resume` 自动合并完整 worktree diff）并支持落盘后自动回收。

## 证据保证

| 保证 | 机制 |
|------|------|
| Diff 限定本次运行 | 隔离 git tree 快照，排除已有 dirty 文件 |
| 敏感内容过滤 | pathspec 剥离 + 内容指纹 + risk_flags 标记引用 |
| Resume 校验 | Thread ID 不匹配 → 整次运行标记失败 |
| 超时状态显式 | 区分 `idle_timeout` 与 `wall_timeout`；终止前有改动标记 `partial_changes: true` |
| 跨进程安全 | 文件锁 + run-scoped PID 校验 + 活跃 worktree 防误删保护 |

## 工具

| 工具 | 用途 |
|------|------|
| `codex_exec` | 启动任务。参数：`task`, `cwd`, `sandbox`, `idle_timeout`（默认 900s，0 禁用）, `timeout`（可选硬墙钟上限）, `execution_mode`, `wait_budget_seconds`, `return_view` (`full`\|`summary`), `isolation` (`inplace`\|`worktree`), `base`, `model`, `effort`, `acceptance`, `non_goals`, `output_schema`, `grants_mcp` |
| `codex_resume` | 继续会话（继承 worktree、`effort`、`idle_timeout` 与影子 `CODEX_HOME`）。参数：`session_id`, `task`, `effort`, `idle_timeout`, `timeout`, `acceptance`, `non_goals`, `return_view` |
| `codex_sessions` | 管理运行。动作：`list`, `get`, `stop`, `doctor`, `apply`, `cleanup`。get 参数：`view`, `wait_seconds`, `wait_for` (`terminal`\|`progress`), `since_seq`, `max_chars`。apply 参数：`dry_run`, `cleanup`, `scope` (`auto`\|`worktree`\|`run`), `allow_partial` |

## 源码结构

```
src/
├── index.ts        MCP server、协议级 instructions、view 系统、智能长轮询、worktree apply
├── worker.ts       独立 worker：加锁 → 快照 → Codex（活性看门狗）→ 快照 → review
├── evidence.ts     Codex 自动探测、Git 操作、diff/patch 导出、敏感检测、代理环境、进程管理
├── grants.ts       影子 CODEX_HOME（默认零 MCP + 安全继承模型与 provider 默认配置）
├── progress.ts     持久化状态（~/.codex-bridge/ 或 CODEX_BRIDGE_HOME）、增量事件
├── types.ts        共享类型和常量
└── statusline.ts   终端状态栏（仅 CLI 模式）
```

## 安装

**Antigravity** — 加入 `~/.gemini/config/mcp_config.json`：
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

**Claude Code：**
```bash
claude mcp add codex-bridge -- node /absolute/path/to/codex-bridge/dist/index.js
```

**Claude Desktop** — 加入 `claude_desktop_config.json`：
```json
{ "mcpServers": { "codex-bridge": { "command": "node", "args": ["/absolute/path/to/codex-bridge/dist/index.js"] } } }
```

### 可选环境变量

| 变量 | 用途 |
|------|------|
| `CODEX_BINARY` | 显式指定 `codex` 路径（默认自动探测 `Codex.app`、`~/.local/bin`、standalone、Homebrew 与 `PATH`） |
| `CODEX_BRIDGE_HOME` | 重定向持久化状态目录（默认 `~/.codex-bridge`） |
| `CODEX_BRIDGE_MAX_WAIT_SECONDS` | 限制长轮询与同步等待上限（`10..600`，默认 `240`），适配较紧的 MCP 客户端超时 |
| `CODEX_BRIDGE_DEFAULT_IDLE_TIMEOUT` | 覆盖默认活性看门狗 `idle_timeout` 秒数（`0` 禁用，`10..7200`，默认 `900`） |

## 边界

**受保护：** Git diff、patch 文件、review 预览 — 敏感路径/内容已剥离。

**不受保护：** Codex 原始 stdout/stderr。不要让 Codex 打印密钥。

**协作假设：** Diff 假设运行期间独占工作区。Bridge 阻止并发写 session，但不阻止外部编辑器。

## 环境要求

Node.js ≥ 18 · Git ≥ 2.30 · [Codex CLI](https://github.com/openai/codex)

## 许可证

MIT
