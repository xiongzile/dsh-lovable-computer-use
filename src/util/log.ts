/** Append-only operational log. Task records are the durable product state; this log is for diagnosis. */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LogLevel } from '../config.js'

const LEVEL_WEIGHT: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 }

/** Redact common secret-bearing command-line and URL patterns before logging. */
export function redact(text: string): string {
  return text
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1[REDACTED]')
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
}

/** Minimal structured logger writing JSON lines to one file. */
export class Logger {
  constructor(private readonly file: string, private readonly level: LogLevel) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    } catch {
      // Logging is best-effort; the plugin still reports failures through tools.
    }
  }

  /** Write an informational event. */
  info(message: string, data?: Record<string, unknown>): void {
    this.write('info', message, data)
  }

  /** Write a recoverable failure or surprising state. */
  warn(message: string, data?: Record<string, unknown>): void {
    this.write('error', message, data)
  }

  /** Write an error. */
  error(message: string, data?: Record<string, unknown>): void {
    this.write('error', message, data)
  }

  /** Write verbose detail. */
  debug(message: string, data?: Record<string, unknown>): void {
    this.write('debug', message, data)
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[this.level]) return
    try {
      appendFileSync(this.file, `${JSON.stringify({
        time: new Date().toISOString(),
        level,
        message: redact(message),
        ...data === undefined ? {} : { data: JSON.parse(redact(JSON.stringify(data))) as unknown },
      })}\n`, { mode: 0o600 })
    } catch {
      // A full disk or a removed state directory must not break a running tool.
    }
  }
}
