/** Read VS Code JSON-with-comments settings without executing them. */

import { readTextIfExists } from '../util/fs.js'

/** Result of parsing a JSONC settings file. */
export interface JsoncResult {
  value?: Record<string, unknown>
  error?: string
  text?: string
}

/**
 * Strip comments and trailing commas from JSONC, preserving string contents.
 * @param text - raw settings text.
 * @returns JSON-compatible text.
 */
export function stripJsonc(text: string): string {
  let output = ''
  let inString = false
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    const next = text[index + 1]
    if (lineComment) {
      if (char === '\n') {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      output += char
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    output += char
  }
  return output.replace(/,\s*([}\]])/g, '$1')
}

/**
 * Read and parse a JSONC settings file.
 * @param path - absolute file path.
 * @returns parsed object or a diagnostic.
 */
export async function readJsoncFile(path: string): Promise<JsoncResult> {
  const text = await readTextIfExists(path)
  if (text === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(stripJsonc(text))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'settings root must be an object', text }
    }
    return { value: parsed as Record<string, unknown>, text }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), text }
  }
}
