/** Bounded project-level runtime checks that complement an LSP probe. */

import { basename, join, resolve } from 'node:path'
import { access, constants } from 'node:fs/promises'
import { runCommand } from '../util/exec.js'
import { findExecutable, statIfExists } from '../util/fs.js'
import type { IdeLanguage } from './servers.js'

/** How aggressively to run project-level checks. */
export type RuntimeCheckMode = 'auto' | 'force' | 'off'

/** Input for one runtime check. */
export interface RuntimeCheckInput {
  projectDir: string
  language: IdeLanguage
  sourceFile?: string
  /** Python import target, e.g. `vllm` or `my_package`. */
  module?: string
  /** Explicit Python interpreter; otherwise `.venv/bin/python` is discovered. */
  interpreter?: string
  mode: RuntimeCheckMode
  timeoutMs: number
  signal?: AbortSignal
}

/** Outcome of one runtime check. */
export interface RuntimeCheckResult {
  status: 'passed' | 'failed' | 'skipped'
  kind: string
  command?: string
  exitCode?: number | null
  durationMs: number
  detail: string
  stdoutTail?: string
  stderrTail?: string
}

/**
 * Run a small, bounded project check without opening an editor or taking over
 * the desktop. `auto` only runs cheap checks (Python syntax/import); `force`
 * also runs cargo/go/tsc checks; `off` never runs a project command.
 */
export async function runRuntimeCheck(input: RuntimeCheckInput): Promise<RuntimeCheckResult> {
  if (input.mode === 'off') return skipped('runtimeCheck=off')
  const started = Date.now()
  switch (input.language) {
    case 'python': return checkPython(input, started)
    case 'rust': return checkRust(input, started)
    case 'go': return checkGo(input, started)
    case 'typescript':
    case 'javascript': return checkTypeScript(input, started)
    case 'c':
    case 'cpp':
    case 'objective-c':
      return skipped('C/C++ semantic verification is the live clangd probe; no separate build was run')
    default:
      return skipped(`no runtime check adapter for language ${input.language}`)
  }
}

async function checkPython(input: RuntimeCheckInput, started: number): Promise<RuntimeCheckResult> {
  if (input.sourceFile === undefined && input.module === undefined) {
    return skipped('Python runtime check needs a sourceFile or module')
  }
  const interpreter = input.interpreter ?? await findPythonInterpreter(input.projectDir)
  if (interpreter === undefined) return { ...skipped('no Python interpreter found (.venv/bin/python, venv/bin/python, python3)'), durationMs: Date.now() - started }
  if (!/^python(\d+(\.\d+)*)?(\.exe)?$/i.test(basename(interpreter))) {
    return { ...skipped(`refusing to run non-Python interpreter: ${interpreter}`), durationMs: Date.now() - started }
  }
  if (input.module !== undefined && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(input.module)) {
    return { ...skipped(`invalid Python module name: ${input.module}`), durationMs: Date.now() - started }
  }
  const runs: Array<{ label: string; args: string[]; timeoutMs: number }> = []
  if (input.sourceFile !== undefined) {
    runs.push({ label: 'py_compile', args: ['-m', 'py_compile', resolve(input.sourceFile)], timeoutMs: Math.min(input.timeoutMs, 30_000) })
  }
  if (input.module !== undefined) {
    runs.push({
      label: `import ${input.module}`,
      args: ['-c', `import importlib; importlib.import_module(${JSON.stringify(input.module)})`],
      timeoutMs: Math.min(input.timeoutMs, 60_000),
    })
  }
  const outputs: string[] = []
  for (const run of runs) {
    const result = await runCommand(interpreter, run.args, {
      cwd: input.projectDir,
      timeoutMs: run.timeoutMs,
      ...input.signal === undefined ? {} : { signal: input.signal },
    })
    const passed = result.exitCode === 0 && !result.timedOut
    if (!passed) {
      return {
        status: 'failed',
        kind: 'python',
        command: `${interpreter} ${run.args.join(' ')}`,
        exitCode: result.exitCode,
        durationMs: Date.now() - started,
        detail: `${run.label} failed${result.timedOut ? ' (timeout)' : ''}: ${firstLine(result.stderr) || firstLine(result.stdout) || 'no output'}`,
        ...tail(result.stdout) === undefined ? {} : { stdoutTail: tail(result.stdout) },
        ...tail(result.stderr) === undefined ? {} : { stderrTail: tail(result.stderr) },
      }
    }
    outputs.push(`${run.label}: ok`)
  }
  return {
    status: 'passed',
    kind: 'python',
    command: runs.map(run => `${interpreter} ${run.args.join(' ')}`).join(' && '),
    exitCode: 0,
    durationMs: Date.now() - started,
    detail: `Python checks passed: ${outputs.join('; ')}`,
  }
}

async function checkRust(input: RuntimeCheckInput, started: number): Promise<RuntimeCheckResult> {
  if (input.mode === 'auto') return { ...skipped('Rust cargo check is opt-in; pass runtimeCheck=force'), durationMs: Date.now() - started }
  if (await statIfExists(join(input.projectDir, 'Cargo.toml')) === undefined) {
    return { ...skipped('no Cargo.toml in projectDir'), durationMs: Date.now() - started }
  }
  const cargo = await findExecutable('cargo', [join(process.env.HOME ?? '', '.cargo', 'bin', 'cargo')])
  if (cargo === undefined) return { ...skipped('cargo not found'), durationMs: Date.now() - started }
  const result = await runCommand(cargo, ['check', '--quiet'], {
    cwd: input.projectDir,
    timeoutMs: input.timeoutMs,
    ...input.signal === undefined ? {} : { signal: input.signal },
  })
  return commandResult('rust', cargo, ['check', '--quiet'], result, started)
}

async function checkGo(input: RuntimeCheckInput, started: number): Promise<RuntimeCheckResult> {
  if (input.mode === 'auto') return { ...skipped('Go build is opt-in; pass runtimeCheck=force'), durationMs: Date.now() - started }
  if (await statIfExists(join(input.projectDir, 'go.mod')) === undefined) {
    return { ...skipped('no go.mod in projectDir'), durationMs: Date.now() - started }
  }
  const go = await findExecutable('go', ['/opt/homebrew/bin/go', '/usr/local/go/bin/go'])
  if (go === undefined) return { ...skipped('go not found'), durationMs: Date.now() - started }
  const result = await runCommand(go, ['build', './...'], {
    cwd: input.projectDir,
    timeoutMs: input.timeoutMs,
    ...input.signal === undefined ? {} : { signal: input.signal },
  })
  return commandResult('go', go, ['build', './...'], result, started)
}

async function checkTypeScript(input: RuntimeCheckInput, started: number): Promise<RuntimeCheckResult> {
  if (input.mode === 'auto') return { ...skipped('tsc is opt-in; pass runtimeCheck=force'), durationMs: Date.now() - started }
  if (await statIfExists(join(input.projectDir, 'tsconfig.json')) === undefined) {
    return { ...skipped('no tsconfig.json in projectDir'), durationMs: Date.now() - started }
  }
  const local = join(input.projectDir, 'node_modules', '.bin', 'tsc')
  const executable = await runnable(local) ? local : await findExecutable('tsc', ['/opt/homebrew/bin/tsc'])
  if (executable === undefined) return { ...skipped('tsc not found'), durationMs: Date.now() - started }
  const result = await runCommand(executable, ['--noEmit'], {
    cwd: input.projectDir,
    timeoutMs: input.timeoutMs,
    ...input.signal === undefined ? {} : { signal: input.signal },
  })
  return commandResult('typescript', executable, ['--noEmit'], result, started)
}

function commandResult(
  kind: string,
  command: string,
  args: string[],
  result: Awaited<ReturnType<typeof runCommand>>,
  started: number,
): RuntimeCheckResult {
  const passed = result.exitCode === 0 && !result.timedOut
  return {
    status: passed ? 'passed' : 'failed',
    kind,
    command: `${command} ${args.join(' ')}`,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    detail: passed
      ? `${kind} check passed.`
      : `${kind} check failed${result.timedOut ? ' (timeout)' : ''}: ${firstLine(result.stderr) || firstLine(result.stdout) || 'no output'}`,
    ...tail(result.stdout) === undefined ? {} : { stdoutTail: tail(result.stdout) },
    ...tail(result.stderr) === undefined ? {} : { stderrTail: tail(result.stderr) },
  }
}

async function findPythonInterpreter(projectDir: string): Promise<string | undefined> {
  const candidates = [
    join(projectDir, '.venv', 'bin', 'python'),
    join(projectDir, 'venv', 'bin', 'python'),
    join(projectDir, '.venv', 'bin', 'python3'),
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/usr/bin/python3',
  ]
  for (const candidate of candidates) {
    if (await runnable(candidate)) return candidate
  }
  return findExecutable('python3', [])
}

async function runnable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function skipped(detail: string): RuntimeCheckResult {
  return { status: 'skipped', kind: 'none', durationMs: 0, detail }
}

function firstLine(text: string): string {
  return (text.split('\n').find(line => line.trim().length > 0) ?? '').trim().slice(0, 300)
}

function tail(text: string): string | undefined {
  const trimmed = text.trim()
  return trimmed.length === 0 ? undefined : trimmed.slice(-2_000)
}
