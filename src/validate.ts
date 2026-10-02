/**
 * Server config validation shared by the add/update RPC endpoints. Every rule
 * mirrors the owning bridge package's schema so the panel rejects invalid input
 * with the same semantics the plugin would enforce at load.
 *
 * @module dsh-mcp-manager/validate
 */
import {
  MCP_CLIENT_PACKAGE,
  MCP_OAUTH_CLIENT_PACKAGE,
  type McpFieldErrors,
  type McpServerConfig,
  type McpTransport,
} from './shared.ts'

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Trim surrounding quotes from a pasted JSON-style key/value pair. */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

/** Parse a key=value / `key: value` line block into a record. */
export function parseKeyValueBlock(lines: string[] | undefined): Record<string, string> | undefined {
  if (lines === undefined) return undefined
  const out: Record<string, string> = {}
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    const colon = trimmed.indexOf(':')
    const sep = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon)
    if (sep <= 0) continue
    out[stripQuotes(trimmed.slice(0, sep))] = stripQuotes(trimmed.slice(sep + 1))
  }
  return out
}

/** Whether an OAuth bridge URL satisfies that plugin's own activation rules. */
function isOAuthUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopback)
  return scheme && url.username === '' && url.password === ''
}

/** Whether a record carries an OAuth-owned Authorization header. */
function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
}

/**
 * Validate a proposed config against `ownerPackage`'s schema; returns
 * field-level errors (empty = valid).
 */
export function validateMcpConfig(
  id: string,
  config: McpServerConfig,
  ownerPackage: string = MCP_CLIENT_PACKAGE,
): McpFieldErrors {
  const errors: McpFieldErrors = {}

  if (!ENTRY_ID_RE.test(id)) {
    errors['id'] = 'Entry id must match [A-Za-z0-9_-]{1,64}'
  }
  if (typeof config.serverName !== 'string' || !SERVER_NAME_RE.test(config.serverName)) {
    errors['serverName'] = 'serverName must match [A-Za-z0-9_-]{1,32}'
  }

  if (ownerPackage === MCP_OAUTH_CLIENT_PACKAGE) {
    // The OAuth bridge has no transport field: it is always streamable-http.
    if (typeof config.url !== 'string' || !isOAuthUrl(config.url)) {
      errors['url'] = 'An https:// URL is required (http:// only for loopback)'
    }
    if (config.credentialRef !== undefined
      && (typeof config.credentialRef !== 'string' || config.credentialRef.trim() === '')) {
      errors['credentialRef'] = 'credentialRef must be a non-empty string'
    }
    if (config.scope !== undefined && (typeof config.scope !== 'string' || config.scope.trim() === '')) {
      errors['scope'] = 'scope must not be empty'
    }
    if (config.callbackPort !== undefined
      && (!Number.isInteger(config.callbackPort) || config.callbackPort < 0 || config.callbackPort > 65_535)) {
      errors['callbackPort'] = 'callbackPort must be an integer from 0 through 65535'
    }
    if (config.authorizationTimeoutMs !== undefined
      && (typeof config.authorizationTimeoutMs !== 'number' || config.authorizationTimeoutMs < 1)) {
      errors['authorizationTimeoutMs'] = 'authorizationTimeoutMs must be a positive number'
    }
    if (isStringRecord(config.headers) && hasAuthorizationHeader(config.headers)) {
      errors['headers'] = 'headers.Authorization is owned by OAuth and must not be set'
    }
  } else {
    const transport: McpTransport = config.transport === 'stdio' ? 'stdio' : 'streamable-http'
    if (transport === 'streamable-http') {
      if (typeof config.url !== 'string' || !/^https?:\/\/.+/.test(config.url)) {
        errors['url'] = 'A valid http(s):// URL is required for streamable-http'
      }
    } else {
      if (typeof config.command !== 'string' || config.command.trim() === '') {
        errors['command'] = 'An executable command is required for stdio'
      }
      if (config.args !== undefined && !Array.isArray(config.args)) {
        errors['args'] = 'args must be an array of strings'
      }
      if (config.cwd !== undefined && typeof config.cwd !== 'string') {
        errors['cwd'] = 'cwd must be a string'
      }
    }
  }

  if (config.env !== undefined && !isStringRecord(config.env)) {
    errors['env'] = 'env must be a string-to-string map'
  }
  if (config.headers !== undefined && !isStringRecord(config.headers)) {
    errors['headers'] = 'headers must be a string-to-string map'
  }
  if (config.toolCallTimeoutMs !== undefined
    && (typeof config.toolCallTimeoutMs !== 'number' || config.toolCallTimeoutMs < 1)) {
    errors['toolCallTimeoutMs'] = 'toolCallTimeoutMs must be a positive number'
  }
  return errors
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}
