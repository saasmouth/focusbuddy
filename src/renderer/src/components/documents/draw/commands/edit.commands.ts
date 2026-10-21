// Edit menu, plus the editing keys that have no menu item (Escape, nudges).

import { deleteAnchorsBreak, deleteObjects, duplicateObjects, editableIds, moveAnchors, moveObjects, selectableObjectIds } from '@shared/draw/ops'
import type { Command, EditorCtx, KeyInput, MenuSpec } from '../editor/types'
import { partialAnchors, wholeSelection } from '../editor/anchorSelection'
import { discardPlaceItem } from '../editor/place'
import { finishCurvature } from '../tools/curvature.tool'
import { finishPen, popPenAnchor } from '../tools/pen.tool'
import { nudgeSelection } from '../transform/apply'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly
const hasSelection = (ctx: EditorCtx): boolean => ctx.get().selection.length > 0

export const menus: MenuSpec[] = [{ path: 'edit', label: 'Edit', order: 20 }]

/**
 * Delete the selected objects that are not locked or hidden (one undo step).
 * Anchors picked with Direct Selection go with their segments instead, and
 * the rest of their path stays.
 */
export function deleteSelection(ctx: EditorCtx): void {
  const s = ctx.get()
  const anchors = partialAnchors(s)
  const ids = editableIds(s.doc, wholeSelection(s))
  if (!ids.length && !anchors.length) return
  let doc = s.doc
  let kept: string[] = []
  if (anchors.length) {
    const r = deleteAnchorsBreak(doc, anchors)
    doc = r.doc
    kept = r.ids
  }
  if (ids.length) doc = deleteObjects(doc, ids)
  if (doc === s.doc) return
  ctx.history.commit(doc, anchors.length ? 'Delete anchor points' : 'Delete')
  ctx.select(kept)
}

/**
 * Arrow keys: anchors picked with Direct Selection move on their own (by the
 * document's Keyboard Increment, ×10 with Shift); otherwise the selection
 * moves as objects through the transform code, where Alt nudges a copy and the
 * nudge is remembered for Transform Again (transform/apply.ts).
 */
function nudge(dx: number, dy: number): Command['run'] {
  return (ctx, args) => {
    const s = ctx.get()
    const anchors = partialAnchors(s)
    if (!anchors.length) return nudgeSelection(ctx, dx, dy, args as KeyInput | undefined)
    const inc = s.doc.settings.keyIncrement && s.doc.settings.keyIncrement > 0 ? s.doc.settings.keyIncrement : 1
    const step = ((args as KeyInput | undefined)?.shiftKey ? 10 : 1) * inc
    let doc = moveObjects(s.doc, editableIds(s.doc, wholeSelection(s)), dx * step, dy * step)
    doc = moveAnchors(doc, anchors, dx * step, dy * step)
    ctx.history.commit(doc, 'Nudge anchor points')
  }
}

export const commands: Command[] = [
  {
    id: 'edit.undo',
    label: 'Undo',
    icon: 'undo',
    menu: { path: 'edit', order: 100 },
    // Inside a pen path, ⌘Z takes back its last point (Illustrator).
    enabled: (ctx) => writable(ctx) && (ctx.get().pen !== null || ctx.history.canUndo()),
    run: (ctx) => (ctx.get().pen ? popPenAnchor(ctx) : ctx.history.undo())
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    icon: 'redo',
    menu: { path: 'edit', order: 110 },
    enabled: (ctx) => writable(ctx) && ctx.history.canRedo(),
    run: (ctx) => ctx.history.redo()
  },
  {
    id: 'edit.selectAll',
    label: 'Select all',
    icon: 'select_all',
    // Its own group after the clipboard and duplicate/delete items (Illustrator keeps it out of Edit's paste group).
    menu: { path: 'edit', order: 300 },
    // Nothing hidden or locked -- the same rule for the menu and for ⌘A.
    run: (ctx) => ctx.select(selectableObjectIds(ctx.doc()))
  },
  {
    id: 'edit.deselect',
    label: 'Deselect',
    icon: 'deselect',
    menu: { path: 'edit', order: 301 },
    enabled: hasSelection,
    run: (ctx) => ctx.select([])
  },
  {
    id: 'edit.duplicate',
    label: 'Duplicate',
    icon: 'file_copy',
    // ⌘D is Transform Again, as in Illustrator (Object › Transform).
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
    menu: { path: 'edit', order: 220 },
    enabled: (ctx) => writable(ctx) && hasSelection(ctx),
    run: (ctx) => deleteSelection(ctx)
  },
  {
    id: 'edit.escape',
    label: 'Finish path or deselect',
    run: (ctx) => {
      if (ctx.get().pen) finishPen(ctx, false)
      else if (ctx.get().curvature) finishCurvature(ctx, false)
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
    keyWhen: (ctx) => ctx.get().pen !== null || ctx.get().curvature !== null,
    run: (ctx, args) => {
      const close = (args as { close?: boolean } | undefined)?.close === true
      if (ctx.get().pen) finishPen(ctx, close)
      else finishCurvature(ctx, close)
    }
  }
]
