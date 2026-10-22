// The top-bar tab registry. Every `*.tab.tsx` file here is picked up
// automatically and default-exports a DrawBarTab: Home, Object and Align are
// always there; a contextual tab (Type, Shape, Brush, Anchors, Path, Group,
// Image, Artboard) shows while its `when` holds. Adding a tab is adding ONE
// file. See README.md.

import type { DrawBarTab } from '../editor/types'

const modules = import.meta.glob<{ default: DrawBarTab }>('./*.tab.tsx', { eager: true })

const TABS: DrawBarTab[] = Object.entries(modules)
  .map(([file, m]) => {
    if (!m.default || typeof m.default.id !== 'string') throw new Error(`${file} does not default-export a DrawBarTab`)
    return m.default
  })
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

export function drawBarTabs(): DrawBarTab[] {
  return TABS
}

export function barTabById(id: string): DrawBarTab | undefined {
  return TABS.find((t) => t.id === id)
}
