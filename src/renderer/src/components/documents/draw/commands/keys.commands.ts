// Keyboard shortcuts: in Help, under the shared label, as in every office app
// (SPEC §9.2, E-16). Its key stays Illustrator's ⌥⇧⌘K: ⌘/ is Add new fill here.

import type { Command } from '../editor/types'

export const commands: Command[] = [
  {
    id: 'edit.keyboardShortcuts',
    label: 'Keyboard shortcuts',
    icon: 'keyboard',
    menu: { path: 'help', order: 50 },
    run: (ctx) => ctx.set({ dialog: { id: 'keyboard-shortcuts' } })
  }
]
