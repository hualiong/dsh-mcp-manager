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
  | 'statusNotLoaded'
  | 'statusPending'
  | 'statusLoading'
  | 'statusUnloading'
  | 'toolCount'
  | 'enable'
  | 'disable'
  | 'switchBridgeMissing'
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
  | 'headerName'
  | 'headerValue'
  | 'addHeader'
  | 'fieldTimeout'
  | 'noticeOAuth'
  | 'noticeOAuthMissing'
  | 'noticePlain'
  | 'noticeUnknownAdd'
  | 'noticeUnknownEdit'
  | 'cancel'
  | 'save'
  | 'errDuplicateId'
  | 'errDuplicateName'
  | 'errInvalidConfig'
  | 'errBridgeMissing'
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
  statusNotLoaded: '未加载',
  statusPending: '等待中',
  statusLoading: '加载中',
  statusUnloading: '卸载中',
  toolCount: '{count} 个工具',
  enable: '启用',
  disable: '停用',
  switchBridgeMissing: '需要先安装 @hualiong/dsh-oauth-mcp-client 才能启用',
  remove: '删除',
  formAddTitle: '添加 MCP 服务器',
  formEditTitle: '编辑 {name}',
  fieldId: '插件 ID',
  fieldServerName: 'serverName',
  fieldTransport: '传输方式',
  fieldUrl: 'URL',
  fieldCommand: '命令',
  fieldArgs: '参数（每行一个）',
  fieldEnv: '环境变量（KEY=VALUE，每行一个）',
  fieldCwd: '工作目录（可选）',
  fieldHeaders: '请求头（若携带 Authorization 头，则由内置 MCP 客户端处理连接）',
  headerName: '请求头名称',
  headerValue: '请求头值',
  addHeader: '添加请求头',
  fieldTimeout: '超时（毫秒，可选）',
  noticeOAuth: '该地址要求 OAuth 授权，已交给 OAuth 桥接管',
  noticeOAuthMissing: '该行需要 OAuth 桥，但当前 profile 未安装 @hualiong/dsh-oauth-mcp-client；已先以「停用」状态保存，装好并重启 DSH 后直接打开开关即可',
  noticePlain: '未检测到 OAuth 要求，已交给内置客户端处理',
  noticeUnknownAdd: '暂时无法验证该地址，已按普通 Streamable HTTP 接入；若之后连接失败，等服务器可达后重新保存一次即可',
  noticeUnknownEdit: '暂时无法验证该地址，已保持原有接入方式不变',
  cancel: '取消',
  save: '保存',
  errDuplicateId: '插件 ID 已被使用',
  errDuplicateName: 'serverName 已被其他服务器使用',
  errInvalidConfig: 'MCP 服务器配置无效',
  errBridgeMissing: '该行所属的 MCP 桥未安装，无法启用；请先安装 @hualiong/dsh-oauth-mcp-client',
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
  statusNotLoaded: 'Not loaded',
  statusPending: 'Pending',
  statusLoading: 'Loading',
  statusUnloading: 'Unloading',
  toolCount: '{count} tools',
  enable: 'Enable',
  disable: 'Disable',
  switchBridgeMissing: 'Install @hualiong/dsh-oauth-mcp-client before this row can be enabled',
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
  fieldHeaders: 'Headers (a row carrying an Authorization header is connected by the built-in MCP client)',
  headerName: 'Header name',
  headerValue: 'Header value',
  addHeader: 'Add header',
  fieldTimeout: 'Timeout (ms, optional)',
  noticeOAuth: 'This address requires OAuth authorization; the OAuth bridge now handles it',
  noticeOAuthMissing: 'This row needs the OAuth bridge, but @hualiong/dsh-oauth-mcp-client is not installed in this profile; it was saved disabled — install the bridge, restart DSH, then switch this row on',
  noticePlain: 'No OAuth requirement found; the built-in client now handles it',
  noticeUnknownAdd: 'This address could not be verified yet, so it was added as a plain Streamable HTTP server. If it fails to connect, save it again once the server is reachable.',
  noticeUnknownEdit: 'This address could not be verified yet; its existing connection type is unchanged',
  cancel: 'Cancel',
  save: 'Save',
  errDuplicateId: 'Entry id is already in use',
  errDuplicateName: 'serverName is already used by another server',
  errInvalidConfig: 'Invalid MCP server configuration',
  errBridgeMissing: 'The MCP bridge this row needs is not installed, so the row cannot be enabled; install @hualiong/dsh-oauth-mcp-client first',
  errTransport: 'Cannot reach the host',
}
