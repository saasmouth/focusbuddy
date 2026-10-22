// The panel registry. Every `*.panel.tsx` file here is picked up automatically
// and default-exports a DrawPanel: an overlay panel (the office shell's
// ShellPanel) with a button at the bottom of the tool rail, in `order`. There
// is no docked panel column. Adding a panel is adding ONE file. See README.md.

import type { DrawPanel } from '../editor/types'

const modules = import.meta.glob<{ default: DrawPanel }>('./*.panel.tsx', { eager: true })

const PANELS: DrawPanel[] = Object.values(modules)
  .map((m) => m.default)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

export function drawPanels(): DrawPanel[] {
  return PANELS
}

export function panelById(id: string): DrawPanel | undefined {
  return PANELS.find((p) => p.id === id)
}
