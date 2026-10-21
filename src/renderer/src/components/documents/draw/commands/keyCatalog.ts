// The rows of the Keyboard Shortcuts dialog, as plain data: every tool, every
// menu command, the canvas keys, and Illustrator's keys for what is still to
// come -- grouped the way Illustrator's Edit › Keyboard Shortcuts groups them
// (Tools, Menu Commands). Pure, so the dialog and the tests read the same list.

import type { DrawTool } from '../editor/types'
import { drawTools } from '../tools/registry'
import { KEYMAP, RESERVED_KEYS } from './keymap'
import { commandKeys, formatKey, toolKey, toolKeyString, type KeyPlatform } from './keys'
import { drawCommands, drawMenus } from './registry'

export interface ShortcutRow {
  group: 'tools' | 'menu'
  /** Heading inside the group: 'Tools', 'Edit', 'Object › Arrange', 'Canvas keys', 'From Illustrator, still to come'. */
  section: string
  kind: 'tool' | 'command' | 'reserved'
  id: string
  label: string
  /** The live keys (after any remapping), best first. */
  keys: string[]
  /** The default keys. */
  defaultKeys: string[]
  /** The person may change this row's key. */
  remappable: boolean
  /** Why the row does nothing yet (pending and reserved rows). */
  reason?: string
}

/** Human names for the packages that deliver reserved features. */
const ARRIVES: Record<string, string> = {
  'WP-APPEAR': 'the Appearance panel',
  'WP-ARTBOARD': 'multiple artboards',
  'WP-BLEND': 'blends',
  'WP-BRUSHV': 'vector brushes',
  'WP-CLIPBOARD': 'copy and paste',
  'WP-COLOR': 'swatches and colour',
  'WP-EFFECTS': 'effects',
  'WP-ENVELOPE': 'envelope distort',
  'WP-EXPORT': 'more export options',
  'WP-IMPORT': 'place and import',
  'WP-LAYERS': 'object layers',
  'WP-LIQUIFY': 'the liquify tools',
  'WP-OBJ': 'groups, masks and compound paths',
  'WP-PAINT': 'gradients and patterns',
  'WP-PATH': 'full path editing',
  'WP-PATHFINDER': 'the full Pathfinder',
  'WP-PREFS': 'preferences',
  'WP-SHAPEBUILDER': 'the Shape Builder',
  'WP-SNAP': 'rulers and guides',
  'WP-STROKE': 'the Stroke panel',
  'WP-SYMBOLS': 'symbols',
  'WP-TRANSFORM': 'Transform tools',
  'WP-TYPE-A': 'rich type',
  'WP-TYPE-B': 'type outlines',
  'WP-VIEWPORT': 'more view tools'
}

/** "Arrives with Transform tools", or "Not in PlexiiDraw yet" when nothing is planned. */
export function arrivesWith(pkg: string): string {
  const name = ARRIVES[pkg]
  return name ? `Arrives with ${name}` : 'Not in PlexiiDraw yet'
}

function menuSection(path: string): string {
  const menus = drawMenus()
  const top = path.split('/')[0]
  const topLabel = menus.find((m) => m.path === top)?.label ?? top
  if (!path.includes('/')) return topLabel
  const sub = menus.find((m) => m.path === path)?.label ?? path.slice(path.indexOf('/') + 1)
  return `${topLabel} › ${sub}`
}

const TOOL_DEFAULT = (t: DrawTool): string[] => {
  const k = toolKeyString(t.key)
  return k ? [k] : []
}

export function shortcutRows(): ShortcutRow[] {
  const rows: ShortcutRow[] = []
  const realIds = new Set<string>()

  for (const t of drawTools()) {
    // A hidden tool is a mode a command switches to (the Place cursor), not a toolbox button.
    if (t.hidden) continue
    realIds.add(`tool:${t.id}`)
    const k = toolKey(t.id)
    rows.push({
      group: 'tools',
      section: 'Tools',
      kind: 'tool',
      id: t.id,
      label: t.label,
      keys: k ? [k] : [],
      defaultKeys: TOOL_DEFAULT(t),
      remappable: true
    })
  }

  const menus = drawMenus()
  const menuOrder = (path: string): number => {
    const top = menus.find((m) => m.path === path.split('/')[0])?.order ?? 999
    const sub = path.includes('/') ? (menus.find((m) => m.path === path)?.order ?? 0) : 0
    return top * 10000 + sub
  }
  const commands = [...drawCommands()].sort((a, b) => {
    if (!a.menu || !b.menu) return Number(!a.menu) - Number(!b.menu)
    return menuOrder(a.menu.path) - menuOrder(b.menu.path) || a.menu.order - b.menu.order
  })
  for (const c of commands) {
    realIds.add(c.id)
    const defaults = Object.entries(KEYMAP)
      .filter(([, [id]]) => id === c.id)
      .map(([k]) => k)
    const keys = commandKeys(c.id)
    if (c.menu) {
      rows.push({
        group: 'menu',
        section: menuSection(c.menu.path),
        kind: 'command',
        id: c.id,
        label: c.label,
        keys,
        defaultKeys: defaults,
        remappable: !c.pending,
        ...(c.pending ? { reason: c.pending[0].toUpperCase() + c.pending.slice(1) } : {})
      })
    } else if (defaults.length || keys.length) {
      // Keys with no menu item: nudges, Escape, Enter, brush size. Fixed, as the canvas relies on them.
      rows.push({
        group: 'menu',
        section: 'Canvas keys',
        kind: 'command',
        id: c.id,
        label: c.label,
        keys,
        defaultKeys: defaults,
        remappable: false
      })
    }
  }

  // Illustrator's keys for what PlexiiDraw does not have yet. One row per
  // feature (a feature may hold two keys, e.g. rulers on Windows and Mac).
  const byFeature = new Map<string, ShortcutRow>()
  for (const [k, [id, label, pkg]] of Object.entries(RESERVED_KEYS)) {
    if (realIds.has(id)) continue
    const isTool = id.startsWith('tool:')
    const row = byFeature.get(id)
    if (row) {
      row.keys.push(k)
      row.defaultKeys.push(k)
      continue
    }
    const r: ShortcutRow = {
      group: isTool ? 'tools' : 'menu',
      section: 'From Illustrator, still to come',
      kind: 'reserved',
      id,
      label,
      keys: [k],
      defaultKeys: [k],
      remappable: false,
      reason: arrivesWith(pkg)
    }
    byFeature.set(id, r)
    rows.push(r)
  }
  return rows
}

/**
 * Rows matching a search. A key typed as either platform writes it ("⌘D",
 * "ctrl+d", "Shift+E") finds the rows with exactly that key; anything else is
 * words matched against the name, the section and the reason.
 */
export function filterRows(rows: ShortcutRow[], query: string, p?: KeyPlatform): ShortcutRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const compact = q.replace(/\s+/g, '')
  const spellings = (k: string): string[] =>
    [formatKey(k, 'mac'), formatKey(k, 'win'), k].map((x) => x.toLowerCase().replace(/\s+/g, ''))
  const byKey = rows.filter((r) => r.keys.some((k) => spellings(k).includes(compact)))
  if (byKey.length) return byKey
  const words = q.split(/\s+/)
  return rows.filter((r) => {
    const hay =
      `${r.label} ${r.section} ${r.reason ?? ''} ${r.keys.map((k) => formatKey(k, p)).join(' ')}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
