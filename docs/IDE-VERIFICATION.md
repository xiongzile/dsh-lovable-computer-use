# 语言无关的 IDE 验证

> 原则：**不打开、不操作、不抢焦点用户的 IDE**。用后台语言服务器和受限的项目检查来验证“语言行为”，而不是用“IDE 看起来正常”当证据。

## 1. 为什么不是 clangd 专用

旧实现把 IDE 验证等同于 clangd/C++，这只覆盖了工作的一小部分。现在 `ide_diagnose` 会先检测项目语言（C/C++、Python、Rust、Go、TypeScript/JavaScript、Java/Kotlin），再按语言选择验证路径。

`ide_verify` 的通用流程：

```text
检测语言/source file
  → 找对应语言服务器（或明确报告没有）
  → 后台 stdio LSP：initialize + didOpen
  → 请求 semanticTokens / completion / hover / documentSymbol / definition
  → 收集 publishDiagnostics / stderr
  → 可选：受限的项目检查（Python import、cargo check、go build、tsc）
  → 输出 verdict + requiresHostConfirmation
```

全程不启动 IDE，不使用 AppleScript/Accessibility，不读取 IDE 窗口。

## 2. 验证等级

| 等级 | 证明什么 | 不证明什么 |
|---|---|---|
| `static_check` | 配置、解释器、扩展、语言服务器存在 | 语言服务器真的能回答 |
| `runtime_verified` | 解释器/编译器能真实编译或 import 项目 | 编辑器的语义高亮/补全正常 |
| `lsp_verified` | 后台语言服务器对真实源文件返回了至少两个独立语言功能 | 用户当前打开的 IDE 窗口已重新索引 |
| `host_confirmed` | 用户在 IDE 中亲眼确认 | 只能由用户回答，工具不能伪造 |

`ide_verify` 永远返回 `requiresHostConfirmation: true`，即使 `lsp_verified`。

## 3. 支持矩阵（本机实测状态）

| 语言 | 语言服务器 adapter | 本机状态 | 运行时检查 |
|---|---|---|---|
| C/C++ | clangd | ✅ 已安装并实测 | 以 clangd 语义探针为主 |
| Python | pyright / basedpyright / pylsp | ✅ pyright 1.1.414 已用临时 venv 实测（58 completions / 1 symbol → `lsp_verified`）；系统 PATH 未安装；Pylance 不作为 headless server 启动 | ✅ `py_compile` + `import <module>` 已实测 |
| Rust | rust-analyzer | ✅ 已安装并实测 | `cargo check`（`runtimeCheck=force`） |
| Go | gopls | ⚠️ 本机未安装 | `go build ./...`（`force`） |
| TypeScript/JS | typescript-language-server | ⚠️ 本机未安装 | `tsc --noEmit`（`force`） |
| Java | jdtls | ❌ 未安装 | 暂无 |
| Kotlin | kotlin-language-server | ❌ 未安装 | 暂无 |

Python 的说明很重要：**Pylance 是 VS Code 内的专有扩展，本实现不会去启动它的内部 bundle**（实测 `server.bundle.js --stdio` 不能完成 initialize）。要获得 Python 的 `lsp_verified`，请安装 `pyright`、`basedpyright` 或 `pylsp`；本次用临时 venv 的 pyright 1.1.414 实测通过（58 completions / 1 symbol，见 [evidence/ide-python-pyright.txt](evidence/ide-python-pyright.txt)），但系统 PATH 未安装。否则 Python 仍可得到 `runtime_verified`，并且会明确标注没有 LSP。

## 4. 工具输出

`ide_verify` 返回：

- `language` / `languageLabel` / `sourceFile`
- `server`：实际使用的语言服务器、路径、版本（找不到时省略）
- `probe`：LSP 的 features、diagnostics、stderr、verdict、detail
- `runtimeCheck`：`passed` / `failed` / `skipped`，命令与输出尾部
- `verdict`：`lsp_verified` / `runtime_verified` / `partial` / `failed`
- `requiresHostConfirmation: true`

`ide_diagnose` 现在输出 `languages` 数组，每个语言包含 markers、source file、可用 server；C++ 专属的 compile_commands/clangd 字段只在检测到 C/C++ 时参与结论。

## 5. 哪些操作会写文件

- `ide_diagnose` / `ide_verify`：只读（语言服务器可能写自己的缓存，但不改项目源码）。
- `ide_fix`：默认 dry-run；`apply=true` 才写，且：
  - C++：重新生成 compile_commands.json，或写 `.clangd`
  - Python：写 `.vscode/settings.json` 的 `python.defaultInterpreterPath`
  - 所有写入都有备份、diff、rollback
  - 不修改运行中的 IDE 状态，不声称宿主 IDE 已修复

## 6. 实测证据

`npm test` 当前 **32/32** 通过，新增：

- 通用 LSP 假服务器：验证非 C++ 协议路径（semantic tokens/completion/hover/symbols/definitions）
- **真实 rust-analyzer** 对一个小 Cargo 项目返回 LSP 功能
- **真实 pyright 1.1.414** 对 Python fixture 返回 58 completions / 1 symbol（临时 venv 手动验证）
- pyright 可执行名回归：优先 `pyright-langserver`，不能误选 `pyright` CLI
- Python `py_compile` + `import main` + VS Code interpreter 修复/备份/回滚
- `ide_verify` 工具级 Rust 路径和 Python 无 LSP 路径
- 原 clangd/CMake/compile_commands 回归

## 7. 边界

- 语言服务器未安装时，不能伪造 `lsp_verified`；只能 `runtime_verified` 或 `failed`。
- Java/Kotlin 目前只做检测；没有 server 和 runtime 适配。
- Python 的 Pylance 不在 headless 路径内；这是有意为之，不依赖专有内部入口。
- `cargo check`/`go build`/`tsc` 可能写构建缓存，默认只在 `runtimeCheck=force` 下运行。
- 无法证明用户已经打开的 IDE 窗口已重新索引；必须 `host_confirmed`。
- 没有启动任何 IDE GUI；如果某个问题只能在 IDE UI 中复现，交给用户确认，而不是自动化桌面。
