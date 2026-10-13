/**
 * Coexistence tests: the host half rewrites the *whole* profile patch file on
 * every write, and that same file carries every other plugin's row — including
 * the four entries the four-in-one suite materializes there as bare `- id:`
 * overrides, which is exactly how the live desktop profile looks.
 *
 * A write must therefore touch only the row it was asked to touch: no foreign
 * row lost, none rewritten, and the relative order of the rest preserved. The
 * seed below mirrors the live profile rather than the minimal `PATCH_SEED` the
 * route tests use, so a regression here fails on the shape that ships.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChangeChannel, handleRequest } from '../src/index.ts'
import { readPatchList } from '../src/patch.ts'

/** The rows that are none of this plugin's business, exactly as shipped. */
const FOREIGN_ROWS = [
  ['mcp-manager', { id: 'mcp-manager', name: '@hualiong/dsh-mcp-manager', config: { patchFile: 'patch' } }],
  ['xmanrui-dsh-im', { id: 'xmanrui-dsh-im', disabled: true }],
  ['chameleon-session-delete', { id: 'chameleon-session-delete', disabled: false }],
  ['cost-lite', { id: 'cost-lite', disabled: false }],
  ['locale', { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } }],
  ['permission', {
    id: 'permission',
    name: '@deepseek-ai/dsh-permission-presets',
    config: {
      presets: { 'read-only': { sandbox: 'read-only', approval: 'ask' } },
      defaultPreset: 'danger-full-access',
    },
  }],
]

/** The one MCP row the tests act on. */
const MCP_ROW = [
  'oauth-mcp-cloudflare',
  {
    id: 'oauth-mcp-cloudflare',
    name: '@hualiong/dsh-oauth-mcp-client',
    disabled: true,
    config: {
      serverName: 'Cloudflare',
      url: 'https://mcp.cloudflare.com/mcp',
      credentialRef: 'CLOUDFLARE_MCP_OAUTH',
      callbackPort: 45871,
      failOnStartupError: false,
    },
  },
]

const ENTRIES = [
  {
    id: 'include:oauth-mcp-cloudflare',
    disabled: true,
    options: {
      name: '@hualiong/dsh-oauth-mcp-client',
      config: { serverName: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp' },
    },
    fiber: { state: 2 },
  },
  { id: 'include:mcp-manager', options: { name: '@hualiong/dsh-mcp-manager', config: {} } },
]

/** Mount the route over a patch file carrying the foreign rows. */
function harness({ mcpDisabled = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-coexist-'))
  const patchFile = join(dir, 'cordis.patch.yml')
  writeFileSync(patchFile, [
    '# MCP servers managed by the dsh-mcp-manager plugin.',
    '- id: mcp-manager',
    "  name: '@hualiong/dsh-mcp-manager'",
    '  config:',
    `    patchFile: ${patchFile}`,
    '- id: oauth-mcp-cloudflare',
    "  name: '@hualiong/dsh-oauth-mcp-client'",
    ...(mcpDisabled ? ['  disabled: true'] : []),
    '  config:',
    '    serverName: Cloudflare',
    '    url: https://mcp.cloudflare.com/mcp',
    '    credentialRef: CLOUDFLARE_MCP_OAUTH',
    '    callbackPort: 45871',
    '    failOnStartupError: false',
    '- id: xmanrui-dsh-im',
    '  disabled: true',
    '- id: chameleon-session-delete',
    '  disabled: false',
    '- id: cost-lite',
    '  disabled: false',
    '- id: locale',
    "  name: '@deepseek-ai/dsh-client-locale'",
    '  config:',
    '    preference: zh',
    '- id: permission',
    "  name: '@deepseek-ai/dsh-permission-presets'",
    '  config:',
    '    defaultPreset: danger-full-access',
    '',
  ].join('\n'))

  const warnings = []
  const childLogger = { info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {}, debug() {} }
  const ctx = {
    logger: Object.assign(() => childLogger, childLogger),
    loader: { entries: () => ENTRIES },
    tools: { schemas: () => [{ name: 'mcp__Cloudflare__search' }] },
    connection: { requestRejection: () => undefined },
    webServer: { register: () => () => {} },
    effect(callback) { callback() },
  }
  const channel = createChangeChannel(ctx, patchFile)
  const route = {
    handler: (req, res) => handleRequest(ctx, patchFile, channel, req, res, async () => 'plain'),
  }
  return { route, patchFile, warnings, dispose: () => channel.close() }
}

/** Every row keyed by `id`, or by its wrapper key when it is an `insert:` block. */
function rowsOf(patchFile) {
  const rows = readPatchList(patchFile)
  return new Map(rows.map((row) => [
    typeof row?.id === 'string' ? row.id : `wrapper:${Object.keys(row ?? {}).join(',')}`,
    row,
  ]))
}

function call(route, name, payload) {
  const captured = { status: undefined, body: undefined }
  const listeners = new Map()
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(status) { captured.status = status; return res },
    write() { return true },
    end(text) { res.writableEnded = true; if (text !== undefined) captured.body = text; return res },
    on(event, listener) { listeners.set(event, listener); return res },
  }
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = `/mcp-manager/${name}`
  req.headers = {}
  const done = Promise.resolve(route.handler(req, res))
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify({ payload })))
    req.emit('end')
  })
  return done.then(() => ({ ...captured, json: JSON.parse(captured.body) }))
}

/** Assert that nothing outside `allowed` moved. */
function assertForeign(seed, patchFile, { drops = [], adds = [] } = {}) {
  const after = rowsOf(patchFile)
  const survived = []
  for (const [key, row] of seed) {
    if (drops.includes(key)) continue
    assert.ok(after.has(key), `row "${key}" was lost by a write that did not own it`)
    assert.deepEqual(after.get(key), row, `row "${key}" was rewritten by a write that did not own it`)
    survived.push(key)
  }
  for (const key of after.keys()) {
    assert.ok(seed.has(key) || adds.includes(key), `unexpected extra row "${key}"`)
  }
  const order = [...after.keys()].filter((key) => seed.has(key) && !drops.includes(key))
  assert.deepEqual(order, survived, 'the surviving foreign rows must keep their relative order')
  return after
}

test('remove touches only its own row in a profile patch full of foreign rows', async () => {
  const { route, patchFile, dispose } = harness()
  const seed = rowsOf(patchFile)
  assert.deepEqual([...seed.keys()], [
    'mcp-manager', 'oauth-mcp-cloudflare', 'xmanrui-dsh-im',
    'chameleon-session-delete', 'cost-lite', 'locale', 'permission',
  ])

  const reply = await call(route, 'remove', { id: 'oauth-mcp-cloudflare' })
  assert.equal(reply.status, 200)
  assert.deepEqual(reply.json, { ok: true, value: { removed: 'oauth-mcp-cloudflare' } })

  assertForeign(seed, patchFile, { drops: ['oauth-mcp-cloudflare'] })
  dispose()
})

test('add appends an insert wrapper and leaves every pre-existing row byte-identical', async () => {
  const { route, patchFile, dispose } = harness()
  const seed = rowsOf(patchFile)

  const reply = await call(route, 'add', {
    id: 'probe-row',
    config: { serverName: 'probe', transport: 'streamable-http', url: 'https://example.invalid/mcp' },
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.value.added, 'probe-row')

  const after = assertForeign(seed, patchFile, { adds: ['wrapper:insert'] })
  assert.deepEqual(after.get('wrapper:insert').insert.map((row) => row.id), ['probe-row'])
  assert.equal(readFileSync(patchFile, 'utf8').split('\n')[0],
    '# MCP servers managed by the dsh-mcp-manager plugin.')
  dispose()
})

test('setEnabled edits its own row without moving the rows around it', async () => {
  const { route, patchFile, dispose } = harness({ mcpDisabled: false })
  const seed = rowsOf(patchFile)
  assert.ok(!('disabled' in seed.get('oauth-mcp-cloudflare')), 'the seed starts out enabled')

  const reply = await call(route, 'setEnabled', { id: 'oauth-mcp-cloudflare', enabled: false })
  assert.equal(reply.status, 200)

  const after = assertForeign(seed, patchFile, { drops: ['oauth-mcp-cloudflare'] })
  assert.equal(after.get('oauth-mcp-cloudflare').disabled, true)
  assert.deepEqual(after.get('oauth-mcp-cloudflare').config, seed.get('oauth-mcp-cloudflare').config,
    'disabling a row must not disturb its config block')
  dispose()
})
