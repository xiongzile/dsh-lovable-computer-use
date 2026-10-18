/** Deployment configuration for the plugin. Every tunable is a validated config field. */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { harnessHome } from './util/fs.js'

/** Supported operational log levels. */
export type LogLevel = 'error' | 'info' | 'debug'

/** Resolved plugin configuration. */
export interface ResolvedConfig {
  /** Absolute directory for browser profiles, artifacts, backups, and logs. */
  readonly stateDir: string
  /** Explicit Chromium/Chrome executable; otherwise discovered. */
  readonly chromePath?: string
  /** Maximum concurrently live isolated browser processes. */
  readonly maxProfiles: number
  /** Close an idle browser after this many milliseconds; 0 keeps it open. */
  readonly idleCloseMs: number
  /** Page navigation budget in milliseconds. */
  readonly navigationTimeoutMs: number
  /** Per-request CDP and page-action budget in milliseconds. */
  readonly actionTimeoutMs: number
  /** Cross-process profile-lock wait budget in milliseconds. */
  readonly lockWaitMs: number
  /** Allow the explicit human-handoff path to open an isolated visible Chrome window. */
  readonly headedHandoff: boolean
  /** Deliver a macOS notification when a handoff is requested. */
  readonly notifications: boolean
  /** Focus polling interval for focus_guard_start. */
  readonly focusIntervalMs: number
  /** Maximum page text returned by a snapshot. */
  readonly maxSnapshotChars: number
  /** Maximum interactive controls returned by a snapshot. */
  readonly maxSnapshotRefs: number
  /**
   * Chromium sandbox policy: `auto` tries Chromium's own sandbox and visibly
   * falls back to `--no-sandbox` when the host sandbox prevents it; `required`
   * fails instead; `disabled` always launches without the browser sandbox.
   */
  readonly chromeSandbox: 'auto' | 'required' | 'disabled'
  /** Explicit clangd executable; otherwise discovered. */
  readonly clangdPath?: string
  /** Permit ide_fix to write outside the session workspace. Defaults to false. */
  readonly allowOutsideWorkspaceWrites: boolean
  /** Explicit cmake executable; otherwise discovered. */
  readonly cmakePath?: string
  /** Operational log level. */
  readonly logLevel: LogLevel
}

const ALLOWED_KEYS = new Set([
  'stateDir',
  'chromePath',
  'maxProfiles',
  'idleCloseMs',
  'navigationTimeoutMs',
  'actionTimeoutMs',
  'lockWaitMs',
  'headedHandoff',
  'notifications',
  'focusIntervalMs',
  'maxSnapshotChars',
  'maxSnapshotRefs',
  'chromeSandbox',
  'clangdPath',
  'cmakePath',
  'allowOutsideWorkspaceWrites',
  'logLevel',
])

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`lovable-computer-use config.${key} must be a non-empty string`)
  }
  return value
}

function readAbsolutePath(record: Record<string, unknown>, key: string): string | undefined {
  const value = readString(record, key)
  if (value === undefined) return undefined
  if (!isAbsolute(value)) throw new Error(`lovable-computer-use config.${key} must be an absolute path, got ${JSON.stringify(value)}`)
  return resolve(value)
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = record[key]
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`lovable-computer-use config.${key} must be an integer in [${minimum}, ${maximum}]`)
  }
  return value
}

function readBoolean(record: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  const value = record[key]
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') throw new Error(`lovable-computer-use config.${key} must be a boolean`)
  return value
}

/**
 * Resolve and validate the plugin's loader configuration.
 * @param raw - raw `config` value from the Cordis loader entry.
 * @returns the complete resolved configuration.
 * @throws when an unknown key, wrong type, or out-of-range value is present.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('lovable-computer-use config must be an object')
  }
  const record = raw === undefined || raw === null ? {} : asRecord(raw, 'lovable-computer-use config')
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`lovable-computer-use config has unknown key ${JSON.stringify(key)}; known keys: ${[...ALLOWED_KEYS].join(', ')}`)
    }
  }
  const stateDir = readAbsolutePath(record, 'stateDir') ?? join(harnessHome(), 'lovable-computer-use')
  const logLevel = readString(record, 'logLevel') ?? 'info'
  if (!['error', 'info', 'debug'].includes(logLevel)) {
    throw new Error('lovable-computer-use config.logLevel must be one of error, info, debug')
  }
  return {
    stateDir,
    ...readAbsolutePath(record, 'chromePath') === undefined ? {} : { chromePath: readAbsolutePath(record, 'chromePath') as string },
    maxProfiles: readInteger(record, 'maxProfiles', 4, 1, 32),
    idleCloseMs: readInteger(record, 'idleCloseMs', 30 * 60_000, 0, 24 * 60 * 60_000),
    navigationTimeoutMs: readInteger(record, 'navigationTimeoutMs', 30_000, 1_000, 10 * 60_000),
    actionTimeoutMs: readInteger(record, 'actionTimeoutMs', 20_000, 1_000, 10 * 60_000),
    lockWaitMs: readInteger(record, 'lockWaitMs', 5_000, 0, 10 * 60_000),
    headedHandoff: readBoolean(record, 'headedHandoff', true),
    notifications: readBoolean(record, 'notifications', true),
    focusIntervalMs: readInteger(record, 'focusIntervalMs', 1_000, 250, 60_000),
    maxSnapshotChars: readInteger(record, 'maxSnapshotChars', 20_000, 1_000, 200_000),
    maxSnapshotRefs: readInteger(record, 'maxSnapshotRefs', 200, 10, 2_000),
    chromeSandbox: readChromeSandbox(record),
    allowOutsideWorkspaceWrites: readBoolean(record, 'allowOutsideWorkspaceWrites', false),
    ...readAbsolutePath(record, 'clangdPath') === undefined ? {} : { clangdPath: readAbsolutePath(record, 'clangdPath') as string },
    ...readAbsolutePath(record, 'cmakePath') === undefined ? {} : { cmakePath: readAbsolutePath(record, 'cmakePath') as string },
    logLevel: logLevel as LogLevel,
  }
}

function readChromeSandbox(record: Record<string, unknown>): 'auto' | 'required' | 'disabled' {
  const value = readString(record, 'chromeSandbox') ?? 'auto'
  if (!['auto', 'required', 'disabled'].includes(value)) {
    throw new Error('lovable-computer-use config.chromeSandbox must be one of auto, required, disabled')
  }
  return value as 'auto' | 'required' | 'disabled'
}

/** Known locations for a Chromium-family browser on macOS and common Linux installs. */
export function chromeCandidates(): string[] {
  const home = homedir()
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
}

/** Known locations for clangd. */
export function clangdCandidates(): string[] {
  const home = homedir()
  return [
    '/opt/homebrew/opt/llvm/bin/clangd',
    '/usr/local/opt/llvm/bin/clangd',
    '/usr/bin/clangd',
    join(home, '.local/bin/clangd'),
    '/Library/Developer/CommandLineTools/usr/bin/clangd',
    '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd',
  ]
}
