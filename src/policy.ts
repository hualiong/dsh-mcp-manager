/**
 * L2 preset visibility matrix persistence.
 *
 * The matrix is runtime policy, not composition: it never touches
 * `cordis.patch.yml` (the patch file stays the hand-edited composition
 * truth). It lives in a JSON sidecar next to the patch layer —
 * `dirname(patchFile)/mcp-manager.policy.json` — so it is profile-scoped,
 * travels with profile backups, and needs no host API beyond `node:fs`.
 * All matrix reads and writes funnel through this module, so a future move
 * to a host settings channel is contained here.
 *
 * Storage keeps exceptions only: a `false` cell means "hidden for that
 * preset" and is the only value written; `true` equals the matrix default
 * (visible), so setting a cell to visible deletes it, and a server row that
 * becomes empty is deleted with it. Keys are always stored sorted, which is
 * what makes the serialized form a stable snapshot for change comparison.
 *
 * @module dsh-mcp-manager/policy
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isRecord } from './shared.ts'

/**
 * The exception matrix: `serverId -> presetId -> visible`. Only exceptions
 * are stored (a `false` cell hides); a missing cell — row, column or whole
 * file — means visible. The design document calls this type
 * `McpPresetPolicy`; the frozen `shared.ts` ships no such export, so the
 * matrix type lives with its persistence module.
 */
export type McpPresetPolicy = Record<string, Record<string, boolean>>

/** File name of the sidecar that sits next to the user patch layer. */
export const POLICY_FILE_NAME = 'mcp-manager.policy.json'

/**
 * Location of the matrix file for one profile.
 * @param patchFile - the user patch layer this profile edits.
 * @returns the path of the JSON policy sidecar in the same directory.
 */
export function policyPathOf(patchFile: string): string {
  return join(dirname(patchFile), POLICY_FILE_NAME)
}

/**
 * Normalize any parsed file into the canonical exception form: only
 * `false` cells survive (a hand-added `true` restates the default, which
 * the file must not carry), keys are sorted for stable serialization, and
 * empty rows and empty ids are dropped.
 * @param raw - the parsed JSON value (untrusted shape).
 * @returns the canonical matrix.
 */
function canonicalize(raw: unknown): McpPresetPolicy {
  const out: McpPresetPolicy = {}
  if (!isRecord(raw)) return out
  for (const serverId of Object.keys(raw).sort()) {
    const cells = raw[serverId]
    if (serverId === '' || !isRecord(cells)) continue
    const row: Record<string, boolean> = {}
    let any = false
    for (const presetId of Object.keys(cells).sort()) {
      if (presetId === '' || cells[presetId] !== false) continue
      row[presetId] = false
      any = true
    }
    if (any) out[serverId] = row
  }
  return out
}

/**
 * Read the matrix. A missing file means the empty matrix — "visible for
 * every preset" is the default and needs no file at all. A file that
 * cannot be parsed or holds a non-object is also the empty matrix: the
 * default is the safe state, and the next write replaces the junk.
 * @param file - policy file path (normally {@link policyPathOf}).
 * @returns the parsed, canonicalized matrix; never throws.
 */
export function loadPolicy(file: string): McpPresetPolicy {
  let raw: unknown
  try {
    if (!existsSync(file)) return {}
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  return canonicalize(raw)
}

/**
 * Persist the matrix atomically: write a process-tagged temp file next to
 * the target, then rename over it, so a reader (or a crash mid-write)
 * never observes a half-written matrix.
 * @param file - policy file path.
 * @param policy - the matrix to write.
 * @returns the canonical matrix actually stored.
 */
function savePolicy(file: string, policy: McpPresetPolicy): McpPresetPolicy {
  const canonical = canonicalize(policy)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return canonical
}

/**
 * State that `serverId` is visible to `presetId` or hidden from it.
 * `visible: true` deletes the exception cell (default visible); an empty
 * row is deleted with it. A request that already holds is a no-op: no file
 * write, no fs event.
 * @param file - policy file path (normally {@link policyPathOf}).
 * @param serverId - loader entry id of the MCP server row.
 * @param presetId - preset identity from the roster.
 * @param visible - the visibility to state for this cell.
 * @returns the canonical matrix after the edit.
 */
export function setPresetVisible(
  file: string,
  serverId: string,
  presetId: string,
  visible: boolean,
): McpPresetPolicy {
  const policy = loadPolicy(file)
  if (serverId === '' || presetId === '') return policy
  if ((policy[serverId]?.[presetId] ?? true) === visible) return policy
  if (visible) {
    const row = policy[serverId]
    if (row !== undefined) {
      delete row[presetId]
      if (Object.keys(row).length === 0) delete policy[serverId]
    }
  } else {
    policy[serverId] = { ...policy[serverId], [presetId]: false }
  }
  return savePolicy(file, policy)
}

/**
 * Delete one server's whole matrix row (the `remove` endpoint). An absent
 * row is an orphan cell nothing references: the request is ignored and no
 * file is rewritten.
 * @param file - policy file path (normally {@link policyPathOf}).
 * @param serverId - loader entry id being removed.
 * @returns the canonical matrix after the edit.
 */
export function dropServerFromPolicy(file: string, serverId: string): McpPresetPolicy {
  const policy = loadPolicy(file)
  if (policy[serverId] === undefined) return policy
  delete policy[serverId]
  return savePolicy(file, policy)
}
