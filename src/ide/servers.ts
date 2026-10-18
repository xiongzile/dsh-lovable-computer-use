/** Language and language-server discovery for language-agnostic IDE verification. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { clangdCandidates, type ResolvedConfig } from '../config.js'
import { findExecutable, statIfExists } from '../util/fs.js'
import { runCommand } from '../util/exec.js'

/** Languages this build can diagnose and, when a server is installed, probe. */
export type IdeLanguage =
  | 'c'
  | 'cpp'
  | 'objective-c'
  | 'python'
  | 'rust'
  | 'go'
  | 'typescript'
  | 'javascript'
  | 'java'
  | 'kotlin'
  | 'unknown'

/** Supported language-server ids. */
export type LanguageServerId =
  | 'clangd'
  | 'pyright'
  | 'basedpyright'
  | 'pylsp'
  | 'rust-analyzer'
  | 'gopls'
  | 'typescript-language-server'
  | 'jdtls'
  | 'kotlin-language-server'

/** Detected language and the project files that justify it. */
export interface IdeLanguageInfo {
  language: IdeLanguage
  markers: string[]
  sourceFile?: string
  server?: LanguageServerSpec
}

/** One discovered language server ready to spawn. */
export interface LanguageServerSpec {
  id: LanguageServerId
  language: IdeLanguage
  displayName: string
  path: string
  args: string[]
  version?: string
}

const LANGUAGE_LABELS: Record<IdeLanguage, string> = {
  c: 'C',
  cpp: 'C++',
  'objective-c': 'Objective-C',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  java: 'Java',
  kotlin: 'Kotlin',
  unknown: 'Unknown',
}

const MARKERS: Partial<Record<IdeLanguage, readonly string[]>> = {
  c: ['CMakeLists.txt', 'compile_commands.json', 'compile_flags.txt', '.clangd'],
  cpp: ['CMakeLists.txt', 'compile_commands.json', 'compile_flags.txt', '.clangd'],
  python: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock', '.python-version'],
  rust: ['Cargo.toml'],
  go: ['go.mod'],
  typescript: ['tsconfig.json', 'package.json', 'jsconfig.json'],
  javascript: ['package.json', 'jsconfig.json'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
  kotlin: ['build.gradle.kts', 'settings.gradle.kts'],
}

const EXTENSIONS: Partial<Record<IdeLanguage, RegExp>> = {
  c: /\.c$/i,
  cpp: /\.(cpp|cc|cxx|hpp|hh|hxx)$/i,
  'objective-c': /\.(m|mm)$/i,
  python: /\.py$/i,
  rust: /\.rs$/i,
  go: /\.go$/i,
  typescript: /\.(ts|tsx|mts|cts)$/i,
  javascript: /\.(js|jsx|mjs|cjs)$/i,
  java: /\.java$/i,
  kotlin: /\.(kt|kts)$/i,
}

/** Human-readable language name. */
export function languageLabel(language: IdeLanguage): string {
  return LANGUAGE_LABELS[language]
}

/** Map a source path to a language. */
export function languageForPath(path: string): IdeLanguage {
  for (const [language, pattern] of Object.entries(EXTENSIONS) as Array<[IdeLanguage, RegExp]>) {
    if (pattern.test(path)) return language
  }
  return 'unknown'
}

/** LSP `languageId` for a source path. */
export function languageIdForPath(path: string): string {
  switch (languageForPath(path)) {
    case 'c': return 'c'
    case 'cpp': return 'cpp'
    case 'objective-c': return 'objective-cpp'
    case 'python': return 'python'
    case 'rust': return 'rust'
    case 'go': return 'go'
    case 'typescript': return 'typescript'
    case 'javascript': return 'javascript'
    case 'java': return 'java'
    case 'kotlin': return 'kotlin'
    default: return 'plaintext'
  }
}

/** Marker files that strongly suggest a language/project type. */
export function markersFor(language: IdeLanguage): string[] {
  return [...(MARKERS[language] ?? [])]
}

/**
 * Detect the languages present in a project without launching an editor.
 * Markers and source extensions both count; results are de-duplicated.
 */
export async function detectProjectLanguages(projectDir: string, signal?: AbortSignal): Promise<IdeLanguageInfo[]> {
  const root = resolve(projectDir)
  const found = new Map<IdeLanguage, { markers: Set<string>; sourceFile?: string }>()
  const add = (language: IdeLanguage): void => {
    if (language === 'unknown') return
    if (!found.has(language)) found.set(language, { markers: new Set() })
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (signal?.aborted === true) throw new Error('operation cancelled')
    if (!entry.isFile()) continue
    for (const [language, markers] of Object.entries(MARKERS) as Array<[IdeLanguage, string[]]>) {
      if (markers.includes(entry.name)) {
        add(language)
        found.get(language)?.markers.add(entry.name)
      }
    }
    const language = languageForPath(entry.name)
    if (language !== 'unknown') {
      add(language)
      const record = found.get(language)
      if (record !== undefined && record.sourceFile === undefined) record.sourceFile = join(root, entry.name)
    }
  }
  // A few common source directories are enough to avoid recursing into build trees.
  for (const directory of ['src', 'app', 'lib', 'pkg', 'cmd', 'test', 'tests']) {
    const path = join(root, directory)
    const info = await statIfExists(path)
    if (info?.isDirectory() !== true) continue
    const children = await readdir(path, { withFileTypes: true }).catch(() => [])
    for (const child of children) {
      if (!child.isFile()) continue
      const language = languageForPath(child.name)
      if (language === 'unknown') continue
      add(language)
      const record = found.get(language)
      if (record !== undefined && record.sourceFile === undefined) record.sourceFile = join(path, child.name)
    }
  }
  return [...found.entries()].map(([language, record]) => ({
    language,
    markers: [...record.markers],
    ...record.sourceFile === undefined ? {} : { sourceFile: record.sourceFile },
  }))
}

/** Find a representative source file for a language. */
export async function findSourceForLanguage(projectDir: string, language: IdeLanguage, depth = 0): Promise<string | undefined> {
  if (depth > 3) return undefined
  const pattern = EXTENSIONS[language]
  if (pattern === undefined) return undefined
  const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
  const files = entries
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => {
      const preferred = (name: string): number => {
        if (/^(main|index|lib|__init__)\./i.test(name)) return 0
        if (/^(test|spec)/i.test(name)) return 2
        return 1
      }
      return preferred(left) - preferred(right) || left.localeCompare(right)
    })
  for (const file of files) return join(projectDir, file)
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    if (/^(\.|build|cmake-build|target|node_modules|third_party|third-party|\.git|dist|out)$/.test(entry.name)) continue
    const found = await findSourceForLanguage(join(projectDir, entry.name), language, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function candidatesFor(id: LanguageServerId): string[] {
  const home = homedir()
  switch (id) {
    case 'clangd': return clangdCandidates()
    case 'pyright': return [join(home, '.local', 'bin', 'pyright-langserver'), '/opt/homebrew/bin/pyright-langserver', '/usr/local/bin/pyright-langserver']
    case 'basedpyright': return [join(home, '.local', 'bin', 'basedpyright-langserver'), '/opt/homebrew/bin/basedpyright-langserver', '/usr/local/bin/basedpyright-langserver']
    case 'pylsp': return [join(home, '.local', 'bin', 'pylsp'), '/opt/homebrew/bin/pylsp', '/usr/local/bin/pylsp']
    case 'rust-analyzer': return [join(home, '.cargo', 'bin', 'rust-analyzer'), '/opt/homebrew/bin/rust-analyzer', '/usr/local/bin/rust-analyzer']
    case 'gopls': return [join(home, 'go', 'bin', 'gopls'), '/opt/homebrew/bin/gopls', '/usr/local/bin/gopls']
    case 'typescript-language-server': return [join(home, '.npm-global', 'bin', 'typescript-language-server'), '/opt/homebrew/bin/typescript-language-server', '/usr/local/bin/typescript-language-server']
    case 'jdtls': return ['/opt/homebrew/bin/jdtls', '/usr/local/bin/jdtls']
    case 'kotlin-language-server': return [join(home, '.local', 'bin', 'kotlin-language-server'), '/opt/homebrew/bin/kotlin-language-server', '/usr/local/bin/kotlin-language-server']
  }
}

/** Find the best available language server for one language. */
export async function findLanguageServer(
  language: IdeLanguage,
  config: Pick<ResolvedConfig, 'clangdPath'>,
  signal?: AbortSignal,
): Promise<LanguageServerSpec | undefined> {
  const ids: LanguageServerId[] = language === 'python'
    ? ['pyright', 'basedpyright', 'pylsp']
    : language === 'c' || language === 'cpp' || language === 'objective-c'
      ? ['clangd']
      : language === 'rust'
        ? ['rust-analyzer']
        : language === 'go'
          ? ['gopls']
          : language === 'typescript' || language === 'javascript'
            ? ['typescript-language-server']
            : language === 'java'
              ? ['jdtls']
              : language === 'kotlin'
                ? ['kotlin-language-server']
                : []
  for (const id of ids) {
    const spec = await findLanguageServerById(id, config, signal)
    if (spec !== undefined) return { ...spec, language }
  }
  return undefined
}

const SERVER_LANGUAGES: Record<LanguageServerId, IdeLanguage> = {
  clangd: 'cpp',
  pyright: 'python',
  basedpyright: 'python',
  pylsp: 'python',
  'rust-analyzer': 'rust',
  gopls: 'go',
  'typescript-language-server': 'typescript',
  jdtls: 'java',
  'kotlin-language-server': 'kotlin',
}

/** Find one specific language server by id, ignoring language preference. */
export async function findLanguageServerById(
  id: LanguageServerId,
  config: Pick<ResolvedConfig, 'clangdPath'>,
  signal?: AbortSignal,
): Promise<LanguageServerSpec | undefined> {
  const executableName = id === 'pyright'
    ? 'pyright-langserver'
    : id === 'basedpyright'
      ? 'basedpyright-langserver'
      : id
  const path = id === 'clangd' && config.clangdPath !== undefined
    ? config.clangdPath
    : await findExecutable(executableName, candidatesFor(id))
  if (path === undefined) return undefined
  if (signal?.aborted === true) throw new Error('operation cancelled')
  const args = id === 'clangd'
    ? ['--log=error', '--background-index=false', '--pch-storage=memory', '--limit-results=50']
    : id === 'pyright' || id === 'basedpyright' || id === 'typescript-language-server'
      ? ['--stdio']
      : []
  const version = await serverVersion(id, path)
  return {
    id,
    language: SERVER_LANGUAGES[id],
    displayName: id,
    path,
    args,
    ...version === undefined ? {} : { version },
  }
}

async function serverVersion(id: LanguageServerId, path: string): Promise<string | undefined> {
  const args = id === 'gopls' ? ['version'] : ['--version']
  const result = await runCommand(path, args, { timeoutMs: 4_000 }).catch(() => undefined)
  if (result === undefined || result.exitCode !== 0) return undefined
  return (result.stdout.split('\n')[0] ?? '').trim().slice(0, 200) || undefined
}

/** Append clangd-specific compile-database arguments when requested. */
export function withCompileCommands(args: string[], directory?: string): string[] {
  if (directory === undefined) return args
  return [...args, `--compile-commands-dir=${resolve(directory)}`]
}
