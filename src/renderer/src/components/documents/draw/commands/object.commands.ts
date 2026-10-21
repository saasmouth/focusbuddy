// Object menu (Pathfinder, Arrange, Align) and the object edits the
// inspector runs: appearance, live-shape parameters, type, path tools.

import type { DrawBlend } from '@shared/draw'
import type { BooleanOp } from '@shared/drawGeometry'
import type { DrawDocPaint, DrawDocStroke, DrawNode, DrawTextNode } from '@shared/draw/model'
import {
  alignObjects,
  arrange,
  booleanObjects,
  distributeObjects,
  editableIds,
  joinPaths,
  mapObjects,
  reshape,
  reversePath,
  setPathClosed,
  type AlignEdge,
  type ArrangeDir
} from '@shared/draw/ops'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly

export const menus: MenuSpec[] = [
  { path: 'object', label: 'Object', order: 30 },
  { path: 'object/Pathfinder', label: 'Pathfinder', icon: 'join_full', order: 100 },
  { path: 'object/Arrange', label: 'Arrange', icon: 'layers', order: 110 },
  { path: 'object/Align', label: 'Align', icon: 'align_horizontal_center', order: 120 }
]

/** Combine the selected paths (Pathfinder); one undo step. */
export function runBoolean(ctx: EditorCtx, op: BooleanOp): void {
  const s = ctx.get()
  const ids = editableIds(s.doc, s.selection)
  const { doc, newId } = booleanObjects(s.doc, ids, op)
  if (doc === s.doc) return
  ctx.history.commit(doc, 'Pathfinder')
  ctx.select(newId ? [newId] : [])
  if (!newId) ctx.status('The subtraction removed the shape entirely.')
}

/** Change the selected objects that may be edited; one undo step. */
export function patchSelected(ctx: EditorCtx, fn: (o: DrawNode) => DrawNode, label = 'Edit'): void {
  const s = ctx.get()
  const ids = editableIds(s.doc, s.selection)
  if (!ids.length) return
  ctx.history.commit(mapObjects(s.doc, ids, fn), label)
}

const BOOLEANS: Array<{ op: BooleanOp; label: string; id: string }> = [
  { op: 'union', label: 'Unite', id: 'unite' },
  { op: 'subtract', label: 'Minus front', id: 'minusFront' },
  { op: 'intersect', label: 'Intersect', id: 'intersect' },
  { op: 'exclude', label: 'Exclude', id: 'exclude' }
]

const ARRANGE: Array<{ dir: ArrangeDir; label: string }> = [
  { dir: 'front', label: 'Bring to front' },
  { dir: 'forward', label: 'Bring forward' },
  { dir: 'backward', label: 'Send backward' },
  { dir: 'back', label: 'Send to back' }
]

const ALIGN: AlignEdge[] = ['left', 'center', 'right', 'top', 'middle', 'bottom']

export const commands: Command[] = [
  ...BOOLEANS.map(
    (b, i): Command => ({
      id: `object.${b.id}`,
      label: b.label,
      menu: { path: 'object/Pathfinder', order: i },
      enabled: writable,
      run: (ctx) => runBoolean(ctx, b.op)
    })
  ),
  { id: 'object.boolean', label: 'Pathfinder', enabled: writable, run: (ctx, op) => runBoolean(ctx, op as BooleanOp) },
  ...ARRANGE.map(
    (a, i): Command => ({
      id: `object.arrange.${a.dir}`,
      label: a.label,
      menu: { path: 'object/Arrange', order: i },
      enabled: writable,
      run: (ctx) => ctx.history.commit(arrange(ctx.doc(), ctx.get().selection, a.dir), 'Arrange')
    })
  ),
  ...ALIGN.map(
    (edge, i): Command => ({
      id: `object.align.${edge}`,
      label: edge[0].toUpperCase() + edge.slice(1),
      menu: { path: 'object/Align', order: i },
      enabled: writable,
      run: (ctx) => ctx.history.commit(alignObjects(ctx.doc(), ctx.get().selection, edge), 'Align')
    })
  ),
  {
    id: 'object.distribute',
    label: 'Distribute',
    enabled: writable,
    run: (ctx, axis) => ctx.history.commit(distributeObjects(ctx.doc(), ctx.get().selection, axis as 'h' | 'v'), 'Distribute')
  },
  {
    id: 'object.reverse',
    label: 'Reverse path direction',
    enabled: writable,
    run: (ctx) => {
      let next = ctx.doc()
      for (const id of ctx.get().selection) next = reversePath(next, id)
      ctx.history.commit(next, 'Reverse path')
    }
  },
  {
    id: 'object.setClosed',
    label: 'Open or close path',
    enabled: writable,
    run: (ctx, closed) => {
      let next = ctx.doc()
      for (const id of ctx.get().selection) next = setPathClosed(next, id, closed === true)
      ctx.history.commit(next, closed ? 'Close path' : 'Open path')
    }
  },
  {
    id: 'object.join',
    label: 'Join into one path',
    enabled: writable,
    run: (ctx) => {
      const { doc, newId } = joinPaths(ctx.doc(), ctx.get().selection)
      if (doc === ctx.doc()) return
      ctx.history.commit(doc, 'Join paths')
      ctx.select(newId ? [newId] : [])
    }
  },
  {
    id: 'object.reshape',
    label: 'Shape parameters',
    enabled: writable,
    run: (ctx, patch) => {
      const id = ctx.get().selection[0]
      if (id) ctx.history.commit(reshape(ctx.doc(), id, patch as { cornerRadius?: number; sides?: number; innerRatio?: number }), 'Shape')
    }
  },
  {
    id: 'object.fill',
    label: 'Fill',
    run: (ctx, paint) => {
      // With nothing selected this sets the fill the NEXT shape is drawn with.
      ctx.set({ fill: paint as DrawDocPaint })
      patchSelected(ctx, (o) => (o.type === 'path' || o.type === 'text' ? { ...o, fill: paint as DrawDocPaint } : o), 'Fill')
    }
  },
  {
    id: 'object.stroke',
    label: 'Stroke',
    run: (ctx, stroke) => {
      const s = stroke as DrawDocStroke | undefined
      ctx.set({ stroke: s })
      patchSelected(ctx, (o) => (o.type === 'path' || o.type === 'text' ? (s ? { ...o, stroke: s } : { ...o, stroke: undefined }) : o), 'Stroke')
    }
  },
  {
    id: 'object.opacity',
    label: 'Opacity',
    run: (ctx, v) => patchSelected(ctx, (o) => ({ ...o, opacity: v as number }), 'Opacity')
  },
  {
    id: 'object.blend',
    label: 'Blend mode',
    run: (ctx, b) => patchSelected(ctx, (o) => ({ ...o, blend: b as DrawBlend }), 'Blend mode')
  },
  {
    id: 'object.textPatch',
    label: 'Type settings',
    run: (ctx, patch) => patchSelected(ctx, (o) => (o.type === 'text' ? ctx.text.measure({ ...o, ...(patch as Partial<DrawTextNode>) }) : o), 'Type')
  }
]
