// Edit menu, plus the editing keys that have no menu item (Escape, nudges).

import { deleteAnchorsBreak, deleteObjects, duplicateObjects, editableIds, moveAnchors, moveObjects } from '@shared/draw/ops'
import { exitIsolation, isIsolated, selectableInScope } from '../editor/isolation'
import type { Command, EditorCtx, KeyInput, MenuSpec } from '../editor/types'
import { partialAnchors, wholeSelection } from '../editor/anchorSelection'
import { discardPlaceItem } from '../editor/place'
import { finishCurvature } from '../tools/curvature.tool'
import { finishPen, popPenAnchor } from '../tools/pen.tool'
import { nudgeSelection } from '../transform/apply'
import { escapeIntent } from '../../../office/shell/chrome'
import { firstOf, gate, notReadOnly, unless } from './gate'

/** Selection tools: Esc deselects with these rather than switching tool. */
const SELECTION_TOOLS = new Set(['select', 'direct', 'groupSelect', 'lasso'])

const hasSelection = (ctx: EditorCtx): boolean => ctx.get().selection.length > 0
/** What Duplicate acts on: selected objects that are not locked or hidden. */
const duplicable = (ctx: EditorCtx): string[] => editableIds(ctx.get().doc, ctx.get().selection)
/** What Delete acts on: those, or anchors picked with Direct Selection (deleteSelection). */
const deletable = (ctx: EditorCtx): boolean => {
  const s = ctx.get()
  return editableIds(s.doc, wholeSelection(s)).length > 0 || partialAnchors(s).length > 0
}

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
    ...gate(firstOf(notReadOnly, unless((ctx) => ctx.get().pen !== null || ctx.history.canUndo(), 'Nothing to undo yet.'))),
    run: (ctx) => (ctx.get().pen ? popPenAnchor(ctx) : ctx.history.undo())
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    icon: 'redo',
    menu: { path: 'edit', order: 110 },
    ...gate(firstOf(notReadOnly, unless((ctx) => ctx.history.canRedo(), 'Nothing to redo.'))),
    run: (ctx) => ctx.history.redo()
  },
  {
    id: 'edit.selectAll',
    label: 'Select all',
    icon: 'select_all',
    // Its own group after the clipboard and duplicate/delete items (Illustrator keeps it out of Edit's paste group).
    menu: { path: 'edit', order: 300 },
    // Nothing hidden or locked -- the same rule for the menu and for ⌘A.
    // In isolation mode, everything in the isolated group.
    run: (ctx) => ctx.select(selectableInScope(ctx.get()))
  },
  {
    id: 'edit.deselect',
    label: 'Deselect',
    icon: 'deselect',
    menu: { path: 'edit', order: 301 },
    ...gate(unless(hasSelection, 'Nothing is selected.')),
    run: (ctx) => ctx.select([])
  },
  {
    id: 'edit.duplicate',
    label: 'Duplicate',
    icon: 'file_copy',
    // ⌘D is Transform Again, as in Illustrator (Object › Transform).
    menu: { path: 'edit', order: 210 },
    // Locked and hidden objects are never duplicated, so a selection of only those leaves it off.
    ...gate(firstOf(notReadOnly, unless(hasSelection, 'Select something to duplicate.'), unless((ctx) => duplicable(ctx).length > 0, 'Locked or hidden objects cannot be duplicated.'))),
    run: (ctx) => {
      const s = ctx.get()
      const ids = duplicable(ctx)
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
    ...gate(firstOf(notReadOnly, unless(hasSelection, 'Select something to delete.'), unless(deletable, 'Locked or hidden objects cannot be deleted.'))),
    run: (ctx) => deleteSelection(ctx)
  },
  {
    id: 'edit.escape',
    label: 'Finish path or deselect',
    run: (ctx) => {
      if (ctx.get().pen) finishPen(ctx, false)
      else if (ctx.get().curvature) finishCurvature(ctx, false)
      else if (ctx.get().placing) discardPlaceItem(ctx)
      // An armed tool goes back to Select, as in every office app (SPEC §3.2);
      // the selection tools are not "armed", so Esc there deselects.
      else if (escapeIntent(ctx.get().tool, false, (t) => !SELECTION_TOOLS.has(t)) === 'disarm') ctx.setTool('select')
      // Esc leaves isolation mode, as in Illustrator.
      else if (isIsolated(ctx.get())) exitIsolation(ctx)
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
