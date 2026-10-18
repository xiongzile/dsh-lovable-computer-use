/** Non-focus-stealing user notification. */

import { runCommand } from './exec.js'

/** Whether macOS notification delivery is available. */
export function notificationsAvailable(): boolean {
  return process.platform === 'darwin'
}

/**
 * Show a macOS notification. `display notification` does not activate an app or
 * change the frontmost window; it is safe while the user works elsewhere.
 * @param title - short title.
 * @param message - one or two lines.
 * @param timeoutMs - osascript budget.
 * @returns delivery outcome.
 */
export async function notifyUser(title: string, message: string, timeoutMs = 5_000): Promise<{ delivered: boolean; error?: string }> {
  if (!notificationsAvailable()) return { delivered: false, error: 'macOS notifications are unavailable on this platform' }
  const safeTitle = title.slice(0, 200)
  const safeMessage = message.slice(0, 1_000)
  const script = `display notification ${JSON.stringify(safeMessage)} with title ${JSON.stringify(safeTitle)}`
  const result = await runCommand('/usr/bin/osascript', ['-e', script], { timeoutMs, maxBuffer: 64 * 1024 })
  if (result.exitCode !== 0) {
    return { delivered: false, error: (result.stderr || result.error || 'osascript failed').trim().slice(0, 500) }
  }
  return { delivered: true }
}
