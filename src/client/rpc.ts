/**
 * Client for the host's `/mcp-manager` HTTP route.
 *
 * The DSH Connection RPC service cannot reach a plugin-owned route on this
 * client build (`ctx.connection.rpc.handle` fails host-side, see the node
 * half), so the browser half talks to its own host the way every in-box web
 * feature does: plain `fetch` against the loopback route the node half
 * registers on the web server.
 *
 * Wire contract (frozen with the node half):
 *
 *   POST /mcp-manager/<endpoint>   body `{"payload": <unknown>}`
 *   200 `{"ok":true,"value":<unknown>}`
 *   200 `{"ok":false,"error":{"code","message","details"}}`
 *   401 / 403 plain text (connection rejection) and non-2xx generally are
 *   transport failures, not business failures.
 *
 * @module dsh-mcp-manager/client/rpc
 */
import { RPC_CHANNEL, type McpEndpoint } from '../shared.ts'

/** Host-side failure payload carried inside a `{"ok":false}` reply. */
interface HostError {
  code: string
  message: string
  details: Record<string, unknown> | undefined
}

/** Reads a possibly-absent plain object from an untrusted reply. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Normalizes an untrusted error payload into a {@link HostError}. */
function hostErrorOf(value: unknown): HostError {
  const raw = recordOf(value) ?? {}
  const code = typeof raw['code'] === 'string' ? raw['code'] : 'unknown-error'
  return {
    code,
    message: typeof raw['message'] === 'string' ? raw['message'] : code,
    details: recordOf(raw['details']),
  }
}

/** Error thrown by {@link callRpc} for a host-reported failure. */
export class McpManagerRpcError extends Error {
  readonly code: string
  readonly fields: Record<string, string> | undefined

  constructor(error: HostError) {
    super(`${error.code}: ${error.message}`)
    this.name = 'McpManagerRpcError'
    this.code = error.code
    const fields = error.details?.['fields']
    this.fields = recordOf(fields) as Record<string, string> | undefined
  }
}

/**
 * Error thrown when no host reply could be read at all: the request never
 * reached the route, answered with a non-2xx status, or answered with a body
 * that is not the reply envelope. Nothing about the plugin's own operations
 * can be concluded from one, which is why the panel treats it as a broken
 * browser-to-host link instead of an MCP failure.
 */
export class McpManagerTransportError extends Error {
  /** HTTP status when a response arrived, otherwise undefined. */
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'McpManagerTransportError'
    this.status = status
  }
}

/**
 * Call one host endpoint and return its business value.
 * @param endpoint - endpoint name (its own path segment under the route).
 * @param payload - endpoint payload; absent becomes `null`.
 * @returns the endpoint's value.
 * @throws McpManagerRpcError on a host-reported failure,
 *   McpManagerTransportError when the route did not answer.
 */
export async function callRpc<T>(endpoint: McpEndpoint, payload?: unknown): Promise<T> {
  const route = `${RPC_CHANNEL}/${endpoint}`
  let response: Response
  try {
    response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: payload ?? null }),
      credentials: 'same-origin',
    })
  } catch (cause) {
    throw new McpManagerTransportError(cause instanceof Error ? cause.message : String(cause))
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const detail = text.trim()
    throw new McpManagerTransportError(
      `${endpoint}: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`,
      response.status,
    )
  }

  let reply: unknown
  try {
    reply = await response.json()
  } catch {
    throw new McpManagerTransportError(`${endpoint}: reply is not JSON`)
  }

  const envelope = recordOf(reply)
  if (envelope === undefined || typeof envelope['ok'] !== 'boolean') {
    throw new McpManagerTransportError(`${endpoint}: unexpected reply envelope`)
  }
  if (envelope['ok'] === true) return envelope['value'] as T
  throw new McpManagerRpcError(hostErrorOf(envelope['error']))
}
