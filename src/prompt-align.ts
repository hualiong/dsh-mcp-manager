/**
 * L2 prompt/execution-surface alignment (design §5 addendum: P1/P2/P3).
 *
 * A hidden server must look *absent*, not merely uncallable. The tool mask
 * in `./visibility.ts` covers the tool-schema surface, but the host assembles
 * each request from two independent inputs — prompt sections and tools — and
 * two bridge packages speak outside the `mcp__<serverName>__*` namespace:
 *
 *  - P1: `@deepseek-ai/dsh-mcp-client` (0.2.2-rc.1, server-context.js)
 *    registers an instructions section per connected server under
 *    `mcp:${serverName}` — stripped from the assembly of a scope whose preset
 *    hides that server.
 *  - P2: `@deepseek-ai/dsh-mcp-resources` (0.2.2-rc.1) registers
 *    `mcp-resource-servers`, a section embedding a JSON array of visible
 *    server names — filtered when only some are hidden, dropped when all are,
 *    and left alone when its text no longer matches the template (contract
 *    drift fails open: a stale mention is repairable by the mask itself, a
 *    wrecked prompt is not).
 *  - P3: the same package's three meta tools
 *    (`list_mcp_resources` / `list_mcp_resource_templates` /
 *    `read_mcp_resource`) take a bare `server` argument and read through the
 *    scoped provider registry, which ignores tool masks — the
 *    `tools/pre-execute` waterfall denies a hidden `server` outright. The
 *    payload field is `exec.arguments` (`ToolExecutionInput.arguments`,
 *    `@deepseek-ai/dsh-tools` 0.2.2-rc.1 types: parsed arguments, validated
 *    by the tool's own schema); `exec.args` does not exist on this surface.
 *
 * Discipline copied from dsh-ops `official-tool-hiding.ts`: assembly objects
 * are shared across scopes, so every rewrite COPIES the array and the touched
 * section objects and returns a new assembly (the host renders the waterfall's
 * return value); nothing here mutates the input; a per-agent or per-request
 * host failure warns once and passes the untouched surface through.
 *
 * @module dsh-mcp-manager/prompt-align
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the pre-dispatch decision this plugin's guard returns.
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { isRecord, type McpServerInfo } from './shared.ts'
import type { McpPresetPolicy } from './policy.ts'
import {
  hiddenServerNames,
  readAgentPresets,
  type AgentPresetsService,
} from './visibility.ts'

/** Section names owned by `@deepseek-ai/dsh-mcp-client` instructions rows: `mcp:${serverName}`. */
const MCP_SECTION_PREFIX = 'mcp:'

/** Section name of `@deepseek-ai/dsh-mcp-resources`'s server-name list (0.2.2-rc.1). */
const RESOURCE_SECTION = 'mcp-resource-servers'

/** The exact template head that section's text carries, before the JSON array (0.2.2-rc.1). */
const RESOURCE_TEXT_HEADER =
  '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: '

/** The three bare-named meta tools that read through the scoped provider registry. */
const RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
])

/** The shared no-hidden verdict: allocating per request would be pure churn. */
const NOTHING_HIDDEN: ReadonlySet<string> = new Set<string>()

/** The waterfall payload as this module reads it — only `sections` is touched, and never in place. */
interface PromptSection {
  name?: unknown
  text?: unknown
  [key: string]: unknown
}

interface PromptAssembly {
  sections?: unknown
  [key: string]: unknown
}

/**
 * The assemble context. `context.scope` is the AGENT itself: the loop calls
 * `systemPrompt.assemble(assembleContextFor(agent))`, and
 * `function assembleContextFor(agent, signal) { return { agent, scope: agent, ... } }`
 * (@deepseek-ai/dsh-agent-loop 0.2.2-rc.1, asar-verified) — NOT the agent's
 * Context. {@link createPromptAlignment} unwraps the identity before asking
 * `composedPreset`, which reads the scope tag of the scoped Context.
 */
interface PromptContext {
  scope?: unknown
  [key: string]: unknown
}

/** The pre-execute payload as far as this module reads it (`ToolExecutionInput`: name, arguments, agent). */
interface ToolExecutionView {
  name?: unknown
  arguments?: unknown
  agent?: { ctx?: unknown }
}

/** Fresh state reads, shaped exactly like `VisibilityOptions`, plus the roster handle. */
export interface PromptAlignmentOptions {
  /** Current server rows (only `id` and `serverName` are read). */
  listServers(): readonly McpServerInfo[]
  /** The exception matrix. */
  policy(): McpPresetPolicy
  /** The preset service; defaults to `readAgentPresets(ctx)`. */
  presets?(): AgentPresetsService | undefined
}

/**
 * Rewrite one section against the hidden set.
 * @returns the original section (keep), a new object (rewritten text), or
 * `undefined` (drop). "No change" is always the original reference.
 */
function alignSection(section: PromptSection, hidden: ReadonlySet<string>): PromptSection | undefined {
  if (typeof section?.name !== 'string') return section
  if (section.name.startsWith(MCP_SECTION_PREFIX)) {
    return hidden.has(section.name.slice(MCP_SECTION_PREFIX.length)) ? undefined : section
  }
  if (section.name !== RESOURCE_SECTION) return section
  const text = rewriteResourceText(section.text, hidden)
  if (text === section.text) return section
  if (text === undefined) return undefined
  return { ...section, text }
}

/**
 * Filter the server-name array embedded in the `mcp-resource-servers` text.
 * Anything that does not match the 0.2.2-rc.1 template shape returns the
 * original text (fail open); `undefined` means the section must drop because
 * nothing visible is left.
 */
function rewriteResourceText(text: unknown, hidden: ReadonlySet<string>): string | undefined {
  if (typeof text !== 'string' || !text.startsWith(RESOURCE_TEXT_HEADER) || !text.endsWith('.')) {
    return text as string
  }
  let names: unknown
  try {
    names = JSON.parse(text.slice(RESOURCE_TEXT_HEADER.length, -1))
  } catch {
    return text
  }
  if (!Array.isArray(names) || !names.every((entry) => typeof entry === 'string')) return text
  const visible = (names as string[]).filter((serverName) => !hidden.has(serverName))
  if (visible.length === names.length) return text
  if (visible.length === 0) return undefined
  return `${RESOURCE_TEXT_HEADER}${JSON.stringify(visible)}.`
}

/** The parsed `server` argument of a resource meta tool, or undefined when it is not one. */
function serverArgument(exec: ToolExecutionView): string | undefined {
  const args = exec?.arguments
  if (!isRecord(args)) return undefined
  const server = args['server']
  return typeof server === 'string' && server !== '' ? server : undefined
}

/**
 * Mount the alignment hooks: the `system-prompt/assemble` waterfall listener
 * (P1 + P2) and the `tools/pre-execute` guard (P3), with a teardown effect
 * that unsubscribes both. There is nothing to reconcile — every pass reads
 * fresh state, so a matrix write is visible on the next request without any
 * event wiring.
 * @param ctx - plugin context.
 * @param options - injectable state reads (tests run without a real host).
 */
export function createPromptAlignment(ctx: Context, options: PromptAlignmentOptions): void {
  const logger = ctx.logger('mcp-manager')
  const presets = () => (options.presets ? options.presets() : readAgentPresets(ctx))
  let stopped = false
  let lastWarned = ''

  /** Warn once per distinct message: these paths run per request and per call. */
  const warn = (message: string): void => {
    if (lastWarned === message) return
    lastWarned = message
    logger.warn('mcp-manager: %s', message)
  }

  /**
   * The hidden serverNames for one dispatched identity, or undefined when
   * nothing can be decided (service absent, scope-less call, unreadable
   * preset or state): every caller then passes the surface through untouched —
   * fail open. Both waterfalls hand the AGENT over (`context.scope` from
   * `assembleContextFor`, `exec.agent` from the tool scheduler), while
   * `agentPresets.composedPreset` reads `ctx[kScope]` through `generationFor`
   * — the scope tag lives on the Agent's scoped Context, exactly the
   * `agent.ctx` identity `visibility.ts` masks against (asar-verified on
   * 0.2.2-rc.1: an Agent passed un-unwrapped reads `undefined` and silently
   * disables P1/P2 on the live host, which is why the unwrap is here). An
   * identity without a Context is passed through: `composedPreset` then finds
   * no bound preset and nothing is hidden — fail open.
   */
  const hiddenForScope = (identity: unknown): ReadonlySet<string> | undefined => {
    if (stopped || typeof identity !== 'object' || identity === null) return undefined
    const svc = presets()
    if (svc === undefined) return undefined
    const scoped = (identity as { ctx?: unknown }).ctx ?? identity
    let presetId: string | undefined
    try {
      presetId = svc.composedPreset(scoped)
    } catch (error) {
      warn(`prompt alignment skipped, preset identity unreadable: ${String(error)}`)
      return undefined
    }
    if (typeof presetId !== 'string' || presetId === '') return undefined
    // Cheap reads first: the sidecar JSON alone settles most requests. Only a
    // `false` cell in THIS preset's column can hide anything, and finding one
    // needs no server enumeration — so `listServers()` (patch file + loader
    // walk + per-server schema scan) stays untouched for every mask-free
    // preset, which is the common deployment.
    // CAUTION (review keep): this `=== false` sentinel is the second decision
    // site of what "hidden" means — the authority is `hiddenServerNames` in
    // ./visibility.ts. Any change to the predicate (sentinel shape, row
    // handling) must land on BOTH sites together or the mask and the
    // prompt/execution surfaces diverge.
    let policy: McpPresetPolicy
    try {
      policy = options.policy()
    } catch (error) {
      warn(`prompt alignment skipped, state unreadable: ${String(error)}`)
      return undefined
    }
    let touched = false
    for (const row of Object.values(policy)) {
      if (row[presetId] === false) {
        touched = true
        break
      }
    }
    if (!touched) return NOTHING_HIDDEN
    try {
      return new Set(hiddenServerNames(presetId, options.listServers(), policy))
    } catch (error) {
      warn(`prompt alignment skipped, state unreadable: ${String(error)}`)
      return undefined
    }
  }

  /**
   * P1+P2: rewrite the sections of the assembled surface. Runs as the outer
   * host pass-through does — `next()` first, transform its result — so the
   * host's own completion/required-context shaping is never bypassed; only
   * `sections` is replaced, and only when something actually hits.
   */
  const assemble = async (
    assembly: PromptAssembly,
    context: PromptContext,
    next: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly> => {
    const result = await next()
    const hidden = hiddenForScope(context?.scope)
    if (hidden === undefined || hidden.size === 0) return result
    if (!Array.isArray(result?.sections)) return result
    let rewritten = false
    const sections: PromptSection[] = []
    for (const section of result.sections as PromptSection[]) {
      const aligned = alignSection(section, hidden)
      if (aligned === undefined) {
        rewritten = true
        continue
      }
      if (aligned !== section) rewritten = true
      sections.push(aligned)
    }
    if (!rewritten) return result
    return { ...result, sections }
  }

  /**
   * P3: deny a resource meta tool whose bare `server` argument names a
   * hidden server. The provider registry resolves by scope, not by tool
   * mask, so without this guard a hidden server's resources stay readable.
   */
  const preExecute = async (
    exec: ToolExecutionView,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> => {
    if (stopped || typeof exec?.name !== 'string' || !RESOURCE_TOOLS.has(exec.name)) return next()
    const server = serverArgument(exec)
    if (server === undefined) return next()
    // The Agent itself: hiddenForScope unwraps to the scoped Context.
    const hidden = hiddenForScope(exec.agent)
    if (hidden === undefined || !hidden.has(server)) return next()
    return {
      kind: 'deny',
      reason: `MCP server "${server}" is hidden for this agent's preset (dsh-mcp-manager visibility matrix).`,
      info: { name: 'McpVisibility', code: 'server-hidden-for-preset' },
    }
  }

  // The `Events` merges declaring `system-prompt/assemble` (dsh-system-prompt)
  // and the scoped `tools/pre-execute` (dsh-scope) do not ship in this
  // plugin's dependencies; the runtime contract is the cordis string overload,
  // stated with local casts (the `WebServerService` pattern).
  const on = (ctx.on as unknown as (
    name: string,
    listener: (...args: any[]) => any,
  ) => unknown)
  const offs = [
    on('system-prompt/assemble', assemble),
    on('tools/pre-execute', preExecute),
  ]

  ctx.effect(() => () => {
    stopped = true
    for (const off of offs) {
      if (typeof off !== 'function') continue
      try {
        (off as () => void)()
      } catch {
        // Listener bookkeeping gone with the host scope: nothing left to release.
      }
    }
  }, 'mcp-manager: prompt alignment')
}
