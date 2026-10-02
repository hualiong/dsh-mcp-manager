/**
 * Loader/tools status enumeration for MCP server instances.
 *
 * Every MCP server is one MCP-bridge plugin entry in the loader composition
 * (`@deepseek-ai/dsh-mcp-client` or the OAuth bridge
 * `@dsh-external/dsh-oauth-mcp-client`). Its lifecycle phase (mirrored from the
 * Cordis FiberState const enum) plus the number of `mcp__<serverName>__*` tools
 * it currently has registered on the tool registry make up the observable
 * "connection status": a server that successfully connected and synchronized
 * its tool list is `active` with `toolCount > 0`; a disabled entry reports
 * `pending`/`null`; a failing server reports `failed`.
 *
 * @module dsh-mcp-manager/status
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the `Context { tools }` and `Context { loader }`
// declaration merges into the program (runtime never imports these packages).
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { McpPatchRow } from './patch.ts'
import {
  MCP_CLIENT_PACKAGES,
  MCP_OAUTH_CLIENT_PACKAGE,
  type FiberPhase,
  type McpServerConfig,
  type McpServerInfo,
} from './shared.ts'

/**
 * The composed loader nests every row under the root include group, so tree
 * entry ids look like `include:<file-id>` (nested groups add more segments).
 * The user patch file addresses rows by their file-level id, so the plugin
 * strips the leading root-group segment for all id comparisons.
 */
export function normalizeEntryId(id: string): string {
  return id.startsWith('include:') ? id.slice('include:'.length) : id
}

/** Complete public projection of the Cordis Fiber states, by ordinal. */
const FIBER_PHASE: readonly FiberPhase[] = [
  'pending', 'loading', 'active', 'failed', null, 'unloading',
]

/** Normalize a raw bridge row config into the shared shape. */
export function toServerConfig(raw: unknown, oauth: boolean): McpServerConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>
  return {
    serverName: typeof cfg['serverName'] === 'string' ? cfg['serverName'] : '',
    // The OAuth bridge always speaks streamable-http and has no transport field.
    transport: oauth ? 'streamable-http' : cfg['transport'] === 'stdio' ? 'stdio' : 'streamable-http',
    url: typeof cfg['url'] === 'string' ? cfg['url'] : undefined,
    command: typeof cfg['command'] === 'string' ? cfg['command'] : undefined,
    args: Array.isArray(cfg['args']) ? (cfg['args'] as string[]) : undefined,
    env: isRecord(cfg['env']) ? (cfg['env'] as Record<string, string>) : undefined,
    cwd: typeof cfg['cwd'] === 'string' ? cfg['cwd'] : undefined,
    headers: isRecord(cfg['headers']) ? (cfg['headers'] as Record<string, string>) : undefined,
    toolCallTimeoutMs: typeof cfg['toolCallTimeoutMs'] === 'number'
      ? cfg['toolCallTimeoutMs']
      : undefined,
    failOnStartupError: typeof cfg['failOnStartupError'] === 'boolean'
      ? cfg['failOnStartupError']
      : undefined,
    reconnect: isRecord(cfg['reconnect']) ? cfg['reconnect'] as McpServerConfig['reconnect'] : undefined,
    credentialRef: typeof cfg['credentialRef'] === 'string' ? cfg['credentialRef'] : undefined,
    scope: typeof cfg['scope'] === 'string' ? cfg['scope'] : undefined,
    callbackPort: typeof cfg['callbackPort'] === 'number' ? cfg['callbackPort'] : undefined,
    authorizationTimeoutMs: typeof cfg['authorizationTimeoutMs'] === 'number'
      ? cfg['authorizationTimeoutMs']
      : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Count tools registered on the harness registry under a server namespace. */
export function countServerTools(ctx: Context, serverName: string): number {
  if (serverName === '') return 0
  const prefix = `mcp__${serverName}__`
  let count = 0
  for (const schema of ctx.tools.schemas()) {
    if (schema.name.startsWith(prefix)) count += 1
  }
  return count
}

/** One live MCP server row resolved by file-level entry id. */
export interface McpServerEntry {
  /** Module specifier of the owning bridge package, verbatim. */
  ownerPackage: string
  /** Config normalized into the shared shape. */
  config: McpServerConfig
}

/** Enumerate every MCP server with its status projection. */
export function listMcpServers(
  ctx: Context,
  fileRows: readonly McpPatchRow[] = [],
): McpServerInfo[] {
  const byId = new Map(fileRows.map((row) => [row.id, row]))
  const servers: McpServerInfo[] = []
  const composed = new Set<string>()
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const ownerPackage = entry.options.name
    if (!MCP_CLIENT_PACKAGES.includes(ownerPackage)) continue
    const id = normalizeEntryId(entry.id)
    const oauth = ownerPackage === MCP_OAUTH_CLIENT_PACKAGE
    const live = toServerConfig(entry.options.config, oauth)
    const fileRow = byId.get(id)
    composed.add(id)
    servers.push({
      ...reportedConfig(entry.options.config, fileRow, oauth),
      id,
      ownerPackage,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? null,
      // Tools belong to the running bridge, so count them under the name the
      // live entry still runs, not the name the file was just edited to.
      toolCount: countServerTools(ctx, live.serverName),
      userManaged: fileRow !== undefined,
    })
  }
  // A row the file declares but the loader has not composed yet (just added, or
  // mid-reload) must not stay invisible until the next reload.
  for (const row of fileRows) {
    if (composed.has(row.id) || row.ownerPackage === '') continue
    const oauth = row.ownerPackage === MCP_OAUTH_CLIENT_PACKAGE
    const config = toServerConfig(row.config, oauth)
    if (config.serverName === '') continue
    servers.push({
      ...config,
      id: row.id,
      ownerPackage: row.ownerPackage,
      enabled: row.disabled !== true,
      fiberPhase: null,
      toolCount: 0,
      userManaged: true,
    })
  }
  return servers
}

/**
 * The config to report for one live entry: the patch file's row is what the
 * user just saved, so it wins per key over the live entry's config (which the
 * loader has not caught up with yet). Keys the row does not mention stay live.
 */
function reportedConfig(
  entryConfig: unknown,
  fileRow: McpPatchRow | undefined,
  oauth: boolean,
): McpServerConfig {
  const file = fileRow?.config
  if (!isRecord(file)) return toServerConfig(entryConfig, oauth)
  return toServerConfig({ ...(isRecord(entryConfig) ? entryConfig : {}), ...file }, oauth)
}

/** Resolve one MCP server row (owned by any recognised bridge package). */
export function findMcpServer(ctx: Context, id: string): McpServerEntry | undefined {
  const wanted = normalizeEntryId(id)
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const ownerPackage = entry.options.name
    if (!MCP_CLIENT_PACKAGES.includes(ownerPackage)) continue
    if (normalizeEntryId(entry.id) !== wanted) continue
    return {
      ownerPackage,
      config: toServerConfig(entry.options.config, ownerPackage === MCP_OAUTH_CLIENT_PACKAGE),
    }
  }
  return undefined
}

/** Whether a serverName is already taken by a live MCP server instance. */
export function serverNameTaken(ctx: Context, serverName: string, exceptId?: string): boolean {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    if (!MCP_CLIENT_PACKAGES.includes(entry.options.name)) continue
    // Compare file-level ids (tree ids carry the `include:` root prefix).
    if (exceptId !== undefined && normalizeEntryId(entry.id) === exceptId) continue
    const raw = (entry.options.config ?? {}) as Record<string, unknown>
    if (raw['serverName'] === serverName) return true
  }
  return false
}

/** Whether a loader entry id is already taken (across all plugins). */
export function entryIdTaken(ctx: Context, id: string, exceptId?: string): boolean {
  for (const entry of ctx.loader.entries()) {
    if (normalizeEntryId(entry.id) === id && entry.id !== exceptId) return true
  }
  return false
}
