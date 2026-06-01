# codex-bridge v2.1.0 补充压力测试

## 前置条件

复用 `~/codex-bridge-test` 测试仓库。如不存在，按 STRESS-TEST.md 重新创建。

---

## T20: 非 Git 仓库执行

**操作：**
```bash
mkdir -p ~/codex-bridge-test-nogit
echo '{"name":"nogit-test"}' > ~/codex-bridge-test-nogit/package.json
```

```
codex_exec({
  task: "创建 hello.js，内容为 console.log('hello')",
  cwd: "~/codex-bridge-test-nogit",
  allow_non_git: true,
  execution_mode: "async"
})
```

**预期：**
- 正常执行，不报 "Not a Git repo" 错误
- review packet 中 `git_diff.is_git_repo: false`
- `warnings` 包含 "Non-git directory: no diff captured"
- Codex 实际创建了 hello.js

---

## T21: Codex 不改任何文件（read-only 审方案）

**操作：**
```
codex_exec({
  task: "审查当前项目的代码结构和质量，给出改进建议。不要修改任何文件。",
  cwd: "~/codex-bridge-test",
  sandbox: "read-only",
  execution_mode: "async"
})
```

**预期：**
- `status: "completed"`
- `git_diff.changed: false`
- `output` 包含 Codex 的审查意见
- `partial_changes: false`

---

## T22: 按 session_id 做 get（非 run_id）

**前置：** 从之前任何一个完成的 run 记录 session_id

**操作：**
```
codex_sessions get --session_id <session_id>
```

**预期：**
- 找到对应 run，返回 review_ready + review_packet
- 和用 run_id 查询结果一致

---

## T23: 按 session_id 做 stop

**操作：**
```
# 启动 async 任务
codex_exec({
  task: "实现一个完整的计算器应用，包含加减乘除、括号解析、错误处理",
  cwd: "~/codex-bridge-test",
  execution_mode: "async"
})

# 等任务运行后，用 session_id（不是 run_id）stop
codex_sessions stop --session_id <session_id>
```

**预期：**
- 通过 session_id 找到活跃 run
- `cancellation_requested: true`
- 后续 get 显示 `cancelled`

---

## T24: 多轮连续 Resume（3 轮）

**操作：**
```
# 第 1 轮
codex_exec({
  task: "创建 src/calculator.ts，实现 add(a, b) 函数",
  cwd: "~/codex-bridge-test",
  execution_mode: "async"
})

# 第 2 轮：resume 加功能
codex_resume({
  session_id: "<第 1 轮 session_id>",
  task: "在 calculator.ts 里添加 subtract 和 multiply 函数"
})

# 第 3 轮：resume 再加
codex_resume({
  session_id: "<同一个 session_id>",
  task: "在 calculator.ts 里添加 divide 函数，除以零时抛出 Error"
})
```

**预期：**
- 三轮全部 `resume_attached: true`
- 每轮 diff 只包含该轮新增的内容
- session_id 三轮一致
- 第 3 轮的 calculator.ts 包含全部四个函数

---

## T25: 已知 session 传不同 cwd 被拒绝

**前置：** 从已完成的 run 拿到 session_id

**操作：**
```
codex_resume({
  session_id: "<已知 session_id>",
  task: "继续",
  cwd: "/tmp"
})
```

**预期：**
- 返回错误
- `"codex_resume cannot override cwd"`

---

## T26: danger-full-access 未 ack 被拒绝

**操作：**
```
codex_exec({
  task: "列出文件",
  cwd: "~/codex-bridge-test",
  sandbox: "danger-full-access"
})
```

**预期：**
- 返回错误
- `"danger-full-access requires danger_ack=true"`

---

## T27: max_diff_chars 截断

**操作：**
```
codex_exec({
  task: "创建 5 个新文件：src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts，每个文件写 50 行代码实现不同功能",
  cwd: "~/codex-bridge-test",
  max_diff_chars: 500,
  execution_mode: "async"
})
```

**预期：**
- `git_diff.diff_truncated: true`
- `git_diff.diff_preview` 长度接近 500 字符
- `git_diff.diff_preview_mode: "review-prioritized"`
- `git_diff.diff_path` 指向完整 patch 文件

---

## T28: 网络故障实时检测（30 秒无响应）

**操作（模拟网络不通）：**
```bash
# 方法 1：临时断开 VPN/代理，然后执行
codex_exec({
  task: "列出文件",
  cwd: "~/codex-bridge-test",
  execution_mode: "async",
  timeout: 60
})

# 方法 2：如果无法断网，可以用不存在的 model 触发连接失败
codex_exec({
  task: "列出文件",
  cwd: "~/codex-bridge-test",
  model: "nonexistent-model-that-will-fail",
  execution_mode: "async",
  timeout: 60
})
```

**验证（等 30-40 秒后）：**
```
codex_sessions get --run_id <run_id>
```

**预期：**
- progress 或 review 中包含以下之一：
  - progress.message 含 "No response from Codex API after 30s"
  - review.failure_hint = "network" 或 "no_response"
  - warnings 含网络相关提示
- 不会静默等到 timeout 才返回失败

---

## T29: Doctor 网络连通性检查

**操作：**
```
codex_sessions doctor
```

**预期：**
- 输出包含 `network` 字段
- `network.reachable: true`（网络正常时）
- `network.latencyMs` 有值

**对照（断网时）：**
- `network.reachable: false`
- `network.error` 有值（timeout 或具体错误）

---

## T30: install-statusline

**操作：**
```bash
codex-bridge install-statusline
cat ~/.claude/settings.json
```

**预期：**
- 输出 "Wrote statusLine config to ..."
- `~/.claude/settings.json` 包含：
  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "codex-bridge statusline",
      "refreshInterval": 2
    }
  }
  ```
- 文件权限 0600
- 目录权限 0700

---

## 通过标准

| 编号 | 测试项 | 通过条件 |
|------|--------|---------|
| T20 | 非 Git 仓库 | allow_non_git 正常执行 + is_git_repo=false |
| T21 | 不改文件 | changed=false + 有审查输出 |
| T22 | get by session_id | 找到 run + review |
| T23 | stop by session_id | 找到活跃 run + 取消 |
| T24 | 多轮 resume | 3 轮 attached + diff 独立 |
| T25 | cwd 覆盖拒绝 | 返回错误 |
| T26 | danger 未 ack | 返回错误 |
| T27 | diff 截断 | truncated=true + 路径指向完整 patch |
| T28 | 网络故障检测 | 30s 内有网络相关提示 |
| T29 | Doctor 网络 | reachable + latencyMs |
| T30 | install-statusline | 正确写入 settings.json |
