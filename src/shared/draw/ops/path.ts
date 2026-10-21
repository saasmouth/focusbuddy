// Path operations on a v2 document: Pathfinder booleans, join, reverse,
// open/close, live-shape reshape, and anchor editing.

import { drawId, shapePath } from '../../draw'
import {
  applyMatrix,
  booleanPath,
  fitPathToBox,
  multiplyMatrix,
  transformPath,
  type BooleanOp,
  type DrawNode as PathPoint,
  type DrawPath,
  type DrawSubpath,
  type Matrix,
  type Pt
} from '../../drawGeometry'
import { isStraight, pointAt as cubicPoint, segmentCount, segmentOf } from '../geometry/bezier'
import { simplifySubpath, simplifyTolerance, smoothRun, type SimplifyOptions } from '../geometry/fit'
import {
  addMidpoints,
  averageTarget,
  cornerInfo,
  cutSubpath,
  deleteAnchorsBreaking,
  dragHandle,
  eraseSubpath,
  handleOf,
  insertAnchor,
  joinEnds,
  knifePath,
  meanPoint,
  removeAnchors,
  reshapeCubic,
  reverseNodes,
  roundCorners,
  setSegment,
  toCorner,
  toSmooth,
  translateNodePt,
  withHandle,
  type AverageAxis,
  type HandleSide
} from '../geometry/pathEdit'
import type { DrawDoc, DrawNode, DrawPathNode } from '../model'
import { findNode, vectorLayersOf } from '../tree'
import { nodeBounds } from './geometry'
import { addObject, deleteObjects, editableIds, getObject, layerOf, mapObject } from './objects'

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

// ── Anchor editing (WP-PATH) ─────────────────────────────────────────────────
//
// Every operation below takes anchor references and DOCUMENT-space points; a
// path inside transformed groups is edited in its own space (the point is
// mapped through the inverse of the groups' matrices), so the result lands
// exactly where the pointer was. Locked, hidden and opaque nodes, and paths on
// locked or hidden layers, are never touched (editableIds). Any geometry edit
// turns a live shape into a plain path, as Illustrator does.

/** One anchor: path node id, subpath index, node index. */
export interface AnchorRef {
  id: string
  si: number
  ni: number
}

/** One end of an open subpath. */
export interface EndpointRef {
  id: string
  si: number
  end: 'start' | 'end'
}

export function anchorKey(r: AnchorRef): string {
  return `${r.id}:${r.si}:${r.ni}`
}

/** The groups' combined matrix over a node (identity when no group above it is transformed). */
export function nodeMatrix(doc: DrawDoc, id: string): Matrix {
  const hit = findNode(doc, id)
  let m: Matrix = [1, 0, 0, 1, 0, 0]
  if (!hit) return m
  for (const g of hit.parents) if (g.transform) m = multiplyMatrix(m, g.transform)
  return m
}

function invertMatrix(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

function isIdentity(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
}

/** A document point in a path's own space. */
export function toLocal(doc: DrawDoc, id: string, p: Pt): Pt {
  const m = nodeMatrix(doc, id)
  if (isIdentity(m)) return p
  const inv = invertMatrix(m)
  return inv ? applyMatrix(inv, p) : p
}

/** A path-space point in document space. */
export function toDoc(doc: DrawDoc, id: string, p: Pt): Pt {
  const m = nodeMatrix(doc, id)
  return isIdentity(m) ? p : applyMatrix(m, p)
}

/** A document-space displacement in a path's own space. */
function vecToLocal(doc: DrawDoc, id: string, dx: number, dy: number): Pt {
  const m = nodeMatrix(doc, id)
  if (isIdentity(m)) return { x: dx, y: dy }
  const inv = invertMatrix([m[0], m[1], m[2], m[3], 0, 0])
  return inv ? applyMatrix(inv, { x: dx, y: dy }) : { x: dx, y: dy }
}

/** The path node `id` if it may be edited, else undefined. */
export function editablePath(doc: DrawDoc, id: string): DrawPathNode | undefined {
  if (!editableIds(doc, [id]).length) return undefined
  const o = getObject(doc, id)
  return o && o.type === 'path' ? o : undefined
}

/** A path node with new geometry, detached from any live-shape parameters. */
export function withGeometry(o: DrawPathNode, path: DrawPath): DrawPathNode {
  if (!o.shapeKind || !LIVE_SHAPE_KINDS.has(o.shapeKind)) return { ...o, path }
  const { cornerRadius: _r, sides: _s, innerRatio: _i, ...rest } = o
  void _r
  void _s
  void _i
  return { ...rest, path, shapeKind: 'path' }
}

/** Group refs by path, keeping only editable paths and in-range indices. */
export function refsByPath(doc: DrawDoc, refs: AnchorRef[]): Map<string, Map<number, number[]>> {
  const out = new Map<string, Map<number, number[]>>()
  for (const r of refs) {
    const o = editablePath(doc, r.id)
    const sp = o?.path.subpaths[r.si]
    if (!o || !sp || r.ni < 0 || r.ni >= sp.nodes.length) continue
    let bySp = out.get(r.id)
    if (!bySp) out.set(r.id, (bySp = new Map()))
    const list = bySp.get(r.si) ?? []
    if (!list.includes(r.ni)) list.push(r.ni)
    bySp.set(r.si, list)
  }
  return out
}

/** Every anchor of a path. */
export function allAnchorsOf(doc: DrawDoc, id: string): AnchorRef[] {
  const o = getObject(doc, id)
  if (!o || o.type !== 'path') return []
  return o.path.subpaths.flatMap((sp, si) => sp.nodes.map((_, ni) => ({ id, si, ni })))
}

/** Document-space position of an anchor (null when the reference is stale). */
export function anchorPoint(doc: DrawDoc, r: AnchorRef): Pt | null {
  const o = getObject(doc, r.id)
  const n = o && o.type === 'path' ? o.path.subpaths[r.si]?.nodes[r.ni] : undefined
  return n ? toDoc(doc, r.id, { x: n.x, y: n.y }) : null
}

function patchSubpaths(doc: DrawDoc, id: string, fn: (subpaths: DrawSubpath[]) => DrawSubpath[]): DrawDoc {
  const before = getObject(doc, id)
  if (!before || before.type !== 'path') return doc
  const after = fn(before.path.subpaths)
  if (after === before.path.subpaths) return doc
  return mapObject(doc, id, (o) => {
    if (o.type !== 'path') return o
    return withGeometry(o, { ...o.path, subpaths: after })
  })
}

/** Replace node `id` (wherever it sits) with `nodes`, in its place in the stack. */
export function replaceNode(doc: DrawDoc, id: string, nodes: DrawNode[]): DrawDoc {
  const visit = (list: DrawNode[]): DrawNode[] => {
    let changed = false
    const out: DrawNode[] = []
    for (const n of list) {
      if (n.id === id) {
        out.push(...nodes)
        changed = true
        continue
      }
      if (n.type === 'group') {
        const children = visit(n.children)
        if (children !== n.children) {
          out.push({ ...n, children })
          changed = true
          continue
        }
      }
      out.push(n)
    }
    return changed ? out : list
  }
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector') return l
      const objects = visit(l.objects)
      return objects === l.objects ? l : { ...l, objects }
    })
  }
}

/**
 * A node's copy for a second piece: its paint, stroke and appearance are
 * copied, never shared. Two nodes holding the same object would be one value
 * reachable twice, which the IPC payload check rejects ("cyclic data") -- the
 * save would silently fail.
 */
function pieceOf(o: DrawPathNode, path: DrawPath, id: string): DrawPathNode {
  const { path: _p, ...rest } = withGeometry(o, path)
  void _p
  return { ...(structuredClone(rest) as Omit<DrawPathNode, 'path'>), path, id }
}

/**
 * Write a path's new subpaths back. A path left with no subpath is deleted; a
 * SINGLE path that fell into several pieces becomes several path objects (a
 * compound path keeps its pieces together, as one object). Returns the ids
 * the pieces now have.
 */
function writePieces(doc: DrawDoc, o: DrawPathNode, subpaths: DrawSubpath[], wasCompound: boolean): { doc: DrawDoc; ids: string[] } {
  if (!subpaths.length) return { doc: deleteObjects(doc, [o.id]), ids: [] }
  if (wasCompound || subpaths.length === 1) {
    const next = withGeometry(o, { ...o.path, subpaths })
    return { doc: mapObject(doc, o.id, () => next), ids: [o.id] }
  }
  const nodes: DrawPathNode[] = subpaths.map((sp, i) => (i === 0 ? withGeometry(o, { ...o.path, subpaths: [sp] }) : pieceOf(o, { ...o.path, subpaths: [sp] }, drawId('obj'))))
  return { doc: replaceNode(doc, o.id, nodes), ids: nodes.map((n) => n.id) }
}

/** Move anchors (their handles come along) by a document-space delta. */
export function moveAnchors(doc: DrawDoc, refs: AnchorRef[], dx: number, dy: number): DrawDoc {
  if (!dx && !dy) return doc
  let next = doc
  for (const [id, bySp] of refsByPath(doc, refs)) {
    const v = vecToLocal(doc, id, dx, dy)
    next = patchSubpaths(next, id, (sps) =>
      sps.map((sp, si) => {
        const idx = bySp.get(si)
        if (!idx) return sp
        const set = new Set(idx)
        return { ...sp, nodes: sp.nodes.map((n, ni) => (set.has(ni) ? translateNodePt(n, v.x, v.y) : n)) }
      })
    )
  }
  return next
}

/** Drag one handle of an anchor to a document point (see dragHandle for the modes). */
export function moveHandle(doc: DrawDoc, r: AnchorRef, side: HandleSide, p: Pt, mode: 'smooth' | 'mirror' | 'free'): DrawDoc {
  const o = editablePath(doc, r.id)
  const n = o?.path.subpaths[r.si]?.nodes[r.ni]
  if (!o || !n) return doc
  const q = toLocal(doc, r.id, p)
  return patchSubpaths(doc, r.id, (sps) => sps.map((sp, si) => (si === r.si ? { ...sp, nodes: sp.nodes.map((m, ni) => (ni === r.ni ? dragHandle(m, side, q, mode) : m)) } : sp)))
}

/** Replace one node of a path (already in path space). */
export function setPathNode(doc: DrawDoc, r: AnchorRef, node: PathPoint): DrawDoc {
  if (!editablePath(doc, r.id)) return doc
  return patchSubpaths(doc, r.id, (sps) => sps.map((sp, si) => (si === r.si ? { ...sp, nodes: sp.nodes.map((m, ni) => (ni === r.ni ? node : m)) } : sp)))
}

/** Add Anchor Point: split segment `seg` of subpath `si` at `t`. The outline does not change. */
export function addAnchor(doc: DrawDoc, id: string, si: number, seg: number, t: number): { doc: DrawDoc; ref: AnchorRef | null } {
  const o = editablePath(doc, id)
  const sp = o?.path.subpaths[si]
  if (!o || !sp || seg < 0 || seg >= segmentCount(sp)) return { doc, ref: null }
  const res = insertAnchor(sp, seg, Math.max(1e-6, Math.min(1 - 1e-6, t)))
  return { doc: patchSubpaths(doc, id, (sps) => sps.map((x, i) => (i === si ? res.sp : x))), ref: { id, si, ni: res.ni } }
}

/** Object > Path > Add Anchor Points: a new anchor in the middle of every segment. */
export function addMidpointAnchors(doc: DrawDoc, ids: string[]): DrawDoc {
  let next = doc
  for (const id of editableIds(doc, ids)) {
    if (!editablePath(doc, id)) continue
    next = patchSubpaths(next, id, (sps) => sps.map(addMidpoints))
  }
  return next
}

/**
 * Delete Anchor Point / Remove selected anchor points: the anchors go and the
 * path stays joined (re-fitted over the gap). A subpath left with one anchor
 * goes; a path left with none is deleted.
 */
export function removeAnchorsJoined(doc: DrawDoc, refs: AnchorRef[]): DrawDoc {
  let next = doc
  for (const [id, bySp] of refsByPath(doc, refs)) {
    const o = getObject(next, id) as DrawPathNode
    const subpaths = o.path.subpaths.flatMap((sp, si) => {
      const idx = bySp.get(si)
      if (!idx) return [sp]
      const r = removeAnchors(sp, idx)
      return r ? [r] : []
    })
    next = subpaths.length ? mapObject(next, id, () => withGeometry(o, { ...o.path, subpaths })) : deleteObjects(next, [id])
  }
  return next
}

/**
 * The Delete key with anchors selected: the anchors go with the segments that
 * touch them, and the path falls apart there.
 */
export function deleteAnchorsBreak(doc: DrawDoc, refs: AnchorRef[]): { doc: DrawDoc; ids: string[] } {
  let next = doc
  const ids: string[] = []
  for (const [id, bySp] of refsByPath(doc, refs)) {
    const o = getObject(next, id) as DrawPathNode
    const subpaths = o.path.subpaths.flatMap((sp, si) => {
      const idx = bySp.get(si)
      return idx ? deleteAnchorsBreaking(sp, idx) : [sp]
    })
    const res = writePieces(next, o, subpaths, o.path.subpaths.length > 1)
    next = res.doc
    ids.push(...res.ids)
  }
  return { doc: next, ids }
}

/** Convert anchors to corner points (handles retracted) or smooth points (handles pulled out). */
export function convertAnchors(doc: DrawDoc, refs: AnchorRef[], to: 'corner' | 'smooth'): DrawDoc {
  let next = doc
  for (const [id, bySp] of refsByPath(doc, refs)) {
    next = patchSubpaths(next, id, (sps) => {
      let changed = false
      const out = sps.map((sp, si) => {
        const idx = bySp.get(si)
        if (!idx) return sp
        const set = new Set(idx)
        const nodes = sp.nodes.map((n, ni) => {
          if (!set.has(ni)) return n
          const m = to === 'corner' ? toCorner(sp, ni) : toSmooth(sp, ni)
          if (m.x !== n.x || m.y !== n.y || m.inX !== n.inX || m.inY !== n.inY || m.outX !== n.outX || m.outY !== n.outY) changed = true
          return m
        })
        return { ...sp, nodes }
      })
      return changed ? out : sps
    })
  }
  return next
}

/** Retract one handle of an anchor (the Anchor Point tool on a handle; the pen on its last anchor). */
export function retractHandle(doc: DrawDoc, r: AnchorRef, side: HandleSide): DrawDoc {
  const o = editablePath(doc, r.id)
  const n = o?.path.subpaths[r.si]?.nodes[r.ni]
  if (!o || !n || !handleOf(n, side)) return doc
  return setPathNode(doc, r, withHandle(n, side, null))
}

/** Scissors at a place on a segment (t = 0 at an anchor). Returns the ids of the resulting paths. */
export function cutPathAt(doc: DrawDoc, id: string, cuts: Array<{ si: number; seg: number; t: number }>): { doc: DrawDoc; ids: string[] } {
  const o = editablePath(doc, id)
  if (!o || !cuts.length) return { doc, ids: [] }
  let changed = false
  const subpaths = o.path.subpaths.flatMap((sp, si) => {
    const mine = cuts.filter((c) => c.si === si)
    if (!mine.length) return [sp]
    const pieces = cutSubpath(sp, mine.map((c) => ({ seg: c.seg, t: c.t })))
    if (pieces.length !== 1 || pieces[0] !== sp) changed = true
    return pieces
  })
  if (!changed) return { doc, ids: [] }
  return writePieces(doc, o, subpaths, o.path.subpaths.length > 1)
}

/** Cut Path at Selected Anchor Points. */
export function cutAtAnchors(doc: DrawDoc, refs: AnchorRef[]): { doc: DrawDoc; ids: string[] } {
  let next = doc
  const ids: string[] = []
  for (const [id, bySp] of refsByPath(doc, refs)) {
    const cuts: Array<{ si: number; seg: number; t: number }> = []
    for (const [si, list] of bySp) for (const ni of list) cuts.push({ si, seg: ni, t: 0 })
    const res = cutPathAt(next, id, cuts)
    next = res.doc
    ids.push(...(res.ids.length ? res.ids : [id]))
  }
  return { doc: next, ids }
}

/** Every end of every open subpath among `ids` (editable paths only). */
export function openEndpoints(doc: DrawDoc, ids: string[]): EndpointRef[] {
  const out: EndpointRef[] = []
  for (const id of editableIds(doc, ids)) {
    const o = getObject(doc, id)
    if (!o || o.type !== 'path') continue
    o.path.subpaths.forEach((sp, si) => {
      if (sp.closed || sp.nodes.length < 1) return
      out.push({ id, si, end: 'start' })
      if (sp.nodes.length > 1) out.push({ id, si, end: 'end' })
    })
  }
  return out
}

/** The anchor an endpoint reference names. */
export function endpointAnchor(doc: DrawDoc, e: EndpointRef): AnchorRef | null {
  const o = getObject(doc, e.id)
  const sp = o && o.type === 'path' ? o.path.subpaths[e.si] : undefined
  if (!sp || sp.closed || !sp.nodes.length) return null
  return { id: e.id, si: e.si, ni: e.end === 'start' ? 0 : sp.nodes.length - 1 }
}

/** The endpoint an anchor is, if it is one. */
export function anchorAsEndpoint(doc: DrawDoc, r: AnchorRef): EndpointRef | null {
  const o = getObject(doc, r.id)
  const sp = o && o.type === 'path' ? o.path.subpaths[r.si] : undefined
  if (!sp || sp.closed) return null
  if (r.ni === 0) return { id: r.id, si: r.si, end: 'start' }
  if (r.ni === sp.nodes.length - 1) return { id: r.id, si: r.si, end: 'end' }
  return null
}

/**
 * Join two open ends (⌘J): with a straight segment, or merged into one anchor
 * when they coincide; both ends of one subpath close it. `average` moves them
 * to their midpoint first (Average & Join). The joined path keeps the
 * appearance of the FIRST end's path and takes its place; the second path is
 * absorbed. Null when the two ends cannot be joined.
 */
export function joinEndpoints(doc: DrawDoc, a: EndpointRef, b: EndpointRef, average = false): { doc: DrawDoc; id: string } | null {
  const oa = editablePath(doc, a.id)
  const ob = editablePath(doc, b.id)
  const spa = oa?.path.subpaths[a.si]
  const spb = ob?.path.subpaths[b.si]
  if (!oa || !ob || !spa || !spb || spa.closed || spb.closed) return null
  if (a.id === b.id && a.si === b.si) {
    if (a.end === b.end || spa.nodes.length < 2) return null
    const closed = joinEnds(spa, 'end', null, 'start', average)
    return { doc: patchSubpaths(doc, a.id, (sps) => sps.map((x, i) => (i === a.si ? closed : x))), id: a.id }
  }
  // Bring B into A's space (B may sit under other groups).
  const mBA = (() => {
    const ma = nodeMatrix(doc, a.id)
    const mb = nodeMatrix(doc, b.id)
    const inv = invertMatrix(ma)
    return inv ? multiplyMatrix(inv, mb) : null
  })()
  const spbLocal = mBA && !isIdentity(mBA) ? transformPath({ subpaths: [spb] }, mBA).subpaths[0] : spb
  const joined = joinEnds(spa, a.end, spbLocal, b.end, average)
  let next = doc
  if (a.id === b.id) {
    next = patchSubpaths(next, a.id, (sps) => sps.flatMap((x, i) => (i === a.si ? [joined] : i === b.si ? [] : [x])))
    return { doc: next, id: a.id }
  }
  next = patchSubpaths(next, a.id, (sps) => sps.map((x, i) => (i === a.si ? joined : x)))
  const rest = ob.path.subpaths.filter((_, i) => i !== b.si)
  if (rest.length) {
    // A compound path keeps its other pieces.
    next = mapObject(next, b.id, (o) => (o.type === 'path' ? withGeometry(o, { ...o.path, subpaths: rest }) : o))
  } else next = deleteObjects(next, [b.id])
  return { doc: next, id: a.id }
}

/**
 * ⌘J on whole paths: join the nearest pair of free ends, again and again,
 * until one chain is left (or close a lone open path). Returns null when there
 * is nothing to join.
 */
export function joinPathsByEnds(doc: DrawDoc, ids: string[], average = false): { doc: DrawDoc; id: string } | null {
  let next = doc
  let ends = openEndpoints(next, ids)
  if (!ends.length) return null
  // A lone open path closes; several are chained end to end and stay open.
  const lone = new Set(ends.map((e) => `${e.id}:${e.si}`)).size === 1
  let last: string | null = null
  for (let guard = 0; guard < 500; guard++) {
    ends = openEndpoints(next, ids.filter((id) => getObject(next, id)))
    const subpathsWithEnds = new Set(ends.map((e) => `${e.id}:${e.si}`))
    if (subpathsWithEnds.size <= 1) {
      // One open subpath left: close it, if it was the only one to begin with.
      if (lone && ends.length === 2) {
        const r = joinEndpoints(next, ends[0], ends[1], average)
        if (r) return r
      }
      break
    }
    let best: { a: EndpointRef; b: EndpointRef; d: number } | null = null
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i]
        const b = ends[j]
        if (a.id === b.id && a.si === b.si) continue
        const pa = anchorPoint(next, endpointAnchor(next, a)!)!
        const pb = anchorPoint(next, endpointAnchor(next, b)!)!
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y)
        if (!best || d < best.d) best = { a, b, d }
      }
    }
    if (!best) break
    const r = joinEndpoints(next, best.a, best.b, average)
    if (!r) break
    next = r.doc
    last = r.id
  }
  return last ? { doc: next, id: last } : null
}

/** Average: line the anchors up on their mean (horizontally, vertically, or onto one point). */
export function averageAnchors(doc: DrawDoc, refs: AnchorRef[], axis: AverageAxis): DrawDoc {
  const live = refs.filter((r) => anchorPoint(doc, r) && editablePath(doc, r.id))
  if (live.length < 2) return doc
  const mean = meanPoint(live.map((r) => anchorPoint(doc, r)!))
  let next = doc
  for (const r of live) {
    const p = anchorPoint(next, r)!
    const q = averageTarget(p, mean, axis)
    next = moveAnchors(next, [r], q.x - p.x, q.y - p.y)
  }
  return next
}

export type AnchorAlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** Align selected anchors to the selection's left/centre/right/top/middle/bottom (Properties panel). */
export function alignAnchors(doc: DrawDoc, refs: AnchorRef[], edge: AnchorAlignEdge): DrawDoc {
  const live = refs.filter((r) => anchorPoint(doc, r) && editablePath(doc, r.id))
  if (live.length < 2) return doc
  const pts = live.map((r) => anchorPoint(doc, r)!)
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const target =
    edge === 'left'
      ? Math.min(...xs)
      : edge === 'right'
        ? Math.max(...xs)
        : edge === 'hcenter'
          ? (Math.min(...xs) + Math.max(...xs)) / 2
          : edge === 'top'
            ? Math.min(...ys)
            : edge === 'bottom'
              ? Math.max(...ys)
              : (Math.min(...ys) + Math.max(...ys)) / 2
  const horizontal = edge === 'left' || edge === 'right' || edge === 'hcenter'
  let next = doc
  for (const r of live) {
    const p = anchorPoint(next, r)!
    next = horizontal ? moveAnchors(next, [r], target - p.x, 0) : moveAnchors(next, [r], 0, target - p.y)
  }
  return next
}

/** Object > Path > Simplify on whole paths. */
export function simplifyPaths(doc: DrawDoc, ids: string[], opts: SimplifyOptions): DrawDoc {
  let next = doc
  for (const id of editableIds(doc, ids)) {
    const o = editablePath(doc, id)
    if (!o) continue
    const b = nodeBounds(o)
    const tol = simplifyTolerance(opts.precision, Math.hypot(b.w, b.h))
    next = patchSubpaths(next, id, (sps) => sps.map((sp) => simplifySubpath(sp, tol, opts.angleThreshold, opts.straightLines)))
  }
  return next
}

/** How many anchors a set of paths has (the Simplify dialog's before/after count). */
export function anchorCount(doc: DrawDoc, ids: string[]): number {
  let n = 0
  for (const o of getObjectsOfType(doc, ids)) for (const sp of o.path.subpaths) n += sp.nodes.length
  return n
}

function getObjectsOfType(doc: DrawDoc, ids: string[]): DrawPathNode[] {
  return ids.map((id) => getObject(doc, id)).filter((o): o is DrawPathNode => !!o && o.type === 'path')
}

/**
 * Round corner anchors to radius `r` (the corner widget and the Corner field).
 * Returns the new document and the anchors that now stand for the rounded
 * corners (two per corner), so the selection can follow.
 */
export function roundAnchorCorners(doc: DrawDoc, refs: AnchorRef[], r: number): { doc: DrawDoc; refs: AnchorRef[] } {
  let next = doc
  const out: AnchorRef[] = []
  for (const [id, bySp] of refsByPath(doc, refs)) {
    const o = getObject(next, id) as DrawPathNode
    const subpaths = o.path.subpaths.map((sp, si) => {
      const idx = bySp.get(si)
      if (!idx) return sp
      const rounded = roundCorners(sp, idx, r)
      if (rounded === sp) {
        for (const ni of idx) out.push({ id, si, ni })
        return sp
      }
      // Map old corner indices to their new pairs.
      const set = new Set(idx.filter((i) => cornerInfo(sp, i)))
      let shift = 0
      for (let i = 0; i < sp.nodes.length; i++) {
        if (set.has(i)) {
          out.push({ id, si, ni: i + shift }, { id, si, ni: i + shift + 1 })
          shift++
        } else if (idx.includes(i)) out.push({ id, si, ni: i + shift })
      }
      return rounded
    })
    next = mapObject(next, id, () => withGeometry(o, { ...o.path, subpaths }))
  }
  return { doc: next, refs: out }
}

/**
 * Drag a segment: a curved segment reshapes through the dragged point (its
 * handles move, its anchors stay); a straight one moves with both anchors.
 */
export function dragSegment(doc: DrawDoc, id: string, si: number, seg: number, t: number, target: Pt, from: Pt, bend = false): DrawDoc {
  const o = editablePath(doc, id)
  const sp = o?.path.subpaths[si]
  if (!o || !sp || seg >= segmentCount(sp)) return doc
  const c = segmentOf(sp, seg)
  // `bend` (the Anchor Point tool) curves even a straight segment.
  if (isStraight(c) && !bend) {
    const n = sp.nodes.length
    return moveAnchors(doc, [{ id, si, ni: seg }, { id, si, ni: (seg + 1) % n }], target.x - from.x, target.y - from.y)
  }
  const q = toLocal(doc, id, target)
  const reshaped = reshapeCubic(c, t, q)
  return patchSubpaths(doc, id, (sps) => sps.map((x, i) => (i === si ? setSegment(x, seg, reshaped) : x)))
}

/**
 * The Knife over a set of paths: every filled closed path the line cuts all
 * the way through falls into pieces, each its own path object with the
 * original's appearance. Returns the ids of every piece.
 */
export function knifeCut(doc: DrawDoc, ids: string[], line: Pt[]): { doc: DrawDoc; ids: string[] } {
  let next = doc
  const out: string[] = []
  for (const id of editableIds(doc, ids)) {
    const o = editablePath(next, id)
    if (!o) continue
    const local = line.map((p) => toLocal(next, id, p))
    const pieces = knifePath(o.path, local)
    if (!pieces || pieces.length < 2) continue
    const nodes: DrawPathNode[] = pieces.map((path, i) => (i === 0 ? withGeometry(o, path) : pieceOf(o, path, drawId('obj'))))
    next = replaceNode(next, id, nodes)
    out.push(...nodes.map((n) => n.id))
  }
  return { doc: next, ids: out }
}

/** The Path Eraser: erase what lies within `radius` of the trail from the given paths. */
export function erasePaths(doc: DrawDoc, ids: string[], trail: Pt[], radius: number): { doc: DrawDoc; ids: string[] } {
  let next = doc
  const out: string[] = []
  for (const id of editableIds(doc, ids)) {
    const o = editablePath(next, id)
    if (!o) continue
    const local = trail.map((p) => toLocal(next, id, p))
    let changed = false
    const subpaths = o.path.subpaths.flatMap((sp) => {
      const r = eraseSubpath(sp, local, radius)
      if (r.length !== 1 || r[0] !== sp) changed = true
      return r
    })
    if (!changed) {
      out.push(id)
      continue
    }
    const res = writePieces(next, o, subpaths, o.path.subpaths.length > 1)
    next = res.doc
    out.push(...res.ids)
  }
  return { doc: next, ids: out }
}

/**
 * The Smooth tool: the stretch of each subpath the trail passes within
 * `radius` of is re-fitted more smoothly. `fidelity` 0..100 runs from Accurate
 * (barely changes) to Smooth (strong averaging, few anchors).
 */
export function smoothPaths(doc: DrawDoc, ids: string[], trail: Pt[], radius: number, fidelity: number): DrawDoc {
  let next = doc
  const f = Math.max(0, Math.min(100, fidelity)) / 100
  const tolerance = 0.5 + f * 6
  const passes = 1 + Math.round(f * 6)
  for (const id of editableIds(doc, ids)) {
    const o = editablePath(next, id)
    if (!o) continue
    const local = trail.map((p) => toLocal(next, id, p))
    const near = (p: Pt): boolean => local.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= radius)
    const subpaths = o.path.subpaths.map((sp) => {
      const n = sp.nodes.length
      if (n < 2) return sp
      // Which segments the trail touches (sampled).
      const touched: boolean[] = []
      for (let s = 0; s < segmentCount(sp); s++) {
        const c = segmentOf(sp, s)
        let hit = false
        for (let i = 0; i <= 8 && !hit; i++) hit = near(cubicPoint(c, i / 8))
        touched.push(hit)
      }
      if (!touched.some(Boolean)) return sp
      // Smooth from the first to the last touched segment (rotated so a closed
      // loop's run does not wrap).
      let nodes = sp.nodes
      let rot = 0
      if (sp.closed) {
        const firstFree = touched.findIndex((t) => !t)
        if (firstFree < 0) return { ...sp, nodes: smoothClosed(sp, tolerance, passes) }
        rot = (firstFree + 1) % n
        nodes = [...sp.nodes.slice(rot), ...sp.nodes.slice(0, rot), ...(sp.closed ? [sp.nodes[rot]] : [])]
      }
      const segTouched = (k: number): boolean => touched[(k + rot) % touched.length]
      const segs = sp.closed ? n : n - 1
      let a = -1
      let b = -1
      for (let k = 0; k < segs; k++) {
        if (segTouched(k)) {
          if (a < 0) a = k
          b = k + 1
        }
      }
      if (a < 0) return sp
      const smoothed = smoothRun(nodes, a, b, tolerance, passes)
      if (!sp.closed) return { ...sp, nodes: smoothed }
      // Fold the duplicated closing node back.
      const lastNode = smoothed[smoothed.length - 1]
      const body = smoothed.slice(0, -1)
      body[0] = { ...body[0], ...(lastNode.inX != null ? { inX: lastNode.inX, inY: lastNode.inY } : {}) }
      return { ...sp, nodes: body }
    })
    next = mapObject(next, id, () => withGeometry(o, { ...o.path, subpaths }))
  }
  return next
}

function smoothClosed(sp: DrawSubpath, tolerance: number, passes: number): PathPoint[] {
  const open = [...sp.nodes, sp.nodes[0]]
  const sm = smoothRun(open, 0, open.length - 1, tolerance, passes)
  const lastNode = sm[sm.length - 1]
  const body = sm.slice(0, -1)
  body[0] = { ...body[0], ...(lastNode.inX != null ? { inX: lastNode.inX, inY: lastNode.inY } : {}) }
  return body
}

/**
 * Continue an open subpath with more anchors (the pen picking up an end), and
 * optionally close it. `end` is the end being continued; `added` are the new
 * anchors in drawing order, starting with the (possibly re-handled) end itself.
 */
export function extendSubpath(doc: DrawDoc, ref: EndpointRef, added: PathPoint[], close: boolean): DrawDoc {
  const o = editablePath(doc, ref.id)
  const sp = o?.path.subpaths[ref.si]
  if (!o || !sp || sp.closed || !added.length) return doc
  const local = added.map((n) => mapPathPoint(n, (p) => toLocal(doc, ref.id, p)))
  const base = ref.end === 'end' ? sp.nodes.slice() : reverseNodes(sp.nodes)
  const nodes = [...base.slice(0, -1), local[0], ...local.slice(1)]
  let nextSp: DrawSubpath = { closed: false, nodes }
  if (close) nextSp = joinEnds(nextSp, 'end', null, 'start')
  return patchSubpaths(doc, ref.id, (sps) => sps.map((x, i) => (i === ref.si ? nextSp : x)))
}

function mapPathPoint(n: PathPoint, f: (p: Pt) => Pt): PathPoint {
  const a = f({ x: n.x, y: n.y })
  const out: PathPoint = { x: a.x, y: a.y }
  if (n.inX != null) {
    const h = f({ x: n.inX, y: n.inY ?? n.y })
    out.inX = h.x
    out.inY = h.y
  }
  if (n.outX != null) {
    const h = f({ x: n.outX, y: n.outY ?? n.y })
    out.outX = h.x
    out.outY = h.y
  }
  return out
}

export type { AverageAxis, HandleSide, SimplifyOptions }
