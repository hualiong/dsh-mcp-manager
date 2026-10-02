/**
 * Host-half unit tests for MCP row recognition and patch writing: both bridge
 * packages are enumerated, the owner package is reported verbatim, and an edit
 * never corrupts a non-native (OAuth) row.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MCP_CLIENT_PACKAGE,
  MCP_OAUTH_CLIENT_PACKAGE,
} from '../src/shared.ts'
import {
  addMcpRow,
  patchHasId,
  removeMcpRow,
  setMcpEnabled,
  updateMcpConfig,
} from '../src/patch.ts'
import {
  countServerTools,
  findMcpServer,
  listMcpServers,
  normalizeEntryId,
  serverNameTaken,
  toServerConfig,
} from '../src/status.ts'

const ENTRIES = [
  {
    id: 'include:oauth-mcp-cloudflare',
    disabled: false,
    options: {
      name: MCP_OAUTH_CLIENT_PACKAGE,
      config: {
        serverName: 'cloudflare',
        url: 'https://mcp.cloudflare.com/mcp',
        credentialRef: 'CLOUDFLARE_MCP_OAUTH',
        scope: 'mcp.read',
        callbackPort: 45_871,
        authorizationTimeoutMs: 600_000,
      },
    },
    fiber: { state: 2 },
  },
  {
    id: 'include:mcp-github',
    disabled: true,
    options: {
      name: MCP_CLIENT_PACKAGE,
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
  { id: 'group', options: { name: 'ignored', group: true } },
  { id: 'other', options: { name: '@deepseek-ai/dsh-client-ui-settings' } },
  { id: 'no-fiber', options: { name: MCP_OAUTH_CLIENT_PACKAGE, config: { serverName: 'idle' } } },
]

function fakeCtx(entries = ENTRIES) {
  return {
    loader: { entries: () => entries },
    tools: {
      schemas: () => [
        { name: 'mcp__cloudflare__search' },
        { name: 'mcp__github__search_code' },
        { name: 'mcp__github__list_branches' },
        { name: 'unrelated' },
      ],
    },
  }
}

test('listMcpServers enumerates both bridge packages and skips everything else', () => {
  const servers = listMcpServers(fakeCtx(), (id) => id === 'oauth-mcp-cloudflare')
  assert.deepEqual(servers.map((server) => server.serverName).sort(), ['cloudflare', 'github', 'idle'])

  const cloudflare = servers.find((server) => server.serverName === 'cloudflare')
  assert.equal(cloudflare.id, 'oauth-mcp-cloudflare')
  assert.equal(cloudflare.ownerPackage, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(cloudflare.transport, 'streamable-http')
  assert.equal(cloudflare.url, 'https://mcp.cloudflare.com/mcp')
  assert.equal(cloudflare.credentialRef, 'CLOUDFLARE_MCP_OAUTH')
  assert.equal(cloudflare.scope, 'mcp.read')
  assert.equal(cloudflare.callbackPort, 45_871)
  assert.equal(cloudflare.authorizationTimeoutMs, 600_000)
  assert.equal(cloudflare.enabled, true)
  assert.equal(cloudflare.fiberPhase, 'active')
  assert.equal(cloudflare.toolCount, 1)
  assert.equal(cloudflare.userManaged, true)

  const github = servers.find((server) => server.serverName === 'github')
  assert.equal(github.ownerPackage, MCP_CLIENT_PACKAGE)
  assert.equal(github.transport, 'streamable-http')
  assert.equal(github.toolCount, 2)
  assert.equal(github.failOnStartupError, false)
  assert.equal(github.userManaged, false)

  const idle = servers.find((server) => server.serverName === 'idle')
  assert.equal(idle.ownerPackage, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(idle.fiberPhase, null)
  assert.equal(idle.toolCount, 0)
})

test('findMcpServer resolves by file-level id and reports the owner package', () => {
  const ctx = fakeCtx()
  assert.equal(findMcpServer(ctx, 'oauth-mcp-cloudflare').ownerPackage, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(findMcpServer(ctx, 'include:oauth-mcp-cloudflare').ownerPackage, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(findMcpServer(ctx, 'mcp-github').config.serverName, 'github')
  assert.equal(findMcpServer(ctx, 'group'), undefined)
  assert.equal(findMcpServer(ctx, 'other'), undefined)
  assert.equal(findMcpServer(ctx, 'missing'), undefined)
})

test('serverNameTaken spans both bridge packages', () => {
  const ctx = fakeCtx()
  assert.equal(serverNameTaken(ctx, 'cloudflare'), true)
  assert.equal(serverNameTaken(ctx, 'github'), true)
  assert.equal(serverNameTaken(ctx, 'idle'), true)
  assert.equal(serverNameTaken(ctx, 'unrelated'), false)
  assert.equal(serverNameTaken(ctx, 'cloudflare', 'oauth-mcp-cloudflare'), false)
  assert.equal(serverNameTaken(ctx, 'github', 'oauth-mcp-cloudflare'), true)
})

test('toServerConfig keeps every modeled field and normalizes the OAuth transport', () => {
  const oauth = toServerConfig({ serverName: 'x', url: 'https://x.example/mcp', transport: 'stdio' }, true)
  assert.equal(oauth.transport, 'streamable-http')
  const native = toServerConfig(
    { serverName: 'y', transport: 'stdio', command: 'node', args: ['-v'], env: { A: 'b' }, cwd: '/tmp' },
    false,
  )
  assert.equal(native.transport, 'stdio')
  assert.deepEqual(native.args, ['-v'])
  assert.deepEqual(native.env, { A: 'b' })
  assert.equal(native.cwd, '/tmp')
  assert.deepEqual(toServerConfig(undefined, false), {
    serverName: '',
    transport: 'streamable-http',
    url: undefined,
    command: undefined,
    args: undefined,
    env: undefined,
    cwd: undefined,
    headers: undefined,
    toolCallTimeoutMs: undefined,
    failOnStartupError: undefined,
    reconnect: undefined,
    credentialRef: undefined,
    scope: undefined,
    callbackPort: undefined,
    authorizationTimeoutMs: undefined,
  })
})

test('countServerTools and normalizeEntryId follow the loader id conventions', () => {
  const ctx = fakeCtx()
  assert.equal(countServerTools(ctx, 'github'), 2)
  assert.equal(countServerTools(ctx, 'cloudflare'), 1)
  assert.equal(countServerTools(ctx, ''), 0)
  assert.equal(normalizeEntryId('include:mcp-github'), 'mcp-github')
  assert.equal(normalizeEntryId('include:group:mcp-github'), 'group:mcp-github')
  assert.equal(normalizeEntryId('mcp-github'), 'mcp-github')
})

const OAUTH_ROW = {
  insert: [
    {
      id: 'oauth-mcp-cloudflare',
      name: MCP_OAUTH_CLIENT_PACKAGE,
      config: {
        serverName: 'cloudflare',
        url: 'https://mcp.cloudflare.com/mcp',
        credentialRef: 'CLOUDFLARE_MCP_OAUTH',
        callbackPort: 45_871,
      },
    },
  ],
}

test('addMcpRow always writes an official-client insert row', () => {
  const rows = addMcpRow([], 'mcp-new', {
    serverName: 'new',
    transport: 'streamable-http',
    url: 'https://new.example/mcp',
  })
  assert.equal(rows[0].insert[0].name, MCP_CLIENT_PACKAGE)
  assert.equal(rows[0].insert[0].config.transport, 'streamable-http')

  // A stdio row keeps its transport; a row without one defaults to http.
  const stdio = addMcpRow([], 'mcp-stdio', { serverName: 's', transport: 'stdio', command: 'node' })
  assert.equal(stdio[0].insert[0].config.transport, 'stdio')
  assert.equal(stdio[0].insert[0].config.command, 'node')

  // The OAuth-only keys are never written into an official-client row.
  const stray = addMcpRow([], 'mcp-stray', {
    serverName: 's',
    transport: 'streamable-http',
    url: 'https://s.example/mcp',
    credentialRef: 'NOPE',
  })
  assert.equal(stray[0].insert[0].config.credentialRef, undefined)
})

test('updateMcpConfig merges over an OAuth row instead of replacing it', () => {
  const rows = updateMcpConfig(
    structuredClone([OAUTH_ROW]),
    'oauth-mcp-cloudflare',
    {
      serverName: 'cloudflare',
      transport: 'streamable-http',
      url: 'https://mcp.cloudflare.com/mcp/v2',
      scope: 'files:read',
    },
    MCP_OAUTH_CLIENT_PACKAGE,
  )
  const config = rows[0].insert[0].config
  assert.equal(rows[0].insert[0].name, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(config.url, 'https://mcp.cloudflare.com/mcp/v2')
  assert.equal(config.credentialRef, 'CLOUDFLARE_MCP_OAUTH')
  assert.equal(config.callbackPort, 45_871)
  assert.equal(config.scope, 'files:read')
  assert.equal(config.transport, undefined)
  assert.equal(rows[0].insert[0].id, 'oauth-mcp-cloudflare')
})

test('a synthesized override row repeats the entry owner package', () => {
  const updated = updateMcpConfig(
    [],
    'oauth-mcp-bundle',
    { serverName: 'bundle', transport: 'streamable-http', url: 'https://b.example/mcp' },
    MCP_OAUTH_CLIENT_PACKAGE,
  )
  assert.equal(updated[0].name, MCP_OAUTH_CLIENT_PACKAGE)
  assert.equal(updated[0].config.transport, undefined, 'the OAuth schema has no transport field')

  const toggled = setMcpEnabled([], 'oauth-mcp-bundle', false, MCP_OAUTH_CLIENT_PACKAGE)
  assert.deepEqual(toggled[0], { id: 'oauth-mcp-bundle', name: MCP_OAUTH_CLIENT_PACKAGE, disabled: true })

  const native = setMcpEnabled([], 'mcp-x', true)
  assert.equal(native[0].name, MCP_CLIENT_PACKAGE)
  assert.equal(native[0].disabled, false)
})

test('setMcpEnabled flips the flag on the located patch entry', () => {
  const rows = setMcpEnabled(structuredClone([OAUTH_ROW]), 'oauth-mcp-cloudflare', false)
  assert.equal(rows[0].insert[0].disabled, true)
  assert.equal(rows[0].insert[0].name, MCP_OAUTH_CLIENT_PACKAGE)

  const topLevel = setMcpEnabled([{ id: 'mcp-github', name: MCP_CLIENT_PACKAGE, disabled: true }], 'mcp-github', true)
  assert.equal(topLevel[0].disabled, false)
})

test('removeMcpRow drops the item and the emptied insert row', () => {
  const rows = removeMcpRow(structuredClone([OAUTH_ROW, { id: 'keep', name: MCP_CLIENT_PACKAGE }]), 'oauth-mcp-cloudflare')
  assert.deepEqual(rows, [{ id: 'keep', name: MCP_CLIENT_PACKAGE }])

  const partial = removeMcpRow([
    { insert: [{ id: 'a' }, { id: 'b' }] },
  ], 'a')
  assert.deepEqual(partial, [{ insert: [{ id: 'b' }] }])
})

test('patchHasId sees top-level rows and insert items', () => {
  const rows = structuredClone([OAUTH_ROW, { id: 'keep', name: MCP_CLIENT_PACKAGE }])
  assert.equal(patchHasId(rows, 'oauth-mcp-cloudflare'), true)
  assert.equal(patchHasId(rows, 'keep'), true)
  assert.equal(patchHasId(rows, 'nope'), false)
})
