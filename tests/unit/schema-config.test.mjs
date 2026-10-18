import test from 'node:test'
import assert from 'node:assert/strict'
import { objectSchema, openObjectSchema, validateSchema, parseArgs } from '../../dist/schema.js'
import { resolveConfig } from '../../dist/config.js'

test('objectSchema compiles per-property required markers and rejects invalid input', () => {
  const schema = objectSchema({
    profile: { type: 'string', required: true },
    count: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', required: true },
          optional: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  })
  assert.deepEqual(schema.required, ['profile'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.items.items.required, ['name'])

  assert.deepEqual(validateSchema(schema, { profile: 'p' }), [])
  assert.match(validateSchema(schema, {}).join('\n'), /profile is required/)
  assert.match(validateSchema(schema, { profile: 1 }).join('\n'), /must be string/)
  assert.match(validateSchema(schema, { profile: 'p', extra: 1 }).join('\n'), /extra is not allowed/)
  assert.match(validateSchema(schema, { profile: 'p', items: [{ optional: true }] }).join('\n'), /items\[0\]\.name is required/)
  assert.throws(() => parseArgs('demo', schema, { profile: 1 }), /demo received invalid arguments/)
})

test('openObjectSchema accepts unknown result fields', () => {
  const schema = openObjectSchema({ ok: { type: 'boolean', required: true } })
  assert.equal(schema.additionalProperties, true)
  assert.deepEqual(validateSchema(schema, { ok: true, extra: 'allowed' }), [])
})

test('config defaults, validation, and absolute-path enforcement', () => {
  const config = resolveConfig({ stateDir: '/tmp/lovable-test' })
  assert.equal(config.maxProfiles, 4)
  assert.equal(config.headedHandoff, true)
  assert.equal(config.chromeSandbox, 'auto')
  assert.equal(config.allowOutsideWorkspaceWrites, false)
  assert.equal(config.notifications, true)

  assert.throws(() => resolveConfig({ stateDir: 'relative/path' }), /absolute path/)
  assert.throws(() => resolveConfig({ unknownThing: true }), /unknown key/)
  assert.throws(() => resolveConfig({ maxProfiles: 0 }), /integer in/)
  assert.throws(() => resolveConfig({ logLevel: 'verbose' }), /logLevel/)
  assert.throws(() => resolveConfig([]), /must be an object/)
})
