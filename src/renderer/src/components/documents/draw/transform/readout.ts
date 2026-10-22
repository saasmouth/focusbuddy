// What the Transform controls (the Object tab of the top bar) show and how a
// typed value becomes a transform: X, Y, W and H of the selection at the
// 9-point reference point, and its own turn and shear when one object is
// selected. Pure, so the maths is tested without a DOM.

import type { Box, Matrix } from '@shared/drawGeometry'
import { decompose, invertMatrix, recompose, refFractions, refPointOf, rotation, type RefPoint } from '@shared/draw/geometry/transform'
import type { DrawDoc, DrawNode } from '@shared/draw/model'
import { editableIds, getObjects, nodeOrientation, nodesBounds } from '@shared/draw/ops'

/** The linear matrix a single node carries (frames: matrix × turn; groups: their matrix); identity for paths. */
function nodeLinear(n: DrawNode): Matrix {
  if (n.type === 'group') return n.transform ? [n.transform[0], n.transform[1], n.transform[2], n.transform[3], 0, 0] : [1, 0, 0, 1, 0, 0]
  if (n.type === 'text' || n.type === 'image' || n.type === 'widget') {
    const r = rotation(n.rotation ?? 0)
    if (!n.transform) return r
    const t = n.transform
    return [t[0] * r[0] + t[2] * r[1], t[1] * r[0] + t[3] * r[1], t[0] * r[2] + t[2] * r[3], t[1] * r[2] + t[3] * r[3], 0, 0]
  }
  return [1, 0, 0, 1, 0, 0]
}

export interface TransformReadout {
  ids: string[]
  box: Box
  /** The node whose own turn and shear the panel shows, when exactly one is selected. */
  single: DrawNode | null
  /** UI degrees: counter-clockwise turn, clockwise-positive shear. */
  rotate: number
  shear: number
}

/** What the panel shows for the editable selection, or null when nothing editable is selected. */
export function transformReadout(doc: DrawDoc, selection: string[]): TransformReadout | null {
  const ids = editableIds(doc, selection)
  const objs = getObjects(doc, ids)
  if (!objs.length) return null
  const single = objs.length === 1 ? objs[0] : null
  const o = single ? nodeOrientation(single) : { rotation: 0, skew: 0 }
  const clean = (v: number): number => (Math.abs(v) < 1e-9 ? 0 : v)
  return { ids, box: nodesBounds(objs), single, rotate: clean(-o.rotation), shear: clean(-o.skew) }
}

/** The box with its reference point kept where it is and a new width and height. */
export function resizedAt(b: Box, ref: RefPoint, w: number, h: number): Box {
  const p = refPointOf(b, ref)
  const { fx, fy } = refFractions(ref)
  return { x: p.x - fx * w, y: p.y - fy * h, w, h }
}

/** The change that turns a node's current turn/shear into the typed one (identity part kept). */
export function orientationDelta(single: DrawNode | null, want: { rotate?: number; shear?: number }): Matrix | null {
  const cur = single ? nodeLinear(single) : ([1, 0, 0, 1, 0, 0] as Matrix)
  const d = decompose(cur)
  const next = recompose({
    ...d,
    translateX: 0,
    translateY: 0,
    rotation: want.rotate !== undefined ? -want.rotate : d.rotation,
    skew: want.shear !== undefined ? -want.shear : d.skew
  })
  const inv = invertMatrix(cur)
  if (!inv) return null
  const m = [
    next[0] * inv[0] + next[2] * inv[1],
    next[1] * inv[0] + next[3] * inv[1],
    next[0] * inv[2] + next[2] * inv[3],
    next[1] * inv[2] + next[3] * inv[3],
    0,
    0
  ] as Matrix
  return m
}
