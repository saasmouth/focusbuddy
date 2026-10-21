// The command registry. Every `*.commands.ts` file in this folder is picked up
// automatically; each exports `commands: Command[]` and, when it adds a menu
// or a submenu heading, `menus: MenuSpec[]`. The menu bar, the keyboard and any
// other caller (an assistant, MCP, a future command palette) run commands by
// id, so adding one is adding to -- or adding -- ONE file. See README.md.

import type { Command, MenuSpec } from '../editor/types'
import { drawTools } from '../tools/registry'
import { KEYMAP, RESERVED_KEYS } from './keymap'
import { eventKeyString, resolveKey, toolKeyString } from './keys'

interface CommandModule {
  commands?: Command[]
  menus?: MenuSpec[]
}

const modules = import.meta.glob<CommandModule>('./*.commands.ts', { eager: true })

const ALL: Command[] = []
const MENUS: MenuSpec[] = []
for (const m of Object.values(modules)) {
  ALL.push(...(m.commands ?? []))
  MENUS.push(...(m.menus ?? []))
}
// A `pending` command holds a key and a menu place for a feature another
// package delivers (Transform Again until WP-TRANSFORM). The real command, once
// merged, replaces it with no edit here or there.
export function withoutReplacedPending(all: Command[]): Command[] {
  const real = new Set(all.filter((c) => !c.pending).map((c) => c.id))
  return all.filter((c) => !c.pending || !real.has(c.id))
}
const COMMANDS: Command[] = withoutReplacedPending(ALL)

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
 * `alt+`, then `shift+` when held, then the key (see keys.ts: eventKeyString).
 */
export function keyString(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean; shiftKey: boolean }, withShift = true): string {
  return eventKeyString(e, { shift: withShift })
}

/**
 * The COMMAND an event runs, if any (see keys.ts: resolveKey for the order
 * chords are tried in, the person's remappings and the reserved keys).
 */
export function keyBinding(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean; shiftKey: boolean }): { command: string; preventDefault: boolean } | null {
  const hit = resolveKey(e)
  return hit?.kind === 'command' ? { command: hit.id, preventDefault: hit.prevent } : null
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
  // A reserved Illustrator key may only go to the feature it is reserved for.
  for (const [k, [id]] of Object.entries(KEYMAP)) {
    const r = RESERVED_KEYS[k]
    if (r && r[0] !== id) out.push(`key "${k}" is reserved for ${r[1]} ("${r[0]}", ${r[2]}) but runs "${id}"`)
  }
  for (const t of drawTools()) {
    const k = toolKeyString(t.key)
    const r = k ? RESERVED_KEYS[k] : undefined
    if (r && r[0] !== `tool:${t.id}`) out.push(`tool key "${k}" of ${t.id} is reserved for ${r[1]} ("${r[0]}", ${r[2]})`)
  }
  for (const c of ALL) if (c.pending && !c.enabled) out.push(`pending command "${c.id}" must say it is disabled (enabled: () => false)`)
  const menuPaths = new Set(MENUS.map((m) => m.path))
  for (const c of COMMANDS) {
    if (!c.menu) continue
    const top = c.menu.path.split('/')[0]
    if (!menuPaths.has(top)) out.push(`command "${c.id}" is placed in unknown menu "${top}"`)
    if (c.menu.path.includes('/') && !menuPaths.has(c.menu.path)) out.push(`command "${c.id}" is placed in unknown submenu "${c.menu.path}"`)
  }
  return out
}
