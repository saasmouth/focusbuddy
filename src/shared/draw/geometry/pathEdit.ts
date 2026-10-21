// Anchor-level path editing on plain DrawPath geometry: add, delete, convert
// and move anchors, cut (Scissors, Cut at anchors, Path Eraser), join
// endpoints, average, round corners, and the Knife. No document, no ids: the
// ops in shared/draw/ops/path.ts wrap these for nodes in a drawing.
//
// Conventions: a handle that sits on its anchor is written as no handle at all
// (the segment on that side is straight there), so every result is in the
// same canonical form the pen and the shape tools produce.

import type { DrawNode, DrawPath, DrawSubpath, Pt } from '../../drawGeometry'
import { flattenSubpath, pointInPath, pointInRings, polygonArea } from '../../drawGeometry'
import { cubicLength, derivativeAt, dist, intersectPolylineCubic, isStraight, nearestOnCubic, pointAt, segmentCount, segmentOf, splitCubicAt, subCubic, tangentAt, type Cubic } from './bezier'
import { cubicsToNodes, curvatureHandlesAt, fitSingleCubic } from './fit'

const HANDLE_EPS = 1e-6

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
const norm = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

// ── Node helpers ─────────────────────────────────────────────────────────────

export type HandleSide = 'in' | 'out'

export function handleOf(n: DrawNode, side: HandleSide): Pt | null {
  if (side === 'in') return n.inX != null ? { x: n.inX, y: n.inY ?? n.y } : null
  return n.outX != null ? { x: n.outX, y: n.outY ?? n.y } : null
}

/** The node with its handle on `side` set to `p`, or removed when `p` is null or sits on the anchor. */
export function withHandle(n: DrawNode, side: HandleSide, p: Pt | null): DrawNode {
  const { inX, inY, outX, outY } = n
  const out: DrawNode = { x: n.x, y: n.y }
  const keepIn = side === 'in' ? p : inX != null ? { x: inX, y: inY ?? n.y } : null
  const keepOut = side === 'out' ? p : outX != null ? { x: outX, y: outY ?? n.y } : null
  if (keepIn && Math.hypot(keepIn.x - n.x, keepIn.y - n.y) > HANDLE_EPS) {
    out.inX = keepIn.x
    out.inY = keepIn.y
  }
  if (keepOut && Math.hypot(keepOut.x - n.x, keepOut.y - n.y) > HANDLE_EPS) {
    out.outX = keepOut.x
    out.outY = keepOut.y
  }
  return out
}

/** A node with no handles. */
export function bareNode(n: DrawNode): DrawNode {
  return { x: n.x, y: n.y }
}

/** True when the node's two handles point in opposite directions (a smooth point). */
export function isSmoothNode(n: DrawNode, toleranceDeg = 2): boolean {
  const a = handleOf(n, 'in')
  const b = handleOf(n, 'out')
  if (!a || !b) return false
  const u = norm(sub(a, n))
  const v = norm(sub(b, n))
  const cos = u.x * v.x + u.y * v.y
  return cos <= -Math.cos((toleranceDeg * Math.PI) / 180)
}

/** Move a node (its handles come with it). */
export function translateNodePt(n: DrawNode, dx: number, dy: number): DrawNode {
  return {
    x: n.x + dx,
    y: n.y + dy,
    ...(n.inX != null ? { inX: n.inX + dx, inY: (n.inY ?? n.y) + dy } : {}),
    ...(n.outX != null ? { outX: n.outX + dx, outY: (n.outY ?? n.y) + dy } : {})
  }
}

/**
 * Drag one handle to `p`. `mode`:
 *  - 'smooth': the partner turns to stay opposite but KEEPS ITS LENGTH
 *    (Illustrator's Direct Selection on a smooth point);
 *  - 'mirror': the partner mirrors exactly (the pen while placing a point);
 *  - 'free': only this handle moves (Alt, or a corner point).
 */
export function dragHandle(n: DrawNode, side: HandleSide, p: Pt, mode: 'smooth' | 'mirror' | 'free'): DrawNode {
  let next = withHandle(n, side, p)
  const other: HandleSide = side === 'in' ? 'out' : 'in'
  if (mode === 'free') return next
  const v = sub(p, n)
  const l = Math.hypot(v.x, v.y)
  if (l < HANDLE_EPS) return next
  if (mode === 'mirror') return withHandle(next, other, sub(n, v))
  const partner = handleOf(n, other)
  if (!partner) return next
  const pl = Math.hypot(partner.x - n.x, partner.y - n.y)
  next = withHandle(next, other, add(n, mul(norm(v), -pl)))
  return next
}

// ── Positions on a subpath ───────────────────────────────────────────────────

/** A place on a subpath: segment index plus parameter. */
export interface SegPos {
  seg: number
  t: number
}

function setNode(nodes: DrawNode[], i: number, n: DrawNode): void {
  nodes[i] = n
}

/**
 * Add an anchor on segment `seg` at `t`, splitting the cubic exactly (de
 * Casteljau), so the shape does not change at all. Returns the new subpath and
 * the new node's index.
 */
export function insertAnchor(sp: DrawSubpath, seg: number, t: number): { sp: DrawSubpath; ni: number } {
  const n = sp.nodes.length
  const c = segmentOf(sp, seg)
  const straight = isStraight(c)
  const [l, r] = splitCubicAt(c, t)
  const nodes = sp.nodes.slice()
  const a = seg
  const b = (seg + 1) % n
  const mid: DrawNode = straight ? { x: l.p3.x, y: l.p3.y } : withHandle(withHandle({ x: l.p3.x, y: l.p3.y }, 'in', l.p2), 'out', r.p1)
  if (!straight) {
    setNode(nodes, a, withHandle(nodes[a], 'out', l.p1))
    setNode(nodes, b, withHandle(nodes[b], 'in', r.p2))
  }
  nodes.splice(a + 1, 0, mid)
  return { sp: { ...sp, nodes }, ni: a + 1 }
}

/** Insert a midpoint anchor on every segment (Object > Path > Add Anchor Points). */
export function addMidpoints(sp: DrawSubpath): DrawSubpath {
  let cur = sp
  const segs = segmentCount(sp)
  // From the last segment back, so earlier indices stay valid.
  for (let s = segs - 1; s >= 0; s--) cur = insertAnchor(cur, s, 0.5).sp
  return cur
}

/**
 * Remove the anchors at `indices`, keeping the path joined: each removed
 * anchor's two segments are merged into one cubic fitted to them with the
 * neighbours' tangents kept, the way Illustrator's Delete Anchor Point tool
 * preserves as much of the shape as one segment can carry. An end of an open
 * subpath simply goes, with its segment. Returns null when fewer than two
 * anchors would remain.
 */
export function removeAnchors(sp: DrawSubpath, indices: number[]): DrawSubpath | null {
  let cur: DrawSubpath = sp
  const order = [...new Set(indices)].filter((i) => i >= 0 && i < sp.nodes.length).sort((a, b) => b - a)
  for (const i of order) {
    const r = removeOne(cur, i)
    if (!r) return null
    cur = r
  }
  return cur.nodes.length >= 2 ? cur : null
}

function removeOne(sp: DrawSubpath, i: number): DrawSubpath | null {
  const n = sp.nodes.length
  if (n <= 2) return null
  const nodes = sp.nodes.slice()
  if (!sp.closed && (i === 0 || i === n - 1)) {
    nodes.splice(i, 1)
    if (i === 0) nodes[0] = withHandle(nodes[0], 'in', null)
    else nodes[nodes.length - 1] = withHandle(nodes[nodes.length - 1], 'out', null)
    return { ...sp, nodes }
  }
  const pi = (i - 1 + n) % n
  const ni = (i + 1) % n
  const c1 = segmentOf(sp, pi)
  const c2 = segmentOf(sp, i)
  let prev = nodes[pi]
  let next = nodes[ni]
  if (isStraight(c1) && isStraight(c2)) {
    prev = withHandle(prev, 'out', null)
    next = withHandle(next, 'in', null)
  } else {
    const tan1 = tangentAt(c1, 0) ?? norm(sub(c2.p3, c1.p0))
    const t2 = tangentAt(c2, 1) ?? norm(sub(c2.p3, c1.p0))
    const tan2 = mul(t2, -1)
    const pts: Pt[] = []
    const N = 24
    for (let k = 0; k <= N; k++) pts.push(pointAt(c1, k / N))
    for (let k = 1; k <= N; k++) pts.push(pointAt(c2, k / N))
    // A smooth anchor that was once added by splitting one cubic at s has
    // handle lengths in the ratio s : (1 - s); parameterising the samples by
    // that s lets the fit recover the original cubic exactly.
    let params: number[] | undefined
    const node = nodes[i]
    const hin = handleOf(node, 'in')
    const hout = handleOf(node, 'out')
    if (hin && hout && isSmoothNode(node)) {
      const a = dist(hin, node)
      const b = dist(hout, node)
      const s = a / (a + b)
      params = []
      for (let k = 0; k <= N; k++) params.push((s * k) / N)
      for (let k = 1; k <= N; k++) params.push(s + ((1 - s) * k) / N)
    }
    const fit = fitSingleCubic(pts, tan1, tan2, params)
    prev = withHandle(prev, 'out', fit.p1)
    next = withHandle(next, 'in', fit.p2)
  }
  nodes[pi] = prev
  nodes[ni] = next
  nodes.splice(i, 1)
  return { ...sp, nodes }
}

/** Parameter of a position along a subpath, as segment + t. */
function posValue(p: SegPos): number {
  return p.seg + p.t
}

/**
 * The open subpath tracing [s0, s1] (positions as seg + t; for a closed
 * subpath s1 may run past the segment count and wraps). Pieces of zero length
 * come back null.
 */
export function extractRange(sp: DrawSubpath, s0: number, s1: number): DrawSubpath | null {
  const segs = segmentCount(sp)
  if (segs === 0 || s1 - s0 <= 1e-9) return null
  const cubics: Cubic[] = []
  let s = s0
  while (s < s1 - 1e-9) {
    const k = Math.floor(s + 1e-9)
    const segIdx = ((k % segs) + segs) % segs
    const t0 = Math.max(0, s - k)
    const t1 = Math.min(1, s1 - k)
    if (t1 - t0 > 1e-9) cubics.push(subCubic(segmentOf(sp, segIdx), t0, t1))
    s = k + 1
  }
  const kept = cubics.filter((c) => cubicLength(c) > 1e-7)
  if (!kept.length) return null
  // Interior original anchors keep their exact handles; only the ends are cut.
  return { closed: false, nodes: cubicsToNodes(kept, false) }
}

/**
 * Cut a subpath at the given positions (Scissors; Cut Path at Selected Anchor
 * Points). An open subpath falls into pieces; a closed one cut once opens
 * there, and cut k times falls into k open pieces.
 */
export function cutSubpath(sp: DrawSubpath, cuts: SegPos[]): DrawSubpath[] {
  const segs = segmentCount(sp)
  if (segs === 0) return [sp]
  const at = [...new Set(cuts.map((c) => Math.round(posValue(c) * 1e9) / 1e9))].filter((v) => v >= 0 && v <= segs).sort((a, b) => a - b)
  if (!at.length) return [sp]
  const out: DrawSubpath[] = []
  if (sp.closed) {
    // Positions at 0 and at segs are the same point on a closed loop.
    const ring = [...new Set(at.map((v) => (v >= segs - 1e-9 ? 0 : v)))].sort((a, b) => a - b)
    for (let k = 0; k < ring.length; k++) {
      const from = ring[k]
      const to = k + 1 < ring.length ? ring[k + 1] : ring[0] + segs
      const piece = extractRange(sp, from, to)
      if (piece) out.push(piece)
    }
    return out
  }
  const inner = at.filter((v) => v > 1e-9 && v < segs - 1e-9)
  if (!inner.length) return [sp]
  const bounds = [0, ...inner, segs]
  for (let k = 0; k + 1 < bounds.length; k++) {
    const piece = extractRange(sp, bounds[k], bounds[k + 1])
    if (piece) out.push(piece)
  }
  return out
}

/**
 * Delete anchors AND the segments that touch them (the Delete key with
 * anchors selected): what remains is the runs of untouched anchors, each an
 * open subpath; a run of one lone anchor goes too.
 */
export function deleteAnchorsBreaking(sp: DrawSubpath, indices: number[]): DrawSubpath[] {
  const n = sp.nodes.length
  const gone = new Set(indices.filter((i) => i >= 0 && i < n))
  if (!gone.size) return [sp]
  if (gone.size >= n) return []
  const runs: number[][] = []
  if (sp.closed) {
    // Start right after a removed anchor so no run wraps.
    const start = [...gone][0]
    let run: number[] = []
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n
      if (gone.has(i)) {
        if (run.length) runs.push(run)
        run = []
      } else run.push(i)
    }
    if (run.length) runs.push(run)
  } else {
    let run: number[] = []
    for (let i = 0; i < n; i++) {
      if (gone.has(i)) {
        if (run.length) runs.push(run)
        run = []
      } else run.push(i)
    }
    if (run.length) runs.push(run)
  }
  return runs
    .filter((r) => r.length >= 2)
    .map((r) => {
      const nodes = r.map((i) => sp.nodes[i])
      nodes[0] = withHandle(nodes[0], 'in', null)
      nodes[nodes.length - 1] = withHandle(nodes[nodes.length - 1], 'out', null)
      return { closed: false, nodes }
    })
}

// ── Convert ──────────────────────────────────────────────────────────────────

/** Corner: both handles retracted. */
export function toCorner(sp: DrawSubpath, i: number): DrawNode {
  return bareNode(sp.nodes[i])
}

/**
 * Smooth: handles along the line through the neighbours, a third of the way to
 * each (an open end gets one handle aimed at its neighbour). A point that is
 * already smooth is left exactly as it is.
 */
export function toSmooth(sp: DrawSubpath, i: number): DrawNode {
  const node = sp.nodes[i]
  if (isSmoothNode(node)) return node
  const n = sp.nodes.length
  const isEnd = !sp.closed && (i === 0 || i === n - 1)
  if (!isEnd) {
    const sm = curvatureHandlesAt(sp, i)
    if (sm.inX != null) return sm
  }
  if (n < 2) return node
  // An open end: one handle, a third of the way toward its neighbour.
  const other = i === 0 ? sp.nodes[1] : sp.nodes[n - 2]
  const h = add(node, mul(sub(other, node), 1 / 3))
  return withHandle(node, i === 0 ? 'out' : 'in', h)
}

// ── Join and average ─────────────────────────────────────────────────────────

/** An end of an open subpath. */
export interface EndRef {
  si: number
  end: 'start' | 'end'
}

/** The subpath oriented so `ref`'s end is LAST. */
function orientEndLast(sp: DrawSubpath, end: 'start' | 'end'): DrawNode[] {
  return end === 'end' ? sp.nodes.slice() : reverseNodes(sp.nodes)
}

export function reverseNodes(nodes: DrawNode[]): DrawNode[] {
  return nodes
    .slice()
    .reverse()
    .map((n) => {
      const out: DrawNode = { x: n.x, y: n.y }
      if (n.outX != null) {
        out.inX = n.outX
        out.inY = n.outY
      }
      if (n.inX != null) {
        out.outX = n.inX
        out.outY = n.inY
      }
      return out
    })
}

/** Two endpoints closer than this are the same point when joined (merged into one anchor). */
export const JOIN_COINCIDENT = 0.01

/**
 * Join two open ends with a straight segment -- or, when they sit on top of
 * each other, merge them into one anchor (keeping the incoming handle of one
 * and the outgoing handle of the other, as Illustrator does). `average` moves
 * both to their midpoint first (Average & Join).
 *
 * Both ends on the SAME subpath close it. Returns the joined subpath; the
 * caller removes the second subpath.
 */
export function joinEnds(a: DrawSubpath, endA: 'start' | 'end', b: DrawSubpath | null, endB: 'start' | 'end', average = false): DrawSubpath {
  if (!b) {
    // Close one subpath: its start and end.
    let nodes = a.nodes.slice()
    if (average) {
      const m = mul(add(nodes[0], nodes[nodes.length - 1]), 0.5)
      nodes[0] = translateNodePt(nodes[0], m.x - nodes[0].x, m.y - nodes[0].y)
      nodes[nodes.length - 1] = translateNodePt(nodes[nodes.length - 1], m.x - nodes[nodes.length - 1].x, m.y - nodes[nodes.length - 1].y)
    }
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (nodes.length > 2 && dist(first, last) <= JOIN_COINCIDENT) {
      // Merge the end onto the start: its in-handle carries over.
      nodes = nodes.slice(0, -1)
      nodes[0] = withHandle(nodes[0], 'in', handleOf(last, 'in') ? sub(add(handleOf(last, 'in')!, first), last) : null)
    }
    return { closed: true, nodes }
  }
  // A ends last, B starts first.
  let left = orientEndLast(a, endA)
  let right = reverseNodes(orientEndLast(b, endB))
  if (average) {
    const p = left[left.length - 1]
    const q = right[0]
    const m = mul(add(p, q), 0.5)
    left = [...left.slice(0, -1), translateNodePt(p, m.x - p.x, m.y - p.y)]
    right = [translateNodePt(q, m.x - q.x, m.y - q.y), ...right.slice(1)]
  }
  const p = left[left.length - 1]
  const q = right[0]
  if (dist(p, q) <= JOIN_COINCIDENT) {
    const qIn = handleOf(p, 'in')
    const qOut = handleOf(q, 'out')
    const merged = withHandle(withHandle({ x: p.x, y: p.y }, 'in', qIn), 'out', qOut ? sub(add(qOut, p), q) : null)
    return { closed: false, nodes: [...left.slice(0, -1), merged, ...right.slice(1)] }
  }
  return { closed: false, nodes: [...left, ...right] }
}

export type AverageAxis = 'horizontal' | 'vertical' | 'both'

/** The mean position of a set of points. */
export function meanPoint(pts: Pt[]): Pt {
  const s = pts.reduce((acc, p) => add(acc, p), { x: 0, y: 0 })
  return mul(s, 1 / Math.max(1, pts.length))
}

/**
 * Average: move points to their mean. Illustrator's "Horizontal" averages
 * along the horizontal axis -- the points end up on one HORIZONTAL line, so the
 * y coordinates are averaged; "Vertical" lines them up vertically (x
 * averaged); "Both" stacks them on one point.
 */
export function averageTarget(p: Pt, mean: Pt, axis: AverageAxis): Pt {
  if (axis === 'horizontal') return { x: p.x, y: mean.y }
  if (axis === 'vertical') return { x: mean.x, y: p.y }
  return mean
}

// ── Segment reshape ──────────────────────────────────────────────────────────

/**
 * Drag a curved segment by the point at `t` to `target`: the two inner
 * handles move (more the nearer they are to t) so the curve passes exactly
 * through `target` at the same t. The anchors stay put.
 */
export function reshapeCubic(c: Cubic, t: number, target: Pt): Cubic {
  const tt = Math.max(0.02, Math.min(0.98, t))
  const p = pointAt(c, tt)
  const d = sub(target, p)
  const b1 = 3 * tt * (1 - tt) * (1 - tt)
  const b2 = 3 * tt * tt * (1 - tt)
  const w1 = 1 - tt
  const w2 = tt
  const k = 1 / (b1 * w1 + b2 * w2)
  return { p0: c.p0, p1: add(c.p1, mul(d, w1 * k)), p2: add(c.p2, mul(d, w2 * k)), p3: c.p3 }
}

/** Put a reshaped cubic back into segment `seg` of a subpath. */
export function setSegment(sp: DrawSubpath, seg: number, c: Cubic): DrawSubpath {
  const n = sp.nodes.length
  const nodes = sp.nodes.slice()
  const a = seg
  const b = (seg + 1) % n
  nodes[a] = withHandle(nodes[a], 'out', c.p1)
  nodes[b] = withHandle(nodes[b], 'in', c.p2)
  return { ...sp, nodes }
}

// ── Round corners (the corner widget) ────────────────────────────────────────

export interface CornerInfo {
  /** Interior angle, radians (0..pi). */
  angle: number
  /** Unit directions from the anchor along each side. */
  uIn: Pt
  uOut: Pt
  /** Longest distance the rounding may reach along each side. */
  maxIn: number
  maxOut: number
}

/**
 * The geometry of a CORNER anchor (no handles, two neighbours): null for an
 * open end, a smooth point or a straight-through point.
 */
export function cornerInfo(sp: DrawSubpath, i: number): CornerInfo | null {
  const n = sp.nodes.length
  if (n < 3 && !(sp.closed && n >= 3)) return null
  if (!sp.closed && (i === 0 || i === n - 1)) return null
  const node = sp.nodes[i]
  if (node.inX != null || node.outX != null) return null
  const cIn = segmentOf(sp, (i - 1 + n) % n)
  const cOut = segmentOf(sp, i)
  const tIn = tangentAt(cIn, 1)
  const tOut = tangentAt(cOut, 0)
  if (!tIn || !tOut) return null
  const uIn = mul(tIn, -1)
  const uOut = tOut
  const cos = uIn.x * uOut.x + uIn.y * uOut.y
  const angle = Math.acos(Math.max(-1, Math.min(1, cos)))
  if (angle > Math.PI - 1e-3 || angle < 1e-3) return null
  return { angle, uIn, uOut, maxIn: cubicLength(cIn), maxOut: cubicLength(cOut) }
}

/** How far from the corner the rounding starts on each side for radius r. */
export function cornerReach(info: CornerInfo, r: number): number {
  return r / Math.tan(info.angle / 2)
}

/** The largest radius a corner can take, given how much of each side it may use. */
export function maxCornerRadius(info: CornerInfo, shareIn = 1, shareOut = 1): number {
  const reach = Math.min(info.maxIn * shareIn, info.maxOut * shareOut)
  return reach * Math.tan(info.angle / 2)
}

/**
 * Round the corner anchors `indices` with radius `r` (clamped per corner so
 * neighbouring roundings never overlap): each corner becomes two anchors joined
 * by a circular arc (a cubic with the standard 4/3·tan(θ/4) handles). Returns
 * the new subpath; corners that cannot be rounded are left as they are.
 */
export function roundCorners(sp: DrawSubpath, indices: number[], r: number): DrawSubpath {
  if (r <= 0) return sp
  const n = sp.nodes.length
  const wanted = new Set(indices)
  const infos = new Map<number, CornerInfo>()
  for (const i of wanted) {
    const info = cornerInfo(sp, i)
    if (info) infos.set(i, info)
  }
  if (!infos.size) return sp
  const out: DrawNode[] = []
  // Each side shared with another rounded corner may only use half of itself.
  for (let i = 0; i < n; i++) {
    const info = infos.get(i)
    if (!info) {
      out.push(sp.nodes[i])
      continue
    }
    const prevRounded = infos.has((i - 1 + n) % n)
    const nextRounded = infos.has((i + 1) % n)
    const rr = Math.min(r, maxCornerRadius(info, prevRounded ? 0.5 : 1, nextRounded ? 0.5 : 1))
    if (rr <= 1e-6) {
      out.push(sp.nodes[i])
      continue
    }
    const reach = cornerReach(info, rr)
    const node = sp.nodes[i]
    const a = add(node, mul(info.uIn, reach))
    const b = add(node, mul(info.uOut, reach))
    // Turning angle of the arc, and the cubic handle length for a circle.
    const turn = Math.PI - info.angle
    const h = (4 / 3) * Math.tan(turn / 4) * rr
    const na = withHandle({ x: a.x, y: a.y }, 'out', add(a, mul(info.uIn, -h)))
    const nb = withHandle({ x: b.x, y: b.y }, 'in', add(b, mul(info.uOut, -h)))
    out.push(na, nb)
  }
  // A curved neighbouring segment keeps its own handles: the rounding starts
  // ON the chord there, close enough for the short reach a corner uses.
  return { ...sp, nodes: out }
}

// ── Knife ────────────────────────────────────────────────────────────────────

type Contour = Cubic[]

interface Region {
  contours: Contour[]
}

function contourOf(sp: DrawSubpath): Contour {
  const out: Cubic[] = []
  for (let i = 0; i < segmentCount(sp); i++) out.push(segmentOf(sp, i))
  return out
}

function contourPolygon(c: Contour): Pt[] {
  const pts: Pt[] = []
  for (const cub of c) for (let i = 0; i < 12; i++) pts.push(pointAt(cub, i / 12))
  return pts
}

function contourArea(c: Contour): number {
  return polygonArea(contourPolygon(c))
}

function nearestOnContour(c: Contour, p: Pt): { seg: number; t: number; dist: number } {
  let best = { seg: 0, t: 0, dist: Infinity }
  c.forEach((cub, seg) => {
    const h = nearestOnCubic(cub, p)
    if (h.dist < best.dist) best = { seg, t: h.t, dist: h.dist }
  })
  return best
}

/** The contour as one loop starting (and ending) at a position on it. */
function rotateContour(c: Contour, seg: number, t: number): Contour {
  const [l, r] = t <= 1e-9 ? [null, c[seg]] : t >= 1 - 1e-9 ? [c[seg], null] : splitCubicAt(c[seg], t)
  const out: Contour = []
  if (r) out.push(r)
  for (let k = 1; k < c.length; k++) out.push(c[(seg + k) % c.length])
  if (l) out.push(l)
  return out.filter((x) => cubicLength(x) > 1e-9)
}

/** Split an open chain at a position into [before, after]. */
function cutChain(chain: Contour, seg: number, t: number): [Contour, Contour] {
  const before = chain.slice(0, seg)
  const after = chain.slice(seg + 1)
  const [l, r] = splitCubicAt(chain[seg], t)
  if (cubicLength(l) > 1e-9) before.push(l)
  if (cubicLength(r) > 1e-9) after.unshift(r)
  return [before, after]
}

function lineCubic(a: Pt, b: Pt): Cubic {
  return { p0: a, p1: a, p2: b, p3: b }
}

function polylineChain(pts: Pt[]): Contour {
  const out: Contour = []
  for (let i = 0; i + 1 < pts.length; i++) if (dist(pts[i], pts[i + 1]) > 1e-9) out.push(lineCubic(pts[i], pts[i + 1]))
  return out
}

function reverseChain(c: Contour): Contour {
  return c
    .slice()
    .reverse()
    .map((x) => ({ p0: x.p3, p1: x.p2, p2: x.p1, p3: x.p0 }))
}

function chainToSubpath(c: Contour): DrawSubpath {
  return { closed: true, nodes: cubicsToNodes(c, true) }
}

/** The knife polyline between two "along" positions (index + fraction), inclusive of the ends. */
function polylineBetween(poly: Pt[], a: number, b: number): Pt[] {
  const at = (s: number): Pt => {
    const i = Math.min(poly.length - 2, Math.max(0, Math.floor(s)))
    const f = s - i
    return add(poly[i], mul(sub(poly[i + 1], poly[i]), f))
  }
  const out = [at(a)]
  for (let i = Math.floor(a) + 1; i <= Math.floor(b) && i < poly.length; i++) if (i > a && i < b) out.push(poly[i])
  out.push(at(b))
  return out
}

/** Group closed subpaths into islands: an outer contour with the holes directly inside it. */
function islandsOf(contours: Contour[]): Region[] {
  const polys = contours.map(contourPolygon)
  const depth = contours.map((_, i) => {
    const probe = polys[i][0]
    let d = 0
    contours.forEach((_, j) => {
      if (j !== i && pointInRings([polys[j]], probe, 'evenodd')) d++
    })
    return d
  })
  const regions: Region[] = []
  const outerIdx = contours.map((_, i) => i).filter((i) => depth[i] % 2 === 0)
  const byOuter = new Map<number, Region>()
  for (const i of outerIdx) {
    const r = { contours: [contours[i]] }
    byOuter.set(i, r)
    regions.push(r)
  }
  for (let i = 0; i < contours.length; i++) {
    if (depth[i] % 2 === 0) continue
    // The smallest enclosing outer.
    let best = -1
    let bestArea = Infinity
    for (const o of outerIdx) {
      if (pointInRings([polys[o]], polys[i][0], 'evenodd')) {
        const a = Math.abs(polygonArea(polys[o]))
        if (a < bestArea) {
          bestArea = a
          best = o
        }
      }
    }
    if (best >= 0) byOuter.get(best)!.contours.push(contours[i])
    else regions.push({ contours: [contours[i]] })
  }
  return regions
}

/**
 * The Knife: cut a filled, closed path along a freehand line. Every stretch of
 * the line that runs through the shape (between two crossings of its outline)
 * splits the region it crosses; a stretch from the outline into a hole slits
 * the shape open there. Returns the pieces (each a path of an outer contour
 * plus its holes), or null when the line never cuts all the way through.
 */
export function knifePath(path: DrawPath, knife: Pt[]): DrawPath[] | null {
  if (knife.length < 2) return null
  if (path.subpaths.some((sp) => !sp.closed || sp.nodes.length < 2)) return null
  const contours = path.subpaths.map(contourOf).filter((c) => c.length > 0)
  if (!contours.length) return null
  // Crossings of the knife with the outline, in order along the knife.
  const crossings: Array<{ along: number; point: Pt }> = []
  for (const c of contours) for (const cub of c) for (const h of intersectPolylineCubic(cub, knife)) crossings.push({ along: h.along, point: h.point })
  crossings.sort((a, b) => a.along - b.along)
  const uniq: typeof crossings = []
  for (const c of crossings) if (!uniq.length || dist(uniq[uniq.length - 1].point, c.point) > 1e-6) uniq.push(c)
  if (uniq.length < 2) return null
  let regions = islandsOf(contours)
  const untouched = new Set(regions)
  const scale = Math.max(1, ...contours.flatMap((c) => c.map((x) => Math.max(Math.abs(x.p0.x), Math.abs(x.p0.y)))))
  const tol = 1e-6 * scale + 1e-6
  let cuts = 0
  for (let k = 0; k + 1 < uniq.length; k++) {
    const a = uniq[k]
    const b = uniq[k + 1]
    const chordPts = polylineBetween(knife, a.along, b.along)
    // Only a stretch that runs THROUGH the material is a cut.
    const mid = chordPts.length > 2 ? chordPts[Math.floor(chordPts.length / 2)] : mul(add(chordPts[0], chordPts[chordPts.length - 1]), 0.5)
    if (!pointInPath(path, mid)) continue
    // Find the region and contours each end lies on now.
    let found: { r: Region; ca: number; cb: number; pa: { seg: number; t: number }; pb: { seg: number; t: number } } | null = null
    for (const r of regions) {
      let ca = -1
      let cb = -1
      let pa = { seg: 0, t: 0, dist: Infinity }
      let pb = { seg: 0, t: 0, dist: Infinity }
      r.contours.forEach((c, ci) => {
        const ha = nearestOnContour(c, a.point)
        if (ha.dist < pa.dist) {
          pa = ha
          ca = ci
        }
        const hb = nearestOnContour(c, b.point)
        if (hb.dist < pb.dist) {
          pb = hb
          cb = ci
        }
      })
      if (pa.dist <= tol * 100 && pb.dist <= tol * 100) {
        found = { r, ca, cb, pa, pb }
        break
      }
    }
    if (!found) continue
    const { r, ca, cb, pa, pb } = found
    const chord = polylineChain(chordPts)
    if (!chord.length) continue
    cuts++
    untouched.delete(r)
    const others = r.contours.filter((_, i) => i !== ca && i !== cb)
    if (ca !== cb) {
      // Outline to hole (or hole to hole): slit the two contours into one.
      let loopA = rotateContour(r.contours[ca], pa.seg, pa.t)
      let loopB = rotateContour(r.contours[cb], pb.seg, pb.t)
      if (Math.sign(contourArea(loopA)) === Math.sign(contourArea(loopB))) loopB = reverseChain(loopB)
      if (!loopA.length || !loopB.length) continue
      const merged: Contour = [...loopA, ...chord, ...loopB, ...reverseChain(chord)]
      // The merged contour takes the place of whichever was the outer (index 0).
      const first = ca === 0 || cb === 0
      const next: Region = { contours: first ? [merged, ...others] : [r.contours[0], ...others.filter((c) => c !== r.contours[0]), merged] }
      regions = regions.map((x) => (x === r ? next : x))
      continue
    }
    // Both ends on one contour: it splits into two loops.
    const loop = rotateContour(r.contours[ca], pa.seg, pa.t)
    const hb = nearestOnContour(loop, b.point)
    const [arc1, arc2] = cutChain(loop, hb.seg, hb.t)
    if (!arc1.length || !arc2.length) continue
    const l1: Contour = [...arc1, ...reverseChain(chord)]
    const l2: Contour = [...arc2, ...chord]
    if (ca === 0) {
      // The outline splits: two islands, each keeping the holes inside it.
      const poly1 = contourPolygon(l1)
      const r1: Region = { contours: [l1] }
      const r2: Region = { contours: [l2] }
      for (const h of others) (pointInRings([poly1], contourPolygon(h)[0], 'evenodd') ? r1 : r2).contours.push(h)
      regions = regions.flatMap((x) => (x === r ? [r1, r2] : [x]))
    } else {
      // A hole loses a bump of material to the cut: the loop that contains the
      // hole becomes the (bigger) hole, the other loop is a new island.
      const big = Math.abs(contourArea(l1)) >= Math.abs(contourArea(l2)) ? l1 : l2
      const small = big === l1 ? l2 : l1
      const smallPoly = contourPolygon(small)
      const island: Region = { contours: [small] }
      const keep: Contour[] = [r.contours[0]]
      for (const h of others) {
        if (h === r.contours[0]) continue
        if (pointInRings([smallPoly], contourPolygon(h)[0], 'evenodd')) island.contours.push(h)
        else keep.push(h)
      }
      keep.push(big)
      regions = regions.flatMap((x) => (x === r ? [{ contours: keep }, island] : [x]))
    }
  }
  if (!cuts) return null
  const out: DrawPath[] = []
  const rest = regions.filter((r) => untouched.has(r))
  if (rest.length) out.push({ ...(path.fillRule ? { fillRule: path.fillRule } : {}), subpaths: rest.flatMap((r) => r.contours.map(chainToSubpath)) })
  for (const r of regions) {
    if (untouched.has(r)) continue
    out.push({ ...(path.fillRule ? { fillRule: path.fillRule } : {}), subpaths: r.contours.map(chainToSubpath) })
  }
  return out.filter((p) => p.subpaths.every((sp) => sp.nodes.length >= 2))
}

// ── Path Eraser ──────────────────────────────────────────────────────────────

function distToPolyline(p: Pt, poly: Pt[]): number {
  if (poly.length === 1) return dist(p, poly[0])
  let best = Infinity
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]
    const b = poly[i + 1]
    const d = sub(b, a)
    const l2 = d.x * d.x + d.y * d.y
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2))
    best = Math.min(best, dist(p, add(a, mul(d, t))))
  }
  return best
}

/**
 * The Path Eraser: remove every part of the subpath within `radius` of the
 * eraser's trail. A closed subpath that loses anything opens; the rest of it
 * falls into open pieces. Untouched subpaths come back as they were (same
 * object), so a caller can tell nothing changed.
 */
export function eraseSubpath(sp: DrawSubpath, trail: Pt[], radius: number): DrawSubpath[] {
  const segs = segmentCount(sp)
  if (segs === 0 || !trail.length) return [sp]
  const erased = (s: number): boolean => {
    const k = Math.min(segs - 1, Math.floor(s))
    return distToPolyline(pointAt(segmentOf(sp, k), s - k), trail) <= radius
  }
  // Sample, then refine every in/out boundary by bisection.
  const samples: number[] = []
  for (let k = 0; k < segs; k++) {
    const steps = Math.max(8, Math.min(200, Math.ceil(cubicLength(segmentOf(sp, k)) / Math.max(0.25, radius / 4))))
    for (let i = 0; i < steps; i++) samples.push(k + i / steps)
  }
  samples.push(segs)
  const flags = samples.map(erased)
  if (!flags.some(Boolean)) return [sp]
  if (flags.every(Boolean)) return []
  const refine = (a: number, b: number, aErased: boolean): number => {
    let lo = a
    let hi = b
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2
      if (erased(m) === aErased) lo = m
      else hi = m
    }
    return (lo + hi) / 2
  }
  // Kept intervals.
  const kept: Array<[number, number]> = []
  let start: number | null = flags[0] ? null : 0
  for (let i = 1; i < samples.length; i++) {
    if (flags[i] !== flags[i - 1]) {
      const edge = refine(samples[i - 1], samples[i], flags[i - 1])
      if (flags[i]) {
        if (start != null) kept.push([start, edge])
        start = null
      } else start = edge
    }
  }
  if (start != null) kept.push([start, segs])
  if (sp.closed && kept.length >= 2 && kept[0][0] === 0 && kept[kept.length - 1][1] === segs) {
    // The kept stretch through node 0 is one piece.
    const tail = kept.pop()!
    kept[0] = [tail[0], kept[0][1] + segs]
  }
  const out: DrawSubpath[] = []
  for (const [a, b] of kept) {
    const piece = extractRange(sp, a, b)
    if (piece) out.push(piece)
  }
  return out
}

// ── Misc ─────────────────────────────────────────────────────────────────────

/** Total outline length of a path. */
export function pathLength(path: DrawPath): number {
  let s = 0
  for (const sp of path.subpaths) for (let i = 0; i < segmentCount(sp); i++) s += cubicLength(segmentOf(sp, i))
  return s
}

/** The polyline of a subpath (re-exported for tools drawing previews). */
export function subpathPolyline(sp: DrawSubpath): Pt[] {
  return flattenSubpath(sp, 0.25)
}

/** Direction a segment leaves its start anchor in. */
export function leaveDirection(c: Cubic): Pt {
  return norm(derivativeAt(c, 0))
}
