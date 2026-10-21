// The panel registry. Every `*.panel.tsx` file here is picked up automatically
// and default-exports a DrawPanel; the right-hand dock shows them in `order`.
// Adding a panel is adding ONE file. See README.md.

import type { DrawPanel } from '../editor/types'

const modules = import.meta.glob<{ default: DrawPanel }>('./*.panel.tsx', { eager: true })

const PANELS: DrawPanel[] = Object.values(modules)
  .map((m) => m.default)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

export function drawPanels(): DrawPanel[] {
  return PANELS
}
