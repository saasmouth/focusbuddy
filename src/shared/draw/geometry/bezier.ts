// Cubic bezier maths for anchor editing: de Casteljau splitting, derivatives,
// nearest point, arc length, and line/curve intersection. Pure and DOM-free,
// so the editor, the ops and the tests all agree on the same numbers.
//
// A segment is always a cubic here: drawGeometry's subpathSegments turns a
// missing handle into a control point sitting on its anchor, which is exactly
// a straight line, so one segment kind covers both.

import { subpathSegments, type Cubic, type DrawPath, type DrawSubpath, type Pt } from '../../drawGeometry'

export type { Cubic } from '../../drawGeometry'

const EPS = 1e-9

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
const len = (a: Pt): number => Math.hypot(a.x, a.y)

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** The point at `t` (Bernstein form). */
export function pointAt(c: Cubic, t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const cc = 3 * mt * t * t
  const d = t * t * t
  return { x: a * c.p0.x + b * c.p1.x + cc * c.p2.x + d * c.p3.x, y: a * c.p0.y + b * c.p1.y + cc * c.p2.y + d * c.p3.y }
}

/** First derivative B'(t). */
export function derivativeAt(c: Cubic, t: number): Pt {
  const mt = 1 - t
  const a = 3 * mt * mt
  const b = 6 * mt * t
  const d = 3 * t * t
  return {
    x: a * (c.p1.x - c.p0.x) + b * (c.p2.x - c.p1.x) + d * (c.p3.x - c.p2.x),
    y: a * (c.p1.y - c.p0.y) + b * (c.p2.y - c.p1.y) + d * (c.p3.y - c.p2.y)
  }
}

/** Second derivative B''(t). */
export function secondDerivativeAt(c: Cubic, t: number): Pt {
  const mt = 1 - t
  return {
    x: 6 * mt * (c.p2.x - 2 * c.p1.x + c.p0.x) + 6 * t * (c.p3.x - 2 * c.p2.x + c.p1.x),
    y: 6 * mt * (c.p2.y - 2 * c.p1.y + c.p0.y) + 6 * t * (c.p3.y - 2 * c.p2.y + c.p1.y)
  }
}

/**
 * The unit tangent at `t`, falling back through the control polygon when the
 * derivative vanishes (a handle sitting on its anchor makes B'(0) zero, yet the
 * curve still leaves in a definite direction). Null only for a point-segment.
 */
export function tangentAt(c: Cubic, t: number): Pt | null {
  let d = derivativeAt(c, t)
  if (len(d) < 1e-9) {
    // Probe a hair inside the segment, then the chord.
    const tt = t < 0.5 ? Math.min(1, t + 1e-4) : Math.max(0, t - 1e-4)
    d = sub(pointAt(c, Math.max(t, tt)), pointAt(c, Math.min(t, tt)))
    if (len(d) < 1e-12) d = sub(c.p3, c.p0)
  }
  const l = len(d)
  return l < 1e-12 ? null : { x: d.x / l, y: d.y / l }
}

/** de Casteljau: the two halves of `c` at `t`; together they trace exactly `c`. */
export function splitCubicAt(c: Cubic, t: number): [Cubic, Cubic] {
  const p01 = lerp(c.p0, c.p1, t)
  const p12 = lerp(c.p1, c.p2, t)
  const p23 = lerp(c.p2, c.p3, t)
  const p012 = lerp(p01, p12, t)
  const p123 = lerp(p12, p23, t)
  const mid = lerp(p012, p123, t)
  return [
    { p0: c.p0, p1: p01, p2: p012, p3: mid },
    { p0: mid, p1: p123, p2: p23, p3: c.p3 }
  ]
}

/** The piece of `c` between t0 and t1 (t0 < t1), as one cubic. */
export function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  if (t0 <= 0 && t1 >= 1) return c
  const right = t0 > 0 ? splitCubicAt(c, t0)[1] : c
  if (t1 >= 1) return right
  const u = (t1 - t0) / (1 - t0)
  return splitCubicAt(right, u)[0]
}

/** True when both control points sit on the chord (within `tol`): the segment draws as a line. */
export function isStraight(c: Cubic, tol = 1e-6): boolean {
  const chord = sub(c.p3, c.p0)
  const l = len(chord)
  if (l < EPS) return dist(c.p1, c.p0) <= tol && dist(c.p2, c.p3) <= tol
  const off = (p: Pt): number => Math.abs((p.x - c.p0.x) * chord.y - (p.y - c.p0.y) * chord.x) / l
  const along = (p: Pt): number => dot(sub(p, c.p0), chord) / (l * l)
  const inside = (p: Pt): boolean => along(p) >= -tol / l && along(p) <= 1 + tol / l
  return off(c.p1) <= tol && off(c.p2) <= tol && inside(c.p1) && inside(c.p2)
}

/** Arc length by adaptive Gauss-Legendre-free subdivision (chord vs. control polygon). */
export function cubicLength(c: Cubic, tol = 0.01, depth = 0): number {
  const chord = dist(c.p0, c.p3)
  const poly = dist(c.p0, c.p1) + dist(c.p1, c.p2) + dist(c.p2, c.p3)
  if (poly - chord <= tol || depth > 18) return (chord + poly) / 2
  const [a, b] = splitCubicAt(c, 0.5)
  return cubicLength(a, tol / 2, depth + 1) + cubicLength(b, tol / 2, depth + 1)
}

/** The t at which the arc length from p0 reaches `s` (clamped to [0, 1]). */
export function tAtLength(c: Cubic, s: number): number {
  const total = cubicLength(c)
  if (s <= 0) return 0
  if (s >= total) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (cubicLength(subCubic(c, 0, mid)) < s) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export interface Nearest {
  t: number
  point: Pt
  dist: number
}

/**
 * The point on `c` nearest `p`: a coarse scan finds the basin, Newton's method
 * on d/dt |B(t) - p|^2 polishes it, and the ends are always candidates (the
 * minimum of a clamped problem often sits on one).
 */
export function nearestOnCubic(c: Cubic, p: Pt): Nearest {
  const N = 64
  const d: number[] = []
  for (let i = 0; i <= N; i++) d.push(dist(pointAt(c, i / N), p))
  // Polish EVERY basin of the coarse scan: a looping curve passes near the
  // point more than once, and the coarse best is not always the true one.
  let bestT = 0
  let bestD = Infinity
  for (let i = 0; i <= N; i++) {
    const left = i === 0 ? Infinity : d[i - 1]
    const right = i === N ? Infinity : d[i + 1]
    if (d[i] > left || d[i] > right) continue
    const t = refineNearest(c, p, i / N, Math.max(0, (i - 1) / N), Math.min(1, (i + 1) / N))
    const dt = dist(pointAt(c, t), p)
    if (dt < bestD) {
      bestD = dt
      bestT = t
    }
    if (d[i] < bestD) {
      bestD = d[i]
      bestT = i / N
    }
  }
  return { t: bestT, point: pointAt(c, bestT), dist: bestD }
}

function refineNearest(c: Cubic, p: Pt, t0: number, lo: number, hi: number): number {
  // Golden-section search inside the basin's bracket is robust even at a cusp
  // (where Newton crawls); Newton then polishes the last digits.
  const f = (t: number): number => dist(pointAt(c, t), p)
  const g = (Math.sqrt(5) - 1) / 2
  let a = lo
  let b = hi
  let x1 = b - g * (b - a)
  let x2 = a + g * (b - a)
  let f1 = f(x1)
  let f2 = f(x2)
  for (let i = 0; i < 48; i++) {
    if (f1 < f2) {
      b = x2
      x2 = x1
      f2 = f1
      x1 = b - g * (b - a)
      f1 = f(x1)
    } else {
      a = x1
      x1 = x2
      f1 = f2
      x2 = a + g * (b - a)
      f2 = f(x2)
    }
  }
  let t = f(t0) < Math.min(f1, f2) ? t0 : (a + b) / 2
  for (let i = 0; i < 16; i++) {
    const q = sub(pointAt(c, t), p)
    const d1 = derivativeAt(c, t)
    const d2 = secondDerivativeAt(c, t)
    const num = dot(q, d1)
    const den = dot(d1, d1) + dot(q, d2)
    if (Math.abs(den) < 1e-12) break
    const next = Math.max(0, Math.min(1, t - num / den))
    if (Math.abs(next - t) < 1e-12) {
      t = next
      break
    }
    if (f(next) > f(t)) break
    t = next
  }
  return t
}

export interface PathHit extends Nearest {
  si: number
  /** Segment index within the subpath: segment i runs from node i to node i+1 (wrapping when closed). */
  seg: number
}

/** The cubic of segment `i` of a subpath. */
export function segmentOf(sp: DrawSubpath, i: number): Cubic {
  const n = sp.nodes.length
  const a = sp.nodes[i]
  const b = sp.nodes[(i + 1) % n]
  return {
    p0: { x: a.x, y: a.y },
    p1: { x: a.outX ?? a.x, y: a.outY ?? a.y },
    p2: { x: b.inX ?? b.x, y: b.inY ?? b.y },
    p3: { x: b.x, y: b.y }
  }
}

/** Number of segments in a subpath. */
export function segmentCount(sp: DrawSubpath): number {
  const n = sp.nodes.length
  if (n < 2) return 0
  return sp.closed ? n : n - 1
}

/** The nearest point on the whole path, or null for a path with no segments. */
export function nearestOnPath(path: DrawPath, p: Pt): PathHit | null {
  let best: PathHit | null = null
  path.subpaths.forEach((sp, si) => {
    const segs = subpathSegments(sp)
    segs.forEach((c, seg) => {
      // Cheap reject on the control hull's box before the full search.
      if (best) {
        const minX = Math.min(c.p0.x, c.p1.x, c.p2.x, c.p3.x)
        const maxX = Math.max(c.p0.x, c.p1.x, c.p2.x, c.p3.x)
        const minY = Math.min(c.p0.y, c.p1.y, c.p2.y, c.p3.y)
        const maxY = Math.max(c.p0.y, c.p1.y, c.p2.y, c.p3.y)
        const dx = Math.max(minX - p.x, 0, p.x - maxX)
        const dy = Math.max(minY - p.y, 0, p.y - maxY)
        if (Math.hypot(dx, dy) > best.dist) return
      }
      const h = nearestOnCubic(c, p)
      if (!best || h.dist < best.dist) best = { ...h, si, seg }
    })
  })
  return best
}

// ── Roots ────────────────────────────────────────────────────────────────────

/** Real roots of a t^3 + b t^2 + c t + d = 0 (degrades to quadratic/linear). */
export function solveCubic(a: number, b: number, c: number, d: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d))
  if (scale < 1e-300) return []
  if (Math.abs(a) < 1e-12 * scale) return solveQuadratic(b, c, d)
  const A = b / a
  const B = c / a
  const C = d / a
  const Q = (3 * B - A * A) / 9
  const R = (9 * A * B - 27 * C - 2 * A * A * A) / 54
  const D = Q * Q * Q + R * R
  const off = -A / 3
  if (D > 1e-14) {
    const s = Math.cbrt(R + Math.sqrt(D))
    const t = Math.cbrt(R - Math.sqrt(D))
    return [off + s + t]
  }
  if (D >= -1e-14) {
    // A repeated root.
    const s = Math.cbrt(R)
    return dedupe([off + 2 * s, off - s])
  }
  const th = Math.acos(Math.max(-1, Math.min(1, R / Math.sqrt(-Q * Q * Q))))
  const m = 2 * Math.sqrt(-Q)
  return [off + m * Math.cos(th / 3), off + m * Math.cos((th + 2 * Math.PI) / 3), off + m * Math.cos((th + 4 * Math.PI) / 3)]
}

export function solveQuadratic(a: number, b: number, c: number): number[] {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c))
  if (scale < 1e-300) return []
  if (Math.abs(a) < 1e-12 * scale) return Math.abs(b) < 1e-300 ? [] : [-c / b]
  const disc = b * b - 4 * a * c
  if (disc < 0) return disc > -1e-12 * b * b ? [-b / (2 * a)] : []
  const s = Math.sqrt(disc)
  // The numerically stable pair.
  const q = -0.5 * (b + Math.sign(b || 1) * s)
  const r1 = q / a
  const r2 = Math.abs(q) > 1e-300 ? c / q : r1
  return dedupe([r1, r2])
}

function dedupe(xs: number[]): number[] {
  const out: number[] = []
  for (const x of xs) if (!out.some((y) => Math.abs(y - x) < 1e-9)) out.push(x)
  return out
}

// ── Intersections ────────────────────────────────────────────────────────────

export interface LineHit {
  /** Parameter on the cubic. */
  t: number
  /** Parameter on the line segment a→b, 0..1. */
  u: number
  point: Pt
}

/**
 * Where the segment a→b crosses the cubic. The cubic is expressed as signed
 * distance from the line, a cubic polynomial in t, whose roots in [0, 1] are
 * then kept only if they also fall within the segment. A cubic lying ALONG the
 * line (an overlap, not a crossing) yields nothing.
 */
export function intersectLineCubic(c: Cubic, a: Pt, b: Pt): LineHit[] {
  const dir = sub(b, a)
  const L = len(dir)
  if (L < EPS) return []
  const sd = (p: Pt): number => ((p.x - a.x) * dir.y - (p.y - a.y) * dir.x) / L
  const d0 = sd(c.p0)
  const d1 = sd(c.p1)
  const d2 = sd(c.p2)
  const d3 = sd(c.p3)
  if (Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2), Math.abs(d3)) < 1e-9) return []
  // All control points on one side: no crossing.
  if ((d0 > 0 && d1 > 0 && d2 > 0 && d3 > 0) || (d0 < 0 && d1 < 0 && d2 < 0 && d3 < 0)) return []
  const roots = solveCubic(-d0 + 3 * d1 - 3 * d2 + d3, 3 * d0 - 6 * d1 + 3 * d2, -3 * d0 + 3 * d1, d0)
  const out: LineHit[] = []
  for (const r of roots) {
    if (r < -1e-9 || r > 1 + 1e-9) continue
    const t = Math.max(0, Math.min(1, r))
    const point = pointAt(c, t)
    const u = dot(sub(point, a), dir) / (L * L)
    if (u < -1e-9 || u > 1 + 1e-9) continue
    if (!out.some((h) => Math.abs(h.t - t) < 1e-7)) out.push({ t, u: Math.max(0, Math.min(1, u)), point })
  }
  return out.sort((x, y) => x.t - y.t)
}

/** Every crossing of a polyline with a cubic, ordered along the polyline. */
export function intersectPolylineCubic(c: Cubic, poly: Pt[]): Array<LineHit & { along: number }> {
  const out: Array<LineHit & { along: number }> = []
  for (let i = 0; i + 1 < poly.length; i++) {
    for (const h of intersectLineCubic(c, poly[i], poly[i + 1])) {
      const along = i + h.u
      // A crossing exactly at a polyline vertex is reported by both pieces.
      if (out.some((o) => Math.abs(o.t - h.t) < 1e-7)) continue
      out.push({ ...h, along })
    }
  }
  return out.sort((x, y) => x.along - y.along)
}

/** The angle in degrees between two directions, 0..180. */
export function angleBetween(u: Pt, v: Pt): number {
  const lu = len(u)
  const lv = len(v)
  if (lu < 1e-12 || lv < 1e-12) return 0
  const c = Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)))
  return (Math.acos(c) * 180) / Math.PI
}

/** Sample a cubic at n+1 evenly spaced parameters. */
export function sampleCubic(c: Cubic, n: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) out.push(pointAt(c, i / n))
  return out
}

/** The largest distance from any sample of `a` to the path `b` (one-sided Hausdorff, sampled). */
export function maxDeviation(a: DrawPath, b: DrawPath, samplesPerSegment = 24): number {
  let worst = 0
  for (const sp of a.subpaths) {
    for (const c of subpathSegments(sp)) {
      for (const p of sampleCubic(c, samplesPerSegment)) {
        const h = nearestOnPath(b, p)
        worst = Math.max(worst, h ? h.dist : Infinity)
      }
    }
  }
  return worst
}
