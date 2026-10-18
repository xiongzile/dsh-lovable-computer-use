/** Backwards-compatible clangd wrapper over the generic LSP probe. */

import { resolve } from 'node:path'
import type { Logger } from '../util/log.js'
import { probeLsp, type LspProbeResult } from './lsp.js'
import { languageIdForPath } from './servers.js'

/** Inputs for one clangd feature probe. */
export interface ClangdProbeInput {
  readonly projectDir: string
  readonly sourceFile: string
  readonly compileCommandsDir?: string
  /** 1-based line; converted to LSP's zero-based position. */
  readonly line?: number
  /** 1-based character; converted to LSP's zero-based position. */
  readonly character?: number
  readonly timeoutMs: number
  readonly clangdPath: string
  readonly signal?: AbortSignal
  readonly logger: Logger
}

/** Feature results from a live clangd session. */
export interface ClangdProbeResult {
  clangdPath: string
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
  compileDatabaseLoaded: boolean
  verdict: 'lsp_verified' | 'partial' | 'failed'
  detail: string
  durationMs: number
}

/**
 * Start clangd, open the source file, and ask for semantic IDE features.
 * This wrapper keeps the historical result shape; new callers should use
 * {@link probeLsp} with a language-server spec.
 */
export async function probeClangd(input: ClangdProbeInput): Promise<ClangdProbeResult> {
  const args = [
    '--log=error',
    '--background-index=false',
    '--pch-storage=memory',
    '--limit-results=50',
    ...input.compileCommandsDir === undefined ? [] : [`--compile-commands-dir=${resolve(input.compileCommandsDir)}`],
  ]
  const result: LspProbeResult = await probeLsp({
    projectDir: input.projectDir,
    sourceFile: input.sourceFile,
    language: 'cpp',
    languageId: languageIdForPath(input.sourceFile),
    serverId: 'clangd',
    serverPath: input.clangdPath,
    serverArgs: args,
    ...input.compileCommandsDir === undefined ? {} : { compileCommandsDir: input.compileCommandsDir },
    ...input.line === undefined ? {} : { line: input.line },
    ...input.character === undefined ? {} : { character: input.character },
    timeoutMs: input.timeoutMs,
    ...input.signal === undefined ? {} : { signal: input.signal },
    logger: input.logger,
  })
  return {
    clangdPath: result.serverPath,
    ...result.version === undefined ? {} : { version: result.version },
    initializeMs: result.initializeMs,
    sourceFile: result.sourceFile,
    ...result.compileCommandsDir === undefined ? {} : { compileCommandsDir: result.compileCommandsDir },
    features: result.features,
    diagnostics: result.diagnostics,
    stderrSignals: result.stderrSignals,
    compileDatabaseLoaded: result.compileDatabaseLoaded === true,
    verdict: result.verdict,
    detail: result.detail,
    durationMs: result.durationMs,
  }
}
