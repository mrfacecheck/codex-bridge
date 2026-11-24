# codex-bridge

[English](./README.md) · **中文文档**

不是 Codex 包装器。不是聊天桥接。不是只读审查插件。不是多 agent 终端。

`codex-bridge` v3.1 是一个**基于单次运行作用域的 MCP 执行与证据内核**：Codex 在独立快照仓库中执行，上层 MCP 智能体（Antigravity、Claude Code、Cursor 等）负责规划与审查，每一次交接都锚定在旁路 Git 树证据与可恢复 3-way 合并之上。

```
MCP 客户端 (Antigravity / Claude Code / Cursor)
   ──[MCP stdio]──▶ codex-bridge v3.1 ──▶ Codex CLI（或桥接私有内核补丁版）
                         │
                         ├─ 独立快照仓库 + 旁路 evidence.git 证据库
                         ├─ 私有 3-way merge-tree 与崩溃可恢复落盘
                         ├─ 零 MCP 影子 CODEX_HOME（fail-closed 白名单）
                         ├─ 抗休眠提醒时钟 + 多 worker wait-any 复用
                         └─ macOS Seatbelt 内核级浏览器 exec-deny 防线
```

## 快速开始

推荐直接从 GitHub 安装或本地构建（npm registry 仍停在 2.2.7）：

```bash
npm install -g github:mrfacecheck/codex-bridge
```

或本地克隆构建：

```bash
git clone https://github.com/mrfacecheck/codex-bridge.git
cd codex-bridge && npm install && npm run build
```

验证：在 MCP 客户端中调用 `codex_sessions`，参数 `{"action": "doctor"}`。

## 架构

```
codex_exec / codex_resume
  → 幂等准入 + owner-nonce 租约 + 可选无模型 prepare
  → 独立后台 worker（MCP 断连不影响；直写 FD 的 JSONL stdout/stderr）
    → 冻结 origin_tree / before_tree 至私有 evidence.git
    → 在零 MCP 影子 CODEX_HOME 中启动 Codex CLI
    → 封存 after_tree 并生成 review packet（剥离敏感路径与别名）

codex_sessions get（单任务 run_id 或多任务 run_ids[] wait-any）
  → view=status:  轻量轮询（共享目录 fs.watch 多路复用）
  → view=summary: 文件统计、证据树 OID、attention、警告与输出尾部
  → view=diff / output / review: 按需加载细节

codex_sessions apply
  → 在 evidence.git 内部执行私有 git merge-tree --write-tree（保留主仓暂存区）
  → 持久化 PREPARED → COMMITTED ApplyIntent，逐文件原子替换落盘
```

核心设计：
- **Worker 独立进程** — MCP 崩溃或会话断连不会杀死 Codex；直写 FD 日志确保 worker 异常退出后仍能自动打捞日志、会话 ID 与磁盘改动。
- **独立快照仓库 + 旁路 `evidence.git`** — `isolation="worktree"` 创建完全隔离的快照仓库并将不可变 `origin_tree` 封存入私有 `evidence.git`；即便 Codex 在内自行 `git commit`、`git reset` 或篡改 `.gitignore`，所有变更字节仍完整留证。支持 `base="HEAD"`（默认）与 `base="working_tree"`。
- **私有 3-way `merge-tree` 与可恢复落盘** — `codex_sessions(action="apply", run_id=..., dry_run?, cleanup?)` 在 `evidence.git` 内完成三路合并，保留主工作区 `.git/index` 与不重叠修改，按多轮 `codex_resume` 水位线增量合并，冲突时主仓零写入。
- **视图渐进加载与原生 `wait-any`** — 按需按 `status → summary → diff` 拉取；支持单次 `action="get"` 传入 `run_ids` + `cursor` 同时等待多个并行 worker。
- **默认仅提醒不静默强杀 + 抗休眠时钟** — `timeout` 与 `idle_timeout` 默认均为 `null`；2 秒单调/墙钟采样器自动剔除电脑合盖休眠时段，通过一次性 `attention`（`idle_silence`、`repeated_failure`、`no_response`、`sandbox_gui_crash`）唤醒 `wait_for="terminal"`。
- **macOS Seatbelt 内核级浏览器防线** — macOS 沙箱 worker 注入 `HOST_VISUAL_QA_REQUIRED` 契约、影子 `rules/darwin-no-browser.rules`、`sandbox_gui_crash` 熔断提醒，并支持通过私有内核补丁版 `codex` 实现 100% XNU 内核级 `deny process-exec`。

## 证据与安全保证

| 保证 | 机制 |
| --- | --- |
| Diff 防工作区篡改 | 独立快照仓库 + 不可变 `origin_tree` 封存于旁路 `evidence.git` |
| 主仓安全合并与崩溃恢复 | 私有 `git merge-tree --write-tree`、持久化 `ApplyIntent`、单文件原子替换、拒绝符号链接/gitlink/越界路径 |
| 敏感内容过滤 | pathspec 剥离 + 内容指纹 + 敏感引用与别名 `risk_flags` |
| 默认零 MCP 暴露面 | 影子 `CODEX_HOME` 白名单；仓库夹带未授权 `.codex/config.toml` 直接 fail-closed 拒跑 |
| 诚实活性与自动打捞 | owner-nonce + 宿主机 `bootId` 租约；worker 死亡但 Codex 仍在写时上报 `liveness: "unknown"`，写完后自动打捞 |
| macOS 浏览器崩溃免疫 | 三层边界：能力契约 + 影子规则 + XNU Seatbelt `deny process-exec`（进入 `ChromeMain` 前直接返回 `EPERM`） |

## macOS 内核级浏览器加固（macOS 强烈推荐）

在 macOS 上，在 Codex 的 Seatbelt 沙箱内启动 `/Applications/Google Chrome.app`（即便是 `--headless`）或 Playwright 浏览器，会在 `HIServices._RegisterApplication()` 触发 `SIGABRT (134)` 并引发系统「意外退出」弹窗风暴。

本仓库提供极简可审计补丁（[patches/codex-rs-v0.166.0-darwin-deny-exec.patch](./patches/codex-rs-v0.166.0-darwin-deny-exec.patch)）与一键复现构建脚本（[scripts/build-patched-codex.sh](./scripts/build-patched-codex.sh)），在 Codex 自身的 Seatbelt 策略内收窄 `(allow process-exec)`，于 XNU `mac_vnode_check_exec` 阶段直接拒绝受禁浏览器 bundle 与 Playwright/Puppeteer 缓存的执行：

```bash
./scripts/build-patched-codex.sh
```

- 将桥接私有三件套安装到 `~/.codex-bridge/bin/`（`codex`、`codex-exec-server`、`codex-code-mode-host`），**绝不覆盖全局 `~/.local/bin/codex`**。
- `resolveCodexBinary()` 自动优先使用 `~/.codex-bridge/bin/codex`（仍支持 `CODEX_BINARY` 显式覆写）。
- 在 MCP 客户端执行 `codex_sessions({ "action": "doctor" })`，确认 `darwin_exec_deny_enforced: true` 即表示内核防线已生效。
- 随时删掉 `~/.codex-bridge/bin/` 即可无痛回到官方原版 CLI。

## 工具一览

| 工具 | 用途与核心参数 |
| --- | --- |
| `codex_exec` | 启动任务。参数：`task`、`cwd`、`sandbox`、`isolation`（`inplace`\|`worktree`）、`base`（ref 或 `working_tree`）、`prepare`、`idempotency_key`、`idle_attention_seconds`（默认 `900`）、`idle_timeout`（默认 `null`）、`timeout`（默认 `null`）、`execution_mode`、`wait_budget_seconds`、`return_view`（`full`\|`summary`）、`model`、`effort`、`acceptance`、`non_goals`、`output_schema`、`grants_mcp` |
| `codex_resume` | 按 `session_id` 续跑同一会话（继承快照工作区、`evidence.git`、`effort`、预算与影子 `CODEX_HOME`）。参数：`session_id`、`task`、`idempotency_key`、`effort`、`idle_attention_seconds`、`idle_timeout`、`timeout`、`acceptance`、`non_goals`、`return_view` |
| `codex_sessions` | 编排与诊断。动作：`list`、`get`、`stop`、`doctor`、`apply`、`cleanup`。`get` 参数：`run_id` 或 `run_ids[]`、`cursor`、`view`（`status`\|`summary`\|`diff`\|`output`\|`review`）、`wait_seconds`、`wait_for`（`terminal`\|`progress`）、`since_seq`、`max_chars`。`apply` 参数：`run_id`、`dry_run`、`cleanup`、`scope`（`auto`\|`worktree`\|`run`）、`allow_partial`、`idempotency_key` |

## 仓库结构

```
src/
├── index.ts        MCP server、协议级 instructions、渐进视图、wait-any 与 3-way apply
├── worker.ts       独立 worker：租约 → prepare → 快照 → Codex → 封存 → review packet
├── evidence.ts     Codex 探测、快照仓库、evidence.git、3-way merge-tree、代理与禁执行环境
├── grants.ts       影子 CODEX_HOME（默认零 MCP、macOS 规则、二进制能力与内核探针）
├── state.ts        幂等与墓碑、owner-nonce 租约、ApplyIntent、抗休眠时钟、会话根 GC
├── progress.ts     持久化状态（~/.codex-bridge/）、原子写、增量进度事件
├── types.ts        共享类型、Schema 与常量
└── statusline.ts   终端状态栏（仅 CLI 模式）
bin/
└── codex-bridge.mjs  入口脚本（MCP stdio 服务 + statusline/watch 子命令）
patches/
└── codex-rs-v0.166.0-darwin-deny-exec.patch  针对 openai/codex 的极简 Seatbelt 禁执行补丁
scripts/
└── build-patched-codex.sh  一键构建 ~/.codex-bridge/bin/ 私有补丁套件
test/               91 项确定性单元、桥接、授权、worker 与混沌测试
SKILL.md            智能体协作规范（兼容 Antigravity / Claude Code / Codex Skills）
```

## 安装配置

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
| --- | --- |
| `CODEX_BINARY` | 显式指定 `codex` 路径（默认优先探测 `~/.codex-bridge/bin/codex`，其次 `Codex.app`、`~/.local/bin`、standalone、Homebrew 与 `PATH`） |
| `CODEX_BRIDGE_HOME` | 重定向持久化状态目录（默认 `~/.codex-bridge`） |
| `CODEX_BRIDGE_MAX_WAIT_SECONDS` | 限制长轮询与同步等待上限（`10..600`，默认 `240`），适配较紧的 MCP 客户端超时 |
| `CODEX_BRIDGE_DEFAULT_IDLE_TIMEOUT` | 覆盖默认活性看门狗 `idle_timeout` 秒数（`0` 禁用，`10..7200`，默认 `null`） |
| `CODEX_BRIDGE_DEFAULT_IDLE_ATTENTION` | 覆盖默认静默提醒阈值 `idle_attention_seconds`（`0` 禁用，`10..7200`，默认 `900`） |
| `CODEX_BRIDGE_DENY_EXEC_SUBPATHS` | 仅 macOS：覆盖冒号分隔的浏览器 bundle/缓存路径列表，由私有补丁 `codex` 在 XNU Seatbelt `process-exec` 层拦截 |
| `CODEX_BRIDGE_EXTRA_DENY_EXEC_SUBPATHS` | 仅 macOS：向默认浏览器 `deny process-exec` 列表追加自定义绝对路径（冒号分隔） |

## 边界

- **受保护：** Git diff、补丁文件、3-way apply 目标与 review 预览——自动剥离或拒绝敏感路径、别名、符号链接与 gitlink。
- **不受保护：** Codex 原始 stdout/stderr。不要让 Codex 打印密钥。
- **协作假设：** `inplace` 模式按仓库租约串行写；`worktree` 模式完全隔离，`apply` 时原子校验主仓冲突。

## 环境要求

Node.js ≥ 18 · Git ≥ 2.38（支持 `git merge-tree --write-tree`）· [Codex CLI](https://github.com/openai/codex)

## 许可证

MIT
