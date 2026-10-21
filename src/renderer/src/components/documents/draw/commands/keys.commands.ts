// Keyboard Shortcuts (Edit menu, as in Illustrator).

import type { Command } from '../editor/types'

export const commands: Command[] = [
  {
    id: 'edit.keyboardShortcuts',
    label: 'Keyboard shortcuts…',
    icon: 'keyboard',
    menu: { path: 'edit', order: 900 },
    run: (ctx) => ctx.set({ dialog: { id: 'keyboard-shortcuts' } })
  }
]
