import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startSite } from '../fixtures/site/server.mjs'
import { BrowserManager } from '../../dist/browser/manager.js'
import { FocusGuard } from '../../dist/focus/guard.js'
import { makeConfig, makeLogger, makeScratch, removeScratch } from '../unit/helpers.mjs'

function refFor(result, name) {
  const control = result.snapshot.controls.find(candidate => candidate.name.toLowerCase().includes(name.toLowerCase()))
  if (control === undefined) {
    throw new Error(`control ${name} not found; controls=${result.snapshot.controls.map(item => `${item.ref}:${item.role}:${item.name}`).join(' | ')}`)
  }
  return control.ref
}

test('isolated browser completes a real multi-page registration and reuses the profile', async () => {
  const stateDir = await makeScratch('browser-e2e')
  const site = await startSite()
  const manager = new BrowserManager(makeConfig(stateDir), makeLogger(stateDir))
  const guard = new FocusGuard(200, makeLogger(stateDir))
  try {
    const baseline = await guard.start('headless registration')
    assert.equal(baseline.baseline?.supported, true)

    let result = await manager.open('e2e-account', `${site.url}/`)
    assert.equal(result.mode, 'headless')
    assert.equal(result.url, `${site.url}/`)
    assert.match(result.snapshot.title, /Create account/)

    for (const [label, value] of [
      ['Full name', 'Ada Lovelace'],
      ['Work email', 'ada@example.test'],
      ['Company', 'Analytical Engines'],
      ['Password', 'correct-horse-battery'],
    ]) {
      result = await manager.act('e2e-account', 'type', refFor(result, label), value, false)
    }
    result = await manager.act('e2e-account', 'click', refFor(result, 'Create account'), '', false)
    assert.match(result.url, /\/verify$/)
    assert.match(result.snapshot.text, /Check your email/)
    assert.match(result.snapshot.text, /ada@example\.test/)

    result = await manager.act('e2e-account', 'type', refFor(result, 'Verification code'), '123456', false)
    result = await manager.act('e2e-account', 'click', refFor(result, 'Verify email'), '', false)
    assert.match(result.url, /\/dashboard$/)
    assert.match(result.snapshot.text, /Account status:\s*verified/)

    const status = await manager.evaluate('e2e-account', 'document.querySelector("[data-testid=account-status]").textContent')
    assert.equal(status.result, 'verified')

    const screenshot = await manager.screenshot('e2e-account')
    assert.ok(screenshot.bytes > 1_000)
    assert.equal((await readFile(screenshot.path)).subarray(1, 4).toString(), 'PNG')

    result = await manager.act('e2e-account', 'click', refFor(result, 'Download sample report'), '', false)
    let downloads = []
    for (let attempt = 0; attempt < 20 && downloads.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      downloads = await manager.downloads('e2e-account')
    }
    assert.equal(downloads.length, 1, 'the isolated profile should receive the downloaded CSV')
    assert.match(await readFile(downloads[0].path, 'utf8'), /alpha,ready/)

    result = await manager.act('e2e-account', 'click', refFor(result, 'Configure project'), '', false)
    assert.match(result.url, /\/settings$/)
    result = await manager.act('e2e-account', 'type', refFor(result, 'Project name'), 'lovable-demo', false)
    result = await manager.act('e2e-account', 'select', refFor(result, 'Region'), 'ap', false)
    result = await manager.act('e2e-account', 'click', refFor(result, 'I accept the test terms'), '', false)
    result = await manager.act('e2e-account', 'click', refFor(result, 'Save settings'), '', false)
    assert.match(result.url, /\/dashboard$/)
    assert.match(result.snapshot.text, /Configuration:\s*configured/)

    const [left, right] = await Promise.all([
      manager.snapshot('e2e-account'),
      manager.snapshot('e2e-account'),
    ])
    assert.equal(left.url, right.url)

    await manager.close('e2e-account', false)
    const reopened = await manager.open('e2e-account', `${site.url}/dashboard`)
    assert.equal(reopened.url, `${site.url}/dashboard`)
    assert.match(reopened.snapshot.text, /Account status:\s*verified/)
    assert.match(reopened.snapshot.text, /Configuration:\s*configured/)

    const health = await manager.evaluate('e2e-account', 'fetch("/api/health").then(response => response.json())')
    assert.equal(health.result.ok, true)

    const report = guard.stop()
    await writeFile(join(stateDir, 'focus-report.json'), JSON.stringify(report, null, 2))
    assert.ok(report.samples >= 3)
    assert.equal(report.baseline?.supported, true)
    // The desktop is live: another application may legitimately take focus
    // while the test runs. The assertion is that OUR isolated browser did not.
    // External transitions are recorded in the report and are not attributed.
    const chromeTransition = report.transitions.find(transition => /chrome|chromium|edge/i.test(transition.to.bundleId))
    assert.equal(chromeTransition, undefined, `the isolated browser took the foreground: ${JSON.stringify(report.transitions)}`)
    assert.notEqual(report.verdict, 'unsupported')
    if (report.transitions.length > 0) {
      console.warn('external focus transitions observed (not attributed to the browser):', JSON.stringify(report.transitions))
    }
  } finally {
    try { guard.stop() } catch { /* already stopped */ }
    await manager.dispose()
    await site.close()
    await removeScratch(stateDir)
  }
})

test('profile reset removes login state and downloads', async () => {
  const stateDir = await makeScratch('browser-reset')
  const site = await startSite()
  const manager = new BrowserManager(makeConfig(stateDir), makeLogger(stateDir))
  try {
    let result = await manager.open('reset-me', `${site.url}/`)
    for (const [label, value] of [
      ['Full name', 'Reset Person'],
      ['Work email', 'reset@example.test'],
      ['Company', 'Reset Co'],
      ['Password', 'password-1'],
    ]) result = await manager.act('reset-me', 'type', refFor(result, label), value, false)
    result = await manager.act('reset-me', 'click', refFor(result, 'Create account'), '', false)
    result = await manager.act('reset-me', 'type', refFor(result, 'Verification code'), '123456', false)
    result = await manager.act('reset-me', 'click', refFor(result, 'Verify email'), '', false)
    assert.match(result.url, /dashboard/)
    await manager.close('reset-me', true)
    const reopened = await manager.open('reset-me', `${site.url}/dashboard`)
    assert.equal(reopened.url, `${site.url}/`, 'reset must discard the login cookie')
    assert.match(reopened.snapshot.title, /Create account/)
  } finally {
    await manager.dispose()
    await site.close()
    await removeScratch(stateDir)
  }
})

test('wait_for and keyboard press operate through the isolated browser', async () => {
  const stateDir = await makeScratch('browser-wait-press')
  const site = await startSite()
  const manager = new BrowserManager(makeConfig(stateDir), makeLogger(stateDir))
  try {
    let result = await manager.open('keyboard', `${site.url}/`)
    const waited = await manager.waitFor('keyboard', '#register-form', '', 3_000)
    assert.equal(waited.found, true)
    const waitedText = await manager.waitFor('keyboard', '', 'Create a developer account', 3_000)
    assert.equal(waitedText.found, true)
    const timedOut = await manager.waitFor('keyboard', '#does-not-exist', '', 400)
    assert.equal(timedOut.found, false)

    for (const [label, value] of [
      ['Full name', 'Keyboard Person'],
      ['Work email', 'keyboard@example.test'],
      ['Company', 'Keys Inc'],
      ['Password', 'password-2'],
    ]) result = await manager.act('keyboard', 'type', refFor(result, label), value, false)
    result = await manager.act('keyboard', 'click', refFor(result, 'Create account'), '', false)
    result = await manager.act('keyboard', 'type', refFor(result, 'Verification code'), '123456', false)
    result = await manager.press('keyboard', 'Enter')
    assert.match(result.url, /\/dashboard$/)
    assert.match(result.snapshot.text, /Account status:\s*verified/)
  } finally {
    await manager.dispose()
    await site.close()
    await removeScratch(stateDir)
  }
})
