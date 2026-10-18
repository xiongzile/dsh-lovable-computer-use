# 网页端 Agent 真实任务：vLLM macOS CPU 开发环境 + VS Code

> **历史记录（架构重构前）**：本文使用的 `task_*` 工具已全部删除。最终实现由 DSH Session/turn、tool trace、workspace changes、Goal 与 session repair 负责；本插件的结论仅保留浏览器/IDE/登录持久化部分的证据。见 [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md)。


> 任务：在 `~/Workspace/github` 下拉取 vLLM、配置 macOS Apple Silicon CPU 开发环境、写入 VS Code 解释器配置并在 VS Code 打开。
> 执行者：**源码 DSH 的网页端 Agent**（`dsh web` + 本插件），不是 desktop 应用，也不是我替它执行。
> 结果：`completed`。Task ID `task-2026-10-18T17-53-14-329Z-730929`。

## 1. 网页端怎么用上我们的能力

Source checkout 用独立 `DSH_HOME`、独立 `lovable-web` profile 启动，插件通过 overlay 引入；工作区选为 `~/Workspace/github`，这样 vLLM 和所有安装产物都在 agent 的写入范围内。

发送给网页端 Agent 的任务（节选）：

```text
请在后台完成一个真实的开发环境任务，使用你的工具，不要只给方案：
1. 在 /Users/bytedance/Workspace/github 下拉取 vllm
2. 用 Python 3.11 + uv 创建 .venv；uv pip install -r requirements/cpu.txt；
   VLLM_TARGET_DEVICE=cpu uv pip install -e .
3. 验证 import vllm、vllm --help，并做 CPU 小模型 smoke
4. 写 .vscode/settings.json，python.defaultInterpreterPath=.venv/bin/python
5. 用 code 打开项目
6. 用 task_* 记录证据并完成
```

Agent 实际调用的插件工具（完整参数/结果见 [evidence/vllm-task-tools.json](evidence/vllm-task-tools.json)）：

| 工具 | 次数/结果 |
| --- | --- |
| `task_status` | 读取重启后遗留任务的 `recovering` 状态 |
| `task_recover` | 先无参数调用命中一个 JSON 输出 bug；改带 `taskId` + `action=abandon` 成功放弃旧任务 |
| `task_start` | 新任务 `task-2026-10-18T17-53-14-329Z-730929` |
| `task_change` | 5 条：clone、venv/editable install、VS Code settings、smoke 脚本、workspace 内缓存 |
| `task_evidence` | 6 条 runtime/static 证据：commit、安装、import/CLI、CPU 生成、VS Code settings、VS Code 窗口/解释器 |
| `task_finish` | `completed` + limitations |

这正是我们插件的核心价值：**任务状态、恢复、改动清单、证据门槛**。它没有用浏览器/焦点/接管工具，因为这个任务是 shell + Python + VS Code，不是网页注册或 GUI 排障。

### 恢复能力实际发生了什么

第一次网页端任务（`task-...e199e2`）因为 source web 进程继承了旧的父 sandbox，`git clone` 被 `Operation not permitted` 拒绝；宿主重启后，插件把旧任务自动标成：

```json
{
  "status": "recovering",
  "recovery": { "previousStatus": "running", "note": "The owning process disappeared..." }
}
```

网页端 Agent 没有盲目重跑，而是先 `task_status`、确认没有 `vllm` 目录、再用 `task_recover(action=abandon)` 放弃旧任务，然后 `task_start` 新任务。这是 C4/P-04 的真实使用，不是单测模拟。

### 用出来的 bug

无参数 `task_recover` 把 `undefined` 可选字段写进输出，触发 DSH 的 lossless JSON 校验：

```text
Error: tool "task_recover" returned invalid output: value is not lossless JSON
```

Agent 自己用带 `taskId` 的调用绕过了。我们已修复输出构造并加了回归测试（`task_recover without arguments returns lossless JSON...`），当前 **32/32** 测试通过。

## 2. 怎么验证的

网页端 Agent 记录的 6 条证据（结构化见 [evidence/vllm-task.json](evidence/vllm-task.json)）：

| 验证 | 实际结果 |
| --- | --- |
| clone | `ff01a6b14f329ccd4162fce309913542e2abcd5b`，浅克隆 |
| Python | `.venv/bin/python` = **Python 3.11.15** |
| 安装 | `vllm==0.1.dev1+gff01a6b14.cpu`（editable，`--no-build-isolation`） |
| import | `0.1.dev1+gff01a6b14` |
| CLI | `vllm --help` exit 0，13 秒，包含 `chat/complete/serve/bench/...` |
| 编译产物 | `_C.abi3.so`、`spinloop.abi3.so`、`fs_io_C.abi3.so` |
| CPU 生成 | OPT-125M float32：load 24.0s，两个 prompt 均生成文本，总 24.5s |
| VS Code settings | `python.defaultInterpreterPath=${workspaceFolder}/.venv/bin/python` |
| VS Code 窗口 | `workspace.json` = `file:///Users/bytedance/Workspace/github/vllm` |
| 解释器选择 | Python 扩展日志：`Active interpreter [/Users/bytedance/Workspace/github/vllm]: .../.venv/bin/python` |

独立复核（只读）：[evidence/vllm-versions.txt](evidence/vllm-versions.txt)。

## 3. 现在可用的 VS Code 开发环境

```
/Users/bytedance/Workspace/github/vllm
├── .venv/                     Python 3.11.15，vLLM CPU editable build
├── .vscode/settings.json      解释器指向 .venv/bin/python
└── vllm/                      源码 + 编译好的 .so
/Users/bytedance/Workspace/github/vllm-smoke/run_cpu_smoke.py
```

VS Code 已打开该文件夹，Python 扩展已选中 `.venv/bin/python`。日常使用：

```bash
cd /Users/bytedance/Workspace/github/vllm
source .venv/bin/activate
python -c "import vllm; print(vllm.__version__)"
vllm --help
code .        # 或 open -a "Visual Studio Code" .
```

CPU smoke（必须带 workspace 内缓存，避免 ~/.cache 写权限问题）：

```bash
cd /Users/bytedance/Workspace/github/vllm
HF_HOME=/Users/bytedance/Workspace/github/.hf-cache \
VLLM_CACHE_ROOT=/Users/bytedance/Workspace/github/.vllm-cache \
VLLM_TARGET_DEVICE=cpu \
.venv/bin/python ../vllm-smoke/run_cpu_smoke.py
```

## 4. 限制（重要）

- **macOS Apple Silicon 的 vLLM CPU 是上游 experimental 支持**，没有预编译 wheel；本次是源码 editable 构建。
- 只有 FP32/FP16；没有 GPU 加速。要 GPU 请用 Linux/CUDA，或评估社区的 [vllm-metal](https://github.com/vllm-project/vllm-metal)（MLX/Metal 后端）。
- 没有 Triton，`Model Runner V2` 不可用，自动退回 V1 runner；CPU 生成速度有限（本次 OPT-125M 约 91 tok/s，首 token/加载约 24s）。
- `vllm --help` 首次约 13 秒（torch import）。
- CPU 内存参数需要手动压低：示例用 `gpu_memory_utilization=0.2`（默认 0.92 超过当时 17.86 GiB 可用内存）。
- macOS 多进程需要 `if __name__ == "__main__":` 保护。
- 缓存必须放 workspace（`UV_CACHE_DIR`、`HF_HOME`、`VLLM_CACHE_ROOT`），否则 DSH sandbox 可能拒绝 `~/.cache` 写入。
- 这是 **浅克隆（`--depth 1`）**，没有完整 git 历史；需要贡献/切分支时执行 `git fetch --unshallow`。
- `code` CLI 在当前环境返回 0 但 IPC 没有真正开窗；Agent 改用 `open -a "Visual Studio Code"` 打开，验证来自 VS Code 自身 workspace/Python 日志，不是 GUI 截图；没有做宿主机 GUI 自动化。
- 网页端 Agent 的 `task_finish` 已写 `completed`，但任务 `phase` 仍保留 `recon`（不影响状态/证据；是任务元数据的小瑕疵）。

## 5. 证据索引

- [vllm-task.json](evidence/vllm-task.json)：完整任务记录（6 evidence / 5 changes / result / limitations）
- [vllm-task-tools.json](evidence/vllm-task-tools.json)：16 次 `task_*` 工具调用的参数与结果
- [vllm-task-cancelled.json](evidence/vllm-task-cancelled.json)：被恢复逻辑放弃的旧任务
- [vllm-vscode-settings.json](evidence/vllm-vscode-settings.json)：VS Code 配置
- [run_cpu_smoke.py](evidence/run_cpu_smoke.py)：可复现 CPU smoke
- [vllm-versions.txt](evidence/vllm-versions.txt)：独立复核输出
