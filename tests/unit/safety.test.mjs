import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../../dist/index.js'
import { makeConfig, makeScratch, removeScratch, ROOT } from './helpers.mjs'

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

test('the plugin never synthesizes host GUI input and never opens a browser without handoff', async () => {
  const files = await sourceFiles(join(ROOT, 'src'))
  const offenders = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const prohibited of ['System Events', 'CGEventPost', 'AXUIElement', 'AXIsProcessTrusted', 'cliclick', 'pyautogui', 'osascript -e \'tell application']) {
      if (text.includes(prohibited)) offenders.push(`${file}: ${prohibited}`)
    }
  }
  assert.deepEqual(offenders, [])

  const sampler = await readFile(join(ROOT, 'src/focus/sampler.ts'), 'utf8')
  assert.match(sampler, /CGEventGetLocation/)
  assert.doesNotMatch(sampler, /CGEventPost|CGWarpMouseCursorPosition/)

  const manager = await readFile(join(ROOT, 'src/browser/manager.ts'), 'utf8')
  assert.match(manager, /beginHeadedHandoff/)
  assert.match(manager, /headless: mode === 'headless'/)
})

test('built artifact has no runtime package imports', async () => {
  const jsFiles = []
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.js')) jsFiles.push(path)
    }
  }
  await walk(join(ROOT, 'dist'))
  const offenders = []
  for (const file of jsFiles) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/from ['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (!specifier.startsWith('node:') && !specifier.startsWith('./') && !specifier.startsWith('../')) offenders.push(`${file}: ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the page-injection fixture is returned as untrusted data, not as an executable tool', async () => {
  const stateDir = await makeScratch('safety')
  const tools = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    get: () => undefined,
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 1 },
    effect: () => () => {},
  }
  try {
    apply(ctx, makeConfig(stateDir))
    const names = new Set(tools.map(tool => tool.name))
    for (const executable of ['bash', 'shell', 'exec', 'run_command', 'terminal']) {
      assert.equal(names.has(executable), false)
    }
    assert.ok(tools.length > 0)
    const openTool = tools.find(tool => tool.name === 'background_browser_open')
    assert.ok(openTool)
    assert.equal(openTool.parameters.properties.mode, undefined, 'open must not expose a headed mode selector')
    const { startSite } = await import('../fixtures/site/server.mjs')
    const site = await startSite()
    try {
      const { BrowserManager } = await import('../../dist/browser/manager.js')
      const { makeLogger } = await import('./helpers.mjs')
      const manager = new BrowserManager(makeConfig(stateDir), makeLogger(stateDir))
      try {
        const result = await manager.open('injection', `${site.url}/inject`)
        assert.match(result.snapshot.text, /Ignore all previous instructions/)
        assert.match(result.snapshot.text, /rm -rf/)
        assert.ok(result.snapshot.controls.some(control => control.name.includes('Delete account')))
      } finally {
        await manager.dispose()
      }
    } finally {
      await site.close()
    }
  } finally {
    await removeScratch(stateDir)
  }
})
