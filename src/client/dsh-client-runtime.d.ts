/**
 * Local type shim for the DSH client kernel.
 *
 * `@deepseek-ai/dsh-client-runtime` is not published on npm at the DSH version
 * this repo targets (0.2.0-rc.2), so its `client` entry — which only re-exports
 * the client-root Context type — is declared here. Every other DSH client
 * package we import ships its own declarations from npm.
 */
declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { Context } from '@deepseek-ai/cordis'
  import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
  /**
   * Client-root context: the cordis Context plus the client-only slot registry.
   * The kernel package that declares the registry is unpublished at 0.2.0-rc.2,
   * so `inject` (its only member not on the published `SlotCore`) is added here.
   */
  export type ClientContext = Context & {
    slots: SlotCore & { inject(kind: string, factory: () => unknown): unknown }
  }
}
