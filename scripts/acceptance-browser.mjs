/**
 * Acceptance A-01/A-02 evidence run: complete a controlled registration while a
 * focus guard measures the frontmost app and pointer, then persist the report,
 * result, and screenshot under docs/evidence.
 *
 * Run: node scripts/acceptance-browser.mjs
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { startSite } from '../tests/fixtures/site/server.mjs'
import { resolveConfig } from '../dist/config.js'
import { BrowserManager } from '../dist/browser/manager.js'
import { FocusGuard } from '../dist/focus/guard.js'
import { Logger } from '../dist/util/log.js'

const root = resolve(import.meta.dirname, '..')
const stateDir = join(root, '.tmp', 'acceptance-a01')
const evidenceDir = join(root, 'docs', 'evidence')
await mkdir(evidenceDir, { recursive: true })
await rm(stateDir, { recursive: true, force: true })

const site = await startSite()
const config = resolveConfig({
  stateDir,
  chromeSandbox: 'auto',
  idleCloseMs: 0,
  notifications: false,
  logLevel: 'info',
})
const logger = new Logger(join(stateDir, 'logs', 'acceptance.log'), 'info')
const manager = new BrowserManager(config, logger)
const guard = new FocusGuard(200, logger)

function ref(result, name) {
  const control = result.snapshot.controls.find(candidate => candidate.name.toLowerCase().includes(name.toLowerCase()))
  if (control === undefined) throw new Error(`missing control ${name}: ${JSON.stringify(result.snapshot.controls)}`)
  return control.ref
}

try {
  const started = await guard.start('A-01 headless registration')
  console.log(`focus baseline: ${started.baseline?.name} (${started.baseline?.bundleId})`)
  let result = await manager.open('acceptance', `${site.url}/`)
  for (const [label, value] of [
    ['Full name', 'Acceptance Runner'],
    ['Work email', 'acceptance@example.test'],
    ['Company', 'Evidence Labs'],
    ['Password', 'test-only-password'],
  ]) result = await manager.act('acceptance', 'type', ref(result, label), value, false)
  result = await manager.act('acceptance', 'click', ref(result, 'Create account'), '', false)
  result = await manager.act('acceptance', 'type', ref(result, 'Verification code'), '123456', false)
  result = await manager.act('acceptance', 'click', ref(result, 'Verify email'), '', false)
  const status = await manager.evaluate('acceptance', 'document.querySelector("[data-testid=account-status]").textContent')
  if (status.result !== 'verified') throw new Error(`account status was ${String(status.result)}`)
  const screenshot = await manager.screenshot('acceptance')
  const report = guard.stop()
  const summary = {
    acceptance: 'A-01, A-02',
    finishedAt: new Date().toISOString(),
    site: site.url,
    browser: { mode: result.mode, sandbox: result.sandbox, version: result.browserVersion },
    finalUrl: result.url,
    accountStatus: status.result,
    focusVerdict: report.verdict,
    focusSamples: report.samples,
    focusTransitions: report.transitions,
    pointerMovedPx: report.pointer.movedPx,
    screenshot: join(evidenceDir, 'a01-dashboard.png'),
  }
  await cp(screenshot.path, join(evidenceDir, 'a01-dashboard.png'))
  await writeFile(join(evidenceDir, 'a01-focus-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(evidenceDir, 'a01-result.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
} finally {
  try { guard.stop() } catch { /* already stopped */ }
  await manager.dispose()
  await site.close()
  await rm(stateDir, { recursive: true, force: true })
}
