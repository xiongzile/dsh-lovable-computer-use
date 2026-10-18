# 产品缺口 → 代码改动 → 验证映射

每条改动回答三个问题：用户原来卡在哪、现在多做什么、凭什么证明它有效。

## P-01 前台被抢

| 项 | 内容 |
| --- | --- |
| 原来 | 现有 Browser Use 可 headless，但没有 per-task/profile 生命周期，也没有任何测量能证明"没抢焦点"；Playwright 缓存在受限 profile 下直接 EPERM。 |
| 现在 | `background_browser_*` 启动独立 `--user-data-dir` 的 headless Chromium；`focus_guard` 采样前台 bundle id + 鼠标位置；`background_browser_handoff` 是唯一可见窗口路径。 |
| 代码 | [src/browser/chromium.ts](../src/browser/chromium.ts)、[src/browser/manager.ts](../src/browser/manager.ts)、[src/focus/guard.ts](../src/focus/guard.ts)、[src/focus/sampler.ts](../src/focus/sampler.ts) |
| 验证 | `npm test`：`isolated browser completes...`（断言隔离浏览器未取得前台，外部应用切换不归因）；受控 acceptance 运行 [evidence/a01-focus-report.json](evidence/a01-focus-report.json)（10 次采样、0 次切换、0px 鼠标位移） |
| 限制 | 采样是观测，不是因果证明；用户自己切前台也会被记录。 |

## P-02 人工验证卡死

| 项 | 内容 |
| --- | --- |
| 原来 | `ask_user_question` 只能问一个问题；没有等待状态、通知、profile 绑定的可见窗口、完成后的恢复。 |
| 现在 | `background_browser_handoff`：先问同意 → 关闭 headless → 同一 profile 开独立可见窗口 → macOS 通知 → 问完成 → 关闭窗口 → 恢复 headless；非浏览器人工决策直接用 DSH `ask_user_question`，不再有 `task_handoff`。 |
| 代码 | [src/tools/browser.ts](../src/tools/browser.ts)、[src/tools/handoff.ts](../src/tools/handoff.ts)、[src/util/notify.ts](../src/util/notify.ts) |
| 验证 | `npm test`：`headed browser handoff refuses without...`、`declining the visible handoff...` |
| 限制 | "同意后真正完成再恢复"的可见窗口路径没有自动执行（会真实抢焦点）；需要人工验证一次。 |

## P-03 没修好却报修好

| 项 | 内容 |
| --- | --- |
| 原来 | 模型输出即结论；没有任务级证据、验证级别、host 确认状态。 |
| 现在 | DSH 自动记录 `tool/call`/`tool/result`；验证工具（`ide_verify`、浏览器 canary、项目命令）把真实结果写进 tool result；插件不再提供 `task_evidence`/`task_finish`，不产生模型自证的成功状态。 |
| 代码 | [src/tools/ide.ts](../src/tools/ide.ts)、[src/ide/lsp.ts](../src/ide/lsp.ts)、[src/tools/browser.ts](../src/tools/browser.ts) |
| 验证 | `npm test`：真实 clangd/rust-analyzer/pyright；`ide_verify` 返回 `requiresHostConfirmation=true`；session tool/result 是审计来源。 |
| 限制 | DSH Goal 仍无独立 evaluator；插件不伪造完成状态，但不能代替 core 做 goal 认证。 |

## P-04 崩溃丢任务/重复副作用

| 项 | 内容 |
| --- | --- |
| 原来 | 对话可恢复，浏览器/执行进度不可恢复；Job 无外部副作用幂等语义。 |
| 现在 | DSH `session/repair` 补齐中断 turn/step，未完成 tool call 标记 outcome unknown 并提示先核验外部状态；`workspace/changes` 持久化文件改动；插件不再有 task JSON/recover。 |
| 代码 | DSH `packages/core/session/src/repair.ts`；本插件无第二套恢复逻辑 |
| 验证 | 源码审计（A-06）；插件 `npm test` 不再包含 task recovery 测试 |
| 限制 | 外部副作用（浏览器提交、创建 issue）仍需 canary/人工核验；Session 不自动重放。 |

## P-05 IDE 排障靠人指挥

| 项 | 内容 |
| --- | --- |
| 原来 | 没有 CMake/compile_commands/clangd/VS Code/CLion 结构化诊断；LSP 客户端只服务 Agent 工具。 |
| 现在 | `ide_diagnose` 检测多语言项目并收集证据；`ide_verify` 按语言启动对应语言服务器（clangd/pyright/rust-analyzer/gopls/typescript-language-server），可选 Python import、cargo check、go build、tsc；`ide_fix` 做可回滚的最小改动（C++ 配置或 VS Code Python 解释器）。 |
| 代码 | [src/ide/servers.ts](../src/ide/servers.ts)、[src/ide/lsp.ts](../src/ide/lsp.ts)、[src/ide/runtimeCheck.ts](../src/ide/runtimeCheck.ts)、[src/ide/diagnose.ts](../src/ide/diagnose.ts)、[src/ide/fix.ts](../src/ide/fix.ts) |
| 验证 | `npm test` 26/26：clangd 36/74 tokens；真实 rust-analyzer；Python py_compile/import + 解释器修复；通用 LSP 假服务器；全程不打开 IDE。 |
| 限制 | 宿主 IDE 窗口行为不能由后台 LSP 证明；已用 `requiresHostConfirmation` 区分。Java/Kotlin 目前仅检测，未安装对应 server。 |

## P-06 配置改动不可回滚

| 项 | 内容 |
| --- | --- |
| 原来 | 没有改动台账/备份/回滚。 |
| 现在 | DSH `workspace/changes` 自动记录文件改动与 diff；`ide_fix` 写前备份到 `stateDir/backups/`，返回 diff 和可执行 rollback。 |
| 代码 | DSH `workspace-changes`；[src/ide/fix.ts](../src/ide/fix.ts) |
| 验证 | IDE E2E 验证 `.clangd` 备份/替换/恢复；dry-run 不落盘。 |
| 限制 | 不自动回滚；用户/Agent 必须执行返回的命令。 |

## P-07 看不到状态

| 项 | 内容 |
| --- | --- |
| 原来 | 只有工具卡片；没有任务级状态、等待原因、证据、恢复信息。 |
| 现在 | DSH Session UI 展示 turn/tool cards；Goal projection 展示目标 phase/round；workspace changes UI 展示文件改动；浏览器工具返回 URL/title/控件/告警。插件不再提供 `task_status`。 |
| 代码 | DSH Session/Goal UI；[src/tools/browser.ts](../src/tools/browser.ts) |
| 验证 | 源码审计；真实 Web 会话截图/日志 |
| 限制 | 插件不再自建任务侧栏；Goal 的完成认证仍是 core 的空白。 |

## 能力边界（明确不做）

- 不新增宿主机 GUI 自动化；没有 Accessibility / AppleScript 控制路径。
- 不实现隔离 macOS VM（C6/P2）；没有 Guest GUI 驱动。
- 不承诺睡眠/注销/重启后继续执行。
- 不绕过验证码/反机器人；不自动提交支付或服务条款。
- 不把"headless 里 clangd 正常"说成"用户当前 IDE 已修好"。
