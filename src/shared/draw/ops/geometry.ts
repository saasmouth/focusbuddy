// Geometry of v2 nodes: bounds, hit-testing, moving and scaling, for every
// node kind including groups (whose children are in the group's own space when
// it carries a transform). Frame nodes reuse the v1 helpers in draw.ts, so a
// v1 object and its v2 node always agree to the last bit.

import { frameBounds as v1FrameBounds, hitObject, objectBounds as v1ObjectBounds, objectPivot, objectRotation, type DrawObject } from '../../draw'
import { applyMatrix, multiplyMatrix, transformPath, translatePath, unionBox, type Box, type Matrix, type Pt } from '../../drawGeometry'
import type { DrawGroupNode, DrawImageNode, DrawNode, DrawPathNode, DrawTextNode, DrawWidgetNode } from '../model'

/** A frame node seen through the v1 lens, which only reads geometry fields (an image's asset is irrelevant here). */
function asV1(n: DrawNode): DrawObject {
  return n as unknown as DrawObject
}

function invert(m: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

function boxCorners(b: Box): Pt[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h }
  ]
}

function transformBox(b: Box, m: Matrix): Box {
  const pts = boxCorners(b).map((p) => applyMatrix(m, p))
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

// ── Clipping groups ──────────────────────────────────────────────────────────
// The geometric facts about a clipping group live here, beside bounds and
// hit-testing, so the canvas, the exporter and every selection rule agree on
// what a mask covers. ops/masks.ts builds the Make / Release commands on them.

/** A node that can be a clip path: a path (compound paths included) or type. */
export function canClip(n: DrawNode | undefined): n is DrawPathNode | DrawTextNode {
  if (!n) return false
  if (n.type === 'path') return n.path.subpaths.some((sp) => sp.nodes.length > 0)
  return n.type === 'text'
}

/**
 * A clipping group's clip path -- its TOPMOST member, Illustrator's rule -- or
 * null when the group does not clip (or its top member is something that
 * cannot clip, in which case nothing is masked rather than guessing).
 */
export function clipShapeOf(g: DrawGroupNode): DrawPathNode | DrawTextNode | null {
  if (!g.clip || g.children.length === 0) return null
  const top = g.children[g.children.length - 1]
  return canClip(top) ? top : null
}

/** Is `p` (in the clipping group's own space) inside the area the clip path lets through? */
export function insideClip(clip: DrawPathNode | DrawTextNode, p: Pt): boolean {
  if (clip.type === 'path') return hitObject(asV1({ ...clip, fill: { type: 'solid', color: '#000' }, stroke: undefined } as DrawNode), p, 0)
  // Type clips with its frame: glyph outlines need the font (Create Outlines).
  if (clip.transform) {
    const inv = invert(clip.transform)
    return inv ? hitObject(asV1(clip), applyMatrix(inv, p), 0) : false
  }
  return hitObject(asV1(clip), p, 0)
}

function paintShows(p: { type: string } | undefined): boolean {
  return !!p && p.type !== 'none'
}

/** The clip path carries a visible fill of its own (Make Clipping Mask clears it; the user may add one back). */
export function clipHasFill(clip: DrawPathNode | DrawTextNode): boolean {
  if (clip.appearance) return clip.appearance.fills.some((f) => f.enabled !== false && paintShows(f.paint))
  return paintShows(clip.fill)
}

/** The clip path carries a visible stroke of its own. */
export function clipHasStroke(clip: DrawPathNode | DrawTextNode): boolean {
  if (clip.appearance) return clip.appearance.strokes.some((s) => s.enabled !== false && s.stroke.width > 0 && paintShows(s.stroke.paint))
  return !!clip.stroke && clip.stroke.width > 0 && paintShows(clip.stroke.paint)
}

/** True when the node has no geometry this build can measure (opaque, or an empty group). */
export function isMeasurable(n: DrawNode): boolean {
  if (n.type === 'opaque') return false
  if (n.type === 'group') return n.children.some(isMeasurable)
  return true
}

/** The box a node VISIBLY occupies on the artboard (rotation and transforms included). */
export function nodeBounds(n: DrawNode): Box {
  if (n.type === 'group') {
    // A clipping group occupies exactly its clip path's box, as in Illustrator:
    // whatever the mask hides is not part of the object's visible extent.
    const clip = clipShapeOf(n)
    const inner = clip ? nodeBounds(clip) : unionBox(n.children.filter(isMeasurable).map(nodeBounds))
    return n.transform ? transformBox(inner, n.transform) : inner
  }
  const b = v1ObjectBounds(asV1(n))
  if ((n.type === 'text' || n.type === 'image' || n.type === 'widget') && n.transform) return transformBox(b, n.transform)
  return b
}

export function nodesBounds(nodes: DrawNode[]): Box {
  return unionBox(nodes.filter(isMeasurable).map(nodeBounds))
}

/** The box a node occupies before rotation (paths: geometric bounds; frames: x/y/w/h). */
export function nodeFrame(n: DrawNode): Box {
  if (n.type === 'group') return nodeBounds(n)
  return v1FrameBounds(asV1(n))
}

/** Is `p` on the node? Groups hit through any member; opaque nodes never. */
export function hitNode(n: DrawNode, p: Pt, slop = 0): boolean {
  if (n.type === 'opaque' || n.hidden) return false
  if (n.type === 'group') {
    const local = n.transform ? invert(n.transform) : null
    const q = n.transform ? (local ? applyMatrix(local, p) : null) : p
    if (!q) return false
    // A clipping group is hit only where its clip path lets the contents
    // show -- or on the clip path's own paint, when it has been given some.
    const clip = clipShapeOf(n)
    if (clip) {
      const inside = insideClip(clip, q)
      if (inside && n.children.slice(0, -1).some((c) => hitNode(c, q, slop))) return true
      if (clip.hidden) return false
      if (inside && clipHasFill(clip)) return true
      return clipHasStroke(clip) && hitNode({ ...clip, fill: { type: 'none' }, appearance: undefined } as DrawNode, q, slop)
    }
    return n.children.some((c) => hitNode(c, q, slop))
  }
  if ((n.type === 'text' || n.type === 'image' || n.type === 'widget') && n.transform) {
    const inv = invert(n.transform)
    return inv ? hitObject(asV1(n), applyMatrix(inv, p), slop) : false
  }
  return hitObject(asV1(n), p, slop)
}

/** The node moved by (dx, dy). A transformed group or frame takes the move in its matrix. */
export function translateNode(n: DrawNode, dx: number, dy: number): DrawNode {
  if (n.type === 'opaque') return n
  if (n.type === 'path') return { ...n, path: translatePath(n.path, dx, dy) }
  if (n.type === 'group') {
    if (n.transform) return { ...n, transform: multiplyMatrix([1, 0, 0, 1, dx, dy], n.transform) }
    return { ...n, children: n.children.map((c) => translateNode(c, dx, dy)) }
  }
  if (n.transform) return { ...n, transform: multiplyMatrix([1, 0, 0, 1, dx, dy], n.transform) }
  return { ...n, x: n.x + dx, y: n.y + dy }
}

/** The pivot of a frame node, as both renderers rotate it. */
export function nodePivot(n: DrawTextNode | DrawImageNode | DrawWidgetNode): Pt {
  return objectPivot(asV1(n) as Parameters<typeof objectPivot>[0])
}

/**
 * Scale a TURNED frame node with the selection box: the pivot is carried
 * through the scale exactly and the frame keeps its rotation, sized by the
 * scale factors (see scaleRotatedFrame in drawOps for why).
 */
function scaleRotatedFrame(o: DrawTextNode | DrawImageNode | DrawWidgetNode, sx: number, sy: number, e: number, f: number): DrawNode {
  const frame = nodeFrame(o)
  const pivot = nodePivot(o)
  const moved = { x: pivot.x * sx + e, y: pivot.y * sy + f }
  const ax = Math.abs(sx)
  const ay = Math.abs(sy)
  if (o.type === 'text') {
    const w = Math.max(8, frame.w * ax)
    return { ...o, x: moved.x - w / 2, y: moved.y, w, fontSize: Math.max(1, o.fontSize * ay) }
  }
  const w = Math.max(1, frame.w * ax)
  const h = Math.max(1, frame.h * ay)
  return { ...o, x: moved.x - w / 2, y: moved.y - h / 2, w, h }
}

/**
 * The node scaled by the axis-aligned map x' = sx*x + e, y' = sy*y + f -- what
 * the selection handles do. Paths are re-baked; frames resize (text scales its
 * point size with the vertical factor); groups scale their members, or take
 * the map in their matrix when they carry one.
 */
export function scaleNode(n: DrawNode, sx: number, sy: number, e: number, f: number): DrawNode {
  if (n.type === 'opaque') return n
  if (n.type === 'path') return { ...n, path: transformPath(n.path, [sx, 0, 0, sy, e, f]) }
  if (n.type === 'group') {
    if (n.transform) return { ...n, transform: multiplyMatrix([sx, 0, 0, sy, e, f], n.transform) }
    return { ...n, children: n.children.map((c) => scaleNode(c, sx, sy, e, f)) }
  }
  if (n.transform) return { ...n, transform: multiplyMatrix([sx, 0, 0, sy, e, f], n.transform) }
  if (objectRotation(asV1(n))) return scaleRotatedFrame(n, sx, sy, e, f)
  const b = nodeBounds(n)
  const nx = b.x * sx + e
  const ny = b.y * sy + f
  // A widget scales like an image: the box changes, the contents re-lay out.
  if (n.type === 'image' || n.type === 'widget') return { ...n, x: nx, y: ny, w: Math.max(1, b.w * sx), h: Math.max(1, b.h * sy) }
  // Scaling text scales its point size with the vertical factor, which is what
  // makes dragging a corner feel like resizing the words rather than the box.
  return { ...n, x: nx, y: ny, w: Math.max(8, b.w * sx), fontSize: Math.max(1, n.fontSize * sy) }
}

/**
 * Turn a node by `degrees` about (cx, cy) -- the rotate handle. Paths are
 * re-baked; a frame keeps its pivot and adds to its rotation (exactly what the
 * studio has always done); a group takes the rotation in its matrix.
 */
export function rotateNode(n: DrawNode, m: Matrix, degrees: number): DrawNode {
  if (n.type === 'opaque') return n
  if (n.type === 'path') return { ...n, path: transformPath(n.path, m) }
  if (n.type === 'group') return { ...n, transform: n.transform ? multiplyMatrix(m, n.transform) : m }
  return { ...n, rotation: (n.rotation ?? 0) + degrees }
}

export type { DrawGroupNode }
