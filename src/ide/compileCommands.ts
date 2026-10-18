/** Parse and validate a clangd compilation database without trusting its paths. */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { exists } from '../util/fs.js'

/** One compilation database entry after resolution. */
export interface CompileCommandEntry {
  index: number
  directory: string
  file: string
  command?: string
  arguments?: string[]
  problems: string[]
}

/** Validation report for one `compile_commands.json`. */
export interface CompileDatabaseReport {
  path: string
  directory: string
  exists: boolean
  parseError?: string
  entries: number
  valid: number
  invalid: number
  uniqueFiles: string[]
  invalidEntries: CompileCommandEntry[]
  duplicateFiles: string[]
  compilerBinary?: string
  compilerFound?: boolean
}

/**
 * Read one compilation database and validate every entry against the filesystem.
 * @param path - absolute `compile_commands.json` path.
 * @param maxReported - number of invalid entries to include in detail.
 * @returns the validation report; a missing or malformed file is reported, not thrown.
 */
export async function readCompileDatabase(path: string, maxReported = 10): Promise<CompileDatabaseReport> {
  const directory = resolve(path, '..')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return {
      path,
      directory,
      exists: false,
      entries: 0,
      valid: 0,
      invalid: 0,
      uniqueFiles: [],
      invalidEntries: [],
      duplicateFiles: [],
      ...error instanceof Error ? { parseError: error.message } : {},
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      path,
      directory,
      exists: true,
      parseError: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      entries: 0,
      valid: 0,
      invalid: 0,
      uniqueFiles: [],
      invalidEntries: [],
      duplicateFiles: [],
    }
  }
  if (!Array.isArray(raw)) {
    return {
      path,
      directory,
      exists: true,
      parseError: 'compilation database root must be an array',
      entries: 0,
      valid: 0,
      invalid: 0,
      uniqueFiles: [],
      invalidEntries: [],
      duplicateFiles: [],
    }
  }
  const entries: CompileCommandEntry[] = []
  const seen = new Map<string, number>()
  const duplicates = new Set<string>()
  let compilerBinary: string | undefined
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index]
    const problems: string[] = []
    let entryDirectory = directory
    let file = ''
    let command: string | undefined
    let args: string[] | undefined
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push('entry must be an object')
    } else {
      const record = value as Record<string, unknown>
      if (typeof record.directory !== 'string' || record.directory.length === 0) {
        problems.push('directory must be a non-empty string')
      } else {
        entryDirectory = isAbsolute(record.directory) ? resolve(record.directory) : resolve(directory, record.directory)
        if (!await exists(entryDirectory)) problems.push(`directory does not exist: ${entryDirectory}`)
      }
      if (typeof record.file !== 'string' || record.file.length === 0) {
        problems.push('file must be a non-empty string')
      } else {
        file = isAbsolute(record.file) ? resolve(record.file) : resolve(entryDirectory, record.file)
        if (!await exists(file)) problems.push(`file does not exist: ${file}`)
      }
      if (typeof record.command === 'string' && record.command.length > 0) {
        command = record.command
      } else if (Array.isArray(record.arguments) && record.arguments.every(item => typeof item === 'string')) {
        args = record.arguments as string[]
        command = args.join(' ')
      } else {
        problems.push('one of command or arguments is required')
      }
      if (command !== undefined) {
        const binary = command.trim().split(/\s+/)[0] ?? ''
        if (binary.length > 0) {
          if (!isAbsolute(binary) && !binary.includes('/')) {
            compilerBinary = compilerBinary ?? binary
          } else if (!await exists(binary)) {
            problems.push(`compiler does not exist: ${binary}`)
          }
        }
      }
    }
    if (file.length > 0) {
      const previous = seen.get(file)
      if (previous !== undefined) duplicates.add(file)
      else seen.set(file, index)
    }
    entries.push({
      index,
      directory: entryDirectory,
      file,
      ...command === undefined ? {} : { command },
      ...args === undefined ? {} : { arguments: args },
      problems,
    })
  }
  const valid = entries.filter(entry => entry.problems.length === 0).length
  const compilerFound = compilerBinary === undefined ? undefined : await isOnPath(compilerBinary)
  return {
    path,
    directory,
    exists: true,
    entries: entries.length,
    valid,
    invalid: entries.length - valid,
    uniqueFiles: [...seen.keys()],
    invalidEntries: entries.filter(entry => entry.problems.length > 0).slice(0, maxReported),
    duplicateFiles: [...duplicates].slice(0, 20),
    ...compilerBinary === undefined ? {} : { compilerBinary },
    ...compilerFound === undefined ? {} : { compilerFound },
  }
}

async function isOnPath(name: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory.length > 0 && await exists(join(directory, name))) return true
  }
  return false
}
