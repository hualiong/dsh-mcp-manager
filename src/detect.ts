/**
 * One-shot OAuth capability probe for an MCP HTTP endpoint.
 *
 * A server that wants OAuth answers an unauthenticated request with `401` plus
 * a `WWW-Authenticate: Bearer …` challenge — the behaviour RFC 9728 and the MCP
 * authorization spec require. Anything else (200, 405, a redirect, even a 500)
 * means the endpoint does not need OAuth from this manager's point of view.
 *
 * A server that wants a fixed token (a GitHub PAT, say) also answers 401, but
 * such a row carries its own `Authorization` header and the caller's ownership
 * rule settles that row before this probe is ever reached. `'unreachable'` is
 * not a verdict, only the absence of one: the caller keeps the row's owner.
 *
 * This sends no MCP message and opens no session — it reads the status line and
 * the response headers of one GET and drops the body.
 *
 * @module dsh-mcp-manager/detect
 */
import type { McpOAuthProbe } from './shared.ts'

/** The injectable probe: tests stub it, production uses {@link detectOAuth}. */
export type OAuthProbe = (url: string, headers: Record<string, string>) => Promise<McpOAuthProbe>

/** How long the probe waits for a response before reporting `'unreachable'`. */
const PROBE_TIMEOUT_MS = 5000

/** Classify an MCP endpoint as needing OAuth or not; never throws. */
export async function detectOAuth(
  url: string,
  headers: Record<string, string> = {},
): Promise<McpOAuthProbe> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/event-stream', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const challenge = response.headers.get('www-authenticate') ?? ''
    const verdict: McpOAuthProbe = response.status === 401 && /^bearer/i.test(challenge)
      ? 'oauth'
      : 'plain'
    try {
      // The verdict is already decided: drop the body without reading it, so no
      // MCP response stream is ever parsed.
      await response.body?.cancel()
    } catch {
      // A body that cannot be cancelled is noise, not a verdict.
    }
    return verdict
  } catch {
    // Offline, DNS, TLS, timeout, an abort: all undecided, never fatal.
    return 'unreachable'
  }
}
