// Object › Transform: Transform Again (⌘D), Move… (⇧⌘M), Rotate…, Reflect…,
// Scale…, Shear…, Transform Each… (⌥⇧⌘D), Reset Bounding Box, and the
// Transform panel's Flip Horizontal / Flip Vertical. The dialogs live in
// dialogs/transform*.dialog.tsx; everything applies through transform/apply.ts.

import type { Matrix, Pt } from '@shared/drawGeometry'
import { isFiniteMatrix, uiReflect } from '@shared/draw/geometry/transform'
import { resetBoundingBox, selectionNeedsFrameMatrix, turnedFrameIds } from '@shared/draw/ops'
import { v2BlockedReason } from '../editor/v2gate'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'
import { applyAboutRef, applyTransform, editableBounds, editableSelection, lastTransform, transformAgain, v2Allowed } from '../transform/apply'
import { transformPrefs } from '../transform/prefs'
import { firstOf, gate, notReadOnly, unless, type Why } from './gate'

const NOTHING_EDITABLE = 'Select something that is not locked or hidden first.'
const editWhy: Why = firstOf(notReadOnly, unless((ctx) => editableSelection(ctx.get()).length > 0, NOTHING_EDITABLE))

/** Transform Again: a transform to repeat, and something to repeat it on (transform/apply.ts canTransformAgain). */
const againWhy: Why = firstOf(
  notReadOnly,
  unless((ctx) => lastTransform(ctx.get()) !== null, 'There is no transform to repeat yet.'),
  unless((ctx) => editableSelection(ctx.get()).length > 0, 'Select something to transform again.')
)

/** Open one of the transform dialogs; a tool passes the origin the user set. */
export function openTransformDialog(ctx: EditorCtx, id: 'move' | 'rotate' | 'reflect' | 'scale' | 'shear' | 'each', origin?: Pt): void {
  const no = editWhy(ctx)
  if (no) {
    ctx.status(no)
    return
  }
  ctx.set({ dialog: { id: `transform-${id}`, props: origin ? { origin } : {} } })
}

/** Would flipping need a frame matrix this drawing cannot hold? */
function flipBlocked(ctx: EditorCtx): boolean {
  const s = ctx.get()
  if (v2Allowed(s)) return false
  const box = editableBounds(s.doc, s.selection)
  return !!box && selectionNeedsFrameMatrix(s.doc, s.selection, uiReflect(90, { x: box.x, y: box.y }))
}

const flipWhy: Why = firstOf(editWhy, (ctx) => (flipBlocked(ctx) ? `Flipping this needs the newer drawing format: ${v2BlockedReason(ctx.get())}.` : null))

const resetWhy: Why = firstOf(
  notReadOnly,
  (ctx) => (v2Allowed(ctx.get()) ? null : `Reset Bounding Box needs the newer drawing format: ${v2BlockedReason(ctx.get())}.`),
  unless((ctx) => turnedFrameIds(ctx.doc(), ctx.get().selection).length > 0, 'Nothing selected has a turned bounding box to reset.')
)

export const menus: MenuSpec[] = [{ path: 'object/Transform', label: 'Transform', icon: 'transform', order: 90 }]

export const commands: Command[] = [
  {
    id: 'object.transformAgain',
    label: 'Transform Again',
    icon: 'repeat',
    menu: { path: 'object/Transform', order: 0 },
    ...gate(againWhy),
    run: (ctx) => {
      transformAgain(ctx)
    }
  },
  {
    id: 'object.transform.move',
    label: 'Move…',
    menu: { path: 'object/Transform', order: 100 },
    ...gate(editWhy),
    run: (ctx) => openTransformDialog(ctx, 'move')
  },
  { id: 'object.transform.rotate', label: 'Rotate…', menu: { path: 'object/Transform', order: 101 }, ...gate(editWhy), run: (ctx) => openTransformDialog(ctx, 'rotate') },
  { id: 'object.transform.reflect', label: 'Reflect…', menu: { path: 'object/Transform', order: 102 }, ...gate(editWhy), run: (ctx) => openTransformDialog(ctx, 'reflect') },
  { id: 'object.transform.scale', label: 'Scale…', menu: { path: 'object/Transform', order: 103 }, ...gate(editWhy), run: (ctx) => openTransformDialog(ctx, 'scale') },
  { id: 'object.transform.shear', label: 'Shear…', menu: { path: 'object/Transform', order: 104 }, ...gate(editWhy), run: (ctx) => openTransformDialog(ctx, 'shear') },
  {
    id: 'object.transform.each',
    label: 'Transform Each…',
    menu: { path: 'object/Transform', order: 200 },
    ...gate(editWhy),
    run: (ctx) => openTransformDialog(ctx, 'each')
  },
  {
    id: 'object.transform.resetBoundingBox',
    label: 'Reset Bounding Box',
    menu: { path: 'object/Transform', order: 300 },
    // Only a turned text, image or work widget has a box to reset (paths keep a
    // box square to the page already), and it needs a drawing that can hold a matrix.
    ...gate(resetWhy),
    run: (ctx) => {
      const s = ctx.get()
      if (!v2Allowed(s)) {
        ctx.status(`Reset Bounding Box needs the newer drawing format: ${v2BlockedReason(s)}.`)
        return
      }
      const next = resetBoundingBox(s.doc, s.selection)
      if (next === s.doc) {
        ctx.status('Nothing selected has a turned bounding box to reset.')
        return
      }
      ctx.history.commit(next, 'Reset Bounding Box')
    }
  },
  {
    id: 'object.flipHorizontal',
    label: 'Flip Horizontal',
    icon: 'flip',
    menu: { path: 'object/Transform', order: 400 },
    ...gate(flipWhy),
    run: (ctx) => {
      applyAboutRef(ctx, uiReflect(90, { x: 0, y: 0 }), transformPrefs.getState().refPoint, { label: 'Flip Horizontal' })
    }
  },
  {
    id: 'object.flipVertical',
    label: 'Flip Vertical',
    icon: 'flip',
    menu: { path: 'object/Transform', order: 401 },
    ...gate(flipWhy),
    run: (ctx) => {
      applyAboutRef(ctx, uiReflect(0, { x: 0, y: 0 }), transformPrefs.getState().refPoint, { label: 'Flip Vertical' })
    }
  },
  {
    // For callers with a matrix in hand (the assistant, MCP, a script): one
    // undo step, remembered for Transform Again.
    id: 'object.transform.apply',
    label: 'Transform',
    ...gate(editWhy),
    run: (ctx, args) => {
      const a = (args ?? {}) as { matrix?: Matrix; label?: string; copy?: boolean }
      if (!Array.isArray(a.matrix) || !isFiniteMatrix(a.matrix as Matrix)) {
        ctx.status('That transform is not a valid matrix.')
        return
      }
      applyTransform(ctx, a.matrix as Matrix, { label: a.label ?? 'Transform', copy: a.copy === true })
    }
  }
]
