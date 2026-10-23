import type { OfficeCommand } from '../../../../lib/menus/officeCommand'
import type { ShortcutKeys } from '@shared/menus/shortcuts'
import { drawCommands } from './registry'
import { commandKeys } from './keys'
import type { Command, EditorCtx } from '../editor/types'

// PlexiiDraw's command registry, seen as OfficeCommands (SPEC §9.9): Draw keeps
// its registry (its menu bar, ribbon, right-click and keys already render from
// it, one definition per action); this adapts it so the cross-app registry
// guard covers Draw with the others. Keys come from the live keymap (a person's
// remapping included), so the hint is the key that is really bound.

/** "mod+alt+shift+k" → ['mod','alt','shift','k'] (the shared hint formatter's input). */
export function keysOf(k: string): ShortcutKeys {
  const parts = k.split('+').filter(Boolean)
  return parts as unknown as ShortcutKeys
}

export function toOfficeCommand(c: Command, ctx: EditorCtx): OfficeCommand {
  const [k] = commandKeys(c.id)
  return {
    id: c.id,
    label: c.label,
    ...(c.icon ? { icon: c.icon } : {}),
    ...(k ? { keys: keysOf(k) } : {}),
    ...(c.enabled ? { enabled: () => c.enabled!(ctx) } : {}),
    ...(c.enabled || c.pending ? { reason: () => c.pending ?? c.disabledReason?.(ctx) ?? undefined } : {}),
    ...(c.checked ? { checked: () => c.checked!(ctx) } : {}),
    run: () => void ctx.run(c.id)
  }
}

/** Every command Draw shows in a menu, as OfficeCommands. */
export function drawOfficeCommands(ctx: EditorCtx): OfficeCommand[] {
  return drawCommands()
    .filter((c) => c.menu)
    .map((c) => toOfficeCommand(c, ctx))
}
