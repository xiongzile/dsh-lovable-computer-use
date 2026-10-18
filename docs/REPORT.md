# 实现报告：后台电脑使用插件

> 重构后版本。生命周期/持久化/恢复不再由插件任务台账承担，改由 DSH 的 Session、Goal、Workspace Changes、Session Repair 负责。

## 1. 结论

本仓库补的是 DSH **缺失的资源与交互能力**：

- 隔离、持久、可接管的 Chromium profile
- 浏览器/IDE 的后台验证探针
- 前台抢占测量
- 不抢焦点的通知

它**不再提供** `task_start/status/update/change/evidence/handoff/finish/recover/prune`。这些工具与 DSH 的 turn/tool trace/workspace changes/session repair/goal/user-question 重叠，已在架构复审后删除。

- 架构复审：[ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md)
- IDE 验证：[IDE-VERIFICATION.md](IDE-VERIFICATION.md)

## 2. 职责边界

| 需求 | 负责方 |
|---|---|
| Run/Turn 生命周期 | DSH `turn/start` / `step/start` / `turn/end` |
| 工具轨迹 | DSH `tool/call` / `tool/result` |
| 文件修改 | DSH `workspace/changes` |
| 持久化/恢复 | Session log、projection cache、`session/repair` |
| 长目标 | DSH Goal domain |
| 后台长工作 | DSH Jobs |
| 人工决策 | `ask_user_question` + approval；浏览器可见窗口用本插件 handoff |
| 电脑资源 | 本插件的 browser/IDE/focus/notify 工具 |

## 3. 实际能做什么

### 后台浏览器 + 人工接管

```text
background_browser_open(profile="platform-test-account", url=...)
→ snapshot/act 填写、提交
→ 页面要求邮箱验证
→ background_browser_handoff(profile=..., reason=..., instructions=...)
   先问同意；同意后开独立 Chrome 窗口；用户完成后关闭窗口、回到 headless
→ background_browser_eval 核验状态
→ background_browser_close
```

Session 自动记录每一步 tool/call、tool/result；不需要模型再写 evidence。

### 不打扰前台的证据

```text
focus_guard start(label="headless registration")
... background_browser_* ...
focus_guard stop
# 期望 verdict=no-interruption，transitions=[]，pointer.movedPx=0
```

真实 headless 注册 10 次采样：0 次前台切换，鼠标 0px。证据：[a01-focus-report.json](evidence/a01-focus-report.json)。

### IDE 验证（不打开 IDE）

```text
C++:   clangd semantic tokens / completion / hover / symbols
Python: pyright/pylsp LSP 或 py_compile + import（runtime_verified）
Rust:  rust-analyzer LSP；cargo check（force）
Go/TS: gopls / typescript-language-server；go build / tsc（force）
```

- 真实 clangd 22.1.6；真实 rust-analyzer 1.98.1；真实 pyright 1.1.414（临时 venv，58 completions/1 symbol）
- 前台 IDE 窗口始终 `requiresHostConfirmation=true`；工具不启动、不操作 IDE

## 4. 测试与验收

`npm test`：**26/26** 通过。

- 真实 Chromium E2E：注册、profile 复用/重置、wait/press、跨进程锁
- 真实 clangd / rust-analyzer E2E
- Python py_compile/import + VS Code 解释器修复
- 通用 LSP 假服务器
- 焦点、注入、安全静态扫描
- 架构测试：17 个工具，无 `task_*`，无 `taskId`

完整验收：[ACCEPTANCE.md](ACCEPTANCE.md)。测试输出：[evidence/test-output.txt](evidence/test-output.txt)。

## 5. 删除任务台账的理由

旧实现的 9 个 task 工具：

- 每个请求固定注入约 **2,216 tokens** 的工具 schema（实测 8,855 字符）
- 5 个真实 session 中产生 33 次 task 调用、16,842 字符结果（约 4,210 tokens）
- `task_change` 与 `workspace/changes` 重复
- `task_evidence` 与 tool/result 重复
- `task_finish` 让模型自证成功，语义错误
- `task_recover` 与 `session/repair` 重复
- `task_prune` 与 Session retention 重复
- `task_handoff` 与 `ask_user_question` 重复

逐项表和成本数据：[ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md)。

## 6. 历史证据

以下文档/JSON 来自重构前的构建，保留用于浏览器/IDE/登录持久化的真实证据；其中 `task_*` 调用已不再存在：

- [vLLM macOS CPU + VS Code](WEB-AGENT-VLLM-TASK.md)
- [GitHub 登录态跨进程复用](WEB-AGENT-LOGIN-PERSISTENCE.md)
- [dsh-e2e-task.json](evidence/dsh-e2e-task.json)、[vllm-task.json](evidence/vllm-task.json)

## 7. 明确未实现/限制

- DSH Goal 仍无独立 evaluator；插件不伪造 goal 成功状态。
- 浏览器可见 handoff 的完成路径未自动化（会抢焦点）；拒绝/无 provider 路径已测。
- 单标签、无文件上传；外部副作用只由 tool/result 记录，非 workspace changes。
- 无 daemon、无隔离 VM；桌面 UI 关闭后的持续执行未承诺。
- no-sandbox 降级会降低浏览器隔离强度。
