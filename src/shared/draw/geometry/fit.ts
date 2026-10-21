// Curve fitting: Philip Schneider's least-squares bezier fit ("An Algorithm
// for Automatically Fitting Digitized Curves", Graphics Gems, 1990), and what
// is built on it -- Simplify (Object > Path > Simplify), the Smooth tool, and
// the Curvature tool's spline. Pure and deterministic.

import type { DrawNode, DrawSubpath, Pt } from '../../drawGeometry'
import { angleBetween, cubicLength, dist, isStraight, pointAt, segmentCount, segmentOf, type Cubic } from './bezier'

const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
const norm = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

// ── Schneider ────────────────────────────────────────────────────────────────

/**
 * Fit a chain of cubics through `pts` with every sample within `error` of the
 * result. `tan1` / `tan2` pin the end tangents (unit vectors pointing INTO the
 * curve at the start, and back along it at the end); left out they are taken
 * from the neighbouring samples.
 */
export function fitCubics(pts: Pt[], error: number, tan1?: Pt, tan2?: Pt): Cubic[] {
  const points = dedupePoints(pts)
  if (points.length < 2) return []
  const n = points.length
  const t1 = tan1 ?? norm(sub(points[1], points[0]))
  const t2 = tan2 ?? norm(sub(points[n - 2], points[n - 1]))
  const out: Cubic[] = []
  fitRange(points, 0, n - 1, t1, t2, Math.max(error, 1e-6), out, 0)
  return out
}

function dedupePoints(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 1e-9) out.push(p)
  return out
}

function fitRange(pts: Pt[], first: number, last: number, tan1: Pt, tan2: Pt, error: number, out: Cubic[], depth: number): void {
  if (last - first === 1) {
    const d = dist(pts[first], pts[last]) / 3
    out.push({ p0: pts[first], p1: add(pts[first], mul(tan1, d)), p2: add(pts[last], mul(tan2, d)), p3: pts[last] })
    return
  }
  let u = chordLengthParameterize(pts, first, last)
  let curve = generateBezier(pts, first, last, u, tan1, tan2)
  let { max, index } = maxError(pts, first, last, curve, u)
  if (max < error) {
    out.push(curve)
    return
  }
  // Close enough to improve by re-parameterising (Newton) rather than splitting.
  if (max < error * 4) {
    for (let i = 0; i < 20; i++) {
      const uPrime = reparameterize(pts, first, last, u, curve)
      curve = generateBezier(pts, first, last, uPrime, tan1, tan2)
      const e = maxError(pts, first, last, curve, uPrime)
      if (e.max < error) {
        out.push(curve)
        return
      }
      max = e.max
      index = e.index
      u = uPrime
    }
  }
  if (depth > 40) {
    out.push(curve)
    return
  }
  // Split at the worst point with a shared centre tangent, and fit each half.
  index = Math.min(last - 1, Math.max(first + 1, index))
  const center = centerTangent(pts, index)
  fitRange(pts, first, index, tan1, center, error, out, depth + 1)
  fitRange(pts, index, last, mul(center, -1), tan2, error, out, depth + 1)
}

function centerTangent(pts: Pt[], i: number): Pt {
  const v = sub(pts[i - 1], pts[i + 1])
  const t = norm(v)
  if (t.x === 0 && t.y === 0) return norm(sub(pts[i - 1], pts[i]))
  return t
}

function chordLengthParameterize(pts: Pt[], first: number, last: number): number[] {
  const u = [0]
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(pts[i], pts[i - 1]))
  const total = u[u.length - 1] || 1
  return u.map((x) => x / total)
}

function generateBezier(pts: Pt[], first: number, last: number, u: number[], tan1: Pt, tan2: Pt): Cubic {
  const p0 = pts[first]
  const p3 = pts[last]
  const C = [
    [0, 0],
    [0, 0]
  ]
  const X = [0, 0]
  for (let i = 0; i < u.length; i++) {
    const t = u[i]
    const mt = 1 - t
    const b0 = mt * mt * mt
    const b1 = 3 * t * mt * mt
    const b2 = 3 * t * t * mt
    const b3 = t * t * t
    const a1 = mul(tan1, b1)
    const a2 = mul(tan2, b2)
    C[0][0] += dot(a1, a1)
    C[0][1] += dot(a1, a2)
    C[1][0] = C[0][1]
    C[1][1] += dot(a2, a2)
    const tmp = sub(pts[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)))
    X[0] += dot(a1, tmp)
    X[1] += dot(a2, tmp)
  }
  const det = C[0][0] * C[1][1] - C[1][0] * C[0][1]
  let alpha1 = 0
  let alpha2 = 0
  if (Math.abs(det) > 1e-12) {
    alpha1 = (X[0] * C[1][1] - X[1] * C[0][1]) / det
    alpha2 = (C[0][0] * X[1] - C[1][0] * X[0]) / det
  }
  const segLen = dist(p0, p3)
  const eps = 1e-6 * segLen
  // A degenerate or backwards solution falls back to Wu/Barsky's heuristic.
  if (alpha1 < eps || alpha2 < eps) {
    alpha1 = alpha2 = segLen / 3
  }
  return { p0, p1: add(p0, mul(tan1, alpha1)), p2: add(p3, mul(tan2, alpha2)), p3 }
}

function reparameterize(pts: Pt[], first: number, _last: number, u: number[], c: Cubic): number[] {
  return u.map((t, i) => newtonRoot(c, pts[first + i], t))
}

function newtonRoot(c: Cubic, p: Pt, t: number): number {
  const q = pointAt(c, t)
  const d1 = {
    x: 3 * ((1 - t) * (1 - t) * (c.p1.x - c.p0.x) + 2 * t * (1 - t) * (c.p2.x - c.p1.x) + t * t * (c.p3.x - c.p2.x)),
    y: 3 * ((1 - t) * (1 - t) * (c.p1.y - c.p0.y) + 2 * t * (1 - t) * (c.p2.y - c.p1.y) + t * t * (c.p3.y - c.p2.y))
  }
  const d2 = {
    x: 6 * ((1 - t) * (c.p2.x - 2 * c.p1.x + c.p0.x) + t * (c.p3.x - 2 * c.p2.x + c.p1.x)),
    y: 6 * ((1 - t) * (c.p2.y - 2 * c.p1.y + c.p0.y) + t * (c.p3.y - 2 * c.p2.y + c.p1.y))
  }
  const diff = sub(q, p)
  const num = dot(diff, d1)
  const den = dot(d1, d1) + dot(diff, d2)
  if (Math.abs(den) < 1e-12) return t
  return Math.max(0, Math.min(1, t - num / den))
}

function maxError(pts: Pt[], first: number, last: number, c: Cubic, u: number[]): { max: number; index: number } {
  let max = 0
  let index = Math.floor((last - first + 1) / 2) + first
  for (let i = first + 1; i < last; i++) {
    const d = dist(pointAt(c, u[i - first]), pts[i])
    if (d >= max) {
      max = d
      index = i
    }
  }
  return { max, index }
}

/**
 * ONE cubic through `pts` with the given end tangents, as close as least
 * squares (plus Newton re-parameterisation) gets it. What deleting an anchor
 * uses to merge its two segments without changing the shape more than it must.
 */
export function fitSingleCubic(pts: Pt[], tan1: Pt, tan2: Pt, params?: number[]): Cubic {
  const points = params && params.length === pts.length ? pts : dedupePoints(pts)
  const n = points.length
  if (n < 2) return { p0: pts[0], p1: pts[0], p2: pts[pts.length - 1], p3: pts[pts.length - 1] }
  if (n === 2) {
    const d = dist(points[0], points[1]) / 3
    return { p0: points[0], p1: add(points[0], mul(tan1, d)), p2: add(points[1], mul(tan2, d)), p3: points[1] }
  }
  let u = params && params.length === pts.length ? params.slice() : chordLengthParameterize(points, 0, n - 1)
  let curve = generateBezier(points, 0, n - 1, u, tan1, tan2)
  let best = { curve, err: maxError(points, 0, n - 1, curve, u).max }
  if (best.err < 1e-9) return curve
  for (let i = 0; i < 30; i++) {
    u = reparameterize(points, 0, n - 1, u, curve)
    curve = generateBezier(points, 0, n - 1, u, tan1, tan2)
    const err = maxError(points, 0, n - 1, curve, u).max
    if (err < best.err) best = { curve, err }
  }
  return best.curve
}

// ── Cubics <-> nodes ─────────────────────────────────────────────────────────

/** Nodes for a chain of cubics (end of one = start of the next). Straight pieces carry no handles. */
export function cubicsToNodes(cubics: Cubic[], closed: boolean): DrawNode[] {
  if (!cubics.length) return []
  const nodes: DrawNode[] = []
  for (let i = 0; i < cubics.length; i++) {
    const c = cubics[i]
    const straight = isStraight(c, 1e-6)
    if (i === 0) nodes.push({ x: c.p0.x, y: c.p0.y })
    const start = nodes[nodes.length - 1]
    if (!straight) {
      start.outX = c.p1.x
      start.outY = c.p1.y
    }
    const end: DrawNode = { x: c.p3.x, y: c.p3.y }
    if (!straight) {
      end.inX = c.p2.x
      end.inY = c.p2.y
    }
    nodes.push(end)
  }
  if (closed && nodes.length > 1) {
    // The last node is the first one again: fold its in-handle onto node 0.
    const lastNode = nodes.pop()!
    if (lastNode.inX != null) {
      nodes[0].inX = lastNode.inX
      nodes[0].inY = lastNode.inY
    }
  }
  return nodes
}

/** The cubics of a subpath, as the node list describes them. */
export function subpathCubics(sp: DrawSubpath): Cubic[] {
  const out: Cubic[] = []
  for (let i = 0; i < segmentCount(sp); i++) out.push(segmentOf(sp, i))
  return out
}

// ── Corners ──────────────────────────────────────────────────────────────────

/**
 * The interior angle at node `i`, 0..180 degrees: 180 is a straight-through
 * (smooth) point, 90 a square corner, near 0 a spike. Open-path ends report 180.
 */
export function anchorAngle(sp: DrawSubpath, i: number): number {
  const n = sp.nodes.length
  if (!sp.closed && (i === 0 || i === n - 1)) return 180
  const node = sp.nodes[i]
  const prev = sp.nodes[(i - 1 + n) % n]
  const next = sp.nodes[(i + 1) % n]
  const inDir = node.inX != null && Math.hypot(node.inX - node.x, (node.inY ?? 0) - node.y) > 1e-9 ? { x: node.inX - node.x, y: (node.inY ?? 0) - node.y } : tangentToward(prev, node, true)
  const outDir = node.outX != null && Math.hypot(node.outX - node.x, (node.outY ?? 0) - node.y) > 1e-9 ? { x: node.outX - node.x, y: (node.outY ?? 0) - node.y } : tangentToward(next, node, false)
  return angleBetween(inDir, outDir)
}

/** Direction from `node` toward its neighbour along the segment, when the node has no handle on that side. */
function tangentToward(other: DrawNode, node: DrawNode, otherIsPrev: boolean): Pt {
  // The neighbour's facing handle, else the neighbour itself.
  const h = otherIsPrev ? (other.outX != null ? { x: other.outX, y: other.outY ?? 0 } : other) : other.inX != null ? { x: other.inX, y: other.inY ?? 0 } : other
  const v = sub(h, node)
  return Math.hypot(v.x, v.y) > 1e-9 ? v : sub(other, node)
}

// ── Simplify ─────────────────────────────────────────────────────────────────

export interface SimplifyOptions {
  /** Simplify Curve, 0..100: 0 = fewest points, 100 = closest to the original. */
  precision: number
  /** Corner Point Angle Threshold, 0..180: corners sharper than this stay sharp. */
  angleThreshold: number
  /** Convert to Straight Lines: the result has no curves. */
  straightLines: boolean
}

export const SIMPLIFY_DEFAULTS: SimplifyOptions = { precision: 50, angleThreshold: 135, straightLines: false }

/** The fit tolerance a precision stands for, scaled to the size of what is simplified. */
export function simplifyTolerance(precision: number, size: number): number {
  const p = Math.max(0, Math.min(100, precision)) / 100
  return Math.max(0.02, size * 0.04 * (1 - p) * (1 - p))
}

/**
 * Simplify one subpath: sample it, keep its sharp corners as fixed points,
 * and re-fit each run between them with as few cubics as the tolerance allows.
 */
export function simplifySubpath(sp: DrawSubpath, tolerance: number, angleThreshold: number, straightLines: boolean): DrawSubpath {
  const n = sp.nodes.length
  const segs = segmentCount(sp)
  if (segs === 0) return sp
  // Fixed points: open ends always, plus corners sharper than the threshold.
  const fixed: number[] = []
  for (let i = 0; i < n; i++) {
    if (!sp.closed && (i === 0 || i === n - 1)) fixed.push(i)
    else if (anchorAngle(sp, i) < angleThreshold - 1e-9) fixed.push(i)
  }
  // Walk runs of segments between fixed anchors. A closed subpath with no
  // corner starts and ends at node 0 with a smooth join.
  const runs: Array<{ from: number; to: number }> = []
  if (sp.closed) {
    if (fixed.length === 0) runs.push({ from: 0, to: n })
    else
      for (let k = 0; k < fixed.length; k++) {
        const from = fixed[k]
        const to = k + 1 < fixed.length ? fixed[k + 1] : fixed[0] + n
        runs.push({ from, to })
      }
  } else {
    for (let k = 0; k + 1 < fixed.length; k++) runs.push({ from: fixed[k], to: fixed[k + 1] })
  }
  const smoothLoop = sp.closed && fixed.length === 0
  const out: Cubic[] = []
  for (const run of runs) {
    const pts: Pt[] = []
    for (let s = run.from; s < run.to; s++) {
      const c = segmentOf(sp, s % n)
      const steps = Math.max(4, Math.min(64, Math.ceil(cubicLength(c) / Math.max(0.5, tolerance / 2))))
      for (let i = s === run.from ? 0 : 1; i <= steps; i++) pts.push(pointAt(c, i / steps))
    }
    if (straightLines) {
      const kept = rdp(pts, tolerance)
      for (let i = 0; i + 1 < kept.length; i++) out.push({ p0: kept[i], p1: kept[i], p2: kept[i + 1], p3: kept[i + 1] })
      continue
    }
    let tan1: Pt | undefined
    let tan2: Pt | undefined
    if (smoothLoop && pts.length > 3) {
      // One tangent through node 0 shared by both ends of the loop.
      const t = norm(sub(pts[1], pts[pts.length - 2]))
      tan1 = t
      tan2 = mul(t, -1)
    }
    out.push(...fitCubics(pts, tolerance, tan1, tan2))
  }
  if (!out.length) return sp
  const nodes = cubicsToNodes(out, sp.closed)
  return { closed: sp.closed, nodes: nodes.length >= (sp.closed ? 2 : 2) ? nodes : sp.nodes }
}

function rdp(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.slice()
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = keep[points.length - 1] = true
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let maxD = -1
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (idx > 0 && maxD > tolerance) {
      keep[idx] = true
      stack.push([s, idx], [idx, e])
    }
  }
  return points.filter((_, i) => keep[i])
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const d = sub(b, a)
  const l2 = dot(d, d)
  if (l2 < 1e-18) return dist(p, a)
  const t = Math.max(0, Math.min(1, dot(sub(p, a), d) / l2))
  return dist(p, add(a, mul(d, t)))
}

// ── Smooth tool ──────────────────────────────────────────────────────────────

/**
 * Re-fit the stretch of an OPEN node list from node i0 to node i1 (i0 < i1)
 * more smoothly: the samples are averaged (`passes` times) before fitting with
 * `tolerance`, the end nodes stay where they are and keep their outer handles.
 */
export function smoothRun(nodes: DrawNode[], i0: number, i1: number, tolerance: number, passes: number): DrawNode[] {
  if (i1 - i0 < 1) return nodes
  const sp: DrawSubpath = { closed: false, nodes }
  const pts: Pt[] = []
  for (let s = i0; s < i1; s++) {
    const c = segmentOf(sp, s)
    const steps = Math.max(6, Math.min(48, Math.ceil(cubicLength(c) / 2)))
    for (let i = s === i0 ? 0 : 1; i <= steps; i++) pts.push(pointAt(c, i / steps))
  }
  let smoothed = pts
  for (let k = 0; k < passes; k++) {
    smoothed = smoothed.map((p, i) => (i === 0 || i === smoothed.length - 1 ? p : mul(add(add(smoothed[i - 1], mul(p, 2)), smoothed[i + 1]), 0.25)))
  }
  const cubics = fitCubics(smoothed, tolerance)
  if (!cubics.length) return nodes
  const mid = cubicsToNodes(cubics, false)
  const first = nodes[i0]
  const last = nodes[i1]
  mid[0] = { ...withoutHandle(first, 'out'), ...(mid[0].outX != null ? { outX: mid[0].outX, outY: mid[0].outY } : {}) }
  mid[mid.length - 1] = { ...withoutHandle(last, 'in'), ...(mid[mid.length - 1].inX != null ? { inX: mid[mid.length - 1].inX, inY: mid[mid.length - 1].inY } : {}) }
  return [...nodes.slice(0, i0), ...mid, ...nodes.slice(i1 + 1)]
}

function withoutHandle(n: DrawNode, side: 'in' | 'out'): DrawNode {
  if (side === 'in') {
    const { inX: _x, inY: _y, ...rest } = n
    void _x
    void _y
    return rest
  }
  const { outX: _x, outY: _y, ...rest } = n
  void _x
  void _y
  return rest
}

// ── Curvature spline ─────────────────────────────────────────────────────────

export interface CurvaturePoint {
  x: number
  y: number
  /** A corner point: straight segments meet here. */
  corner?: boolean
}

/**
 * The Curvature tool's path: every smooth point gets handles along the line
 * through its neighbours (so the curve flows through it), each a third of the
 * way to the neighbour on that side; a corner point gets none. An open path's
 * end handles aim at the neighbour's facing handle, so the first and last
 * segments bend into the curve instead of leaving it straight.
 */
export function curvatureNodes(points: CurvaturePoint[], closed: boolean): DrawNode[] {
  const n = points.length
  if (n === 0) return []
  if (n === 1) return [{ x: points[0].x, y: points[0].y }]
  const nodes: DrawNode[] = points.map((p) => ({ x: p.x, y: p.y }))
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const isEnd = !closed && (i === 0 || i === n - 1)
    if (p.corner || isEnd || n < 3) continue
    const prev = points[(i - 1 + n) % n]
    const next = points[(i + 1) % n]
    const t = norm(sub(next, prev))
    const dIn = dist(p, prev) / 3
    const dOut = dist(p, next) / 3
    nodes[i].inX = p.x - t.x * dIn
    nodes[i].inY = p.y - t.y * dIn
    nodes[i].outX = p.x + t.x * dOut
    nodes[i].outY = p.y + t.y * dOut
  }
  if (!closed && n >= 3) {
    // Ends: aim at the neighbour's facing handle (a quadratic-like bend).
    const a = nodes[1]
    if (!points[1].corner && a.inX != null) {
      const h = { x: a.inX, y: a.inY ?? 0 }
      const o = add(points[0], mul(sub(h, points[0]), 0.5))
      nodes[0].outX = o.x
      nodes[0].outY = o.y
    }
    const b = nodes[n - 2]
    if (!points[n - 2].corner && b.outX != null) {
      const h = { x: b.outX, y: b.outY ?? 0 }
      const o = add(points[n - 1], mul(sub(h, points[n - 1]), 0.5))
      nodes[n - 1].inX = o.x
      nodes[n - 1].inY = o.y
    }
  }
  return nodes
}

/**
 * Re-smooth one anchor of an existing path with the Curvature tool's rule
 * (handles along the neighbours' chord, a third of each neighbour distance),
 * keeping it as it is when it is a corner.
 */
export function curvatureHandlesAt(sp: DrawSubpath, i: number): DrawNode {
  const n = sp.nodes.length
  const node = sp.nodes[i]
  if (n < 3 && !sp.closed) return node
  const isEnd = !sp.closed && (i === 0 || i === n - 1)
  if (isEnd) return node
  const prev = sp.nodes[(i - 1 + n) % n]
  const next = sp.nodes[(i + 1) % n]
  const t = norm(sub(next, prev))
  const dIn = dist(node, prev) / 3
  const dOut = dist(node, next) / 3
  return { x: node.x, y: node.y, inX: node.x - t.x * dIn, inY: node.y - t.y * dIn, outX: node.x + t.x * dOut, outY: node.y + t.y * dOut }
}

