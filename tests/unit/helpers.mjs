/** Shared helpers for the node:test suites. */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../../dist/config.js'
import { Logger } from '../../dist/util/log.js'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRATCH = join(ROOT, '.tmp', 'tests')

export async function makeScratch(prefix) {
  await import('node:fs/promises').then(fs => fs.mkdir(SCRATCH, { recursive: true }))
  return mkdtemp(join(SCRATCH, `${prefix}-`))
}

export async function removeScratch(path) {
  await rm(path, { recursive: true, force: true })
}

export function makeConfig(stateDir, overrides = {}) {
  return resolveConfig({
    stateDir,
    chromeSandbox: 'disabled',
    logLevel: 'error',
    idleCloseMs: 0,
    notifications: false,
    ...overrides,
  })
}

export function makeLogger(stateDir) {
  return new Logger(join(stateDir, 'logs', 'test.log'), 'error')
}

export function fakeExec(overrides = {}) {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    agent: { id: 'session-test', session: { id: 'session-test', header: { cwd: ROOT } } },
    controller,
    ...overrides,
  }
}

export async function callTool(tool, args, exec = fakeExec()) {
  return tool.execute.call(tool, args, exec)
}

export function tempDir() {
  return tmpdir()
}

export { ROOT }
