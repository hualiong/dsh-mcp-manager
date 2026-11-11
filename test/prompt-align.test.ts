/**
 * Unit tests for the prompt/execution-surface alignment (P1 sections strip,
 * P2 resource-name section rewrite, P3 resource meta-tool guard). The fake
 * bus mirrors cordis 4.0.4 `Events.waterfall` exactly: listeners chain over
 * one shared args array, `next()` takes no payload argument, and the
 * waterfall RESULT is the outermost listener's return value — which is why
 * the engine must return new objects instead of mutating the shared ones.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPromptAlignment } from '../src/prompt-align.ts'

/** cordis `waterfall(...args)`: pop the final callback, append `next`, run. */
function runWaterfall(listeners, ...args) {
  const inner = args.pop()
  const queue = [...listeners]
  let innerCalls = 0
  const next = () => {
    const step = queue.shift()
    if (step === undefined) {
      innerCalls += 1
      return inner(...args)
    }
    return step(...args)
  }
  args.push(next)
  return { promise: next(), innerCalls: () => innerCalls }
}

const RESOURCE_HEADER =
  '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: '

const resourceText = (names) => `${RESOURCE_HEADER}${JSON.stringify(names)}.`

/**
 * Host shape mirrored from the asar evidence (dsh-agent-loop 0.2.2-rc.1):
 * both waterfalls dispatch the AGENT (`assembleContextFor` sets `scope:
 * agent`; the scheduler sets `exec.agent`), while `agentPresets.composedPreset`
 * keys on the Agent's scoped Context (`ctx[kScope]`). The fake service is
 * identity-bound exactly like the real one: only `agentCtx` composes 'p1' —
 * hand it the Agent unwrapped-less and it finds no preset. This is what
 * pins the unwrap; reverting it fails these tests.
 */
const agentCtx = { sessionId: 'live-agent' }
const caller = { ctx: agentCtx }

/**
 * A host with just the two waterfalls: an event bus, effect bookkeeping, and
 * an `agentPresets` handle behind `ctx.get` (absent when `presets` is unset).
 * `presetOf(scope)` decides what identity each scope composes.
 */
function fakeHost({ presets = undefined, servers = [], policy = {}, presetOf = (id) => (id === agentCtx ? 'p1' : undefined), serversThrow = false } = {}) {
  const events = new Map()
  const warnings = []
  const disposers = []
  const childLogger = {
    info() {},
    warn: (...args) => warnings.push(args.join(' ')),
    error() {},
    debug() {},
  }
  const seen = { scopes: [], listServersCalls: 0 }
  const svc = presets === undefined && presetOf !== null
    ? { compositionInventory: () => [], composedPreset: (scope) => { seen.scopes.push(scope); return presetOf(scope) } }
    : presets
  const ctx = {
    logger: Object.assign(() => childLogger, childLogger),
    on(name, handler) {
      const list = events.get(name) ?? []
      list.push(handler)
      events.set(name, list)
      return () => events.set(name, (events.get(name) ?? []).filter((entry) => entry !== handler))
    },
    effect(callback) {
      disposers.push(callback())
    },
    get: (name) => (name === 'agentPresets' ? svc : undefined),
  }
  createPromptAlignment(ctx, {
    listServers: () => {
      seen.listServersCalls += 1
      if (serversThrow) throw new Error('patch file unreadable')
      return servers
    },
    policy: () => policy,
  })
  const assembleSurface = (assembly, context) => runWaterfall(
    [...(events.get('system-prompt/assemble') ?? [])],
    assembly,
    context,
    () => Promise.resolve(assembly),
  )
  const decide = (exec) => runWaterfall(
    [...(events.get('tools/pre-execute') ?? [])],
    exec,
    () => Promise.resolve({ kind: 'allow' }),
  )
  const dispose = () => disposers.splice(0).forEach((off) => off())
  return { ctx, events, warnings, seen, assembleSurface, decide, dispose, svc }
}

/** A typical assembled surface: sections are fresh `{name, text}` objects. */
function assembly(extra = []) {
  return {
    sections: [
      { name: 'persona', text: 'you are…' },
      { name: 'mcp:github', text: '### MCP server: github\n\nGitHub tools.' },
      { name: 'mcp-resource-servers', text: resourceText(['github']), interpolate: false },
      ...extra,
    ],
    contexts: [],
    variables: {},
  }
}

const SERVERS = [
  { id: 'srv-github', serverName: 'github' },
  { id: 'srv-webdav', serverName: 'webdav' },
]

test('a deployment without the preset service passes the assembly through and reads no state', async () => {
  const host = fakeHost({ presetOf: null, servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const input = assembly()
  const run = host.assembleSurface(input, { scope: caller })
  assert.equal(await run.promise, input, 'the very same assembly object comes back')
  assert.equal(host.seen.listServersCalls, 0, 'no IO when there is nothing to decide')
  assert.deepEqual(host.warnings, [])
})

test('composedPreset is asked with the agent Context, never the dispatched Agent', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const input = assembly()
  const result = await host.assembleSurface(input, { scope: caller }).promise
  assert.equal(host.seen.scopes[0], agentCtx, 'the Agent was unwrapped to its scoped Context')
  assert.equal(result.sections.some((section) => section.name === 'mcp:github'), false, 'and the mask applied on the live identity shape')
  const stranger = await host.assembleSurface(assembly(), { scope: { ctx: { sessionId: 'other-agent' } } }).promise
  assert.equal(stranger.sections.some((section) => section.name === 'mcp:github'), true, 'an identity with no bound preset hides nothing (fail open)')
})

test('hidden servers lose their mcp:<server> instruction sections', async () => {
  const webdav = { name: 'mcp:webdav', text: '### MCP server: webdav' }
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const input = assembly([webdav])
  const result = await host.assembleSurface(input, { scope: caller }).promise
  // `github` is the only name in the resource list, so that section drops too
  // (fully hidden ⇒ absent, same rule as P2).
  const names = result.sections.map((section) => section.name)
  assert.deepEqual(names, ['persona', 'mcp:webdav'])
  assert.notEqual(result.sections, input.sections, 'a copied array, not the shared one')
  assert.equal(result.sections[result.sections.length - 1], webdav, 'untouched sections keep identity')
})

test('resource section: fully hidden drops it, partially hidden rebuilds the name array', async () => {
  const hostAll = fakeHost({
    servers: SERVERS,
    policy: { 'srv-github': { p1: false }, 'srv-webdav': { p1: false } },
  })
  const both = {
    sections: [
      { name: 'persona', text: 'you are…' },
      { name: 'mcp:github', text: 'instr' },
      { name: 'mcp:webdav', text: 'instr' },
      { name: 'mcp-resource-servers', text: resourceText(['github', 'webdav']), interpolate: false },
    ],
    contexts: [],
    variables: {},
  }
  const dropped = await hostAll.assembleSurface(both, { scope: caller }).promise
  assert.deepEqual(dropped.sections.map((section) => section.name), ['persona'],
    'both instruction sections and the emptied resource list drop out')

  const hostPart = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const original = assembly()
  original.sections[2] = { name: 'mcp-resource-servers', text: resourceText(['github', 'webdav']), interpolate: false }
  const rewritten = await hostPart.assembleSurface(original, { scope: caller }).promise
  const section = rewritten.sections.find((entry) => entry.name === 'mcp-resource-servers')
  const source = original.sections.find((entry) => entry.name === 'mcp-resource-servers')
  assert.notEqual(section, source, 'the rewritten section is a new object')
  assert.equal(section.text, `${RESOURCE_HEADER}${JSON.stringify(['webdav'])}.`)
  const listed = JSON.parse(section.text.slice(RESOURCE_HEADER.length, -1))
  assert.deepEqual(listed, ['webdav'], 'hidden names are gone from the JSON array')
  assert.equal(section.interpolate, false, 'other members carry over into the copy')
})

test('a resource text that does not match the template fails open', async () => {
  const junk = [
    'something else entirely',
    `${RESOURCE_HEADER}not-json].`,
    `${RESOURCE_HEADER}${JSON.stringify({ github: true })}.`,
    `${RESOURCE_HEADER}${JSON.stringify(['github', 7])}.`,
    `${RESOURCE_HEADER}${JSON.stringify(['github'])}`,
  ]
  for (const text of junk) {
    const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
    const section = { name: 'mcp-resource-servers', text, interpolate: false }
    const input = { sections: [section], contexts: [], variables: {} }
    const result = await host.assembleSurface(input, { scope: caller }).promise
    // Only the hidden instruction section hits; the resource section must come
    // back as the very same object: fail open, never rewrite a drifted shape.
    assert.equal(result.sections.some((entry) => entry === section), true, text.slice(0, 40))
  }
})

test('the shared surface is never mutated: frozen inputs survive a full rewrite', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const sections = Object.freeze([
    Object.freeze({ name: 'persona', text: 'you are…' }),
    Object.freeze({ name: 'mcp:github', text: 'instr' }),
    Object.freeze({ name: 'mcp-resource-servers', text: resourceText(['github', 'webdav']), interpolate: false }),
  ])
  const input = Object.freeze({ sections, contexts: Object.freeze([]), variables: Object.freeze({}) })
  const result = await host.assembleSurface(input, { scope: caller }).promise
  assert.notEqual(result, input, 'a copy is returned')
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0], sections[0], 'untouched sections keep identity')
  assert.notEqual(result.sections[1], sections[2], 'the rewritten section is new')
  // The frozen originals prove the contract: no mutation happened anywhere.
  assert.equal(sections.length, 3)
  assert.equal(sections[2].text, resourceText(['github', 'webdav']))
  assert.equal(input.sections, sections)
})

test('an assembly whose surface hides nothing else keeps the exact original object', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-webdav': { p1: false } } })
  const input = assembly()
  const result = await host.assembleSurface(input, { scope: caller }).promise
  assert.equal(result, input, 'webdav is hidden but absent from this surface: zero churn')
  assert.equal(host.seen.listServersCalls, 1, 'the decision still read state once')
})

test('a non-array sections field is left alone', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const input = { sections: undefined, contexts: [] }
  assert.equal(await host.assembleSurface(input, { scope: caller }).promise, input)
})

test('guard: a hidden server resource call is denied without reaching the chain', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const run = host.decide({
    name: 'read_mcp_resource',
    arguments: { server: 'github', uri: 'file:///a' },
    agent: caller,
  })
  const decision = await run.promise
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /github/)
  assert.match(decision.reason, /hidden for this agent's preset/)
  assert.deepEqual(decision.info, { name: 'McpVisibility', code: 'server-hidden-for-preset' })
  assert.equal(run.innerCalls(), 0, 'deny short-circuits the waterfall')

  for (const name of ['list_mcp_resources', 'list_mcp_resource_templates']) {
    const other = host.decide({ name, arguments: { server: 'github' }, agent: caller })
    assert.equal((await other.promise).kind, 'deny', name)
  }
})

test('guard: the allow matrix — visible, unrelated tools, unreadable args, no preset', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const cases = [
    { name: 'read_mcp_resource', arguments: { server: 'webdav' }, agent: caller, why: 'visible server' },
    { name: 'mcp__github__search', arguments: { server: 'github' }, agent: caller, why: 'namespaced tool' },
    { name: 'read_file', arguments: { server: 'github' }, agent: caller, why: 'unrelated tool' },
    { name: 'read_mcp_resource', arguments: {}, agent: caller, why: 'missing server arg' },
    { name: 'read_mcp_resource', arguments: { server: 7 }, agent: caller, why: 'non-string server' },
    { name: 'read_mcp_resource', arguments: 'github', agent: caller, why: 'non-object args' },
    { name: 'read_mcp_resource', agent: caller, why: 'no arguments at all' },
    { name: 'read_mcp_resource', arguments: { server: 'github' }, why: 'caller agent unknown' },
  ]
  for (const spec of cases) {
    const run = host.decide(spec)
    assert.equal((await run.promise).kind, 'allow', spec.why)
    assert.ok(run.innerCalls() >= 1, `${spec.why}: the chain still runs`)
  }

  const noPreset = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } }, presetOf: () => undefined })
  const bare = noPreset.decide({ name: 'read_mcp_resource', arguments: { server: 'github' }, agent: caller })
  assert.equal((await bare.promise).kind, 'allow', 'a scope composing no preset inherits everything')

  const noService = fakeHost({ presetOf: null, servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const orphan = noService.decide({ name: 'read_mcp_resource', arguments: { server: 'github' }, agent: caller })
  assert.equal((await orphan.promise).kind, 'allow', 'no roster service means no visibility layer')
})

test('a throwing composedPreset warns once per message and passes the surface through', async () => {
  let boom = true
  const host = fakeHost({
    servers: SERVERS,
    policy: { 'srv-github': { p1: false } },
    presetOf: () => {
      if (boom) throw new Error('preset registry busy')
      return 'p1'
    },
  })
  const input = assembly()
  assert.equal(await host.assembleSurface(input, { scope: caller }).promise, input)
  assert.equal(await host.assembleSurface(input, { scope: caller }).promise, input, 'again, still pass-through')
  assert.equal(host.warnings.filter((line) => line.includes('preset registry busy')).length, 1, 'warn once')

  boom = false
  const rewritten = await host.assembleSurface(assembly(), { scope: caller }).promise
  assert.equal(rewritten.sections.some((section) => section.name === 'mcp:github'), false, 'recovered normally')
})

test('unreadable state passes the surface through with a warning', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } }, serversThrow: true })
  const input = assembly()
  assert.equal(await host.assembleSurface(input, { scope: caller }).promise, input)
  assert.ok(host.warnings.some((line) => line.includes('patch file unreadable')))
  const run = host.decide({ name: 'read_mcp_resource', arguments: { server: 'github' }, agent: caller })
  assert.equal((await run.promise).kind, 'allow', 'a guard that cannot decide never denies')
})

test('a flip stored for another preset settles on the sidecar alone: no server enumeration', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { 'other-preset': false } } })
  const input = assembly()
  const result = await host.assembleSurface(input, { scope: caller }).promise
  assert.equal(result, input, 'nothing hides for this preset: the very same assembly passes through')
  assert.equal(host.seen.listServersCalls, 0, 'the false cell lives in another column: servers are never enumerated')
})

test('teardown unsubscribes both waterfalls and a stale listener stays inert', async () => {
  const host = fakeHost({ servers: SERVERS, policy: { 'srv-github': { p1: false } } })
  const assembleHandlers = [...host.events.get('system-prompt/assemble')]
  const executeHandlers = [...host.events.get('tools/pre-execute')]
  assert.equal(assembleHandlers.length, 1)
  assert.equal(executeHandlers.length, 1)

  host.dispose()
  assert.deepEqual(host.events.get('system-prompt/assemble'), [], 'unsubscribed from the bus')
  assert.deepEqual(host.events.get('tools/pre-execute'), [])

  // Even if the host had kept a reference, the stopped guard keeps the surface.
  const input = assembly()
  const kept = await runWaterfall(assembleHandlers, input, { scope: caller }, () => Promise.resolve(input)).promise
  assert.equal(kept, input, 'no rewrite after dispose')
  const decision = await runWaterfall(executeHandlers, {
    name: 'read_mcp_resource', arguments: { server: 'github' }, agent: caller,
  }, () => Promise.resolve({ kind: 'allow' })).promise
  assert.equal(decision.kind, 'allow', 'no deny after dispose')
})
