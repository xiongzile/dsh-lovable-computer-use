# 架构复审：删除 9 个 `task_*` 工具

> 结论：这 9 个工具与 DSH 的 Session/turn、规则化 Goal、workspace changes、tool trace、session repair、approval/user-question 重叠。**已全部删除**，插件只保留真正需要 Agent 决策的工具。

## 1. DSH 已经提供了什么

| 需求 | DSH 机制 | 证据/行为 |
|---|---|---|
| Run/Turn 生命周期 | `turn/start`、`step/start`、`turn/end` | `packages/core/session/src/types.ts`；turn end reason 区分 `completed/aborted/interrupted/...` |
| 工具调用轨迹 | `tool/call`、`tool/result` | 每次调用、参数、结果、错误、中断都写 Session log；`known-event-types.ts` |
| 修改记录 | `workspace/changes` | `packages/deliverables/workspace-changes/src/recorder.ts` 在 turn 结束自动比较 git 工作树/文件工具改动，记录文件列表和 diff |
| 持久化/Checkpoint | Session JSONL + projection cache + checkpoint policy | `packages/core/session`、`packages/session/session-persistence`、`session-projection-cache` |
| 崩溃恢复 | `session/repair` | `packages/core/session/src/repair.ts`：补齐 interrupted turn/step，未完成的 tool call 生成 `TOOL_OUTCOME_UNKNOWN`，提示先核验外部状态 |
| 长目标 | Goal domain | `packages/goal/goal`：`active/paused/blocked/complete`、round cap、`goal/change`、跨 turn/resume/fork 持久化 |
| 后台长工作 | Jobs | owner-scoped job registry；进程内实现，按 owner 隔离；不是任务台账 |
| 人工决策 | `ask_user_question` + approval seam | `packages/interaction/tool-ask-user`；`approval/asked`/`approval/decided` 事件 |
| 计划 | `todo_write` | 会话内计划，不是持久任务状态 |
| 审计/展示 | Session UI、tool cards、goal projection、workspace changes UI | 不需要重复造一份 task JSON |

### 关键限制（必须诚实）

- DSH 的 Goal **没有独立 evaluator**：文档明确“caller that records completion is authoritative; evaluator-backed certification deferred”。因此不能把 `update_goal complete` 当成客观验证。
- Jobs 是进程内的，不是跨重启的持久任务后端；但 Sessions 的 turn/tool trace 会持久化。
- `workspace/changes` 覆盖工作区文件，不覆盖浏览器外部副作用（例如创建 GitHub issue）。外部副作用只能通过 tool/result + 后续 canary 核验。

## 2. 9 个工具的职责判定

| 工具 | 与 DSH 的关系 | 判断 | 处理 |
|---|---|---|---|
| `task_start` | 重复 Session/turn；长期目标已有 Goal | 重复 + 抽象泄漏 | **删除** |
| `task_status` | Session log/UI 已可回放；Goal projection 已可读 | 重复 | **删除** |
| `task_update` | 状态推进应由 turn/goal 管理 | 重复 | **删除** |
| `task_change` | `workspace/changes` 自动记录文件改动；工具结果记录外部动作 | 重复；Agent 手写必然漏/慢 | **删除** |
| `task_evidence` | `tool/call`/`tool/result` 自动记录；验证工具结果本身就是证据 | 重复；诱导模型做记账而不是做事 | **删除** |
| `task_handoff` | `ask_user_question` 已提供人工决策 | 重复 | **删除**；浏览器可见窗口仍用专用 handoff |
| `task_finish` | `turn/end` 自动结束；Goal phase 由 Goal domain 管理 | 模型自证成功，语义错误 | **删除** |
| `task_recover` | `session/repair` 自动修复中断 turn/tool；Goal 可 resume | 重复 | **删除** |
| `task_prune` | Session retention/cleanup；profile 有 close/idle | 重复 | **删除** |

## 3. 成本

每个请求都会注入工具 schema。删除前实测：

- 9 个 task 工具定义：**8,855 JSON 字符，约 2,216 tokens**（按 chars/4 粗估）
- 5 个本地 Web session 中真实 task 调用：**33 次**，结果文本 **16,842 字符，约 4,210 tokens**
- 这还不含模型生成的 arguments、`task_change`/`task_evidence` 的书生化文字、以及为了“补记录”多跑的轮次

这不是“多几个工具”的成本，而是**每个请求都付的固定 prompt 税**，外加模型注意力被账本占据。

## 4. 删除后的职责边界

插件只保留：

- **浏览器**：`background_browser_*`（隔离 profile、快照、操作、下载、截图、close）
- **浏览器人工接管**：`background_browser_handoff`（唯一可见窗口；仍走 `ctx.userQuestions`）
- **IDE**：`ide_diagnose` / `ide_verify` / `ide_fix`（验证工具，不是生命周期）
- **焦点**：`foreground_app` / `focus_guard`
- **通知**：`notify_user`

不再有 `task_*`、`TaskStore`、task JSON、recover/prune 逻辑。

### “执行结束”与“目标验证成功”

- 执行结束：DSH 在 turn 结束时写 `turn/end`，这是运行时事实，不是模型宣告。
- 目标验证：由确定性的验证工具（`ide_verify`、浏览器 canary、项目命令）产生结果，写入 tool/result；**不生成一个成功的任务状态**。
- 需要人确认的部分：`ask_user_question` 或浏览器 handoff；host-only 结果只能 `host_confirmed`。
- 我们不再提供 `task_finish`，所以模型不能用一个工具调用把“我完成了”写成成功。

**残留核心缺口**：DSH Goal 的 `complete` 仍是 caller-authoritative，没有独立 evaluator。插件不应伪造一个；如果要在 Goal 层强制“验证通过才 complete”，需要在 DSH core/Goal policy 增加 evaluator 接口。本次不越权实现。

## 5. 恢复与清理

- 中断 turn/工具：DSH `session/repair` 自动补齐，并给出外部状态核验警告。
- 浏览器进程：插件 dispose 时 `Browser.close`；profile 保留登录态；`idleCloseMs` 回收空闲浏览器。
- 删除登录态：仍是显式的 `background_browser_close(reset=true, confirm=true)`，这是用户决策，不是任务生命周期。
- 不再有 `task_prune`；Session retention 由 Harness 负责。

## 6. 这次重构的验收

- 工具目录不含任何 `task_*`
- 无 `src/task/`、无 TaskStore、无 task JSON
- 浏览器 handoff 不需要 taskId，不写任务状态
- 架构测试断言工具目录 = 17 个、无 task_*、无 taskId 参数
- 文档不再把 task ledger 说成能力
