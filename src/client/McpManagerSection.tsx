/**
 * MCP Manager settings section: server list with live status, add/remove,
 * enable/disable, edit and on-demand connectivity tests. Rendered inside the
 * Settings panel as the "MCP" page (a `settings.section` entry).
 *
 * Layout and typography mirror the official settings pages. The card is the
 * 模型 page's configured-row structure — `rowCard` / `rowHead` / `rowIdentity`
 * / `rowName` / `rowTag` / `rowActions`
 * (`.recon/official/settings-models.client.js`) — with the disclosure
 * mechanics of the plugin-inventory card (`cardContent` toggle, chevron at
 * `data-open` rotation, `cardDetails` panel;
 * `.recon/official/settings-plugin-inventory.client.js`). Every number and
 * token below is copied from those bundles; each style constant names the
 * official rule it reproduces.
 *
 * The transcript-facing `DisclosureRow` primitive is deliberately NOT used:
 * its contract is a 24px tertiary process row, so it cannot carry the
 * settings-page title scale or host the row's controls.
 *
 * Controls still come from the official kit
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
import { MCP_CLIENT_PACKAGE } from '../shared.ts'
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

/** Status keys used by the card badge (a subset of the locale dictionary). */
type StatusKey =
  | 'statusConnected'
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

// --- official values -----------------------------------------------------------------
// `models` = ModelsSection.module.css inside .recon/official/settings-models.client.js
// `inventory` = PluginInventorySettingsTab.module.css inside
//   .recon/official/settings-plugin-inventory.client.js
// `general` = settings-general.client.js

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
/** models `.intro` — the summary sentence under the heading. */
const introStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  margin: 0,
  fontSize: 14,
  lineHeight: '22px',
}
/** plugin-manager `.pageHead` — heading block left, toolbar right (its `padding-top:28px` is page chrome). */
const pageHeadStyle: CSSProperties = {
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 16,
  display: 'flex',
}
/** models `.rowIdentity` / inventory `.cardMainRow` — the shrinking-child `min-width:0` idiom. */
const titleBlockStyle: CSSProperties = { minWidth: 0 }
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
/** models `.rowCard` — one server card. */
const rowCardStyle: CSSProperties = {
  border: '.5px solid var(--dsw-alias-settings-card-stroke)',
  background: 'var(--dsw-alias-settings-card-fill)',
  borderRadius: 'var(--dsw-radius-xl)',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 14px',
  display: 'flex',
}
/** inventory `.card[data-failed=true]` — the card's stroke colour only. */
const rowCardFailedStyle: CSSProperties = {
  ...rowCardStyle,
  borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)',
}
/** inventory `.card[data-open=true]` — an expanded card's stroke; failure wins (source order). */
const rowCardOpenStyle: CSSProperties = {
  ...rowCardStyle,
  borderColor: 'var(--dsw-alias-border-l3)',
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
/** models `.editor` — the nested edit panel inside a row card. */
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
/** inventory `.entryValue` code face on the `.cardDescription` 12/18 colour. */
const targetStyle: CSSProperties = {
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
  overflowWrap: 'anywhere',
  display: 'block',
}
/** inventory `.statusWithDot` + models `.modelInputChoices` wrapping (row spacing = `.editor` gap). */
const metaRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
}
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
/** models `.editorHeader` / `.editorTitle`. */
const editorHeaderStyle: CSSProperties = { alignItems: 'baseline', gap: 8, display: 'flex' }
const editorTitleStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 14,
  fontWeight: 500,
  lineHeight: '22px',
}
/** models `.editorActions`. */
const formActionsStyle: CSSProperties = { justifyContent: 'flex-end', gap: 8, display: 'flex' }
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

const TRANSPORT_OPTIONS: readonly SegmentedControlOption<McpTransport>[] = [
  { value: 'streamable-http', label: 'streamable-http' },
  { value: 'stdio', label: 'stdio' },
]

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
      // With zero tools the server is effectively not connected, so it must
      // never render green (that would mislead users into thinking the
      // connection is healthy when it failed, e.g. HTTP 401 / crash loop).
      return server.toolCount > 0
        ? { dot: 'done', tone: 'success', key: 'statusConnected', count: String(server.toolCount) }
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

/** One-line transport target: the URL, or the stdio command line. */
function targetOf(server: McpServerInfo): string {
  if (server.transport === 'stdio') {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
  }
  return server.url ?? ''
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
  const [form, setForm] = useState<FormTarget>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({})
  const [removing, setRemoving] = useState<McpServerInfo | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const formOpen = form !== null
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

  const beginAdd = useCallback(() => setForm({ mode: 'add' }), [])
  const beginEdit = useCallback((server: McpServerInfo) => setForm({ mode: 'edit', server }), [])
  const closeForm = useCallback(() => setForm(null), [])
  const toggleExpanded = useCallback((id: string) => {
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

  /** Shared by both form modes: close the form, then re-read the host list. */
  const savedForm = useCallback((mode: 'add' | 'edit') => {
    setForm(null)
    void run(() => Promise.resolve(), `form:${mode}`)
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
    <section style={sectionStyle}>
      {/*
       * The 插件页 header: heading block on the left, `.toolbar` at the right
       * edge of the same row. Refresh is the kit's ghost Button wearing the
       * official icon-button box (so hover comes from the kit's own
       * `.ghost:hover` token and focus from the platform), with the kit
       * Tooltip, the glyph swap while refreshing, and the add action as the
       * kit's primary Button wearing `.addButton` metrics.
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
        {form?.mode === 'add' ? (
          <li style={addCardStyle} key="add">
            <div style={nestedEditorStyle}>
              <ServerForm
                t={t}
                initial={undefined}
                busy={busy !== null}
                onCancel={closeForm}
                onSaved={() => savedForm('add')}
              />
            </div>
          </li>
        ) : null}

        {servers.map((server) => {
          const status = statusOf(server)
          const statusText = t(status.key, status.count !== undefined ? { count: status.count } : undefined)
          const editing = form?.mode === 'edit' && form.server.id === server.id
          const open = expanded[server.id] === true
          const probe = probes[server.id]
          const probing = busy === `probe:${server.id}`
          const failed = server.enabled && server.fiberPhase === 'failed'
          const regionId = `mcp-details-${server.id}`
          const target = targetOf(server)
          return (
            <li
              style={failed ? rowCardFailedStyle : open ? rowCardOpenStyle : rowCardStyle}
              key={server.id}
              data-open={open ? 'true' : undefined}
              data-failed={failed ? 'true' : undefined}
            >
              <div style={rowHeadStyle}>
                {/*
                 * The title area is the disclosure toggle (inventory
                 * `cardContent` as a bare button), so the title keeps the
                 * settings-page scale. Only the enable Switch shares the
                 * header: it has to stay reachable while the card is
                 * collapsed. Everything else lives in the expanded panel.
                 */}
                <button
                  type="button"
                  style={rowToggleStyle}
                  aria-expanded={open}
                  aria-controls={open ? regionId : undefined}
                  onClick={() => toggleExpanded(server.id)}
                >
                  <span style={rowNameStyle}>{displayName(server)}</span>
                  <Tag tone={status.tone}>{statusText}</Tag>
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

              {editing ? (
                <div style={editorStyle}>
                  <ServerForm
                    t={t}
                    initial={server}
                    busy={busy !== null}
                    onCancel={closeForm}
                    onSaved={() => savedForm('edit')}
                  />
                </div>
              ) : open ? (
                <div style={editorStyle} id={regionId}>
                  <span style={targetStyle} title={target}>
                    {target || (server.transport === 'stdio' ? 'stdio' : 'streamable-http')}
                  </span>

                  <span style={metaRowStyle}>
                    <Tag tone="quiet">{server.transport}</Tag>
                    <Tag tone="quiet">{t('toolCount', { count: String(server.toolCount) })}</Tag>
                    {!server.userManaged ? <Tag tone="quiet">{t('bundleDefined')}</Tag> : null}
                    {server.failOnStartupError === true ? <Tag tone="quiet">{t('fieldFailStartup')}</Tag> : null}
                    {server.reconnect?.enabled === false ? <Tag tone="quiet">{t('reconnectOff')}</Tag> : null}
                    {server.ownerPackage !== MCP_CLIENT_PACKAGE
                      ? <Tag tone="info">{server.ownerPackage}</Tag>
                      : null}
                  </span>

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

                  {/* models `.editorActions` — the row's actions, right-aligned at the panel foot. */}
                  <div style={formActionsStyle}>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={probing ? <StateDot state="ongoing" size={14} /> : undefined}
                      onClick={() => testConnection(server)}
                      disabled={actionsDisabled}
                    >
                      {t('test')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => beginEdit(server)}
                      disabled={actionsDisabled}
                    >
                      {t('edit')}
                    </Button>
                    <Tooltip label={server.userManaged ? t('remove') : t('bundleDefined')}>
                      <Button
                        variant="ghost"
                        size="sm"
                        style={dangerButtonStyle}
                        icon={<IconTrashOutlineRegular size={14} />}
                        onClick={() => requestRemove(server)}
                        disabled={actionsDisabled}
                      >
                        {t('remove')}
                      </Button>
                    </Tooltip>
                  </div>
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

/** Which form the page is showing, if any. */
type FormTarget = { mode: 'add' } | { mode: 'edit'; server: McpServerInfo } | null

interface ServerFormProps {
  t: TranslateNS<typeof NS>
  initial?: McpServerInfo | undefined
  busy: boolean
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

function toConfig(form: FormState): McpServerConfig {
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
  return config
}

/** A labelled field: label, control, and the host's validation hint for it. */
function Field({ labelFor, label, hint, children }: {
  /** Id of the control this label names; omitted when the control owns no such id. */
  labelFor?: string | undefined
  label: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <div style={fieldStyle}>
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
 * and Button. When editing, the id field is locked.
 *
 * Validation is the host's: the submit sends the draft and renders whatever
 * field errors come back (`McpManagerRpcError.fields`), so the panel never
 * keeps a second copy of the bridge package's schema rules.
 *
 * @param props - form context and callbacks.
 */
function ServerForm({ t, initial, busy, onCancel, onSaved }: ServerFormProps): JSX.Element {
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
      const payload = { id: form.id.trim(), config: toConfig(form) }
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

      <div style={fieldRowStyle}>
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
        <div style={{ ...fieldStyle, justifyContent: 'flex-end' }}>
          <Checkbox
            checked={form.failOnStartupError}
            label={t('fieldFailStartup')}
            disabled={locked}
            onChange={(next) => set('failOnStartupError', next)}
          />
        </div>
      </div>

      {submitError !== null ? <p style={errorLineStyle} role="alert">{submitError}</p> : null}

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
          {editing ? t('save') : t('addMcp')}
        </Button>
      </div>
    </>
  )
}
