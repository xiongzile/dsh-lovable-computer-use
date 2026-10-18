/** Small async primitives used by the browser and focus subsystems. */

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Build the canonical cancellation error. */
export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason
  if (reason instanceof Error) return reason
  return new Error('operation cancelled')
}

/** Throw when the caller already cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError(signal)
}

/**
 * Await `promise` with a deadline and cancellation.
 * The original promise keeps running; callers remain responsible for closing
 * the resource it owns.
 * @param promise - work to bound.
 * @param ms - budget in milliseconds.
 * @param message - timeout diagnostic.
 * @param signal - caller cancellation.
 * @returns the promise's value.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal)
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    onAbort = (): void => reject(abortError(signal))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

/** Serialize work per key while allowing different keys to proceed concurrently. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  /**
   * Run `task` after all earlier work for `key` settles.
   * @param key - serialization key.
   * @param task - work to run.
   * @returns the task result.
   */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    this.tails.set(key, current)
    try {
      return await current
    } finally {
      if (this.tails.get(key) === current) this.tails.delete(key)
    }
  }

  /** Number of keys with pending work; used by diagnostics. */
  get pendingKeys(): number {
    return this.tails.size
  }
}

/** Map with a hard cap that evicts the least-recently-used entry. */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (oldest.done === true) break
      this.map.delete(oldest.value)
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }
}
