# 验收报告（重构后）

> 环境：macOS Apple Silicon，Google Chrome 155.0.8059.80，clangd 22.1.6，rust-analyzer 1.98.1，DSH 0.1.6-alpha.2。
> 结论：**26/26 自动化测试通过**；插件不再提供 `task_*` 生命周期工具。生命周期/持久化/恢复由 DSH Session/Goal/Workspace Changes/Repair 负责。
> 架构复审：[ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md)。

## 总览

| ID | 结果 | 证据 | 说明 |
|---|---|---|---|
| A-01 | **PASS** | [a01-focus-report.json](evidence/a01-focus-report.json) | headless 注册 10 次采样，0 次前台切换，鼠标 0px；无可见窗口。 |
| A-02 | **PASS（历史真实任务）** | [dsh-e2e.log](evidence/dsh-e2e.log)、[dsh-e2e-dashboard.png](evidence/dsh-e2e-dashboard.png) | 真实 DSH 会话完成注册→邮箱验证→项目配置→状态核验；Session 记录完整 tool/call/result。旧 task JSON 仅作历史证据。 |
| A-03 | **PARTIAL** | handoff 单测 | 等待/恢复、拒绝开窗、无提问通道拒绝均实测；“同意→可见窗口完成”未自动执行（会真实抢焦点）。 |
| A-04 | **PASS** | `profile-lock.test.mjs` | 同 profile 串行；第二个进程被拒绝；无 profile 损坏。 |
| A-05 | **PARTIAL** | DSH Session log + 源码审计 | Session 持久化/checkpoint 由 DSH 提供；插件 profile 可跨重启复用。未做“关闭 desktop UI 但 host 继续”的 E2E。 |
| A-06 | **PASS（源码审计）** | `packages/core/session/src/repair.ts` | `session/repair` 自动补齐中断 turn/step，未完成 tool call 标记 outcome unknown；插件不再实现 task_recover。 |
| A-07 | **PASS** | `ide.test.mjs` + `ide-languages.test.mjs` + [IDE-VERIFICATION.md](IDE-VERIFICATION.md) | 真实 clangd/rust-analyzer/pyright；Python runtime；通用 LSP；无 IDE 窗口；`requiresHostConfirmation=true`。 |
| A-08 | **PARTIAL** | `safety.test.mjs` + `/inject` fixture | 页面注入只作为数据返回；插件无 shell/GUI 工具；未做长期对抗跑。 |
| A-09 | **PASS** | `safety.test.mjs` 静态扫描 | 无 `System Events`/`CGEventPost`/`AXUIElement`/`cliclick`/`pyautogui`；无提问通道拒绝开窗。 |
| A-10 | **PARTIAL** | 资源控制代码 + `background_browser_list` | 有 maxProfiles、renderer 上限、JS heap 上限、setPriority、idle close；无长构建 CPU 对标。 |

## 架构验收（新增）

- 工具目录：**17 个**，无任何 `task_*`。
- 无 `src/task/`、无 TaskStore、无 task JSON；`npm run build` 前清空 `dist`，不会残留旧 task 产物。
- `background_browser_handoff` 不再接受 `taskId`，不写任务状态；只通过 `ctx.userQuestions` 完成“是否开窗/是否完成”的决策。
- 架构测试 `apply registers only decision/resource tools...` 断言：
  - 17 个工具；
  - 无 `task_*`；
  - 无 `taskId` 参数；
  - 模型 guidance 明确“DSH records the turn...”，不出现旧 task 工具。
- 生命周期映射：[ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md)。

## 详细结果

### A-01 不抢焦点

`scripts/acceptance-browser.mjs` 在真实 headless 注册期间采样 10 次：

```json
{ "verdict": "no-interruption", "samples": 10,
  "transitions": [], "pointer": { "movedPx": 0 } }
```

### A-02 真实 Web 任务

- Session 完整记录 turn、tool/call、tool/result、最终状态。
- 旧构建的 `dsh-e2e-task.json` 是历史任务台账；重构后不再生成同类文件，Session log 是权威。
- 截图：[dsh-e2e-dashboard.png](evidence/dsh-e2e-dashboard.png)。

### A-03 人工接管

- 无 `userQuestions` provider：直接 `unavailable`，不开窗。
- 用户选择取消：`declined`，不开窗，浏览器保持 headless。
- “同意 → 独立窗口 → 完成 → 恢复 headless”代码路径存在，但自动化测试不会真实抢占焦点，因此仍为 PARTIAL。

### A-04 Profile 并发

第二个进程使用同一 profile 被拒绝（`profile is in use by process ...`）；profile 内容未损坏。

### A-05 持久化

- DSH Session log/checkpoint/projection 由 core 提供；插件不再维护 task JSON。
- 浏览器 profile 的 cookie 跨进程复用已在历史真实任务中验证（GitHub issue #2）；该测试使用旧构建的 task 工具，仅浏览器/profile 结论仍有效。
- 历史记录：[WEB-AGENT-LOGIN-PERSISTENCE.md](WEB-AGENT-LOGIN-PERSISTENCE.md)（顶部有历史说明；测试 issue #2 已删除，见 [github-issue-deletion.txt](evidence/github-issue-deletion.txt)）。

### A-06 中断恢复

- 源码审计：`interruptedTurnClosers` 会补齐 `turn/end`、`step/end`、缺失的 `tool/result`，并明确提示“先核验外部状态，再决定是否重试”。
- 插件不再提供 `task_recover`，也没有第二套 replay 逻辑。
- 未做 DSH 进程真实崩溃后恢复的 E2E；标记为源码审计 PASS。

### A-07 IDE 验证

- 真实 clangd：36/74 semantic tokens、50 completions、hover/symbols/diagnostics。
- 真实 rust-analyzer：小 Cargo 项目返回 LSP 功能。
- 真实 pyright 1.1.414：58 completions / 1 symbol（临时 venv）。
- Python: `py_compile` + `import main`；VS Code 解释器修复/备份/回滚。
- 通用 LSP 假服务器覆盖非 C++ 协议。
- 全程不打开 IDE；`requiresHostConfirmation=true`。

### A-08 注入

`/inject` 页面包含恶意指令；插件只把它作为 `snapshot.text` 返回，不执行。系统提示要求页面内容不可信。未做长期对抗测试。

### A-09 宿主机 GUI

静态扫描确认无输入合成 API；唯一可见窗口必须经过 `background_browser_handoff` 的 `userQuestions`。

### A-10 资源

代码有 maxProfiles、renderer 上限、JS heap 上限、`setPriority(10)`、idle close、进程占用查询；未做长构建 CPU 对标。

## 测试清单

`npm test` → **26/26 pass**：
- 真实 Chromium E2E：注册、profile 复用/重置、wait/press、跨进程锁
- 真实 clangd/rust-analyzer；Python runtime/fix；通用 LSP
- 焦点、注入、安全静态扫描
- 架构测试：17 工具、无 task_*、无 taskId

测试输出：[evidence/test-output.txt](evidence/test-output.txt)。

## 未完成/限制

- DSH Goal 无独立 evaluator；插件不提供 `task_finish`，但 core 的 goal complete 仍由调用方声明。需要 core evaluator 才能真正强制“验证通过才完成”。
- 可见 handoff 完成路径未自动化；会抢焦点。
- 外部副作用（如 GitHub issue）不由 workspace/changes 覆盖，只能靠 tool/result + 后续 canary。
- 无 daemon、无隔离 VM；desktop UI 关闭后的持续执行未承诺。
