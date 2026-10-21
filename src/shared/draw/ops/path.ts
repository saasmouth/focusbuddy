// Path operations on a v2 document: Pathfinder booleans, join, reverse,
// open/close, live-shape reshape, and anchor editing.

import { drawId, shapePath } from '../../draw'
import { booleanPath, fitPathToBox, type BooleanOp, type Pt } from '../../drawGeometry'
import type { DrawDoc, DrawNode, DrawPathNode } from '../model'
import { vectorLayersOf } from '../tree'
import { nodeBounds } from './geometry'
import { addObject, deleteObjects, getObject, layerOf, mapObject } from './objects'

/** The top-level path nodes among `ids`, in paint order. */
function orderedPaths(doc: DrawDoc, ids: string[]): DrawPathNode[] {
  const out: DrawPathNode[] = []
  for (const l of vectorLayersOf(doc)) for (const o of l.objects) if (ids.includes(o.id) && o.type === 'path') out.push(o)
  return out
}

/**
 * Combine two or more selected paths. The result inherits the appearance of
 * the BOTTOM-most operand. Non-path nodes in the selection are left untouched
 * rather than silently discarded -- a boolean has no meaning for a photo, a
 * text frame or a group.
 */
export function booleanObjects(doc: DrawDoc, ids: string[], op: BooleanOp): { doc: DrawDoc; newId: string | null } {
  const ordered = orderedPaths(doc, ids)
  if (ordered.length < 2) return { doc, newId: null }
  const base = ordered[0]
  let path = base.path
  for (let i = 1; i < ordered.length; i++) path = booleanPath(path, ordered[i].path, op)
  if (path.subpaths.length === 0) {
    // A subtraction that consumes the shape entirely is a real outcome: remove
    // the operands rather than leaving an invisible empty object behind.
    return { doc: deleteObjects(doc, ordered.map((o) => o.id)), newId: null }
  }
  const layer = layerOf(doc, base.id)
  const newId = drawId('obj')
  const combined: DrawPathNode = { ...base, id: newId, path, shapeKind: 'path', name: base.name, cornerRadius: undefined, sides: undefined, innerRatio: undefined }
  const cleared = deleteObjects(doc, ordered.map((o) => o.id))
  return { doc: addObject(cleared, combined, layer?.id), newId }
}

/** Reverse every subpath's direction -- flips which side a hole cuts from. */
export function reversePath(doc: DrawDoc, id: string): DrawDoc {
  return mapObject(doc, id, (o) => {
    if (o.type !== 'path') return o
    return {
      ...o,
      path: {
        ...o.path,
        subpaths: o.path.subpaths.map((sp) => ({
          closed: sp.closed,
          nodes: sp.nodes
            .slice()
            .reverse()
            .map((n) => ({ x: n.x, y: n.y, ...(n.outX != null ? { inX: n.outX, inY: n.outY } : {}), ...(n.inX != null ? { outX: n.inX, outY: n.inY } : {}) }))
        }))
      }
    }
  })
}

export function setPathClosed(doc: DrawDoc, id: string, closed: boolean): DrawDoc {
  return mapObject(doc, id, (o) => (o.type === 'path' ? { ...o, path: { ...o.path, subpaths: o.path.subpaths.map((sp) => ({ ...sp, closed })) } } : o))
}

/** Merge several paths into one multi-subpath (compound) node, without a boolean. */
export function joinPaths(doc: DrawDoc, ids: string[]): { doc: DrawDoc; newId: string | null } {
  const ordered = orderedPaths(doc, ids)
  if (ordered.length < 2) return { doc, newId: null }
  const base = ordered[0]
  const newId = drawId('obj')
  const merged: DrawPathNode = { ...base, id: newId, shapeKind: 'path', path: { fillRule: 'evenodd', subpaths: ordered.flatMap((o) => o.path.subpaths) } }
  const layer = layerOf(doc, base.id)
  const cleared = deleteObjects(doc, ordered.map((o) => o.id))
  return { doc: addObject(cleared, merged, layer?.id), newId }
}

/** Kinds whose geometry is re-derived from parameters. */
const LIVE_SHAPE_KINDS = new Set(['rect', 'roundRect', 'ellipse', 'polygon', 'star', 'line'])

/** Re-derive one live shape's geometry from new parameters (radius, points, inset). */
export function reshape(doc: DrawDoc, id: string, patch: { cornerRadius?: number; sides?: number; innerRatio?: number }): DrawDoc {
  const target = getObject(doc, id)
  // Only a shape that still remembers how it was made can be re-derived; once a
  // boolean or an anchor edit changed the geometry there are no parameters left.
  // The document comes back untouched -- identity included -- so an unchanged
  // document never lands on the undo stack.
  if (!target || target.type !== 'path' || !target.shapeKind || !LIVE_SHAPE_KINDS.has(target.shapeKind)) return doc
  // Refitted into the CURRENT bounds, so changing a star's point count keeps it
  // exactly where it sits instead of nudging it each time.
  const box = nodeBounds(target)
  return mapObject(doc, id, (o) => {
    if (o.type !== 'path' || !o.shapeKind) return o
    const next = { ...o, ...patch }
    return { ...next, path: fitPathToBox(shapePath(o.shapeKind, box, next), box) }
  })
}

export type NodePart = 'anchor' | 'in' | 'out'

/**
 * Drag one anchor or bezier handle of a path to `p`. An anchor carries its
 * handles; a handle mirrors its partner unless `breakPair` (Alt). Editing a
 * LIVE shape's anchor detaches it into a plain path, as Illustrator does, so a
 * later parameter change cannot regenerate the outline and lose the edit.
 */
export function editAnchor(doc: DrawDoc, id: string, si: number, ni: number, part: NodePart, p: Pt, breakPair = false): DrawDoc {
  return mapObject(doc, id, (o): DrawNode => {
    if (o.type !== 'path') return o
    const subpaths = o.path.subpaths.map((sp, i) => {
      if (i !== si) return sp
      return {
        ...sp,
        nodes: sp.nodes.map((n, j) => {
          if (j !== ni) return n
          if (part === 'anchor') {
            const dx = p.x - n.x
            const dy = p.y - n.y
            return {
              x: p.x,
              y: p.y,
              ...(n.inX != null ? { inX: n.inX + dx, inY: (n.inY ?? 0) + dy } : {}),
              ...(n.outX != null ? { outX: n.outX + dx, outY: (n.outY ?? 0) + dy } : {})
            }
          }
          if (part === 'out') return breakPair ? { ...n, outX: p.x, outY: p.y } : { ...n, outX: p.x, outY: p.y, inX: 2 * n.x - p.x, inY: 2 * n.y - p.y }
          return breakPair ? { ...n, inX: p.x, inY: p.y } : { ...n, inX: p.x, inY: p.y, outX: 2 * n.x - p.x, outY: 2 * n.y - p.y }
        })
      }
    })
    const edited: DrawPathNode = { ...o, path: { ...o.path, subpaths } }
    if (!o.shapeKind || !LIVE_SHAPE_KINDS.has(o.shapeKind)) return edited
    const { cornerRadius: _r, sides: _s, innerRatio: _i, ...rest } = edited
    void _r
    void _s
    void _i
    return { ...rest, shapeKind: 'path' }
  })
}
