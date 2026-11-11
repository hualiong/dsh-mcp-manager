/**
 * dsh-mcp-manager — node half.
 *
 * A visual MCP manager for the DeepSeek Harness web GUI:
 *
 *  - enumerates every live MCP bridge instance (which MCP servers are
 *    installed, which package owns the row, enabled state, and their current
 *    lifecycle/connection status, including how many `mcp__<serverName>__*`
 *    tools are registered);
 *  - adds / removes / enables / disables / edits MCP servers by editing the
 *    web profile's `cordis.patch.yml` (the harness HMR watcher hot-reloads
 *    the tree, so changes apply live without a restart);
 *  - hides a server from the agent presets that opt it out of the visibility
 *    matrix, per agent scope, through `agent.ctx.tools.restrict()` (see
 *    `./visibility.ts`; the matrix itself lives in the JSON sidecar managed
 *    by `./policy.ts`, never in the patch file).
 *
 * The browser half talks to this host half over a loopback-only HTTP route
 * (`POST /mcp-manager/<endpoint>`, body `{"payload":…}`, reply
 * `{"ok":true,"value":…}` / `{"ok":false,"error":…}`). The route is mounted on
 * the harness HTTP carrier (`ctx.webServer`) instead of a Connection RPC
 * channel, and reuses Connection's Host/Origin + browser-auth fence
 * (`ctx.connection.requestRejection`) so only the local browser can reach it.
 *
 * Config (row config in cordis.patch.yml; all optional):
 *   patchFile   absolute path of the user patch layer to edit
 *               (default: $DSH_HOME/profiles/web/cordis.patch.yml)
 * @module dsh-mcp-manager
 */
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the `Context { connection }` declaration merge into the program.
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  EVENT_CHANGED,
  EVENT_CHANNEL,
  EVENT_READY,
  MCP_CLIENT_PACKAGE,
  MCP_OAUTH_CLIENT_PACKAGE,
  RPC_CHANNEL,
  isRecord,
  type McpEndpoint,
  type McpOAuthProbe,
  type McpPresetInfo,
  type McpServerConfig,
  type McpServerInfo,
} from './shared.ts'
import { detectOAuth, type OAuthProbe } from './detect.ts'
import {
  addMcpRow,
  editPatchList,
  readMcpPatchRows,
  readPatchList,
  removeMcpRow,
  resolvePatchPath,
  setMcpEnabled,
  updateMcpConfig,
} from './patch.ts'
import { entryIdTaken, findMcpServer, listMcpServers, serverNameTaken } from './status.ts'
import { hasAuthorizationHeader, validateMcpConfig } from './validate.ts'
import { dropServerFromPolicy, loadPolicy, policyPathOf, setPresetVisible, type McpPresetPolicy } from './policy.ts'
import { createPromptAlignment } from './prompt-align.ts'
import {
  createVisibilityManager,
  readAgentPresets,
  type PresetRosterRow,
  type VisibilityHandle,
} from './visibility.ts'

/** Stable plugin id for loader rows. */
export const name = 'mcp-manager'

/** Required services: RPC fence, loader tree, tools, HTTP carrier. Deliberately NOT `systemPrompt`:
 * the prompt/execution hooks are plain event listeners, and untagged root listeners receive every
 * scope's events whether or not the emitting service is injected (dsh-scope's dispatch filter admits
 * them globally) — requiring it here would deny the whole panel on a distro without prompt assembly,
 * against this plugin's degrade-everywhere philosophy. */
export const inject = ['connection', 'loader', 'tools', 'webServer']

/** Raw row config — every field defaults in code. */
export interface McpManagerRowConfig {
  patchFile?: string
}

/**
 * Structural mirror of the `@deepseek-ai/dsh-host-webserver` surface used here.
 * The package is part of the harness, not a dependency of this plugin, so the
 * two members the host half needs are declared locally.
 */
interface WebRoute {
  /** `exact` matches the pathname verbatim; `prefix` matches it and its children. */
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle. */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface WebServerService {
  /** Register a named route; returns the disposer removing it. */
  register(route: WebRoute): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser HTTP carrier, provided by `@deepseek-ai/dsh-host-webserver`. */
    webServer: WebServerService
  }
}

/** RPC envelope (shape of `RpcResult` from dsh-host-apiproxy). */
type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail(code: string, message: string, details: Record<string, unknown> = {}): RpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

/** Malformed envelope or payload — the caller sent something we cannot read. */
function badRequest(): RpcResult<never> {
  return fail('bad-request', 'Malformed payload for this endpoint')
}

/** Path segments accepted as an endpoint name. */
const ENDPOINT_SEGMENT_RE = /^[A-Za-z0-9_$.-]+$/

/** Response headers of the event stream. */
const EVENT_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  'connection': 'keep-alive',
} as const

/**
 * How often an open stream is examined for a state change. The tick exists only
 * while at least one stream is open (see {@link createChangeChannel}).
 */
const TICK_MS = 1000
/** Every n-th tick writes a comment so an idle stream is not reaped (~20s). */
const PING_TICKS = 20
/** Keep-alive comment; SSE ignores it, proxies and idle timeouts do not. */
const PING_FRAME = ': ping\n\n'

/** One SSE frame carrying a single event type. */
function frame(type: string): string {
  return `data: ${JSON.stringify({ type })}\n\n`
}

/** The panel's change channel: every open event stream plus its one timer. */
interface ChangeChannel {
  /** Hold one response open as an event stream and start the tick on demand. */
  open(res: ServerResponse): void
  /** Tell every open stream to re-read; never throws into the caller. */
  broadcast(): void
  /** End every stream and stop the timer (fiber dispose). */
  close(): void
}

/**
 * Create the panel's server-sent-events channel.
 *
 * Frames carry no state — they are nudges to re-read `list` — so a frame lost
 * between reads costs latency, never correctness, and the `ready` frame a
 * reconnecting client receives closes the window it slept through.
 *
 * The tick timer is created on the first subscriber and cleared with the last:
 * with no stream open there is no timer at all, so an unopened panel costs
 * nothing, and a disposed fiber leaves nothing scheduled.
 * @param ctx - plugin context (the loader and tool registry the tick reads).
 * @param patchFile - user patch layer the tick re-reads.
 * @returns the channel handle owned by the plugin fiber.
 */
export function createChangeChannel(ctx: Context, patchFile: string): ChangeChannel {
  const streams = new Set<ServerResponse>()
  let timer: ReturnType<typeof setInterval> | undefined
  let ticks = 0
  let signature: string | undefined

  const stop = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  /** Write one frame to every live stream; never throws. */
  const write = (payload: string): void => {
    for (const stream of [...streams]) {
      if (stream.destroyed || stream.writableEnded) {
        streams.delete(stream)
        continue
      }
      try {
        stream.write(payload)
      } catch {
        // A socket that died between the check and the write: drop it rather
        // than let a response teardown surface in a request handler.
        streams.delete(stream)
      }
    }
    if (streams.size === 0) stop()
  }

  /** The reported state as one string; undefined when it cannot be read. */
  const readSignature = (): string | undefined => {
    try {
      return JSON.stringify(listMcpServers(ctx, readMcpPatchRows(readPatchList(patchFile))))
    } catch {
      // A malformed patch file is a read failure, not a change: report nothing
      // and keep the previous signature so the next tick retries.
      return undefined
    }
  }

  const tick = (): void => {
    try {
      ticks += 1
      if (ticks % PING_TICKS === 0) write(PING_FRAME)
      const next = readSignature()
      if (next !== undefined && next !== signature) {
        signature = next
        write(frame(EVENT_CHANGED))
      }
    } catch (error) {
      // Runs on a timer: an escaping error would be an uncaught exception.
      ctx.logger.warn('mcp-manager: event stream tick failed: %s', String(error))
    }
  }

  const open = (res: ServerResponse): void => {
    res.writeHead(200, EVENT_HEADERS)
    try {
      res.write(frame(EVENT_READY))
    } catch {
      res.end()
      return
    }
    streams.add(res)
    res.on('close', () => {
      streams.delete(res)
      if (streams.size === 0) stop()
    })
    // Baseline the comparison at the first subscriber: the client reads the
    // list as it connects, so the state it just saw must not be re-announced.
    if (streams.size === 1) signature = readSignature()
    if (timer === undefined) timer = setInterval(tick, TICK_MS)
  }

  const close = (): void => {
    stop()
    const held = [...streams]
    streams.clear()
    for (const stream of held) {
      try {
        stream.end()
      } catch {
        // Disposal continues regardless: every stream must be released.
      }
    }
  }

  return { open, broadcast: () => write(frame(EVENT_CHANGED)), close }
}

/**
 * Plugin body: mount the panel's HTTP route and dispatch MCP management
 * commands.
 * @param ctx - plugin context.
 * @param rawConfig - raw row config (optional).
 */
export function apply(ctx: Context, rawConfig?: McpManagerRowConfig): void {
  const patchFile = resolvePatchPath(rawConfig?.patchFile)
  const logger = ctx.logger('mcp-manager')

  // L2 masks: the manager registers its own dispose effect, observes agent
  // and tool events, and runs the first reconcile right here.
  const listServers = () => listMcpServers(ctx, readMcpPatchRows(readPatchList(patchFile)))
  const visibility = createVisibilityManager(ctx, {
    listServers,
    policy: () => loadPolicy(policyPathOf(patchFile)),
  })

  // L2 prompt/execution alignment: strips hidden servers' instruction and
  // resource-name sections and denies the bare `server` resource calls. The
  // hooks read fresh state per request/call, so no events or handle needed.
  createPromptAlignment(ctx, {
    listServers,
    policy: () => loadPolicy(policyPathOf(patchFile)),
  })

  ctx.effect(() => {
    const channel = createChangeChannel(ctx, patchFile)
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: (req, res) => handleRequest(ctx, patchFile, channel, req, res, detectOAuth, visibility),
    })
    return () => {
      // Fiber dispose must release every held-open response, not just stop
      // serving new ones.
      channel.close()
      disposeRoute()
    }
  }, 'mcp-manager: http route')

  logger.info('mcp-manager active (patch file: %s)', patchFile)
}

/**
 * Serve one request: apply Connection's Host/Origin + browser-auth fence, then
 * either hold `GET /mcp-manager/events` open as an event stream or dispatch
 * `POST /mcp-manager/<endpoint>`.
 * @param ctx - plugin context.
 * @param patchFile - user patch layer to read and edit.
 * @param channel - change channel the request may subscribe to.
 * @param req - incoming HTTP request.
 * @param res - response owned for this request.
 * @param probe - OAuth probe used to pick a new row's bridge (injectable for tests).
 * @param visibility - L2 mask manager, when the plugin fiber mounted one.
 */
export async function handleRequest(
  ctx: Context,
  patchFile: string,
  channel: ChangeChannel,
  req: IncomingMessage,
  res: ServerResponse,
  probe: OAuthProbe = detectOAuth,
  visibility?: VisibilityHandle,
): Promise<void> {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }

  const pathname = pathnameOf(req.url)
  if (req.method === 'GET' && pathname === EVENT_CHANNEL) {
    channel.open(res)
    return
  }

  const endpoint = req.method === 'POST' ? endpointOf(pathname) : undefined
  if (endpoint === undefined) {
    res.writeHead(404)
    res.end()
    return
  }

  let payload: unknown
  try {
    payload = parseEnvelope(await readBody(req))
  } catch {
    res.writeHead(400)
    res.end()
    return
  }

  let result: RpcResult<unknown>
  try {
    result = await dispatch(ctx, patchFile, channel, endpoint as McpEndpoint, payload, probe, visibility)
  } catch (error) {
    // Endpoint failures are data, not transport failures: report them in the
    // envelope so the panel can render them.
    result = fail('internal', error instanceof Error ? error.message : String(error))
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result))
}

/** Pathname of one request URL, or undefined when it cannot be parsed. */
function pathnameOf(rawUrl: string | undefined): string | undefined {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').pathname
  } catch {
    return undefined
  }
}

/** Resolve the endpoint segment of `/mcp-manager/<segment>`, or undefined. */
function endpointOf(pathname: string | undefined): string | undefined {
  if (pathname === undefined || !pathname.startsWith(`${RPC_CHANNEL}/`)) return undefined
  const segment = pathname.slice(RPC_CHANNEL.length + 1)
  return ENDPOINT_SEGMENT_RE.test(segment) ? segment : undefined
}

/** Read the whole request body as UTF-8 text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Parse the `{"payload": unknown}` request envelope. */
function parseEnvelope(text: string): unknown {
  const body: unknown = JSON.parse(text)
  if (!isRecord(body) || !('payload' in body)) {
    throw new Error('request body must be a JSON object carrying a "payload" field')
  }
  return body['payload']
}

/**
 * Decide which bridge package owns one row, and report how it was decided.
 *
 * stdio and a row carrying its own `Authorization` header can never need OAuth,
 * so they stay on the built-in client without a probe — the OAuth bridge would
 * overwrite that header with its own token anyway. Every other HTTP row is
 * classified by one probe: only a `401` + `Bearer` challenge hands it to the
 * OAuth bridge, which is what keeps this manager independent of a third-party
 * plugin unless a server really demands OAuth.
 *
 * An undecided probe (`'unreachable'`) keeps the row's current owner on edit;
 * a row that does not exist yet has no owner to keep, so it defaults to the
 * built-in client.
 */
async function resolveOwner(
  ctx: Context,
  id: string,
  config: McpServerConfig,
  probe: OAuthProbe,
): Promise<{ ownerPackage: string; probe: McpOAuthProbe }> {
  const headers = config.headers
  if (config.transport === 'stdio' || (isRecord(headers) && hasAuthorizationHeader(headers))) {
    return { ownerPackage: MCP_CLIENT_PACKAGE, probe: 'plain' }
  }
  const probeHeaders = isRecord(headers) ? (headers as Record<string, string>) : {}
  const verdict = await probe(config.url ?? '', probeHeaders)
  if (verdict === 'oauth') return { ownerPackage: MCP_OAUTH_CLIENT_PACKAGE, probe: verdict }
  if (verdict === 'unreachable') {
    return {
      ownerPackage: findMcpServer(ctx, id)?.ownerPackage ?? MCP_CLIENT_PACKAGE,
      probe: verdict,
    }
  }
  return { ownerPackage: MCP_CLIENT_PACKAGE, probe: verdict }
}

/**
 * Whether this profile can resolve the OAuth bridge package, i.e. whether the
 * loader will be able to load a row that names it.
 *
 * Resolution runs from the patch file's directory because that directory is the
 * profile root the loader resolves every plugin name from: `dsh plugin add`
 * installs packages into `<profile>/node_modules/` whether they came from npm, a
 * Git URL or a local `link:`, so this one lookup reflects all of them. Deliberately
 * uncached: the user may install the plugin while DSH is running.
 */
function oauthBridgeInstalled(patchFile: string): boolean {
  const fromProfile = createRequire(join(dirname(patchFile), 'noop.js'))
  try {
    fromProfile.resolve(MCP_OAUTH_CLIENT_PACKAGE)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a row owned by `ownerPackage` would name a bridge this profile cannot
 * resolve — the one question add, update, setEnabled and list all ask.
 */
function isBridgeMissing(patchFile: string, ownerPackage: string): boolean {
  return ownerPackage === MCP_OAUTH_CLIENT_PACKAGE && !oauthBridgeInstalled(patchFile)
}

/**
 * The `oauthBridgeMissing` marker for a row that lands on an unresolvable OAuth
 * bridge, or an empty object otherwise — the field's mere presence is the
 * panel's signal. The row is still written, disabled: installing the bridge and
 * restarting DSH is enough to be able to switch it on, no re-save needed.
 */
function oauthBridgeMarker(
  ctx: Context,
  patchFile: string,
  ownerPackage: string,
): { oauthBridgeMissing?: true } {
  if (!isBridgeMissing(patchFile, ownerPackage)) return {}
  ctx.logger.warn(
    'mcp-manager: %s is not installed in this profile; the row was saved disabled and can be switched on after installing it and restarting DSH',
    MCP_OAUTH_CLIENT_PACKAGE,
  )
  return { oauthBridgeMissing: true }
}

/** Route one RPC endpoint to its implementation. */
async function dispatch(
  ctx: Context,
  patchFile: string,
  channel: ChangeChannel,
  endpoint: McpEndpoint,
  payload: unknown,
  probe: OAuthProbe,
  visibility?: VisibilityHandle,
): Promise<RpcResult<unknown>> {
  switch (endpoint) {
    case 'list': {
      // The patch file is the authority for config: it holds what the user just
      // saved, while the loader entry still describes the previous edit.
      const servers: McpServerInfo[] = listMcpServers(ctx, readMcpPatchRows(readPatchList(patchFile)))
        .map((server) => (
          isBridgeMissing(patchFile, server.ownerPackage) ? { ...server, bridgeMissing: true } : server
        ))
      // The preset row exists only where a roster exists: a deployment without
      // `agentPresets` keeps the exact pre-L2 response shape.
      const projection = await readPresetProjection(ctx, patchFile)
      if (projection === undefined) return ok({ servers })
      return ok({
        servers: servers.map((server) => ({
          ...server,
          presetPolicy: projectPresetRow(projection.policy, projection.roster, server.id),
        })),
      })
    }
    case 'patchInfo': {
      return ok({ patch: { path: patchFile, exists: existsSync(patchFile) } })
    }
    case 'add': {
      const params = upsertParams(payload)
      if (params === undefined) return badRequest()
      const { id, config } = params
      const { ownerPackage: owner, probe: verdict } = await resolveOwner(ctx, id, config, probe)
      const errors = validateMcpConfig(id, config, owner)
      if (Object.keys(errors).length > 0) {
        return fail('invalid-config', 'Invalid MCP server configuration', { fields: errors })
      }
      if (entryIdTaken(ctx, id)) {
        return fail('duplicate-id', `Entry id "${id}" is already in use`)
      }
      if (serverNameTaken(ctx, config.serverName)) {
        return fail(
          'duplicate-server-name',
          `serverName "${config.serverName}" is already used by another MCP server`,
        )
      }
      // An unresolvable bridge cannot load, so the row is saved disabled: the
      // switch stays shut until the plugin is installed and DSH restarted.
      const missing = isBridgeMissing(patchFile, owner)
      editPatchList(patchFile, (rows) => {
        const next = addMcpRow(rows, id, config, owner)
        return missing ? setMcpEnabled(next, id, false, owner) : next
      })
      channel.broadcast()
      return ok({ added: id, probe: verdict, ...oauthBridgeMarker(ctx, patchFile, owner) })
    }
    case 'remove': {
      const id = readId(payload)
      if (id === undefined) return badRequest()
      editPatchList(patchFile, (rows) => removeMcpRow(rows, id))
      // The matrix row is orphaned with the entry: drop it, then re-align
      // every mask so a removed server can no longer hide stale names.
      dropServerFromPolicy(policyPathOf(patchFile), id)
      visibility?.reconcile()
      channel.broadcast()
      return ok({ removed: id })
    }
    case 'setEnabled': {
      const id = readId(payload)
      const enabled = isRecord(payload) ? payload['enabled'] : undefined
      if (id === undefined || typeof enabled !== 'boolean') return badRequest()
      // Repeat the entry's own package in any synthesized override row: the
      // loader skips a row whose `name` does not match its id.
      const owner = findMcpServer(ctx, id)?.ownerPackage
      // Switching on a row whose bridge is not installed would only create a
      // failed fiber, so the host refuses it; switching off always works.
      if (enabled && owner !== undefined && isBridgeMissing(patchFile, owner)) {
        return fail(
          'bridge-missing',
          `${MCP_OAUTH_CLIENT_PACKAGE} is not installed in this profile, so this server cannot be enabled yet. Install it, restart DSH, then switch it on.`,
        )
      }
      editPatchList(patchFile, (rows) => setMcpEnabled(rows, id, enabled, owner))
      channel.broadcast()
      return ok({ id, enabled })
    }
    case 'update': {
      const params = upsertParams(payload)
      if (params === undefined) return badRequest()
      const { id, config } = params
      // Same probe as add: an edit may move the row between the built-in client
      // and the OAuth bridge, and an undecided probe keeps the current owner.
      const { ownerPackage: owner, probe: verdict } = await resolveOwner(ctx, id, config, probe)
      const errors = validateMcpConfig(id, config, owner)
      if (Object.keys(errors).length > 0) {
        return fail('invalid-config', 'Invalid MCP server configuration', { fields: errors })
      }
      if (serverNameTaken(ctx, config.serverName, id)) {
        return fail(
          'duplicate-server-name',
          `serverName "${config.serverName}" is already used by another MCP server`,
        )
      }
      // Same rule as add for the bridge the edit lands on; a row that moves back
      // to the built-in client keeps whatever disabled state it already had.
      const missing = isBridgeMissing(patchFile, owner)
      editPatchList(patchFile, (rows) => {
        const next = updateMcpConfig(rows, id, config, owner)
        return missing ? setMcpEnabled(next, id, false, owner) : next
      })
      channel.broadcast()
      return ok({ updated: id, probe: verdict, ...oauthBridgeMarker(ctx, patchFile, owner) })
    }
    case 'presets': {
      const svc = readAgentPresets(ctx)
      if (svc === undefined) return agentPresetsUnavailable()
      let roster: readonly PresetRosterRow[]
      try {
        roster = await svc.compositionInventory()
      } catch (error) {
        return agentPresetsUnavailable(error)
      }
      const presets = roster
        .map((row) => toPresetInfo(row))
        .filter((preset): preset is McpPresetInfo => preset !== undefined)
      return ok({ presets })
    }
    case 'setPresetEnabled': {
      const id = readId(payload)
      const presetId = isRecord(payload) ? payload['presetId'] : undefined
      const enabled = isRecord(payload) ? payload['enabled'] : undefined
      if (id === undefined || typeof presetId !== 'string' || presetId === '' || typeof enabled !== 'boolean') {
        return badRequest()
      }
      const svc = readAgentPresets(ctx)
      if (svc === undefined) return agentPresetsUnavailable()
      let roster: readonly PresetRosterRow[]
      try {
        roster = await svc.compositionInventory()
      } catch (error) {
        return agentPresetsUnavailable(error)
      }
      // The cell may only name a roster preset with a sound declaration: a
      // broken row's identity is not something a mask may key on.
      const known = roster.find((preset) => toPresetId(preset) === presetId && !isBrokenPreset(preset))
      if (known === undefined) {
        return fail('preset-not-found', `Preset "${presetId}" is not a managed roster entry`)
      }
      setPresetVisible(policyPathOf(patchFile), id, presetId, enabled)
      visibility?.reconcile()
      channel.broadcast()
      return ok({ id, presetId, enabled })
    }
    default: {
      const unhandled: never = endpoint
      return fail('unknown-endpoint', `Unknown endpoint ${String(unhandled)}`)
    }
  }
}

/** Read the `{id, config}` payload shared by add and update. */
function upsertParams(payload: unknown): { id: string; config: McpServerConfig } | undefined {
  const id = readId(payload)
  const config = isRecord(payload) ? payload['config'] : undefined
  if (id === undefined || !isRecord(config)) return undefined
  return { id, config: config as unknown as McpServerConfig }
}

/** The roster service is not installed (or it refused): everything preset-related degrades away. */
function agentPresetsUnavailable(error?: unknown): RpcResult<never> {
  const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`
  return fail('agent-presets-unavailable', `The agentPresets service is not available in this deployment${detail}`)
}

/** Read a usable preset id out of a roster row; undefined when the row carries none. */
function toPresetId(row: PresetRosterRow | undefined): string | undefined {
  return typeof row?.id === 'string' && row.id !== '' ? row.id : undefined
}

/** A broken declaration carries a diagnostic and its cells cannot be edited. */
function isBrokenPreset(row: PresetRosterRow): boolean {
  return row['broken'] !== undefined && row['broken'] !== null
}

/** Project one roster row onto the wire shape shared with the client; rows without a usable id drop out. */
function toPresetInfo(row: PresetRosterRow): McpPresetInfo | undefined {
  const id = toPresetId(row)
  if (id === undefined) return undefined
  const info: McpPresetInfo = { id, isDefault: row['isDefault'] === true }
  if (typeof row['name'] === 'string') info.name = row['name']
  if (typeof row['description'] === 'string') info.description = row['description']
  if (isBrokenPreset(row)) info.broken = String(row['broken'])
  return info
}

/**
 * The roster ids and exception matrix the `list` projection needs, or
 * undefined when the deployment has no usable preset roster — then the
 * `presetPolicy` field stays absent and the response keeps its pre-L2 shape.
 */
async function readPresetProjection(
  ctx: Context,
  patchFile: string,
): Promise<{ roster: string[]; policy: McpPresetPolicy } | undefined> {
  const svc = readAgentPresets(ctx)
  if (svc === undefined) return undefined
  let roster: string[]
  try {
    // The live service answers with a Promise; awaiting a plain array (the
    // test fake's shape) resolves to itself, so both host shapes work.
    roster = (await svc.compositionInventory())
      .map((row) => toPresetId(row))
      .filter((id): id is string => id !== undefined)
  } catch {
    // A refusing roster is a read failure, not a change: project nothing.
    return undefined
  }
  return { roster, policy: loadPolicy(policyPathOf(patchFile)) }
}

/**
 * State one server's visibility across the roster: every preset starts at the
 * default `true` and the stored exception cells overwrite it — cells for
 * presets outside the roster (deleted or not yet published) stay as the
 * exceptions they are, waiting for their preset to return.
 */
function projectPresetRow(
  policy: McpPresetPolicy,
  roster: readonly string[],
  serverId: string,
): Record<string, boolean> {
  const row: Record<string, boolean> = {}
  for (const presetId of roster) row[presetId] = true
  Object.assign(row, policy[serverId])
  return row
}

/** Read a non-empty string `id` out of a payload. */
function readId(payload: unknown): string | undefined {
  const id = isRecord(payload) ? payload['id'] : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
}
