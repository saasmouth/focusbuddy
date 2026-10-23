import { MENU, actionKeys, type MenuAction, type MenuActionId } from '@shared/menus/lexicon'
import { shortcutLabel, type ShortcutKeys } from '@shared/menus/shortcuts'

// A shared menu action's label and this platform's shortcut hint, from the one
// lexicon (SPEC §9.4). Menu bars and right-click menus spread it into an item:
//   { kind: 'item', ...menuAction('redo'), icon: 'redo', run: redo }
// so the same action reads and hints the same in every app.

export function menuPlatform(): string {
  const p = (window as unknown as { api?: { platform?: string } }).api?.platform
  if (p) return p
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'darwin' : 'win32'
}

/** A key combination's hint on this platform (for an app-specific action not in the lexicon). */
export function hint(keys: ShortcutKeys): string {
  return shortcutLabel(keys, menuPlatform())
}

export function menuAction(id: MenuActionId): { label: string; shortcut?: string } {
  const a = MENU[id] as MenuAction
  const keys = actionKeys(a, menuPlatform())
  return keys ? { label: a.label, shortcut: shortcutLabel(keys, menuPlatform()) } : { label: a.label }
}
