/** Bounded subprocess execution for IDE diagnostics and macOS queries. */

import { execFile } from 'node:child_process'

/** Result of one finished command. */
export interface CommandResult {
  command: string
  args: string[]
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  error?: string
}

/** Options for {@link runCommand}. */
export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

/**
 * Run a command without a shell and collect bounded output.
 * A timeout is reported as `timedOut: true` with the partial output.
 * @param command - executable path.
 * @param args - argument vector.
 * @param options - cwd, timeout, cancellation, environment.
 * @returns the completed command outcome.
 */
export function runCommand(command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 20_000
  return new Promise(resolve => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: timeoutMs,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        signal: options.signal,
        env: options.env ?? process.env,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const timedOut = error !== null && error !== undefined
          && (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
          && Date.now() - started >= timeoutMs - 50
        const exitCode = typeof error === 'object' && error !== null && 'code' in error
          && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error === null || error === undefined ? 0 : null
        resolve({
          command,
          args: [...args],
          exitCode,
          signal: typeof error === 'object' && error !== null && 'signal' in error
            && typeof (error as { signal?: unknown }).signal === 'string'
            ? (error as { signal: string }).signal
            : null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut,
          durationMs: Date.now() - started,
          ...error === null || error === undefined ? {} : { error: error.message },
        })
      },
    )
  })
}
