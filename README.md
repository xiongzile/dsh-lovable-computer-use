# dsh-lovable-computer-use

A macOS DeepSeek Harness plugin for background browser work and language-agnostic IDE verification.

## What it adds

- **Isolated Chromium profiles.** Each site/account gets its own `--user-data-dir`, process, cookies, and downloads. Browsers run headless by default; the user's Chrome profile is never used.
- **Persistent logins.** A profile can be logged in once and reused across calls and DSH restarts. Separate profiles keep unrelated accounts isolated.
- **Human handoff when needed.** For MFA, email verification, QR scans, or CAPTCHAs, the agent asks first, opens a separate visible Chrome window, waits for the user, then returns to headless on the same profile.
- **Browser interaction tools.** Open/navigate, snapshot the page with tagged controls, click/type/select/scroll, press keys, wait for text, evaluate page state, capture screenshots, inspect downloads, and list profiles.
- **Language-agnostic IDE verification.** Detect C/C++, Python, Rust, Go, TypeScript/JavaScript, Java, and Kotlin projects; start the matching language server in the background; request semantic tokens, completions, hover, symbols, definitions, and diagnostics; optionally run `py_compile`/import, `cargo check`, `go build`, or `tsc --noEmit`.
- **Minimal, reversible IDE fixes.** Regenerate `compile_commands.json`, write a `.clangd` database entry, or set the VS Code Python interpreter. Dry-run by default; every write has a backup, diff, and rollback command.
- **Interruption evidence.** Sample the foreground app and pointer position to show whether a background task actually stayed out of the user's way.
- **Non-activating notifications.** Deliver macOS notifications without bringing an app to the foreground.

Lifecycle, tool traces, workspace change history, and crash recovery are supplied by DSH's Session, Goal, workspace-changes, and session-repair layers.

## Why it is useful

- Web automation can run without opening a window or touching the user's Chrome. The agent can work while the user continues using the machine.
- A login is a one-time cost. Persistent profiles make recurring GitHub, internal-platform, or web-app tasks practical, while per-account directories prevent cookie mixing.
- The visible-window path exists only for steps that genuinely need a human. Normal runs stay headless.
- IDE checks use real language servers and real project commands instead of static config inspection. The user's currently open IDE window is still reported as requiring host confirmation.
- Focus data turns "it should not disturb you" into a measured result.

## Tools

### Browser (11)

| Tool | Purpose |
| --- | --- |
| `background_browser_open` | Open or navigate a profile; return page text, alerts, and tagged controls. |
| `background_browser_snapshot` | Re-read the current page. |
| `background_browser_act` | Click, type, select, or scroll using refs from the latest snapshot. |
| `background_browser_press` | Send Enter, Tab, Escape, or arrow keys to the page. |
| `background_browser_wait` | Wait for a selector or visible text. |
| `background_browser_eval` | Evaluate JavaScript in the page for state checks. |
| `background_browser_screenshot` | Save a page PNG under the plugin artifact directory. |
| `background_browser_downloads` | List files downloaded by the profile. |
| `background_browser_list` | List profiles, locks, login state, downloads, and process use. |
| `background_browser_handoff` | Ask the user, open an isolated visible window, then resume headless. |
| `background_browser_close` | Close a profile, keeping login state; `reset=true` plus `confirm=true` deletes it. |

### IDE (3)

| Tool | Purpose |
| --- | --- |
| `ide_diagnose` | Detect project languages and report interpreters, extensions, language servers, compilation databases, CMake, and `.clangd` state. |
| `ide_verify` | Run the matching language server in the background and optionally a bounded project check. |
| `ide_fix` | Apply one dry-run-first, backed-up, reversible IDE configuration fix. |

### Focus and notifications (3)

| Tool | Purpose |
| --- | --- |
| `foreground_app` | Read the foreground app and pointer position once. |
| `focus_guard` | Start, inspect, or stop foreground-interruption sampling. |
| `notify_user` | Post a macOS notification without activating an app. |

## Requirements

- macOS.
- Google Chrome or Chromium for the isolated browser.
- Optional language servers for IDE verification: `clangd`, `pyright`/`basedpyright`/`pylsp`, `rust-analyzer`, `gopls`, or `typescript-language-server`. When a server is absent, `ide_verify` reports it and can still run a Python runtime check.

## Safety

- Isolated browser profiles only; never the user's Chrome profile.
- Headless by default; the visible window is opened only through `background_browser_handoff` after the user agrees.
- No AppleScript, Accessibility, or host GUI input synthesis.
- Page text and downloaded files are untrusted data.
- IDE fixes are dry-run first, workspace-bound by default, and return a rollback command.

## Verification

- 26 automated tests, including real Chromium flows and real clangd/rust-analyzer probes.
- Real Python checks with `py_compile`/import, and a pyright LSP probe.
- Test output: [docs/evidence/test-output.txt](docs/evidence/test-output.txt)
- IDE verification details: [docs/IDE-VERIFICATION.md](docs/IDE-VERIFICATION.md)

## License

MIT.
