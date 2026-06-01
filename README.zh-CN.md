# codex-bridge

[English](./README.md) · **中文文档**

Claude 与 Codex 之间的协作证据层。

Claude 负责思考和审查，Codex 负责写代码。codex-bridge 在中间做一件事：记录 Codex 到底改了什么文件——不依赖 Codex 自己的报告，而是直接对比文件系统的前后变化。

```
Claude Code ──[MCP]──▶ codex-bridge ──▶ Codex CLI
                            │
                      精确的代码变更对比
                      敏感文件自动过滤
                      长任务后台执行与恢复
```

## 解决什么问题

Claude 出方案、Codex 写代码，是很强的工作方式。但实际用下来有五个地方会出问题：

| 问题 | 具体表现 |
|------|---------|
| **无法核实结果** | Codex 说"修好了认证，测试也更新了"。但 Claude 没有办法独立验证这句话是否属实——只能信。 |
| **长任务会断** | Codex 跑了十几分钟，Claude Code 的连接断开了。代码改动已经落盘，但结果送不回来。 |
| **敏感文件可能泄漏** | Codex 把 `.env` 的内容复制到了 `config/defaults.txt`。如果不做内容识别，这份敏感信息会直接进入审查。 |
| **会话恢复可能失败** | Claude 要求继续上一次的工作。Codex 实际上开了一个全新的会话，但没有人发现上下文已经换了。 |
| **执行过程看不到** | Codex 在后台跑了好几分钟，Claude 和用户都不知道进展到哪了。 |

codex-bridge 逐一解决这五个问题。

## 快速开始

```bash
npm install -g @codex-bridge/core
claude mcp add codex-bridge -- npx codex-bridge
```

安装后验证：让 Claude 执行 `codex_sessions doctor`，确认环境正常。

然后直接对 Claude 说：`"用 codex 在 ~/my-project 实现用户认证"`

## 核心机制

每次调用 `codex_exec`，返回的不是一句"完成了"，而是一份结构化的**审查报告**（review packet）——记录了哪些文件变了、怎么变的、有没有敏感内容：

```json
{
  "status": "completed",
  "git_diff": {
    "summary": "修改了 3 个文件，增加 42 行，删除 5 行",
    "files": [{"status": "M", "path": "src/auth.ts"}],
    "diff_preview": "...",
    "sensitive_diff_omitted": [".env -> config.txt (内容匹配到敏感文件)"]
  },
  "partial_changes": false,
  "warnings": []
}
```

### 六项保证

| 保证 | 实现方式 |
|------|---------|
| **变更对比精确到本次运行** | 运行前后各做一次 Git 快照，放在隔离的临时目录里。之前未提交的改动不会混进来。 |
| **敏感内容自动过滤** | `.env`、`.pem`、`.key` 等文件自动从变更记录中剥离。即使 Codex 把敏感文件复制成了别的名字，内容指纹匹配也能识别并排除。代码中引用敏感路径的行为会被标记。 |
| **会话恢复有校验** | 每次恢复会话时都会检查实际连接的线程是否和请求的一致。不一致则整次运行标记为失败。 |
| **超时状态明确** | 如果 Codex 超时但已经改了文件，会明确标记 `partial_changes: true`。不会让你误以为什么都没发生。 |
| **长任务不怕断连** | 后台独立进程负责执行。即使 Claude Code 断开，Codex 继续跑，结果写到磁盘上，重连后可以取回。 |
| **多实例不冲突** | 文件锁加进程级别校验。同时开多个 Claude 实例也不会互相干扰。 |

### 长任务处理

3 分钟以内的任务，结果直接同步返回。更长的任务自动切换为后台执行：

```
调用 codex_exec → 启动后台进程 → 最多等 180 秒
  ├─ 在等待时间内完成 → 直接返回完整结果
  └─ 超过等待时间 → 返回任务编号，后续通过 codex_sessions get 查询结果
```

后台进程独立于主服务运行。结果持久化到磁盘，不受连接状态影响。

### 网络问题检测

三层机制，适配不稳定的网络环境：

| 层级 | 触发时机 | 表现 |
|------|---------|------|
| **实时预警** | Codex 启动 30 秒后仍无任何响应 | 进度信息中提示可能是网络问题 |
| **故障归类** | Codex 因连接错误退出时 | 审查报告中标注 `failure_hint: "network"` |
| **主动诊断** | 手动执行 `codex_sessions doctor` | 显示到 OpenAI 接口的连通性和延迟 |

### 状态栏

```bash
codex-bridge install-statusline
```

在 Claude Code 底部实时显示 Codex 的执行进度：

```
Codex 8f1c running 06:21  正在运行: npm test
Codex 8f1c done 11:03  修改了 3 个文件，+42 -5
```

## 三个工具

| 工具 | 作用 | 主要参数 |
|------|------|---------|
| `codex_exec` | 启动新任务 | `task`（任务描述）、`cwd`（项目目录）、`sandbox`（权限级别）、`timeout`（超时时间）、`execution_mode`（执行模式） |
| `codex_resume` | 继续上一次的会话 | `session_id`（会话标识）、`task`（后续指令） |
| `codex_sessions` | 管理和诊断 | `list`（列出全部）· `get`（查看详情）· `stop`（停止任务）· `doctor`（环境检查） |

## 典型工作流

**基础循环** — Claude 出方案 → Codex 执行 → Claude 审查变更 → Codex 修复问题 → 完成。

**方案审查** — 让 Codex 以只读模式审查 Claude 的方案，不修改任何文件，先拿到第二意见。

**多角度并行审查** — 同时启动多个只读会话（分别关注架构、安全、性能）→ Claude 综合意见 → 一次写入执行。

## 项目结构

```
src/
├── types.ts        类型定义、常量、状态模型
├── evidence.ts     Git 快照、差异对比、敏感文件检测、文件锁
├── progress.ts     持久化状态管理（运行记录、会话索引、项目指针）
├── worker.ts       后台进程：加锁 → 快照 → 执行 Codex → 快照 → 生成审查报告
├── index.ts        MCP 服务：工具接口、会话管理、网络探测
└── statusline.ts   状态栏输出与安装
```

架构设计文档：[V2-DESIGN.md](./V2-DESIGN.md)

## 安装配置

**Claude Code：**
```bash
claude mcp add codex-bridge -- npx codex-bridge
```

**Claude Desktop** — 在 `claude_desktop_config.json` 中添加：
```json
{ "mcpServers": { "codex-bridge": { "command": "npx", "args": ["codex-bridge"] } } }
```

## 保护边界

**保护范围：** 代码变更对比、补丁文件、审查预览。敏感路径和内容副本从所有证据输出中自动剥离。

**不在保护范围：** Codex 的原始文本输出（标准输出、错误输出、最终消息）。这些内容未经过滤，可能包含 Codex 或命令行打印的任何信息。不要要求 Codex 显示密钥或凭证。

**协作前提：** 变更对比假设 Codex 运行期间工作区是独占的。codex-bridge 会阻止同一仓库的并发写入任务，但无法阻止外部编辑器或脚本同时修改文件。

## 常见问题

| 现象 | 解决方法 |
|------|---------|
| 提示"另一个进程正在写入" | 执行 `codex_sessions list` 找到活跃任务，用 `codex_sessions stop` 加任务编号停止 |
| `~/.codex-bridge` 目录越来越大 | 超过 7 天的运行记录会自动清理。手动清理：`rm -rf ~/.codex-bridge/runs/*` |
| 长任务完成了但 Claude 没收到 | 用 `codex_sessions get` 加任务编号轮询结果 |
| 恢复会话时提示"未知会话" | 服务重启后内存状态会丢失。在恢复命令中显式指定项目目录即可 |
| Codex 启动后立即失败 | 执行 `codex_sessions doctor` 检查网络连通性和 Codex CLI 版本 |

## 环境要求

Node.js 18 或更高版本 · Git 2.30 或更高版本 · [Codex CLI](https://github.com/openai/codex)

## 开源许可

MIT
