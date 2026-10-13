/**
 * MCP Manager settings section: server list with live status, add/remove,
 * enable/disable, edit and on-demand connectivity tests. Rendered inside the
 * Settings panel as the "MCP" page (a `settings.section` entry).
 *
 * Layout and typography mirror the official settings pages. The card is the
 * 模型 page's configured-row structure — `rowCard` / `rowHead` / `rowIdentity`
 * / `rowName` / `rowTag` / `rowActions`
 * (`.recon/official/settings-models.client.js`) — with the plugin-inventory
 * card's disclosure mechanics for the title toggle and chevron
 * (`.recon/official/settings-plugin-inventory.client.js`), and the header row
 * + toolbar of the plugin page (`.recon/official/plugin-manager.client.js`).
 * Every number and token below is copied from those bundles; each style
 * constant names the official rule it reproduces, and deliberate departures
 * are called out where they happen.
 *
 * The card header carries the whole identity — name, status chip, transport
 * chip, chevron — plus the enable Switch, so a collapsed card is still fully
 * operable. The transport chip is static: a transport is a written-down
 * property of the row. The status chip is the only one that moves, and it
 * walks the fiber's phases (等待中 → 加载中 → 工具数) so the connection story
 * is visible while a server comes up. Expanding a card IS editing it: the
 * disclosure panel mounts the edit form directly (there is no read-only body
 * left to show), and the form's footer holds [取消][保存].
 *
 * The transcript-facing `DisclosureRow` primitive is deliberately NOT used:
 * its contract is a 24px tertiary process row, so it cannot carry the
 * settings-page title scale or host the row's controls.
 *
 * Controls come from the official kit
 * (`@deepseek-ai/dsh-client-ui-primitives`): Button (`sm` = the 28px actions
 * this panel uses everywhere), Input, Switch, Tag, StateDot, Tooltip,
 * SegmentedControl, RiskConfirmation, PathLabel and the product icons; the
 * transport choice is the kit's SegmentedControl, the control the 模型 page's
 * own add card switches its forms with. The only styles this module owns are
 * inline declarations carrying those official values — the kit ships no layout
 * primitives and this package has no CSS file.
 *
 * Copy is fully localized (zh/en); the renderer hands the registered `locale:`
 * namespace's `t` seat in as a prop, so the page follows the active GUI
 * language without subscribing to locale state itself.
 *
 * @module dsh-mcp-manager/client/McpManagerSection
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  Modal,
  PathLabel,
  SegmentedControl,
  StateDot,
  Switch,
  Tag,
  Tooltip,
  type StateDotState,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { EVENT_CHANNEL } from '../shared.ts'
import type {
  McpFieldErrors,
  McpOAuthProbe,
  McpServerConfig,
  McpServerInfo,
  McpTransport,
} from '../shared.ts'
import { callRpc, McpManagerRpcError, McpManagerTransportError } from './rpc.ts'
import { NS } from './locales.ts'

/** Patch-file snapshot shown in the page footer. */
interface PatchInfo {
  path: string
  exists: boolean
}

/** Composed props: the locale namespace's `t` seat (the section needs nothing else). */
interface SectionProps {
  t: TranslateNS<typeof NS>
}

/**
 * Status keys used by the card badge. A connected server reports the tool count
 * itself, so that case reuses the `toolCount` sentence; `statusNotConnected`
 * covers the one state that is not a fiber phase (an active bridge whose
 * handshake never succeeded); every other key names one fiber phase. The
 * transport chip never takes part in any of them — a transport is a written-down
 * property of the row, not a connection state — so the status chip is the only
 * one that moves while a server comes up.
 */
type StatusKey =
  | 'toolCount'
  | 'statusNotConnected'
  | 'statusFailed'
  | 'statusDisabled'
  | 'statusNotLoaded'
  | 'statusPending'
  | 'statusLoading'
  | 'statusUnloading'

/** Card status: the dot's semantic, the tag's palette, and the copy key. */
interface ServerStatus {
  dot: StateDotState
  tone: TagTone
  key: StatusKey
  count?: string
}

/**
 * Transport names as the header chip and the form's selector both read them.
 * Both are short enough for the SegmentedControl's equal-width tracks, which is
 * the only reason the selector can use it (the control places its indicator
 * arithmetically; a label wider than its share would push the pill off).
 */
const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'STDIO',
  'streamable-http': 'Streamable HTTP',
}

/**
 * The transport choices, in display order — one list for the add and the edit
 * form alike. Which bridge package implements a choice is the manager's
 * business: streamable-http always goes to the OAuth bridge, which authorizes
 * only when the server answers 401, so there is no third option to pick.
 */
const TRANSPORT_OPTIONS: readonly { value: McpTransport; label: string }[] = [
  { value: 'streamable-http', label: TRANSPORT_LABELS['streamable-http'] },
  { value: 'stdio', label: TRANSPORT_LABELS.stdio },
]

// --- official values -----------------------------------------------------------------
// `models` = ModelsSection.module.css inside .recon/official/settings-models.client.js
// `inventory` = PluginInventorySettingsTab.module.css inside
//   .recon/official/settings-plugin-inventory.client.js
// `manager` = plugin-manager.client.js, `general` = settings-general.client.js

/** models `.section` — the settings page column. */
const sectionStyle: CSSProperties = {
  maxWidth: 720,
  color: 'var(--dsw-alias-label-primary)',
  flexDirection: 'column',
  gap: 12,
  display: 'flex',
}
/** models `.title` — the page heading. */
const titleStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  margin: 0,
  fontSize: 16,
  fontWeight: 500,
  lineHeight: '24px',
}
/** models `.intro` — the summary sentence under the heading (spacing comes from `.section`'s gap). */
const introStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  margin: 0,
  fontSize: 14,
  lineHeight: '22px',
}
/** plugin-manager `.pageHead` layout; `align-items` is `center` by explicit user instruction
 * (the official rule is `flex-start`), so the toolbar centres against the two-line heading. */
const pageHeadStyle: CSSProperties = {
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 16,
  display: 'flex',
}
/** models `.section` column (gap 12) on the heading block; `min-width:0` from `.rowIdentity`. */
const titleBlockStyle: CSSProperties = {
  flexDirection: 'column',
  gap: 12,
  display: 'flex',
  minWidth: 0,
}
/** plugin-manager `.toolbar` — the [refresh][add] cluster at the heading's right edge. */
const toolbarStyle: CSSProperties = {
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 16,
  display: 'flex',
}
/** plugin-manager `.iconButton` box and colour on the kit ghost Button (hover/focus come from the kit). */
const refreshButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  color: 'var(--dsw-alias-label-caption)',
}
/** plugin-manager `.iconButton:disabled`. */
const refreshButtonOffStyle: CSSProperties = { opacity: 0.5, cursor: 'default' }
/** plugin-manager `.iconWrap` around the refresh glyph. */
const iconWrapStyle: CSSProperties = { display: 'inline-flex' }
/** plugin-manager `.addButton` on the kit's primary `sm` Button (inline beats the kit class). */
const addButtonStyle: CSSProperties = {
  borderRadius: 'var(--dsw-radius-md)',
  height: 32,
  padding: '0 12px',
  fontSize: 13,
  lineHeight: '20px',
}
/** models `.rows` — the card list. */
const rowsStyle: CSSProperties = {
  flexDirection: 'column',
  gap: 8,
  margin: '12px 0 0',
  padding: 0,
  listStyle: 'none',
  display: 'flex',
}
/**
 * models `.rowCard` — one server card, with ONE stroke in every state
 * (collapsed, expanded, failed). The failure is carried by the red status chip
 * instead of a second border: a `border-color` declaration that cannot resolve
 * falls back to `currentColor`, which is what produced the stray light stroke.
 */
const rowCardStyle: CSSProperties = {
  border: '.5px solid var(--dsw-alias-settings-card-stroke)',
  background: 'var(--dsw-alias-settings-card-fill)',
  borderRadius: 'var(--dsw-radius-xl)',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 14px',
  display: 'flex',
}
/** models `.addCard` / `.setupCard` — the add form's card. */
const addCardStyle: CSSProperties = {
  borderRadius: 'var(--dsw-radius-lg)',
  background: 'var(--dsw-alias-bg-module-platform)',
  flexDirection: 'column',
  gap: 14,
  padding: '14px 16px',
  listStyle: 'none',
  display: 'flex',
}
/** models `.editor` — the panel an expanded card opens into. */
const editorStyle: CSSProperties = {
  borderRadius: 'var(--dsw-radius-lg)',
  background: 'var(--dsw-alias-bg-module-platform)',
  flexDirection: 'column',
  gap: 14,
  padding: '14px 16px',
  display: 'flex',
}
/** models `.addCard .editor` — the editor nested in the add card drops its own box. */
const nestedEditorStyle: CSSProperties = {
  borderRadius: 'var(--dsw-radius-lg)',
  background: '0 0',
  flexDirection: 'column',
  gap: 14,
  padding: 0,
  display: 'flex',
}
/** models `.rowHead` — identity plus actions, one centred row. */
const rowHeadStyle: CSSProperties = { alignItems: 'center', gap: 10, display: 'flex' }
/** models `.rowName` + inventory `.cardTitle` ellipsis. */
const rowNameStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  fontWeight: 500,
  lineHeight: '22px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
/** models `.rowActions` — the right-aligned control cluster (`margin-left:auto`). */
const rowActionsStyle: CSSProperties = { alignItems: 'center', gap: 4, marginLeft: 'auto', display: 'inline-flex' }
/** models `.rowIdentity` metrics on inventory `.cardContent` (a bare toggle button). */
const rowToggleStyle: CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  flex: 'auto',
  padding: 0,
  border: 0,
  background: '0 0',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
/** inventory `.chevron` + `[data-open=true]` rotation; `margin-left:auto` right-pushes it. */
const chevronWrapStyle: CSSProperties = {
  display: 'inline-flex',
  flex: 'none',
  marginLeft: 'auto',
  color: 'var(--dsw-alias-label-tertiary)',
}
/** inventory `.phaseDot` — the status dot's own slot. */
const dotSlotStyle: CSSProperties = { flex: 'none', display: 'inline-flex' }
/** inventory `.statusWithDot` (plus `.status,.failure`'s `margin:0`). */
const statusLineStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }
/** inventory `.status` — the loading line's sentence. */
const statusTextStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px' }
/** models `.error` — the page-level failure line. */
const errorLineStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
}
/** models `.savedNotice` — the page-level success line under the heading. */
const noticeStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary)',
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
}
/** models `.notice` — the same line for a result that needs attention. */
const noticeWarnStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-warn-label)',
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
}
/** models `.modelEmpty` — the empty-state box. */
const emptyBoxStyle: CSSProperties = {
  border: '1px dashed var(--dsw-alias-border-l3)',
  borderRadius: 'var(--dsw-radius-lg)',
  textAlign: 'center',
  padding: 12,
  color: 'var(--dsw-alias-label-tertiary)',
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
}
/** general `.actions` / models `.rowHead` — one centred row for mixed content. */
const footerStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
/** inventory `.cardDescription` scale on a path label. */
const footerPathStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', maxWidth: '100%' }
/** models `.field` — a label/control/hint stack (`min-width:0` from `.rowIdentity`). */
const fieldStyle: CSSProperties = { flexDirection: 'column', gap: 6, display: 'flex', flex: 1, minWidth: 0 }
/** models `.fieldLabel`. */
const labelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  alignItems: 'center',
  gap: 10,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: '18px',
  display: 'inline-flex',
}
/** models `.error` for the host's per-field message. */
const hintStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
}
/** models `.rowHead` gap 10 with `.modelRow`'s centred alignment between two field stacks. */
const fieldRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 }
/** models `.editorHeader` title side; `space-between` + `flex-start` are the user's instruction. */
const editorHeaderStyle: CSSProperties = {
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 8,
  display: 'flex',
}
const editorTitleStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  fontWeight: 500,
  lineHeight: '22px',
}
/**
 * models `.editorActions` — the footer's action cluster
 * (`justify-content:flex-end;gap:8px`).
 */
const formActionsStyle: CSSProperties = {
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 8,
  display: 'flex',
}
/** models `.input` tokens; the kit ships no textarea, so this is the one native control. */
const textareaStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 64,
  padding: '6px 10px',
  border: '.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  resize: 'vertical',
}
/** models `.dangerButton` colour on the kit's ghost button. */
const dangerButtonStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
/** models `.modelList` — the request-header rows. */
const headerListStyle: CSSProperties = { flexDirection: 'column', gap: 8, display: 'flex' }
/**
 * models `.modelRow` minus its chevron column: the header name, its value, and
 * the row's own action. The `>` control the models page keeps in the third
 * column is deliberately NOT reproduced — the row carries its delete alone, and
 * (per the user's read of the result on screen) so is that page's `.modelEntry`
 * frame: the rows here are the list's own items.
 */
const headerRowStyle: CSSProperties = {
  gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr) auto',
  alignItems: 'center',
  gap: 6,
  display: 'grid',
}
/** models `.iconButton`'s 28px box in the `.iconButtonDanger` colour, on the kit's ghost `sm` Button. */
const rowIconButtonStyle: CSSProperties = { ...refreshButtonStyle, ...dangerButtonStyle }
/** models `.addModelButton`'s placement on the kit's outline `sm` Button (its box is the kit's). */
const headerAddButtonStyle: CSSProperties = { alignSelf: 'flex-start' }

/**
 * The remove confirmation is the official models page's delete dialog: a 480px
 * panel with a hollow, danger-coloured confirm button. Neither property is
 * reachable through the kit alone — `Modal` takes only a `className`, and no
 * `Button` variant carries the danger palette — so the two rules live here
 * under this plugin's own class names. The kit's own class hashes are private
 * and are deliberately not targeted.
 */
const REMOVE_DIALOG_CSS = [
  'div.dsh-mcp-manager-remove-dialog{width:min(480px,100%)}',
  'button.dsh-mcp-manager-remove-confirm:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
  'button.dsh-mcp-manager-remove-confirm:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
].join('')

/** Owning element id of {@link REMOVE_DIALOG_CSS}; one sheet serves every mount. */
const REMOVE_DIALOG_STYLE_ID = 'dsh-mcp-manager-remove-dialog-style'

/** models `.warning`: the description row, flagged by the danger-tinted icon. */
const removeWarningStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 14,
  lineHeight: '22px',
}
/** models `.warningIcon`; `IconProps` has no `style`, so the glyph sits in a span. */
const removeWarningIconStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  marginTop: 2,
  color: 'var(--dsw-alias-state-error-primary)',
}
/** The kit's `RiskConfirmation` owns this reset; `Modal` does not. */
const removeWarningTextStyle: CSSProperties = { margin: 0 }
/** models `.error`, shown inside the dialog when the remove call fails. */
const removeErrorStyle: CSSProperties = {
  margin: '8px 0 0',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 12,
  lineHeight: '18px',
}

/**
 * Install {@link REMOVE_DIALOG_CSS} into the page once.
 * @returns disposer that removes the sheet, but only when this call added it.
 */
function ensureRemoveDialogStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(REMOVE_DIALOG_STYLE_ID) !== null) return () => {}
  const sheet = document.createElement('style')
  sheet.id = REMOVE_DIALOG_STYLE_ID
  sheet.textContent = REMOVE_DIALOG_CSS
  document.head.append(sheet)
  return () => { sheet.remove() }
}

/** `useLayoutEffect` on the client; the server render (the render harness) has no DOM. */
const useDomLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Keep the settings page's width constant while a card is expanded.
 *
 * The settings panel is a fixed 800px dialog whose `.wCInkW_options` column
 * (`flex:1; padding:0 24px 24px; overflow-y:auto`) is the scroll container our
 * page is rendered into: 800 − 188 (nav) − 48 (padding) leaves 564px, so the
 * page is never as wide as its own `max-width:720`. As soon as an expanded
 * editor makes the column taller than the dialog, Chromium adds a 15px classic
 * scrollbar and the column's client width drops to 597 — the page shrinks from
 * 564 to 549 with its left edge fixed, which is the visible "narrowing" (all
 * figures measured in .recon/panel-mock at DPR 1).
 *
 * The scroller belongs to the settings shell, not to this plugin, so the one
 * lever here is `scrollbar-gutter: stable` on it: the gutter is then reserved
 * whether or not a scrollbar is drawn, and the page keeps ONE width in both
 * states. The previous inline value is restored when the page unmounts.
 * @param ref - the page's root element.
 */
function useStablePageGutter(ref: RefObject<HTMLElement>): void {
  useDomLayoutEffect(() => {
    const root = ref.current
    if (root === null) return undefined
    for (let node = root.parentElement; node !== null; node = node.parentElement) {
      const overflowY = window.getComputedStyle(node).overflowY
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue
      const previous = node.style.scrollbarGutter
      node.style.scrollbarGutter = 'stable'
      return () => { node.style.scrollbarGutter = previous }
    }
    return undefined
  }, [ref])
}

/** Map a host/business error (or anything thrown) to localized copy. */
function errorMessage(error: unknown, t: TranslateNS<typeof NS>): string {
  if (error instanceof McpManagerRpcError) {
    switch (error.code) {
      case 'duplicate-id': return t('errDuplicateId')
      case 'duplicate-server-name': return t('errDuplicateName')
      case 'invalid-config': return t('errInvalidConfig')
      case 'bridge-missing': return t('errBridgeMissing')
      // Codes this panel has no copy for fall back to the host's own prose.
      default: return error.message.replace(/^[a-z-]+: /, '')
    }
  }
  if (error instanceof McpManagerTransportError) return `${t('errTransport')}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/** The one-line result a successful add/update leaves under the heading. */
type NoticeKey =
  | 'noticeOAuth'
  | 'noticeOAuthMissing'
  | 'noticePlain'
  | 'noticeUnknownAdd'
  | 'noticeUnknownEdit'

/** The notices that carry attention rather than a plain confirmation (models `.notice`). */
const WARN_NOTICES: readonly NoticeKey[] = [
  'noticeOAuthMissing',
  'noticeUnknownAdd',
  'noticeUnknownEdit',
]

/**
 * The notice a save result asks for, or `null` when the host reported nothing.
 * An OAuth endpoint this profile cannot serve is the loudest case; otherwise
 * `'unreachable'` reads differently for a new row (it went in as a plain
 * Streamable HTTP server) than for an edit (its owner is unchanged).
 * @param result - what the host reported about the written row.
 * @param added - whether this save created the row.
 */
function noticeOf(result: SaveResult | undefined, added: boolean): NoticeKey | null {
  if (result?.probe === 'oauth') {
    return result.oauthBridgeMissing === true ? 'noticeOAuthMissing' : 'noticeOAuth'
  }
  if (result?.probe === 'plain') return 'noticePlain'
  if (result?.probe === 'unreachable') return added ? 'noticeUnknownAdd' : 'noticeUnknownEdit'
  return null
}

/**
 * Derive the visual status of one server from its fiber phase. Every phase has
 * its own word, so the chip shows how far the connection has come instead of
 * collapsing the wait into one state. (Exported for the render harness.)
 */
export function statusOf(server: McpServerInfo): ServerStatus {
  if (!server.enabled) return { dot: 'idle', tone: 'neutral', key: 'statusDisabled' }
  switch (server.fiberPhase) {
    case 'active':
      // The fiber being active only means the mcp-client entry is running; the
      // MCP handshake succeeded only when tools are actually registered. The
      // bridge's `apply` awaits its *first* connection attempt alone
      // (`await connection.ready`, mcp-client:831) and tolerates its failure
      // when `failOnStartupError` is false, so a server that never connected
      // still reports an active fiber with zero tools while the bridge retries
      // in the background (500ms → 1s → 2s → 4s …, RECONNECT_DEFAULTS). That
      // whole wait has no fiber phase of its own, which is why it is named here
      // rather than folded into `statusLoading` or left as a bare tool count.
      // It must never render green: zero tools means not connected (e.g. HTTP
      // 401 / crash loop), not a healthy connection.
      return server.toolCount > 0
        ? { dot: 'done', tone: 'success', key: 'toolCount', count: String(server.toolCount) }
        : { dot: 'warning', tone: 'warning', key: 'statusNotConnected' }
    case 'failed':
      return { dot: 'error', tone: 'danger', key: 'statusFailed' }
    case 'loading':
      return { dot: 'ongoing', tone: 'warning', key: 'statusLoading' }
    case 'pending':
      return { dot: 'ongoing', tone: 'warning', key: 'statusPending' }
    case 'unloading':
      return { dot: 'ongoing', tone: 'warning', key: 'statusUnloading' }
    default:
      // `null`: the host knows the row but the loader has not built a fiber yet.
      return { dot: 'idle', tone: 'outline', key: 'statusNotLoaded' }
  }
}

/**
 * The MCP Manager settings page body.
 * @param props - the locale namespace's translate.
 */
export function McpManagerSection({ t }: SectionProps): JSX.Element {
  const pageRef = useRef<HTMLElement>(null)
  useStablePageGutter(pageRef)
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [patchInfo, setPatchInfo] = useState<PatchInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<McpServerInfo | null>(null)
  const [removingBusy, setRemovingBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<NoticeKey | null>(null)

  const anyExpanded = Object.values(expanded).some((open) => open === true)
  const formOpen = adding || anyExpanded
  const actionsDisabled = busy !== null || formOpen

  /**
   * Ids the user just removed. A loader entry is the authority for whether a
   * server exists — `listMcpServers` enumerates `ctx.loader.entries()` — and the
   * harness only drops that entry once its watcher has hot-reloaded
   * `cordis.patch.yml`, so the host keeps reporting the row for a while after
   * `remove` has already resolved. Hiding it here is what lets the card leave
   * together with the dialog; an id the host stops reporting is dropped from
   * the set again, so it never outlives the reload it papers over.
   */
  const hiddenRemovals = useRef<Set<string>>(new Set())

  /**
   * Read the host list. A quiet read — the stream nudge, every post-write read,
   * and the focus/visibility fallbacks — never touches `loading`/`error` and
   * keeps the last good snapshot when it fails, so a host that is mid-reload
   * right after a write cannot blank the panel.
   * @param options - `quiet: true` keeps the read silent.
   */
  const refresh = useCallback(async (options?: { quiet?: boolean }) => {
    const quiet = options?.quiet === true
    if (!quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      const { servers: list } = await callRpc<{ servers: McpServerInfo[] }>('list')
      const live = new Set(list.map((server) => server.id))
      for (const id of hiddenRemovals.current) {
        // The host stopped reporting the row: the reload landed, stop hiding.
        if (!live.has(id)) hiddenRemovals.current.delete(id)
      }
      const visible = list.filter((server) => !hiddenRemovals.current.has(server.id))
      setServers(visible)
      setExpanded((previous) => {
        // An editor can only be closed from its own card, so a flag whose card
        // is no longer listed would stay true forever: `formOpen` would then
        // keep the header's Add button disabled. Prune on every list so any
        // route to a vanished row — this panel's own removal, or the patch file
        // being edited elsewhere — cannot strand one.
        const listed = new Set(visible.map((server) => server.id))
        const kept = Object.entries(previous).filter(([id, open]) => open !== true || listed.has(id))
        return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept)
      })
      const { patch } = await callRpc<{ patch: PatchInfo }>('patchInfo')
      setPatchInfo(patch)
    } catch (err) {
      // A quiet read stays silent: the host can be reloading right after a write.
      if (!quiet) setError(errorMessage(err, t))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [t])

  /** The first read is the only loud one; later identity changes (locale) must not flash. */
  const initialised = useRef(false)
  useEffect(() => {
    if (initialised.current) return
    initialised.current = true
    void refresh()
  }, [refresh])

  /**
   * Live updates come from the host's event stream (`text/event-stream`), the
   * same way the harness's own HMR channel works: every frame is a nudge, so
   * the panel just runs the quiet read. The browser reconnects a dropped stream
   * on its own, so an error is deliberately ignored — and a build without
   * `EventSource` simply falls back to the focus/visibility reads below.
   */
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource(EVENT_CHANNEL)
    source.onmessage = () => { void refresh({ quiet: true }) }
    source.onerror = () => { /* the browser reconnects; the fallback reads cover the gap */ }
    return () => { source.close() }
  }, [refresh])

  /**
   * Belt and braces for a web build where the stream never connects: revalidate
   * whenever the window regains focus or the page becomes visible again.
   */
  useEffect(() => {
    const revalidate = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void refresh({ quiet: true })
    }
    const onVisibility = () => { revalidate() }
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', revalidate)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  /** The remove dialog's width and danger confirm button; see {@link REMOVE_DIALOG_CSS}. */
  useEffect(ensureRemoveDialogStyle, [])

  /**
   * Run one action behind the busy flag, then revalidate with a quiet read. A
   * new action retires the previous notice, so a stale result cannot outlive
   * the operation that produced it.
   */
  const run = useCallback(async (action: () => Promise<unknown>, label: string) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await action()
      await refresh({ quiet: true })
    } catch (err) {
      setError(errorMessage(err, t))
    } finally {
      setBusy(null)
    }
  }, [refresh, t])

  const displayName = useCallback(
    (server: McpServerInfo): string => server.serverName || t('unnamed'),
    [t],
  )

  const beginAdd = useCallback(() => setAdding(true), [])
  const closeAdd = useCallback(() => setAdding(false), [])
  const closeCard = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: false }))
  }, [])
  const toggleCard = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true }))
  }, [])

  const requestRemove = useCallback((server: McpServerInfo) => {
    setRemoveError(null)
    setRemoving(server)
  }, [])

  /**
   * Dismiss the remove dialog. Esc, the backdrop and the X all reach it through
   * `onCancel`, so one guard makes an operation in flight undismissible — the
   * same rule the official models dialog enforces with `if (deleting) return`.
   */
  const closeRemove = useCallback(() => {
    if (removingBusy) return
    setRemoving(null)
    setRemoveError(null)
  }, [removingBusy])

  /**
   * Remove the pending server. Unlike the other actions this one does not go
   * through {@link run}: the dialog has to stay open, with its confirm button
   * disabled and relabelled, for the whole round trip, so that completion and
   * the card's disappearance read as one event instead of a dialog closing onto
   * a list that still shows the row.
   *
   * The card is then hidden locally rather than waited for. `remove` only
   * rewrites the patch file and nudges the stream; the host's `list` answers
   * from the live loader, which keeps the row until the harness finishes
   * hot-reloading the file — so a post-write read cannot confirm the removal.
   */
  const confirmRemove = useCallback(() => {
    const target = removing
    if (target === null || removingBusy) return
    setRemovingBusy(true)
    setRemoveError(null)
    callRpc('remove', { id: target.id }).then(() => {
      hiddenRemovals.current.add(target.id)
      setServers((previous) => previous.filter((server) => server.id !== target.id))
      // The row is gone, so its editor can never be closed by hand again: the
      // card that owned it no longer renders. Leaving the flag set would keep
      // `formOpen` true forever, which disables the header's Add button and the
      // empty-state hint until the page is remounted.
      setExpanded((previous) => ({ ...previous, [target.id]: false }))
      setRemoving(null)
      void refresh({ quiet: true })
    }).catch((err: unknown) => {
      // Keep the dialog open on failure so retrying costs one click.
      setRemoveError(errorMessage(err, t))
    }).finally(() => {
      setRemovingBusy(false)
    })
  }, [refresh, removing, removingBusy, t])

  /** The add card saved: close it, re-read the list, then report the probe. */
  const savedAdd = useCallback(async (result?: SaveResult) => {
    // The host echoes the id it just wrote. Re-adding a server under the id of a
    // removal whose reload has not landed yet must un-hide it, or the new card
    // would be invisible until the next page load.
    if (result?.added !== undefined) hiddenRemovals.current.delete(result.added)
    setAdding(false)
    await run(() => Promise.resolve(), 'form:add')
    setNotice(noticeOf(result, true))
  }, [run])

  /** A card's form saved: collapse the card, re-read the list, then report the result. */
  const savedEdit = useCallback(async (id: string, result?: SaveResult) => {
    closeCard(id)
    await run(() => Promise.resolve(), `form:update:${id}`)
    setNotice(noticeOf(result, false))
  }, [closeCard, run])

  const toggleEnabled = useCallback((server: McpServerInfo) => {
    void run(
      () => callRpc('setEnabled', { id: server.id, enabled: !server.enabled }),
      `toggle:${server.id}`,
    )
  }, [run])

  const summary = useMemo(() => {
    const enabled = servers.filter((s) => s.enabled).length
    const connected = servers.filter((s) => s.enabled && s.fiberPhase === 'active' && s.toolCount > 0).length
    const failed = servers.filter((s) => s.enabled && s.fiberPhase === 'failed').length
    return { total: servers.length, enabled, connected, failed }
  }, [servers])

  /** models `.intro` sentence: total, connected, failures when any, enabled ratio. */
  const summaryText = useMemo(() => {
    const parts = [
      t('total', { count: String(summary.total) }),
      t('connected', { count: String(summary.connected) }),
    ]
    if (summary.failed > 0) parts.push(t('failed', { count: String(summary.failed) }))
    parts.push(t('enabledOf', { count: String(summary.enabled), total: String(summary.total) }))
    return parts.join(' · ')
  }, [summary, t])

  return (
    <section style={sectionStyle} ref={pageRef} data-mcp-manager-page="true">
      {/*
       * The 插件页 header: heading block on the left, `.toolbar` at the right
       * edge of the same row. Refresh is the kit's ghost Button wearing the
       * official icon-button box (hover from the kit's own `.ghost:hover`
       * token, focus from the platform), with the kit Tooltip, the glyph swap
       * while refreshing, and the add action as the kit's primary Button
       * wearing `.addButton` metrics.
       */}
      <header style={pageHeadStyle}>
        <div style={titleBlockStyle}>
          <h2 style={titleStyle}>{t('title')}</h2>
          <p style={introStyle}>{summaryText}</p>
        </div>

        <div style={toolbarStyle}>
          <Tooltip
            label={t('refresh')}
            delayMs={500}
            focusDelayMs={500}
            side="bottom"
            portal
            disabled={loading || busy !== null}
          >
            <Button
              variant="ghost"
              size="sm"
              style={loading || busy !== null ? { ...refreshButtonStyle, ...refreshButtonOffStyle } : refreshButtonStyle}
              aria-label={t('refresh')}
              aria-busy={loading}
              disabled={loading || busy !== null}
              onClick={() => { setNotice(null); void refresh() }}
            >
              <span style={iconWrapStyle} aria-hidden="true">
                {loading ? <StateDot state="ongoing" size={18} /> : <IconRefreshOutlineRegular />}
              </span>
            </Button>
          </Tooltip>
          <Button
            variant="primary"
            size="sm"
            style={addButtonStyle}
            icon={<IconPlusOutlineRegular size={13} />}
            onClick={beginAdd}
            disabled={busy !== null || formOpen}
          >
            {t('addMcp')}
          </Button>
        </div>
      </header>

      {error !== null ? <p style={errorLineStyle} role="alert">{error}</p> : null}

      {notice !== null ? (
        <p style={WARN_NOTICES.includes(notice) ? noticeWarnStyle : noticeStyle} role="status">
          {t(notice)}
        </p>
      ) : null}

      {loading && servers.length === 0 && !formOpen ? (
        <p style={statusLineStyle} role="status">
          <span style={dotSlotStyle}><StateDot state="ongoing" size={10} /></span>
          <span style={statusTextStyle}>{t('loading')}</span>
        </p>
      ) : null}

      {!loading && servers.length === 0 && !formOpen ? (
        <p style={emptyBoxStyle}>
          {t('empty')} {t('emptyHint')}
        </p>
      ) : null}

      <ul style={rowsStyle}>
        {adding ? (
          <li style={addCardStyle} key="add">
            <div style={nestedEditorStyle}>
              <ServerForm
                t={t}
                initial={undefined}
                busy={busy !== null}
                onCancel={closeAdd}
                onSaved={savedAdd}
              />
            </div>
          </li>
        ) : null}

        {servers.map((server) => {
          const status = statusOf(server)
          const statusText = t(status.key, status.count !== undefined ? { count: status.count } : undefined)
          const open = expanded[server.id] === true
          const failed = server.enabled && server.fiberPhase === 'failed'
          // The host alone knows whether this row's bridge resolves; when it does
          // not, the row was written disabled and the host refuses to switch it on.
          const bridgeMissing = server.bridgeMissing === true
          const regionId = `mcp-details-${server.id}`
          return (
            <li
              style={rowCardStyle}
              key={server.id}
              data-open={open ? 'true' : undefined}
              data-failed={failed ? 'true' : undefined}
            >
              <div style={rowHeadStyle}>
                {/*
                 * The title area is the disclosure toggle (inventory
                 * `cardContent` as a bare button): name, then the identity
                 * chips — status/tools, transport — and the chevron. The
                 * transport chip is a written-down property of the row and
                 * never changes with the connection; the status chip walks
                 * every phase the fiber goes through. The enable Switch lives
                 * outside in `rowActions`, so a collapsed card stays toggleable
                 * and clicking the Switch never toggles the card. 删除 belongs
                 * to the inner panel's header.
                 */}
                <button
                  type="button"
                  style={rowToggleStyle}
                  aria-expanded={open}
                  aria-controls={open ? regionId : undefined}
                  onClick={() => toggleCard(server.id)}
                >
                  <span style={rowNameStyle}>{displayName(server)}</span>
                  <Tag tone={status.tone}>{statusText}</Tag>
                  <Tag tone="neutral">{TRANSPORT_LABELS[server.transport]}</Tag>
                  <span style={{ ...chevronWrapStyle, transform: open ? 'rotate(180deg)' : 'none' }}>
                    <IconChevronDownOutlineRegular size={12} />
                  </span>
                </button>

                {/*
                 * The tooltip's anchor is the whole `rowActions` span, not the
                 * Switch: a disabled button fires no pointer events, so a tooltip
                 * anchored on it could never explain why the row cannot be
                 * switched on. The bubble is portaled, so the row's layout (and
                 * the span's `margin-left:auto`) is unchanged.
                 */}
                <Tooltip
                  label={t('switchBridgeMissing')}
                  side="bottom"
                  align="end"
                  delayMs={500}
                  focusDelayMs={500}
                  portal
                  disabled={!bridgeMissing}
                >
                  <span style={rowActionsStyle}>
                    <Switch
                      checked={server.enabled}
                      label={t('enable')}
                      title={server.enabled ? t('disable') : t('enable')}
                      disabled={actionsDisabled || bridgeMissing}
                      onChange={() => toggleEnabled(server)}
                    />
                  </span>
                </Tooltip>
              </div>

              {open ? (
                <div style={editorStyle} id={regionId}>
                  <ServerForm
                    t={t}
                    initial={server}
                    busy={busy !== null}
                    onRemove={() => requestRemove(server)}
                    onCancel={() => closeCard(server.id)}
                    onSaved={(result) => void savedEdit(server.id, result)}
                  />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      {patchInfo !== null ? (
        <div style={footerStyle}>
          {patchInfo.exists ? null : <Tag tone="warning">{t('patchMissing')}</Tag>}
          <PathLabel path={patchInfo.path} style={footerPathStyle} />
        </div>
      ) : null}

      <RemoveConfirmation
        t={t}
        target={removing}
        busy={removingBusy}
        locked={busy !== null}
        failure={removeError}
        onCancel={closeRemove}
        onConfirm={confirmRemove}
      />
    </section>
  )
}

/** Props of {@link RemoveConfirmation}. */
export interface RemoveConfirmationProps {
  t: TranslateNS<typeof NS>
  /** The row awaiting confirmation; `null` keeps the dialog closed. */
  target: McpServerInfo | null
  /** A remove RPC is in flight: the actions lock and the confirm label says so. */
  busy: boolean
  /** Another panel action is running, which locks this dialog too. */
  locked: boolean
  /** Text from a failed attempt, shown inside the dialog. */
  failure: string | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * The remove confirmation.
 *
 * Built from the kit's `Modal` rather than its `RiskConfirmation`: that
 * component hard-codes a `primary` (filled) confirm button with a 136px floor,
 * which is what made this dialog's delete button wider and bluer than the
 * official one. This mirrors the models page instead — an outline Button in the
 * danger palette, initial focus parked on the safe action, and a cancel that
 * refuses while the call is in flight.
 *
 * The dialog is held open for the whole round trip and closed by the caller in
 * the same batch that drops the card, so the two read as one event.
 * @param props - see {@link RemoveConfirmationProps}.
 */
export function RemoveConfirmation({
  t,
  target,
  busy,
  locked,
  failure,
  onCancel,
  onConfirm,
}: RemoveConfirmationProps) {
  const name = target !== null && target.serverName !== '' ? target.serverName : t('unnamed')
  return (
    <Modal
      open={target !== null}
      onClose={onCancel}
      title={t('removeTitle')}
      closeLabel={t('cancel')}
      className="dsh-mcp-manager-remove-dialog"
      footer={(
        <>
          <Button variant="outline" data-modal-autofocus disabled={locked || busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            variant="outline"
            className="dsh-mcp-manager-remove-confirm"
            disabled={locked || busy}
            onClick={onConfirm}
          >
            {busy ? t('removing', { name }) : t('remove')}
          </Button>
        </>
      )}
    >
      <div style={removeWarningStyle}>
        <span style={removeWarningIconStyle}>
          <IconWarningOutlineRegular size={18} />
        </span>
        <p style={removeWarningTextStyle}>{t('removeDesc', { name, id: target?.id ?? '' })}</p>
      </div>
      {failure === null ? null : <p style={removeErrorStyle}>{failure}</p>}
    </Modal>
  )
}

interface ServerFormProps {
  t: TranslateNS<typeof NS>
  /** Absent for the add form; the row being edited otherwise. */
  initial?: McpServerInfo | undefined
  busy: boolean
  /** Edit only: open the remove confirmation (panel header, right). */
  onRemove?: (() => void) | undefined
  onCancel: () => void
  /** Saved: what the host reported back about the written row. */
  onSaved: (result?: SaveResult) => void
}

/**
 * What the host reports about a row it just wrote: how it classified the
 * endpoint (`probe`), and — when that classification needs the OAuth bridge —
 * whether this profile actually has it installed.
 */
interface SaveResult {
  /** The id the host wrote, echoed by `add` only. */
  added?: string
  probe?: McpOAuthProbe
  oauthBridgeMissing?: boolean
}

/** One editable request header: the two inputs of a row. */
interface HeaderRow {
  key: string
  value: string
}

interface FormState {
  id: string
  serverName: string
  transport: McpTransport
  url: string
  command: string
  argsText: string
  envText: string
  cwd: string
  headers: HeaderRow[]
  toolCallTimeoutMs: string
  /**
   * The bridges' "fail on startup error" switch. It has no control any more —
   * a new server always takes the bridges' own `false` default (the key is
   * omitted) — but an existing row that states `true` keeps it through an
   * unrelated edit instead of being silently reset.
   */
  failOnStartupError: boolean
}

/** One blank header row: a form always opens with at least one place to type. */
const EMPTY_HEADER: HeaderRow = { key: '', value: '' }

const EMPTY_FORM: FormState = {
  id: '',
  serverName: '',
  transport: 'streamable-http',
  url: '',
  command: '',
  argsText: '',
  envText: '',
  cwd: '',
  headers: [EMPTY_HEADER],
  toolCallTimeoutMs: '',
  failOnStartupError: false,
}

/**
 * The draft the form opens on. (Exported for the render harness.)
 * @param server - the row being edited, absent for the add form.
 */
export function toForm(server: McpServerInfo | undefined): FormState {
  if (server === undefined) return EMPTY_FORM
  const headers = Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value }))
  return {
    id: server.id,
    serverName: server.serverName,
    transport: server.transport,
    url: server.url ?? '',
    command: server.command ?? '',
    argsText: (server.args ?? []).join('\n'),
    envText: (server.env !== undefined ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`) : []).join('\n'),
    cwd: server.cwd ?? '',
    headers: headers.length > 0 ? headers : [EMPTY_HEADER],
    toolCallTimeoutMs: server.toolCallTimeoutMs !== undefined ? String(server.toolCallTimeoutMs) : '',
    failOnStartupError: server.failOnStartupError === true,
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
}

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

function parsePairs(text: string): Record<string, string> | undefined {
  const lines = splitLines(text)
  if (lines.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const line of lines) {
    const eq = line.indexOf('=')
    const colon = line.indexOf(':')
    const sep = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon)
    if (sep <= 0) continue
    out[stripQuotes(line.slice(0, sep))] = stripQuotes(line.slice(sep + 1))
  }
  return out
}

/**
 * Build the wire config from the draft. Only the fields the panel shows travel;
 * the host validates them and preserves every other key of an existing row
 * (the OAuth bridge's `credentialRef`, `scope`, `callbackPort`, …).
 *
 * `transport` always travels, because the host routes a row by it. The OAuth
 * bridge has no `transport` field of its own, so the host projects the config
 * onto the bridge's schema and drops the key there.
 * @param form - the current draft.
 * @returns the config payload. (Exported for the render harness.)
 */
export function toConfig(form: FormState): McpServerConfig {
  const config: McpServerConfig = {
    serverName: form.serverName.trim(),
    transport: form.transport,
  }
  if (form.transport === 'stdio') {
    if (form.command.trim() !== '') config.command = form.command.trim()
    const args = splitLines(form.argsText)
    if (args.length > 0) config.args = args
    const env = parsePairs(form.envText)
    if (env !== undefined) config.env = env
    if (form.cwd.trim() !== '') config.cwd = form.cwd.trim()
  } else {
    if (form.url.trim() !== '') config.url = form.url.trim()
  }
  // A row without a name is just a blank line the form keeps for typing, so it
  // is dropped; a name typed twice keeps the last value, in row order.
  const headers: Record<string, string> = {}
  for (const row of form.headers) {
    const name = row.key.trim()
    if (name !== '') headers[name] = row.value.trim()
  }
  if (Object.keys(headers).length > 0) config.headers = headers
  if (form.toolCallTimeoutMs.trim() !== '' && Number.isFinite(Number(form.toolCallTimeoutMs))) {
    config.toolCallTimeoutMs = Number(form.toolCallTimeoutMs)
  }
  // Only a preserved `true` travels: a new server leaves the key out and takes
  // the bridge's own (`false`) default.
  if (form.failOnStartupError) config.failOnStartupError = true
  return config
}

/** A labelled field: label, control, and the host's validation hint for it. */
function Field({ labelFor, label, hint, style, children }: {
  /** Id of the control this label names; omitted when the control owns no such id. */
  labelFor?: string | undefined
  label: string
  hint?: string | undefined
  /** Extra placement for this field, merged over the shared stack. */
  style?: CSSProperties | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <div style={{ ...fieldStyle, ...style }}>
      {labelFor === undefined
        ? <span style={labelStyle}>{label}</span>
        : <label style={labelStyle} htmlFor={labelFor}>{label}</label>}
      {children}
      {hint !== undefined ? <p style={hintStyle}>{hint}</p> : null}
    </div>
  )
}

/**
 * Add/edit server form built from the kit's Input, Button and SegmentedControl
 * plus the one native control the kit does not ship (the args/env textareas).
 * When editing, the id field is locked.
 *
 * Request headers are a row list (models `ModelListEditor` without its chevron
 * column): each row is a name input, a value input and its delete action, and
 * the list's add action sits under it. A name-less row is a blank line the form
 * keeps for typing, never a written key; a value is taken verbatim, so a `:` or
 * `=` inside it can no longer be misread.
 *
 * Both forms carry the same two transport choices: which bridge package
 * implements a choice is the manager's business, and streamable-http always
 * goes to the OAuth bridge, which authorizes only when the server asks. An
 * existing row's other keys are the host's to preserve.
 *
 * Validation is the host's: the submit sends the draft and renders whatever
 * field errors come back (`McpManagerRpcError.fields`), so the panel never
 * keeps a second copy of the bridge package's schema rules.
 *
 * @param props - form context and callbacks.
 * @returns the form panel: header row (title + remove), fields, footer.
 */
export function ServerForm({
  t,
  initial,
  busy,
  onRemove,
  onCancel,
  onSaved,
}: ServerFormProps): JSX.Element {
  const editing = initial !== undefined
  const [form, setForm] = useState<FormState>(() => toForm(initial))
  const [fieldErrors, setFieldErrors] = useState<McpFieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /** Replace one header row's field; the list itself is replaced, never mutated. */
  const setHeader = (index: number, patch: Partial<HeaderRow>): void => {
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    }))
  }

  const addHeader = (): void => {
    setForm((prev) => ({ ...prev, headers: [...prev.headers, EMPTY_HEADER] }))
  }

  const removeHeader = (index: number): void => {
    setForm((prev) => ({ ...prev, headers: prev.headers.filter((_, at) => at !== index) }))
  }

  const submit = async (): Promise<void> => {
    setSaving(true)
    setSubmitError(null)
    setFieldErrors({})
    try {
      const payload = { id: form.id.trim(), config: toConfig(form) }
      // The host classifies the endpoint while it writes the row; an older host
      // simply leaves the fields out and the panel shows no notice.
      const reply = await callRpc<SaveResult>(editing ? 'update' : 'add', payload)
      onSaved(reply)
    } catch (err) {
      setFieldErrors(err instanceof McpManagerRpcError ? err.fields ?? {} : {})
      setSubmitError(errorMessage(err, t))
    } finally {
      setSaving(false)
    }
  }

  const err = (key: keyof McpFieldErrors): string | undefined => fieldErrors[key]
  const locked = saving || busy

  return (
    <>
      <div style={editorHeaderStyle}>
        <span style={editorTitleStyle}>
          {editing ? t('formEditTitle', { name: initial.serverName }) : t('formAddTitle')}
        </span>
        {onRemove !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            style={dangerButtonStyle}
            icon={<IconTrashOutlineRegular size={14} />}
            onClick={onRemove}
            disabled={locked}
          >
            {t('remove')}
          </Button>
        ) : null}
      </div>

      <div style={fieldRowStyle}>
        <Field labelFor="dshmcp-id" label={t('fieldId')} hint={err('id')}>
          <Input
            id="dshmcp-id"
            value={form.id}
            placeholder="mcp-github"
            spellCheck={false}
            aria-invalid={err('id') !== undefined}
            disabled={editing || locked}
            onChange={(e) => set('id', e.target.value)}
          />
        </Field>
        <Field labelFor="dshmcp-server" label={t('fieldServerName')} hint={err('serverName')}>
          <Input
            id="dshmcp-server"
            value={form.serverName}
            placeholder="github"
            spellCheck={false}
            aria-invalid={err('serverName') !== undefined}
            disabled={locked}
            onChange={(e) => set('serverName', e.target.value)}
          />
        </Field>
      </div>

      <Field label={t('fieldTransport')} hint={err('transport')}>
        <SegmentedControl
          id="dshmcp-transport"
          value={form.transport}
          options={TRANSPORT_OPTIONS}
          onChange={(next) => set('transport', next)}
          label={t('fieldTransport')}
          disabled={locked}
        />
      </Field>

      {form.transport !== 'stdio' ? (
        <Field labelFor="dshmcp-url" label={t('fieldUrl')} hint={err('url')}>
          <Input
            id="dshmcp-url"
            value={form.url}
            placeholder="http://127.0.0.1:3000/mcp"
            spellCheck={false}
            aria-invalid={err('url') !== undefined}
            disabled={locked}
            onChange={(e) => set('url', e.target.value)}
          />
        </Field>
      ) : (
        <>
          <Field labelFor="dshmcp-command" label={t('fieldCommand')} hint={err('command')}>
            <Input
              id="dshmcp-command"
              value={form.command}
              placeholder="npx"
              spellCheck={false}
              aria-invalid={err('command') !== undefined}
              disabled={locked}
              onChange={(e) => set('command', e.target.value)}
            />
          </Field>
          <Field labelFor="dshmcp-args" label={t('fieldArgs')} hint={err('args')}>
            <textarea
              id="dshmcp-args"
              style={textareaStyle}
              rows={3}
              value={form.argsText}
              placeholder={'-y\n@modelcontextprotocol/server-github'}
              spellCheck={false}
              disabled={locked}
              onChange={(e) => set('argsText', e.target.value)}
            />
          </Field>
          <Field labelFor="dshmcp-env" label={t('fieldEnv')} hint={err('env')}>
            <textarea
              id="dshmcp-env"
              style={textareaStyle}
              rows={3}
              value={form.envText}
              placeholder="GITHUB_TOKEN=ghp_xxx"
              spellCheck={false}
              disabled={locked}
              onChange={(e) => set('envText', e.target.value)}
            />
          </Field>
          <Field labelFor="dshmcp-cwd" label={t('fieldCwd')} hint={err('cwd')}>
            <Input
              id="dshmcp-cwd"
              value={form.cwd}
              spellCheck={false}
              aria-invalid={err('cwd') !== undefined}
              disabled={locked}
              onChange={(e) => set('cwd', e.target.value)}
            />
          </Field>
        </>
      )}

      {/*
       * models `ModelListEditor` without its `.modelEntry` frame: each header is
       * one `.modelRow` grid and a direct item of the list, then the add action
       * aligned to the field's left edge. Our row also drops the chevron column.
       */}
      <Field label={t('fieldHeaders')} hint={err('headers')}>
        <div style={headerListStyle}>
          {form.headers.map((row, index) => (
            <div style={headerRowStyle} key={index}>
              <Input
                value={row.key}
                placeholder="Authorization"
                aria-label={`${t('headerName')} ${String(index + 1)}`}
                spellCheck={false}
                disabled={locked}
                onChange={(e) => setHeader(index, { key: e.target.value })}
              />
              <Input
                value={row.value}
                placeholder="Bearer xxx"
                aria-label={`${t('headerValue')} ${String(index + 1)}`}
                spellCheck={false}
                disabled={locked}
                onChange={(e) => setHeader(index, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                style={rowIconButtonStyle}
                icon={<IconTrashOutlineRegular size={14} />}
                aria-label={`${t('remove')} ${String(index + 1)}`}
                title={t('remove')}
                disabled={locked}
                onClick={() => removeHeader(index)}
              />
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          style={headerAddButtonStyle}
          icon={<IconPlusOutlineRegular size={14} />}
          disabled={locked}
          onClick={addHeader}
        >
          {t('addHeader')}
        </Button>
      </Field>

      <Field labelFor="dshmcp-timeout" label={t('fieldTimeout')} hint={err('toolCallTimeoutMs')}>
        <Input
          id="dshmcp-timeout"
          value={form.toolCallTimeoutMs}
          inputMode="numeric"
          placeholder="60000"
          aria-invalid={err('toolCallTimeoutMs') !== undefined}
          disabled={locked}
          onChange={(e) => set('toolCallTimeoutMs', e.target.value.replace(/[^0-9]/g, ''))}
        />
      </Field>

      {submitError !== null ? <p style={errorLineStyle} role="alert">{submitError}</p> : null}

      {/*
       * models `.editorActions` (`justify-content:flex-end;gap:8px`): one 28px
       * action row on the kit's `sm` Button, the row scale the panel already
       * uses for its chrome. The 14px gap above it is the editor column's own
       * `gap` (models `.editor`), exactly as there.
       */}
      <div style={formActionsStyle}>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={saving ? <StateDot state="ongoing" size={14} /> : undefined}
          onClick={() => void submit()}
          disabled={locked}
        >
          {/* Both forms save: the add card is a form's save, not a page action. */}
          {t('save')}
        </Button>
      </div>
    </>
  )
}
