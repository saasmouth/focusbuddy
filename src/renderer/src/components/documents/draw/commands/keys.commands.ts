// Keyboard Shortcuts (Edit menu, as in Illustrator), and Transform Again's
// place on ⌘D until the Transform package delivers the real command.

import type { Command } from '../editor/types'

export const commands: Command[] = [
  {
    id: 'edit.keyboardShortcuts',
    label: 'Keyboard shortcuts…',
    icon: 'keyboard',
    menu: { path: 'edit', order: 900 },
    run: (ctx) => ctx.set({ dialog: { id: 'keyboard-shortcuts' } })
  },
  {
    // Illustrator's ⌘D. WP-TRANSFORM registers the real `object.transformAgain`
    // (Object › Transform › Transform Again), which replaces this stand-in.
    id: 'object.transformAgain',
    label: 'Transform again',
    menu: { path: 'object', order: 50 },
    pending: 'arrives with Transform tools',
    enabled: () => false,
    // Reached only by a direct ctx.run (the menu and the key respect `enabled`):
    // say so rather than look as if something happened.
    run: (ctx) => ctx.status('Transform again arrives with Transform tools.')
  }
]
