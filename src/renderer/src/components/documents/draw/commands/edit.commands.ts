// Edit menu, plus the editing keys that have no menu item (Escape, nudges).

import { deleteObjects, duplicateObjects, editableIds, moveObjects, selectableObjectIds } from '@shared/draw/ops'
import type { Command, EditorCtx, KeyInput, MenuSpec } from '../editor/types'
import { finishPen } from '../tools/pen.tool'
import { discardPlaceItem } from '../editor/place'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly
const hasSelection = (ctx: EditorCtx): boolean => ctx.get().selection.length > 0

export const menus: MenuSpec[] = [{ path: 'edit', label: 'Edit', order: 20 }]

/** Delete the selected objects that are not locked or hidden (one undo step). */
export function deleteSelection(ctx: EditorCtx): void {
  const s = ctx.get()
  const ids = editableIds(s.doc, s.selection)
  if (!ids.length) return
  ctx.history.commit(deleteObjects(s.doc, ids), 'Delete')
  ctx.select([])
}

function nudge(dx: number, dy: number): Command['run'] {
  return (ctx, args) => {
    const step = (args as KeyInput | undefined)?.shiftKey ? 10 : 1
    const s = ctx.get()
    ctx.history.commit(moveObjects(s.doc, editableIds(s.doc, s.selection), dx * step, dy * step), 'Nudge')
  }
}

export const commands: Command[] = [
  {
    id: 'edit.undo',
    label: 'Undo',
    icon: 'undo',
    shortcut: '⌘Z',
    menu: { path: 'edit', order: 100 },
    enabled: (ctx) => writable(ctx) && ctx.history.canUndo(),
    run: (ctx) => ctx.history.undo()
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    icon: 'redo',
    shortcut: '⇧⌘Z',
    menu: { path: 'edit', order: 110 },
    enabled: (ctx) => writable(ctx) && ctx.history.canRedo(),
    run: (ctx) => ctx.history.redo()
  },
  {
    id: 'edit.selectAll',
    label: 'Select all',
    icon: 'select_all',
    shortcut: '⌘A',
    menu: { path: 'edit', order: 200 },
    // Nothing hidden or locked -- the same rule for the menu and for ⌘A.
    run: (ctx) => ctx.select(selectableObjectIds(ctx.doc()))
  },
  {
    id: 'edit.duplicate',
    label: 'Duplicate',
    icon: 'file_copy',
    shortcut: '⌘D',
    menu: { path: 'edit', order: 210 },
    enabled: (ctx) => writable(ctx) && hasSelection(ctx),
    run: (ctx) => {
      const s = ctx.get()
      const ids = editableIds(s.doc, s.selection)
      if (!ids.length) return
      const { doc, newIds } = duplicateObjects(s.doc, ids)
      ctx.history.commit(doc, 'Duplicate')
      ctx.select(newIds)
    }
  },
  {
    id: 'edit.delete',
    label: 'Delete',
    icon: 'delete',
    shortcut: '⌫',
    menu: { path: 'edit', order: 220 },
    enabled: (ctx) => writable(ctx) && hasSelection(ctx),
    run: (ctx) => deleteSelection(ctx)
  },
  {
    id: 'edit.escape',
    label: 'Finish path or deselect',
    run: (ctx) => {
      if (ctx.get().pen) finishPen(ctx, false)
      else if (ctx.get().placing) discardPlaceItem(ctx)
      else ctx.select([])
    }
  },
  { id: 'object.nudgeLeft', label: 'Nudge left', keyWhen: hasSelection, run: nudge(-1, 0) },
  { id: 'object.nudgeRight', label: 'Nudge right', keyWhen: hasSelection, run: nudge(1, 0) },
  { id: 'object.nudgeUp', label: 'Nudge up', keyWhen: hasSelection, run: nudge(0, -1) },
  { id: 'object.nudgeDown', label: 'Nudge down', keyWhen: hasSelection, run: nudge(0, 1) },
  {
    id: 'pen.finish',
    label: 'Finish pen path',
    keyWhen: (ctx) => ctx.get().pen !== null,
    run: (ctx, args) => finishPen(ctx, (args as { close?: boolean } | undefined)?.close === true)
  }
]
