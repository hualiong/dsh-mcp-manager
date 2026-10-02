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
 * The card header carries the whole identity — name, transport chip, status
 * chip, OAuth chip, chevron — plus the enable Switch and the remove action, so
 * a collapsed card is still fully operable. Expanding a card IS editing it:
 * the disclosure panel mounts the edit form directly (there is no read-only
 * body left to show), and the form's footer holds [测试][取消][保存].
 *
 * The transcript-facing `DisclosureRow` primitive is deliberately NOT used:
 * its contract is a 24px tertiary process row, so it cannot carry the
 * settings-page title scale or host the row's controls.
 *
 * Controls come from the official kit
 * (`@deepseek-ai/dsh-client-ui-primitives`): Button (`md` = the page's 36px
 * actions, `sm` = the row's 28px actions), Input, Switch, Tag, StateDot,
 * SegmentedControl, Checkbox, Tooltip, RiskConfirmation, PathLabel and the
 * product icons. The only styles this module owns are inline declarations
 * carrying those official values — the kit ships no layout primitives and this
 * package has no CSS file.
 *
 * Copy is fully localized (zh/en); the renderer hands the registered `locale:`
 * namespace's `t` seat in as a prop, so the page follows the active GUI
 * language without subscribing to locale state itself.
 *
 * @module dsh-mcp-manager/client/McpManagerSection
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  Checkbox,
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  PathLabel,
  RiskConfirmation,
  SegmentedControl,
  StateDot,
  Switch,
  Tag,
  Tooltip,
  type SegmentedControlOption,
  type StateDotState,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { MCP_OAUTH_CLIENT_PACKAGE } from '../shared.ts'
import type {
  McpFieldErrors,
  McpProbeResult,
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
 * itself, so that case reuses the `toolCount` sentence.
 */
type StatusKey =
  | 'toolCount'
  | 'statusActiveNoTools'
  | 'statusFailed'
  | 'statusDisabled'
  | 'statusLoading'
  | 'statusPending'
  | 'statusUnloading'
  | 'statusNotLoaded'

/** Card status: the dot's semantic, the tag's palette, and the copy key. */
interface ServerStatus {
  dot: StateDotState
  tone: TagTone
  key: StatusKey
  count?: string
}

/** Transport names as the header chip and the form's selector both read them. */
const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'STDIO',
  'streamable-http': 'Streamable HTTP',
}

const TRANSPORT_OPTIONS: readonly SegmentedControlOption<McpTransport>[] = [
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
/** inventory `.status` — the probe sentence. */
const statusTextStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px' }
/** inventory `.failure` — the probe failure colour on the same 13/20 scale. */
const failureStyle: CSSProperties = { ...statusTextStyle, color: 'var(--dsw-alias-state-error-primary)' }
/** models `.error` — the page-level failure line. */
const errorLineStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
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
/** models `.editorActions`' `space-between` idiom for the 超时 / 报错 row: field left, choices right. */
const timeoutRowStyle: CSSProperties = { justifyContent: 'space-between', alignItems: 'center', display: 'flex' }
/** The 超时 field takes half the row so the choices row can sit flush at the right end. */
const timeoutFieldStyle: CSSProperties = { flex: '0 1 50%' }
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
/** models `.editorActions` — the footer row split so 测试 sits alone on the left. */
const formActionsStyle: CSSProperties = { justifyContent: 'space-between', alignItems: 'center', display: 'flex' }
/** models `.editorActions` cluster (`justify-content:flex-end;gap:8px`) on the footer's right. */
const formActionsEndStyle: CSSProperties = {
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 8,
  marginLeft: 'auto',
  display: 'flex',
}
/** models `.modelInputChoices`, bottom-aligned against the labelled input's 32px box. */
const checkboxCellStyle: CSSProperties = {
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 16,
  minHeight: 32,
  alignSelf: 'flex-end',
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

/** Map a host/business error (or anything thrown) to localized copy. */
function errorMessage(error: unknown, t: TranslateNS<typeof NS>): string {
  if (error instanceof McpManagerRpcError) {
    switch (error.code) {
      case 'duplicate-id': return t('errDuplicateId')
      case 'duplicate-server-name': return t('errDuplicateName')
      case 'invalid-config': return t('errInvalidConfig')
      case 'not-found': return t('errNotFound')
      // Codes this panel has no copy for fall back to the host's own prose.
      default: return error.message.replace(/^[a-z-]+: /, '')
    }
  }
  if (error instanceof McpManagerTransportError) return `${t('errTransport')}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/** Derive the visual status of one server. */
function statusOf(server: McpServerInfo): ServerStatus {
  if (!server.enabled) return { dot: 'idle', tone: 'neutral', key: 'statusDisabled' }
  switch (server.fiberPhase) {
    case 'active':
      // The fiber being active only means the mcp-client entry is running;
      // the MCP handshake succeeded only when tools are actually registered.
      // A connected server reports its tool count alone; with zero tools the
      // server is effectively not connected, so it must never render green
      // (that would mislead users into thinking the connection is healthy
      // when it failed, e.g. HTTP 401 / crash loop).
      return server.toolCount > 0
        ? { dot: 'done', tone: 'success', key: 'toolCount', count: String(server.toolCount) }
        : { dot: 'warning', tone: 'warning', key: 'statusActiveNoTools' }
    case 'failed':
      return { dot: 'error', tone: 'danger', key: 'statusFailed' }
    case 'loading':
      return { dot: 'ongoing', tone: 'warning', key: 'statusLoading' }
    case 'pending':
      return { dot: 'ongoing', tone: 'warning', key: 'statusPending' }
    case 'unloading':
      return { dot: 'ongoing', tone: 'warning', key: 'statusUnloading' }
    default:
      return { dot: 'idle', tone: 'outline', key: 'statusNotLoaded' }
  }
}

/**
 * The MCP Manager settings page body.
 * @param props - the locale namespace's translate.
 */
export function McpManagerSection({ t }: SectionProps): JSX.Element {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [patchInfo, setPatchInfo] = useState<PatchInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({})
  const [removing, setRemoving] = useState<McpServerInfo | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const anyExpanded = Object.values(expanded).some((open) => open === true)
  const formOpen = adding || anyExpanded
  const actionsDisabled = busy !== null || formOpen

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { servers: list } = await callRpc<{ servers: McpServerInfo[] }>('list')
      setServers(list)
      const { patch } = await callRpc<{ patch: PatchInfo }>('patchInfo')
      setPatchInfo(patch)
    } catch (err) {
      setError(errorMessage(err, t))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  const run = useCallback(async (action: () => Promise<unknown>, label: string) => {
    setBusy(label)
    setError(null)
    try {
      await action()
      await refresh()
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

  const toggleEnabled = useCallback((server: McpServerInfo) => {
    void run(
      () => callRpc('setEnabled', { id: server.id, enabled: !server.enabled }),
      `toggle:${server.id}`,
    )
  }, [run])

  const testConnection = useCallback((server: McpServerInfo) => {
    void run(async () => {
      const result = await callRpc<McpProbeResult>('probe', { id: server.id })
      setProbes((prev) => ({ ...prev, [server.id]: result }))
    }, `probe:${server.id}`)
  }, [run])

  const beginAdd = useCallback(() => setAdding(true), [])
  const closeAdd = useCallback(() => setAdding(false), [])
  const closeCard = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: false }))
  }, [])
  const toggleCard = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true }))
  }, [])

  const requestRemove = useCallback((server: McpServerInfo) => {
    setAcknowledged(false)
    setRemoving(server)
  }, [])

  const confirmRemove = useCallback(() => {
    const target = removing
    if (target === null) return
    setRemoving(null)
    void run(() => callRpc('remove', { id: target.id }), `remove:${target.id}`)
  }, [removing, run])

  /**
   * One delayed re-read (~800ms) after a save: the immediate read returns as
   * soon as the patch file is written, while the live fiber's status needs a
   * moment to settle. A single retry, never a polling loop.
   */
  const refreshSoon = useCallback(() => {
    window.setTimeout(() => { void refresh() }, 800)
  }, [refresh])

  /** The add card saved: close it, then re-read the host list. */
  const savedAdd = useCallback(() => {
    setAdding(false)
    void run(() => Promise.resolve(), 'form:add')
    refreshSoon()
  }, [refreshSoon, run])

  /** A card's form saved: collapse the card, then re-read the host list. */
  const savedEdit = useCallback((id: string) => {
    closeCard(id)
    void run(() => Promise.resolve(), `form:update:${id}`)
    refreshSoon()
  }, [closeCard, refreshSoon, run])

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
    <section style={sectionStyle}>
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
              onClick={() => void refresh()}
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
          const probe = probes[server.id]
          const probing = busy === `probe:${server.id}`
          const failed = server.enabled && server.fiberPhase === 'failed'
          const oauth = server.ownerPackage === MCP_OAUTH_CLIENT_PACKAGE
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
                 * chips — status/tools, transport, OAuth — and the chevron.
                 * The enable Switch lives outside it in `rowActions`, so a
                 * collapsed card stays toggleable and clicking the Switch never
                 * toggles the card. 删除 belongs to the inner panel's header.
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
                  {oauth ? <Tag tone="info">OAuth</Tag> : null}
                  <span style={{ ...chevronWrapStyle, transform: open ? 'rotate(180deg)' : 'none' }}>
                    <IconChevronDownOutlineRegular size={12} />
                  </span>
                </button>

                <span style={rowActionsStyle}>
                  <Switch
                    checked={server.enabled}
                    label={t('enable')}
                    title={server.enabled ? t('disable') : t('enable')}
                    disabled={actionsDisabled}
                    onChange={() => toggleEnabled(server)}
                  />
                </span>
              </div>

              {open ? (
                <div style={editorStyle} id={regionId}>
                  <ServerForm
                    t={t}
                    initial={server}
                    oauth={oauth}
                    busy={busy !== null}
                    probe={probe}
                    probing={probing}
                    onTest={() => testConnection(server)}
                    onRemove={() => requestRemove(server)}
                    removeLabel={server.userManaged ? t('remove') : t('bundleDefined')}
                    onCancel={() => closeCard(server.id)}
                    onSaved={() => savedEdit(server.id)}
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

      <RiskConfirmation
        open={removing !== null}
        title={t('removeTitle')}
        description={t('removeDesc', {
          name: removing !== null ? displayName(removing) : '',
          id: removing?.id ?? '',
        })}
        acknowledgeLabel={t('removeAck')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={t('remove')}
        acknowledged={acknowledged}
        disabled={busy !== null}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => setRemoving(null)}
        onConfirm={confirmRemove}
      />
    </section>
  )
}

interface ServerFormProps {
  t: TranslateNS<typeof NS>
  /** Absent for the add form; the row being edited otherwise. */
  initial?: McpServerInfo | undefined
  /** The row is owned by the OAuth bridge: its transport is fixed, so the selector is hidden. */
  oauth?: boolean | undefined
  busy: boolean
  /** Latest probe of this server, shown inside the panel. */
  probe?: McpProbeResult | undefined
  probing?: boolean | undefined
  /** Edit only: run the connectivity test (footer, left). */
  onTest?: (() => void) | undefined
  /** Edit only: open the remove confirmation (panel header, right). */
  onRemove?: (() => void) | undefined
  /** Tooltip of the header's remove action: the action, or why the row is bundle-owned. */
  removeLabel?: string | undefined
  onCancel: () => void
  onSaved: () => void
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
  headersText: string
  toolCallTimeoutMs: string
  failOnStartupError: boolean
  /** OAuth rows only: the credential reference the bridge stores its OAuth state under. */
  credentialRef: string
  /** OAuth rows only: the loopback callback port (`0` = OS-assigned). */
  callbackPort: string
}

const EMPTY_FORM: FormState = {
  id: '',
  serverName: '',
  transport: 'streamable-http',
  url: '',
  command: '',
  argsText: '',
  envText: '',
  cwd: '',
  headersText: '',
  toolCallTimeoutMs: '',
  failOnStartupError: false,
  credentialRef: '',
  callbackPort: '',
}

function toForm(server: McpServerInfo | undefined): FormState {
  if (server === undefined) return EMPTY_FORM
  return {
    id: server.id,
    serverName: server.serverName,
    transport: server.transport,
    url: server.url ?? '',
    command: server.command ?? '',
    argsText: (server.args ?? []).join('\n'),
    envText: (server.env !== undefined ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`) : []).join('\n'),
    cwd: server.cwd ?? '',
    headersText: (server.headers !== undefined ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`) : []).join('\n'),
    toolCallTimeoutMs: server.toolCallTimeoutMs !== undefined ? String(server.toolCallTimeoutMs) : '',
    failOnStartupError: server.failOnStartupError === true,
    credentialRef: server.credentialRef ?? '',
    callbackPort: server.callbackPort !== undefined ? String(server.callbackPort) : '',
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
 * Build the wire config from the draft. OAuth-owned rows also carry the two
 * bridge keys the form exposes; the host validates them and merges the bridge's
 * other keys onto the row.
 * @param form - the current draft.
 * @param oauth - whether this row is owned by the OAuth bridge.
 * @returns the config payload.
 */
function toConfig(form: FormState, oauth: boolean): McpServerConfig {
  const config: McpServerConfig = {
    serverName: form.serverName.trim(),
    transport: form.transport,
  }
  if (form.transport === 'streamable-http') {
    if (form.url.trim() !== '') config.url = form.url.trim()
  } else {
    if (form.command.trim() !== '') config.command = form.command.trim()
    const args = splitLines(form.argsText)
    if (args.length > 0) config.args = args
    const env = parsePairs(form.envText)
    if (env !== undefined) config.env = env
    if (form.cwd.trim() !== '') config.cwd = form.cwd.trim()
  }
  const headers = parsePairs(form.headersText)
  if (headers !== undefined) config.headers = headers
  if (form.toolCallTimeoutMs.trim() !== '' && Number.isFinite(Number(form.toolCallTimeoutMs))) {
    config.toolCallTimeoutMs = Number(form.toolCallTimeoutMs)
  }
  if (form.failOnStartupError) config.failOnStartupError = true
  if (oauth) {
    if (form.credentialRef.trim() !== '') config.credentialRef = form.credentialRef.trim()
    if (form.callbackPort.trim() !== '' && Number.isFinite(Number(form.callbackPort))) {
      config.callbackPort = Number(form.callbackPort)
    }
  }
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
 * Add/edit server form built from the kit's Input, SegmentedControl, Checkbox
 * and Button. When editing, the id field is locked and the footer carries the
 * connectivity test; the transport selector is hidden for OAuth-owned rows,
 * whose transport is fixed and whose other keys the host merges.
 *
 * Validation is the host's: the submit sends the draft and renders whatever
 * field errors come back (`McpManagerRpcError.fields`), so the panel never
 * keeps a second copy of the bridge package's schema rules.
 *
 * @param props - form context and callbacks.
 * @returns the form panel: header row (title + remove), fields, probe line, footer.
 */
export function ServerForm({
  t,
  initial,
  oauth,
  busy,
  probe,
  probing,
  onTest,
  onRemove,
  removeLabel,
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

  const submit = async (): Promise<void> => {
    setSaving(true)
    setSubmitError(null)
    setFieldErrors({})
    try {
      const payload = { id: form.id.trim(), config: toConfig(form, oauth === true) }
      await callRpc(editing ? 'update' : 'add', payload)
      onSaved()
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
          <Tooltip label={removeLabel ?? t('remove')}>
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
          </Tooltip>
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

      {oauth === true ? null : (
        <Field label={t('fieldTransport')}>
          <SegmentedControl
            id="dshmcp-transport"
            value={form.transport}
            options={TRANSPORT_OPTIONS}
            label={t('fieldTransport')}
            disabled={locked}
            onChange={(next) => set('transport', next)}
          />
        </Field>
      )}

      {form.transport === 'streamable-http' ? (
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

      {/* OAuth-owned rows carry these two bridge keys; the host validates them and merges the rest. */}
      {oauth === true ? (
        <div style={fieldRowStyle}>
          <Field labelFor="dshmcp-credential" label={t('fieldCredentialRef')} hint={err('credentialRef')}>
            <Input
              id="dshmcp-credential"
              value={form.credentialRef}
              placeholder="CLOUDFLARE_MCP_OAUTH"
              spellCheck={false}
              aria-invalid={err('credentialRef') !== undefined}
              disabled={locked}
              onChange={(e) => set('credentialRef', e.target.value)}
            />
          </Field>
          <Field labelFor="dshmcp-callback-port" label={t('fieldCallbackPort')} hint={err('callbackPort')}>
            <Input
              id="dshmcp-callback-port"
              value={form.callbackPort}
              inputMode="numeric"
              placeholder="45871"
              aria-invalid={err('callbackPort') !== undefined}
              disabled={locked}
              onChange={(e) => set('callbackPort', e.target.value.replace(/[^0-9]/g, ''))}
            />
          </Field>
        </div>
      ) : null}

      <Field labelFor="dshmcp-headers" label={t('fieldHeaders')} hint={err('headers')}>
        <textarea
          id="dshmcp-headers"
          style={textareaStyle}
          rows={2}
          value={form.headersText}
          placeholder="Authorization: Bearer xxx"
          spellCheck={false}
          disabled={locked}
          onChange={(e) => set('headersText', e.target.value)}
        />
      </Field>

      <div style={timeoutRowStyle}>
        <Field
          labelFor="dshmcp-timeout"
          label={t('fieldTimeout')}
          hint={err('toolCallTimeoutMs')}
          style={timeoutFieldStyle}
        >
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
        <div style={checkboxCellStyle}>
          <Checkbox
            checked={form.failOnStartupError}
            label={t('fieldFailStartup')}
            disabled={locked}
            onChange={(next) => set('failOnStartupError', next)}
          />
        </div>
      </div>

      {submitError !== null ? <p style={errorLineStyle} role="alert">{submitError}</p> : null}

      {/* inventory `.statusWithDot` + `.status`/`.failure`: the probe sentence stays in the panel. */}
      {probe !== undefined ? (
        probe.skipped === true ? (
          <p style={statusLineStyle}>
            <span style={dotSlotStyle}><StateDot state="warning" size={10} /></span>
            <span style={statusTextStyle}>{t('probeSkipped')} {probe.error ?? ''}</span>
          </p>
        ) : probe.ok ? (
          <p style={statusLineStyle}>
            <span style={dotSlotStyle}><StateDot state="done" size={10} /></span>
            <span style={statusTextStyle}>
              {t('probeOk', {
                ms: String(probe.latencyMs),
                count: probe.toolCount !== undefined ? String(probe.toolCount) : '?',
              })}
            </span>
          </p>
        ) : (
          <p style={statusLineStyle}>
            <span style={dotSlotStyle}><StateDot state="error" size={10} /></span>
            <span style={failureStyle}>
              {t('probeFail', { error: probe.error ?? 'failed', ms: String(probe.latencyMs) })}
            </span>
          </p>
        )
      ) : null}

      <div style={formActionsStyle}>
        {editing && onTest !== undefined ? (
          <Button
            variant="outline"
            size="sm"
            icon={probing === true ? <StateDot state="ongoing" size={14} /> : undefined}
            onClick={onTest}
            disabled={locked}
          >
            {t('test')}
          </Button>
        ) : null}
        <span style={formActionsEndStyle}>
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
            {editing ? t('save') : t('addMcp')}
          </Button>
        </span>
      </div>
    </>
  )
}
