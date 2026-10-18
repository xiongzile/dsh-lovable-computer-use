import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startSite } from '../fixtures/site/server.mjs'
import { BrowserManager } from '../../dist/browser/manager.js'
import { makeConfig, makeLogger, makeScratch, removeScratch, ROOT } from '../unit/helpers.mjs'

test('a second process cannot use the same profile while the first owns it', async () => {
  const stateDir = await makeScratch('profile-lock')
  const site = await startSite()
  const manager = new BrowserManager(makeConfig(stateDir), makeLogger(stateDir))
  try {
    await manager.open('shared-profile', site.url)
    const childScript = join(stateDir, 'contender.mjs')
    await writeFile(childScript, `
import { BrowserManager } from ${JSON.stringify(join(ROOT, 'dist', 'browser', 'manager.js'))}
import { resolveConfig } from ${JSON.stringify(join(ROOT, 'dist', 'config.js'))}
import { Logger } from ${JSON.stringify(join(ROOT, 'dist', 'util', 'log.js'))}
import { join } from 'node:path'
const [stateDir, url] = process.argv.slice(2)
const config = resolveConfig({ stateDir, chromeSandbox: 'disabled', idleCloseMs: 0, logLevel: 'error' })
const manager = new BrowserManager(config, new Logger(join(stateDir, 'logs', 'contender.log'), 'error'))
try {
  await manager.open('shared-profile', url)
  console.log('UNEXPECTED_SUMMARY')
  process.exitCode = 0
} catch (error) {
  if (!/in use by process/.test(String(error.message))) throw error
  console.log(String(error.message))
} finally {
  await manager.dispose()
}
`)
    const child = spawnSync(process.execPath, [childScript, stateDir, site.url], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /in use by process/)
    assert.match(child.stdout, /Concurrent use of one Chromium profile is rejected/)
    const profiles = await manager.list()
    assert.equal(profiles[0].inUse, true)
    assert.equal(profiles[0].pid, process.pid)
  } finally {
    await manager.dispose()
    await site.close()
    await removeScratch(stateDir)
  }
})
