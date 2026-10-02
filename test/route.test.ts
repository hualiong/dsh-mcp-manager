/**
 * Route-contract tests for the host half: `POST /mcp-manager/<endpoint>` on the
 * harness HTTP carrier, behind Connection's request fence.
 *
 * Every case drives `apply()` through a fake sibling-fiber context (webserver,
 * connection, loader, tools) and a fake node:http request/response pair, so the
 * exact bytes the browser half will see are asserted here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.ts'
import { readPatchList } from '../src/patch.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-test-server.mjs')

const PATCH_SEED = `- insert:
    - id: oauth-mcp-cloudflare
      name: '@dsh-external/dsh-oauth-mcp-client'
      config:
        serverName: cloudflare
        url: https://mcp.cloudflare.com/mcp
        credentialRef: CLOUDFLARE_MCP_OAUTH
        callbackPort: 45871

- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  disabled: true
  config:
    serverName: github
    transport: streamable-http
    url: https://api.githubcopilot.com/mcp
`

/** Loader entries: the user's OAuth row, a native row, a bundle-only OAuth row, and a stdio fixture. */
const ENTRIES = [
  {
    id: 'include:oauth-mcp-cloudflare',
    disabled: false,
    options: {
      name: '@dsh-external/dsh-oauth-mcp-client',
      config: {
        serverName: 'cloudflare',
        url: 'https://mcp.cloudflare.com/mcp',
        credentialRef: 'CLOUDFLARE_MCP_OAUTH',
        callbackPort: 45871,
      },
    },
    fiber: { state: 2 },
  },
  {
    id: 'include:mcp-github',
    disabled: true,
    options: {
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'github',
        transport: 'streamable-http',
        url: 'https://api.githubcopilot.com/mcp',
        toolCallTimeoutMs: 12_345,
        failOnStartupError: false,
        reconnect: { enabled: true, maxAttempts: 20 },
      },
    },
    fiber: { state: 2 },
  },
  {
    id: 'oauth-mcp-bundle',
    disabled: false,
    options: {
      name: '@dsh-external/dsh-oauth-mcp-client',
      config: { serverName: 'bundle', url: 'https://mcp.example.com/mcp' },
    },
    fiber: { state: 3 },
  },
  {
    id: 'mcp-fixture',
    disabled: false,
    options: {
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE] },
    },
    fiber: { state: 2 },
  },
  { id: 'some-group', options: { name: 'ignored', group: true } },
  { id: 'unrelated', options: { name: '@deepseek-ai/dsh-client-ui-settings' } },
]

const TOOL_SCHEMAS = [
  { name: 'mcp__cloudflare__search' },
  { name: 'mcp__github__search_code' },
  { name: 'other' },
]

/** Mount the host half over fake sibling services and return the mounted route. */
function harness({ reject = () => undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-route-'))
  const patchFile = join(dir, 'cordis.patch.yml')
  writeFileSync(patchFile, PATCH_SEED)

  const routes = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    loader: { entries: () => ENTRIES },
    tools: { schemas: () => TOOL_SCHEMAS },
    connection: { requestRejection: (req) => reject(req) },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(callback) {
      callback()
    },
  }
  apply(ctx, { patchFile })
  assert.equal(routes.length, 1, 'apply() must mount exactly one route')
  return { route: routes[0], patchFile }
}

/** Fake node:http response capturing status, headers and body. */
function fakeRes() {
  const captured = {}
  const res = {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
      return res
    },
    end(text) {
      captured.body = text
      return res
    },
    captured,
  }
  return res
}

/** Drive the route with a fake request, emitting the body after the handler attaches. */
function call(route, { url = '/mcp-manager/list', method = 'POST', body = { payload: null }, headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  const res = fakeRes()
  const done = Promise.resolve(route.handler(req, res))
  setImmediate(() => {
    req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  })
  return done.then(() => {
    let json
    try {
      json = JSON.parse(res.captured.body)
    } catch {
      json = undefined
    }
    return { ...res.captured, json }
  })
}

/** Call one endpoint and return the parsed reply. */
function endpoint(route, name, payload) {
  return call(route, { url: `/mcp-manager/${name}`, body: { payload } })
}

/** The server array of a `list` reply. */
function listOf(reply) {
  return reply.json.value.servers
}

test('mounts a prefix route on the shared channel path', () => {
  const { route } = harness()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/mcp-manager')
  assert.equal(typeof route.handler, 'function')
})

test('rejects a fenced request before it reaches the endpoint', async () => {
  const unauthorized = await endpoint(harness({ reject: () => 401 }).route, 'list', null)
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.body, 'unauthorized')
  assert.equal(unauthorized.json, undefined, 'a rejection must not carry a JSON envelope')

  const forbidden = await endpoint(harness({ reject: () => 403 }).route, 'list', null)
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.body, 'forbidden')
})

test('answers 404 for a non-POST method or a path outside the channel', async () => {
  const { route } = harness()
  const cases = [
    { url: '/mcp-manager/list', method: 'GET' },
    { url: '/mcp-manager/list', method: 'HEAD' },
    { url: '/mcp-manager/list', method: 'PUT' },
    { url: '/mcp-manager/', method: 'POST' },
    { url: '/mcp-manager', method: 'POST' },
    { url: '/mcp-manager/list/extra', method: 'POST' },
    { url: '/mcp-manager/li%20st', method: 'POST' },
    { url: '/other/list', method: 'POST' },
  ]
  for (const options of cases) {
    const reply = await call(route, options)
    assert.equal(reply.status, 404, `${options.method} ${options.url}`)
    assert.equal(reply.json, undefined)
  }
})

test('answers 400 for a malformed body or envelope', async () => {
  const { route } = harness()
  for (const body of ['{not json', '', 'null', '[]', '{"nope":1}', '{']) {
    const reply = await call(route, { body })
    assert.equal(reply.status, 400, JSON.stringify(body))
  }
})

test('reads the body from a real readable stream', async () => {
  const { route } = harness()
  const req = Readable.from([Buffer.from(JSON.stringify({ payload: null }))])
  req.method = 'POST'
  req.url = '/mcp-manager/patchInfo'
  req.headers = {}
  const res = fakeRes()
  await route.handler(req, res)
  assert.equal(res.captured.status, 200)
  assert.equal(JSON.parse(res.captured.body).ok, true)
})

test('list reports both bridge packages with their status projection', async () => {
  const { route } = harness()
  const reply = await endpoint(route, 'list', null)
  assert.equal(reply.status, 200)
  assert.equal(reply.headers['content-type'], 'application/json')
  assert.equal(reply.json.ok, true)

  const servers = reply.json.value.servers
  const names = servers.map((server) => server.serverName)
  assert.deepEqual(names.sort(), ['bundle', 'cloudflare', 'fixture', 'github'])

  const cloudflare = servers.find((server) => server.serverName === 'cloudflare')
  assert.equal(cloudflare.id, 'oauth-mcp-cloudflare')
  assert.equal(cloudflare.ownerPackage, '@dsh-external/dsh-oauth-mcp-client')
  assert.equal(cloudflare.transport, 'streamable-http')
  assert.equal(cloudflare.url, 'https://mcp.cloudflare.com/mcp')
  assert.equal(cloudflare.credentialRef, 'CLOUDFLARE_MCP_OAUTH')
  assert.equal(cloudflare.callbackPort, 45871)
  assert.equal(cloudflare.userManaged, true)
  assert.equal(cloudflare.enabled, true)
  assert.equal(cloudflare.fiberPhase, 'active')
  assert.equal(cloudflare.toolCount, 1)

  const github = servers.find((server) => server.serverName === 'github')
  assert.equal(github.ownerPackage, '@deepseek-ai/dsh-mcp-client')
  assert.equal(github.userManaged, true)
  assert.equal(github.enabled, false)
  assert.equal(github.toolCount, 1)
  assert.equal(github.toolCallTimeoutMs, 12_345)
  assert.deepEqual(github.reconnect, { enabled: true, maxAttempts: 20 })

  const bundleOnly = servers.find((server) => server.serverName === 'bundle')
  assert.equal(bundleOnly.ownerPackage, '@dsh-external/dsh-oauth-mcp-client')
  assert.equal(bundleOnly.userManaged, false)
  assert.equal(bundleOnly.fiberPhase, 'failed')
})

test('patchInfo reports the edited file', async () => {
  const { route, patchFile } = harness()
  const reply = await endpoint(route, 'patchInfo', null)
  assert.deepEqual(reply.json.value.patch, { path: patchFile, exists: true })
})

test('add writes an official-client insert row and rejects duplicates', async () => {
  const { route, patchFile } = harness()
  const config = {
    serverName: 'newserver',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
  }
  const added = await endpoint(route, 'add', { id: 'mcp-new', config })
  assert.deepEqual(added.json, { ok: true, value: { added: 'mcp-new' } })

  const rows = readPatchList(patchFile)
  const inserted = rows.at(-1).insert[0]
  assert.equal(inserted.name, '@deepseek-ai/dsh-mcp-client')
  assert.deepEqual(inserted.config, config)

  // The loader is the source of truth for a taken id (a disabled row is still
  // a live entry, so it is covered).
  const duplicateId = await endpoint(route, 'add', { id: 'oauth-mcp-cloudflare', config })
  assert.equal(duplicateId.json.error.code, 'duplicate-id')

  const duplicateName = await endpoint(route, 'add', {
    id: 'mcp-other',
    config: { serverName: 'cloudflare', transport: 'streamable-http', url: 'https://example.com/mcp' },
  })
  assert.equal(duplicateName.json.error.code, 'duplicate-server-name')

  const invalid = await endpoint(route, 'add', {
    id: 'bad id',
    config: { serverName: 'x', transport: 'streamable-http', url: 'ftp://nope' },
  })
  assert.equal(invalid.json.error.code, 'invalid-config')
  assert.equal(typeof invalid.json.error.details.fields.id, 'string')
  assert.equal(typeof invalid.json.error.details.fields.url, 'string')

  for (const payload of [null, {}, { id: 'x' }, { config }, { id: 7, config }]) {
    const reply = await endpoint(route, 'add', payload)
    assert.equal(reply.status, 200, JSON.stringify(payload))
    assert.equal(reply.json.error.code, 'bad-request', JSON.stringify(payload))
  }
})

test('remove deletes the row from the user patch', async () => {
  const { route, patchFile } = harness()
  const reply = await endpoint(route, 'remove', { id: 'oauth-mcp-cloudflare' })
  assert.deepEqual(reply.json, { ok: true, value: { removed: 'oauth-mcp-cloudflare' } })
  assert.deepEqual(readPatchList(patchFile).flatMap((row) => row.insert ?? []), [])

  const malformed = await endpoint(route, 'remove', {})
  assert.equal(malformed.json.error.code, 'bad-request')
})

test('setEnabled flips the flag in place and keeps the owner package on overrides', async () => {
  const { route, patchFile } = harness()
  const disabled = await endpoint(route, 'setEnabled', { id: 'oauth-mcp-cloudflare', enabled: false })
  assert.deepEqual(disabled.json, { ok: true, value: { id: 'oauth-mcp-cloudflare', enabled: false } })
  const insert = readPatchList(patchFile).flatMap((row) => row.insert ?? [])
  assert.equal(insert[0].disabled, true)
  assert.equal(insert[0].name, '@dsh-external/dsh-oauth-mcp-client')

  // A bundle-defined row is not in the patch: the override must repeat its package.
  const bundle = await endpoint(route, 'setEnabled', { id: 'oauth-mcp-bundle', enabled: false })
  assert.equal(bundle.json.ok, true)
  const override = readPatchList(patchFile).find((row) => row.id === 'oauth-mcp-bundle')
  assert.equal(override.name, '@dsh-external/dsh-oauth-mcp-client')
  assert.equal(override.disabled, true)

  const malformed = await endpoint(route, 'setEnabled', { id: 'oauth-mcp-bundle', enabled: 'yes' })
  assert.equal(malformed.json.error.code, 'bad-request')
})

test('update keeps the OAuth row intact and never writes a transport key into it', async () => {
  const { route, patchFile } = harness()
  const reply = await endpoint(route, 'update', {
    id: 'oauth-mcp-cloudflare',
    config: {
      serverName: 'cloudflare',
      transport: 'streamable-http',
      url: 'https://mcp.cloudflare.com/mcp/v2',
      callbackPort: 45872,
    },
  })
  assert.deepEqual(reply.json, { ok: true, value: { updated: 'oauth-mcp-cloudflare' } })

  const config = readPatchList(patchFile).flatMap((row) => row.insert ?? [])[0].config
  assert.equal(config.url, 'https://mcp.cloudflare.com/mcp/v2')
  assert.equal(config.credentialRef, 'CLOUDFLARE_MCP_OAUTH', 'an edit must not strip the credential reference')
  assert.equal(config.callbackPort, 45872)
  assert.equal(config.transport, undefined)
  assert.equal(config.command, undefined)

  const rejected = await endpoint(route, 'update', {
    id: 'oauth-mcp-cloudflare',
    config: { serverName: 'cloudflare', transport: 'streamable-http', url: 'http://public.example.com/mcp' },
  })
  assert.equal(rejected.json.error.code, 'invalid-config')
  assert.equal(typeof rejected.json.error.details.fields.url, 'string')

  const malformed = await endpoint(route, 'update', { id: 'oauth-mcp-cloudflare' })
  assert.equal(malformed.json.error.code, 'bad-request')
})

test('probe skips an OAuth-owned row instead of reporting a false failure', async () => {
  const { route } = harness()
  const reply = await endpoint(route, 'probe', { id: 'oauth-mcp-cloudflare' })
  assert.equal(reply.status, 200)
  const result = reply.json.value
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.equal(result.latencyMs, 0)
  assert.match(result.error, /OAuth/i)

  const missing = await endpoint(route, 'probe', { id: 'nope' })
  assert.equal(missing.json.error.code, 'not-found')

  const malformed = await endpoint(route, 'probe', {})
  assert.equal(malformed.json.error.code, 'bad-request')
})

test('probe still connects to a stdio server for real', async () => {
  const { route } = harness()
  const reply = await endpoint(route, 'probe', { id: 'mcp-fixture' })
  const result = reply.json.value
  assert.equal(result.ok, true, result.error)
  assert.equal(result.toolCount, 1)
  assert.ok(result.latencyMs >= 0)
})

test('list reflects a just-saved edit without waiting for the loader', async () => {
  const { route } = harness()
  const before = await endpoint(route, 'list', null)
  const original = before.json.value.servers.find((server) => server.id === 'oauth-mcp-cloudflare')
  assert.equal(original.serverName, 'cloudflare')
  assert.equal(original.url, 'https://mcp.cloudflare.com/mcp')

  await endpoint(route, 'update', {
    id: 'oauth-mcp-cloudflare',
    config: {
      serverName: 'cloudflare-renamed',
      transport: 'streamable-http',
      url: 'https://mcp.cloudflare.com/mcp/v2',
    },
  })

  // The fake loader still reports the pre-edit config; the file already holds
  // the new one, and the panel must see what the user just saved.
  const row = listOf(await endpoint(route, 'list', null)).find((server) => server.id === 'oauth-mcp-cloudflare')
  assert.equal(row.serverName, 'cloudflare-renamed')
  assert.equal(row.url, 'https://mcp.cloudflare.com/mcp/v2')
  assert.equal(row.credentialRef, 'CLOUDFLARE_MCP_OAUTH', 'the file row keeps the credential reference')
  assert.equal(row.callbackPort, 45_871)
  assert.equal(row.fiberPhase, 'active', 'status still describes the running bridge')
  assert.equal(row.toolCount, 1, 'tools are counted under the name the bridge still runs')
  assert.equal(row.enabled, true)
  assert.equal(row.userManaged, true)
})

test('list shows a freshly added server before the loader composes it', async () => {
  const { route } = harness()
  await endpoint(route, 'add', {
    id: 'mcp-fresh',
    config: { serverName: 'fresh', transport: 'streamable-http', url: 'https://fresh.example/mcp' },
  })

  const row = listOf(await endpoint(route, 'list', null)).find((server) => server.id === 'mcp-fresh')
  assert.equal(row.serverName, 'fresh')
  assert.equal(row.ownerPackage, '@deepseek-ai/dsh-mcp-client')
  assert.equal(row.fiberPhase, null)
  assert.equal(row.toolCount, 0)
  assert.equal(row.userManaged, true)
})

test('an unreachable endpoint is a handled failure, not a transport error', async () => {
  const { route } = harness()
  const reply = await call(route, { url: '/mcp-manager/nope' })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.ok, false)
  assert.equal(reply.json.error.code, 'unknown-endpoint')
})
