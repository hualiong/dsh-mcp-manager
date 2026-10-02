/**
 * Types and constants shared by the host half and the client half of the
 * dsh-mcp-manager plugin. This module is type-only for the client build
 * (values are used by the host only, the client imports types).
 *
 * @module dsh-mcp-manager/shared
 */

/** The package that implements an MCP server bridge in the harness. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * OAuth-enabled MCP server bridge. It ships its own config schema
 * (`serverName`, `url`, `credentialRef`, `scope`, `callbackPort`,
 * `authorizationTimeoutMs`, …) with no `transport` field, but it publishes its
 * tools under the same `mcp__<serverName>__*` namespace, so a row owned by it
 * is an MCP server row like any other.
 */
export const MCP_OAUTH_CLIENT_PACKAGE = '@dsh-external/dsh-oauth-mcp-client'

/** Every package the manager recognises as an MCP server bridge. */
export const MCP_CLIENT_PACKAGES: readonly string[] = [
  MCP_CLIENT_PACKAGE,
  MCP_OAUTH_CLIENT_PACKAGE,
]

/** Logical Connection RPC channel registered by the host half. */
export const RPC_CHANNEL = '/mcp-manager'

/**
 * Server-sent-events channel served by the host half on its own route, same
 * origin as the panel, authenticated by the same connection fence as the RPC
 * endpoints. This is how the plugin pushes without the host-event allowlist
 * (which fixes the keys of `ctx.remote.$on`): the harness ships the same shape
 * for its own HMR channel.
 */
export const EVENT_CHANNEL = `${RPC_CHANNEL}/events`

/**
 * The only frame the host sends: a nudge to re-read the list. The panel treats
 * every event the same way, so a payload it cannot parse is still actionable,
 * and a missed frame only costs latency — never state.
 */
export const EVENT_CHANGED = 'changed'

/** Frame sent once on connect, so a reconnect cannot miss a change it slept through. */
export const EVENT_READY = 'ready'

/** Supported MCP transports. */
export type McpTransport = 'stdio' | 'streamable-http'

/** Fiber lifecycle phase mirror of the Cordis FiberState const enum. */
export type FiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** A user-editable MCP server configuration (subset of the mcp-client schema). */
export interface McpServerConfig {
  /** Model-facing namespace for this server's tools (`mcp__<serverName>__*`). */
  serverName: string
  /** Transport kind. */
  transport: McpTransport
  /** streamable-http: server URL. */
  url?: string
  /** stdio: executable to spawn. */
  command?: string
  /** stdio: arguments passed to the command. */
  args?: string[]
  /** stdio: extra environment variables. */
  env?: Record<string, string>
  /** stdio: working directory of the child process. */
  cwd?: string
  /** streamable-http: extra request headers. */
  headers?: Record<string, string>
  /** Per-callTool timeout in ms (default 60000). */
  toolCallTimeoutMs?: number
  /** Reject activation when the initial connection/sync fails. */
  failOnStartupError?: boolean
  /** Reconnect policy. */
  reconnect?: {
    enabled?: boolean
    initialDelayMs?: number
    maxDelayMs?: number
    maxAttempts?: number
  }
  /** OAuth bridge only: credential reference holding the serialized OAuth state. */
  credentialRef?: string
  /** OAuth bridge only: fallback OAuth scope when server metadata declares none. */
  scope?: string
  /** OAuth bridge only: loopback callback port (`0` = OS-assigned). */
  callbackPort?: number
  /** OAuth bridge only: maximum wait for the browser authorization callback. */
  authorizationTimeoutMs?: number
}

/** Full server snapshot the host exposes to the client. */
export interface McpServerInfo extends McpServerConfig {
  /** Loader entry id of the bridge plugin instance. */
  id: string
  /** Module specifier of the bridge package owning this row, verbatim. */
  ownerPackage: string
  /** Whether the entry is enabled in the loader composition. */
  enabled: boolean
  /** Current loader fiber phase (undefined entry → null). */
  fiberPhase: FiberPhase
  /** Number of `mcp__<serverName>__*` tools currently registered. */
  toolCount: number
  /** true when this server is defined in the user patch layer (removable). */
  userManaged: boolean
}

/** Live connectivity probe result. */
export interface McpProbeResult {
  ok: boolean
  latencyMs: number
  toolCount?: number
  error?: string
  /**
   * true when no verdict was produced at all — an OAuth-owned row a bare MCP
   * probe cannot authorize. The UI shows a warning instead of a failure.
   */
  skipped?: true
}

/** RPC endpoints understood by the host channel handler. */
export type McpEndpoint =
  | 'list'
  | 'add'
  | 'remove'
  | 'setEnabled'
  | 'update'
  | 'probe'
  | 'patchInfo'

/** Server-side validation errors, keyed by field for inline form display. */
export type McpFieldErrors = Partial<Record<keyof McpServerConfig | 'id', string>>
