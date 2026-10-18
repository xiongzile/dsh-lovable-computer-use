/** Chromium process lifecycle: spawn, DevTools discovery, and bounded shutdown. */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { lstat, readFile, readlink, rm } from 'node:fs/promises'
import { setPriority } from 'node:os'
import { join } from 'node:path'
import { findExecutable, isProcessAlive } from '../util/fs.js'
import { chromeCandidates, type ResolvedConfig } from '../config.js'
import { runCommand } from '../util/exec.js'
import type { Logger } from '../util/log.js'

/** A launched Chromium process with its DevTools endpoint. */
export interface LaunchedChrome {
  readonly child: ChildProcess
  readonly port: number
  readonly browserVersion: string
  readonly logPath: string
  readonly executable: string
}

/** Inputs for one launch. */
export interface LaunchChromeOptions {
  readonly executable: string
  readonly profileDir: string
  readonly logPath: string
  readonly headless: boolean
  readonly noSandbox: boolean
  readonly config: ResolvedConfig
  readonly logger: Logger
  readonly signal?: AbortSignal
}

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']

/** Resolve the Chromium-family executable used by the isolated browser. */
export async function resolveChrome(config: ResolvedConfig): Promise<string> {
  if (config.chromePath !== undefined) {
    const explicit = await findExecutable(config.chromePath, [config.chromePath], '')
    if (explicit === undefined) {
      throw new Error(`configured chromePath is not executable: ${config.chromePath}`)
    }
    return explicit
  }
  const found = await findExecutable('google-chrome', chromeCandidates())
  if (found === undefined) {
    throw new Error(
      'no Chromium-family browser found. Install Google Chrome, Chromium, or Edge, or set config.chromePath to an absolute executable path.',
    )
  }
  return found
}

/**
 * Launch an isolated browser and wait until its debugging endpoint answers.
 * The profile directory is exclusively owned by the caller; stale Chromium
 * singleton links from an earlier crash are cleared only before launch.
 * @param options - executable, profile, mode, and budgets.
 * @returns the running process and endpoint.
 */
export async function launchChrome(options: LaunchChromeOptions): Promise<LaunchedChrome> {
  const { profileDir, logPath, headless, config } = options
  await rm(join(profileDir, 'DevToolsActivePort'), { force: true })
  for (const singleton of SINGLETON_FILES) {
    const path = join(profileDir, singleton)
    if (await staleSingleton(path)) await rm(path, { force: true })
  }

  const args = [
    ...headless ? ['--headless=new'] : [],
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-crash-reporter',
    '--disable-breakpad',
    `--crash-dumps-dir=${join(profileDir, 'crash-dumps')}`,
    '--noerrdialogs',
    '--renderer-process-limit=2',
    '--js-flags=--max-old-space-size=512',
    `--window-size=${headless ? '1440,900' : '1280,900'}`,
    ...headless ? ['--disable-gpu'] : ['--new-window'],
    ...options.noSandbox ? ['--no-sandbox'] : [],
    'about:blank',
  ]

  const logFd = openSync(logPath, 'a', 0o600)
  const child = spawn(options.executable, args, {
    stdio: ['ignore', logFd, logFd],
    detached: false,
    env: process.env,
  })
  closeSync(logFd)
  if (child.pid !== undefined) {
    try {
      // Lower the browser's scheduling priority so a background page does not
      // compete with the user's foreground IDE or build.
      setPriority(child.pid, 10)
    } catch {
      // Not all platforms permit priority changes; the process still runs.
    }
  }
  const spawned = new Promise<never>((_, reject) => {
    child.once('error', error => reject(new Error(`Chromium failed to spawn: ${error.message}`)))
    child.once('exit', code => reject(new Error(`Chromium exited during startup with code ${String(code)}: ${''}`)))
  })
  // The exit branch above may win the race; attach a no-op handler so Node does
  // not report the rejected race promise as unhandled after a successful launch.
  spawned.catch(() => undefined)

  try {
    const port = await Promise.race([
      waitForDevToolsPort(profileDir, child, logPath, config.navigationTimeoutMs, options.signal),
      spawned,
    ])
    const version = await readBrowserVersion(port, options.signal)
    options.logger.debug('Chromium process is listening', {
      mode: headless ? 'headless' : 'headed',
      port,
      version,
      profileDir,
    })
    return { child, port, browserVersion: version, logPath, executable: options.executable }
  } catch (error) {
    await stopChrome(child, 2_000)
    throw error
  }
}

async function staleSingleton(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    let target: string
    if (info.isSymbolicLink()) {
      target = await readlink(path)
    } else {
      target = await readFile(path, 'utf8')
    }
    const parts = target.trim().split(/[-:\n]/)
    const pid = Number.parseInt(parts[parts.length - 1] ?? '', 10)
    if (Number.isInteger(pid) && pid > 0) return !isProcessAlive(pid)
    return true
  } catch {
    return false
  }
}

async function waitForDevToolsPort(
  profileDir: string,
  child: ChildProcess,
  logPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  const portFile = join(profileDir, 'DevToolsActivePort')
  while (Date.now() < deadline) {
    if (signal?.aborted === true) {
      child.kill('SIGTERM')
      throw new Error('browser launch cancelled')
    }
    if (child.exitCode !== null) {
      throw new Error(`Chromium exited during startup with code ${String(child.exitCode)}: ${await logTail(logPath)}`)
    }
    try {
      const text = await readFile(portFile, 'utf8')
      const port = Number.parseInt(text.split('\n')[0] ?? '', 10)
      if (Number.isInteger(port) && port > 0) return port
    } catch {
      // Chrome writes this file after the socket is listening; keep waiting.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill('SIGKILL')
  throw new Error(`Chromium did not expose a DevTools port within ${timeoutMs}ms: ${await logTail(logPath)}`)
}

async function readBrowserVersion(port: number, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new Error('browser launch cancelled')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal })
      if (response.ok) {
        const payload = await response.json() as { Browser?: unknown }
        return typeof payload.Browser === 'string' ? payload.Browser : 'chromium'
      }
    } catch {
      // The HTTP endpoint can lag the port file by one event-loop turn.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Chromium DevTools endpoint on port ${port} did not answer`)
}

/** Create a page target and return its WebSocket URL. */
export async function createTarget(port: number, url: string, signal?: AbortSignal): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    signal,
  })
  if (!response.ok) {
    throw new Error(`could not create a page target: HTTP ${response.status} ${await response.text()}`)
  }
  const payload = await response.json() as { id?: unknown; webSocketDebuggerUrl?: unknown }
  if (typeof payload.id !== 'string' || typeof payload.webSocketDebuggerUrl !== 'string') {
    throw new Error('DevTools /json/new returned an unexpected payload')
  }
  return { id: payload.id, webSocketDebuggerUrl: payload.webSocketDebuggerUrl }
}

/**
 * Wait for a process to exit without signalling it.
 * @param child - process to observe.
 * @param timeoutMs - upper bound.
 * @returns whether it exited within the budget.
 */
export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise(resolve => {
    let settled = false
    const onExit = (): void => finish(true)
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs)
    child.once('exit', onExit)
  })
}

/**
 * Stop a browser process with a bounded TERM/KILL sequence.
 * @param child - launched process.
 * @param graceMs - wait before SIGKILL.
 */
export async function stopChrome(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve()
    }
    child.once('exit', finish)
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may have exited between the check and the signal.
      }
      finish()
    }, graceMs)
    try {
      child.kill('SIGTERM')
    } catch {
      finish()
    }
  })
}

/** Let Chromium flush the profile before the next process opens it. */
export async function settleProfile(profileDir: string): Promise<void> {
  for (const singleton of SINGLETON_FILES) {
    await rm(join(profileDir, singleton), { force: true })
  }
  await rm(join(profileDir, 'DevToolsActivePort'), { force: true })
}

/** Chromium's stderr tail, used to explain launch failures. */
export async function logTail(path: string, maxChars = 4_000): Promise<string> {
  try {
    const text = await readFile(path, 'utf8')
    return text.slice(-maxChars).trim()
  } catch {
    return '(no Chromium log)'
  }
}

/** Read the process's RSS/CPU on macOS/Linux when available; best effort only. */
export async function readProcessFootprint(pid: number, signal?: AbortSignal): Promise<string | undefined> {
  const result = await runCommand('/bin/ps', ['-o', 'rss=,pcpu=,comm=', '-p', String(pid)], {
    timeoutMs: 3_000,
    signal,
  })
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim() || undefined
}
