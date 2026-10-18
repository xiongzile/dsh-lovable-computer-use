/** Read the frontmost application and pointer position without Accessibility or Screen Recording. */

import { runCommand } from '../util/exec.js'

/** One foreground observation. */
export interface ForegroundSample {
  readonly timestamp: string
  readonly supported: boolean
  readonly bundleId: string
  readonly name: string
  readonly pid: number
  readonly pointer?: { readonly x: number; readonly y: number }
  readonly chromeProcesses: string[]
  readonly error?: string
}

/**
 * JXA reads `NSWorkspace.frontmostApplication` and `CGEventGetLocation`.
 * Both are available to ordinary applications; unlike accessibility scripting
 * they do not require Accessibility permission and they never synthesize input.
 */
const SAMPLE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
const workspace = $.NSWorkspace.sharedWorkspace;
const app = workspace.frontmostApplication;
const event = $.CGEventCreate(null);
const location = $.CGEventGetLocation(event);
const running = workspace.runningApplications;
const chrome = [];
for (let index = 0; index < running.count; index += 1) {
  const bundle = ObjC.unwrap(running.objectAtIndex(index).bundleIdentifier) || '';
  if (/chrome|chromium|edgemac/i.test(bundle)) chrome.push(bundle);
}
JSON.stringify({
  bundleId: app ? (ObjC.unwrap(app.bundleIdentifier) || '') : '',
  name: app ? (ObjC.unwrap(app.localizedName) || '') : '',
  pid: app ? app.processIdentifier : -1,
  pointer: { x: location.x, y: location.y },
  chrome
});
`

const OSASCRIPT = '/usr/bin/osascript'

/**
 * Read one foreground sample.
 * @param timeoutMs - bound for the JXA process.
 * @returns a sample; `supported: false` explains why the host cannot observe.
 */
export async function sampleForeground(timeoutMs = 5_000): Promise<ForegroundSample> {
  const timestamp = new Date().toISOString()
  if (process.platform !== 'darwin') {
    return {
      timestamp,
      supported: false,
      bundleId: '',
      name: '',
      pid: -1,
      chromeProcesses: [],
      error: 'foreground observation requires macOS',
    }
  }
  const result = await runCommand(OSASCRIPT, ['-l', 'JavaScript', '-e', SAMPLE_SCRIPT], {
    timeoutMs,
    maxBuffer: 64 * 1024,
  })
  if (result.exitCode !== 0) {
    return {
      timestamp,
      supported: false,
      bundleId: '',
      name: '',
      pid: -1,
      chromeProcesses: [],
      error: (result.stderr || result.error || 'osascript failed').trim().slice(0, 500),
    }
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      bundleId?: unknown
      name?: unknown
      pid?: unknown
      pointer?: { x?: unknown; y?: unknown }
      chrome?: unknown
    }
    const x = parsed.pointer?.x
    const y = parsed.pointer?.y
    return {
      timestamp,
      supported: true,
      bundleId: typeof parsed.bundleId === 'string' ? parsed.bundleId : '',
      name: typeof parsed.name === 'string' ? parsed.name : '',
      pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
      ...typeof x === 'number' && typeof y === 'number' ? { pointer: { x, y } } : {},
      chromeProcesses: Array.isArray(parsed.chrome)
        ? parsed.chrome.filter((value): value is string => typeof value === 'string')
        : [],
    }
  } catch (error) {
    return {
      timestamp,
      supported: false,
      bundleId: '',
      name: '',
      pid: -1,
      chromeProcesses: [],
      error: `could not parse foreground sample: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
