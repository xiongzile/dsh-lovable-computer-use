/** Minimal, reversible IDE configuration fixes with backups. */

import { join, relative, resolve } from 'node:path'
import {
  copyFileEnsuringDir,
  ensureDir,
  exists,
  readTextIfExists,
  removeIfExists,
  timestampSlug,
  writeTextAtomic,
} from '../util/fs.js'
import { runCommand } from '../util/exec.js'
import type { ResolvedConfig } from '../config.js'
import { readCompileDatabase } from './compileCommands.js'

/** Fixes this build can apply without editing another tool's live state. */
export type FixFinding = 'compile-commands' | 'clangd-config' | 'vscode-python-interpreter'

/** Input for {@link applyIdeFix}. */
export interface FixInput {
  projectDir: string
  finding: FixFinding
  apply: boolean
  buildDir?: string
  compileCommandsDir?: string
  interpreterPath?: string
  config: ResolvedConfig
  signal?: AbortSignal
}

/** Result returned to the model. */
export interface FixResult {
  finding: FixFinding
  applied: boolean
  projectDir: string
  command?: string
  backupPath?: string
  changedPaths: string[]
  output?: string
  diff?: string
  rollback: string
  verification: string
  warnings: string[]
}

/**
 * Apply one known-safe fix.
 * @param input - fix selection and whether to write.
 * @returns what would change or what changed, with rollback instructions.
 */
export async function applyIdeFix(input: FixInput): Promise<FixResult> {
  const projectDir = resolve(input.projectDir)
  switch (input.finding) {
    case 'compile-commands':
      return fixCompileCommands(projectDir, input)
    case 'clangd-config':
      return fixClangdConfig(projectDir, input)
    case 'vscode-python-interpreter':
      return fixVscodePythonInterpreter(projectDir, input)
  }
}

async function fixCompileCommands(projectDir: string, input: FixInput): Promise<FixResult> {
  const cmakeLists = join(projectDir, 'CMakeLists.txt')
  if (!await exists(cmakeLists)) {
    throw new Error(`compile-commands fix requires a CMakeLists.txt at ${projectDir}`)
  }
  const buildDir = resolve(projectDir, input.buildDir ?? await pickBuildDir(projectDir))
  if (!isInside(projectDir, buildDir)) {
    throw new Error(`buildDir must stay inside the project directory: ${buildDir}`)
  }
  const database = join(buildDir, 'compile_commands.json')
  const cmake = input.config.cmakePath ?? 'cmake'
  const args = ['-S', projectDir, '-B', buildDir, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON']
  const command = [cmake, ...args].join(' ')
  const existing = await exists(database)
  const backupPath = existing
    ? join(input.config.stateDir, 'backups', `${timestampSlug()}-compile-commands`, 'compile_commands.json')
    : undefined
  if (!input.apply) {
    return {
      finding: 'compile-commands',
      applied: false,
      projectDir,
      command,
      ...backupPath === undefined ? {} : { backupPath },
      changedPaths: [database],
      rollback: existing ? `No change was made. A real run would back up ${database} first.` : 'No change was made.',
      verification: 'Run ide_verify with compileCommandsDir set to the build directory.',
      warnings: [],
    }
  }
  await ensureDir(buildDir)
  if (backupPath !== undefined) await copyFileEnsuringDir(database, backupPath)
  const result = await runCommand(cmake, args, {
    cwd: projectDir,
    timeoutMs: 180_000,
    signal: input.signal,
    maxBuffer: 4 * 1024 * 1024,
  })
  const warnings: string[] = []
  if (result.timedOut) warnings.push(`CMake did not finish within 180000ms; the command was terminated.`)
  if (result.exitCode !== 0) {
    throw new Error(`cmake configure failed with exit code ${String(result.exitCode)}: ${tail(result.stderr || result.stdout, 2_000)}`)
  }
  if (!await exists(database)) {
    throw new Error(`cmake succeeded but did not write ${database}; check that the generator supports compilation databases`)
  }
  const validation = await readCompileDatabase(database)
  if (validation.invalid > 0) warnings.push(`${validation.invalid} generated entr${validation.invalid === 1 ? 'y is' : 'ies are'} invalid; inspect with ide_diagnose.`)
  return {
    finding: 'compile-commands',
    applied: true,
    projectDir,
    command,
    ...backupPath === undefined ? {} : { backupPath },
    changedPaths: [database],
    output: tail([result.stdout, result.stderr].filter(Boolean).join('\n'), 4_000),
    rollback: backupPath === undefined
      ? `rm ${JSON.stringify(database)}`
      : `cp ${JSON.stringify(backupPath)} ${JSON.stringify(database)}`,
    verification: `Run ide_verify with compileCommandsDir=${JSON.stringify(buildDir)}. A successful clangd probe proves the language server can use the database; it does not prove your current IDE window has re-indexed.`,
    warnings,
  }
}

async function fixClangdConfig(projectDir: string, input: FixInput): Promise<FixResult> {
  const databaseDir = input.compileCommandsDir === undefined
    ? await pickDatabaseDir(projectDir)
    : resolve(projectDir, input.compileCommandsDir)
  if (databaseDir === undefined) {
    throw new Error('clangd-config fix needs compileCommandsDir; run ide_diagnose first to locate a valid compile_commands.json')
  }
  const database = join(databaseDir, 'compile_commands.json')
  if (!await exists(database)) {
    throw new Error(`no compile_commands.json in ${databaseDir}; generate one before writing .clangd`)
  }
  const target = join(projectDir, '.clangd')
  const previous = await readTextIfExists(target)
  const next = mergeClangdConfig(previous ?? '', databaseDir)
  const backupPath = previous === undefined
    ? undefined
    : join(input.config.stateDir, 'backups', `${timestampSlug()}-clangd-config`, '.clangd')
  if (!input.apply) {
    return {
      finding: 'clangd-config',
      applied: false,
      projectDir,
      ...backupPath === undefined ? {} : { backupPath },
      changedPaths: [target],
      diff: simpleDiff(previous ?? '', next),
      rollback: previous === undefined ? 'No prior .clangd exists; a real run would create it.' : `cp ${JSON.stringify(backupPath)} ${JSON.stringify(target)}`,
      verification: 'Run ide_verify; clangd should report the compilation database as loaded and return semantic tokens.',
      warnings: ['Values outside CompileFlags are preserved, but review the resulting .clangd before committing it.'],
    }
  }
  if (backupPath !== undefined) await copyFileEnsuringDir(target, backupPath)
  await writeTextAtomic(target, next, 0o600)
  return {
    finding: 'clangd-config',
    applied: true,
    projectDir,
    ...backupPath === undefined ? {} : { backupPath },
    changedPaths: [target],
    diff: simpleDiff(previous ?? '', next),
    rollback: previous === undefined
      ? `rm ${JSON.stringify(target)}`
      : `cp ${JSON.stringify(backupPath)} ${JSON.stringify(target)}`,
    verification: 'Run ide_verify. A green probe proves clangd behavior for this project, not that the already-open CLion/VS Code window re-indexed.',
    warnings: ['An already-running IDE may need its language server restarted before it observes the new .clangd.'],
  }
}

async function fixVscodePythonInterpreter(projectDir: string, input: FixInput): Promise<FixResult> {
  const target = join(projectDir, '.vscode', 'settings.json')
  const explicit = input.interpreterPath === undefined ? undefined : resolve(projectDir, input.interpreterPath)
  const candidates = explicit === undefined
    ? [join(projectDir, '.venv', 'bin', 'python'), join(projectDir, 'venv', 'bin', 'python')]
    : [explicit]
  const interpreter = await firstExisting(candidates)
  if (interpreter === undefined) {
    throw new Error(`vscode-python-interpreter needs an existing interpreter; tried ${candidates.join(', ')}`)
  }
  const previous = await readTextIfExists(target)
  if (previous !== undefined && /(^|[^:"'])\/\/|\/\*/.test(previous)) {
    throw new Error(`.vscode/settings.json contains JSONC comments; this build will not rewrite it. Set "python.defaultInterpreterPath" to ${JSON.stringify(interpreter)} manually.`)
  }
  let settings: Record<string, unknown> = {}
  if (previous !== undefined) {
    try {
      const parsed = JSON.parse(previous) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('settings.json must contain a JSON object')
      settings = parsed as Record<string, unknown>
    } catch (error) {
      throw new Error(`.vscode/settings.json is not valid pure JSON: ${error instanceof Error ? error.message : String(error)}. Fix it manually; this build will not overwrite it.`)
    }
  }
  const relativeInterpreter = relative(projectDir, interpreter)
  settings['python.defaultInterpreterPath'] = relativeInterpreter.startsWith('..') ? interpreter : `\${workspaceFolder}/${relativeInterpreter}`
  if (settings['python.terminal.activateEnvironment'] === undefined) settings['python.terminal.activateEnvironment'] = true
  if (settings['python.terminal.activateEnvInCurrentTerminal'] === undefined) settings['python.terminal.activateEnvInCurrentTerminal'] = true
  const next = `${JSON.stringify(settings, null, 2)}\n`
  const backupPath = previous === undefined
    ? undefined
    : join(input.config.stateDir, 'backups', `${timestampSlug()}-vscode-python-interpreter`, 'settings.json')
  if (!input.apply) {
    return {
      finding: 'vscode-python-interpreter',
      applied: false,
      projectDir,
      ...backupPath === undefined ? {} : { backupPath },
      changedPaths: [target],
      diff: simpleDiff(previous ?? '', next, '.vscode/settings.json'),
      rollback: previous === undefined ? 'No prior .vscode/settings.json exists; a real run would create it.' : `cp ${JSON.stringify(backupPath)} ${JSON.stringify(target)}`,
      verification: `Run ide_verify with language=python and interpreter=${JSON.stringify(interpreter)}. A successful Python probe proves the interpreter can import/compile the project; it does not prove the open VS Code window switched interpreters.`,
      warnings: [],
    }
  }
  if (backupPath !== undefined) await copyFileEnsuringDir(target, backupPath)
  await writeTextAtomic(target, next, 0o644)
  return {
    finding: 'vscode-python-interpreter',
    applied: true,
    projectDir,
    ...backupPath === undefined ? {} : { backupPath },
    changedPaths: [target],
    diff: simpleDiff(previous ?? '', next, '.vscode/settings.json'),
    rollback: previous === undefined
      ? `rm ${JSON.stringify(target)}`
      : `cp ${JSON.stringify(backupPath)} ${JSON.stringify(target)}`,
    verification: `Run ide_verify with language=python and interpreter=${JSON.stringify(interpreter)}. A green probe proves the interpreter/import, not that VS Code's Python extension has already switched.`,
    warnings: ['VS Code must reload the window or select the interpreter before the UI reflects this setting.'],
  }
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await exists(path)) return path
  }
  return undefined
}

function mergeClangdConfig(previous: string, databaseDir: string): string {
  const quoted = JSON.stringify(databaseDir)
  const lines = previous.replace(/\r\n/g, '\n').split('\n')
  const inlineCompileFlags = lines.findIndex(line => /^CompileFlags:\s*\S/.test(line))
  if (inlineCompileFlags >= 0) {
    throw new Error('.clangd uses an inline CompileFlags value; edit it manually to add CompilationDatabase (this build will not risk corrupting the existing YAML)')
  }
  const lineIndex = lines.findIndex(line => /^\s*CompilationDatabase:\s*/i.test(line))
  if (lineIndex >= 0) {
    lines[lineIndex] = `  CompilationDatabase: ${quoted}`
    return `${lines.join('\n').replace(/\n*$/, '')}\n`
  }
  const compileFlags = lines.findIndex(line => /^CompileFlags:\s*$/.test(line))
  if (compileFlags >= 0) {
    lines.splice(compileFlags + 1, 0, `  CompilationDatabase: ${quoted}`)
    return `${lines.join('\n').replace(/\n*$/, '')}\n`
  }
  const prefix = previous.trimEnd()
  return `${prefix.length === 0 ? '' : `${prefix}\n`}CompileFlags:\n  CompilationDatabase: ${quoted}\n`
}

async function pickBuildDir(projectDir: string): Promise<string> {
  for (const candidate of ['cmake-build-debug', 'cmake-build-release', 'build']) {
    if (await exists(join(projectDir, candidate, 'CMakeCache.txt'))) return candidate
  }
  return 'build'
}

async function pickDatabaseDir(projectDir: string): Promise<string | undefined> {
  const candidates = [
    join(projectDir, 'compile_commands.json'),
    join(projectDir, 'build', 'compile_commands.json'),
    join(projectDir, 'cmake-build-debug', 'compile_commands.json'),
    join(projectDir, 'cmake-build-release', 'compile_commands.json'),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) return resolve(candidate, '..')
  }
  return undefined
}

function isInside(parent: string, child: string): boolean {
  const root = resolve(parent)
  const target = resolve(child)
  return target === root || target.startsWith(`${root}/`)
}

function simpleDiff(before: string, after: string, label = '.clangd'): string {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const lines = [`--- ${label} (before)`, `+++ ${label} (after)`]
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1
  lines.push(`@@ after ${prefix} line(s) @@`)
  for (const line of beforeLines.slice(prefix, beforeLines.length - suffix)) lines.push(`-${line}`)
  for (const line of afterLines.slice(prefix, afterLines.length - suffix)) lines.push(`+${line}`)
  return lines.join('\n')
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(-maxChars)}`
}
