import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { diagnoseProject } from '../../dist/ide/diagnose.js'
import { probeClangd } from '../../dist/ide/clangd.js'
import { applyIdeFix } from '../../dist/ide/fix.js'
import { readCompileDatabase } from '../../dist/ide/compileCommands.js'
import { findExecutable } from '../../dist/util/fs.js'
import { makeConfig, makeLogger, makeScratch, removeScratch, ROOT } from '../unit/helpers.mjs'

const clangd = await findExecutable('clangd', ['/opt/homebrew/opt/llvm/bin/clangd', '/usr/local/opt/llvm/bin/clangd'])
const cmake = await findExecutable('cmake', ['/Applications/CMake.app/Contents/bin/cmake', '/opt/homebrew/bin/cmake'])

async function prepareProject(stateDir) {
  const project = join(stateDir, 'project')
  await cp(join(ROOT, 'tests/fixtures/cpp-ok'), project, { recursive: true })
  const commands = [{
    directory: join(project, 'build'),
    file: '../src/main.cpp',
    command: `${join('/opt/homebrew/opt/llvm/bin', 'clang++')} -std=c++17 -I../include -c ../src/main.cpp`,
  }]
  await writeFile(join(project, 'build', 'compile_commands.json'), JSON.stringify(commands, null, 2))
  return project
}

test('IDE diagnosis, live clangd verification, and reversible .clangd fix', { skip: clangd === undefined ? 'clangd not installed' : false }, async () => {
  const stateDir = await makeScratch('ide-e2e')
  try {
    const project = await prepareProject(stateDir)
    const config = makeConfig(stateDir)
    const logger = makeLogger(stateDir)
    const diagnosis = await diagnoseProject({ projectDir: project, config })
    assert.equal(diagnosis.status, 'degraded')
    assert.ok(diagnosis.findings.some(finding => finding.id === 'clangd-config-missing'))
    assert.equal(diagnosis.clangd.found, true)

    const probe = await probeClangd({
      projectDir: project,
      sourceFile: join(project, 'src', 'main.cpp'),
      compileCommandsDir: join(project, 'build'),
      timeoutMs: 30_000,
      clangdPath: clangd,
      logger,
    })
    assert.equal(probe.verdict, 'lsp_verified')
    assert.ok(probe.features.semanticTokens > 0)
    assert.ok(probe.features.completionItems > 0)
    assert.equal(probe.compileDatabaseLoaded, true)
    assert.deepEqual(probe.stderrSignals, [])

    const dry = await applyIdeFix({ projectDir: project, finding: 'clangd-config', compileCommandsDir: join(project, 'build'), apply: false, config })
    assert.equal(dry.applied, false)
    await assert.rejects(() => readFile(join(project, '.clangd')), /ENOENT/)

    await writeFile(join(project, '.clangd'), 'CompileFlags:\n  Add: [-Wall]\n')
    const applied = await applyIdeFix({ projectDir: project, finding: 'clangd-config', compileCommandsDir: join(project, 'build'), apply: true, config })
    assert.equal(applied.applied, true)
    assert.ok(applied.backupPath)
    const updated = await readFile(join(project, '.clangd'), 'utf8')
    assert.match(updated, /Add: \[-Wall\]/)
    assert.match(updated, /CompilationDatabase: /)
    assert.match(await readFile(applied.backupPath, 'utf8'), /Add: \[-Wall\]/)

    const withoutExplicitDatabase = await probeClangd({
      projectDir: project,
      sourceFile: join(project, 'src', 'main.cpp'),
      timeoutMs: 30_000,
      clangdPath: clangd,
      logger,
    })
    assert.ok(withoutExplicitDatabase.features.semanticTokens > 0, 'clangd should load .clangd CompilationDatabase')
    assert.equal(withoutExplicitDatabase.compileDatabaseLoaded, false)

    await cp(applied.backupPath, join(project, '.clangd'))
    assert.equal(await readFile(join(project, '.clangd'), 'utf8'), 'CompileFlags:\n  Add: [-Wall]\n')
  } finally {
    await removeScratch(stateDir)
  }
})

test('invalid database entries are reported and a wrong clangd database directory is detected', { skip: clangd === undefined ? 'clangd not installed' : false }, async () => {
  const stateDir = await makeScratch('ide-broken-e2e')
  try {
    const project = join(ROOT, 'tests/fixtures/cpp-broken')
    const config = makeConfig(stateDir)
    const diagnosis = await diagnoseProject({ projectDir: project, config })
    assert.equal(diagnosis.status, 'broken')
    const finding = diagnosis.findings.find(item => item.id === 'invalid-compile-commands')
    assert.ok(finding)
    assert.ok(finding.evidence.some(line => line.includes('/nonexistent/build-dir')))

    const probe = await probeClangd({
      projectDir: project,
      sourceFile: join(project, 'src', 'main.cpp'),
      compileCommandsDir: join(stateDir, 'missing-database'),
      timeoutMs: 30_000,
      clangdPath: clangd,
      logger: makeLogger(stateDir),
    })
    assert.equal(probe.compileDatabaseLoaded, false)
    assert.ok(probe.stderrSignals.some(signal => /does not exist|Failed to find compilation database/i.test(signal)))
  } finally {
    await removeScratch(stateDir)
  }
})

test('CMake fix regenerates a compile_commands.json that clangd can use', { skip: cmake === undefined || clangd === undefined ? 'cmake or clangd not installed' : false }, async () => {
  const stateDir = await makeScratch('ide-cmake-e2e')
  try {
    const project = join(stateDir, 'tiny')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\nproject(tiny CXX)\nadd_executable(tiny main.cpp)\n')
    await writeFile(join(project, 'main.cpp'), '#include <string>\n#include <vector>\nint main() { std::vector<int> values{1,2,3}; std::string text = "ok"; return values.size() == text.size() ? 0 : 1; }\n')
    const config = makeConfig(stateDir)
    const result = await applyIdeFix({ projectDir: project, finding: 'compile-commands', apply: true, config })
    assert.equal(result.applied, true)
    const database = await readCompileDatabase(join(project, 'build', 'compile_commands.json'))
    assert.ok(database.valid >= 1)
    assert.equal(database.invalid, 0)
    const probe = await probeClangd({
      projectDir: project,
      sourceFile: join(project, 'main.cpp'),
      compileCommandsDir: join(project, 'build'),
      timeoutMs: 30_000,
      clangdPath: clangd,
      logger: makeLogger(stateDir),
    })
    assert.equal(probe.verdict, 'lsp_verified')
    assert.ok(probe.features.semanticTokens > 0)
    assert.match(result.rollback, /rm|\bcp\b/)
  } finally {
    await removeScratch(stateDir)
  }
})
