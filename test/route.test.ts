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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, createChangeChannel, handleRequest } from '../src/index.ts'
import { readPatchList } from '../src/patch.ts'
import { MCP_CLIENT_PACKAGE, MCP_OAUTH_CLIENT_PACKAGE } from '../src/shared.ts'
import { validateMcpConfig } from '../src/validate.ts'

const PATCH_SEED = `- insert:
    - id: oauth-mcp-cloudflare
      name: '@hualiong/dsh-oauth-mcp-client'
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

/** Loader entries: the user's OAuth row, a native row, a bundle-only OAuth row, and a stdio row. */
const ENTRIES = [
  {
    id: 'include:oauth-mcp-cloudflare',
    disabled: false,
    options: {
      name: '@hualiong/dsh-oauth-mcp-client',
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
      name: '@hualiong/dsh-oauth-mcp-client',
      config: { serverName: 'bundle', url: 'https://mcp.example.com/mcp' },
    },
    fiber: { state: 3 },
  },
  {
    id: 'mcp-stdio-local',
    disabled: false,
    options: {
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'localfs', transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp'] },
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

/**
 * Mount the host half over fake sibling services and return the mounted route.
 *
 * `apply()` always probes over the real network, so the request path is driven
 * through `handleRequest` with a stub probe instead; `apply()` still runs here
 * so its own mounting is exercised, and the fiber disposers stay real.
 */
function harness({
  reject = () => undefined,
  entries = ENTRIES,
  tools = TOOL_SCHEMAS,
  probe = async () => 'plain',
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-manager-route-'))
  const patchFile = join(dir, 'cordis.patch.yml')
  writeFileSync(patchFile, PATCH_SEED)

  const routes = []
  const disposers = []
  const warnings = []
  // Cordis' logger is both callable (`ctx.logger('scope')`) and a logger.
  const childLogger = {
    info() {},
    warn: (...args) => warnings.push(args.join(' ')),
    error() {},
    debug() {},
  }
  const ctx = {
    logger: Object.assign(() => childLogger, childLogger),
    loader: { entries: () => entries },
    tools: { schemas: () => tools },
    connection: { requestRejection: (req) => reject(req) },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(callback) {
      disposers.push(callback())
    },
  }
  apply(ctx, { patchFile })
  assert.equal(routes.length, 1, 'apply() must mount exactly one route')

  const channel = createChangeChannel(ctx, patchFile)
  const route = {
    ...routes[0],
    handler: (req, res) => handleRequest(ctx, patchFile, channel, req, res, probe),
  }
  // Dispose the plugin fiber exactly as the loader would on unload.
  const dispose = () => {
    channel.close()
    for (const disposer of disposers) disposer()
  }
  return { route, patchFile, dispose, warnings }
}

/** Fake the OAuth bridge being installed in a profile directory. */
function installOAuthBridge(patchFile) {
  const packageDir = join(dirname(patchFile), 'node_modules', ...MCP_OAUTH_CLIENT_PACKAGE.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: MCP_OAUTH_CLIENT_PACKAGE, version: '0.0.0', main: 'index.js' }),
  )
  writeFileSync(join(packageDir, 'index.js'), '')
}

/**
 * Fake node:http response: captures status, headers, body and every written
 * frame, and can be closed like a real one (`end` or a client 'close').
 */
function fakeRes() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  const frames = []
  const listeners = new Map()
  const res = {
    destroyed: false,
    writableEnded: false,
    failWrites: false,
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
      return res
    },
    write(chunk) {
      if (res.failWrites) throw new Error('EPIPE')
      if (res.writableEnded) throw new Error('write after end')
      frames.push(String(chunk))
      return true
    },
    end(text) {
      res.writableEnded = true
      if (text !== undefined) captured.body = text
      return res
    },
    on(event, listener) {
      listeners.set(event, listener)
      return res
    },
    /** Simulate a client disconnect: node emits 'close' on the response. */
    clientClose() {
      res.destroyed = true
      listeners.get('close')?.()
      return res
    },
    /** Every frame written so far, as one string. */
    written() {
      return frames.join('')
    },
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
    return { ...res.captured, json, res }
  })
}

/** Call one endpoint and return the parsed reply. */
function endpoint(route, name, payload) {
  return call(route, { url: `/mcp-manager/${name}`, body: { payload } })
}

/** Subscribe to the change channel and return the held-open response. */
function subscribe(route) {
  return call(route, { url: '/mcp-manager/events', method: 'GET' })
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

test('GET /mcp-manager/events opens a text/event-stream and sends `ready`', async () => {
  const { route } = harness()
  const stream = await subscribe(route)

  assert.equal(stream.status, 200)
  assert.equal(stream.headers['content-type'], 'text/event-stream')
  assert.equal(stream.headers['cache-control'], 'no-store')
  assert.equal(stream.headers['connection'], 'keep-alive')
  assert.equal(stream.res.writableEnded, false, 'the response is held open')
  assert.equal(stream.res.written(), 'data: {"type":"ready"}\n\n')

  // A second subscriber gets its own ready frame and no extra timer (see the
  // timer test) — both stay open.
  const second = await subscribe(route)
  assert.equal(second.res.written(), 'data: {"type":"ready"}\n\n')
  assert.equal(second.res.writableEnded, false)
  stream.res.clientClose()
  second.res.clientClose()
})

test('every write pushes a `changed` frame to open streams', async () => {
  const { route } = harness()
  const stream = await subscribe(route)
  const before = stream.res.written().length

  const added = await endpoint(route, 'add', {
    id: 'mcp-pushed',
    config: { serverName: 'pushed', transport: 'streamable-http', url: 'https://pushed.example/mcp' },
  })
  assert.equal(added.json.ok, true)
  assert.equal(stream.res.written().slice(before), 'data: {"type":"changed"}\n\n')

  await endpoint(route, 'setEnabled', { id: 'mcp-pushed', enabled: false })
  await endpoint(route, 'update', {
    id: 'mcp-pushed',
    config: { serverName: 'pushed', transport: 'streamable-http', url: 'https://pushed.example/mcp/v2' },
  })
  await endpoint(route, 'remove', { id: 'mcp-pushed' })
  assert.equal(stream.res.written().match(/"type":"changed"/g).length, 4, 'one nudge per write')

  // Reads never nudge.
  const reads = stream.res.written().length
  await endpoint(route, 'list', null)
  await endpoint(route, 'patchInfo', null)
  assert.equal(stream.res.written().length, reads)

  stream.res.clientClose()
})

test('a closed stream stops receiving frames', async () => {
  const { route } = harness()
  const stream = await subscribe(route)
  const kept = await subscribe(route)

  stream.res.clientClose()
  await endpoint(route, 'setEnabled', { id: 'mcp-github', enabled: false })

  assert.equal(stream.res.written(), 'data: {"type":"ready"}\n\n', 'the closed stream is dropped')
  assert.match(kept.res.written(), /"type":"changed"/, 'the open stream still hears it')
  kept.res.clientClose()
})

test('the change timer is created with the first stream and cleared with the last', async (t) => {
  const setSpy = t.mock.method(globalThis, 'setInterval')
  const clearSpy = t.mock.method(globalThis, 'clearInterval')
  const { route } = harness()

  assert.equal(setSpy.mock.callCount(), 0, 'no subscribers means no timer at all')

  const first = await subscribe(route)
  assert.equal(setSpy.mock.callCount(), 1, 'the first stream starts the timer')
  const handle = setSpy.mock.calls[0].result

  const second = await subscribe(route)
  assert.equal(setSpy.mock.callCount(), 1, 'one timer serves every stream')

  first.res.clientClose()
  assert.equal(clearSpy.mock.callCount(), 0, 'a remaining stream keeps it alive')
  second.res.clientClose()
  assert.equal(clearSpy.mock.callCount(), 1, 'the last stream clears it')
  assert.equal(clearSpy.mock.calls[0].arguments[0], handle, 'the cleared timer is the created one')

  const again = await subscribe(route)
  assert.equal(setSpy.mock.callCount(), 2, 'a later subscriber starts a fresh timer')
  again.res.clientClose()
  assert.equal(clearSpy.mock.callCount(), 2)
})

test('the tick nudges on a reported-state change and pings an idle stream', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const entries = structuredClone(ENTRIES)
  const { route, patchFile } = harness({ entries, tools: [{ name: 'mcp__github__search_code' }] })

  const stream = await subscribe(route)
  assert.equal(stream.res.written(), 'data: {"type":"ready"}\n\n')

  // No change: nothing but the 20s keep-alive comment.
  t.mock.timers.tick(19_000)
  assert.equal(stream.res.written(), 'data: {"type":"ready"}\n\n')
  t.mock.timers.tick(1_000)
  assert.equal(stream.res.written(), 'data: {"type":"ready"}\n\n: ping\n\n')

  // The live fiber settles: the signature changes and the panel is nudged.
  entries[1].fiber = { state: 3 }
  t.mock.timers.tick(1_000)
  assert.equal(stream.res.written(), 'data: {"type":"ready"}\n\n: ping\n\n' + 'data: {"type":"changed"}\n\n')

  // An out-of-band edit to the patch file is caught by the same comparison.
  writeFileSync(patchFile, `${PATCH_SEED}- insert:\n    - id: mcp-out-of-band\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: outofband\n        transport: streamable-http\n        url: https://oob.example/mcp\n`)
  t.mock.timers.tick(1_000)
  assert.equal(stream.res.written().match(/"type":"changed"/g).length, 2)

  // The last stream is gone: the timer must not be doing work any more.
  stream.res.clientClose()
  const settled = stream.res.written()
  entries[1].fiber = { state: 2 }
  t.mock.timers.tick(60_000)
  assert.equal(stream.res.written(), settled)
})

test('fiber dispose ends every open stream and stops the timer', async (t) => {
  const setSpy = t.mock.method(globalThis, 'setInterval')
  const clearSpy = t.mock.method(globalThis, 'clearInterval')
  const { route, dispose } = harness()
  const first = await subscribe(route)
  const second = await subscribe(route)

  dispose()

  assert.equal(first.res.writableEnded, true, 'a held-open response must be released on unload')
  assert.equal(second.res.writableEnded, true)
  assert.equal(clearSpy.mock.callCount(), 1, 'the timer is cleared')
  assert.equal(setSpy.mock.callCount(), 1, 'and not restarted')

  // A write after dispose must still succeed: the channel is simply empty.
  const late = await endpoint(route, 'setEnabled', { id: 'mcp-github', enabled: false })
  assert.equal(late.json.ok, true)
})

test('a broadcast never throws into a write path', async () => {
  const { route } = harness()
  const stream = await subscribe(route)
  stream.res.failWrites = true

  const reply = await endpoint(route, 'add', {
    id: 'mcp-dead-socket',
    config: { serverName: 'deadsocket', transport: 'streamable-http', url: 'https://dead.example/mcp' },
  })
  assert.equal(reply.json.ok, true, 'the write path survives a dead subscriber')

  const kept = await subscribe(route)
  stream.res.failWrites = false
  await endpoint(route, 'setEnabled', { id: 'mcp-github', enabled: false })
  assert.equal(stream.res.written().includes('"type":"changed"'), false, 'the dead stream was dropped')
  assert.match(kept.res.written(), /"type":"changed"/)
  kept.res.clientClose()
})

test('the events path sits behind the same fence and only GET opens it', async () => {
  const denied = await call(harness({ reject: () => 401 }).route, { url: '/mcp-manager/events', method: 'GET' })
  assert.equal(denied.status, 401)
  assert.equal(denied.body, 'unauthorized')
  assert.equal(denied.res.written(), '', 'a fenced request opens no stream')

  const { route } = harness()
  for (const options of [
    { url: '/mcp-manager/event', method: 'GET' },
    { url: '/mcp-manager/events/extra', method: 'GET' },
    { url: '/mcp-manager/', method: 'GET' },
    { url: '/other/events', method: 'GET' },
    { url: '/mcp-manager/events', method: 'HEAD' },
    { url: '/mcp-manager/events', method: 'PUT' },
  ]) {
    const reply = await call(route, options)
    assert.equal(reply.status, 404, `${options.method} ${options.url}`)
    assert.equal(reply.res.written(), '', `${options.method} ${options.url} must not open a stream`)
  }

  // POST to the events path stays what it always was: a well-formed segment
  // that no endpoint answers.
  const post = await call(route, { url: '/mcp-manager/events', method: 'POST', body: { payload: null } })
  assert.equal(post.status, 200)
  assert.equal(post.json.error.code, 'unknown-endpoint')
})

test('list reports both bridge packages with their status projection', async () => {
  const { route } = harness()
  const reply = await endpoint(route, 'list', null)
  assert.equal(reply.status, 200)
  assert.equal(reply.headers['content-type'], 'application/json')
  assert.equal(reply.json.ok, true)

  const servers = reply.json.value.servers
  const names = servers.map((server) => server.serverName)
  assert.deepEqual(names.sort(), ['bundle', 'cloudflare', 'github', 'localfs'])

  const cloudflare = servers.find((server) => server.serverName === 'cloudflare')
  assert.equal(cloudflare.id, 'oauth-mcp-cloudflare')
  assert.equal(cloudflare.ownerPackage, '@hualiong/dsh-oauth-mcp-client')
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
  assert.equal(bundleOnly.ownerPackage, '@hualiong/dsh-oauth-mcp-client')
  assert.equal(bundleOnly.userManaged, false)
  assert.equal(bundleOnly.fiberPhase, 'failed')
})

test('patchInfo reports the edited file', async () => {
  const { route, patchFile } = harness()
  const reply = await endpoint(route, 'patchInfo', null)
  assert.deepEqual(reply.json.value.patch, { path: patchFile, exists: true })
})

test('add picks the bridge package by transport, own token and probe', async () => {
  let probes = 0
  const { route, patchFile } = harness({ probe: async () => { probes += 1; return 'plain' } })
  const config = {
    serverName: 'newserver',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
  }
  const added = await endpoint(route, 'add', { id: 'mcp-new', config })
  // The reply carries the id and the probe verdict: the panel re-reads the list
  // (the change channel nudges it), so the created row travels through neither.
  assert.deepEqual(added.json, { ok: true, value: { added: 'mcp-new', probe: 'plain' } })
  assert.equal(probes, 1, 'a plain HTTP row is decided by exactly one probe')

  // A plain endpoint stays on the built-in client, which keeps `transport`.
  const inserted = readPatchList(patchFile).at(-1).insert[0]
  assert.equal(inserted.name, MCP_CLIENT_PACKAGE)
  assert.deepEqual(inserted.config, config)

  // A row carrying its own token is settled before the probe: the OAuth bridge
  // would overwrite that Authorization header with its own token.
  const ownToken = {
    serverName: 'pat',
    transport: 'streamable-http',
    url: 'https://pat.example/mcp',
    headers: { Authorization: 'Bearer ghp_x' },
  }
  const ownTokenAdd = await endpoint(route, 'add', { id: 'mcp-pat', config: ownToken })
  assert.deepEqual(ownTokenAdd.json.value, { added: 'mcp-pat', probe: 'plain' })
  const pat = readPatchList(patchFile).at(-1).insert[0]
  assert.equal(pat.name, MCP_CLIENT_PACKAGE)
  assert.deepEqual(pat.config, ownToken)

  // stdio can only be the built-in client, and needs no probe either.
  const stdioAdd = await endpoint(route, 'add', {
    id: 'mcp-new-stdio',
    config: { serverName: 'newstdio', transport: 'stdio', command: 'npx' },
  })
  assert.deepEqual(stdioAdd.json.value, { added: 'mcp-new-stdio', probe: 'plain' })
  const stdio = readPatchList(patchFile).at(-1).insert[0]
  assert.equal(stdio.name, MCP_CLIENT_PACKAGE)
  assert.equal(stdio.config.transport, 'stdio')
  assert.equal(probes, 1, 'stdio and self-authenticating rows must not be probed')

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

test('the probe sends a 401+Bearer endpoint to the OAuth bridge', async () => {
  const { route, patchFile } = harness({ probe: async () => 'oauth' })
  installOAuthBridge(patchFile)
  const added = await endpoint(route, 'add', {
    id: 'mcp-oauth-new',
    config: {
      serverName: 'oauthnew',
      transport: 'streamable-http',
      url: 'https://oauthnew.example/mcp',
      credentialRef: 'OAUTHNEW_REF',
      callbackPort: 45872,
    },
  })
  assert.deepEqual(added.json, { ok: true, value: { added: 'mcp-oauth-new', probe: 'oauth' } })

  const inserted = readPatchList(patchFile).at(-1).insert[0]
  assert.equal(inserted.name, MCP_OAUTH_CLIENT_PACKAGE)
  // That bridge has no transport field, so the panel's value never reaches the file.
  assert.deepEqual(inserted.config, {
    serverName: 'oauthnew',
    url: 'https://oauthnew.example/mcp',
    credentialRef: 'OAUTHNEW_REF',
    callbackPort: 45872,
  })

  // The new row lands in the list as an OAuth-owned row right away.
  const row = listOf(await endpoint(route, 'list', null)).find((server) => server.id === 'mcp-oauth-new')
  assert.equal(row.ownerPackage, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(row.transport, 'streamable-http')
  assert.equal(row.credentialRef, 'OAUTHNEW_REF')

  // The OAuth bridge's own rules apply: a public http:// URL is rejected.
  const rejected = await endpoint(route, 'add', {
    id: 'mcp-oauth-bad',
    config: {
      serverName: 'oauthbad',
      transport: 'streamable-http',
      url: 'http://public.example/mcp',
    },
  })
  assert.equal(rejected.json.error.code, 'invalid-config')
  assert.equal(typeof rejected.json.error.details.fields.url, 'string')
})

test('an undecided probe defaults to the built-in client, an edit keeps the owner', async () => {
  const added = await endpoint(harness({ probe: async () => 'unreachable' }).route, 'add', {
    id: 'mcp-offline',
    config: { serverName: 'offline', transport: 'streamable-http', url: 'https://offline.example/mcp' },
  })
  assert.deepEqual(added.json.value, { added: 'mcp-offline', probe: 'unreachable' })

  // The live OAuth row keeps its bridge when the endpoint cannot be reached:
  // an offline probe must not silently strip its credential reference.
  const keepRun = harness({ probe: async () => 'unreachable' })
  installOAuthBridge(keepRun.patchFile)
  const kept = await endpoint(keepRun.route, 'update', {
    id: 'oauth-mcp-cloudflare',
    config: {
      serverName: 'cloudflare',
      transport: 'streamable-http',
      url: 'https://mcp.cloudflare.com/mcp/v2',
    },
  })
  assert.deepEqual(kept.json.value, { updated: 'oauth-mcp-cloudflare', probe: 'unreachable' })
  const keptRow = readPatchList(keepRun.patchFile).flatMap((row) => row.insert ?? [])[0]
  assert.equal(keptRow.name, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(keptRow.config.credentialRef, 'CLOUDFLARE_MCP_OAUTH')

  // A live built-in row moves to the OAuth bridge when the probe demands it.
  const moveRun = harness({ probe: async () => 'oauth' })
  installOAuthBridge(moveRun.patchFile)
  const moved = await endpoint(moveRun.route, 'update', {
    id: 'mcp-github',
    config: { serverName: 'github', transport: 'streamable-http', url: 'https://github.example/mcp' },
  })
  assert.deepEqual(moved.json.value, { updated: 'mcp-github', probe: 'oauth' })
  const movedRow = readPatchList(moveRun.patchFile).find((row) => row.id === 'mcp-github')
  assert.equal(movedRow.name, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(movedRow.config.transport, undefined, 'the OAuth schema has no transport field')
  assert.equal(movedRow.disabled, true, 'an edit must not re-enable a row the user had switched off')
})

test('a row sent to an OAuth bridge the profile lacks is flagged, saved disabled', async () => {
  // No package in the temp profile: the row is written disabled, the panel is warned.
  const gapRun = harness({ probe: async () => 'oauth' })
  const gapAdded = await endpoint(gapRun.route, 'add', {
    id: 'mcp-oauth-gap',
    config: { serverName: 'gap', transport: 'streamable-http', url: 'https://gap.example/mcp' },
  })
  assert.deepEqual(gapAdded.json.value, {
    added: 'mcp-oauth-gap',
    probe: 'oauth',
    oauthBridgeMissing: true,
  })
  const gapRow = readPatchList(gapRun.patchFile).at(-1).insert[0]
  assert.equal(gapRow.name, MCP_OAUTH_CLIENT_PACKAGE, 'the row is saved anyway: install the bridge later')
  assert.equal(gapRow.disabled, true, 'it cannot load, so it is saved switched off')
  // The host log names the package and what to do about it.
  assert.equal(gapRun.warnings.filter((warning) => warning.includes(MCP_OAUTH_CLIENT_PACKAGE)).length, 1)

  // The same profile with the bridge installed reports nothing extra.
  const okRun = harness({ probe: async () => 'oauth' })
  installOAuthBridge(okRun.patchFile)
  const okAdded = await endpoint(okRun.route, 'add', {
    id: 'mcp-oauth-ok',
    config: { serverName: 'ok', transport: 'streamable-http', url: 'https://ok.example/mcp' },
  })
  assert.deepEqual(okAdded.json.value, { added: 'mcp-oauth-ok', probe: 'oauth' })
  assert.equal(readPatchList(okRun.patchFile).at(-1).insert[0].disabled, undefined)
  assert.deepEqual(okRun.warnings, [])

  // A built-in row never consults the bridge at all.
  const builtInRun = harness()
  const builtIn = await endpoint(builtInRun.route, 'add', {
    id: 'mcp-plain',
    config: { serverName: 'plain', transport: 'stdio', command: 'npx' },
  })
  assert.deepEqual(builtIn.json.value, { added: 'mcp-plain', probe: 'plain' })
  assert.deepEqual(builtInRun.warnings, [])

  // An edit that keeps an OAuth owner is flagged and disabled the same way.
  const keepRun = harness({ probe: async () => 'unreachable' })
  const kept = await endpoint(keepRun.route, 'update', {
    id: 'oauth-mcp-cloudflare',
    config: { serverName: 'cloudflare', transport: 'streamable-http', url: 'https://mcp.cloudflare.com/mcp/v2' },
  })
  assert.equal(kept.json.value.probe, 'unreachable')
  assert.equal(kept.json.value.oauthBridgeMissing, true)
  assert.equal(readPatchList(keepRun.patchFile).flatMap((row) => row.insert ?? [])[0].disabled, true)
})

test('the switch cannot be turned on while the bridge is missing, and works once it is installed', async () => {
  // The seeded OAuth row is saved enabled; there is no bridge in the profile.
  const gapRun = harness()
  const before = listOf(await endpoint(gapRun.route, 'list', null))
    .find((server) => server.id === 'oauth-mcp-cloudflare')
  assert.equal(before.bridgeMissing, true)
  assert.equal(before.ownerPackage, MCP_OAUTH_CLIENT_PACKAGE)

  // Every other row is not flagged: the field is present only when true.
  const other = listOf(await endpoint(gapRun.route, 'list', null))
    .find((server) => server.id === 'mcp-github')
  assert.equal('bridgeMissing' in other, false)

  const refused = await endpoint(gapRun.route, 'setEnabled', { id: 'oauth-mcp-cloudflare', enabled: true })
  assert.equal(refused.json.ok, false)
  assert.equal(refused.json.error.code, 'bridge-missing')
  assert.match(refused.json.error.message, /@hualiong\/dsh-oauth-mcp-client/)
  assert.equal(
    readPatchList(gapRun.patchFile).flatMap((row) => row.insert ?? [])[0].disabled,
    undefined,
    'a refused enable must not touch the file',
  )

  // Switching off is always allowed.
  const disabled = await endpoint(gapRun.route, 'setEnabled', { id: 'oauth-mcp-cloudflare', enabled: false })
  assert.deepEqual(disabled.json, { ok: true, value: { id: 'oauth-mcp-cloudflare', enabled: false } })
  assert.equal(readPatchList(gapRun.patchFile).flatMap((row) => row.insert ?? [])[0].disabled, true)

  // Install the bridge: the same row switches on without being saved again.
  installOAuthBridge(gapRun.patchFile)
  const after = listOf(await endpoint(gapRun.route, 'list', null))
    .find((server) => server.id === 'oauth-mcp-cloudflare')
  assert.equal('bridgeMissing' in after, false)

  const enabled = await endpoint(gapRun.route, 'setEnabled', { id: 'oauth-mcp-cloudflare', enabled: true })
  assert.deepEqual(enabled.json, { ok: true, value: { id: 'oauth-mcp-cloudflare', enabled: true } })
  assert.equal(readPatchList(gapRun.patchFile).flatMap((row) => row.insert ?? [])[0].disabled, false)
})

test('an official row rejects an unknown transport, and the OAuth branch rejects stdio', async () => {
  const { route, patchFile } = harness()
  // `update` keys the schema off the owner the probe picked, so the built-in
  // row cannot be handed a transport its own schema does not know.
  const reply = await endpoint(route, 'update', {
    id: 'mcp-github',
    config: { serverName: 'github', transport: 'sse', url: 'https://github.example/mcp' },
  })
  assert.equal(reply.json.error.code, 'invalid-config')
  assert.equal(typeof reply.json.error.details.fields.transport, 'string')
  assert.equal(readPatchList(patchFile).find((row) => row.id === 'mcp-github').config.transport, 'streamable-http')

  // The ownership rule never hands an OAuth row a stdio config, so this guard is
  // the last line of defence and is checked directly.
  const stdioOnOauth = validateMcpConfig(
    'x',
    { serverName: 'x', transport: 'stdio', command: 'npx' },
    MCP_OAUTH_CLIENT_PACKAGE,
  )
  assert.equal(typeof stdioOnOauth.transport, 'string')
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
  assert.equal(insert[0].name, '@hualiong/dsh-oauth-mcp-client')

  // A bundle-defined row is not in the patch: the override must repeat its package.
  const bundle = await endpoint(route, 'setEnabled', { id: 'oauth-mcp-bundle', enabled: false })
  assert.equal(bundle.json.ok, true)
  const override = readPatchList(patchFile).find((row) => row.id === 'oauth-mcp-bundle')
  assert.equal(override.name, '@hualiong/dsh-oauth-mcp-client')
  assert.equal(override.disabled, true)

  const malformed = await endpoint(route, 'setEnabled', { id: 'oauth-mcp-bundle', enabled: 'yes' })
  assert.equal(malformed.json.error.code, 'bad-request')
})

test('update keeps the OAuth row intact and never writes a transport key into it', async () => {
  const { route, patchFile } = harness({ probe: async () => 'oauth' })
  installOAuthBridge(patchFile)
  const reply = await endpoint(route, 'update', {
    id: 'oauth-mcp-cloudflare',
    config: {
      serverName: 'cloudflare',
      transport: 'streamable-http',
      url: 'https://mcp.cloudflare.com/mcp/v2',
      callbackPort: 45872,
    },
  })
  assert.deepEqual(reply.json, { ok: true, value: { updated: 'oauth-mcp-cloudflare', probe: 'oauth' } })

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

test('list reports the file `enabled` while the fiber still disagrees', async () => {
  const { route, patchFile } = harness()
  // The live github entry is disabled; enabling it must show up immediately.
  assert.equal(listOf(await endpoint(route, 'list', null)).find((s) => s.id === 'mcp-github').enabled, false)

  await endpoint(route, 'setEnabled', { id: 'mcp-github', enabled: true })
  assert.equal(readPatchList(patchFile).find((row) => row.id === 'mcp-github').disabled, false)

  const enabled = listOf(await endpoint(route, 'list', null)).find((server) => server.id === 'mcp-github')
  assert.equal(enabled.enabled, true, 'the file value wins over the stale fiber')
  assert.equal(enabled.fiberPhase, 'active', 'the phase stays live')
  assert.equal(enabled.toolCount, 1, 'the tool count stays live')

  await endpoint(route, 'setEnabled', { id: 'mcp-github', enabled: false })
  const disabled = listOf(await endpoint(route, 'list', null)).find((server) => server.id === 'mcp-github')
  assert.equal(disabled.enabled, false)
})

test('list reflects a just-saved edit without waiting for the loader', async () => {
  const { route, patchFile } = harness({ probe: async () => 'oauth' })
  installOAuthBridge(patchFile)
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
  assert.equal(row.ownerPackage, MCP_CLIENT_PACKAGE)
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
