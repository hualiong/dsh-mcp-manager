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
 *  - runs an independent live connectivity probe per server on demand.
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
  type McpEndpoint,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerInfo,
} from './shared.ts'
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
import { probeServer } from './probe.ts'
import { validateMcpConfig } from './validate.ts'

/** Stable plugin id for loader rows. */
export const name = 'mcp-manager'

/** Required services: RPC fence, loader tree, tools, HTTP carrier. */
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

/**
 * Reason attached to an OAuth row's probe result. A bare MCP client has no
 * credential to present, so probing would report a red failure for a server
 * that is merely waiting for its browser authorization flow.
 */
const OAUTH_PROBE_ERROR =
  'OAuth-protected MCP server: a bare probe cannot complete the browser authorization flow, '
  + 'so reachability was not tested — read the live connection status instead.'

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
function createChangeChannel(ctx: Context, patchFile: string): ChangeChannel {
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

  ctx.effect(() => {
    const channel = createChangeChannel(ctx, patchFile)
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: (req, res) => handleRequest(ctx, patchFile, channel, req, res),
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
 */
export async function handleRequest(
  ctx: Context,
  patchFile: string,
  channel: ChangeChannel,
  req: IncomingMessage,
  res: ServerResponse,
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
    result = await dispatch(ctx, patchFile, channel, endpoint as McpEndpoint, payload)
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

/** Route one RPC endpoint to its implementation. */
async function dispatch(
  ctx: Context,
  patchFile: string,
  channel: ChangeChannel,
  endpoint: McpEndpoint,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  switch (endpoint) {
    case 'list': {
      // The patch file is the authority for config: it holds what the user just
      // saved, while the loader entry still describes the previous edit.
      const servers: McpServerInfo[] = listMcpServers(ctx, readMcpPatchRows(readPatchList(patchFile)))
      return ok({ servers })
    }
    case 'patchInfo': {
      return ok({ patch: { path: patchFile, exists: existsSync(patchFile) } })
    }
    case 'add': {
      const params = upsertParams(payload)
      if (params === undefined) return badRequest()
      const { id, config } = params
      const errors = validateMcpConfig(id, config)
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
      editPatchList(patchFile, (rows) => addMcpRow(rows, id, config))
      channel.broadcast()
      return ok({ added: id })
    }
    case 'remove': {
      const id = readId(payload)
      if (id === undefined) return badRequest()
      editPatchList(patchFile, (rows) => removeMcpRow(rows, id))
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
      editPatchList(patchFile, (rows) => setMcpEnabled(rows, id, enabled, owner))
      channel.broadcast()
      return ok({ id, enabled })
    }
    case 'update': {
      const params = upsertParams(payload)
      if (params === undefined) return badRequest()
      const { id, config } = params
      // The live entry decides which package's schema this edit must satisfy,
      // so the panel does not have to name the owner package.
      const owner = findMcpServer(ctx, id)?.ownerPackage ?? MCP_CLIENT_PACKAGE
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
      editPatchList(patchFile, (rows) => updateMcpConfig(rows, id, config, owner))
      channel.broadcast()
      return ok({ updated: id })
    }
    case 'probe': {
      const id = readId(payload)
      if (id === undefined) return badRequest()
      const entry = findMcpServer(ctx, id)
      if (entry === undefined) {
        return fail('not-found', `No MCP server entry with id "${id}"`)
      }
      if (entry.ownerPackage === MCP_OAUTH_CLIENT_PACKAGE) {
        const skipped: McpProbeResult = {
          ok: false,
          skipped: true,
          latencyMs: 0,
          error: OAUTH_PROBE_ERROR,
        }
        return ok(skipped)
      }
      const result: McpProbeResult = await probeServer(entry.config)
      return ok(result)
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

/** Read a non-empty string `id` out of a payload. */
function readId(payload: unknown): string | undefined {
  const id = isRecord(payload) ? payload['id'] : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
