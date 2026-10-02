/**
 * MCP Manager settings section: server list with live status, add/remove,
 * enable/disable, edit and on-demand connectivity tests. Rendered inside the
 * Settings panel as the "MCP" page (a `settings.section` entry).
 *
 * Everything interactive here comes from the official component kit
 * (`@deepseek-ai/dsh-client-ui-primitives`) — Button, Input, Switch, Tag,
 * StateDot, DisclosureRow, SegmentedControl, Checkbox, Tooltip,
 * RiskConfirmation, PathLabel and the product icons — so the page wears the
 * shell's own look and behaviour. The only styles this module owns are inline
 * layout declarations on its own containers (stack, card, field column, meta
 * row): the kit ships no layout primitives, and the framework's own rule is
 * that a card stacking name over description belongs to the feature package.
 *
 * Copy is fully localized (zh/en); the renderer hands the registered `locale:`
 * namespace's `t` seat in as a prop, so the page follows the active GUI
 * language without subscribing to locale state itself.
 *
 * The add form sits at the top of the page; the edit form opens **in place of**
 * the card being edited, and the two modes are mutually exclusive. Data flows
 * through the typed fetch client to the host half; field-level validation
 * feedback is the host's (`err.fields`), never a second copy of its rules.
 *
 * @module dsh-mcp-manager/client/McpManagerSection
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  Checkbox,
  DisclosureRow,
  IconCheckCircleFillRegular,
  IconCodeOutlineRegular,
  IconEditOutlineRegular,
  IconGlobeOutlineRegular,
  IconPlayOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
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

/**
 * Inline layout styles. The kit styles every control; these objects only place
 * its output (and the multi-line textareas it does not ship) inside the page,
 * using the same `--dsw-*` tokens the kit reads so both themes stay in step.
 */
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 720 }
const headStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8 }
const headTitleStyle: CSSProperties = { fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const headSubStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
const toolbarStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const spacerStyle: CSSProperties = { flex: 1 }
const metaStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
const metaBadStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
const errorStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent)',
  borderRadius: 9,
  background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 12,
}
const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-3)',
  padding: '8px 12px 4px',
}
const cardBodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 0 14px 22px' }
const statusGroupStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }
const targetStyle: CSSProperties = {
  fontSize: 12.5,
  fontFamily: 'ui-monospace, Consolas, monospace',
  color: 'var(--dsw-alias-label-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const tagRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const probeStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
const probeOkStyle: CSSProperties = { color: 'var(--dsw-alias-state-success-primary)', overflowWrap: 'anywhere' }
const probeBadStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' }
/** A skipped probe is a stated reason, not a failure: neutral, not red. */
const probeNoteStyle: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }
const actionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  paddingTop: 10,
}
const switchGroupStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, marginRight: 4 }
const switchLabelStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
const formStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 18,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-3)',
}
const formTitleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
const hintStyle: CSSProperties = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }
const fieldRowStyle: CSSProperties = { display: 'flex', gap: 10 }
const formActionsStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }
const emptyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  padding: '36px 16px',
  fontSize: 13,
  color: 'var(--dsw-alias-label-tertiary)',
}
const footerStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const footerPathStyle: CSSProperties = { fontSize: 11.5, maxWidth: '100%' }
const dangerButtonStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
/** A textarea, which the kit does not ship; dressed with the Input tokens. */
const textareaStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 64,
  padding: '6px 8px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  resize: 'vertical',
}

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

  return (
    <div style={sectionStyle}>
      <div style={headStyle}>
        <span style={headTitleStyle}>{t('title')}</span>
        <span style={headSubStyle}>{t('total', { count: String(summary.total) })}</span>
      </div>

      <div style={toolbarStyle}>
        <Button
          variant="primary"
          size="sm"
          icon={<IconPlusOutlineRegular size={14} />}
          onClick={beginAdd}
          disabled={busy !== null || formOpen}
        >
          {t('addServer')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          icon={loading ? <StateDot state="ongoing" size={14} /> : <IconRefreshOutlineRegular size={14} />}
          onClick={() => void refresh()}
          disabled={busy !== null || loading}
        >
          {t('refresh')}
        </Button>
        <span style={spacerStyle} />
        <span style={metaStyle}>
          <span>{t('connected', { count: String(summary.connected) })}</span>
          {summary.failed > 0 ? <span style={metaBadStyle}>{t('failed', { count: String(summary.failed) })}</span> : null}
          <span>{t('enabledOf', { count: String(summary.enabled), total: String(summary.total) })}</span>
        </span>
      </div>

      {error !== null ? (
        <div style={errorStyle} role="alert">
          <IconWarningOutlineRegular size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      {form?.mode === 'add' ? (
        <ServerForm
          key="add"
          t={t}
          initial={undefined}
          busy={busy !== null}
          onCancel={closeForm}
          onSaved={() => savedForm('add')}
        />
      ) : null}

      {loading && servers.length === 0 && !formOpen ? (
        <div style={emptyStyle}>
          <StateDot state="ongoing" size={14} />
          <span>{t('loading')}</span>
        </div>
      ) : null}

      {!loading && servers.length === 0 && !formOpen ? (
        <div style={emptyStyle}>
          <span>{t('empty')}</span>
          <span>{t('emptyHint')}</span>
        </div>
      ) : null}

      {servers.map((server) => {
        if (form?.mode === 'edit' && form.server.id === server.id) {
          return (
            <ServerForm
              key={server.id}
              t={t}
              initial={server}
              busy={busy !== null}
              onCancel={closeForm}
              onSaved={() => savedForm('edit')}
            />
          )
        }

        const status = statusOf(server)
        const probe = probes[server.id]
        const probing = busy === `probe:${server.id}`
        const target = targetOf(server)
        return (
          <div style={cardStyle} key={server.id}>
            <DisclosureRow
              icon={server.transport === 'stdio'
                ? <IconCodeOutlineRegular size={16} />
                : <IconGlobeOutlineRegular size={16} />}
              title={displayName(server)}
              open={expanded[server.id] === true}
              expandable
              expandOnRowClick
              running={probing}
              onToggle={() => toggleExpanded(server.id)}
              collapsedContent={(
                <span style={statusGroupStyle}>
                  <StateDot state={status.dot} size={8} />
                  <Tag tone={status.tone}>
                    {t(status.key, status.count !== undefined ? { count: status.count } : undefined)}
                  </Tag>
                </span>
              )}
            >
              <div style={cardBodyStyle}>
                <span style={targetStyle} title={target}>
                  {target || (server.transport === 'stdio' ? 'stdio' : 'streamable-http')}
                </span>

                <span style={tagRowStyle}>
                  <Tag tone="quiet">{server.transport}</Tag>
                  <Tag tone="quiet">{t('toolCount', { count: String(server.toolCount) })}</Tag>
                  <Tag tone="outline">{server.id}</Tag>
                  {!server.userManaged ? <Tag tone="quiet">{t('bundleDefined')}</Tag> : null}
                  {server.failOnStartupError === true ? <Tag tone="quiet">{t('fieldFailStartup')}</Tag> : null}
                  {server.reconnect?.enabled === false ? <Tag tone="quiet">{t('reconnectOff')}</Tag> : null}
                  {server.ownerPackage !== MCP_CLIENT_PACKAGE
                    ? <Tag tone="info">{server.ownerPackage}</Tag>
                    : null}
                </span>

                {probe !== undefined ? (
                  probe.skipped === true ? (
                    <span style={probeStyle}>
                      <Tag tone="warning">{t('probeSkipped')}</Tag>
                      <span style={probeNoteStyle}>{probe.error ?? ''}</span>
                    </span>
                  ) : probe.ok ? (
                    <span style={probeStyle}>
                      <IconCheckCircleFillRegular size={14} />
                      <span style={probeOkStyle}>
                        {t('probeOk', {
                          ms: String(probe.latencyMs),
                          count: probe.toolCount !== undefined ? String(probe.toolCount) : '?',
                        })}
                      </span>
                    </span>
                  ) : (
                    <span style={probeStyle}>
                      <IconWarningOutlineRegular size={14} />
                      <span style={probeBadStyle}>
                        {t('probeFail', { error: probe.error ?? 'failed', ms: String(probe.latencyMs) })}
                      </span>
                    </span>
                  )
                ) : null}

                <span style={actionsStyle}>
                  <span style={switchGroupStyle}>
                    <Switch
                      checked={server.enabled}
                      label={t('enable')}
                      disabled={actionsDisabled}
                      onChange={() => toggleEnabled(server)}
                    />
                    <span style={switchLabelStyle}>{server.enabled ? t('disable') : t('enable')}</span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={probing ? <StateDot state="ongoing" size={14} /> : <IconPlayOutlineRegular size={14} />}
                    onClick={() => testConnection(server)}
                    disabled={actionsDisabled}
                  >
                    {t('test')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconEditOutlineRegular size={14} />}
                    onClick={() => beginEdit(server)}
                    disabled={actionsDisabled}
                  >
                    {t('edit')}
                  </Button>
                  <span style={spacerStyle} />
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
                </span>
              </div>
            </DisclosureRow>
          </div>
        )
      })}

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
    </div>
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
    <div style={formStyle}>
      <span style={formTitleStyle}>
        {editing ? t('formEditTitle', { name: initial.serverName }) : t('formAddTitle')}
      </span>

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

      {submitError !== null ? (
        <div style={errorStyle} role="alert">
          <IconWarningOutlineRegular size={14} />
          <span>{submitError}</span>
        </div>
      ) : null}

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
          {editing ? t('save') : t('addServer')}
        </Button>
      </div>
    </div>
  )
}
