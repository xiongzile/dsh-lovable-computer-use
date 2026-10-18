# dsh-lovable-computer-use

给 DeepSeek Harness 增加“后台执行、不打扰前台、可人工接管、结果可验证”的电脑使用能力。它不是又一套任务框架：**生命周期、持久化、轨迹、修改记录、恢复都交给 DSH 已有的 Session / Goal / Workspace Changes / Repair 机制**，插件只提供真正需要 Agent 决策的工具。

- **隔离后台浏览器**：每个站点/账号一个独立 Chromium user-data 目录，默认 headless；不使用用户的 Chrome，不打开窗口，不发送宿主机鼠标/键盘事件。Cookie、登录态、下载文件留在 profile 内，跨调用/重启保留。
- **人工接管**：邮箱验证、MFA、扫码、验证码时，先通过 DSH 问题 UI 征得同意，再打开**独立的**可见 Chrome 窗口；用户完成后关闭窗口、保留登录态、回到 headless。不同意就不开窗。
- **语言无关的 IDE 验证**：`ide_diagnose` 检测 C/C++、Python、Rust、Go、TypeScript/JavaScript、Java/Kotlin；`ide_verify` 后台启动对应语言服务器，并可选跑 Python import、cargo check、go build、tsc；`ide_fix` 只做最小、可回滚的修改。全程不打开、不操作 IDE。
- **前台抢占证据**：`focus_guard` 采样当前前台应用和鼠标位置，用真实数据说明后台任务有没有抢焦点。
- **通知**：`notify_user` 发 macOS 通知，不激活应用。

> 本仓库是独立 DSH 插件包，不修改 DSH 源码；运行时零 npm 依赖。

## 生命周期与证据：不重复实现

DSH 已经提供这些能力，插件不再注册任何 `task_*` 工具：

| 需求 | 由谁负责 |
|---|---|
| Run/Turn 生命周期 | `turn/start`、`step/start`、`turn/end` |
| 工具调用轨迹 | `tool/call`、`tool/result`（参数、结果、错误、中断） |
| 文件修改记录 | `workspace/changes`（turn 结束自动 diff/文件列表） |
| 持久化 / Checkpoint | Session log、projection cache、checkpoint policy |
| 崩溃恢复 | `session/repair`（补齐中断 turn/step；未完成 tool call 标记 outcome unknown） |
| 长目标 | Goal domain（`active/paused/blocked/complete`、round cap、跨 turn 持久化） |
| 后台长工作 | Jobs（owner-scoped；进程内实现） |
| 人工决策 | `ask_user_question` + approval seam |
| 审计展示 | Session UI、tool cards、goal projection、workspace changes UI |

因此：

- **执行结束**是 DSH 的 `turn/end`，不是模型宣告。
- **工具结果本身就是证据**；不需要 `task_evidence` 再抄一遍。
- **文件改动自动记录**；不需要 `task_change`。
- **中断恢复由 `session/repair` 负责**；不需要 `task_recover`。
- **清理由 Session retention / browser close / idle close 负责**；不需要 `task_prune`。
- **人工接管**用 `ask_user_question`（非浏览器）或 `background_browser_handoff`（浏览器可见窗口）。

这一决策、9 个旧工具的逐项评估和实测 token 成本见 [docs/ARCHITECTURE-REVIEW.md](docs/ARCHITECTURE-REVIEW.md)。

### 一个诚实的空白

DSH Goal 的 `complete` 仍是 caller-authoritative：官方文档明确没有独立 evaluator。插件不再提供 `task_finish`，所以**本插件不会把“我完成了”写成一个成功状态**；但也不能代替 DSH core 做 goal 级认证。确定性验证（`ide_verify`、浏览器 canary、项目命令）只产生证据，最终 goal 完成/认证需要用户或 core policy。

## 现在能多做什么（真实运行结果）

在真实 DSH headless profile 中，浏览器工具完成了本地受控站点的多页注册：

```
final URL:  http://127.0.0.1:54201/dashboard
account status:     verified
configuration:      configured
sandbox:            disabled-fallback（宿主 sandbox 阻止 Chromium 自身 sandbox，已显式降级并告警）
screenshot:         docs/evidence/dsh-e2e-dashboard.png
```

- 会话/工具调用：[docs/evidence/dsh-e2e.log](docs/evidence/dsh-e2e.log)
- 焦点证据：[docs/evidence/a01-result.json](docs/evidence/a01-result.json)（10 次采样，0 次前台切换，鼠标 0px）
- Web 端真实调用：[docs/evidence/dsh-web-ui.png](docs/evidence/dsh-web-ui.png)
- 旧构建的历史任务记录：[docs/evidence/dsh-e2e-task.json](docs/evidence/dsh-e2e-task.json)（仅作历史证据；`task_*` 已删除）

其他真实任务（均标注为重构前历史）：

- [vLLM macOS CPU + VS Code](docs/WEB-AGENT-VLLM-TASK.md)
- [GitHub 登录态跨 web 进程复用](docs/WEB-AGENT-LOGIN-PERSISTENCE.md)（测试 issue #2 已删除）

## 安装

### 方式 A：手动安装到当前 DSH profile

> Desktop 应用有自己的 profile 与包管理流程；官方支持路径是 **Plugins 页面 / `plugin_manager` 的 bundle 安装**。下面的脚本是手动兜底：请先退出 DeepSeek Harness，再执行。

```bash
cd /path/to/dsh-lovable-computer-use
npm install && npm run build
node scripts/install-profile.mjs --profile desktop --no-install
cd "${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
pnpm install
# 重新打开 DeepSeek Harness
```

`scripts/install-profile.mjs` 只修改该 profile 的 `package.json` 与 `cordis.patch.yml`，并先备份到 `<profile>/.backups/<时间戳>-lovable-install/`；不修改 desktop 应用包。

安装后新会话会出现以下 17 个工具：

```text
background_browser_* (11)  ide_* (3)  foreground_app/focus_guard (2)  notify_user (1)
```

### 方式 B：源码 Web profile

```bash
DSH_HOME=/path/to/.dsh-web \
  node --import tsx/esm apps/cli/src/bin.ts \
  --profile lovable-web \
  --patch /path/to/dsh-lovable-computer-use/examples/web-overlay.yml \
  --port 57364 --no-open
```

## 工具

### 隔离浏览器

| 工具 | 作用 |
| --- | --- |
| `background_browser_open` | 打开/导航一个 profile；返回页面文本、对话框、告警和带 ref 的控件 |
| `background_browser_snapshot` | 重新观察当前页面 |
| `background_browser_act` | `click` / `type` / `select` / `scroll`，只接受最新 snapshot 的 ref |
| `background_browser_press` | Enter/Tab/Escape/方向键等，通过 CDP 发给页面，不碰宿主机键盘 |
| `background_browser_wait` | 等待选择器或可见文本，超时返回 `found:false` |
| `background_browser_eval` | 页面内 JS 校验（如读取状态元素） |
| `background_browser_screenshot` | 保存 PNG 到 `stateDir/artifacts/<profile>/` |
| `background_browser_downloads` | 列出 profile 内下载文件 |
| `background_browser_list` | 列出 profile、锁状态、登录态、下载数、进程占用 |
| `background_browser_handoff` | 唯一允许打开可见窗口的路径：同意 → 独立窗口 → 等待完成 → 回到 headless |
| `background_browser_close` | 关闭并保留登录态；`reset=true` + `confirm=true` 才会删除 profile |

### IDE / 语言验证

| 工具 | 作用 |
| --- | --- |
| `ide_diagnose` | 只读诊断：项目语言；C/C++ 编译数据库/CMake/`.clangd`；Python 解释器/VS Code 扩展；Rust/Go/TS 语言服务器；JetBrains/VS Code 工程与日志 |
| `ide_verify` | 后台启动对应语言服务器，返回 semantic tokens、补全、hover、符号、定义、诊断；可选 `py_compile`/import、`cargo check`、`go build`、`tsc`；verdict 为 `lsp_verified/runtime_verified/partial/failed` |
| `ide_fix` | 默认 dry-run；可重新生成 compile_commands.json、写 `.clangd`，或写 `.vscode/settings.json` 的 Python 解释器；写前备份，返回 diff 与回滚命令 |

支持矩阵与“为什么不启动 IDE”：[docs/IDE-VERIFICATION.md](docs/IDE-VERIFICATION.md)。

### 焦点与通知

| 工具 | 作用 |
| --- | --- |
| `focus_guard` | `start/status/stop`：采样前台应用 + 鼠标位置，返回 `no-interruption` / `focus-changed` / `unsupported` |
| `foreground_app` | 单次读取前台应用与鼠标位置（无需 Accessibility） |
| `notify_user` | `osascript display notification`，不激活应用、不抢焦点 |

## 典型用法

### 1. 后台注册并在需要时叫人

```text
用户：在后台注册一个测试开发者账号，完成基础配置；需要邮箱验证时再提醒我。

Agent：
background_browser_open(profile="platform-test-account", url=...)
→ 填写、提交 → 页面提示查收邮件
→ background_browser_handoff(profile=..., reason=..., instructions=...)
   （先问用户是否开窗；同意后开独立窗口；用户完成；关闭窗口恢复 headless）
→ background_browser_eval 读取账号状态 / 调健康检查
→ background_browser_close
```

没有 `task_start` / `task_evidence` / `task_finish`：Session log 自动记录 turn、tool/call、tool/result，workspace changes 自动记录文件改动。

### 2. 不打扰前台的验收

```text
foreground_app / focus_guard start(label="headless registration")
... 执行 background_browser_* ...
focus_guard stop
# 期望 verdict=no-interruption，transitions=[]，pointer.movedPx=0
```

`scripts/acceptance-browser.mjs` 会生成这份证据。

### 3. IDE 语言验证（不打开 IDE）

```text
C/C++:  ide_diagnose → ide_fix(.clangd) → ide_verify → clangd semantic tokens → lsp_verified
Python: ide_verify(language=python, module=vllm) → py_compile + import vllm → runtime_verified
Rust:   ide_verify(language=rust, runtimeCheck=force) → rust-analyzer + cargo check
Go/TS:  ide_verify(language=go|typescript, runtimeCheck=force) → gopls/ts server + build/tsc（如安装）
```

`lsp_verified` 只证明后台语言服务器对真实源文件返回了语义功能，**不证明用户当前打开的 IDE 窗口已经重新索引/切换解释器**。后者只能由用户确认，工具结果始终带 `requiresHostConfirmation=true`。

## 安全模型与边界

- **不碰宿主机 GUI**：源码里没有 `System Events`、`CGEventPost`、`AXUIElement`、`cliclick`、`pyautogui`。唯一的可见窗口是 `background_browser_handoff`，且必须先通过 DSH 的 `userQuestions` 征得同意。没有提问通道时直接拒绝。
- **不使用日常 Chrome profile**：每次启动都指定独立的 `--user-data-dir`；`background_browser_open` 没有 headed 参数。
- **页面内容是不可信输入**：工具只返回文本/控件，不执行页面里的指令；文件下载留在 profile 的 `downloads/`，不进 `~/Downloads`。
- **密钥**：不要把密码/API Key 写进 prompt 或日志；凭据应走本地凭据机制。
- **回滚**：IDE 修改在 `stateDir/backups/` 留备份；`ide_fix` 返回 `rollback`。浏览器 profile 删除需要 `reset=true` + `confirm=true`。
- **写入范围**：`ide_fix(apply=true)` 默认只允许写 session workspace 内；跨项目需要显式配置 `allowOutsideWorkspaceWrites=true`（或先 `apply=false` 查看）。
- **CMake 执行**：`ide_fix(finding=compile-commands, apply=true)` 会运行项目自己的 CMake 脚本；只在可信项目上应用，并先 dry-run。
- **高风险网页操作**：付款、发布、删除、接受条款没有语义级硬拦截；依赖 DSH approval/权限策略和用户确认。
- **Chromium sandbox 降级**：`chromeSandbox=auto` 在宿主阻止 Chromium sandbox 时重试 `--no-sandbox` 并显式告警；`required` 可禁止降级。

## 已知限制

- 只支持 Chromium 家族浏览器（Chrome/Chromium/Edge），不支持 Firefox/WebKit。
- 只跟踪单页；`target=_blank` 会改成当前页；不支持文件上传。
- `background_browser_handoff` 的**可见窗口完成路径**未在自动化测试中执行（会真实抢焦点）；拒绝路径、无提问通道路径已测试。
- 如果 DSH 宿主在人工接管期间崩溃，可见 Chrome 窗口可能残留；正常 dispose 会尝试终止子进程。
- DSH 桌面 UI 关闭后的持续执行依赖后端进程仍在运行；本仓库没有 daemon 化。
- `workspace/changes` 覆盖工作区文件，不覆盖浏览器外部副作用（例如创建 GitHub issue）；外部动作靠 tool/result + 后续 canary 核验。
- DSH Goal 没有独立 evaluator；插件不伪造 goal 成功状态，见 [ARCHITECTURE-REVIEW.md](docs/ARCHITECTURE-REVIEW.md)。
- no-sandbox 降级降低浏览器隔离强度；生产环境应尽量修复宿主 sandbox 或使用 `chromeSandbox=required`。
- 未实现隔离 macOS VM / Guest GUI。宿主机 GUI 自动化被明确禁止。

## 开发与测试

```bash
npm install
npm run typecheck
npm test            # 26 个 node:test：单元 + 真实 Chromium E2E + 真实 clangd/rust-analyzer E2E
node scripts/acceptance-browser.mjs   # 生成 docs/evidence/a01-*.{json,png}
```

- 真实浏览器测试使用受控本地站点 `tests/fixtures/site/server.mjs`，不访问真实平台。
- 测试环境通过 `config.chromeSandbox='disabled'` 避免依赖宿主 sandbox；生产默认 `auto`。
- `npm test` 需要 macOS + Google Chrome/Chromium；clangd/rust-analyzer 缺失时相关测试 skip。
