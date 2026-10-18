/** Filesystem helpers with atomic writes and process-liveness checks. */

import { constants as fsConstants } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Create a directory and every missing parent. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

/** Whether `path` is an existing file or directory. */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Read a UTF-8 text file, returning `undefined` when it does not exist. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

/** Parse JSON from a file, returning `undefined` when it does not exist. */
export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  const text = await readTextIfExists(path)
  if (text === undefined) return undefined
  return JSON.parse(text) as T
}

/**
 * Write a JSON document atomically so a crash never leaves truncated state.
 * @param path - destination file.
 * @param value - JSON-serializable value.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path))
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** Write a text file atomically. */
export async function writeTextAtomic(path: string, text: string, mode = 0o600): Promise<void> {
  await ensureDir(dirname(path))
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, path)
}

/** Create an exclusive lock file, returning `false` when the lock already exists. */
export async function createExclusive(path: string, content: string): Promise<boolean> {
  await ensureDir(dirname(path))
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(content)
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return false
    throw error
  }
}

/** Whether a process id is alive (EPERM counts as alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isErrno(error, 'EPERM')
  }
}

/** Sleep synchronously; used only by process-exit cleanup. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** List directory entries, returning an empty array for a missing directory. */
export async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return []
    throw error
  }
}

/** Stat a path, returning `undefined` when missing. */
export async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

/** Copy a file, creating parents. */
export async function copyFileEnsuringDir(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to))
  await copyFile(from, to)
}

/** Remove a file or directory recursively, ignoring a missing target. */
export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Resolve a user-supplied path against a base directory and require absoluteness. */
export function resolvePath(input: string, base = process.cwd()): string {
  return isAbsolute(input) ? resolve(input) : resolve(base, input)
}

/** The Harness home used to place durable plugin state. */
export function harnessHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/** Narrow an unknown error to a Node errno code. */
export function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code
}

/** Discover an executable by name on PATH or among explicit candidates. */
export async function findExecutable(
  name: string,
  candidates: readonly string[] = [],
  envPath = process.env.PATH ?? '',
): Promise<string | undefined> {
  const names = process.platform === 'win32' ? [name, `${name}.exe`, `${name}.cmd`] : [name]
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }
  for (const directory of envPath.split(':')) {
    if (directory.length === 0) continue
    for (const executable of names) {
      const candidate = join(directory, executable)
      if (await isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A compact timestamp safe for directory names. */
export function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}
