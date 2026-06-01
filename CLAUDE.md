# codex-bridge

Claude 与 Codex 之间的 MCP 证据层。Claude 出方案做审查，Codex 写代码，codex-bridge 捕获文件系统真实变更。

## 调用规范

1. **task**: 自包含的详细规范。Codex 不知道之前的对话，prompt 必须完整
2. **cwd**: 项目根目录绝对路径
3. **model**: 不要指定。省略让 Codex CLI 使用默认模型（自动跟随官方最新版本）
4. **sandbox**: 默认 "workspace-write"，除非任务明确只需要读
5. **execution_mode**: 不需要指定，默认 auto（短任务同步返回，长任务自动切异步）
6. **同一任务的修复/迭代**: 用 `codex_resume`（保持上下文），不要新建 session
7. **不相关的新任务**: 用 `codex_exec` 新建 session

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

## 仓库信息

- **GitHub：** https://github.com/mrfacecheck/codex-bridge
- **npm：** https://www.npmjs.com/package/@codex-bridge/core
- **版本：** 2.1.0
- **许可证：** MIT
