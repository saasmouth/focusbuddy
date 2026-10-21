// Help menu.

import type { Command, MenuSpec } from '../editor/types'

export const menus: MenuSpec[] = [{ path: 'help', label: 'Help', order: 70 }]

export const commands: Command[] = [
  { id: 'help.howItWorks', label: 'How PlexiiDraw works', icon: 'help', menu: { path: 'help', order: 100 }, run: (ctx) => ctx.set({ dialog: { id: 'help' } }) }
]
