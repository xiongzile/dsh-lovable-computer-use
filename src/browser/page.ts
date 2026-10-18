/** One isolated page target: navigation, snapshots, DOM actions, and screenshots. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CdpConnection } from './cdp.js'
import { actInPage, snapshotInPage, waitInPage, type PageSnapshot } from './injected.js'
import { sleep, throwIfAborted } from '../util/async.js'
import type { Logger } from '../util/log.js'

/** Result of one action dispatched in the page. */
export interface PageActionResult {
  ok: boolean
  url: string
  tag?: string
  value?: string
  submitted?: boolean
  error?: string
  note?: string
}

/** Screenshot metadata returned to tools. */
export interface ScreenshotResult {
  path: string
  bytes: number
  url: string
  title: string
}

const KEY_TABLE: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

/** A page target with request budgeting and cancellation forwarding. */
export class Page {
  constructor(
    private readonly cdp: CdpConnection,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  /** Enable the domains needed by every operation and configure downloads. */
  async initialize(downloadsDir: string): Promise<void> {
    await this.cdp.send('Page.enable')
    await this.cdp.send('Runtime.enable')
    try {
      await this.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir })
    } catch (error) {
      this.logger.debug('Page.setDownloadBehavior unavailable', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Evaluate an expression in the main frame.
   * @param expression - JavaScript expression.
   * @param options - timeout and cancellation.
   * @returns the JSON value of the expression.
   */
  async evaluate<T = unknown>(expression: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const response = await this.cdp.send<{
      result?: { type?: string; value?: unknown; description?: string; subtype?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } }
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: options.timeoutMs ?? this.timeoutMs,
    }, options.timeoutMs ?? this.timeoutMs, options.signal)
    if (response.exceptionDetails !== undefined) {
      const detail = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? 'page evaluation failed'
      throw new Error(detail)
    }
    return response.result?.value as T
  }

  /**
   * Navigate and wait for the document to settle.
   * @param url - http, https, or about:blank.
   * @param timeoutMs - navigation budget.
   * @param signal - caller cancellation.
   */
  async navigate(url: string, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const response = await this.cdp.send<{ errorText?: string; frameId?: string }>('Page.navigate', { url }, timeoutMs, signal)
    if (response.errorText !== undefined && response.errorText.length > 0) {
      throw new Error(`navigation failed: ${response.errorText}`)
    }
    await this.waitForReady(timeoutMs, signal)
  }

  /** Wait until `document.readyState` is complete (or interactive with a body). */
  async waitForReady(timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      try {
        const ready = await this.evaluate<{ state?: string; body?: boolean }>(
          '({ state: document.readyState, body: document.body !== null })',
          { timeoutMs: 2_000, signal },
        )
        if ((ready.state === 'complete' || ready.state === 'interactive') && ready.body === true) {
          await sleep(100, signal)
          return
        }
      } catch (error) {
        if (signal?.aborted === true) throw error
        // Navigation replaces the execution context; retry until the deadline.
      }
      await sleep(100, signal)
    }
    throw new Error(`page did not finish loading within ${timeoutMs}ms`)
  }

  /** Wait for a selector or for body text, polling the page. */
  async waitFor(selector: string, text: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      try {
        const found = await this.evaluate<boolean>(`(${waitInPage.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(text)})`, {
          timeoutMs: 2_000,
          signal,
        })
        if (found === true) return true
      } catch (error) {
        if (signal?.aborted === true) throw error
        // The document may be replacing its execution context; retry.
      }
      await sleep(200, signal)
    }
    return false
  }

  /** Take a structured snapshot of the visible page. */
  async snapshot(maxChars: number, maxRefs: number, signal?: AbortSignal): Promise<PageSnapshot> {
    const code = `(${snapshotInPage.toString()})(${Math.trunc(maxChars)}, ${Math.trunc(maxRefs)})`
    const snapshot = await this.evaluate<PageSnapshot>(code, { signal })
    return snapshot
  }

  /** Dispatch one DOM action. */
  async act(action: string, ref: string, text: string, submit: boolean, signal?: AbortSignal): Promise<PageActionResult> {
    const code = `(${actInPage.toString()})(${JSON.stringify(action)}, ${JSON.stringify(ref)}, ${JSON.stringify(text)}, ${submit ? 'true' : 'false'})`
    return this.evaluate<PageActionResult>(code, { signal })
  }

  /** Send one keyboard event into the focused element. */
  async press(keyName: string, signal?: AbortSignal): Promise<{ key: string; dispatched: boolean }> {
    const entry = KEY_TABLE[keyName]
    if (entry === undefined) {
      throw new Error(`unsupported key ${JSON.stringify(keyName)}; supported: ${Object.keys(KEY_TABLE).join(', ')}`)
    }
    const base = {
      key: entry.key,
      code: entry.code,
      windowsVirtualKeyCode: entry.keyCode,
      nativeVirtualKeyCode: entry.keyCode,
    }
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...base,
      ...entry.text === undefined ? {} : { text: entry.text },
    }, this.timeoutMs, signal)
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.timeoutMs, signal)
    return { key: keyName, dispatched: true }
  }

  /** Capture a PNG into the artifact directory. */
  async screenshot(artifactsDir: string, profileKey: string, signal?: AbortSignal): Promise<ScreenshotResult> {
    const response = await this.cdp.send<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    }, this.timeoutMs, signal)
    if (typeof response.data !== 'string') throw new Error('Page.captureScreenshot returned no data')
    const directory = join(artifactsDir, profileKey)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    const bytes = Buffer.from(response.data, 'base64')
    await writeFile(path, bytes, { mode: 0o600 })
    const [url, title] = await Promise.all([
      this.evaluate<string>('location.href', { signal }).catch(() => ''),
      this.evaluate<string>('document.title', { signal }).catch(() => ''),
    ])
    return { path, bytes: bytes.length, url: String(url), title: String(title) }
  }

  /** Current URL, or an empty string when the context is being replaced. */
  async currentUrl(signal?: AbortSignal): Promise<string> {
    try {
      return String(await this.evaluate<string>('location.href', { signal }))
    } catch {
      return ''
    }
  }

  /** Ask Chromium to shut down cleanly so cookies and local storage are flushed. */
  async closeBrowser(): Promise<void> {
    try {
      await this.cdp.send('Browser.close', {}, 3_000)
    } catch {
      // The browser may already be gone or the socket may close first.
    }
  }

  /** Close the CDP transport. */
  close(): void {
    this.cdp.close()
  }
}
