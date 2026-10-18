/** Foreground-interruption evidence recorder. */

import { randomUUID } from 'node:crypto'
import type { Logger } from '../util/log.js'
import { sampleForeground, type ForegroundSample } from './sampler.js'

/** One observed change of the frontmost application. */
export interface FocusTransition {
  readonly at: string
  readonly elapsedMs: number
  readonly from: { readonly bundleId: string; readonly name: string; readonly pid: number }
  readonly to: { readonly bundleId: string; readonly name: string; readonly pid: number }
  readonly expected: boolean
}

/** Completed measurement returned by `focus_guard_stop`. */
export interface FocusReport {
  readonly id: string
  readonly label: string
  readonly startedAt: string
  readonly stoppedAt: string
  readonly durationMs: number
  readonly intervalMs: number
  readonly samples: number
  readonly baseline: ForegroundSample | null
  readonly final: ForegroundSample | null
  readonly transitions: FocusTransition[]
  readonly interruptions: FocusTransition[]
  readonly pointer: {
    readonly sampling: 'supported' | 'unsupported'
    readonly start?: { readonly x: number; readonly y: number }
    readonly end?: { readonly x: number; readonly y: number }
    readonly movedPx?: number
    readonly distanceFromStartPx?: number
  }
  readonly expectedBundleIds: string[]
  readonly verdict: 'no-interruption' | 'focus-changed' | 'unsupported'
  readonly note: string
}

interface ActiveGuard {
  readonly id: string
  readonly label: string
  readonly startedAt: string
  readonly startedAtMs: number
  readonly expectedBundleIds: Set<string>
  readonly transitions: FocusTransition[]
  readonly samples: ForegroundSample[]
  timer: NodeJS.Timeout | undefined
  last: ForegroundSample | null
  sampling: boolean
  stopped: boolean
}

/**
 * Polls the foreground application while agent work runs. It records what
 * changed instead of claiming an action caused it: attribution needs an input
 * source the agent never uses.
 */
export class FocusGuard {
  private active: ActiveGuard | null = null
  private lastReport: FocusReport | null = null

  constructor(private readonly intervalMs: number, private readonly logger: Logger) {}

  /** Begin a measurement, replacing any active guard. */
  async start(label: string, expectedBundleIds: readonly string[] = []): Promise<{ id: string; baseline: ForegroundSample | null }> {
    this.stopActive('replaced by a new guard')
    const id = `focus-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const guard: ActiveGuard = {
      id,
      label,
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      expectedBundleIds: new Set(expectedBundleIds),
      transitions: [],
      samples: [],
      timer: undefined,
      last: null,
      sampling: false,
      stopped: false,
    }
    this.active = guard
    const tick = async (): Promise<void> => {
      if (guard.stopped || guard.sampling) return
      guard.sampling = true
      try {
        const sample = await sampleForeground()
        guard.samples.push(sample)
        if (guard.last !== null && sample.supported && guard.last.supported
          && (sample.bundleId !== guard.last.bundleId || sample.pid !== guard.last.pid)) {
          guard.transitions.push({
            at: sample.timestamp,
            elapsedMs: Date.now() - guard.startedAtMs,
            from: { bundleId: guard.last.bundleId, name: guard.last.name, pid: guard.last.pid },
            to: { bundleId: sample.bundleId, name: sample.name, pid: sample.pid },
            expected: guard.expectedBundleIds.has(sample.bundleId),
          })
        }
        guard.last = sample
      } catch (error) {
        this.logger.warn('focus sample failed', { error: error instanceof Error ? error.message : String(error) })
      } finally {
        guard.sampling = false
      }
    }
    const first = await sampleForeground()
    guard.samples.push(first)
    guard.last = first
    guard.timer = setInterval(() => { void tick() }, this.intervalMs)
    guard.timer.unref()
    return { id, baseline: first }
  }

  /** Current guard identity, useful to verify the caller stops the right measurement. */
  get activeId(): string | undefined {
    return this.active?.id
  }

  /** Latest completed report, if any. */
  get lastFinished(): FocusReport | null {
    return this.lastReport
  }

  /** Return the active guard's partial state. */
  status(id?: string): Record<string, unknown> {
    const guard = this.active
    if (guard === null || (id !== undefined && guard.id !== id)) {
      return { active: false, last: this.lastReport }
    }
    return {
      active: true,
      id: guard.id,
      label: guard.label,
      startedAt: guard.startedAt,
      elapsedMs: Date.now() - guard.startedAtMs,
      samples: guard.samples.length,
      baseline: guard.samples[0] ?? null,
      current: guard.last,
      transitions: guard.transitions,
      expectedBundleIds: [...guard.expectedBundleIds],
    }
  }

  /**
   * Stop a measurement and produce evidence.
   * @param id - guard id; omitted accepts the only active guard.
   * @returns the completed report.
   */
  stop(id?: string): FocusReport {
    const guard = this.active
    if (guard === null || (id !== undefined && guard.id !== id)) {
      throw new Error(id === undefined ? 'no focus guard is active' : `focus guard ${id} is not active`)
    }
    const report = this.buildReport(guard)
    this.active = null
    this.lastReport = report
    return report
  }

  /** Stop without a report; used by plugin disposal. */
  dispose(): void {
    this.stopActive('plugin disposed')
  }

  private stopActive(reason: string): void {
    const guard = this.active
    if (guard === null) return
    guard.stopped = true
    if (guard.timer !== undefined) clearInterval(guard.timer)
    this.active = null
    this.lastReport = this.buildReport(guard)
    this.logger.debug('focus guard stopped', { id: guard.id, reason })
  }

  private buildReport(guard: ActiveGuard): FocusReport {
    guard.stopped = true
    if (guard.timer !== undefined) clearInterval(guard.timer)
    const supported = guard.samples.some(sample => sample.supported)
    const interruptions = guard.transitions.filter(transition => !transition.expected)
    const baseline = guard.samples[0] ?? null
    const final = guard.last ?? null
    const startPointer = baseline?.pointer
    const endPointer = final?.pointer
    const movedPx = startPointer !== undefined && endPointer !== undefined
      ? Math.hypot(endPointer.x - startPointer.x, endPointer.y - startPointer.y)
      : undefined
    return {
      id: guard.id,
      label: guard.label,
      startedAt: guard.startedAt,
      stoppedAt: new Date().toISOString(),
      durationMs: Date.now() - guard.startedAtMs,
      intervalMs: this.intervalMs,
      samples: guard.samples.length,
      baseline,
      final,
      transitions: guard.transitions,
      interruptions,
      pointer: {
        sampling: supported ? 'supported' : 'unsupported',
        ...startPointer === undefined ? {} : { start: startPointer },
        ...endPointer === undefined ? {} : { end: endPointer },
        ...movedPx === undefined ? {} : { movedPx, distanceFromStartPx: movedPx },
      },
      expectedBundleIds: [...guard.expectedBundleIds],
      verdict: !supported ? 'unsupported' : interruptions.length === 0 ? 'no-interruption' : 'focus-changed',
      note: 'Transitions are observations, not proof of causation. Only an explicit handoff may open a visible window; background browser tools never synthesize input or activate windows.',
    }
  }
}
