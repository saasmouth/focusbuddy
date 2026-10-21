// Object › Transform: Transform Again (⌘D), Move… (⇧⌘M), Rotate…, Reflect…,
// Scale…, Shear…, Transform Each… (⌥⇧⌘D), Reset Bounding Box, and the
// Transform panel's Flip Horizontal / Flip Vertical. The dialogs live in
// dialogs/transform*.dialog.tsx; everything applies through transform/apply.ts.

import type { Matrix, Pt } from '@shared/drawGeometry'
import { isFiniteMatrix, uiReflect } from '@shared/draw/geometry/transform'
import { resetBoundingBox, selectionNeedsFrameMatrix, turnedFrameIds } from '@shared/draw/ops'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'
import { applyAboutRef, applyTransform, canTransformAgain, editableBounds, editableSelection, transformAgain, v2Allowed } from '../transform/apply'
import { transformPrefs } from '../transform/prefs'

const canEdit = (ctx: EditorCtx): boolean => !ctx.get().readOnly && editableSelection(ctx.get()).length > 0

/** Open one of the transform dialogs; a tool passes the origin the user set. */
export function openTransformDialog(ctx: EditorCtx, id: 'move' | 'rotate' | 'reflect' | 'scale' | 'shear' | 'each', origin?: Pt): void {
  if (!canEdit(ctx)) {
    ctx.status('Select something that is not locked or hidden first.')
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

export const menus: MenuSpec[] = [{ path: 'object/Transform', label: 'Transform', icon: 'transform', order: 90 }]

export const commands: Command[] = [
  {
    id: 'object.transformAgain',
    label: 'Transform Again',
    icon: 'repeat',
    shortcut: '⌘D',
    menu: { path: 'object/Transform', order: 0 },
    enabled: canTransformAgain,
    run: (ctx) => {
      transformAgain(ctx)
    }
  },
  {
    id: 'object.transform.move',
    label: 'Move…',
    shortcut: '⇧⌘M',
    menu: { path: 'object/Transform', order: 100 },
    enabled: canEdit,
    run: (ctx) => openTransformDialog(ctx, 'move')
  },
  { id: 'object.transform.rotate', label: 'Rotate…', menu: { path: 'object/Transform', order: 101 }, enabled: canEdit, run: (ctx) => openTransformDialog(ctx, 'rotate') },
  { id: 'object.transform.reflect', label: 'Reflect…', menu: { path: 'object/Transform', order: 102 }, enabled: canEdit, run: (ctx) => openTransformDialog(ctx, 'reflect') },
  { id: 'object.transform.scale', label: 'Scale…', menu: { path: 'object/Transform', order: 103 }, enabled: canEdit, run: (ctx) => openTransformDialog(ctx, 'scale') },
  { id: 'object.transform.shear', label: 'Shear…', menu: { path: 'object/Transform', order: 104 }, enabled: canEdit, run: (ctx) => openTransformDialog(ctx, 'shear') },
  {
    id: 'object.transform.each',
    label: 'Transform Each…',
    shortcut: '⌥⇧⌘D',
    menu: { path: 'object/Transform', order: 200 },
    enabled: canEdit,
    run: (ctx) => openTransformDialog(ctx, 'each')
  },
  {
    id: 'object.transform.resetBoundingBox',
    label: 'Reset Bounding Box',
    menu: { path: 'object/Transform', order: 300 },
    // Only a turned text, image or work widget has a box to reset (paths keep a
    // box square to the page already), and it needs a drawing that can hold a matrix.
    enabled: (ctx) => {
      const s = ctx.get()
      return !s.readOnly && v2Allowed(s) && turnedFrameIds(s.doc, s.selection).length > 0
    },
    run: (ctx) => {
      const s = ctx.get()
      if (!v2Allowed(s)) {
        ctx.status('Reset Bounding Box needs the newer drawing format, which is not switched on yet.')
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
    enabled: (ctx) => canEdit(ctx) && !flipBlocked(ctx),
    run: (ctx) => {
      applyAboutRef(ctx, uiReflect(90, { x: 0, y: 0 }), transformPrefs.getState().refPoint, { label: 'Flip Horizontal' })
    }
  },
  {
    id: 'object.flipVertical',
    label: 'Flip Vertical',
    icon: 'flip',
    menu: { path: 'object/Transform', order: 401 },
    enabled: (ctx) => canEdit(ctx) && !flipBlocked(ctx),
    run: (ctx) => {
      applyAboutRef(ctx, uiReflect(0, { x: 0, y: 0 }), transformPrefs.getState().refPoint, { label: 'Flip Vertical' })
    }
  },
  {
    // For callers with a matrix in hand (the assistant, MCP, a script): one
    // undo step, remembered for Transform Again.
    id: 'object.transform.apply',
    label: 'Transform',
    enabled: canEdit,
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
