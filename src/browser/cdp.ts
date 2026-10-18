/** Chromium DevTools Protocol transport over the host Node WebSocket. */

interface WebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly readyState: number
}

interface WebSocketConstructor {
  new (url: string): WebSocketLike
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/** One CDP event payload. */
export type CdpListener = (params: Record<string, unknown>) => void

function webSocketConstructor(): WebSocketConstructor {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof candidate !== 'function') {
    throw new Error('this Node runtime has no global WebSocket; dsh-lovable-computer-use requires Node >= 22.19')
  }
  return candidate as WebSocketConstructor
}

/** A single CDP target connection with request/response and event dispatch. */
export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Map<string, Set<CdpListener>>()
  private closed = false

  private constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener('message', event => this.onMessage(event))
    socket.addEventListener('close', () => this.failAll(new Error('CDP connection closed')))
    socket.addEventListener('error', () => this.failAll(new Error('CDP connection failed')))
  }

  /**
   * Open a WebSocket connection to a DevTools target.
   * @param url - `ws://` target URL from `/json/list` or `/json/new`.
   * @param timeoutMs - connection budget.
   * @returns the connected transport.
   */
  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const Constructor = webSocketConstructor()
    const socket = new Constructor(url)
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch {
          // Already closed sockets are not an error here.
        }
        reject(new Error(`CDP connection to ${url} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(new CdpConnection(socket))
      })
      socket.addEventListener('error', event => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const detail = (event as { message?: string }).message
        reject(new Error(`CDP connection to ${url} failed${detail === undefined ? '' : `: ${detail}`}`))
      })
    })
  }

  /** Whether the underlying socket is open. */
  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === 1
  }

  /**
   * Send one CDP request.
   * @param method - protocol method name.
   * @param params - protocol parameters.
   * @param timeoutMs - per-request budget.
   * @param signal - caller cancellation.
   * @returns the protocol result.
   */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'))
    if (signal?.aborted === true) return Promise.reject(new Error('operation cancelled'))
    const id = this.nextId++
    const message = JSON.stringify({ id, method, params })
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(new Error('operation cancelled'))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value as T)
        },
        reject: error => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.socket.send(message)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Subscribe to one CDP event.
   * @param method - event method name.
   * @param listener - event callback.
   * @returns the disposer.
   */
  on(method: string, listener: CdpListener): () => void {
    const set = this.listeners.get(method) ?? new Set<CdpListener>()
    set.add(listener)
    this.listeners.set(method, set)
    return () => {
      const current = this.listeners.get(method)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(method)
    }
  }

  /** Close the transport and reject every in-flight request. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new Error('CDP connection closed'))
    try {
      this.socket.close()
    } catch {
      // A socket already closed by the browser needs no extra cleanup.
    }
  }

  private failAll(error: Error): void {
    this.closed = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private onMessage(event: unknown): void {
    const data = (event as { data?: unknown }).data
    if (typeof data !== 'string') return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    const id = message.id
    if (typeof id === 'number') {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      const error = message.error
      if (typeof error === 'object' && error !== null) {
        const detail = error as { message?: unknown; code?: unknown }
        pending.reject(new Error(`CDP error ${String(detail.code)}: ${String(detail.message)}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    const method = message.method
    if (typeof method !== 'string') return
    const params = typeof message.params === 'object' && message.params !== null
      ? message.params as Record<string, unknown>
      : {}
    for (const listener of this.listeners.get(method) ?? []) {
      try {
        listener(params)
      } catch {
        // Event listeners are observational; one failure must not stop dispatch.
      }
    }
  }
}
