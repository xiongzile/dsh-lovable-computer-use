# DSH 源码仓库 + Web 端集成验证

> **历史记录（架构重构前）**：本文部分调用使用了已删除的 `task_*` 工具；最终生命周期由 DSH Session/Goal 负责，见 [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md)。


> 目标：不碰正在运行的 desktop 应用，使用本地 `deepseek-harness` 源码仓库引入本插件，并从**网页端**发一轮真实请求。

## 1. 源码仓库状态与"最新分支"

审计时的本地 checkout：

```text
branch: xiongzile/develop
HEAD:   18f9596cccdb1e870da6e4916b97e859792d964e (2026-09-20)
origin: git@github.com:xiongzile/deepseek-harness.git
origin/master: ddefc45fbc7f8e46dd73185e68295696d1297887
```

`git ls-remote --heads origin` 显示远端只有 `master`，其 tip 是 `ddefc45`；本地 `xiongzile/develop` 的 `18f9596` 是在它之上的提交，且该本地分支没有配置 upstream。因此**没有可拉取的更新分支**；把工作区 reset 到 `origin/master` 反而会后退。验证直接使用这个本地最新 checkout，没有改写用户的 git 状态。

## 2. 独立 profile 与 Web 启动

为避免影响 desktop：

- 使用工作区内的 `DSH_HOME=.dsh-web`（不是 `~/.dsh`）。
- 从源码的默认 `web` 模板生成 `lovable-web` profile。
- 用 overlay 引入本插件（绝对路径指向 `dist/index.js`），并额外加载源码仓库自带的 in-page directory picker overlay，便于自动化选择工作区：

```bash
cd /path/to/deepseek-harness
DSH_HOME=/path/to/dsh-lovable-computer-use/.dsh-web \
  node --import tsx/esm apps/cli/src/bin.ts \
  --profile lovable-web \
  --patch /path/to/dsh-lovable-computer-use/examples/web-overlay.yml \
  --patch apps/web/tests/pin-browse-picker.overlay.yml \
  --port 57364 --no-open
```

输出：

```text
dsh web: http://127.0.0.1:57364/?token=<local-token>
```

插件日志确认加载：

```json
{"level":"info","message":"plugin loaded","data":{"tools":26}}
```

## 3. Web 端真实调用

用独立的 headless Chromium（本插件自身的工具/管理器）打开该 URL，完成：

1. 通过 token 进入；
2. 关闭内测声明 / 跳过 API key 配置；
3. 选择 workspace `deepseek-harness`；
4. 在 Web composer 发送：
   > Call the foreground_app tool once, then reply with only the frontmost bundle id.
5. 页面渲染：

```text
系统提示词 Call the foreground_app tool once...
1 次工具调用 · 1 条消息
思考 I'll call the tool.
工具调用 foreground_app · {}
思考 com.deepseek.dsh
用量 44.2K tok 用时 2秒
```

截图：[evidence/dsh-web-ui.png](evidence/dsh-web-ui.png)
文本：[evidence/dsh-web-ui.txt](evidence/dsh-web-ui.txt)
插件加载日志：[evidence/dsh-web-plugin.log](evidence/dsh-web-plugin.log)

图中同时保留了**第一次**未配置 API key 的 `MISSING_CREDENTIAL` 轮次（Web UI 自己的错误面板）和**第二次**成功的工具调用轮次，说明这是真实页面状态，不是合成截图。

## 4. Desktop 不受影响

- 验证过程中未写入 `~/.dsh/profiles/desktop/`，未修改 desktop 的 `package.json`/`cordis.patch.yml`。
- 验证结束时 desktop GUI 仍可访问：`http://127.0.0.1:50126/` 返回 401（需要其自身的本地认证），进程仍在运行。
- 源码 Web 使用独立端口 `57364` 与独立 `DSH_HOME`，与 desktop 的 `50126` 互不干扰。

## 5. 停止与清理

当前会话中源码 Web 以一个受管理的后台 job 运行；需要停止时：

```bash
# 在 DSH 会话里
job_kill <job-id>

# 或按端口找到进程（只杀源码 Web，不要动 desktop）
lsof -nP -iTCP:57364 -sTCP:LISTEN
```

临时 credential 副本位于 `.dsh-web/.credentials.yaml`（仅本机、已 0600、已被 `.gitignore` 忽略）。如果不再使用源码 Web，删除整个 `.dsh-web/` 即可；desktop 的数据在 `~/.dsh`，不受影响。

## 6. 后续真实任务

- 登录态跨进程复用验收：[WEB-AGENT-LOGIN-PERSISTENCE.md](WEB-AGENT-LOGIN-PERSISTENCE.md)

网页端 Agent 后续完成了一个真实开发环境任务（vLLM macOS CPU + VS Code）：[WEB-AGENT-VLLM-TASK.md](WEB-AGENT-VLLM-TASK.md)。

## 7. 复现

见 [examples/web-overlay.yml](../examples/web-overlay.yml) 与 [README](../README.md)。
需要先在 Web 的 Models 页面配置 API key（或启动时导出 `DEEPSEEK_API_KEY`）；本验证为了复现，临时复制了本机已有 credentials 到独立 `DSH_HOME`。
