/**
 * Locale dictionaries for the MCP Manager section. The web GUI's active
 * locale (zh/en) selects the dictionary automatically; technical identifiers
 * (serverName, transport names, config keys) stay untranslated in both.
 *
 * Every label the official primitives need (button text, switch name, dialog
 * copy) is resolved here and passed in — the kit owns no language fallback of
 * its own. The only error strings that live here are the host failure *codes*
 * this panel maps to copy; per-field messages are the host's own.
 *
 * @module dsh-mcp-manager/client/locales
 */

/** Locale namespace for this plugin's copy. */
export const NS = 'mcpManager'

/** Key union merged into the slots LocaleNamespaceMap. */
export type McpManagerKeys =
  | 'nav'
  | 'title'
  | 'unnamed'
  | 'total'
  | 'addMcp'
  | 'connected'
  | 'failed'
  | 'enabledOf'
  | 'refresh'
  | 'loading'
  | 'empty'
  | 'emptyHint'
  | 'patchMissing'
  | 'removeTitle'
  | 'removeDesc'
  | 'removeAck'
  | 'statusActiveNoTools'
  | 'statusFailed'
  | 'statusDisabled'
  | 'statusLoading'
  | 'statusPending'
  | 'statusUnloading'
  | 'statusNotLoaded'
  | 'connecting'
  | 'toolCount'
  | 'probeOk'
  | 'probeFail'
  | 'probeSkipped'
  | 'enable'
  | 'disable'
  | 'test'
  | 'remove'
  | 'formAddTitle'
  | 'formEditTitle'
  | 'fieldId'
  | 'fieldServerName'
  | 'fieldTransport'
  | 'fieldUrl'
  | 'fieldCommand'
  | 'fieldArgs'
  | 'fieldEnv'
  | 'fieldCwd'
  | 'fieldHeaders'
  | 'fieldTimeout'
  | 'fieldFailStartup'
  | 'fieldCredentialRef'
  | 'fieldCallbackPort'
  | 'cancel'
  | 'save'
  | 'errDuplicateId'
  | 'errDuplicateName'
  | 'errInvalidConfig'
  | 'errNotFound'
  | 'errTransport'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    mcpManager: McpManagerKeys
  }
}

/** Simplified lookup type (the LocaleDictOf resolution needs the merge above). */
export type McpManagerDict = Record<McpManagerKeys, string>

/** Simplified lookup type (the LocaleDictOf resolution needs the merge above). */
export const zh: McpManagerDict = {
  nav: 'MCP',
  title: 'MCP 服务器',
  unnamed: '（未命名）',
  total: '共 {count} 个',
  addMcp: '添加 MCP',
  connected: '{count} 个已连接',
  failed: '{count} 个失败',
  enabledOf: '{count}/{total} 已启用',
  refresh: '刷新',
  loading: '正在加载服务器…',
  empty: '尚未配置 MCP 服务器。',
  emptyHint: '点击“添加 MCP”开始接入。',
  patchMissing: '补丁文件缺失',
  removeTitle: '删除 MCP 服务器',
  removeDesc: '将从 cordis.patch.yml 中删除“{name}”（{id}），并断开它的全部工具。此操作不可恢复。',
  removeAck: '我了解这会修改 cordis.patch.yml 并断开该服务器的工具',
  statusActiveNoTools: '无工具',
  statusFailed: '失败',
  statusDisabled: '已停用',
  statusLoading: '加载中',
  statusPending: '等待中',
  statusUnloading: '卸载中',
  statusNotLoaded: '未加载',
  connecting: '连接中',
  toolCount: '{count} 个工具',
  probeOk: '已连接，耗时 {ms}ms · {count} 个工具',
  probeFail: '{error}（{ms}ms）',
  probeSkipped: '未检测',
  enable: '启用',
  disable: '停用',
  test: '测试',
  remove: '删除',
  formAddTitle: '添加 MCP 服务器',
  formEditTitle: '编辑 {name}',
  fieldId: '条目 ID',
  fieldServerName: 'serverName',
  fieldTransport: '传输方式',
  fieldUrl: 'URL',
  fieldCommand: '命令',
  fieldArgs: '参数（每行一个）',
  fieldEnv: '环境变量（KEY=VALUE，每行一个）',
  fieldCwd: '工作目录（可选）',
  fieldHeaders: '请求头（Key: Value，每行一个）',
  fieldTimeout: '超时（毫秒，可选）',
  fieldFailStartup: '启动失败即报错',
  fieldCredentialRef: '凭据引用（OAuth）',
  fieldCallbackPort: '回调端口（OAuth）',
  cancel: '取消',
  save: '保存',
  errDuplicateId: '条目 ID 已被使用',
  errDuplicateName: 'serverName 已被其他服务器使用',
  errInvalidConfig: 'MCP 服务器配置无效',
  errNotFound: '未找到该 MCP 服务器条目',
  errTransport: '无法访问主进程',
}

/** English dictionary. */
export const en: McpManagerDict = {
  nav: 'MCP',
  title: 'MCP servers',
  unnamed: '(unnamed)',
  total: '{count} total',
  addMcp: 'Add MCP',
  connected: '{count} connected',
  failed: '{count} failed',
  enabledOf: '{count}/{total} enabled',
  refresh: 'Refresh',
  loading: 'Loading servers…',
  empty: 'No MCP servers configured.',
  emptyHint: 'Use “Add MCP” to connect one.',
  patchMissing: 'patch file missing',
  removeTitle: 'Remove MCP server',
  removeDesc: 'This removes "{name}" ({id}) from cordis.patch.yml and disconnects all of its tools. It cannot be undone.',
  removeAck: 'I understand this edits cordis.patch.yml and disconnects this server’s tools',
  statusActiveNoTools: 'No tools',
  statusFailed: 'Failed',
  statusDisabled: 'Disabled',
  statusLoading: 'Loading',
  statusPending: 'Pending',
  statusUnloading: 'Unloading',
  statusNotLoaded: 'Not loaded',
  connecting: 'Connecting',
  toolCount: '{count} tools',
  probeOk: 'Connected in {ms}ms · {count} tools',
  probeFail: '{error} ({ms}ms)',
  probeSkipped: 'Not probed',
  enable: 'Enable',
  disable: 'Disable',
  test: 'Test',
  remove: 'Remove',
  formAddTitle: 'Add MCP server',
  formEditTitle: 'Edit {name}',
  fieldId: 'Entry id',
  fieldServerName: 'serverName',
  fieldTransport: 'Transport',
  fieldUrl: 'URL',
  fieldCommand: 'Command',
  fieldArgs: 'Args (one per line)',
  fieldEnv: 'Env (KEY=VALUE, one per line)',
  fieldCwd: 'Working directory (optional)',
  fieldHeaders: 'Headers (Key: Value, one per line)',
  fieldTimeout: 'Timeout (ms, optional)',
  fieldFailStartup: 'Fail on startup error',
  fieldCredentialRef: 'Credential reference (OAuth)',
  fieldCallbackPort: 'Callback port (OAuth)',
  cancel: 'Cancel',
  save: 'Save',
  errDuplicateId: 'Entry id is already in use',
  errDuplicateName: 'serverName is already used by another server',
  errInvalidConfig: 'Invalid MCP server configuration',
  errNotFound: 'MCP server entry not found',
  errTransport: 'Cannot reach the host',
}
