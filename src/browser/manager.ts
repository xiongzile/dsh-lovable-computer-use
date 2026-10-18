/** Isolated browser environments keyed by an explicit site/account profile. */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResolvedConfig } from '../config.js'
import { KeyedQueue, throwIfAborted } from '../util/async.js'
import {
  createExclusive,
  ensureDir,
  exists,
  isProcessAlive,
  readJsonIfExists,
  readTextIfExists,
  removeIfExists,
  statIfExists,
  timestampSlug,
  writeJsonAtomic,
} from '../util/fs.js'
import type { Logger } from '../util/log.js'
import { CdpConnection } from './cdp.js'
import { Page, type PageActionResult, type ScreenshotResult } from './page.js'
import type { PageSnapshot } from './injected.js'
import {
  createTarget,
  launchChrome,
  logTail,
  readProcessFootprint,
  resolveChrome,
  settleProfile,
  stopChrome,
  waitForExit,
  type LaunchedChrome,
} from './chromium.js'

const PROFILE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/** Reject a profile key that could escape the profile root or collide with internal names. */
export function normalizeProfileKey(input: string): string {
  const key = input.trim()
  if (!PROFILE_KEY.test(key) || key === '..' || key === '.') {
    throw new Error(
      `profile must match ${PROFILE_KEY.source} (letters, digits, dot, underscore, dash; max 64); got ${JSON.stringify(input)}`,
    )
  }
  return key
}

/** One live isolated browser. */
interface Environment {
  readonly key: string
  readonly profileRoot: string
  readonly userDataDir: string
  readonly downloadsDir: string
  readonly logPath: string
  readonly mode: 'headless' | 'headed'
  readonly sandbox: 'chrome' | 'disabled' | 'disabled-fallback'
  readonly launched: LaunchedChrome
  readonly page: Page
  lastUrl: string
  lastUsed: number
  busy: number
  pinned: boolean
  idleTimer: NodeJS.Timeout | undefined
  closed: boolean
}

/** Public description of one persistent profile. */
export interface BrowserProfileInfo {
  profile: string
  profileDir: string
  downloadsDir: string
  inUse: boolean
  mode?: 'headless' | 'headed'
  pid?: number
  startedAt?: string
  hasLoginState: boolean
  downloads: number
  logPath: string
}

/** Result of opening or reusing a profile. */
export interface OpenBrowserResult {
  profile: string
  mode: 'headless' | 'headed'
  sandbox: 'chrome' | 'disabled' | 'disabled-fallback'
  reused: boolean
  pid: number
  url: string
  title: string
  browserVersion: string
  profileDir: string
  downloadsDir: string
  snapshot: PageSnapshot
}

/** Result of a page action plus the fresh observation. */
export interface ActBrowserResult extends OpenBrowserResult {
  action: PageActionResult
}

interface LockPayload {
  /** Owning DSH process; this is the identity checked by other processes. */
  pid: number
  /** Chromium process for this profile, when launched. */
  chromePid?: number
  port: number
  mode: 'headless' | 'headed'
  startedAt: string
  app: 'dsh-lovable-computer-use'
}

/**
 * Owns every isolated browser process, its cross-process profile lock, and its
 * per-profile serialization. Only explicit handoff may launch a visible window.
 */
export class BrowserManager {
  private readonly environments = new Map<string, Environment>()
  private readonly queue = new KeyedQueue()
  private readonly profilesDir: string
  private readonly artifactsDir: string
  private disposed = false

  constructor(private readonly config: ResolvedConfig, private readonly logger: Logger) {
    this.profilesDir = join(config.stateDir, 'profiles')
    this.artifactsDir = join(config.stateDir, 'artifacts')
  }

  /** Directory containing browser profiles and locks. */
  get profileRoot(): string {
    return this.profilesDir
  }

  /** Every live profile key, for diagnostics. */
  get openProfiles(): string[] {
    return [...this.environments.keys()]
  }

  /**
   * Open or navigate a profile's isolated browser.
   * @param profile - validated site/account key.
   * @param url - http(s) URL or about:blank.
   * @param signal - caller cancellation.
   * @returns the live state and a snapshot.
   */
  async open(profile: string, url: string, signal?: AbortSignal): Promise<OpenBrowserResult> {
    const key = normalizeProfileKey(profile)
    assertAllowedUrl(url)
    return this.queue.run(key, async () => {
      throwIfAborted(signal)
      const existing = this.environments.get(key)
      if (existing !== undefined && await this.isAlive(existing)) {
        return this.withEnvironment(key, signal, async environment => {
          await environment.page.navigate(url, this.config.navigationTimeoutMs, signal)
          environment.lastUrl = url
          return this.describe(environment, true, await environment.page.snapshot(this.config.maxSnapshotChars, this.config.maxSnapshotRefs, signal))
        })
      }
      if (existing !== undefined) await this.stopEnvironment(existing, 'replacing dead browser')
      const environment = await this.createEnvironment(key, 'headless', url, signal)
      return this.describe(environment, false, await environment.page.snapshot(this.config.maxSnapshotChars, this.config.maxSnapshotRefs, signal))
    })
  }

  /** Return a fresh snapshot for an open profile. */
  async snapshot(profile: string, signal?: AbortSignal): Promise<OpenBrowserResult> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, () => this.withEnvironment(key, signal, async environment =>
      this.describe(environment, true, await environment.page.snapshot(this.config.maxSnapshotChars, this.config.maxSnapshotRefs, signal)),
    ))
  }

  /** Perform one DOM action and return the fresh observation. */
  async act(
    profile: string,
    action: 'click' | 'type' | 'select' | 'scroll',
    ref: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<ActBrowserResult> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, () => this.withEnvironment(key, signal, async environment => {
      const result = await environment.page.act(action, ref, text, submit, signal)
      if (!result.ok) throw new Error(result.error ?? `${action} failed`)
      await environment.page.waitForReady(this.config.navigationTimeoutMs, signal)
      const url = await environment.page.currentUrl(signal)
      if (url.length > 0) environment.lastUrl = url
      return {
        ...this.describe(environment, true, await environment.page.snapshot(this.config.maxSnapshotChars, this.config.maxSnapshotRefs, signal)),
        action: result,
      }
    }))
  }

  /** Send one keyboard event. */
  async press(profile: string, key: string, signal?: AbortSignal): Promise<ActBrowserResult> {
    const profileKey = normalizeProfileKey(profile)
    return this.queue.run(profileKey, () => this.withEnvironment(profileKey, signal, async environment => {
      const pressed = await environment.page.press(key, signal)
      await environment.page.waitForReady(this.config.navigationTimeoutMs, signal)
      const url = await environment.page.currentUrl(signal)
      if (url.length > 0) environment.lastUrl = url
      return {
        ...this.describe(environment, true, await environment.page.snapshot(this.config.maxSnapshotChars, this.config.maxSnapshotRefs, signal)),
        action: { ok: true, url, note: `pressed ${pressed.key}` },
      }
    }))
  }

  /** Wait for a selector or text, returning the fresh observation when found. */
  async waitFor(
    profile: string,
    selector: string,
    text: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<OpenBrowserResult & { found: boolean; elapsedMs: number }> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, () => this.withEnvironment(key, signal, async environment => {
      const started = Date.now()
      const found = await environment.page.waitFor(selector, text, timeoutMs, signal)
      return {
        ...this.describe(environment, true, await environment.page.snapshot(this.config.maxSnapshotChars, this.config.maxSnapshotRefs, signal)),
        found,
        elapsedMs: Date.now() - started,
      }
    }))
  }

  /** Evaluate a JSON-returning expression in the page. */
  async evaluate(profile: string, expression: string, signal?: AbortSignal): Promise<{ profile: string; url: string; result: unknown }> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, () => this.withEnvironment(key, signal, async environment => ({
      profile: key,
      url: await environment.page.currentUrl(signal),
      result: await environment.page.evaluate(expression, { signal }) ?? null,
    })))
  }

  /** Capture a screenshot artifact. */
  async screenshot(profile: string, signal?: AbortSignal): Promise<ScreenshotResult> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, () => this.withEnvironment(key, signal, environment =>
      environment.page.screenshot(this.artifactsDir, key, signal),
    ))
  }

  /** Stop a profile and optionally delete its persistent login state. */
  async close(profile: string, reset: boolean): Promise<{ profile: string; closed: boolean; reset: boolean; profileDir: string }> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, async () => {
      const environment = this.environments.get(key)
      if (environment !== undefined) await this.stopEnvironment(environment, 'close requested')
      if (reset) {
        const active = await this.readLock(key)
        if (active !== undefined && isProcessAlive(active.pid) && active.pid !== process.pid) {
          throw new Error(`refusing to reset profile ${key}: still locked by pid ${active.pid}`)
        }
        await removeIfExists(this.profileRootFor(key))
      }
      await rm(this.lockPath(key), { force: true })
      return { profile: key, closed: true, reset, profileDir: this.profileRootFor(key) }
    })
  }

  /** List every persistent profile and its lock state. */
  async list(): Promise<BrowserProfileInfo[]> {
    await ensureDir(this.profilesDir)
    const entries = await readdir(this.profilesDir, { withFileTypes: true })
    const keys = entries.filter(entry => entry.isDirectory() && PROFILE_KEY.test(entry.name)).map(entry => entry.name).sort()
    const result: BrowserProfileInfo[] = []
    for (const key of keys) {
      const environment = this.environments.get(key)
      const lock = await this.readLock(key)
      const profileRoot = this.profileRootFor(key)
      const downloadsDir = join(profileRoot, 'downloads')
      const downloads = await readdir(downloadsDir).catch(() => [] as string[])
      const cookieStore = join(profileRoot, 'user-data', 'Default', 'Cookies')
      const localState = join(profileRoot, 'user-data', 'Default', 'Local Storage')
      result.push({
        profile: key,
        profileDir: profileRoot,
        downloadsDir,
        inUse: environment !== undefined ? await this.isAlive(environment) : lock !== undefined && isProcessAlive(lock.pid),
        ...lock === undefined ? {} : { mode: lock.mode, pid: lock.pid, startedAt: lock.startedAt },
        hasLoginState: await exists(cookieStore) || await exists(localState),
        downloads: downloads.length,
        logPath: join(profileRoot, 'chrome.log'),
      })
    }
    return result
  }

  /** List downloaded files in a profile's isolated download directory. */
  async downloads(profile: string): Promise<Array<{ name: string; path: string; bytes: number; modifiedAt: string }>> {
    const key = normalizeProfileKey(profile)
    const directory = join(this.profileRootFor(key), 'downloads')
    const entries = await readdir(directory).catch(() => [] as string[])
    const files = []
    for (const name of entries) {
      const path = join(directory, name)
      const info = await statIfExists(path)
      if (info?.isFile() !== true) continue
      files.push({ name, path, bytes: Number(info.size), modifiedAt: info.mtime.toISOString() })
    }
    return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
  }

  /**
   * Close the headless browser and open a visible window on the same profile.
   * The caller must have asked the human before calling this.
   */
  async beginHeadedHandoff(profile: string, signal?: AbortSignal): Promise<{ profile: string; url: string; pid: number; mode: 'headed'; sandbox: 'chrome' | 'disabled' | 'disabled-fallback' }> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, async () => {
      const environment = await this.requireEnvironment(key, signal)
      const url = await environment.page.currentUrl(signal) || environment.lastUrl
      await this.stopEnvironment(environment, 'handoff to headed window')
      const headed = await this.createEnvironment(key, 'headed', url, signal)
      headed.pinned = true
      headed.lastUrl = url
      return { profile: key, url, pid: headed.launched.child.pid ?? -1, mode: 'headed', sandbox: headed.sandbox }
    })
  }

  /** Close the visible window and resume headless on the same profile. */
  async finishHeadedHandoff(profile: string, signal?: AbortSignal): Promise<OpenBrowserResult> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, async () => {
      const headed = this.environments.get(key)
      if (headed === undefined || headed.mode !== 'headed') {
        throw new Error(`profile ${key} has no active headed handoff`)
      }
      const url = await headed.page.currentUrl(signal) || headed.lastUrl
      await this.stopEnvironment(headed, 'handoff complete')
      const environment = await this.createEnvironment(key, 'headless', url, signal)
      return this.describe(environment, false, await environment.page.snapshot(this.config.maxSnapshotChars, this.config.maxSnapshotRefs, signal))
    })
  }

  /** Close a visible handoff window without resuming. */
  async cancelHeadedHandoff(profile: string): Promise<{ profile: string; closed: boolean; url: string }> {
    const key = normalizeProfileKey(profile)
    return this.queue.run(key, async () => {
      const headed = this.environments.get(key)
      if (headed === undefined) return { profile: key, closed: false, url: '' }
      const url = await headed.page.currentUrl() || headed.lastUrl
      await this.stopEnvironment(headed, 'handoff cancelled')
      return { profile: key, closed: true, url }
    })
  }

  /** Best-effort resource observation for long-running browser work. */
  async resources(): Promise<Array<{ profile: string; mode: string; pid: number; memory: string | undefined }>> {
    const result = []
    for (const environment of this.environments.values()) {
      result.push({
        profile: environment.key,
        mode: environment.mode,
        pid: environment.launched.child.pid ?? -1,
        memory: environment.launched.child.pid === undefined
          ? undefined
          : await readProcessFootprint(environment.launched.child.pid),
      })
    }
    return result
  }

  /** Synchronously signal every child at process exit; cleanup cannot await there. */
  killSync(): void {
    for (const environment of this.environments.values()) {
      try {
        environment.launched.child.kill('SIGKILL')
      } catch {
        // The child already exited.
      }
    }
  }

  /** Terminate every owned browser; called on plugin disposal. */
  async dispose(): Promise<void> {
    this.disposed = true
    const environments = [...this.environments.values()]
    this.environments.clear()
    await Promise.all(environments.map(async environment => {
      try {
        await this.stopEnvironment(environment, 'plugin disposed')
      } catch (error) {
        this.logger.warn('browser cleanup failed', { profile: environment.key, error: error instanceof Error ? error.message : String(error) })
      }
    }))
  }

  private async withEnvironment<T>(
    key: string,
    signal: AbortSignal | undefined,
    operation: (environment: Environment) => Promise<T>,
  ): Promise<T> {
    const environment = await this.requireEnvironment(key, signal)
    environment.busy += 1
    environment.lastUsed = Date.now()
    try {
      return await operation(environment)
    } finally {
      this.releaseBusy(environment)
    }
  }

  private async createEnvironment(
    key: string,
    mode: 'headless' | 'headed',
    url: string,
    signal?: AbortSignal,
  ): Promise<Environment> {
    throwIfAborted(signal)
    if (this.disposed) throw new Error('browser manager is disposed')
    await this.makeRoom(key)
    const executable = await resolveChrome(this.config)
    const profileRoot = this.profileRootFor(key)
    const userDataDir = join(profileRoot, 'user-data')
    const downloadsDir = join(profileRoot, 'downloads')
    const logPath = join(profileRoot, 'chrome.log')
    await ensureDir(userDataDir)
    await ensureDir(downloadsDir)
    await this.acquireLock(key, mode, signal)

    const startAttempt = async (noSandbox: boolean): Promise<{ launched: LaunchedChrome; page: Page }> => {
      let launched: LaunchedChrome | undefined
      let cdp: CdpConnection | undefined
      try {
        launched = await launchChrome({
          executable,
          profileDir: userDataDir,
          logPath,
          headless: mode === 'headless',
          noSandbox,
          config: this.config,
          logger: this.logger,
          ...signal === undefined ? {} : { signal },
        })
        const target = await createTarget(launched.port, url, signal)
        cdp = await CdpConnection.connect(target.webSocketDebuggerUrl, this.config.actionTimeoutMs)
        const page = new Page(cdp, this.config.actionTimeoutMs, this.logger)
        await page.initialize(downloadsDir)
        // /json/new may return before its initial navigation commits; navigate
        // explicitly so every environment starts on the requested page.
        if (url === 'about:blank') {
          await page.waitForReady(this.config.navigationTimeoutMs, signal)
        } else {
          await page.navigate(url, this.config.navigationTimeoutMs, signal)
        }
        return { launched, page }
      } catch (error) {
        cdp?.close()
        if (launched !== undefined) await stopChrome(launched.child, 2_000)
        await settleProfile(userDataDir).catch(() => undefined)
        const reason = error instanceof Error ? error.message : String(error)
        const tail = await logTail(logPath)
        throw new Error(`${reason}\nChromium log tail: ${tail}`)
      }
    }

    let sandbox: 'chrome' | 'disabled' | 'disabled-fallback' = this.config.chromeSandbox === 'disabled' ? 'disabled' : 'chrome'
    let started: { launched: LaunchedChrome; page: Page }
    try {
      if (this.config.chromeSandbox === 'disabled') {
        started = await startAttempt(true)
      } else {
        try {
          started = await startAttempt(false)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (this.config.chromeSandbox !== 'auto' || !isSandboxBlocked(reason)) throw error
          this.logger.warn('Chromium sandbox is blocked by the host; retrying without the browser sandbox', {
            profile: key,
            reason: reason.slice(0, 800),
          })
          sandbox = 'disabled-fallback'
          started = await startAttempt(true)
        }
      }
    } catch (error) {
      await this.releaseLock(key)
      throw new Error(`could not start isolated browser for profile ${key}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const { launched, page } = started
    this.logger.info('isolated browser ready', {
      profile: key,
      mode,
      sandbox,
      version: launched.browserVersion,
      profileDir: profileRoot,
    })
    try {
      await this.writeLock(key, {
        pid: process.pid,
        ...launched.child.pid === undefined ? {} : { chromePid: launched.child.pid },
        port: launched.port,
        mode,
        startedAt: new Date().toISOString(),
        app: 'dsh-lovable-computer-use',
      })
      const environment: Environment = {
        key,
        profileRoot,
        userDataDir,
        downloadsDir,
        logPath,
        mode,
        sandbox,
        launched,
        page,
        lastUrl: url,
        lastUsed: Date.now(),
        busy: 0,
        pinned: false,
        idleTimer: undefined,
        closed: false,
      }
      launched.child.once('exit', () => {
        environment.closed = true
        environment.page.close()
        this.logger.info('isolated browser exited', { profile: key, code: launched.child.exitCode })
        void this.releaseLock(key)
        if (this.environments.get(key) === environment) this.environments.delete(key)
      })
      this.environments.set(key, environment)
      this.scheduleIdle(environment)
      return environment
    } catch (error) {
      page.close()
      await stopChrome(launched.child, 2_000)
      await settleProfile(userDataDir).catch(() => undefined)
      await this.releaseLock(key)
      throw new Error(`could not register isolated browser for profile ${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async stopEnvironment(environment: Environment, reason: string): Promise<void> {
    if (this.environments.get(environment.key) === environment) this.environments.delete(environment.key)
    environment.closed = true
    if (environment.idleTimer !== undefined) clearTimeout(environment.idleTimer)
    await environment.page.closeBrowser()
    environment.page.close()
    if (!await waitForExit(environment.launched.child, 5_000)) {
      await stopChrome(environment.launched.child)
    }
    await settleProfile(environment.userDataDir).catch(() => undefined)
    await this.releaseLock(environment.key)
    this.logger.info('isolated browser stopped', { profile: environment.key, reason })
  }

  private async requireEnvironment(key: string, signal?: AbortSignal): Promise<Environment> {
    throwIfAborted(signal)
    const environment = this.environments.get(key)
    if (environment === undefined) {
      throw new Error(`profile ${key} is not open; call background_browser_open first`)
    }
    if (!await this.isAlive(environment)) {
      this.environments.delete(key)
      environment.closed = true
      environment.page.close()
      await settleProfile(environment.userDataDir).catch(() => undefined)
      await this.releaseLock(key)
      throw new Error(`profile ${key}'s browser exited; call background_browser_open to relaunch it with the same login state`)
    }
    return environment
  }

  private releaseBusy(environment: Environment): void {
    environment.busy = Math.max(0, environment.busy - 1)
    environment.lastUsed = Date.now()
    this.scheduleIdle(environment)
  }

  private async isAlive(environment: Environment): Promise<boolean> {
    if (environment.closed) return false
    const pid = environment.launched.child.pid
    return pid !== undefined && environment.launched.child.exitCode === null && isProcessAlive(pid)
  }

  private describe(environment: Environment, reused: boolean, snapshot: PageSnapshot): OpenBrowserResult {
    environment.lastUrl = snapshot.url
    return {
      profile: environment.key,
      mode: environment.mode,
      sandbox: environment.sandbox,
      reused,
      pid: environment.launched.child.pid ?? -1,
      url: snapshot.url,
      title: snapshot.title,
      browserVersion: environment.launched.browserVersion,
      profileDir: environment.profileRoot,
      downloadsDir: environment.downloadsDir,
      snapshot,
    }
  }

  private scheduleIdle(environment: Environment): void {
    if (environment.idleTimer !== undefined) clearTimeout(environment.idleTimer)
    environment.idleTimer = undefined
    if (this.config.idleCloseMs <= 0 || environment.pinned || environment.closed) return
    environment.idleTimer = setTimeout(() => {
      if (environment.closed || environment.pinned || environment.busy > 0) return
      if (Date.now() - environment.lastUsed < this.config.idleCloseMs) {
        this.scheduleIdle(environment)
        return
      }
      void this.queue.run(environment.key, async () => {
        if (environment.closed || environment.pinned || environment.busy > 0) return
        await this.stopEnvironment(environment, 'idle timeout')
      }).catch(() => undefined)
    }, this.config.idleCloseMs + 250)
    environment.idleTimer.unref()
  }

  private async makeRoom(incoming: string): Promise<void> {
    for (const [key, environment] of this.environments) {
      if (!await this.isAlive(environment)) {
        this.environments.delete(key)
        environment.closed = true
        environment.page.close()
        await this.releaseLock(key)
      }
    }
    if (this.environments.size < this.config.maxProfiles) return
    if (this.environments.has(incoming)) return
    const candidates = [...this.environments.values()]
      .filter(environment => !environment.pinned && environment.busy === 0)
      .sort((left, right) => left.lastUsed - right.lastUsed)
    const victim = candidates[0]
    if (victim === undefined) {
      throw new Error(
        `maxProfiles (${this.config.maxProfiles}) reached and every profile is busy; close a profile with background_browser_close or raise config.maxProfiles`,
      )
    }
    await this.queue.run(victim.key, async () => {
      if (!victim.closed && victim.busy === 0 && !victim.pinned) {
        await this.stopEnvironment(victim, 'maxProfiles eviction')
      }
    })
  }

  private profileRootFor(key: string): string {
    return join(this.profilesDir, key)
  }

  private lockPath(key: string): string {
    return join(this.profilesDir, `${key}.lock`)
  }

  private async acquireLock(key: string, mode: 'headless' | 'headed', signal?: AbortSignal): Promise<void> {
    await ensureDir(this.profilesDir)
    const path = this.lockPath(key)
    const deadline = Date.now() + this.config.lockWaitMs
    for (;;) {
      throwIfAborted(signal)
      const payload: LockPayload = {
        pid: process.pid,
        port: 0,
        mode,
        startedAt: new Date().toISOString(),
        app: 'dsh-lovable-computer-use',
      }
      if (await createExclusive(path, `${JSON.stringify(payload, null, 2)}\n`)) return
      const existing = await this.readLock(key)
      if (existing !== undefined && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
        throw new Error(
          `profile ${key} is in use by process ${existing.pid} (${existing.mode}, started ${existing.startedAt}); `
          + 'use another profile or close the other process. Concurrent use of one Chromium profile is rejected to protect its state.',
        )
      }
      // A dead owner or a lock left by this process's earlier attempt is stale.
      await rm(path, { force: true })
      if (Date.now() >= deadline) {
        throw new Error(`could not acquire profile ${key}'s lock within ${this.config.lockWaitMs}ms`)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  private async writeLock(key: string, payload: LockPayload): Promise<void> {
    await writeJsonAtomic(this.lockPath(key), payload)
  }

  private async releaseLock(key: string): Promise<void> {
    const existing = await this.readLock(key)
    if (existing === undefined) return
    if (existing.pid !== process.pid) return
    await rm(this.lockPath(key), { force: true })
  }

  private async readLock(key: string): Promise<LockPayload | undefined> {
    const payload = await readJsonIfExists<LockPayload>(this.lockPath(key)).catch(() => undefined)
    if (payload === undefined || typeof payload.pid !== 'number' || typeof payload.port !== 'number') return undefined
    return payload
  }
}

/** Recognize the host-sandbox failures that a `--no-sandbox` retry can resolve. */
function isSandboxBlocked(message: string): boolean {
  return /sandbox initialization failed|Crashpad|GPU process isn't usable|Operation not permitted/i.test(message)
}

/** Restrict navigation to web pages; local files and internal schemes stay out of reach. */
export function assertAllowedUrl(input: string): void {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error(`url must be an absolute http(s) URL or about:blank, got ${JSON.stringify(input)}`)
  }
  if (parsed.protocol === 'about:' && parsed.href === 'about:blank') return
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`url scheme ${parsed.protocol} is not allowed; use http or https`)
  }
}

/** Human-readable profile summary used by tool renderers. */
export function describeProfile(profile: string, info: BrowserProfileInfo): string {
  const state = info.inUse ? `open (${info.mode ?? 'unknown'}, pid ${info.pid ?? '?'})` : 'closed'
  return `${profile}: ${state}; login state ${info.hasLoginState ? 'present' : 'absent'}; ${info.downloads} download(s)`
}

/** A timestamp safe for artifact directory names. */
export function nowSlug(): string {
  return timestampSlug()
}

/** Expose the lock file path for the cleanup script. */
export function profileLockPath(stateDir: string, key: string): string {
  return join(stateDir, 'profiles', `${normalizeProfileKey(key)}.lock`)
}

/** Read a profile's Chrome log without starting a browser. */
export async function readChromeLog(stateDir: string, key: string, maxChars = 8_000): Promise<string> {
  const path = join(stateDir, 'profiles', normalizeProfileKey(key), 'chrome.log')
  const text = await readTextIfExists(path)
  return text === undefined ? '' : text.slice(-maxChars)
}
