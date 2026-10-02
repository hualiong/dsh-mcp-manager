/**
 * dsh-mcp-manager — browser half.
 *
 * Registers an "MCP" page in the Settings panel (a `settings.section` entry
 * beside 通用设置 / 模型 / 插件 / Agent 预设), hosting the server list,
 * add/remove, enable/disable and connection-status tools. The page is built
 * from the official component kit (`@deepseek-ai/dsh-client-ui-primitives`),
 * so it wears the shell's own look and behaviour instead of a private
 * stylesheet. Copy is localized (zh/en) and follows the GUI's active locale
 * automatically.
 *
 * All data flows over the loopback-only `/mcp-manager` HTTP route registered
 * by the node half (plain `fetch`, see `rpc.ts`); the browser never touches
 * the host filesystem directly.
 *
 * @module dsh-mcp-manager/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the slot-registry Context merge (ctx.slots) and the
// settings-slot declarations (`settings.section`) into this program so the
// register call below type-checks.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { McpManagerSection } from './McpManagerSection.tsx'
import { NS, en, zh } from './locales.ts'

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/** Nav position of the MCP section (models=10, plugins=15, agent-presets=20). */
const SECTION_ORDER = 18

/**
 * Client plugin body: register the settings section and its dictionaries.
 *
 * `locale: NS` makes the renderer hand the namespace's typed `t` seat to the
 * component as a prop, so locale switches re-render the page without it
 * subscribing to locale state; the `label` thunk follows the same namespace.
 * The section injects no business face of its own — the fetch client needs
 * nothing from the context.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-manager: locale')

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp',
    order: SECTION_ORDER,
    label: () => t('nav'),
    locale: NS,
  }, McpManagerSection))
}
