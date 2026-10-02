/**
 * User patch-layer editor for the web profile's `cordis.patch.yml`.
 *
 * MCP servers live as MCP-bridge plugin entries composed into the loader tree
 * (`@deepseek-ai/dsh-mcp-client`, or the OAuth bridge
 * `@dsh-external/dsh-oauth-mcp-client`). The user-editable layer is the profile
 * patch file; the harness watches it (HMR) and hot-reloads the tree when it
 * changes, so every edit here is applied live without a restart.
 *
 * The file is a top-level YAML array of loader patch entries in the
 * `cordis-plugin-include` dialect:
 *   - `{ insert: [ {id, name, config} ] }`  — append new entries (id-less insert
 *     appends to the root list);
 *   - `{ id, name, config?, disabled? }`     — override/disable a composed entry;
 *   - `!!js` scalar expressions round-trip unchanged.
 *
 * @module dsh-mcp-manager/patch
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { MCP_CLIENT_PACKAGE, MCP_OAUTH_CLIENT_PACKAGE, type McpServerConfig } from './shared.ts'

/**
 * Mirrors `isJsExpr` from @deepseek-ai/cordis-plugin-loader (the harness's own
 * `cordis-plugin-include` uses it as the `!!js` yaml predicate). Replicated
 * inline so the host half has zero runtime imports of @deepseek-ai packages —
 * the plugin may be installed anywhere (e.g. via a `link:`), where bare
 * @deepseek-ai specifiers may not be resolvable from its real path.
 */
function isJsExpr(value: unknown): value is { __jsExpr: unknown } {
  return value instanceof Object && '__jsExpr' in value
}

/**
 * Mirrors `resolveDshHome` from @deepseek-ai/dsh-home-paths (same precedence:
 * an explicit configured path, `$DSH_HOME`, then `~/.dsh`). Replicated inline
 * for the same portability reason as {@link isJsExpr}.
 */
function resolveDshHome(configured?: string): string {
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  const env = process.env['DSH_HOME']
  if (env !== undefined && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/** A parsed patch row: either a top-level entry row or an insert row. */
interface PatchRow {
  /** Row-level id (top-level rows only). */
  id?: string
  /** Module specifier (top-level rows only). */
  name?: string
  /** Row-level config (top-level rows only). */
  config?: unknown
  /** Row-level disabled flag (top-level rows only). */
  disabled?: boolean
  /** Insert list (insert rows only). */
  insert?: Array<Record<string, unknown>>
  [key: string]: unknown
}

/**
 * The entry-list YAML dialect used by the harness include: plain JSON schema
 * extended with a `!!js` scalar type that round-trips expression nodes
 * (mirrors the dialect `dsh-app-boot` mounts).
 */
const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: unknown) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data: unknown) => (data as { __jsExpr?: unknown })['__jsExpr'],
})

const ENTRY_LIST_SCHEMA = yaml.JSON_SCHEMA.extend(JsExprType)

/** Header comment written ahead of the managed entry rows. */
const PATCH_HEADER = `# MCP servers managed by the dsh-mcp-manager plugin.
# Format: a top-level YAML array of loader patch entries (\`!!js\` expressions
# allowed). Edit here, or use the MCP Manager panel in the web GUI.
`

/**
 * Config keys each bridge package accepts from the panel's editor. A row is
 * rewritten from that surface alone, so anything else in an incoming config is
 * dropped instead of being written into the user's patch file.
 */
const PLUGIN_CONFIG_KEYS: Record<string, readonly string[]> = {
  [MCP_CLIENT_PACKAGE]: [
    'serverName', 'transport', 'url', 'command', 'args', 'env', 'cwd', 'headers',
    'toolCallTimeoutMs', 'failOnStartupError', 'reconnect',
  ],
  [MCP_OAUTH_CLIENT_PACKAGE]: [
    'serverName', 'url', 'credentialRef', 'scope', 'headers', 'callbackPort',
    'authorizationTimeoutMs', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect',
  ],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Project an edited config onto the owning package's schema.
 *
 * Every package other than the official client merges over the row's current
 * config first: the panel's editor does not model `credentialRef`, `scope`,
 * `callbackPort` or `authorizationTimeoutMs`, and a plain replace would strip
 * the authorization state reference the OAuth bridge needs. `transport` and the
 * stdio/http-only keys never reach such a row either, because its schema has no
 * such field and an unknown key is a load-time config error.
 */
function rowConfigFor(
  ownerPackage: string,
  config: McpServerConfig,
  current?: unknown,
): Record<string, unknown> {
  const keys = PLUGIN_CONFIG_KEYS[ownerPackage] ?? PLUGIN_CONFIG_KEYS[MCP_CLIENT_PACKAGE]!
  const incoming = config as unknown as Record<string, unknown>
  const source = ownerPackage !== MCP_CLIENT_PACKAGE && isRecord(current)
    ? { ...current, ...incoming }
    : incoming
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  // `transport` is a required const in the official schema; a row without one
  // fails to load.
  if (ownerPackage === MCP_CLIENT_PACKAGE && out['transport'] === undefined) {
    out['transport'] = 'streamable-http'
  }
  return out
}

/** Resolve the user patch file for the running profile (config override wins). */
export function resolvePatchPath(configured?: string): string {
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  return join(resolveDshHome(), 'profiles', 'web', 'cordis.patch.yml')
}

/** Read and parse the patch file; a missing file yields an empty list. */
export function readPatchList(file: string): PatchRow[] {
  if (!existsSync(file)) return []
  const content = readFileSync(file, 'utf8')
  const trimmed = content.trim()
  if (trimmed === '') return []
  const parsed = yaml.load(content, { schema: ENTRY_LIST_SCHEMA })
  if (parsed === undefined || parsed === null) return []
  if (!Array.isArray(parsed)) throw new Error(`patch file ${file} must be a top-level array`)
  return parsed as PatchRow[]
}

/** Serialize and write the patch list, preserving `!!js` expressions. */
export function writePatchList(file: string, rows: PatchRow[]): void {
  const body = rows.length > 0 ? yaml.dump(rows, { schema: ENTRY_LIST_SCHEMA, lineWidth: 120 }) : '[]\n'
  writeFileSync(file, `${PATCH_HEADER}${body}`, 'utf8')
}

/** Apply an edit function and persist; returns the rows after the edit. */
export function editPatchList(
  file: string,
  edit: (rows: PatchRow[]) => PatchRow[],
): PatchRow[] {
  const next = edit(readPatchList(file))
  writePatchList(file, next)
  return next
}

/** Find the in-patch location of an entry id. */
type Location =
  | { kind: 'row'; row: PatchRow }
  | { kind: 'insert'; row: PatchRow; item: Record<string, unknown> }
  | undefined

function locate(rows: PatchRow[], id: string): Location {
  for (const row of rows) {
    if (row.id === id) return { kind: 'row', row }
    if (Array.isArray(row.insert)) {
      const item = row.insert.find((entry) => entry['id'] === id)
      if (item !== undefined) return { kind: 'insert', row, item }
    }
  }
  return undefined
}

/** Rewrite one located patch entry (top-level row or insert item) in place. */
function rewriteLocated(
  rows: PatchRow[],
  found: Location,
  next: (entry: Record<string, unknown>) => Record<string, unknown>,
): PatchRow[] {
  if (found === undefined) return rows
  if (found.kind === 'row') {
    return rows.map((row) => (row === found.row ? next(row) as PatchRow : row))
  }
  return rows.map((row) =>
    row === found.row
      ? { ...row, insert: row.insert!.map((item) => (item === found.item ? next(item) : item)) }
      : row,
  )
}

/** The package an existing patch entry names, or the caller's fallback. */
function ownerPackageOf(entry: Record<string, unknown>, fallback: string): string {
  return typeof entry['name'] === 'string' ? entry['name'] : fallback
}

/**
 * Append a new MCP server as an id-less insert row (the only patch form that
 * creates brand-new entries in the composed tree).
 */
export function addMcpRow(rows: PatchRow[], id: string, config: McpServerConfig): PatchRow[] {
  return [
    ...rows,
    { insert: [{ id, name: MCP_CLIENT_PACKAGE, config: rowConfigFor(MCP_CLIENT_PACKAGE, config) }] },
  ]
}

/**
 * Remove every trace of an entry id: top-level rows and items inside insert
 * lists; an insert row that becomes empty is dropped.
 */
export function removeMcpRow(rows: PatchRow[], id: string): PatchRow[] {
  const next: PatchRow[] = []
  for (const row of rows) {
    if (row.id === id) continue
    if (Array.isArray(row.insert)) {
      const filtered = row.insert.filter((item) => item['id'] !== id)
      if (filtered.length === 0) continue
      next.push({ ...row, insert: filtered })
      continue
    }
    next.push(row)
  }
  return next
}

/**
 * Enable/disable an entry. When the entry is defined in the user patch
 * (top-level or insert item) its own flag flips; otherwise a bundle-defined
 * entry is overridden with a matching `{id, name, disabled}` row (the patch
 * layer later in the stack wins). The synthesized override must repeat the
 * entry's real owner package: a name mismatch makes the loader skip the row.
 */
export function setMcpEnabled(
  rows: PatchRow[],
  id: string,
  enabled: boolean,
  fallbackPackage: string = MCP_CLIENT_PACKAGE,
): PatchRow[] {
  const found = locate(rows, id)
  if (found === undefined) {
    return [...rows, { id, name: fallbackPackage, disabled: !enabled }]
  }
  return rewriteLocated(rows, found, (entry) => ({ ...entry, disabled: !enabled }))
}

/**
 * Replace the config of an existing entry. When the entry is not in the user
 * patch (bundle-defined), a matching override row is appended.
 */
export function updateMcpConfig(
  rows: PatchRow[],
  id: string,
  config: McpServerConfig,
  fallbackPackage: string = MCP_CLIENT_PACKAGE,
): PatchRow[] {
  const found = locate(rows, id)
  if (found === undefined) {
    return [
      ...rows,
      { id, name: fallbackPackage, config: rowConfigFor(fallbackPackage, config) },
    ]
  }
  const current = found.kind === 'row' ? found.row : found.item
  return rewriteLocated(rows, found, (entry) => ({
    ...entry,
    config: rowConfigFor(ownerPackageOf(entry, fallbackPackage), config, current.config),
  }))
}

/** Whether an entry id is present in the user patch (removable/editable). */
export function patchHasId(rows: PatchRow[], id: string): boolean {
  return locate(rows, id) !== undefined
}
