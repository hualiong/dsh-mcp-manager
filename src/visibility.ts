/**
 * L2 visibility engine: per-agent MCP tool masks.
 *
 * The policy matrix (see `./policy.ts`) says which preset may not see which
 * server. The host mechanism that enforces it is the per-agent restriction:
 * `agent.ctx.tools.restrict({ deny })` hides those tool names from that
 * agent alone — presentation, lookup and execution stay aligned, while the
 * connection itself remains owned by the global bridge row. Design:
 * `docs/per-agent-mcp-switch-design.md` §5, host facts: §11.
 *
 * The engine observes agents (`agent/created` / `agent/disposed` events plus
 * a boot sweep of `agents.list()`), enumerates each scope's own tool surface
 * (`tools.schemas(agent)`), and expands the `mcp__<serverName>__` prefixes of
 * the servers hidden for the preset the agent composes. A mask is republished
 * only when the set it would deny actually changed: `restrict()` itself emits
 * `tools/change`, and an unguarded re-restrict would feed that event back
 * into another restriction (the publication/withdrawal loop dsh-ops learned
 * to guard against with snapshot comparison).
 *
 * Failure containment: a throwing host call for one agent is a `logger.warn`
 * for that agent, never a broken reconcile for the others, and `restrict()`
 * demands currently known names — so every fresh mask is enumerated from the
 * scope's clean (unmask-first) view, never replayed from stale memory.
 *
 * @module dsh-mcp-manager/visibility
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the `Context { tools }` declaration merge into the program
// (the runtime never imports the package — services are read via `ctx.get`).
import type {} from '@deepseek-ai/dsh-tools'
import type { McpPresetPolicy } from './policy.ts'
import type { McpServerInfo } from './shared.ts'

/**
 * One roster row as `compositionInventory()` publishes it, before projection
 * onto the wire type. Fields are `unknown` on purpose: the service belongs to
 * another package, and this plugin trusts nothing it does not re-check.
 */
export interface PresetRosterRow {
  /** Preset identity (`config.id`), the matrix column key. */
  id?: unknown
  /** Published display name. */
  name?: unknown
  /** Published display description. */
  description?: unknown
  /** Whether sessions naming no preset compose this one. */
  isDefault?: unknown
  /** Diagnostic carried by a broken declaration. */
  broken?: unknown
  [key: string]: unknown
}

/** Structural mirror of the optional `agentPresets` service surface (the `WebServerService` trick). */
export interface AgentPresetsService {
  /**
   * Every declared preset, in roster order. The live service returns a
   * Promise; consumers `await` this and tolerate a synchronous fake too.
   */
  compositionInventory(): readonly PresetRosterRow[] | Promise<readonly PresetRosterRow[]>
  /** The preset id one agent scope composes, or `undefined` when it composes none. */
  composedPreset(scope: unknown): string | undefined
}

/**
 * The `agentPresets` service when it is installed and usable, else
 * `undefined` — the whole feature degrades away without it.
 * @param ctx - plugin context.
 * @returns the service handle, or undefined.
 */
export function readAgentPresets(ctx: Context): AgentPresetsService | undefined {
  const svc = ctx.get('agentPresets') as Partial<AgentPresetsService> | undefined
  if (svc === undefined || svc === null) return undefined
  if (typeof svc.compositionInventory !== 'function' || typeof svc.composedPreset !== 'function') {
    return undefined
  }
  return svc as AgentPresetsService
}

/** What `restrict()` hands back for release: a disposer function or a `{ dispose() }` object — the host's dual shape, both accepted. */
type RestrictionLift = (() => void) | { dispose(): void }

/** The one member an agent scope is asked for, typed locally like {@link AgentPresetsService}. */
interface AgentScope {
  tools?: {
    restrict?(filter: { deny: readonly string[] }): RestrictionLift | undefined
  }
}

/** `ctx.tools` seen through this plugin's use: the scope argument is the agent identity, whose typed `ScopeKey` shape belongs to the host packages. */
interface ScopedToolsView {
  schemas(scope?: unknown): readonly { name: string }[]
}

/** The optional `agents` service, read at boot only. */
interface AgentsServiceView {
  list?(): Iterable<unknown>
}

/** State the manager reconciles against, read fresh on every pass. */
export interface VisibilityOptions {
  /** Current server rows — only `id` and `serverName` matter for a mask. */
  listServers(): readonly McpServerInfo[]
  /** The current exception matrix. */
  policy(): McpPresetPolicy
}

/** Handle the RPC endpoints use to re-align masks right after a matrix write. */
export interface VisibilityHandle {
  /** Idempotent: republish nothing unless some agent's deny set actually changed. */
  reconcile(): void
}

/** One observed agent: its scoped ctx, the lifts held against it, and the row the last mask came from. */
interface ObservedAgent {
  ctx: AgentScope
  lifts: RestrictionLift[]
  /** Serialized sorted hidden-serverName list the current mask was computed from (`''` = never computed). */
  rowJson: string
  /** False until the row was computed and published (or proven mask-free) against the live host. */
  applied: boolean
  /** Last warning reported for this agent, so repeats of the same failure do not spam the log. */
  reported?: string
}

/**
 * Server names the matrix hides from one preset, deduplicated and sorted —
 * the single hidden-resolution reading in this plugin (the mask engine and
 * the prompt-alignment hooks must never diverge on what "hidden" means).
 * `presetId` undefined (no composed preset, or no roster service at all) is
 * the empty set: nothing is hidden, everything is inherited.
 * @param presetId - the preset one scope composes, or undefined.
 * @param servers - current server rows (only `id` and `serverName` read).
 * @param policy - the exception matrix.
 * @returns the hidden serverNames, sorted.
 */
export function hiddenServerNames(
  presetId: string | undefined,
  servers: readonly McpServerInfo[],
  policy: McpPresetPolicy,
): string[] {
  if (presetId === undefined) return []
  const names = new Set<string>()
  for (const server of servers) {
    if (server.serverName === '') continue
    if (policy[server.id]?.[presetId] === false) names.add(server.serverName)
  }
  return [...names].sort()
}

/**
 * Create the visibility manager: subscribe to the agent and tool events that
 * change what an agent may see, sweep the agents that already exist, and run
 * the first reconcile. The teardown effect releases every held mask and stops
 * the manager.
 * @param ctx - plugin context (`tools` must be injected).
 * @param options - injectable state reads, so tests need no real host.
 * @returns the reconcile handle.
 */
export function createVisibilityManager(ctx: Context, options: VisibilityOptions): VisibilityHandle {
  const logger = ctx.logger('mcp-manager')
  const entries = new Map<object, ObservedAgent>()
  const unsubscribers: Array<() => void> = []
  let stopped = false
  let mutating = false

  /** Release one lift; false when the host disposer threw (the lift is kept for a retry). */
  const release = (lift: RestrictionLift): boolean => {
    try {
      if (typeof lift === 'function') lift()
      else lift.dispose()
      return true
    } catch (error) {
      logger.warn('mcp-manager: visibility mask cleanup failed: %s', String(error))
      return false
    }
  }

  const clear = (entry: ObservedAgent): void => {
    const pending = entry.lifts.splice(0)
    const failed: RestrictionLift[] = []
    for (const lift of pending) {
      if (!release(lift)) failed.push(lift)
    }
    entry.lifts.push(...failed)
  }

  /** The tool names one scope currently sees, including anything an active mask already removed from sight. */
  const scopedNames = (agent: object): string[] => {
    const tools = ctx.tools as unknown as ScopedToolsView
    return tools.schemas(agent).map((schema) => schema.name)
  }

  /** Expand the hidden servers' namespaces over a name list — the deny set proper. */
  const expand = (hidden: readonly string[], names: readonly string[]): string[] => {
    if (hidden.length === 0) return []
    const prefixes = hidden.map((serverName) => `mcp__${serverName}__`)
    return names.filter((name) => prefixes.some((prefix) => name.startsWith(prefix))).sort()
  }

  /** Warn once per distinct failure message per agent (dsh-ops' reported-guard). */
  const report = (entry: ObservedAgent, message: string): void => {
    if (entry.reported === message) return
    entry.reported = message
    logger.warn('mcp-manager: %s', message)
  }

  /**
   * Republish this agent's mask from the scope's clean view: lift whatever is
   * held first, enumerate what the scope really has now, then restrict. The
   * host rejects unknown names, so a mask is never replayed from memory.
   */
  const publish = (agent: object, entry: ObservedAgent, hidden: readonly string[]): void => {
    clear(entry)
    const deny = expand(hidden, scopedNames(agent))
    if (deny.length === 0) {
      entry.applied = true
      entry.reported = undefined
      return
    }
    const restrict = entry.ctx.tools?.restrict
    if (typeof restrict !== 'function') {
      entry.applied = false
      report(entry, `cannot mask ${hidden.join(', ')}: this agent scope exposes no tools.restrict()`)
      return
    }
    try {
      const lift = restrict.call(entry.ctx.tools!, { deny })
      entry.applied = true
      entry.reported = undefined
      if (lift === undefined) {
        report(entry, 'tools.restrict() returned no disposer; this mask can only be lifted by the scope teardown')
      } else {
        entry.lifts.push(lift)
      }
    } catch (error) {
      // Keep `applied` false: the next event (or matrix write) retries from a clean view.
      entry.applied = false
      report(entry, `visibility mask failed: ${String(error)}`)
    }
  }

  /** Reconcile one observed agent against the current roster/policy snapshot. */
  const align = (
    agent: object,
    entry: ObservedAgent,
    presetId: string | undefined,
    servers: readonly McpServerInfo[],
    policy: McpPresetPolicy,
  ): void => {
    const hidden = hiddenServerNames(presetId, servers, policy)
    const rowJson = JSON.stringify(hidden)
    if (rowJson !== entry.rowJson || !entry.applied) {
      entry.rowJson = rowJson
      publish(agent, entry, hidden)
      return
    }
    if (hidden.length === 0) return
    // The row is already published: only a tool the bridge registered after
    // the mask can make this pass different, and it is visible right now —
    // under the active mask everything older stays out of sight.
    if (expand(hidden, scopedNames(agent)).length === 0) return
    publish(agent, entry, hidden)
  }

  /**
   * Re-align every observed agent. Idempotent by snapshot comparison, guarded
   * against re-entry from the events its own restrictions emit.
   */
  const reconcile = (): void => {
    if (stopped || mutating || entries.size === 0) return
    mutating = true
    try {
      const svc = readAgentPresets(ctx)
      let servers: readonly McpServerInfo[]
      let policy: McpPresetPolicy
      try {
        servers = options.listServers()
        policy = options.policy()
      } catch (error) {
        logger.warn('mcp-manager: visibility reconcile skipped, state unreadable: %s', String(error))
        return
      }
      for (const [agent, entry] of entries) {
        let presetId: string | undefined
        try {
          presetId = svc?.composedPreset(entry.ctx)
        } catch (error) {
          report(entry, `preset identity unreadable: ${String(error)}`)
          continue
        }
        try {
          align(agent, entry, presetId, servers, policy)
        } catch (error) {
          report(entry, `visibility reconcile failed: ${String(error)}`)
        }
      }
    } finally {
      mutating = false
    }
  }

  /** Register one observed agent; scopes without a context are not maskable and are skipped. */
  const attach = (agent: unknown): void => {
    if (stopped || typeof agent !== 'object' || agent === null || entries.has(agent)) return
    const scope = (agent as { ctx?: unknown }).ctx
    if (typeof scope !== 'object' || scope === null) return
    entries.set(agent, { ctx: scope as AgentScope, lifts: [], rowJson: '', applied: false })
  }

  /** Forget one agent and release whatever mask it held (its scope is gone; releasing keeps the bookkeeping honest). */
  const detach = (agent: unknown): void => {
    if (typeof agent !== 'object' || agent === null) return
    const entry = entries.get(agent)
    if (entry === undefined) return
    entries.delete(agent)
    const wasMutating = mutating
    mutating = true
    try {
      clear(entry)
    } finally {
      mutating = wasMutating
    }
  }

  const subscribe = (event: string, handler: (payload: { agent?: unknown }) => unknown): void => {
    // `agent/created` / `agent/disposed` / `tools/change` are declared by the
    // host packages' `Events` merge, which no dependency of this plugin ships.
    // The runtime contract is the plain cordis string overload; the cast says
    // exactly that (the `WebServerService` trick again).
    const on = ctx.on as unknown as (
      name: string,
      listener: (payload: { agent?: unknown }) => unknown,
    ) => unknown
    const off = on(event, handler)
    if (typeof off === 'function') unsubscribers.push(off as () => void)
  }

  subscribe('agent/created', ({ agent }) => {
    attach(agent)
    reconcile()
  })
  subscribe('agent/disposed', ({ agent }) => {
    detach(agent)
  })
  // Tool registry churn (bridges connecting, restrictions landing) is the
  // one event that covers preset switches and recompositions too.
  subscribe('tools/change', () => {
    reconcile()
  })

  ctx.effect(() => () => {
    // Fiber dispose: nothing may re-mask after this, and every held
    // restriction must not outlive the fiber that registered it.
    stopped = true
    mutating = true
    for (const entry of entries.values()) clear(entry)
    entries.clear()
    for (const off of unsubscribers.splice(0)) {
      try {
        off()
      } catch {
        // Listener bookkeeping gone with the host scope: nothing left to release.
      }
    }
  }, 'mcp-manager: preset visibility')

  try {
    const agents = ctx.get('agents') as AgentsServiceView | undefined
    for (const agent of agents?.list?.() ?? []) attach(agent)
  } catch (error) {
    logger.warn('mcp-manager: could not enumerate live agents at boot: %s', String(error))
  }
  reconcile()

  return { reconcile }
}
