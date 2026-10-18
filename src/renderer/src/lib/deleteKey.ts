// Delete / Backspace on a canvas selection — docs/widget-files.md, "Remove or
// delete".
//
// The key asks the same question the × does (lib/widgetRemoval): "Remove from
// this desk" or "Delete work widget", for one work widget or many. This module
// is only the decision of WHEN the key means that, kept pure so it is tested
// without a renderer.
//
// It reuses the quick-add focus gate (lib/quickAddFocus): Backspace is the key
// people press most while writing, so it may only reach the canvas when focus
// is confirmed to be somewhere that is not a text field, a control, a dialog or
// an opaque web view. One difference from quick-add: a widget the person has
// clicked into is allowed when it is part of the selection (shift-clicking a
// header both selects and activates), because the selection is then exactly
// what they are pointing at. A clicked-into widget OUTSIDE the selection means
// they are working in it, so the key is theirs and nothing is removed.

import { focusBlocksQuickAdd } from './quickAddFocus'

export interface DeleteKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  repeat?: boolean
}

/** Delete or Backspace with no command modifier, and not a held-key repeat. */
export function isDeleteKey(e: DeleteKeyEvent): boolean {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return false
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  return !e.repeat
}

export interface DeleteKeyContext {
  /** The desk on screen. The key means nothing without one. */
  activeTaskId: string | null
  /** The canvas selection (marquee, shift-click, ⌘A). */
  selectedIds: readonly string[]
  /** The widget clicked into, if any. */
  activeWidgetId: string | null
  /** The widget open in focus mode, if any. */
  focusedWidgetId: string | null
  /** document.activeElement, pierced through shadow roots. */
  focusedElement: Element | null
}

/** True when Delete / Backspace should ask to remove or delete the selection. */
export function deleteKeyAllowed(ctx: DeleteKeyContext): boolean {
  if (!ctx.activeTaskId) return false
  if (ctx.selectedIds.length === 0) return false
  if (ctx.focusedWidgetId) return false
  if (ctx.activeWidgetId && !ctx.selectedIds.includes(ctx.activeWidgetId)) return false
  if (focusBlocksQuickAdd(ctx.focusedElement)) return false
  return true
}
