# codex-bridge

MCP 客户端（Antigravity / Claude Code 等）与 Codex 之间的 MCP 证据层。上层智能体出方案做审查，Codex 写代码，codex-bridge 捕获文件系统真实变更。

## 调用规范

1. **task**: 自包含的详细规范。Codex 不知道之前的对话，prompt 必须完整。建议配 `acceptance`（验收标准，worker 完成前自查）和 `non_goals`（明确不做的事）
2. **cwd**: 项目根目录绝对路径
3. **model / effort**: 默认省略让 Codex CLI 跟随 `~/.codex/config.toml` 默认（影子 `CODEX_HOME` 会安全继承 `model` / `model_reasoning_effort` / `service_tier` / `model_provider` 及对应 `[model_providers.<name>]`）。编排路由场景可显式指定（如 `model: "gpt-6.2-sol", effort: "xhigh"`）
4. **sandbox**: 默认 "workspace-write"，除非任务明确只需要读
5. **isolation**: 默认 "inplace"（直接改工作树，同 repo 写锁串行）。"worktree" 把运行放进 `<CODEX_BRIDGE_HOME>/wt/<run_id>` 的隔离 worktree——**不碰调用方工作树、同 repo 可并行、diff 天然只含本次变更**；编排派单场景优先用它，完成后用 `codex_sessions(action="apply", run_id=..., dry_run=true|false, cleanup=true)` 一键校验、落盘并回收（未合入则用 `action="cleanup"` 回收）
6. **同一任务的修复/迭代**: 用 `codex_resume`（保持上下文、自动继承 worktree、`effort`、`idle_timeout` 与影子 `CODEX_HOME`），不要新建 session
7. **不相关的新任务**: 用 `codex_exec` 新建 session
8. **return_view**: 在 `auto`/`sync` 模式下可传 `return_view: "summary"`，快任务完成时直接返回紧凑摘要，避免把完整 diff 灌入上下文

## 默认执行策略

v2.4.0 起 **默认取消墙钟硬超时（`timeout` 为 `null`）**，改由基于真实 Codex JSONL stdout 活性的 **`idle_timeout`（默认 900s，可设 0 禁用）** 看门狗兜底——长思考 / 多文件任务只要还在持续推进，绝不会被武断腰斩；真正卡死无输出才会触发 `idle_timeout`。仅在需要硬时间预算时才显式传 `timeout`。

| 任务类型 | execution_mode | wait_budget_seconds | idle_timeout | timeout |
|---------|---------------|-------------------:|-------------:|--------:|
| read-only 审方案 / 小型定位 | auto | 45 | 默认 (900) | 省略 |
| 小 patch / 单文件修改 | auto | 60 | 默认 (900) | 省略 |
| 常规功能实现 / 需要跑测试 | async | — | 默认 (900) | 省略 |
| 大重构 / 深度推理 (xhigh) | async | — | 默认 (900) 或 1200 | 省略 |

`wait_budget_seconds` 是调用方等待工具同步返回的时间（默认 60s）。
`idle_timeout` 是无真实 Codex JSONL 活动时的静默看门狗（默认 900s）；`timeout` 是可选硬墙钟上限（默认关闭）。
不要把三者混用。

## Async 轮询策略

当 `codex_exec` 返回 `async: true` 或 `status: "running"`：

1. 立即告诉用户：Codex 已在后台执行，给出 run_id
2. 不要启动同一 repo 的第二个 `inplace` 写任务（`isolation="worktree"` 允许安全并行）
3. 用 **`view: "summary"` + `wait_seconds`** 一步等到终态（`wait_for` 默认 `"terminal"`，仅在完成/失败/卡死/超时时唤醒，不会每条中间事件都惊醒）：
   ```json
   { "action": "get", "run_id": "<run_id>", "view": "summary", "wait_seconds": 240 }
   ```
   若仅需流式观察中间进度，再传 `"view": "status", "wait_for": "progress", "since_seq": <last_seq>`。
4. 单次 `wait_seconds` 上限受 `CODEX_BRIDGE_MAX_WAIT_SECONDS` 约束（默认 240，最高可配 600；客户端 MCP 超时较紧时自动截断）
5. 未完成不要 stop，向用户说明后台继续，保留 run_id；`action:"list"` 默认紧凑字段（含 `isolation` 与 `worktree_exists`），需要全量细节时传 `verbose: true`
6. 如果 status 返回 `stale: true`（5 分钟无真实 Codex JSONL 活动），向用户说明 Codex 可能卡住，询问是否 stop
7. 当 `review_ready: true` 时，先看 summary 再按需看 diff；worktree 任务审查通过后直接调用 `action="apply"`（支持 `dry_run: true` 与 `cleanup: true`）落盘回主工作区

## Review 获取策略

不要在任务完成后立刻请求完整 review packet。正确顺序：

1. 先取 summary：`{ "action": "get", "run_id": "...", "view": "summary" }`
2. summary 包含：status、文件列表、diff 摘要、warnings、risk_flags、output 尾部 2KB、`concurrent_parent_changes`（并行编辑主工作区时不再误报 escape）
3. 如果需要看完整 diff：`{ "view": "diff", "max_chars": 60000 }`
4. 如果需要看完整 packet：`{ "view": "review", "max_chars": 80000 }`
5. 如果只看 Codex 输出：`{ "view": "output", "max_chars": 10000 }`
6. worktree 成果落盘：`{ "action": "apply", "run_id": "...", "dry_run": true }` 预检后 `{ "action": "apply", "run_id": "...", "cleanup": true }`（多轮 `codex_resume` 自动合并整个 worktree diff）

默认不要把完整 review packet 灌入上下文。

## 项目结构

```
src/
├── types.ts        类型定义、常量、状态模型
├── evidence.ts     Git 快照、差异对比、敏感文件检测、文件锁
├── progress.ts     持久化状态管理（运行记录、会话索引、项目指针）
├── worker.ts       后台进程：加锁 → 快照 → 执行 Codex → 快照 → 生成审查报告
├── index.ts        MCP 服务：工具接口、会话管理、网络探测
└── statusline.ts   状态栏输出与安装
bin/
└── codex-bridge.mjs  入口（子命令路由，开发走 tsx，生产走 dist）
```

## 常用命令

```bash
npm run build          # TypeScript 编译到 dist/
npm start              # 开发模式启动 MCP server
npx tsc --noEmit       # 类型检查
npm pack --dry-run     # 预览发布内容
```

## 发版规范

### Commit 规范

使用 conventional commits，一个版本一个 commit：

```
feat: 功能描述 (vX.Y.Z)      ← 新功能
fix: 修复描述 (vX.Y.Z)       ← bug 修复
chore: 维护描述               ← 不影响功能的杂务
docs: 文档描述                ← 纯文档
```

**不要**：一行改一个 commit、SCP 失误单独 commit、版本号单独 commit。
**应该**：所有改动攒齐 → 一次 commit 带版本号 → tag → push。

### 发版流程

```bash
# 1. 本地改代码 + 改 package.json 版本号
# 2. 构建验证
npx tsc --noEmit && npm run build && npm install -g .

# 3. SCP 到 dev-01
scp -P 2900 -i ~/.ssh/easycut_dev01_ed25519 \
  src/*.ts package.json CHANGELOG.md CLAUDE.md README.md README.zh-CN.md \
  liangzhi@a.nixx.top:/home/liangzhi/projects/codex-bridge/src/
# （注意 src/ 文件放 src/ 目录，根文件放根目录，分两次 scp）

# 4. dev-01 上一次性提交 + tag + push + publish
git add -A
git commit -m "feat/fix: 描述 (vX.Y.Z)"
git tag vX.Y.Z
git push && git push --tags
npm publish --ignore-scripts --access public

# 5. 同步 review 目录和两个 node 版本的全局安装
```

### Tag 规范

只给里程碑版本打 tag，不给 patch 中间版本打：
- `v2.1.0` — 初始发布
- `v2.1.1` — proxy 修复
- `v2.2.7` — view 系统 + long-poll + stall 检测

### 两个 node 版本都要装

CCD 可能用 v22.21.1 或 v22.22.3 的 PATH，两个都要 `npm install -g`：
```bash
npm install -g .                                                              # 当前 node
/Users/liangzhi/.nvm/versions/node/v22.22.3/bin/npm --prefix \
  /Users/liangzhi/.nvm/versions/node/v22.22.3 install -g @codex-bridge/core@latest  # 另一个
```

## 仓库信息

- **GitHub：** https://github.com/mrfacecheck/codex-bridge
- **npm：** https://www.npmjs.com/package/@codex-bridge/core
- **版本：** 2.4.0
- **许可证：** MIT
