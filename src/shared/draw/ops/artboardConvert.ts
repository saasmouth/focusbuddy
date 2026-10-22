// Object › Artboards › Convert to Artboards (4.3.41): selected rectangles
// become artboards and the shapes go, as in Illustrator.
//
// A rectangle is a live Rectangle (shapeKind 'rect') or any path that is one
// closed, straight-sided, axis-aligned four-corner outline -- also inside a
// group, as long as the group only moves or scales it (a rotated or sheared
// rectangle is not an artboard: artboards are never rotated). Rounded
// rectangles, ellipses and other shapes are not converted.

import type { Box, Matrix } from '../../drawGeometry'
import type { DrawDoc, DrawNode, DrawPathNode } from '../model'
import { addArtboard, normalArtboardRect } from './artboards'
import { nodesWorldBounds, parentMatrixOf } from './groups'
import { deleteObjects, editableIds, getObject } from './objects'

const EPS = 1e-6

/** Is a path one closed, straight, axis-aligned rectangle with some area? */
export function isAxisAlignedRectPath(n: DrawPathNode): boolean {
  if (n.shapeKind === 'roundRect' || n.shapeKind === 'ellipse') return false
  const sps = n.path.subpaths
  if (sps.length !== 1 || !sps[0].closed) return false
  let pts = sps[0].nodes
  // A closing node that repeats the first is the same outline.
  if (pts.length === 5 && Math.abs(pts[4].x - pts[0].x) < EPS && Math.abs(pts[4].y - pts[0].y) < EPS) pts = pts.slice(0, 4)
  if (pts.length !== 4) return false
  // Straight sides: a handle that sits off its anchor bends the side.
  for (const p of pts) {
    if (p.inX !== undefined && (Math.abs(p.inX - p.x) > EPS || Math.abs((p.inY ?? p.y) - p.y) > EPS)) return false
    if (p.outX !== undefined && (Math.abs(p.outX - p.x) > EPS || Math.abs((p.outY ?? p.y) - p.y) > EPS)) return false
  }
  // Every side horizontal or vertical, alternating, so it is a rectangle (not a bow tie or a line).
  let horizontal = 0
  let vertical = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    const h = Math.abs(a.y - b.y) < EPS && Math.abs(a.x - b.x) > EPS
    const v = Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) > EPS
    if (!h && !v) return false
    if (h) horizontal++
    else vertical++
    const c = pts[(i + 2) % 4]
    const nextH = Math.abs(b.y - c.y) < EPS
    if (h === nextH) return false
  }
  return horizontal === 2 && vertical === 2
}

const axisAligned = (m: Matrix): boolean => Math.abs(m[1]) < EPS && Math.abs(m[2]) < EPS

/** The artboard a selected node would become, in document space, or null when it is not a rectangle. */
export function rectangleArtboardBox(doc: DrawDoc, id: string): Box | null {
  const n = getObject(doc, id) as DrawNode | undefined
  if (!n || n.type !== 'path') return null
  // A live Rectangle turned by its points is no longer axis-aligned either.
  if (!isAxisAlignedRectPath(n)) return null
  if (!axisAligned(parentMatrixOf(doc, id))) return null
  const b = nodesWorldBounds(doc, [id])
  if (!b || !(b.w > 0) || !(b.h > 0)) return null
  return b
}

/** The selected, editable rectangles, in reading order (top to bottom, then left to right), with their artboard boxes. */
export function convertibleRectangles(doc: DrawDoc, selection: string[]): Array<{ id: string; box: Box }> {
  const out: Array<{ id: string; box: Box }> = []
  for (const id of editableIds(doc, selection)) {
    const box = rectangleArtboardBox(doc, id)
    if (box) out.push({ id, box: normalArtboardRect(box) })
  }
  return out.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
}

/**
 * Convert the selected rectangles to artboards and delete them. Each new
 * artboard is named "Artboard N" in reading order, takes the document's
 * page background (as a new artboard does), and the last one made is active.
 * Anything else selected is left alone. `newId` mints each artboard id.
 */
export function convertToArtboards(doc: DrawDoc, selection: string[], newId: () => string): { doc: DrawDoc; created: string[]; removed: string[] } {
  const rects = convertibleRectangles(doc, selection)
  if (!rects.length) return { doc, created: [], removed: [] }
  let next = doc
  const created: string[] = []
  for (const r of rects) {
    const id = newId()
    next = addArtboard(next, id, r.box)
    created.push(id)
  }
  const removed = rects.map((r) => r.id)
  next = deleteObjects(next, removed)
  return { doc: next, created, removed }
}
