# Step 0 — Baseline 与源码审计

> 审计对象：本机 `~/Workspace/github/deepseek-harness`（DSH `0.1.6-alpha.2`，commit `18f9596ccc`），以及正在运行的 desktop 应用（runtime payload `0.2.1-rc.2`，Node `24.21.0`）。
> 目的：区分"已有能力""配置缺口""产品缺口""代码缺陷""平台限制"，避免把未验证的东西当成需求实现。

## 1. 真实入口与生命周期

| 能力 | 真实代码/文档 | 审计结论 |
| --- | --- | --- |
| 插件组合 | `apps/cli/src/bin.ts` + `packages/boot/app-boot`；profile = 有序 bundle patch + 用户 `cordis.patch.yml` + `--patch` overlay | 插件通过 Cordis 行插入；`dsh --profile <name> --patch <file>` 可在源码 checkout 中启动自定义组合。本仓库用它做了真实 DSH E2E。 |
| 工具注册 | `packages/core/tools/src/index.ts` `ToolRuntime.register()` | 需要 `output { schema, render }`，输出 schema 必须在受支持子集内；没有 shell 要求。本插件直接注册 26 个工具。 |
| 人工交互 | `packages/interaction/user-questions` + `tool-ask-user` | 有 `ctx.userQuestions.ask()`，可按 Agent scope 暂停工具调用并等待用户回答；但没有"任务进入 waiting、保留状态、之后继续"的任务语义。 |
| Session 持久化 | `packages/session`、`session-persistence-jsonl` | 会话日志可恢复；浏览器/Chrome profile/页面状态不在日志中，恢复会话不会恢复浏览器。 |
| 后台 Job | `packages/jobs/jobs` | `ctx.jobs` 管理 running/stopping/completed/killed/failed，owner 是 live Agent；Agent dispose 会取消并等待 job。没有任务目标、验证证据、外部副作用幂等/恢复语义。 |
| LSP | `packages/lsp/*`、`packages/tool/tool-lsp` | 给 Agent 提供 LSP 工具；没有面向用户的 IDE 配置诊断，也没有 clangd 语义高亮/补全的独立探针。 |

## 2. Browser Use 的真实能力与边界

文档与代码事实：

- `docs/subsystems/browser-use.md`：共享服务**只注册一个 provider 名字**，没有统一的浏览器操作 API、没有浏览器资源、没有模型可控的 selector。
- 同一文档：启动的浏览器属于**一个 live Agent + Session**；销毁 Session runtime 会关闭它；reload/fork 后是全新的浏览器状态；**"Browser profiles and login state are not restored from the Session log."**
- `packages/experimental/browser-use-playwright-mcp/src/index.ts`：启动参数包含 `--isolated`；headless 默认 true；配置只有 `mode/headless/executablePath/endpoint/toolCallTimeoutMs`，没有跨任务的 profile 选择、账号隔离、锁、接管或下载目录。
- `packages/experimental/browser-use-chrome-devtools-mcp`：同样 `--isolated`。
- `packages/experimental/browser-use-stagehand-native`：有 `launch`/`attach`，但没有面向用户的 profile 生命周期与人工接管。
- 这些 provider 都是 **experimental public packages**，desktop/base bundle 默认不挂载（`packages/bundle/base/cordis.patch.yml` 中没有 browser-use/computer-use 行），需要显式组合。

实测（Baseline）：

```text
# 在真实 DSH headless session 中挂载 browser-use + playwright-mcp
# 输入：打开 http://127.0.0.1:54201/ 并报告标题
Error: async initializeServer: EPERM: operation not permitted,
open '/Users/bytedance/Library/Caches/ms-playwright/b/browser@...'
```

在 workspace-write 文件策略下，Playwright MCP 的浏览器缓存位于 `~/Library/Caches/ms-playwright`，MCP server 初始化即被拒绝；页面根本没有加载。该失败是**配置/环境缺口**，不是页面问题。完整证据：[evidence/baseline-playwright-mcp.log](evidence/baseline-playwright-mcp.log)。

这个 baseline 说明：现有 Browser Use 不是"装上就能在受限 profile 里后台跑"的能力，而且即使跑起来也不提供 per-site/account profile、人工接管、任务证据或焦点抢占测量。

## 3. Computer Use 的真实边界

- `docs/subsystems/computer-use.md`：共享服务同样只注册一个 provider；**"One registered provider does not reserve a desktop for a Session."**
- 两个 Cua Driver provider（MCP / native）操作的是**宿主机桌面**，没有隔离图形环境、没有"是否允许接管宿主机"的统一 consent gate。是否安全完全取决于调用方。
- 默认组合不挂载；一旦挂载，模型可以通过上游工具直接观察/操作宿主机桌面。

因此本仓库**不新增宿主机 GUI 路径**，只提供"被明确同意的、独立 Chromium 窗口"这一种可见接管。

## 4. Jobs / 任务可靠性

`ctx.jobs` 的 `JobStatus` 是 `running | stopping | completed | killed | failed`，粒度是"进程/生产者的生命周期"，不是"用户任务"：

- 没有 `waiting_for_user`、`verifying`、`partial`、`recovering`。
- Job owner 是 live Agent；Agent 被 dispose 时会取消并等待 job。因此"关掉前端/会话结束后任务继续"不是现成保证。
- 没有验证证据、改动清单、回滚路径或外部副作用重放检查。

## 5. 痛点到分类

| 痛点 | 审计分类 | 依据 | 本仓库的处理 |
| --- | --- | --- | --- |
| P-01 抢焦点/抢鼠标/弹窗 | `configuration_gap` + `product_gap` | 现有 provider 可 headless，但没有隔离 profile/焦点证据；Playwright cache 在 sandbox 下直接失败 | 独立 headless Chromium + per-profile 目录 + `focus_guard` 真实采样 |
| P-02 人工验证卡死 | `product_gap` | 有 `ask_user_question`，但没有 profile 绑定的可见窗口/通知 | `background_browser_handoff` + macOS 通知；非浏览器决策用 core `ask_user_question` |
| P-03 假称修好 | `product_gap` | 没有独立验证；模型输出即结论 | Session tool/result 自动记录 + `ide_verify` 等确定性验证；插件不提供自证成功的 `task_finish` |
| P-04 崩溃丢任务/重复副作用 | `product_gap` | Session 可恢复对话，但浏览器状态和"上次做到哪"不可恢复；Jobs 无幂等语义 | DSH `session/repair` + tool/result outcome unknown 警告；插件不自动重放 |
| P-05 IDE 排障靠人指挥 | `product_gap` | 没有 CMake/compile_commands/clangd/IDE 配置诊断工具 | `ide_diagnose` + 多语言 LSP/运行时探针 + 最小修复 |
| P-06 配置改动不可回滚 | `product_gap` | 没有面向用户改动的 backup/diff/rollback 台账 | DSH `workspace/changes` + `ide_fix` 备份/diff/rollback |
| P-07 看不到状态/卡点 | `product_gap` | Session 有工具卡片，但没有任务级状态、等待原因、证据列表 | DSH Session UI + Goal projection + workspace changes UI |

### 补充分类

- **already_supported**：会话日志、工具审批/沙箱、用户提问、LSP 客户端、Job 生命周期、profile 组合机制。
- **configuration_gap**：Playwright MCP 的浏览器缓存在 workspace-write 下不可读；现有 provider 默认不挂载；headless 参数默认已开。
- **product_gap**：验证证据、人工接管、profile 隔离、焦点证据、IDE 诊断、副作用恢复；**生命周期/台账不再作为插件缺口**。
- **code_bug**：本轮未发现 DSH 现有 browser-use/computer-use 代码缺陷；没有把它们的行为问题当作 bug。
- **platform_limitation**：宿主 sandbox 会阻止 Chromium 自身 sandbox（已实测）；macOS 屏幕锁定/睡眠/注销后的持续执行没有承诺；本仓库未实现隔离 VM。

## 6. Baseline 实测记录

| 测试 | 结果 | 证据 |
| --- | --- | --- |
| 源码 checkout 启动 `dsh --help` | PASS | 本地命令输出 |
| 新建自定义 `lovable` profile 并 `--dump-config` | PASS | 自定义 overlay 行出现在组合尾部 |
| 真实 DSH headless 会话调用 `foreground_app` | PASS | 本仓库插件；返回 frontmost `Ghostty (com.mitchellh.ghostty, pid 74995)` |
| 真实 DSH headless 会话使用现有 Playwright MCP 打开本地站点 | FAIL（环境/配置） | `docs/evidence/baseline-playwright-mcp.log` |
| 现有 Browser Use 提供跨任务 profile / 人工接管 / 焦点证据 | 不存在（源码事实） | `docs/subsystems/browser-use.md`、provider 源码 |
| 现有 Computer Use 隔离宿主机桌面 | 不存在（源码事实） | `docs/subsystems/computer-use.md` |

> 没有声称"原版 S1–S4 全部跑过"：原版 browser-use 在上述受限环境中无法启动，S1/S2 的 baseline 因此只能以源码事实 + 单点启动失败记录。改造后的 S1 已用真实 DSH 会话跑通（见 `docs/ACCEPTANCE.md`）。
