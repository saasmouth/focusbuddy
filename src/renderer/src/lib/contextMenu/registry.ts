// Widget context-action registry.
//
// Widgets register a provider against a (kind, granularity) pair, or a
// (kind, '*') wildcard that fires for every object inside that kind. The
// resolver asks the registry for the kind's rows (each in its §9.3 group, see
// types.ts) and the suppress flags for whatever was clicked. Marketplace plugins push into a separate store the
// resolver also reads, constrained by the extensibility framework.

import type { WidgetKind } from '@shared/types'
import type {
  MenuContext,
  MenuContribution,
  WidgetContextProvider,
  WidgetContribution
} from './types'

const WILDCARD = '*'

function key(kind: WidgetKind, granularity: string): string {
  return `${kind}::${granularity}`
}

const providers = new Map<string, WidgetContextProvider>()

// Register a provider. Two-arity form registers the kind wildcard (fires for
// any object inside that widget); three-arity names a specific granularity such
// as 'cell' or 'row'. A specific granularity is merged on top of the wildcard.
export function registerWidgetContextActions(
  kind: WidgetKind,
  granularityOrProvider: string | WidgetContextProvider,
  maybeProvider?: WidgetContextProvider
): void {
  if (typeof granularityOrProvider === 'function') {
    providers.set(key(kind, WILDCARD), granularityOrProvider)
    return
  }
  if (maybeProvider) providers.set(key(kind, granularityOrProvider), maybeProvider)
}

// For tests and hot-reload safety.
export function clearWidgetContextActions(): void {
  providers.clear()
}

// Collect the widget's contribution for this click: the wildcard
// provider plus any granularity-specific provider, merged. Granularity rows
// sort ahead of wildcard rows within the same priority because they are the
// more specific answer to what was clicked.
export function collectWidgetContribution(
  kind: WidgetKind,
  ctx: MenuContext
): WidgetContribution {
  const out: MenuContribution[] = []
  const suppress: WidgetContribution['suppress'] = {}

  const wild = providers.get(key(kind, WILDCARD))
  const gran = ctx.sub?.granularity ? providers.get(key(kind, ctx.sub.granularity)) : undefined

  for (const provider of [wild, gran]) {
    if (!provider) continue
    const c = provider(ctx)
    out.push(...c.context)
    if (c.suppress) Object.assign(suppress, c.suppress)
  }
  return { context: out, suppress }
}

// ── Marketplace plugin store (extensibility framework, deliverable 9) ─────────
//
// Plugins never register into the per-widget registry above and never reach the
// object group. They contribute into a single dedicated bucket the resolver
// places under More actions ▸ Installed tools, so the trust boundary is one obvious place and the
// first-party two-level submenu budget stays free. A throwing plugin is
// isolated so it can never break the menu.

export interface PluginMenuContribution extends MenuContribution {
  pluginId: string
}

const pluginProviders = new Map<string, (ctx: MenuContext) => PluginMenuContribution[]>()

export function registerPluginContextActions(
  pluginId: string,
  provider: (ctx: MenuContext) => PluginMenuContribution[]
): void {
  pluginProviders.set(pluginId, provider)
}

const MAX_PLUGIN_ROWS_PER_PLUGIN = 3

export function collectPluginContributions(ctx: MenuContext): MenuContribution[] {
  const out: MenuContribution[] = []
  for (const [pluginId, provider] of pluginProviders) {
    try {
      const rows = provider(ctx) || []
      // Cap per plugin so one tool cannot flood the menu.
      for (const row of rows.slice(0, MAX_PLUGIN_ROWS_PER_PLUGIN)) {
        out.push({ ...row, id: `plugin:${pluginId}/${row.id}` })
      }
    } catch (err) {
      // Failure isolation: a broken plugin drops out, the menu still opens.
      // eslint-disable-next-line no-console
      console.warn(`[contextMenu] plugin "${pluginId}" threw, skipping its actions`, err)
    }
  }
  return out
}
