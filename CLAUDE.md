# codex-bridge

Claude 与 Codex 之间的 MCP 证据层。Claude 出方案做审查，Codex 写代码，codex-bridge 捕获文件系统真实变更。

## 调用规范

1. **task**: 自包含的详细规范。Codex 不知道之前的对话，prompt 必须完整
2. **cwd**: 项目根目录绝对路径
3. **model**: 不要指定。省略让 Codex CLI 使用默认模型（自动跟随官方最新版本）
4. **sandbox**: 默认 "workspace-write"，除非任务明确只需要读
5. **同一任务的修复/迭代**: 用 `codex_resume`（保持上下文），不要新建 session
6. **不相关的新任务**: 用 `codex_exec` 新建 session

## 默认执行策略

按任务类型选择模式，不要所有任务都用默认参数：

| 任务类型 | execution_mode | wait_budget_seconds | timeout |
|---------|---------------|-------------------:|--------:|
| read-only 审方案 / 小型定位 | auto | 45 | 300 |
| 小 patch / 单文件修改 | auto | 60 | 600 |
| 常规功能实现 / 需要跑测试 | async | — | 1200 |
| 大重构 / 迁移 / 多文件复杂任务 | async | — | 1800-3600 |

`wait_budget_seconds` 是 Claude 等待工具返回的时间（默认 60s）。
`timeout` 是 Codex worker 的硬上限（不指定时按 sandbox/mode 自动推算）。
不要把二者混用。

## Async 轮询策略

当 `codex_exec` 返回 `async: true` 或 `status: "running"`：

1. 立即告诉用户：Codex 已在后台执行，给出 run_id
2. 不要启动同一 repo 的第二个 workspace-write run
3. 用轻量 status 视图 + long-poll 轮询：
   ```json
   { "action": "get", "run_id": "<run_id>", "view": "status", "wait_seconds": 20, "since_seq": <last_seq> }
   ```
4. 轮询节奏：第 1 次 wait_seconds=20，第 2 次 30，第 3 次起 60
5. 单回合最多轮询 4-6 次
6. 未完成不要 stop，向用户说明后台继续，保留 run_id
7. 如果 status 返回 `stale: true`（5 分钟无新事件），向用户说明 Codex 可能卡住，询问是否 stop
7. 当 `review_ready: true` 时，先取 summary 再决定是否看 diff

## Review 获取策略

不要在任务完成后立刻请求完整 review packet。正确顺序：

1. 先取 summary：`{ "action": "get", "run_id": "...", "view": "summary" }`
2. summary 包含：status、文件列表、diff 摘要、warnings、risk_flags、output 尾部 2KB
3. 如果需要看完整 diff：`{ "view": "diff", "max_chars": 60000 }`
4. 如果需要看完整 packet：`{ "view": "review", "max_chars": 80000 }`
5. 如果只看 Codex 输出：`{ "view": "output", "max_chars": 10000 }`

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
- **版本：** 2.2.7
- **许可证：** MIT
