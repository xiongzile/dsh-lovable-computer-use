/** Model-facing IDE/toolchain diagnosis and language-agnostic verification tools. */

import { resolve } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '../context.js'
import { objectSchema, openObjectSchema, parseArgs, summaryRender } from '../schema.js'
import type { ResolvedConfig } from '../config.js'
import { diagnoseProject, summarizeDiagnosis, type IdeDiagnosis } from '../ide/diagnose.js'
import { applyIdeFix, type FixFinding } from '../ide/fix.js'
import { probeLsp, type LspProbeResult } from '../ide/lsp.js'
import { runRuntimeCheck, type RuntimeCheckMode, type RuntimeCheckResult } from '../ide/runtimeCheck.js'
import {
  detectProjectLanguages,
  findLanguageServer,
  findLanguageServerById,
  findSourceForLanguage,
  languageForPath,
  languageIdForPath,
  languageLabel,
  withCompileCommands,
  type IdeLanguage,
  type LanguageServerId,
  type LanguageServerSpec,
} from '../ide/servers.js'
import type { Logger } from '../util/log.js'
import { throwIfAborted } from '../util/async.js'

function projectDirFor(args: Record<string, unknown>, exec: ToolRunContext): string {
  const fromArgs = typeof args.projectDir === 'string' ? args.projectDir : undefined
  const fromSession = exec.agent?.session?.header?.cwd
  return resolve(fromArgs ?? fromSession ?? process.cwd())
}

function findingText(finding: IdeDiagnosis['findings'][number]): string {
  const lines = [`[${finding.severity}] ${finding.title}`, finding.detail]
  if (finding.evidence.length > 0) lines.push(`  evidence: ${finding.evidence.join(' | ')}`)
  if (finding.fix !== undefined) lines.push(`  fix: ${finding.fix.description}`)
  if (finding.manualSteps !== undefined && finding.manualSteps.length > 0) lines.push(`  manual: ${finding.manualSteps.join(' | ')}`)
  return lines.join('\n')
}

function renderDiagnosis(diagnosis: IdeDiagnosis): string {
  const lines = [summarizeDiagnosis(diagnosis)]
  if (diagnosis.primaryDatabase !== undefined) {
    const database = diagnosis.primaryDatabase
    lines.push(`Primary database: ${database.path}`)
    if (database.invalidEntries.length > 0) {
      lines.push('Invalid entries:')
      for (const entry of database.invalidEntries.slice(0, 5)) lines.push(`  entry ${entry.index}: ${entry.problems.join('; ')}`)
    }
  }
  lines.push('Findings:')
  for (const finding of diagnosis.findings) lines.push(findingText(finding))
  lines.push(`Recommended verification: ${JSON.stringify(diagnosis.recommendedVerification)}`)
  return lines.join('\n')
}

interface VerifyResult {
  language: IdeLanguage
  languageLabel: string
  sourceFile: string
  server?: Pick<LanguageServerSpec, 'id' | 'path' | 'version' | 'displayName'>
  probe?: LspProbeResult
  runtimeCheck: RuntimeCheckResult
  diagnosisStatus: string
  verdict: 'lsp_verified' | 'runtime_verified' | 'partial' | 'failed'
  requiresHostConfirmation: true
}

function renderVerify(result: VerifyResult): string {
  const lines = [
    `IDE verification: ${result.verdict}`,
    `language: ${result.languageLabel} (${result.language})`,
    `source: ${result.sourceFile}`,
    ...result.server === undefined
      ? ['language server: none found']
      : [`language server: ${result.server.id} (${result.server.path}${result.server.version === undefined ? '' : `, ${result.server.version}`})`],
  ]
  if (result.probe !== undefined) {
    const probe = result.probe
    lines.push(
      `LSP probe: ${probe.verdict} (${probe.durationMs}ms, init ${probe.initializeMs}ms)`,
      `features: semantic tokens ${probe.features.semanticTokens}; completions ${probe.features.completionItems}; symbols ${probe.features.documentSymbols}; definitions ${probe.features.definitions}`,
      ...probe.features.hover === undefined ? [] : [`hover: ${probe.features.hover.replace(/\s+/g, ' ').slice(0, 300)}`],
      `diagnostics: ${probe.diagnostics.length}${probe.diagnostics.length === 0 ? '' : ` (first: ${probe.diagnostics[0]?.message ?? ''})`}`,
      ...probe.stderrSignals.length === 0 ? [] : [`server stderr signals: ${probe.stderrSignals.join(' | ')}`],
      probe.detail,
    )
  } else {
    lines.push('LSP probe: not run (no supported language server installed for this language)')
  }
  const runtime = result.runtimeCheck
  lines.push(
    `runtime check: ${runtime.status}${runtime.kind === 'none' ? '' : ` (${runtime.kind})`}`,
    runtime.detail,
    ...runtime.command === undefined ? [] : [`runtime command: ${runtime.command}`],
    ...runtime.stderrTail === undefined ? [] : [`runtime stderr tail:\n${runtime.stderrTail}`],
  )
  lines.push(
    `IDE diagnosis status: ${result.diagnosisStatus}`,
    `Requires host confirmation: true — an isolated LSP/runtime pass does not prove the user's open IDE window has re-indexed or selected the same interpreter.`,
  )
  return lines.join('\n')
}

function languageFromArgs(raw: unknown): IdeLanguage | 'auto' {
  const value = typeof raw === 'string' ? raw : 'auto'
  return value === 'auto' ? 'auto' : value as IdeLanguage
}

/** Register the IDE tools. */
export function registerIdeTools(input: {
  config: ResolvedConfig
  logger: Logger
}): ToolDefinition[] {
  const { config, logger } = input
  const tools: ToolDefinition[] = []

  tools.push({
    name: 'ide_diagnose',
    description: 'Inspect a project for why semantic IDE behavior may be missing, without opening an editor. Covers C/C++ compilation databases and clangd, Python interpreters and VS Code/Pylance settings, Rust/Go/TypeScript/Java toolchain and extension hints, JetBrains project files, and VS Code extension conflicts. '
      + 'Read-only. Prefer this over guessing, and run it before changing any IDE configuration.',
    parameters: objectSchema({
      projectDir: { type: 'string', description: 'Absolute project directory; defaults to the session working directory.' },
      ide: { type: 'string', enum: ['jetbrains', 'vscode', 'auto'], description: 'Target IDE family; auto detects from .idea/.vscode.' },
      sourceFile: { type: 'string', description: 'Source file to check; absolute or project-relative. Auto-selects one when omitted.' },
      language: { type: 'string', enum: ['auto', 'c', 'cpp', 'objective-c', 'python', 'rust', 'go', 'typescript', 'javascript', 'java', 'kotlin'], description: 'Preferred language for source selection; auto detects from the project.' },
    }),
    output: {
      schema: openObjectSchema({ diagnosis: { type: 'object', additionalProperties: true, required: true } }),
      render: (_args, value) => {
        const diagnosis = (value as { diagnosis: IdeDiagnosis }).diagnosis
        return [{ type: 'text', text: renderDiagnosis(diagnosis) }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      throwIfAborted(exec.signal)
      const args = parseArgs('ide_diagnose', this.parameters, rawArgs)
      const projectDir = projectDirFor(args, exec)
      const diagnosis = await diagnoseProject({
        projectDir,
        ...typeof args.ide === 'string' ? { ide: args.ide as 'jetbrains' | 'vscode' | 'auto' } : {},
        ...typeof args.sourceFile === 'string'
          ? { sourceFile: resolve(projectDir, args.sourceFile) }
          : {},
        ...typeof args.language === 'string' && args.language !== 'auto' ? { language: args.language as IdeLanguage } : {},
        config,
        signal: exec.signal,
      })
      return { diagnosis }
    },
  })

  tools.push({
    name: 'ide_verify',
    description: 'Prove language behavior without opening the user\'s IDE: start the appropriate language server in the background (clangd, pyright/basedpyright/pylsp, rust-analyzer, gopls, or typescript-language-server), open one source file, and measure semantic tokens, completions, hover, document symbols, definitions, and diagnostics. '
      + 'Optionally run a bounded project check (Python py_compile/import, cargo check, go build, or tsc --noEmit). This never proves the user\'s already-open IDE window has re-indexed; mark host_confirmed only after the user confirms.',
    parameters: objectSchema({
      projectDir: { type: 'string', description: 'Absolute project directory; defaults to the session working directory.' },
      sourceFile: { type: 'string', description: 'Source file to probe; absolute or project-relative. Auto-selects one when omitted.' },
      language: { type: 'string', enum: ['auto', 'c', 'cpp', 'objective-c', 'python', 'rust', 'go', 'typescript', 'javascript', 'java', 'kotlin'], description: 'Language to verify; auto detects from sourceFile/project.' },
      languageServer: { type: 'string', enum: ['auto', 'clangd', 'pyright', 'basedpyright', 'pylsp', 'rust-analyzer', 'gopls', 'typescript-language-server', 'jdtls', 'kotlin-language-server'], description: 'Force a specific language server; auto chooses by language.' },
      compileCommandsDir: { type: 'string', description: 'clangd only: directory containing compile_commands.json; auto-selects the best database when omitted.' },
      line: { type: 'integer', description: '1-based line for hover/completion probes.' },
      character: { type: 'integer', description: '1-based character for hover/completion probes.' },
      timeoutMs: { type: 'integer', description: 'Overall probe budget; default 30000, max 120000.' },
      runtimeCheck: { type: 'string', enum: ['auto', 'off', 'force'], description: 'auto: cheap Python checks only; force: also cargo/go/tsc; off: no project command.' },
      module: { type: 'string', description: 'Python import target for a real import check, e.g. vllm.' },
      interpreter: { type: 'string', description: 'Explicit Python interpreter; defaults to .venv/bin/python, venv/bin/python, or python3.' },
    }),
    output: {
      schema: openObjectSchema({
        language: { type: 'string', required: true },
        languageLabel: { type: 'string', required: true },
        sourceFile: { type: 'string', required: true },
        verdict: { type: 'string', required: true },
        runtimeCheck: { type: 'object', additionalProperties: true, required: true },
        diagnosisStatus: { type: 'string', required: true },
        requiresHostConfirmation: { type: 'boolean', required: true },
      }),
      render: (_args, value) => [{ type: 'text', text: renderVerify(value as VerifyResult) }],
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      throwIfAborted(exec.signal)
      const args = parseArgs('ide_verify', this.parameters, rawArgs)
      const projectDir = projectDirFor(args, exec)
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000
      if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) {
        throw new Error('ide_verify timeoutMs must be an integer in [5000, 120000]')
      }
      const diagnosis = await diagnoseProject({
        projectDir,
        ...typeof args.sourceFile === 'string' ? { sourceFile: resolve(projectDir, args.sourceFile) } : {},
        config,
        signal: exec.signal,
      })
      let language = languageFromArgs(args.language)
      const requestedSource = typeof args.sourceFile === 'string' ? resolve(projectDir, args.sourceFile) : undefined
      if (language === 'auto' && requestedSource !== undefined) language = languageForPath(requestedSource)
      if (language === 'auto') {
        const detected = await detectProjectLanguages(projectDir, exec.signal)
        language = detected[0]?.language ?? (diagnosis.sourceFile === undefined ? 'unknown' : languageForPath(diagnosis.sourceFile))
      }
      const forcedServer = typeof args.languageServer === 'string' && args.languageServer !== 'auto'
        ? args.languageServer as LanguageServerId
        : undefined
      const server = forcedServer === undefined
        ? await findLanguageServer(language, config, exec.signal)
        : await findLanguageServerById(forcedServer, config, exec.signal)
      if (server !== undefined && forcedServer !== undefined) language = server.language
      const sourceFile = requestedSource ?? await findSourceForLanguage(projectDir, language) ?? diagnosis.sourceFile
      if (sourceFile === undefined) {
        throw new Error(`ide_verify needs a source file for ${languageLabel(language)}; pass sourceFile or add a supported source file under the project`)
      }
      const compileCommandsDir = typeof args.compileCommandsDir === 'string'
        ? resolve(projectDir, args.compileCommandsDir)
        : server?.id === 'clangd' ? diagnosis.primaryDatabase?.directory : undefined
      const serverArgs = server === undefined ? [] : withCompileCommands(server.args, compileCommandsDir)
      const probe = server === undefined
        ? undefined
        : await probeLsp({
          projectDir,
          sourceFile,
          language,
          languageId: languageIdForPath(sourceFile),
          serverId: server.id,
          serverPath: server.path,
          serverArgs,
          ...compileCommandsDir === undefined ? {} : { compileCommandsDir },
          ...typeof args.line === 'number' ? { line: args.line } : {},
          ...typeof args.character === 'number' ? { character: args.character } : {},
          timeoutMs,
          signal: exec.signal,
          logger,
        })
      const runtimeMode: RuntimeCheckMode = args.runtimeCheck === 'off' || args.runtimeCheck === 'force'
        ? args.runtimeCheck
        : 'auto'
      const runtimeCheck = await runRuntimeCheck({
        projectDir,
        language,
        sourceFile,
        mode: runtimeMode,
        timeoutMs: Math.min(timeoutMs, 120_000),
        ...typeof args.module === 'string' ? { module: args.module } : {},
        ...typeof args.interpreter === 'string' ? { interpreter: resolve(projectDir, args.interpreter) } : {},
        signal: exec.signal,
      })
      const runtimeFailed = runtimeCheck.status === 'failed'
      const verdict: VerifyResult['verdict'] = probe?.verdict === 'lsp_verified' && !runtimeFailed
        ? 'lsp_verified'
        : probe?.verdict === 'partial' && !runtimeFailed
          ? 'partial'
          : runtimeCheck.status === 'passed'
            ? 'runtime_verified'
            : 'failed'
      return {
        language,
        languageLabel: languageLabel(language),
        sourceFile,
        ...server === undefined ? {} : { server: { id: server.id, path: server.path, displayName: server.displayName, ...server.version === undefined ? {} : { version: server.version } } },
        ...probe === undefined ? {} : { probe },
        runtimeCheck,
        diagnosisStatus: diagnosis.status,
        verdict,
        requiresHostConfirmation: true,
      }
    },
  })

  tools.push({
    name: 'ide_fix',
    description: 'Apply one minimal, reversible IDE fix after ide_diagnose: regenerate compile_commands.json with CMAKE_EXPORT_COMPILE_COMMANDS=ON, write a .clangd CompilationDatabase entry, or set a Python interpreter in .vscode/settings.json. '
      + 'Dry-run by default; set apply=true only after the user approves. Every write is backed up under the plugin state directory and the result includes a rollback command. '
      + 'This never edits a running IDE and never claims the host UI is fixed.',
    parameters: objectSchema({
      projectDir: { type: 'string', description: 'Absolute project directory; defaults to the session working directory.' },
      finding: { type: 'string', required: true, enum: ['compile-commands', 'clangd-config', 'vscode-python-interpreter'], description: 'Fix to evaluate.' },
      apply: { type: 'boolean', description: 'Write the change. Defaults to false (dry-run).' },
      buildDir: { type: 'string', description: 'For compile-commands: build directory inside the project; auto-detected when omitted.' },
      compileCommandsDir: { type: 'string', description: 'For clangd-config: directory containing compile_commands.json.' },
      interpreterPath: { type: 'string', description: 'For vscode-python-interpreter: interpreter path, e.g. .venv/bin/python.' },
    }),
    output: {
      schema: openObjectSchema({
        result: { type: 'object', additionalProperties: true, required: true },
      }),
      render: (_args, value) => {
        const result = (value as { result: Awaited<ReturnType<typeof applyIdeFix>> }).result
        return [{
          type: 'text',
          text: [
            `${result.finding}: ${result.applied ? 'APPLIED' : 'dry-run (no write)'}`,
            ...result.command === undefined ? [] : [`command: ${result.command}`],
            `changed: ${result.changedPaths.join(', ')}`,
            ...result.backupPath === undefined ? [] : [`backup: ${result.backupPath}`],
            `rollback: ${result.rollback}`,
            `verification: ${result.verification}`,
            ...result.diff === undefined ? [] : [result.diff],
            ...result.output === undefined || result.output.length === 0 ? [] : [`output tail:\n${result.output}`],
            ...result.warnings.length === 0 ? [] : [`warnings:\n${result.warnings.map(warning => `- ${warning}`).join('\n')}`],
          ].join('\n'),
        }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      throwIfAborted(exec.signal)
      const args = parseArgs('ide_fix', this.parameters, rawArgs)
      const projectDir = projectDirFor(args, exec)
      if (args.apply === true && !config.allowOutsideWorkspaceWrites) {
        const workspace = exec.agent?.session?.header?.cwd
        if (workspace !== undefined) {
          const root = resolve(workspace)
          if (projectDir !== root && !projectDir.startsWith(`${root}/`)) {
            throw new Error(`ide_fix would write outside the session workspace (${root}); pass apply=false to inspect, or set config.allowOutsideWorkspaceWrites=true after the user approves.`)
          }
        }
      }
      const result = await applyIdeFix({
        projectDir,
        finding: String(args.finding) as FixFinding,
        apply: args.apply === true,
        ...typeof args.buildDir === 'string' ? { buildDir: args.buildDir } : {},
        ...typeof args.compileCommandsDir === 'string' ? { compileCommandsDir: args.compileCommandsDir } : {},
        ...typeof args.interpreterPath === 'string' ? { interpreterPath: args.interpreterPath } : {},
        config,
        signal: exec.signal,
      })
      return { result }
    },
  })

  return tools
}
