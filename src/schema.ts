/** JSON Schema construction, validation, and model-facing rendering helpers. */

import type { JsonSchemaNode, TextBlock, ToolDefinition } from './context.js'

/** One property in an author-facing schema; `required: true` marks its key. */
export interface SchemaProperty extends Omit<JsonSchemaNode, 'required' | 'properties' | 'items' | 'oneOf'> {
  required?: true | string[]
  properties?: Record<string, SchemaProperty>
  items?: SchemaProperty
  oneOf?: SchemaProperty[]
}

/** Compile one author property node, collecting its own required keys. */
function compileNode(node: SchemaProperty): { schema: JsonSchemaNode; required: string[] } {
  const { required, properties, items, oneOf, ...rest } = node
  const explicit = Array.isArray(required) ? required : []
  const schema: JsonSchemaNode = { ...rest }
  if (properties !== undefined) {
    const compiled = compileProperties(properties)
    schema.properties = compiled.properties
    schema.required = [...new Set([...explicit, ...compiled.required])]
  } else if (explicit.length > 0) {
    schema.required = explicit
  }
  if (items !== undefined) schema.items = compileNode(items).schema
  if (oneOf !== undefined) schema.oneOf = oneOf.map(branch => compileNode(branch).schema)
  return { schema, required: required === true ? [] : [] }
}

/** Compile a property map into standard JSON Schema plus its required key list. */
function compileProperties(properties: Record<string, SchemaProperty>): { properties: Record<string, JsonSchemaNode>; required: string[] } {
  const compiled: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const [key, node] of Object.entries(properties)) {
    if (node.required === true) required.push(key)
    compiled[key] = compileNode(node).schema
  }
  return { properties: compiled, required }
}

/** Build a closed object schema for tool arguments or output. */
export function objectSchema(
  properties: Record<string, SchemaProperty>,
  required: string[] = [],
  additionalProperties = false,
): JsonSchemaNode {
  const compiled = compileProperties(properties)
  return {
    type: 'object',
    properties: compiled.properties,
    required: [...new Set([...required, ...compiled.required])],
    additionalProperties,
  }
}

/** A permissive object schema for results whose fields grow with the feature. */
export function openObjectSchema(properties: Record<string, SchemaProperty>, required: string[] = []): JsonSchemaNode {
  return objectSchema(properties, required, true)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(type: NonNullable<JsonSchemaNode['type']>, value: unknown): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
  }
}

/**
 * Validate a value against the supported JSON Schema subset.
 * @param schema - declared schema.
 * @param value - candidate value.
 * @param path - diagnostic prefix.
 * @returns every violation; an empty array means valid.
 */
export function validateSchema(schema: JsonSchemaNode, value: unknown, path = '$'): string[] {
  const violations: string[] = []
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(branch => validateSchema(branch, value, path).length === 0)
    if (matches.length !== 1) {
      violations.push(`${path} must match exactly one oneOf branch (matched ${matches.length})`)
    }
    return violations
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    violations.push(`${path} must be ${schema.type}, got ${typeName(value)}`)
    return violations
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean | null)) {
    violations.push(`${path} must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`)
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(value) && schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => {
      violations.push(...validateSchema(schema.items as JsonSchemaNode, item, `${path}[${index}]`))
    })
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && schema.type === 'object') {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(record, key)) violations.push(`${path}.${key} is required`)
    }
    for (const [key, child] of Object.entries(record)) {
      const declared = schema.properties?.[key]
      if (declared !== undefined) {
        violations.push(...validateSchema(declared, child, `${path}.${key}`))
      } else if (schema.additionalProperties === false) {
        violations.push(`${path}.${key} is not allowed`)
      }
    }
  }
  return violations
}

/**
 * Validate model-provided arguments and fail with an actionable message.
 * @param toolName - name used in the diagnostic.
 * @param parameters - declared parameter schema.
 * @param args - raw model arguments.
 * @returns the raw object after validation.
 */
export function parseArgs(toolName: string, parameters: JsonSchemaNode, args: unknown): Record<string, unknown> {
  const violations = validateSchema(parameters, args)
  if (violations.length > 0) {
    throw new Error(`${toolName} received invalid arguments: ${violations.join('; ')}`)
  }
  return args as Record<string, unknown>
}

/** Serialize a value for a renderer without throwing on cycles. */
export function safeJson(value: unknown, maxChars = 60_000): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? 'null'
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `[unserializable result: ${reason}]`
  }
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} characters]`
}

/** Render a canonical result as one text block. */
export function jsonRender(value: unknown): TextBlock[] {
  return [{ type: 'text', text: safeJson(value) }]
}

/** Render a prepared human-readable summary (with a bounded JSON appendix when useful). */
export function summaryRender(summary: string, value?: unknown): TextBlock[] {
  const text = value === undefined ? summary : `${summary}\n\n${safeJson(value, 20_000)}`
  return [{ type: 'text', text }]
}

/**
 * Build a tool definition with a mandatory `output` projection.
 * @param definition - complete tool contract.
 * @returns the same definition, typed for `ctx.tools.register`.
 */
export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition
}
