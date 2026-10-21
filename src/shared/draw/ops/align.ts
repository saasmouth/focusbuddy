// The Align panel's operations, Illustrator's way: align to the selection, to
// a KEY object (which never moves) or to the artboard; distribute objects by
// any of six edges or centres; distribute the spacing between them, evenly or
// by an exact value measured from the key object. Groups move as units;
// locked, hidden and opaque nodes never move. Everything is measured and moved
// on the ARTBOARD, members of transformed groups included (their bounds and
// moves go through the groups' matrices). Pure functions over DrawDoc.

import type { Box } from '../../drawGeometry'
import type { DrawDoc } from '../model'
import { primaryArtboard } from './artboards'
import { nodesWorldBounds } from './groups'
import { editableIds, moveObjects } from './objects'

export type AlignEdgeId = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type AlignTarget = { kind: 'selection' } | { kind: 'artboard' } | { kind: 'key'; id: string }

/** Distribute Objects: the six edges or centres whose positions are evened out. */
export type DistributeEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

export const DISTRIBUTE_EDGES: readonly DistributeEdge[] = ['top', 'vcenter', 'bottom', 'left', 'hcenter', 'right']

function horizontal(e: AlignEdgeId | DistributeEdge): boolean {
  return e === 'left' || e === 'center' || e === 'right' || e === 'hcenter'
}

/** The coordinate of an edge or centre of a box. */
function edgeOf(b: Box, e: AlignEdgeId | DistributeEdge): number {
  switch (e) {
    case 'left':
      return b.x
    case 'right':
      return b.x + b.w
    case 'center':
    case 'hcenter':
      return b.x + b.w / 2
    case 'top':
      return b.y
    case 'bottom':
      return b.y + b.h
    default:
      return b.y + b.h / 2
  }
}

/** The editable nodes among `ids`, each with its visible bounds. */
function measured(doc: DrawDoc, ids: string[]): Array<{ id: string; b: Box }> {
  const out: Array<{ id: string; b: Box }> = []
  for (const id of editableIds(doc, ids)) {
    const b = nodesWorldBounds(doc, [id])
    if (b) out.push({ id, b })
  }
  return out
}

function shiftAll(doc: DrawDoc, shifts: Map<string, number>, h: boolean): DrawDoc {
  const ids = [...shifts.entries()].filter(([, d]) => Math.abs(d) > 1e-12).map(([id]) => id)
  if (!ids.length) return doc
  let next = doc
  for (const id of ids) {
    const d = shifts.get(id) ?? 0
    next = h ? moveObjects(next, [id], d, 0) : moveObjects(next, [id], 0, d)
  }
  return next
}

/** Is `keyId` a usable key object for this selection (selected and editable)? */
export function validKey(doc: DrawDoc, ids: string[], keyId: string | null | undefined): string | null {
  if (!keyId) return null
  return editableIds(doc, ids).includes(keyId) ? keyId : null
}

/** The box the selection aligns against, or null when there is nothing to align. */
export function alignFrame(doc: DrawDoc, ids: string[], target: AlignTarget): Box | null {
  const items = measured(doc, ids)
  if (!items.length) return null
  if (target.kind === 'artboard' || (target.kind === 'selection' && items.length === 1)) {
    // A single object aligns to the artboard, as in Illustrator.
    const a = primaryArtboard(doc)
    return { x: a.x, y: a.y, w: a.w, h: a.h }
  }
  if (target.kind === 'key') {
    const key = items.find((i) => i.id === target.id)
    if (key) return key.b
  }
  return nodesWorldBounds(doc, items.map((i) => i.id))
}

/** Align Objects: move each editable node so its `edge` matches the target's. A key object stays put. */
export function alignTo(doc: DrawDoc, ids: string[], edge: AlignEdgeId, target: AlignTarget = { kind: 'selection' }): DrawDoc {
  const frame = alignFrame(doc, ids, target)
  if (!frame) return doc
  const keyId = target.kind === 'key' ? target.id : null
  const h = horizontal(edge)
  const want = edgeOf(frame, edge)
  const shifts = new Map<string, number>()
  for (const { id, b } of measured(doc, ids)) if (id !== keyId) shifts.set(id, want - edgeOf(b, edge))
  return shiftAll(doc, shifts, h)
}

/** How many objects a distribute needs: three to even out, or two when an exact spacing is measured from a key object. */
export function distributeMinimum(exact: boolean): number {
  return exact ? 2 : 3
}

/**
 * Distribute Objects. Without an exact spacing, the outermost two stay and the
 * `edge` positions of everything between become evenly spaced. With a key
 * object and a spacing, the key stays and every other object's `edge` lands a
 * whole multiple of `spacing` from the key's, in their current order.
 */
export function distributeEdges(doc: DrawDoc, ids: string[], edge: DistributeEdge, opts: { keyId?: string | null; spacing?: number } = {}): DrawDoc {
  const items = measured(doc, ids)
  const keyId = validKey(doc, ids, opts.keyId)
  const exact = keyId !== null && typeof opts.spacing === 'number' && Number.isFinite(opts.spacing)
  if (items.length < distributeMinimum(exact)) return doc
  const h = horizontal(edge)
  const sorted = items.slice().sort((a, b) => edgeOf(a.b, edge) - edgeOf(b.b, edge) || (h ? a.b.y - b.b.y : a.b.x - b.b.x))
  const shifts = new Map<string, number>()
  if (exact) {
    const ki = sorted.findIndex((s) => s.id === keyId)
    const base = edgeOf(sorted[ki].b, edge)
    sorted.forEach((s, i) => shifts.set(s.id, base + (i - ki) * (opts.spacing as number) - edgeOf(s.b, edge)))
  } else {
    const first = edgeOf(sorted[0].b, edge)
    const last = edgeOf(sorted[sorted.length - 1].b, edge)
    const step = (last - first) / (sorted.length - 1)
    sorted.forEach((s, i) => shifts.set(s.id, first + i * step - edgeOf(s.b, edge)))
  }
  return shiftAll(doc, shifts, h)
}

/**
 * Distribute Spacing: equal gaps between neighbours along an axis. Without an
 * exact spacing the outermost two stay put and the gaps are evened out; with a
 * key object and a spacing, the key stays and every gap becomes exactly
 * `spacing` (negative spacing overlaps).
 */
export function distributeSpacing(doc: DrawDoc, ids: string[], axis: 'h' | 'v', opts: { keyId?: string | null; spacing?: number } = {}): DrawDoc {
  const items = measured(doc, ids)
  const keyId = validKey(doc, ids, opts.keyId)
  const exact = keyId !== null && typeof opts.spacing === 'number' && Number.isFinite(opts.spacing)
  if (items.length < distributeMinimum(exact)) return doc
  const h = axis === 'h'
  const pos = (b: Box): number => (h ? b.x : b.y)
  const size = (b: Box): number => (h ? b.w : b.h)
  const sorted = items.slice().sort((a, b) => pos(a.b) - pos(b.b) || pos(a.b) + size(a.b) - (pos(b.b) + size(b.b)))
  const shifts = new Map<string, number>()
  if (exact) {
    const gap = opts.spacing as number
    const ki = sorted.findIndex((s) => s.id === keyId)
    let cursor = pos(sorted[ki].b) + size(sorted[ki].b)
    for (let i = ki + 1; i < sorted.length; i++) {
      shifts.set(sorted[i].id, cursor + gap - pos(sorted[i].b))
      cursor += gap + size(sorted[i].b)
    }
    cursor = pos(sorted[ki].b)
    for (let i = ki - 1; i >= 0; i--) {
      const at = cursor - gap - size(sorted[i].b)
      shifts.set(sorted[i].id, at - pos(sorted[i].b))
      cursor = at
    }
  } else {
    const first = sorted[0].b
    const last = sorted[sorted.length - 1].b
    const span = pos(last) + size(last) - pos(first)
    const used = sorted.reduce((sum, s) => sum + size(s.b), 0)
    const gap = (span - used) / (sorted.length - 1)
    let cursor = pos(first)
    for (const s of sorted) {
      shifts.set(s.id, cursor - pos(s.b))
      cursor += size(s.b) + gap
    }
  }
  return shiftAll(doc, shifts, h)
}
