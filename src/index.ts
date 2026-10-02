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

/**
 * Plugin body: mount the panel's HTTP route and dispatch MCP management
 * commands.
 * @param ctx - plugin context.
 * @param rawConfig - raw row config (optional).
 */
export function apply(ctx: Context, rawConfig?: McpManagerRowConfig): void {
  const patchFile = resolvePatchPath(rawConfig?.patchFile)
  const logger = ctx.logger('mcp-manager')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: (req, res) => handleRequest(ctx, patchFile, req, res),
    }),
    'mcp-manager: http route',
  )

  logger.info('mcp-manager active (patch file: %s)', patchFile)
}

/**
 * Serve one request: apply Connection's Host/Origin + browser-auth fence, then
 * dispatch `POST /mcp-manager/<endpoint>`.
 * @param ctx - plugin context.
 * @param patchFile - user patch layer to read and edit.
 * @param req - incoming HTTP request.
 * @param res - response owned for this request.
 */
export async function handleRequest(
  ctx: Context,
  patchFile: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }

  const endpoint = req.method === 'POST' ? endpointOf(req.url) : undefined
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
    result = await dispatch(ctx, patchFile, endpoint as McpEndpoint, payload)
  } catch (error) {
    // Endpoint failures are data, not transport failures: report them in the
    // envelope so the panel can render them.
    result = fail('internal', error instanceof Error ? error.message : String(error))
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result))
}

/** Resolve the endpoint segment of `/mcp-manager/<segment>`, or undefined. */
function endpointOf(rawUrl: string | undefined): string | undefined {
  let pathname: string
  try {
    pathname = new URL(rawUrl ?? '/', 'http://localhost').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${RPC_CHANNEL}/`)) return undefined
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
      return ok({ added: id })
    }
    case 'remove': {
      const id = readId(payload)
      if (id === undefined) return badRequest()
      editPatchList(patchFile, (rows) => removeMcpRow(rows, id))
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
