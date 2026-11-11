/**
 * Unit tests for the L2 mask engine: prefix expansion against each scope's
 * own surface, the snapshot comparison that keeps `tools/change` (emitted by
 * a restriction itself) from feeding back into re-restriction, lift release
 * in both host shapes, event-driven attach/detach, graceful degradation
 * without the `agentPresets` service, and per-agent failure containment.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVisibilityManager } from '../src/visibility.ts'

/**
 * One fake agent: `agent.ctx.tools.restrict` behaves like the host — it
 * rejects empty filters, masks its scope, and hands back a disposer.
 * `visible` is what `tools.schemas(agent)` reports: masked names are gone
 * from sight, exactly as the host promises for presentation/lookup/execution.
 */
function fakeAgent(name, tools, { liftForm = 'dispose', refuse = false } = {}) {
  const agent = {
    name,
    base: [...tools],
    masked: new Set(),
    lifts: [],
    restrictCalls: [],
    scopeError: false,
  }
  agent.visible = () => {
    if (agent.scopeError) throw new Error(`schemas boom for ${name}`)
    return agent.base.filter((tool) => !agent.masked.has(tool))
  }
  agent.ctx = {
    tools: {
      restrict(filter) {
        const deny = filter?.deny
        if (!Array.isArray(deny) || deny.length === 0) {
          throw new Error('tools.restrict() rejects empty filters')
        }
        if (refuse) throw new Error(`host refuses restriction for ${name}`)
        if (agent.lifts.some((lift) => !lift.disposed)) {
          throw new Error(`restrict with an active mask: ${name}`)
        }
        for (const tool of deny) agent.masked.add(tool)
        agent.restrictCalls.push([...deny].sort())
        const lift = { deny: [...deny].sort(), disposed: false }
        if (liftForm === 'dispose') {
          lift.dispose = () => {
            lift.disposed = true
            agent.masked.clear()
          }
        } else {
          lift.call = () => {
            lift.disposed = true
            agent.masked.clear()
          }
        }
        agent.lifts.push(lift)
        return liftForm === 'function'
          ? () => {
              lift.dispose?.() ?? lift.call()
            }
          : lift
      },
    },
  }
  return agent
}

/**
 * The fake host: a root ctx with a scope-aware `tools.schemas`, an event
 * bus, effect bookkeeping, and the two optional services behind `ctx.get`.
 */
function fakeWorld({ presets, servers = [], policy = {}, agents = [] } = {}) {
  const events = new Map()
  const warnings = []
  const disposers = []
  const childLogger = { info() {}, warn: (...args) => warnings.push(args.join(' ')), error() {}, debug() {} }
  const ctx = {
    logger: Object.assign(() => childLogger, childLogger),
    tools: {
      schemas: (scope) => {
        // Scoped view: what that agent sees under its active mask (the host
        // keeps presentation, lookup and execution aligned, so masked names
        // really are out of sight). Global view: every registered name.
        const names = scope && typeof scope.visible === 'function'
          ? scope.visible()
          : [...new Set(agents.flatMap((agent) => agent.visible()))]
        return names.map((toolName) => ({ name: toolName }))
      },
    },
    on(event, handler) {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => events.set(event, (events.get(event) ?? []).filter((entry) => entry !== handler))
    },
    emit(event, payload) {
      for (const handler of [...(events.get(event) ?? [])]) handler(payload)
    },
    effect(callback) {
      disposers.push(callback())
    },
    get(name) {
      if (name === 'agents') return { list: () => agents }
      if (name === 'agentPresets') return presets
      return undefined
    },
    warnings,
    disposerCount: () => disposers.length,
  }
  const state = { servers, policy }
  const manager = createVisibilityManager(ctx, {
    listServers: () => state.servers,
    policy: () => state.policy,
  })
  const refresh = (next) => {
    Object.assign(state, next)
    manager.reconcile()
  }
  return { ctx, manager, state, refresh, warnings, agents, disposers }
}

const SERVERS = [
  { id: 'srv-a', serverName: 'a' },
  { id: 'srv-b', serverName: 'b' },
  { id: 'srv-blank', serverName: '' },
]

test('a hidden server is expanded into the scope-specific tool names', () => {
  const agent = fakeAgent('std', ['mcp__a__x', 'mcp__a__y', 'mcp__b__z', 'read_file'])
  const { refresh } = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.deepEqual(agent.restrictCalls, [['mcp__a__x', 'mcp__a__y']], 'prefix expansion, sorted')
  assert.deepEqual(agent.visible(), ['mcp__b__z', 'read_file'], 'presentation follows the mask')

  // A second hidden server joins the same deny set on the next pass.
  refresh({ policy: { 'srv-a': { p1: false }, 'srv-b': { p1: false } } })
  assert.equal(agent.restrictCalls.length, 2)
  assert.deepEqual(agent.restrictCalls[1], ['mcp__a__x', 'mcp__a__y', 'mcp__b__z'])

  // Unhiding clears the mask and publishes nothing in its place.
  refresh({ policy: {} })
  assert.deepEqual(agent.visible(), ['mcp__a__x', 'mcp__a__y', 'mcp__b__z', 'read_file'])
  assert.equal(agent.restrictCalls.length, 2, 'an empty deny is never published')
})

test('two hidden servers whose prefixes nest do not deny each other out', () => {
  // `__` separators make a short serverName a prefix of a longer one's tools.
  const agent = fakeAgent('std', ['mcp__a__x', 'mcp__a1__y'])
  const { refresh } = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: [{ id: 'srv-a', serverName: 'a' }],
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.deepEqual(agent.restrictCalls, [['mcp__a__x']])
  refresh({ servers: [{ id: 'srv-a', serverName: 'a' }, { id: 'srv-a1', serverName: 'a1' }] })
  assert.equal(agent.restrictCalls.length, 1, 'a new server the matrix never hid changes nothing')
})

test('an agent composing no preset carries no mask, and its old one is cleared', () => {
  const agent = fakeAgent('std', ['mcp__a__x', 'other'])
  let preset = 'p1'
  const world = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => preset },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.equal(agent.restrictCalls.length, 1)
  assert.equal(agent.lifts[0].disposed, false)

  // The session recomposed without a preset: the mask must go, not linger.
  preset = undefined
  world.refresh({})
  assert.equal(agent.lifts[0].disposed, true, 'the stale lift was released')
  assert.equal(agent.restrictCalls.length, 1, 'and nothing was published in its place')
  assert.deepEqual(agent.visible(), ['mcp__a__x', 'other'])

  // Composing another preset hides again — a fresh lift, not the old one.
  preset = 'p2'
  world.refresh({ policy: { 'srv-a': { p2: false } } })
  assert.equal(agent.restrictCalls.length, 2)
  assert.deepEqual(agent.restrictCalls[1], ['mcp__a__x'])
})

test('reconcile is idempotent: the second pass publishes nothing', () => {
  const agent = fakeAgent('std', ['mcp__a__x'])
  const { manager, refresh } = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.equal(agent.restrictCalls.length, 1)
  manager.reconcile()
  manager.reconcile()
  refresh({})
  refresh({})
  assert.equal(agent.restrictCalls.length, 1, 'no re-restriction after the state settled')
  assert.equal(agent.lifts.length, 1, 'and the single lift was never re-applied')
})

test('the snapshot comparison breaks the tools/change feedback loop', () => {
  const agent = fakeAgent('std', ['mcp__a__x', 'mcp__a__y'])
  const world = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.equal(agent.restrictCalls.length, 1)
  // The host emits `tools/change` for the restriction itself. A naive engine
  // would now enumerate the masked (empty) view, see a change, clear and
  // re-restrict — forever.
  for (let round = 0; round < 3; round += 1) world.ctx.emit('tools/change')
  assert.equal(agent.restrictCalls.length, 1, 'the self-echo changed nothing')
  assert.equal(agent.lifts[0].disposed, false, 'and the live lift was not churned')
})

test('a tool registered under a hidden namespace after the mask is caught by the next pass', () => {
  const agent = fakeAgent('std', ['mcp__a__x'])
  const world = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  // The bridge reconnects and publishes a new tool that is NOT masked yet.
  agent.base.push('mcp__a__late')
  world.ctx.emit('tools/change')
  assert.deepEqual(agent.restrictCalls, [['mcp__a__x'], ['mcp__a__late', 'mcp__a__x']])
  assert.equal(agent.lifts[0].disposed, true, 'the old lift was released before the new one')
  assert.deepEqual(agent.visible(), [], 'the late tool is hidden now')
  // ...and the echo of that second restriction publishes nothing further.
  world.ctx.emit('tools/change')
  world.ctx.emit('tools/change')
  assert.equal(agent.restrictCalls.length, 2)
})

test('agent/created attaches and masks; agent/disposed releases', () => {
  const first = fakeAgent('first', ['mcp__a__x'])
  const world = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [first],
  })
  assert.equal(first.restrictCalls.length, 1, 'boot sweep attached the agent list')

  const second = fakeAgent('second', ['mcp__a__y'])
  world.agents.push(second)
  world.ctx.emit('agent/created', { agent: second })
  assert.deepEqual(second.restrictCalls, [['mcp__a__y']], 'the created agent is masked right away')

  world.ctx.emit('agent/disposed', { agent: second })
  assert.equal(second.lifts[0].disposed, true, 'dispose releases the mask')
  world.manager.reconcile()
  assert.equal(second.restrictCalls.length, 1, 'a forgotten agent is never re-masked')

  // A garbage payload cannot confuse the manager.
  world.ctx.emit('agent/created', { agent: null })
  world.ctx.emit('agent/created', { agent: { ctx: 42 } })
  world.ctx.emit('agent/disposed', { agent: 'not-an-agent' })
  world.manager.reconcile()
  assert.equal(first.restrictCalls.length, 1, 'and real agents keep working')
})

test('without the agentPresets service the whole feature is a no-op', () => {
  const agent = fakeAgent('std', ['mcp__a__x'])
  const world = fakeWorld({
    presets: undefined,
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.deepEqual(agent.restrictCalls, [])
  world.ctx.emit('tools/change')
  world.manager.reconcile()
  assert.deepEqual(agent.restrictCalls, [], 'nothing is masked and nothing is churned')
  assert.deepEqual(agent.visible(), ['mcp__a__x'], 'the scope stays untouched')
})

test('a half-service (no composedPreset) degrades the same way', () => {
  const agent = fakeAgent('std', ['mcp__a__x'])
  fakeWorld({
    presets: { compositionInventory: () => [{ id: 'p1', isDefault: true }] },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.deepEqual(agent.restrictCalls, [])
})

test('one agent blowing up does not stop the others, and the failure is logged once', () => {
  const broken = fakeAgent('broken', ['mcp__a__x'], { refuse: true })
  const healthy = fakeAgent('healthy', ['mcp__a__y'])
  const world = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [broken, healthy],
  })
  assert.deepEqual(healthy.restrictCalls, [['mcp__a__y']], 'the healthy agent still got masked')
  assert.deepEqual(broken.restrictCalls, [], 'the refusing host call was contained')
  assert.equal(world.warnings.filter((line) => line.includes('broken')).length, 1, 'warn once per distinct failure')

  // A repeated event with the same failure does not spam the log.
  world.ctx.emit('tools/change')
  world.ctx.emit('tools/change')
  assert.equal(world.warnings.filter((line) => line.includes('broken')).length, 1)

  // A different failure for the same agent is a new warning.
  broken.scopeError = true
  world.ctx.emit('tools/change')
  assert.ok(world.warnings.some((line) => line.includes('schemas boom')))
})

test('unreadable state skips the pass with a warning and leaves the masks alone', () => {
  const agent = fakeAgent('std', ['mcp__a__x'])
  const events = new Map()
  const warnings = []
  const childLogger = { info() {}, warn: (...args) => warnings.push(args.join(' ')), error() {}, debug() {} }
  const ctx = {
    logger: Object.assign(() => childLogger, childLogger),
    tools: { schemas: () => agent.visible().map((name) => ({ name })) },
    on(event, handler) {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => {}
    },
    emit(event, payload) {
      for (const handler of [...(events.get(event) ?? [])]) handler(payload)
    },
    effect() {},
    get: (name) => (name === 'agentPresets' ? { compositionInventory: () => [], composedPreset: () => 'p1' } : undefined),
  }
  let throwing = false
  const manager = createVisibilityManager(ctx, {
    listServers: () => {
      if (throwing) throw new Error('patch file unreadable')
      return SERVERS
    },
    policy: () => ({ 'srv-a': { p1: false } }),
  })
  manager.reconcile() // no agents attached: ctx.get('agents') was absent
  assert.deepEqual(agent.restrictCalls, [], 'boot found no agents to mask')
  manager.reconcile()
  assert.deepEqual(agent.restrictCalls, [])
  // Attach through the event, then break the state read.
  ctx.emit('agent/created', { agent })
  assert.equal(agent.restrictCalls.length, 1)
  throwing = true
  ctx.emit('tools/change')
  assert.ok(warnings.some((line) => line.includes('patch file unreadable')))
  assert.equal(agent.lifts[0].disposed, false, 'a skipped pass does not unmask anything')
  throwing = false
  manager.reconcile()
  assert.equal(agent.restrictCalls.length, 1, 'and the recovery publishes nothing new')
})

test('the function-shaped lift is released too', () => {
  const agent = fakeAgent('std', ['mcp__a__x'], { liftForm: 'function' })
  let preset = 'p1'
  const world = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => preset },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.equal(agent.restrictCalls.length, 1)
  preset = undefined
  world.refresh({})
  assert.equal(agent.lifts[0].disposed, true)
  assert.deepEqual(agent.visible(), ['mcp__a__x'])
})

test('the dispose effect releases every mask and stops the manager', () => {
  const one = fakeAgent('one', ['mcp__a__x'])
  const two = fakeAgent('two', ['mcp__a__y'])
  const world = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [one, two],
  })
  assert.equal(one.restrictCalls.length, 1)

  const dispose = world.disposers.at(-1)
  dispose()
  assert.equal(one.lifts[0].disposed, true, 'every held restriction is released')
  assert.equal(two.lifts[0].disposed, true)
  // A late event (or a late endpoint reconcile) must not re-mask anything.
  world.ctx.emit('tools/change')
  world.ctx.emit('agent/created', { agent: two })
  world.manager.reconcile()
  assert.equal(one.restrictCalls.length, 1)
  assert.equal(two.restrictCalls.length, 1, 'a late attach after dispose is ignored')
})

test('a scope without tools.restrict is skipped with one warning, not a crash', () => {
  const agent = { name: 'bare', base: ['mcp__a__x'], visible: () => ['mcp__a__x'], ctx: { tools: {} } }
  const world = fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p1: false } },
    agents: [agent],
  })
  assert.ok(world.warnings.some((line) => line.includes('no tools.restrict')))
  world.ctx.emit('tools/change')
  assert.equal(world.warnings.filter((line) => line.includes('no tools.restrict')).length, 1)
})

test('empty deny sets never reach the host', () => {
  // Every server visible: composedPreset names a preset, the matrix has no false cells.
  const agent = fakeAgent('std', ['mcp__a__x'])
  fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: SERVERS,
    policy: { 'srv-a': { p2: false } },
    agents: [agent],
  })
  assert.deepEqual(agent.restrictCalls, [])
  assert.equal(agent.lifts.length, 0, 'and no empty restriction was ever registered')
})

test('duplicate server names and blank rows fold into one clean deny set', () => {
  const agent = fakeAgent('std', ['mcp__a__x', 'mcp__a__y'])
  fakeWorld({
    presets: { compositionInventory: () => [], composedPreset: () => 'p1' },
    servers: [
      { id: 'srv-a', serverName: 'a' },
      { id: 'srv-again', serverName: 'a' },
      { id: 'srv-blank', serverName: '' },
    ],
    policy: { 'srv-a': { p1: false }, 'srv-again': { p1: false }, 'srv-blank': { p1: false } },
    agents: [agent],
  })
  assert.deepEqual(agent.restrictCalls, [['mcp__a__x', 'mcp__a__y']])
})
