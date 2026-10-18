/** Read-only IDE/toolchain diagnosis across C/C++, Python, Rust, Go, TS/JS, and JetBrains/VS Code. */

import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { clangdCandidates, type ResolvedConfig } from '../config.js'
import { findExecutable, exists, readTextIfExists, statIfExists } from '../util/fs.js'
import { runCommand } from '../util/exec.js'
import { readCompileDatabase, type CompileDatabaseReport } from './compileCommands.js'
import { readJsoncFile } from './jsonc.js'
import { detectProjectLanguages, findLanguageServer, findSourceForLanguage, languageLabel, languageForPath, type IdeLanguage } from './servers.js'

/** Machine-actionable finding with evidence. */
export interface IdeFinding {
  id: string
  severity: 'info' | 'warning' | 'error'
  title: string
  detail: string
  evidence: string[]
  fix?: {
    tool: 'ide_fix'
    args: Record<string, unknown>
    description: string
  }
  manualSteps?: string[]
}

/** Optional JetBrains project/log hints. */
export interface JetbrainsReport {
  detected: boolean
  projectFiles: string[]
  buildDirectories: string[]
  logs: Array<{ path: string; hints: string[] }>
  exportFlagMentioned?: boolean
}

/** Optional VS Code report. */
export interface VscodeReport {
  settingsPath: string
  settingsError?: string
  clangdPath?: string
  clangdArguments: string[]
  cpptoolsIntelliSenseEngine?: string
  clangdExtension?: string
  cpptoolsExtension?: string
  pythonExtension?: string
  pylanceExtension?: string
  rustExtension?: string
  goExtension?: string
  typescriptExtension?: string
}

/** Result of one project diagnosis. */
export interface IdeDiagnosis {
  projectDir: string
  ide: 'jetbrains' | 'vscode' | 'unknown'
  languages: Array<{
    language: IdeLanguage
    label: string
    markers: string[]
    sourceFile?: string
    server?: { id: string; path: string; version?: string }
  }>
  sourceFile?: string
  detected: {
    cmakeLists: boolean
    cmakeCache: boolean
    compileFlagsTxt: boolean
    clangdConfig?: string
    dotIdea: boolean
    dotVscode: boolean
  }
  compileDatabases: CompileDatabaseReport[]
  primaryDatabase?: CompileDatabaseReport
  sourceInDatabase?: boolean
  clangd: {
    found: boolean
    path?: string
    version?: string
  }
  cmake: {
    found: boolean
    path?: string
    exportCompileCommands?: string
  }
  vscode?: VscodeReport
  jetbrains?: JetbrainsReport
  findings: IdeFinding[]
  recommendedVerification: {
    projectDir: string
    sourceFile?: string
    compileCommandsDir?: string
  }
  status: 'ok' | 'degraded' | 'broken'
}

/** Input for {@link diagnoseProject}. */
export interface DiagnoseInput {
  projectDir: string
  ide?: 'clion' | 'jetbrains' | 'vscode' | 'auto'
  sourceFile?: string
  language?: IdeLanguage
  config: ResolvedConfig
  signal?: AbortSignal
}

/**
 * Diagnose why a C/C++ project may lack semantic IDE behavior.
 * Reads only configuration, toolchain, logs, and compilation databases; it
 * never launches an editor or takes over the desktop.
 * @param input - project directory and optional IDE/source selection.
 * @returns findings with evidence and the recommended verification target.
 */
export async function diagnoseProject(input: DiagnoseInput): Promise<IdeDiagnosis> {
  if (input.signal?.aborted === true) throw new Error('operation cancelled')
  const projectDir = resolve(input.projectDir)
  const info = await statIfExists(projectDir)
  if (info?.isDirectory() !== true) throw new Error(`projectDir is not a directory: ${projectDir}`)
  const entries = await readdir(projectDir).catch(() => [] as string[])
  const cmakeLists = entries.includes('CMakeLists.txt')
  const dotIdea = entries.includes('.idea')
  const dotVscode = entries.includes('.vscode')
  const ide = input.ide === 'vscode'
    ? 'vscode'
    : input.ide === 'jetbrains' || input.ide === 'clion'
      ? 'jetbrains'
      : dotIdea ? 'jetbrains' : dotVscode ? 'vscode' : 'unknown'
  const sourceFile = input.sourceFile !== undefined
    ? resolve(projectDir, input.sourceFile)
    : input.language !== undefined
      ? await findSourceForLanguage(projectDir, input.language)
      : await findSourceFile(projectDir)
  const buildDirectories = entries
    .filter(entry => entry.startsWith('cmake-build-'))
    .map(entry => join(projectDir, entry))
  const cmakeCachePath = await findFirst([
    ...buildDirectories.map(directory => join(directory, 'CMakeCache.txt')),
    join(projectDir, 'build', 'CMakeCache.txt'),
    join(projectDir, 'CMakeCache.txt'),
  ])
  const cache = cmakeCachePath === undefined ? {} : await parseCMakeCache(cmakeCachePath)
  const clangdConfigPath = await findFirst([join(projectDir, '.clangd')])
  const clangdConfigText = clangdConfigPath === undefined ? undefined : await readTextIfExists(clangdConfigPath)
  const clangdConfigDir = clangdConfigText === undefined ? undefined : extractClangdCompilationDatabase(clangdConfigText, dirname(clangdConfigPath as string))
  const vscode = await inspectVscode(projectDir)
  const clangdPath = input.config.clangdPath ?? await findExecutable('clangd', clangdCandidates())
  const clangdVersion = clangdPath === undefined ? undefined : (await runCommand(clangdPath, ['--version'], { timeoutMs: 5_000, signal: input.signal })).stdout.split('\n')[0]?.trim()
  const cmakePath = input.config.cmakePath ?? await findExecutable('cmake', [
    '/Applications/CMake.app/Contents/bin/cmake',
    '/opt/homebrew/bin/cmake',
    '/usr/local/bin/cmake',
    '/usr/bin/cmake',
  ])

  const databasePaths = await findCompilationDatabases({
    projectDir,
    buildDirectories,
    clangdConfigDir,
    vscode,
  })
  const compileDatabases: CompileDatabaseReport[] = []
  for (const path of databasePaths) {
    compileDatabases.push(await readCompileDatabase(path))
  }
  const sourceInDatabase = sourceFile === undefined
    ? undefined
    : compileDatabases.some(database => database.uniqueFiles.some(file => resolve(file) === resolve(sourceFile)))
  const primaryDatabase = choosePrimary(compileDatabases, sourceFile)
  const jetbrains = ide === 'jetbrains' ? await inspectJetbrains(projectDir, buildDirectories) : undefined
  const detectedLanguages = await detectProjectLanguages(projectDir, input.signal)
  const languages: IdeDiagnosis['languages'] = []
  for (const info of detectedLanguages) {
    const server = await findLanguageServer(info.language, input.config, input.signal)
    languages.push({
      ...info,
      label: languageLabel(info.language),
      ...server === undefined ? {} : { server: { id: server.id, path: server.path, ...server.version === undefined ? {} : { version: server.version } } },
    })
  }

  const hasCpp = languages.some(info => info.language === 'c' || info.language === 'cpp' || info.language === 'objective-c')
  const findings: IdeFinding[] = []
  const recommendations: IdeDiagnosis['recommendedVerification'] = {
    projectDir,
    ...sourceFile === undefined ? {} : { sourceFile },
    ...primaryDatabase === undefined ? {} : { compileCommandsDir: primaryDatabase.directory },
  }

  if (!cmakeLists && compileDatabases.length === 0) {
    findings.push({
      id: 'no-build-system',
      severity: 'warning',
      title: 'No CMake project or compilation database detected',
      detail: 'clangd needs either compile_commands.json or compile_flags.txt to understand this project; without one it falls back to guessed flags and semantic behavior is unreliable.',
      evidence: [`projectDir: ${projectDir}`, 'CMakeLists.txt: absent', 'compile_commands.json: absent', 'compile_flags.txt: absent'],
      manualSteps: [
        'Generate a compilation database with your build system, or add a compile_flags.txt with the include paths and language flags.',
      ],
    })
  }

  if (cmakeLists && compileDatabases.length === 0) {
    findings.push({
      id: 'no-compile-commands',
      severity: 'error',
      title: 'CMake project has no compile_commands.json',
      detail: 'CMake only exports compile_commands.json when CMAKE_EXPORT_COMPILE_COMMANDS is ON. Without it clangd cannot resolve project headers or produce reliable semantic results.',
      evidence: [
        `CMakeLists.txt: ${join(projectDir, 'CMakeLists.txt')}`,
        ...cmakeCachePath === undefined ? ['CMakeCache.txt: absent'] : [`CMakeCache.txt: ${cmakeCachePath}`, `CMAKE_EXPORT_COMPILE_COMMANDS=${cache.CMAKE_EXPORT_COMPILE_COMMANDS ?? '(unset)'}`],
      ],
      fix: {
        tool: 'ide_fix',
        args: { projectDir, finding: 'compile-commands', apply: true },
        description: 'Run CMake with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON in the existing build directory, after backing up any existing database.',
      },
      manualSteps: [
        `cmake -S ${projectDir} -B ${join(projectDir, 'build')} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`,
        'Then point clangd at the build directory (ide_fix with finding=clangd-config).',
      ],
    })
  }

  for (const database of compileDatabases) {
    if (database.parseError !== undefined) {
      findings.push({
        id: 'invalid-compile-commands-json',
        severity: 'error',
        title: `Unreadable compilation database: ${database.path}`,
        detail: database.parseError,
        evidence: [database.path],
        fix: {
          tool: 'ide_fix',
          args: { projectDir, finding: 'compile-commands', apply: true, buildDir: dirname(database.path) },
          description: 'Regenerate the database with CMake after backing up the broken file.',
        },
      })
      continue
    }
    if (database.invalid > 0) {
      findings.push({
        id: 'invalid-compile-commands',
        severity: 'error',
        title: `Compilation database has ${database.invalid} invalid entr${database.invalid === 1 ? 'y' : 'ies'}`,
        detail: 'Invalid entries make clangd fall back to guessed flags for those files, which removes project include paths and semantic resolution.',
        evidence: database.invalidEntries.slice(0, 5).map(entry => `entry ${entry.index}: ${entry.problems.join('; ')}`),
        fix: {
          tool: 'ide_fix',
          args: { projectDir, finding: 'compile-commands', apply: true },
          description: 'Regenerate the database from the current build directory after backing it up.',
        },
      })
    }
    if (database.duplicateFiles.length > 0) {
      findings.push({
        id: 'duplicate-compile-commands',
        severity: 'info',
        title: `Compilation database contains duplicate entries for ${database.duplicateFiles.length} file(s)`,
        detail: 'clangd uses the first matching command. Duplicates usually come from reconfiguring one build directory with changed targets; harmless when the commands agree, confusing when they do not.',
        evidence: database.duplicateFiles.slice(0, 5),
      })
    }
  }

  if (primaryDatabase !== undefined && primaryDatabase.valid > 0 && sourceFile !== undefined && sourceInDatabase === false) {
    findings.push({
      id: 'source-not-in-database',
      severity: 'warning',
      title: 'The selected source file is not in the compilation database',
      detail: 'clangd cannot use a project compile command for a file that no target lists; it will guess flags and may lose semantic highlighting for that file.',
      evidence: [`source: ${sourceFile}`, `database: ${primaryDatabase.path}`, `files: ${primaryDatabase.uniqueFiles.length}`],
      fix: {
        tool: 'ide_fix',
        args: { projectDir, finding: 'compile-commands', apply: true },
        description: 'Re-run CMake configuration so the target database includes this source file.',
      },
    })
  }

  if (primaryDatabase !== undefined && clangdConfigDir === undefined && !isAncestor(primaryDatabase.directory, sourceFile ?? projectDir)) {
    findings.push({
      id: 'clangd-config-missing',
      severity: 'warning',
      title: 'clangd will not find the compilation database from this source file',
      detail: 'clangd searches the source file\'s parent directories for compile_commands.json. This database lives in a sibling build directory, so clangd needs an explicit CompilationDatabase in .clangd.',
      evidence: [`database: ${primaryDatabase.path}`, `source: ${sourceFile ?? '(none)'}`],
      fix: {
        tool: 'ide_fix',
        args: { projectDir, finding: 'clangd-config', compileCommandsDir: primaryDatabase.directory, apply: true },
        description: 'Write CompileFlags.CompilationDatabase into .clangd after backing up the previous configuration.',
      },
    })
  }

  if (clangdConfigText !== undefined && clangdConfigDir !== undefined && !await exists(clangdConfigDir)) {
    findings.push({
      id: 'clangd-config-broken',
      severity: 'error',
      title: '.clangd CompilationDatabase points to a missing directory',
      detail: 'Every clangd session in this project will fail to load the compilation database until the path is corrected.',
      evidence: [`config: ${clangdConfigPath ?? '.clangd'}`, `CompilationDatabase: ${clangdConfigDir}`],
      fix: {
        tool: 'ide_fix',
        args: { projectDir, finding: 'clangd-config', ...primaryDatabase === undefined ? {} : { compileCommandsDir: primaryDatabase.directory }, apply: true },
        description: 'Rewrite the CompilationDatabase entry to a verified database directory, with a backup.',
      },
    })
  }

  if (hasCpp && clangdPath === undefined) {
    findings.push({
      id: 'clangd-missing',
      severity: 'error',
      title: 'clangd executable not found',
      detail: 'Programmatic LSP verification and the clangd-based path in VS Code/CLion cannot run until clangd is installed or config.clangdPath is set.',
      evidence: ['searched PATH and common Homebrew/Xcode locations'],
      manualSteps: ['Install LLVM (for example `brew install llvm`) and set config.clangdPath to its clangd binary.'],
    })
  } else if (hasCpp && (clangdVersion === undefined || clangdVersion.length === 0)) {
    findings.push({
      id: 'clangd-version-timeout',
      severity: 'warning',
      title: 'clangd did not report its version',
      detail: 'The executable exists but `clangd --version` produced no first line within the budget; it may be a wrapper or damaged install.',
      evidence: [`path: ${clangdPath}`],
    })
  }

  const exportEnabled = cmakeBoolean(cache.CMAKE_EXPORT_COMPILE_COMMANDS)
  if (cmakeLists && !exportEnabled) {
    findings.push({
      id: 'cmake-export-disabled',
      severity: 'warning',
      title: 'CMAKE_EXPORT_COMPILE_COMMANDS is not enabled',
      detail: 'The existing build directory will not refresh compile_commands.json when the CMake project changes.',
      evidence: [`CMAKE_EXPORT_COMPILE_COMMANDS=${cache.CMAKE_EXPORT_COMPILE_COMMANDS ?? '(unset)'}`],
    })
  }

  if (vscode !== undefined) {
    if (vscode.settingsError !== undefined) {
      findings.push({
        id: 'vscode-settings-unreadable',
        severity: 'warning',
        title: 'VS Code settings could not be parsed',
        detail: vscode.settingsError,
        evidence: [vscode.settingsPath],
      })
    }
    if (hasCpp && vscode.clangdExtension === undefined && dotVscode) {
      findings.push({
        id: 'vscode-clangd-missing',
        severity: 'warning',
        title: 'The VS Code clangd extension is not installed',
        detail: 'Without llvm-vs-code-extensions.vscode-clangd, VS Code will not start clangd even when the project has a valid database.',
        evidence: [`extension directories checked: ${(await extensionRoots()).join(', ')}`],
        manualSteps: ['Install `llvm-vs-code-extensions.vscode-clangd` from the VS Code marketplace.'],
      })
    }
    if (hasCpp && vscode.cpptoolsIntelliSenseEngine !== undefined && vscode.cpptoolsIntelliSenseEngine !== 'disabled') {
      findings.push({
        id: 'vscode-cpptools-conflict',
        severity: 'warning',
        title: 'Microsoft C/C++ IntelliSense is still enabled beside clangd',
        detail: 'Two language engines produce duplicated diagnostics and can mask which one owns semantic highlighting. The clangd extension recommends `"C_Cpp.intelliSenseEngine": "disabled"`.',
        evidence: [`C_Cpp.intelliSenseEngine=${JSON.stringify(vscode.cpptoolsIntelliSenseEngine)}`],
        manualSteps: ['Set `"C_Cpp.intelliSenseEngine": "disabled"` in .vscode/settings.json (this build does not rewrite it automatically).'],
      })
    }
  }

  if (hasCpp && jetbrains !== undefined) {
    if (jetbrains.detected) {
      findings.push({
        id: 'jetbrains-detected',
        severity: 'info',
        title: 'JetBrains project files detected',
        detail: 'JetBrains IDEs use their own language engines; a valid compile_commands.json still matters for clangd-based verification and for external clangd/clang-tidy integration. A successful background probe does not prove the open JetBrains IDE UI is fixed.',
        evidence: [join(projectDir, '.idea'), ...jetbrains.buildDirectories.slice(0, 3)],
      })
    }
    for (const log of jetbrains.logs) {
      if (log.hints.length === 0) continue
      findings.push({
        id: 'jetbrains-log-hints',
        severity: 'warning',
        title: `JetBrains log mentions IDE/language-server problems (${log.hints.length})`,
        detail: 'These are raw lines from a JetBrains IDE log; they may describe an earlier session. Compare timestamps before acting.',
        evidence: log.hints.slice(0, 5),
      })
    }
    if (jetbrains.exportFlagMentioned === false && jetbrains.detected && !exportEnabled) {
      findings.push({
        id: 'jetbrains-export-flag-absent',
        severity: 'warning',
        title: 'JetBrains CMake configuration does not mention CMAKE_EXPORT_COMPILE_COMMANDS',
        detail: 'The JetBrains CMake profile may not export a compilation database, so command-line clangd and verification tools have nothing to read.',
        evidence: [join(projectDir, '.idea', 'cmake.xml')],
        manualSteps: ['In CLion, enable Settings → Build, Execution, Deployment → CMake → CMake options: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON.'],
      })
    }
  }

  const languageSet = new Set(languages.map(info => info.language))
  if (languageSet.has('python')) {
    const interpreter = await findFirst([
      join(projectDir, '.venv', 'bin', 'python'),
      join(projectDir, 'venv', 'bin', 'python'),
    ])
    if (interpreter === undefined) {
      findings.push({
        id: 'python-interpreter-missing',
        severity: 'warning',
        title: 'No project Python interpreter found',
        detail: 'A .venv or venv interpreter was not found. An IDE may fall back to a global interpreter, which can hide missing project dependencies.',
        evidence: [join(projectDir, '.venv', 'bin', 'python'), join(projectDir, 'venv', 'bin', 'python')],
        manualSteps: ['Create `.venv` with Python 3.11+ and select it in the IDE; then run ide_verify with language=python and module=<package>.'],
      })
    } else if (dotVscode || ide === 'vscode') {
      findings.push({
        id: 'python-interpreter-configured',
        severity: 'info',
        title: 'Project Python interpreter found',
        detail: 'The interpreter can be wired into VS Code explicitly instead of relying on global state.',
        evidence: [interpreter],
        fix: {
          tool: 'ide_fix',
          args: { projectDir, finding: 'vscode-python-interpreter', interpreterPath: interpreter, apply: true },
          description: 'Set python.defaultInterpreterPath in .vscode/settings.json, with a backup and rollback.',
        },
      })
    }
    const python = languages.find(info => info.language === 'python')
    if (python?.server === undefined) {
      findings.push({
        id: 'python-lsp-missing',
        severity: 'warning',
        title: 'No standalone Python language server found',
        detail: 'Python runtime/import checks still work, but this build cannot run a live Python LSP probe. Pylance is bundled inside VS Code and is not launched as a headless server here.',
        evidence: ['searched pyright-langserver, basedpyright-langserver, pylsp'],
        manualSteps: ['Install `pyright` (or `basedpyright`, or `python-lsp-server`) and ensure its language-server executable is on PATH; then rerun ide_verify.'],
      })
    }
    if (vscode !== undefined) {
      if (vscode.pythonExtension === undefined) {
        findings.push({
          id: 'vscode-python-extension-missing',
          severity: 'warning',
          title: 'The VS Code Python extension is not installed',
          detail: 'VS Code will not resolve the project interpreter or start a Python language server without ms-python.python.',
          evidence: [`extension directories checked: ${(await extensionRoots()).join(', ')}`],
          manualSteps: ['Install `ms-python.python` from the VS Code marketplace.'],
        })
      }
      if (vscode.pylanceExtension === undefined) {
        findings.push({
          id: 'vscode-pylance-missing',
          severity: 'info',
          title: 'Pylance is not installed in VS Code',
          detail: 'Pylance provides Python IntelliSense inside VS Code. This probe does not launch it; install it for the editor UI, and install a standalone language server for headless verification.',
          evidence: [`extension directories checked: ${(await extensionRoots()).join(', ')}`],
          manualSteps: ['Install `ms-python.vscode-pylance` if you use VS Code for Python.'],
        })
      }
    }
  }

  if (languageSet.has('rust')) {
    const rust = languages.find(info => info.language === 'rust')
    if (rust?.server === undefined) {
      findings.push({
        id: 'rust-analyzer-missing',
        severity: 'warning',
        title: 'rust-analyzer is not on PATH',
        detail: 'Rust code cannot be semantically verified by this build until rust-analyzer is installed; `cargo check` can still be run as a runtime check.',
        evidence: ['searched PATH, ~/.cargo/bin/rust-analyzer, Homebrew locations'],
        manualSteps: ['Run `rustup component add rust-analyzer` (or install rust-analyzer) and rerun ide_verify with language=rust.'],
      })
    }
    if (vscode !== undefined && vscode.rustExtension === undefined) {
      findings.push({
        id: 'vscode-rust-extension-missing',
        severity: 'info',
        title: 'The VS Code rust-analyzer extension is not installed',
        detail: 'The standalone rust-analyzer probe can still work, but VS Code will not provide Rust IntelliSense without the extension.',
        evidence: [`extension directories checked: ${(await extensionRoots()).join(', ')}`],
        manualSteps: ['Install `rust-lang.rust-analyzer` in VS Code if you use it for Rust.'],
      })
    }
  }

  if (languageSet.has('go')) {
    const go = languages.find(info => info.language === 'go')
    if (go?.server === undefined) {
      findings.push({
        id: 'gopls-missing',
        severity: 'warning',
        title: 'gopls is not on PATH',
        detail: 'Go code cannot be semantically verified by this build until gopls is installed; `go build` can still be run as a runtime check.',
        evidence: ['searched PATH, ~/go/bin/gopls, Homebrew locations'],
        manualSteps: ['Run `go install golang.org/x/tools/gopls@latest` and rerun ide_verify with language=go.'],
      })
    }
  }

  if (languageSet.has('java')) {
    const java = languages.find(info => info.language === 'java')
    if (java?.server === undefined) {
      findings.push({
        id: 'jdtls-missing',
        severity: 'warning',
        title: 'jdtls is not on PATH',
        detail: 'Java semantic verification is not available in this build until Eclipse JDT Language Server is installed; project detection still works.',
        evidence: ['searched PATH and Homebrew locations'],
        manualSteps: ['Install `jdtls` and rerun ide_verify with language=java.'],
      })
    }
  }

  if (languageSet.has('kotlin')) {
    const kotlin = languages.find(info => info.language === 'kotlin')
    if (kotlin?.server === undefined) {
      findings.push({
        id: 'kotlin-language-server-missing',
        severity: 'warning',
        title: 'kotlin-language-server is not on PATH',
        detail: 'Kotlin semantic verification is not available in this build until kotlin-language-server is installed; project detection still works.',
        evidence: ['searched PATH and Homebrew locations'],
        manualSteps: ['Install `kotlin-language-server` and rerun ide_verify with language=kotlin.'],
      })
    }
  }

  if (languageSet.has('typescript') || languageSet.has('javascript')) {
    const ts = languages.find(info => info.language === 'typescript' || info.language === 'javascript')
    if (ts?.server === undefined) {
      findings.push({
        id: 'typescript-lsp-missing',
        severity: 'warning',
        title: 'typescript-language-server is not on PATH',
        detail: 'TypeScript/JavaScript cannot be semantically verified by this build until typescript-language-server is installed; `tsc --noEmit` can still be run as a runtime check.',
        evidence: ['searched PATH, npm global, Homebrew locations'],
        manualSteps: ['Run `npm install -g typescript typescript-language-server` and rerun ide_verify.'],
      })
    }
  }

  if (findings.every(finding => finding.severity === 'info')) {
    findings.push(hasCpp
      ? {
        id: 'configuration-ready',
        severity: 'info',
        title: 'Project has a readable compilation database and clangd',
        detail: 'Diagnosis found no blocking C/C++ configuration problem. Run ide_verify to measure semantic tokens, completions, and diagnostics from a live clangd session.',
        evidence: primaryDatabase === undefined ? [] : [primaryDatabase.path, `valid entries: ${primaryDatabase.valid}`],
      }
      : {
        id: 'language-ready',
        severity: 'info',
        title: 'No blocking language configuration problem found',
        detail: 'Run ide_verify to start the detected language server and, optionally, a bounded project check. Static diagnosis is not proof that the language server will answer.',
        evidence: languages.map(info => `${info.label}: ${info.markers.join(', ') || 'source files'}${info.server === undefined ? ' (no server)' : ` (${info.server.id})`}`),
      })
  }

  const status = findings.some(finding => finding.severity === 'error')
    ? 'broken'
    : findings.some(finding => finding.severity === 'warning')
      ? 'degraded'
      : 'ok'
  return {
    projectDir,
    ide,
    languages,
    ...sourceFile === undefined ? {} : { sourceFile },
    detected: {
      cmakeLists,
      cmakeCache: cmakeCachePath !== undefined,
      compileFlagsTxt: entries.includes('compile_flags.txt'),
      ...clangdConfigPath === undefined ? {} : { clangdConfig: clangdConfigPath },
      dotIdea,
      dotVscode,
    },
    compileDatabases,
    ...primaryDatabase === undefined ? {} : { primaryDatabase },
    ...sourceInDatabase === undefined ? {} : { sourceInDatabase },
    clangd: {
      found: clangdPath !== undefined,
      ...clangdPath === undefined ? {} : { path: clangdPath },
      ...clangdVersion === undefined || clangdVersion.length === 0 ? {} : { version: clangdVersion },
    },
    cmake: {
      found: cmakePath !== undefined,
      ...cmakePath === undefined ? {} : { path: cmakePath },
      ...cache.CMAKE_EXPORT_COMPILE_COMMANDS === undefined ? {} : { exportCompileCommands: cache.CMAKE_EXPORT_COMPILE_COMMANDS },
    },
    ...vscode === undefined ? {} : { vscode },
    ...jetbrains === undefined ? {} : { jetbrains },
    findings,
    recommendedVerification: recommendations,
    status,
  }
}

async function findCompilationDatabases(input: {
  projectDir: string
  buildDirectories: string[]
  clangdConfigDir: string | undefined
  vscode: VscodeReport | undefined
}): Promise<string[]> {
  const candidates = [
    join(input.projectDir, 'compile_commands.json'),
    join(input.projectDir, 'build', 'compile_commands.json'),
    ...input.buildDirectories.map(directory => join(directory, 'compile_commands.json')),
  ]
  if (input.clangdConfigDir !== undefined) {
    candidates.push(input.clangdConfigDir.endsWith('.json')
      ? input.clangdConfigDir
      : join(input.clangdConfigDir, 'compile_commands.json'))
  }
  for (const argument of input.vscode?.clangdArguments ?? []) {
    if (argument.startsWith('--compile-commands-dir=')) {
      candidates.push(join(argument.slice('--compile-commands-dir='.length), 'compile_commands.json'))
    }
  }
  const found: string[] = []
  for (const candidate of candidates) {
    const path = resolve(candidate)
    if (found.includes(path)) continue
    if (await exists(path)) found.push(path)
  }
  return found
}

function choosePrimary(databases: CompileDatabaseReport[], sourceFile: string | undefined): CompileDatabaseReport | undefined {
  if (databases.length === 0) return undefined
  const matching = sourceFile === undefined
    ? []
    : databases.filter(database => database.uniqueFiles.some(file => resolve(file) === resolve(sourceFile)))
  const candidates = matching.length > 0 ? matching : databases
  return [...candidates].sort((left, right) => right.valid - left.valid)[0]
}

async function inspectVscode(projectDir: string): Promise<VscodeReport | undefined> {
  const settingsPath = join(projectDir, '.vscode', 'settings.json')
  if (!await exists(settingsPath)) return undefined
  const parsed = await readJsoncFile(settingsPath)
  const settings = parsed.value ?? {}
  const argumentsValue = settings['clangd.arguments']
  const roots = await extensionRoots()
  const extensions: string[] = []
  for (const root of roots) {
    const entries = await readdir(root).catch(() => [] as string[])
    extensions.push(...entries)
  }
  const clangdExtension = extensions.find(entry => entry.startsWith('llvm-vs-code-extensions.vscode-clangd-'))
  const cpptoolsExtension = extensions.find(entry => entry.startsWith('ms-vscode.cpptools-'))
  const pythonExtension = extensions.find(entry => entry.startsWith('ms-python.python-'))
  const pylanceExtension = extensions.find(entry => entry.startsWith('ms-python.vscode-pylance-'))
  const rustExtension = extensions.find(entry => entry.startsWith('rust-lang.rust-analyzer-'))
  const goExtension = extensions.find(entry => entry.startsWith('golang.go-'))
  const typescriptExtension = extensions.find(entry => entry.startsWith('ms-vscode.vscode-typescript-next-') || entry === 'vscode.typescript-language-features')
  return {
    settingsPath,
    ...parsed.error === undefined ? {} : { settingsError: parsed.error },
    ...typeof settings['clangd.path'] === 'string' ? { clangdPath: settings['clangd.path'] } : {},
    clangdArguments: Array.isArray(argumentsValue) ? argumentsValue.filter((value): value is string => typeof value === 'string') : [],
    ...typeof settings['C_Cpp.intelliSenseEngine'] === 'string' ? { cpptoolsIntelliSenseEngine: settings['C_Cpp.intelliSenseEngine'] } : {},
    ...clangdExtension === undefined ? {} : { clangdExtension },
    ...cpptoolsExtension === undefined ? {} : { cpptoolsExtension },
    ...pythonExtension === undefined ? {} : { pythonExtension },
    ...pylanceExtension === undefined ? {} : { pylanceExtension },
    ...rustExtension === undefined ? {} : { rustExtension },
    ...goExtension === undefined ? {} : { goExtension },
    ...typescriptExtension === undefined ? {} : { typescriptExtension },
  }
}

async function extensionRoots(): Promise<string[]> {
  const home = homedir()
  return [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.cursor', 'extensions'),
    join(home, '.vscode-server', 'extensions'),
  ]
}

async function inspectJetbrains(
  projectDir: string,
  buildDirectories: string[],
): Promise<JetbrainsReport> {
  const candidates = ['.idea/cmake.xml', '.idea/workspace.xml', '.idea/misc.xml']
  const present: string[] = []
  let exportFlagMentioned: boolean | undefined
  for (const relative of candidates) {
    const path = join(projectDir, relative)
    const text = await readTextIfExists(path)
    if (text === undefined) continue
    present.push(path)
    if (/CMAKE_EXPORT_COMPILE_COMMANDS/.test(text)) exportFlagMentioned = true
  }
  if (exportFlagMentioned === undefined && present.length > 0) exportFlagMentioned = false
  const logs: JetbrainsReport['logs'] = []
  const logsRoot = join(homedir(), 'Library', 'Logs', 'JetBrains')
  const jetbrainsDirs = await readdir(logsRoot).catch(() => [] as string[])
  for (const directory of jetbrainsDirs.filter(entry => /clion|pycharm|idea|goland|webstorm/i.test(entry)).slice(0, 5)) {
    const path = join(logsRoot, directory, 'idea.log')
    const text = await readTextIfExists(path)
    if (text === undefined) continue
    const tail = text.slice(-300_000)
    const hints = tail.split('\n')
      .filter(line => /clangd|compile_commands|compilation database|CMAKE_EXPORT_COMPILE_COMMANDS|pyright|pylance|rust-analyzer|gopls|typescript|language server|Python SDK|interpreter/i.test(line))
      .slice(-25)
      .map(line => line.slice(0, 500))
    logs.push({ path, hints })
  }
  return {
    detected: present.length > 0,
    projectFiles: present,
    buildDirectories,
    logs,
    ...exportFlagMentioned === undefined ? {} : { exportFlagMentioned },
  }
}

async function parseCMakeCache(path: string): Promise<Record<string, string>> {
  const text = await readFile(path, 'utf8').catch(() => '')
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9_.-]+):[A-Z]+=(.*)$/.exec(line)
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      if (['CMAKE_EXPORT_COMPILE_COMMANDS', 'CMAKE_HOME_DIRECTORY', 'CMAKE_GENERATOR', 'CMAKE_BUILD_TYPE', 'CMAKE_CXX_COMPILER'].includes(match[1])) {
        result[match[1]] = match[2]
      }
    }
  }
  return result
}

/** CMake cache booleans are written as 1/0, ON/OFF, or TRUE/FALSE depending on generator. */
function cmakeBoolean(value: string | undefined): boolean {
  return value !== undefined && /^(1|on|true|yes|y)$/i.test(value.trim())
}

function extractClangdCompilationDatabase(text: string, baseDir: string): string | undefined {
  const match = /^\s*CompilationDatabase:\s*(.+?)\s*$/m.exec(text)
  if (match === null || match[1] === undefined) return undefined
  const value = match[1].replace(/^["']|["']$/g, '')
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value)
}

function isAncestor(directory: string, target: string): boolean {
  const parent = resolve(directory)
  const child = resolve(target)
  return child === parent || child.startsWith(`${parent}/`)
}

async function findFirst(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await exists(path)) return path
  }
  return undefined
}

async function findSourceFile(projectDir: string, depth = 0): Promise<string | undefined> {
  if (depth > 3) return undefined
  const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile() && /\.(py|rs|go|ts|tsx|mts|cts|js|jsx|mjs|cjs|c|cc|cpp|cxx|h|hpp|java|kt|kts)$/i.test(entry.name)) return join(projectDir, entry.name)
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    if (/^(\.|build|cmake-build|node_modules|third_party|third-party|\.git)/.test(entry.name)) continue
    const found = await findSourceFile(join(projectDir, entry.name), depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** Short human summary used in tool output. */
export function summarizeDiagnosis(diagnosis: IdeDiagnosis): string {
  const errors = diagnosis.findings.filter(finding => finding.severity === 'error').length
  const warnings = diagnosis.findings.filter(finding => finding.severity === 'warning').length
  const database = diagnosis.primaryDatabase
  const hasCpp = diagnosis.languages.some(info => info.language === 'c' || info.language === 'cpp' || info.language === 'objective-c')
  const languageLine = diagnosis.languages.length === 0
    ? 'Languages: none detected.'
    : `Languages: ${diagnosis.languages.map(info => `${info.label}${info.server === undefined ? '' : ` via ${info.server.id}`}`).join(', ')}.`
  return [
    `IDE diagnosis for ${diagnosis.projectDir}: ${diagnosis.status} (${errors} error(s), ${warnings} warning(s)).`,
    languageLine,
    ...hasCpp
      ? [
          database === undefined
            ? 'No C/C++ compilation database was found.'
            : `Primary database ${basename(database.path)}: ${database.valid}/${database.entries} valid entries.`,
          diagnosis.clangd.found ? `clangd: ${diagnosis.clangd.version ?? diagnosis.clangd.path ?? 'found'}` : 'clangd: not found',
        ]
      : [],
    diagnosis.sourceFile === undefined ? 'No source file selected.' : `Source: ${diagnosis.sourceFile}${diagnosis.sourceInDatabase === false ? ' (not in database)' : ''}`,
  ].join('\n')
}
