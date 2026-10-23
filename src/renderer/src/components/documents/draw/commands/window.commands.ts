// The Window menu: the overlay panels (Layers F7, as in Illustrator, and
// Artboards), moving keyboard focus between the canvas, the top bar and the
// tool rail, and stepping through a rail flyout. The panels themselves are
// panels/*.panel.tsx; which are open is editor state (openPanels), so the
// menu, the key and the rail button all show and change the same thing.

import type { Command, EditorCtx, MenuSpec } from '../editor/types'
import { cycleFlyout } from '../tools/flyouts'
import { toolById } from '../tools/registry'
import { firstOf, gate, notReadOnly, unless } from './gate'

export const menus: MenuSpec[] = [{ path: 'window', label: 'Window', order: 65 }]

export function panelOpen(ctx: Pick<EditorCtx, 'get'>, id: string): boolean {
  return ctx.get().openPanels.includes(id)
}

/** Open or close an overlay panel (`open` forces one way). */
export function togglePanel(ctx: EditorCtx, id: string, open?: boolean): void {
  ctx.set((s) => {
    const isOpen = s.openPanels.includes(id)
    const want = open ?? !isOpen
    if (want === isOpen) return {}
    return { openPanels: want ? [...s.openPanels, id] : s.openPanels.filter((p) => p !== id) }
  })
}

const panelCommand = (id: string, label: string, icon: string, order: number): Command => ({
  id: `window.${id}`,
  label,
  icon,
  menu: { path: 'window', order },
  checked: (ctx) => panelOpen(ctx, id),
  run: (ctx, args) => togglePanel(ctx, id, typeof args === 'boolean' ? args : undefined)
})

export const commands: Command[] = [
  panelCommand('layers', 'Layers', 'layers', 0),
  panelCommand('artboards', 'Artboards', 'dashboard', 1),
  {
    id: 'window.focusNext',
    label: 'Move focus: canvas, top bar, tools',
    icon: 'keyboard_tab',
    menu: { path: 'window', order: 100 },
    // F6 is Illustrator's Color panel and ⌘F6 its next document, so the
    // studio's focus cycle is ⌥F6 (keymap.ts).
    // Absent only where there is no studio window (a headless run).
    ...gate(unless((ctx) => !!ctx.ui, 'Moving focus needs the studio window.')),
    run: (ctx) => ctx.ui?.cycleFocus()
  },
  {
    id: 'tool.nextInGroup',
    label: 'Next tool in group',
    icon: 'switch_access_shortcut',
    menu: { path: 'window', order: 101 },
    // Illustrator steps through a toolbar group with Option/Alt-click on its
    // button; the rail does that too. This is the same step as a command, with
    // no default key (every Shift+letter of a group is an Illustrator key
    // already); give it one in Edit › Keyboard shortcuts.
    ...gate(
      firstOf(notReadOnly, (ctx) => {
        const t = toolById(ctx.get().tool)
        return t?.flyout ? null : `The ${t?.label ?? 'current'} tool is not grouped with other tools. Pick one that is, such as the Pen.`
      })
    ),
    run: (ctx) => {
      const f = toolById(ctx.get().tool)?.flyout
      if (f) cycleFlyout(ctx, f)
    }
  }
]
