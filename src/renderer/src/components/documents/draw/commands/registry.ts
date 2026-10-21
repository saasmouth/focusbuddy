// The command registry. Every `*.commands.ts` file in this folder is picked up
// automatically; each exports `commands: Command[]` and, when it adds a menu
// or a submenu heading, `menus: MenuSpec[]`. The menu bar, the keyboard and any
// other caller (an assistant, MCP, a future command palette) run commands by
// id, so adding one is adding to -- or adding -- ONE file. See README.md.

import type { Command, MenuSpec } from '../editor/types'
import { KEYMAP } from './keymap'

interface CommandModule {
  commands?: Command[]
  menus?: MenuSpec[]
}

const modules = import.meta.glob<CommandModule>('./*.commands.ts', { eager: true })

const COMMANDS: Command[] = []
const MENUS: MenuSpec[] = []
for (const m of Object.values(modules)) {
  COMMANDS.push(...(m.commands ?? []))
  MENUS.push(...(m.menus ?? []))
}

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]))

export function drawCommands(): Command[] {
  return COMMANDS
}

export function commandById(id: string): Command | undefined {
  return BY_ID.get(id)
}

export function drawMenus(): MenuSpec[] {
  return MENUS
}

/**
 * The key string a keyboard event is looked up by: `mod+` for ⌘ or Ctrl, then
 * `shift+` when held, then the key ('z', 'escape', 'arrowleft', '['). Alt is
 * ignored, as it always has been for these shortcuts.
 */
export function keyString(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, withShift = true): string {
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (withShift && e.shiftKey) parts.push('shift')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

/**
 * The binding for an event: an exact match first, then the same keys without
 * Shift (so ⇧⌘Y still redoes and ⇧-arrows still nudge -- the command reads
 * Shift itself -- while ⇧⌘Z is its own binding).
 */
export function keyBinding(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): { command: string; preventDefault: boolean } | null {
  const exact = KEYMAP[keyString(e, true)]
  const loose = e.shiftKey ? KEYMAP[keyString(e, false)] : undefined
  const hit = exact ?? loose
  if (!hit) return null
  const [command, flag] = hit
  return { command, preventDefault: flag === 'prevent' }
}

/** Problems with the registry: duplicate ids, keymap entries naming no command. Empty when healthy. */
export function commandRegistryProblems(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const c of COMMANDS) {
    if (seen.has(c.id)) out.push(`command id "${c.id}" is registered twice`)
    seen.add(c.id)
  }
  for (const [k, [id]] of Object.entries(KEYMAP)) if (!BY_ID.has(id)) out.push(`key "${k}" runs unknown command "${id}"`)
  const menuPaths = new Set(MENUS.map((m) => m.path))
  for (const c of COMMANDS) {
    if (!c.menu) continue
    const top = c.menu.path.split('/')[0]
    if (!menuPaths.has(top)) out.push(`command "${c.id}" is placed in unknown menu "${top}"`)
    if (c.menu.path.includes('/') && !menuPaths.has(c.menu.path)) out.push(`command "${c.id}" is placed in unknown submenu "${c.menu.path}"`)
  }
  return out
}
