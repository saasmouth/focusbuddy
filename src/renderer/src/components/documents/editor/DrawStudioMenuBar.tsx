import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { MenuBarShell, type MenuDef, type MenuItem } from './menuBarKit'
import { drawCommands, drawMenus } from '../draw/commands/registry'
import { commandShortcutLabel, subscribeKeyOverrides } from '../draw/commands/keys'
import type { Command, EditorCtx } from '../draw/editor/types'

// The PlexiiDraw menu bar, built from the command registry: every menu, item,
// submenu, icon, shortcut label, check mark and disabled state comes from the
// `*.commands.ts` files in documents/draw/commands. A package adds a menu item
// by adding a command with a `menu` placement -- this file never changes.
// Items whose orders fall in different hundreds get a separator between them.

function itemFor(ctx: EditorCtx, c: Command): MenuItem {
  // The live key from the keymap (and the person's remapping), written for this
  // platform; a command's own `shortcut` text only when the keymap holds none.
  const shortcut = commandShortcutLabel(c.id) ?? c.shortcut
  const disabled = c.enabled ? !c.enabled(ctx) : false
  return {
    kind: 'item',
    label: c.label,
    ...(c.icon ? { icon: c.icon } : {}),
    ...(shortcut ? { shortcut } : {}),
    run: () => ctx.run(c.id),
    ...(c.enabled ? { disabled } : {}),
    ...(disabled && (c.pending || c.disabledReason?.(ctx)) ? { hint: c.pending ?? c.disabledReason?.(ctx) ?? undefined } : {}),
    ...(c.checked ? { active: c.checked(ctx) } : {})
  }
}

/** One menu's entries: its commands and its submenus, in order, with separators between hundreds. */
export function buildMenu(ctx: EditorCtx, path: string): MenuItem[] {
  const commands = drawCommands()
  const entries: Array<{ order: number; item: MenuItem }> = []
  for (const c of commands) if (c.menu && c.menu.path === path) entries.push({ order: c.menu.order, item: itemFor(ctx, c) })
  for (const sub of drawMenus()) {
    const parent = sub.path.slice(0, sub.path.lastIndexOf('/'))
    if (!sub.path.includes('/') || parent !== path) continue
    const items = commands
      .filter((c) => c.menu && c.menu.path === sub.path)
      .sort((a, b) => a.menu!.order - b.menu!.order)
      .map((c) => itemFor(ctx, c))
    entries.push({ order: sub.order, item: { kind: 'submenu', label: sub.label, ...(sub.icon ? { icon: sub.icon } : {}), items } })
  }
  entries.sort((a, b) => a.order - b.order)
  const out: MenuItem[] = []
  entries.forEach((e, i) => {
    if (i > 0 && Math.floor(entries[i - 1].order / 100) !== Math.floor(e.order / 100)) out.push({ kind: 'sep' })
    out.push(e.item)
  })
  return out
}

export default function DrawStudioMenuBar({ ctx }: { ctx: EditorCtx }): JSX.Element {
  // Re-render when the person remaps a key, so the menus show the new one.
  const [, setTick] = useState(0)
  useEffect(() => subscribeKeyOverrides(() => setTick((t) => t + 1)), [])
  // Re-render when anything an item's enabled/checked state reads changes.
  useStore(ctx.store, (s) => `${s.past.length}|${s.future.length}|${s.selection.length}|${s.showGrid}|${s.snapOn}|${s.readOnly}|${s.liveUndoTick}|${s.pen ? 1 : 0}`)
  const menus: MenuDef[] = drawMenus()
    .filter((m) => !m.path.includes('/'))
    .sort((a, b) => a.order - b.order)
    .map((m) => ({ id: m.path, label: m.label, build: () => buildMenu(ctx, m.path) }))
  return <MenuBarShell menus={menus} testid="draw-studio-menubar" />
}
