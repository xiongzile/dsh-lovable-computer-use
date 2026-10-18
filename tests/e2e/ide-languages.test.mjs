import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { probeLsp } from '../../dist/ide/lsp.js'
import { findLanguageServerById } from '../../dist/ide/servers.js'
import { runRuntimeCheck } from '../../dist/ide/runtimeCheck.js'
import { diagnoseProject } from '../../dist/ide/diagnose.js'
import { applyIdeFix } from '../../dist/ide/fix.js'
import { findExecutable } from '../../dist/util/fs.js'
import { registerIdeTools } from '../../dist/tools/ide.js'
import { makeConfig, makeLogger, makeScratch, removeScratch, ROOT, callTool, fakeExec } from '../unit/helpers.mjs'

const rustAnalyzer = await findExecutable('rust-analyzer', [join(process.env.HOME ?? '', '.cargo', 'bin', 'rust-analyzer')])
const python = await findExecutable('python3', ['/opt/homebrew/bin/python3', '/usr/bin/python3'])

test('generic LSP probe verifies a non-C++ server without external dependencies', async () => {
  const stateDir = await makeScratch('ide-generic-lsp')
  try {
    const project = join(ROOT, 'tests/fixtures/python-ok')
    const probe = await probeLsp({
      projectDir: project,
      sourceFile: join(project, 'main.py'),
      language: 'python',
      languageId: 'python',
      serverId: 'pylsp',
      serverPath: process.execPath,
      serverArgs: [join(ROOT, 'tests/fixtures/fake-lsp.mjs')],
      timeoutMs: 20_000,
      logger: makeLogger(stateDir),
    })
    assert.equal(probe.verdict, 'lsp_verified')
    assert.equal(probe.features.semanticTokens, 2)
    assert.equal(probe.features.completionItems, 1)
    assert.equal(probe.features.documentSymbols, 1)
    assert.equal(probe.features.definitions, 1)
    assert.match(probe.features.hover ?? '', /fake hover/)
  } finally {
    await removeScratch(stateDir)
  }
})

test('Python diagnosis, runtime check, and VS Code interpreter fix are language-agnostic', { skip: python === undefined ? 'python3 not available' : false }, async () => {
  const stateDir = await makeScratch('ide-python')
  try {
    const project = join(stateDir, 'project')
    await cp(join(ROOT, 'tests/fixtures/python-ok'), project, { recursive: true })
    await mkdir(join(project, '.venv', 'bin'), { recursive: true })
    await symlink(python, join(project, '.venv', 'bin', 'python'))

    const config = makeConfig(stateDir)
    const logger = makeLogger(stateDir)
    const diagnosis = await diagnoseProject({ projectDir: project, config })
    assert.ok(diagnosis.languages.some(info => info.language === 'python'))
    assert.ok(diagnosis.findings.some(finding => finding.id === 'python-interpreter-configured'))
    assert.ok(!diagnosis.findings.some(finding => finding.id === 'clangd-missing'))

    const runtime = await runRuntimeCheck({
      projectDir: project,
      language: 'python',
      sourceFile: join(project, 'main.py'),
      module: 'main',
      mode: 'auto',
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    })
    assert.equal(runtime.status, 'passed')
    assert.match(runtime.detail, /py_compile.*ok/)
    assert.match(runtime.detail, /import main.*ok/)

    const dry = await applyIdeFix({ projectDir: project, finding: 'vscode-python-interpreter', apply: false, config })
    assert.equal(dry.applied, false)
    assert.match(dry.diff ?? '', /python\.defaultInterpreterPath/)

    const applied = await applyIdeFix({ projectDir: project, finding: 'vscode-python-interpreter', apply: true, config })
    assert.equal(applied.applied, true)
    assert.ok(applied.backupPath)
    const settings = JSON.parse(await readFile(join(project, '.vscode', 'settings.json'), 'utf8'))
    assert.equal(settings['python.defaultInterpreterPath'], '${workspaceFolder}/.venv/bin/python')
    assert.equal(settings['editor.formatOnSave'], true)
    assert.match(await readFile(applied.backupPath, 'utf8'), /editor\.formatOnSave/)

    const probe = await probeLsp({
      projectDir: project,
      sourceFile: join(project, 'main.py'),
      language: 'python',
      languageId: 'python',
      serverId: 'pylsp',
      serverPath: process.execPath,
      serverArgs: [join(ROOT, 'tests/fixtures/fake-lsp.mjs')],
      timeoutMs: 20_000,
      logger,
    })
    assert.equal(probe.verdict, 'lsp_verified')
  } finally {
    await removeScratch(stateDir)
  }
})

test('rust-analyzer provides real non-C++ LSP features', { skip: rustAnalyzer === undefined ? 'rust-analyzer not installed' : false, timeout: 90_000 }, async () => {
  const stateDir = await makeScratch('ide-rust')
  try {
    const project = join(stateDir, 'project')
    await cp(join(ROOT, 'tests/fixtures/rust-ok'), project, { recursive: true })
    const probe = await probeLsp({
      projectDir: project,
      sourceFile: join(project, 'src', 'main.rs'),
      language: 'rust',
      languageId: 'rust',
      serverId: 'rust-analyzer',
      serverPath: rustAnalyzer,
      serverArgs: [],
      timeoutMs: 60_000,
      logger: makeLogger(stateDir),
    })
    assert.notEqual(probe.verdict, 'failed', probe.detail)
    assert.ok(
      probe.features.documentSymbols > 0 || probe.features.completionItems > 0 || probe.features.hover !== undefined,
      `rust-analyzer returned no usable feature: ${JSON.stringify(probe.features)}`,
    )
  } finally {
    await removeScratch(stateDir)
  }
})

test('ide_verify uses the selected language server and reports host confirmation', { skip: rustAnalyzer === undefined ? 'rust-analyzer not installed' : false, timeout: 90_000 }, async () => {
  const stateDir = await makeScratch('ide-tool-rust')
  try {
    const project = join(stateDir, 'project')
    await cp(join(ROOT, 'tests/fixtures/rust-ok'), project, { recursive: true })
    const config = makeConfig(stateDir)
    const tools = registerIdeTools({ config, logger: makeLogger(stateDir) })
    const verify = tools.find(tool => tool.name === 'ide_verify')
    assert.ok(verify)
    const result = await callTool(verify, { projectDir: project, language: 'rust', runtimeCheck: 'off' }, fakeExec())
    assert.notEqual(result.verdict, 'failed', JSON.stringify(result))
    assert.equal(result.server.id, 'rust-analyzer')
    assert.equal(result.requiresHostConfirmation, true)
    assert.equal(result.language, 'rust')
  } finally {
    await removeScratch(stateDir)
  }
})

test('ide_verify falls back to a Python runtime check when no LSP server is installed', { skip: python === undefined ? 'python3 not available' : false, timeout: 60_000 }, async () => {
  const stateDir = await makeScratch('ide-tool-python')
  try {
    const project = join(stateDir, 'project')
    await cp(join(ROOT, 'tests/fixtures/python-ok'), project, { recursive: true })
    await mkdir(join(project, '.venv', 'bin'), { recursive: true })
    await symlink(python, join(project, '.venv', 'bin', 'python'))
    const config = makeConfig(stateDir)
    const tools = registerIdeTools({ config, logger: makeLogger(stateDir) })
    const verify = tools.find(tool => tool.name === 'ide_verify')
    assert.ok(verify)
    const result = await callTool(verify, { projectDir: project, language: 'python', sourceFile: 'main.py', runtimeCheck: 'auto', module: 'main' }, fakeExec())
    assert.equal(result.runtimeCheck.status, 'passed')
    assert.equal(result.verdict, 'runtime_verified')
    assert.equal(result.server, undefined)
    assert.equal(result.requiresHostConfirmation, true)
  } finally {
    await removeScratch(stateDir)
  }
})

test('pyright selection prefers pyright-langserver over the pyright CLI', { concurrency: false }, async () => {
  const stateDir = await makeScratch('ide-pyright-name')
  const previousPath = process.env.PATH
  try {
    const bin = join(stateDir, 'bin')
    await mkdir(bin, { recursive: true })
    for (const name of ['pyright', 'pyright-langserver']) {
      const path = join(bin, name)
      await writeFile(path, '#!/bin/sh\nexit 0\n')
      await chmod(path, 0o755)
    }
    process.env.PATH = `${bin}:${previousPath ?? ''}`
    const spec = await findLanguageServerById('pyright', makeConfig(stateDir))
    assert.ok(spec)
    assert.ok(spec.path.endsWith('/pyright-langserver'), `selected ${spec.path}`)
    assert.deepEqual(spec.args, ['--stdio'])
  } finally {
    process.env.PATH = previousPath
    await removeScratch(stateDir)
  }
})
