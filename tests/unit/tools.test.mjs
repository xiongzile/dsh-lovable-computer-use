import test from 'node:test'
import assert from 'node:assert/strict'
import { access, cp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../../dist/index.js'
import { makeConfig, makeScratch, removeScratch, callTool, fakeExec, ROOT } from './helpers.mjs'

function makeContext({ userQuestions, answerSequence = [] } = {}) {
  const tools = []
  const sections = []
  const effects = []
  const answers = [...answerSequence]
  const service = userQuestions === undefined ? undefined : {
    ask: async request => {
      const next = answers.shift() ?? '已处理，继续'
      return { answers: [{ id: request.questions[0].id, selected: [next] }] }
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    get(name) {
      return name === 'userQuestions' ? service : undefined
    },
    systemPrompt: {
      getSectionOrder: () => 42,
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    effect(execute) {
      effects.push(execute)
      return () => {}
    },
  }
  return { ctx, tools, sections, effects }
}

async function withPlugin(options, run) {
  const stateDir = await makeScratch('tools')
  const context = makeContext(options)
  apply(context.ctx, makeConfig(stateDir))
  await new Promise(resolve => setTimeout(resolve, 20))
  try {
    await run({ ...context, stateDir, tools: Object.fromEntries(context.tools.map(tool => [tool.name, tool])) })
  } finally {
    for (const effect of context.effects) {
      const disposer = effect()
      if (typeof disposer === 'function') await disposer()
    }
    await removeScratch(stateDir)
  }
}

test('apply registers only decision/resource tools, never a parallel task lifecycle', async () => {
  await withPlugin({}, async ({ tools, sections }) => {
    const names = Object.keys(tools)
    assert.equal(names.length, 17, `expected 17 tools, got ${names.length}: ${names.join(', ')}`)
    assert.equal(new Set(names).size, names.length)
    assert.deepEqual(names.filter(name => name.startsWith('task_')), [])
    for (const required of [
      'background_browser_open', 'background_browser_act', 'background_browser_handoff',
      'ide_diagnose', 'ide_verify', 'ide_fix', 'focus_guard', 'notify_user',
    ]) {
      assert.ok(names.includes(required), `missing ${required}`)
    }
    for (const tool of Object.values(tools)) {
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.execute, 'function')
      assert.ok(tool.description.length > 40)
      assert.ok(!JSON.stringify(tool.parameters).includes('taskId'), `${tool.name} still has a taskId parameter`)
    }
    assert.equal(sections.length, 1)
    assert.match(sections[0].text, /background_browser_handoff/)
    assert.match(sections[0].text, /DSH records the turn/)
    assert.doesNotMatch(sections[0].text, /task_start|task_evidence|task_finish|task_recover/)
    assert.equal(sections[0].interpolate, false)
    await assert.rejects(access(join(ROOT, 'dist', 'task', 'store.js')), /ENOENT/)
    await assert.rejects(access(join(ROOT, 'dist', 'tools', 'task.js')), /ENOENT/)
  })
})

test('headed browser handoff refuses without a human-interaction provider', async () => {
  await withPlugin({ userQuestions: undefined }, async ({ tools }) => {
    const result = await callTool(tools.background_browser_handoff, {
      profile: 'refusal-test',
      reason: 'email verification',
      instructions: 'enter the code',
    })
    assert.equal(result.status, 'unavailable')
    assert.match(result.message, /no human-interaction provider/)
  })
})

test('declining the visible handoff does not open a window or require task state', async () => {
  await withPlugin({ userQuestions: {}, answerSequence: ['取消'] }, async ({ tools }) => {
    const result = await callTool(tools.background_browser_handoff, {
      profile: 'decline-test',
      reason: 'email verification',
      instructions: 'enter the code',
    })
    assert.equal(result.status, 'declined')
    assert.match(result.message, /stays headless/)
  })
})

test('invalid browser inputs are rejected before launch', async () => {
  await withPlugin({}, async ({ tools }) => {
    await assert.rejects(
      () => callTool(tools.background_browser_open, { profile: '../escape', url: 'https://example.com' }),
      /profile must match/,
    )
    await assert.rejects(
      () => callTool(tools.background_browser_open, { profile: 'safe', url: 'file:///etc/passwd' }),
      /scheme file: is not allowed/,
    )
    await assert.rejects(
      () => callTool(tools.background_browser_close, { profile: 'safe', reset: true }),
      /confirm=true/,
    )
  })
})

test('notify_user honors configuration and focus_guard records real samples', async () => {
  await withPlugin({}, async ({ tools }) => {
    const notice = await callTool(tools.notify_user, { title: 'test', message: 'message' })
    assert.equal(notice.delivered, false)
    assert.match(notice.error, /disabled/)

    const started = await callTool(tools.focus_guard, { action: 'start', label: 'unit' })
    assert.match(started.id, /^focus-/)
    await new Promise(resolve => setTimeout(resolve, 700))
    const status = await callTool(tools.focus_guard, { action: 'status' })
    assert.equal(status.report.active, true)
    const stopped = await callTool(tools.focus_guard, { action: 'stop' })
    assert.ok(['no-interruption', 'focus-changed', 'unsupported'].includes(stopped.verdict))
    assert.ok(stopped.report.samples >= 1)
  })
})

test('ide_fix refuses writes outside the session workspace by default', async () => {
  await withPlugin({}, async ({ tools }) => {
    const outside = await import('node:os').then(os => os.tmpdir())
    await assert.rejects(
      () => callTool(tools.ide_fix, {
        projectDir: `${outside}/lovable-outside-workspace`,
        finding: 'clangd-config',
        compileCommandsDir: `${outside}/lovable-outside-workspace/build`,
        apply: true,
      }),
      /outside the session workspace/,
    )
  })
})

test('ide tools diagnose the broken database and dry-run the config fix', async () => {
  const stateDir = await makeScratch('ide-tools')
  try {
    const project = join(stateDir, 'project')
    await cp(join(ROOT, 'tests/fixtures/cpp-ok'), project, { recursive: true })
    await withPlugin({}, async ({ tools }) => {
      const diagnosis = await callTool(tools.ide_diagnose, { projectDir: join(ROOT, 'tests/fixtures/cpp-broken') })
      assert.equal(diagnosis.diagnosis.status, 'broken')
      assert.ok(diagnosis.diagnosis.findings.some(finding => finding.id === 'invalid-compile-commands'))
      const dry = await callTool(tools.ide_fix, {
        projectDir: project,
        finding: 'clangd-config',
        compileCommandsDir: join(project, 'build'),
        apply: false,
      })
      assert.equal(dry.result.applied, false)
      await assert.rejects(() => stat(join(project, '.clangd')), /ENOENT/)
      assert.match(dry.result.diff, /CompilationDatabase/)
    })
  } finally {
    await removeScratch(stateDir)
  }
})
