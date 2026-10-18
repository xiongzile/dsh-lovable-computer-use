#!/usr/bin/env node
/**
 * Install dsh-lovable-computer-use into one DSH profile.
 *
 * This edits only the profile's package.json and cordis.patch.yml, after
 * backing both up. It never edits the desktop application bundle.
 *
 * The Desktop application owns its profile's package operations and lock. Prefer
 * the Plugins page / plugin_manager bundle install; run this script only with
 * the application closed.
 *
 * Usage:
 *   node scripts/install-profile.mjs [--profile desktop] [--profile-dir PATH] [--no-install]
 *
 * Defaults to the desktop profile under $DSH_HOME/profiles. DSH must be
 * restarted after a successful install because the composition changed.
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

if (!existsSync(resolve(packageRoot, 'dist', 'index.js'))) {
  console.error(`built plugin missing: ${resolve(packageRoot, 'dist', 'index.js')}`)
  console.error('Run `npm install && npm run build` in the plugin checkout first.')
  process.exit(1)
}

function parseArgs(argv) {
  const options = { profile: 'desktop', profileDir: undefined, install: true }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile' && argv[index + 1] !== undefined) {
      options.profile = argv[++index]
    } else if (argument === '--profile-dir' && argv[index + 1] !== undefined) {
      options.profileDir = resolve(argv[++index])
    } else if (argument === '--no-install') {
      options.install = false
    } else if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/install-profile.mjs [--profile desktop] [--profile-dir PATH] [--no-install]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument ${argument}`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = options.profileDir ?? join(dshHome, 'profiles', options.profile)
const manifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(profileDir, '.backups', `${stamp}-lovable-install`)

const manifestText = await readFile(manifestPath, 'utf8')
const manifest = JSON.parse(manifestText)
manifest.dependencies = manifest.dependencies ?? {}
if (!manifest.dependencies['dsh-lovable-computer-use']) {
  manifest.dependencies['dsh-lovable-computer-use'] = `file:${packageRoot}`
} else {
  console.log(`dependency already present: ${manifest.dependencies['dsh-lovable-computer-use']}`)
}

await mkdir(backupDir, { recursive: true })
await cp(manifestPath, join(backupDir, 'package.json'))
const patchText = await readFile(patchPath, 'utf8').catch(() => '[]\n')
await writeFile(join(backupDir, 'cordis.patch.yml'), patchText)

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

let nextPatch = patchText
if (nextPatch.includes('id: lovable-computer-use')) {
  console.log('patch row already present')
} else if (nextPatch.replace(/^\s*#.*$/gm, '').trim() === '[]') {
  nextPatch = nextPatch.replace(/\[\]\s*$/, `# Installed by dsh-lovable-computer-use. Set stateDir to override the default.
- insert:
    - id: lovable-computer-use
      name: 'dsh-lovable-computer-use'
      config:
        idleCloseMs: 1800000
        notifications: true
        headedHandoff: true
        logLevel: info
`)
} else {
  nextPatch = `${nextPatch.replace(/\s*$/, '')}\n\n# Installed by dsh-lovable-computer-use.\n- insert:\n    - id: lovable-computer-use\n      name: 'dsh-lovable-computer-use'\n      config:\n        idleCloseMs: 1800000\n        notifications: true\n        headedHandoff: true\n        logLevel: info\n`
}
await writeFile(patchPath, nextPatch)

console.log(`profile: ${profileDir}`)
console.log(`backup:  ${backupDir}`)
console.log(`dependency: dsh-lovable-computer-use -> file:${packageRoot}`)

if (options.install) {
  const pnpm = process.env.PNPM ?? 'pnpm'
  console.log(`running: ${pnpm} install (profile package manager must be available)`)
  const result = spawnSync(pnpm, ['install'], { cwd: profileDir, stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    console.error(`pnpm install failed with ${result.status}; restore ${backupDir} before retrying or ask DSH's plugin manager to install the bundle`)
    process.exit(result.status ?? 1)
  }
}

console.log('')
console.log('Next: restart the DSH profile (desktop: quit and reopen DeepSeek Harness).')
console.log('Then in a new session, the tools appear as background_browser_*, ide_*, focus_guard, foreground_app, and notify_user.')
console.log(`Rollback: cp ${join(backupDir, 'package.json')} ${manifestPath}`)
console.log(`          cp ${join(backupDir, 'cordis.patch.yml')} ${patchPath}`)
console.log(`          cd ${profileDir} && pnpm install`)
