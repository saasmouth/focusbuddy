// Dialogs a command can open (ctx.set({ dialog: { id } })). Every
// `*.dialog.tsx` file here is picked up automatically and default-exports a
// DrawDialog; the studio shows the open one in a modal.

import type { DrawDialog } from '../editor/types'

const modules = import.meta.glob<{ default: DrawDialog }>('./*.dialog.tsx', { eager: true })
const DIALOGS = new Map(Object.values(modules).map((m) => [m.default.id, m.default]))

export function dialogById(id: string): DrawDialog | undefined {
  return DIALOGS.get(id)
}

export function drawDialogs(): DrawDialog[] {
  return [...DIALOGS.values()]
}
