/** Generic LSP feature probe used for language-agnostic IDE verification. */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sleep, throwIfAborted, withTimeout } from '../util/async.js'
import type { Logger } from '../util/log.js'
import type { IdeLanguage, LanguageServerId } from './servers.js'

/** One generic language-server probe request. */
export interface LspProbeInput {
  readonly projectDir: string
  readonly sourceFile: string
  readonly language: IdeLanguage
  readonly languageId: string
  readonly serverId: LanguageServerId
  readonly serverPath: string
  readonly serverArgs: readonly string[]
  /** Only used to report clangd's compile-database status. */
  readonly compileCommandsDir?: string
  /** 1-based line; converted to LSP's zero-based position. */
  readonly line?: number
  /** 1-based character; converted to LSP's zero-based position. */
  readonly character?: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly logger: Logger
}

/** Generic result from a live language-server session. */
export interface LspProbeResult {
  serverId: LanguageServerId
  serverPath: string
  language: IdeLanguage
  version?: string
  initializeMs: number
  sourceFile: string
  compileCommandsDir?: string
  features: {
    semanticTokens: number
    completionItems: number
    hover?: string
    documentSymbols: number
    definitions: number
  }
  diagnostics: Array<{ severity?: number; message: string; line?: number; character?: number; source?: string }>
  stderrSignals: string[]
  compileDatabaseLoaded?: boolean
  verdict: 'lsp_verified' | 'partial' | 'failed'
  detail: string
  durationMs: number
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

const LSP_HEADER_END = '\r\n\r\n'

/** One JSON-RPC 2.0 session over a language server's stdio. */
class LspConnection {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private closed = false
  readonly stderrChunks: string[] = []

  constructor(
    private readonly child: ChildProcess,
    private readonly label: string,
    private readonly rootUri: string,
  ) {
    child.stdout?.on('data', (chunk: Buffer) => { this.onData(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrChunks.push(chunk.toString())
      if (this.stderrChunks.length > 200) this.stderrChunks.splice(0, this.stderrChunks.length - 200)
    })
    child.once('exit', () => this.failAll(new Error(`${this.label} exited`)))
    child.once('error', error => this.failAll(error))
  }

  /** Send one request and await its result. */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${this.label} connection is closed`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label} ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
        timer,
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Send one notification. */
  notify(method: string, params: unknown): void {
    if (this.closed) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Observe one notification method. */
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(listener)
    this.listeners.set(method, set)
    return () => {
      const current = this.listeners.get(method)
      current?.delete(listener)
    }
  }

  /** End the session; the server must exit, and SIGKILL is the last resort. */
  async close(): Promise<void> {
    if (this.closed) return
    try {
      await withTimeout(this.request('shutdown', null, 1_000), 1_200, `${this.label} shutdown timed out`).catch(() => undefined)
      this.notify('exit', null)
    } finally {
      this.closed = true
      this.failAll(new Error(`${this.label} session closed`))
      const child = this.child
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await sleep(250).catch(() => undefined)
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    }
  }

  /** Kill immediately; used on cancellation. */
  kill(): void {
    this.closed = true
    this.failAll(new Error(`${this.label} session cancelled`))
    try {
      this.child.kill('SIGKILL')
    } catch {
      // The process may already be gone.
    }
  }

  private write(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message))
    try {
      this.child.stdin?.write(`Content-Length: ${body.length}${LSP_HEADER_END}`)
      this.child.stdin?.write(body)
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const separator = this.buffer.indexOf(LSP_HEADER_END)
      if (separator < 0) return
      const header = this.buffer.subarray(0, separator).toString('utf8')
      const match = /Content-Length: (\d+)/i.exec(header)
      if (match === null) {
        this.buffer = this.buffer.subarray(separator + LSP_HEADER_END.length)
        continue
      }
      const length = Number.parseInt(match[1] ?? '', 10)
      const start = separator + LSP_HEADER_END.length
      if (!Number.isInteger(length) || this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      let message: Record<string, unknown>
      try {
        message = JSON.parse(body) as Record<string, unknown>
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id
    if (typeof id === 'number') {
      const pending = this.pending.get(id)
      if (pending !== undefined) {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        const error = message.error
        if (typeof error === 'object' && error !== null) {
          const detail = error as { message?: unknown; code?: unknown }
          pending.reject(new Error(`${this.label} error ${String(detail.code)}: ${String(detail.message)}`))
        } else {
          pending.resolve(message.result)
        }
        return
      }
      // Server-to-client request. Answer every one, otherwise rust-analyzer
      // and other servers can block waiting for configuration.
      this.answerServerRequest(id, message)
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
        // A diagnostic listener must not break the JSON-RPC reader.
      }
    }
  }

  private answerServerRequest(id: number, message: Record<string, unknown>): void {
    const method = typeof message.method === 'string' ? message.method : ''
    if (method === 'workspace/configuration') {
      const items = typeof message.params === 'object' && message.params !== null
        ? (message.params as { items?: unknown }).items
        : undefined
      const count = Array.isArray(items) ? items.length : 1
      this.write({ jsonrpc: '2.0', id, result: Array.from({ length: count }, () => ({})) })
      return
    }
    if (method === 'workspace/workspaceFolders') {
      this.write({ jsonrpc: '2.0', id, result: [{ uri: this.rootUri, name: 'project' }] })
      return
    }
    this.write({ jsonrpc: '2.0', id, result: null })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

/**
 * Start a language server, open the source file, and measure the features that
 * distinguish semantic IDE behavior from text highlighting.
 * @param input - project, source, server, position, and budgets.
 * @returns measured feature availability plus the server's diagnostics.
 */
export async function probeLsp(input: LspProbeInput): Promise<LspProbeResult> {
  const started = Date.now()
  const sourceFile = resolve(input.sourceFile)
  const sourceUri = pathToFileURL(sourceFile).href
  const rootUri = pathToFileURL(resolve(input.projectDir)).href
  const text = await readFile(sourceFile, 'utf8')
  if (text.length > 4 * 1024 * 1024) {
    throw new Error(`source file is too large to probe (${text.length} bytes; limit 4 MiB)`)
  }
  const child = spawn(input.serverPath, [...input.serverArgs], {
    cwd: resolve(input.projectDir),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  const connection = new LspConnection(child, input.serverId, rootUri)
  let diagnostics: LspProbeResult['diagnostics'] = []
  const diagnosticUpdates: string[] = []
  const disposeDiagnostics = connection.on('textDocument/publishDiagnostics', params => {
    const uri = typeof params.uri === 'string' ? params.uri : ''
    if (uri !== sourceUri) return
    diagnosticUpdates.push(new Date().toISOString())
    diagnosticUpdates.splice(0, Math.max(0, diagnosticUpdates.length - 20))
    const raw = Array.isArray(params.diagnostics) ? params.diagnostics : []
    diagnostics = raw.slice(0, 100).map(item => {
      const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
      const range = typeof record.range === 'object' && record.range !== null
        ? record.range as { start?: { line?: unknown; character?: unknown } }
        : {}
      return {
        ...typeof record.severity === 'number' ? { severity: record.severity } : {},
        message: typeof record.message === 'string' ? record.message : '',
        ...typeof range.start?.line === 'number' ? { line: range.start.line + 1 } : {},
        ...typeof range.start?.character === 'number' ? { character: range.start.character + 1 } : {},
        ...typeof record.source === 'string' ? { source: record.source } : {},
      }
    })
  })
  const cleanup = async (): Promise<void> => {
    disposeDiagnostics()
    await connection.close()
  }
  const onAbort = (): void => connection.kill()
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    throwIfAborted(input.signal)
    const initializeStarted = Date.now()
    const capabilities = {
      workspace: {
        workspaceFolders: true,
        configuration: true,
      },
      textDocument: {
        synchronization: { dynamicRegistration: false },
        semanticTokens: {
          requests: { full: true },
          tokenTypes: [],
          tokenModifiers: [],
          formats: ['relative'],
          overlappingTokenSupport: false,
          multilineTokenSupport: false,
        },
        completion: { completionItem: { snippetSupport: false, documentationFormat: ['plaintext'] } },
        hover: { contentFormat: ['plaintext'] },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        publishDiagnostics: { relatedInformation: false, versionSupport: false },
        definition: { linkSupport: false },
      },
    }
    const initializeResult = await connection.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'dsh-lovable-computer-use', version: '0.1.0' },
      rootUri,
      rootPath: resolve(input.projectDir),
      capabilities,
      workspaceFolders: [{ uri: rootUri, name: 'project' }],
      initializationOptions: {},
    }, Math.min(input.timeoutMs, 20_000)) as {
      serverInfo?: { name?: unknown; version?: unknown }
      capabilities?: unknown
    }
    const initializeMs = Date.now() - initializeStarted
    connection.notify('initialized', {})
    connection.notify('textDocument/didOpen', {
      textDocument: { uri: sourceUri, languageId: input.languageId, version: 1, text },
    })
    // Push diagnostics arrive asynchronously; wait for the first update or a
    // short settle window so a clean file is distinguishable from a slow one.
    const diagnosticDeadline = Date.now() + 2_500
    while (Date.now() < diagnosticDeadline && diagnosticUpdates.length === 0) {
      throwIfAborted(input.signal)
      await sleep(100)
    }
    await sleep(100)
    const position = choosePosition(text, input.line, input.character)
    const remaining = Math.max(2_000, input.timeoutMs - (Date.now() - started))
    const [tokens, completion, hover, symbols, definitions] = await Promise.all([
      requestOrUndefined(connection, 'textDocument/semanticTokens/full', { textDocument: { uri: sourceUri } }, Math.min(remaining, 20_000)),
      requestOrUndefined(connection, 'textDocument/completion', {
        textDocument: { uri: sourceUri },
        position,
        context: { triggerKind: 2, triggerCharacter: '.' },
      }, Math.min(remaining, 20_000)),
      requestOrUndefined(connection, 'textDocument/hover', { textDocument: { uri: sourceUri }, position }, Math.min(remaining, 20_000)),
      requestOrUndefined(connection, 'textDocument/documentSymbol', { textDocument: { uri: sourceUri } }, Math.min(remaining, 20_000)),
      requestOrUndefined(connection, 'textDocument/definition', { textDocument: { uri: sourceUri }, position }, Math.min(remaining, 20_000)),
    ])
    const semanticTokens = tokenCount(tokens)
    const completionItems = completionCount(completion)
    const hoverText = hoverValue(hover)
    const documentSymbols = Array.isArray(symbols) ? symbols.length : 0
    const definitionCount = Array.isArray(definitions) ? definitions.length : 0
    const stderrText = connection.stderrChunks.join('')
    const stderrSignals = extractStderrSignals(stderrText)
    const blocking = input.serverId === 'clangd' && stderrSignals.some(signal => /does not exist|failed to set CWD|Failed to find compilation database|no compile command/i.test(signal))
    const compileDatabaseLoaded = input.compileCommandsDir !== undefined && input.serverId === 'clangd' && !blocking
    const version = typeof initializeResult.serverInfo?.version === 'string'
      ? initializeResult.serverInfo.version
      : undefined
    const featureCount = [
      semanticTokens > 0,
      completionItems > 0,
      hoverText !== undefined,
      documentSymbols > 0,
      definitionCount > 0,
    ].filter(Boolean).length
    const verdict = blocking
      ? featureCount > 0 ? 'partial' : 'failed'
      : featureCount >= 2
        ? 'lsp_verified'
        : featureCount === 1
          ? 'partial'
          : 'failed'
    const features = {
      semanticTokens,
      completionItems,
      ...hoverText === undefined ? {} : { hover: hoverText },
      documentSymbols,
      definitions: definitionCount,
    }
    return {
      serverId: input.serverId,
      serverPath: input.serverPath,
      language: input.language,
      ...version === undefined ? {} : { version },
      initializeMs,
      sourceFile,
      ...input.compileCommandsDir === undefined ? {} : { compileCommandsDir: resolve(input.compileCommandsDir) },
      features,
      diagnostics,
      stderrSignals,
      ...input.compileCommandsDir === undefined ? {} : { compileDatabaseLoaded },
      verdict,
      detail: verdictDetail(input.serverId, input.language, verdict, features, blocking, compileDatabaseLoaded),
      durationMs: Date.now() - started,
    }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    if (input.signal?.aborted === true) {
      disposeDiagnostics()
      connection.kill()
    } else {
      await cleanup()
    }
  }
}

async function requestOrUndefined(
  connection: LspConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  try {
    return await connection.request(method, params, timeoutMs)
  } catch {
    return undefined
  }
}

function tokenCount(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const data = (value as { data?: unknown }).data
  return Array.isArray(data) ? Math.floor(data.length / 5) : 0
}

function completionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'object' && value !== null) {
    const items = (value as { items?: unknown }).items
    return Array.isArray(items) ? items.length : 0
  }
  return 0
}

function hoverValue(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const contents = (value as { contents?: unknown }).contents
  if (typeof contents === 'string') return contents.slice(0, 500)
  if (typeof contents === 'object' && contents !== null) {
    const record = contents as { value?: unknown; kind?: unknown }
    if (typeof record.value === 'string') return record.value.slice(0, 500)
  }
  if (Array.isArray(contents)) {
    const text = contents.map(item => {
      if (typeof item === 'string') return item
      if (typeof item === 'object' && item !== null && typeof (item as { value?: unknown }).value === 'string') {
        return (item as { value: string }).value
      }
      return ''
    }).join('\n').trim()
    return text.length === 0 ? undefined : text.slice(0, 500)
  }
  return undefined
}

function extractStderrSignals(text: string): string[] {
  const patterns = [
    /Path specified by --compile-commands-dir does not exist[^\n]*/gi,
    /Failed to find compilation database[^\n]*/gi,
    /failed to set CWD to [^\n]*/gi,
    /Failed to read [^\n]*compile_commands[^\n]*/gi,
    /no compile command[^\n]*/gi,
    /error: unable to find[^\n]*/gi,
    /(?:^|\n)(?:error|failed|panic):?[^\n]*/gi,
  ]
  const found: string[] = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const line = match[0].trim()
      if (line.length > 0 && !found.includes(line)) found.push(line.slice(0, 300))
      if (found.length >= 12) return found
    }
  }
  return found
}

function verdictDetail(
  serverId: LanguageServerId,
  language: IdeLanguage,
  verdict: LspProbeResult['verdict'],
  features: LspProbeResult['features'],
  blocking: boolean,
  compileDatabaseLoaded: boolean,
): string {
  const prefix = `${serverId} (${language}) returned ${features.semanticTokens} semantic token(s), ${features.completionItems} completion item(s), ${features.documentSymbols} document symbol(s), ${features.definitions} definition(s)`
  if (verdict === 'lsp_verified') {
    return `${prefix}; at least two independent language features responded${features.hover === undefined ? '' : ' including hover'}.`
      + `${serverId === 'clangd' ? ` ${compileDatabaseLoaded ? 'The project compilation database was loaded.' : 'No explicit compilation database was supplied.'}` : ''}`
  }
  if (verdict === 'partial') {
    return `${prefix}; only a limited language signal responded. `
      + `${blocking ? 'stderr reports a compilation-database or working-directory problem. ' : ''}This is not sufficient to claim semantic IDE behavior is healthy.`
  }
  return `${prefix}; no independent language feature responded. Treat IDE language behavior as not working until the cause is fixed.`
}

function choosePosition(text: string, line?: number, character?: number): { line: number; character: number } {
  const lines = text.split('\n')
  if (line !== undefined && line >= 1) {
    const index = Math.min(line - 1, lines.length - 1)
    const length = (lines[index] ?? '').length
    const column = character === undefined ? Math.max(0, length - 1) : Math.max(0, Math.min(character - 1, length))
    return { line: index, character: column }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] ?? ''
    const main = current.indexOf('main')
    if (main >= 0) return { line: index, character: main + 2 }
    if (/^\s*(#|\/\/|\/\*|$)/.test(current)) continue
    const identifier = /[A-Za-z_][A-Za-z0-9_]*/.exec(current)
    if (identifier !== null) return { line: index, character: identifier.index + 1 }
  }
  return { line: 0, character: 0 }
}
