// PlexiDraw geometry core — the pure maths under the vector studio. Everything
// here is deterministic and DOM-free so the editor, the exporter and the tests
// all agree on exactly the same geometry.
//
// The path model is the one Illustrator (and SVG) uses: a path is a list of
// subpaths, a subpath is a list of on-curve nodes, and each node carries the
// ABSOLUTE positions of its incoming and outgoing bezier handles. Absolute (not
// relative) handles were chosen because every operation here — transforms,
// flattening, hit-testing, booleans — becomes a plain coordinate map, with no
// chance of a handle drifting out of step with its anchor.

export interface Pt {
  x: number
  y: number
}

export interface DrawNode {
  x: number
  y: number
  // Absolute handle positions. Absent means "no handle" — the segment on that
  // side is a straight line.
  inX?: number
  inY?: number
  outX?: number
  outY?: number
}

export interface DrawSubpath {
  closed: boolean
  nodes: DrawNode[]
}

export interface DrawPath {
  subpaths: DrawSubpath[]
  // SVG fill rule. Absent means 'nonzero', SVG's own default.
  fillRule?: 'nonzero' | 'evenodd'
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A 2D affine transform in SVG's matrix order: [a, b, c, d, e, f]. */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

// Coordinates closer than this are the same point. Chosen well below a device
// pixel at any sane zoom, but far enough above float noise that two ends of the
// same split segment always agree.
const EPS = 1e-6
// The quantisation used to key point lookups when chaining boolean output.
const KEY_Q = 1e4

export function pt(x: number, y: number): Pt {
  return { x, y }
}

export function node(x: number, y: number): DrawNode {
  return { x, y }
}

// ── Construction ─────────────────────────────────────────────────────────────

export function emptyPath(): DrawPath {
  return { subpaths: [] }
}

export function pathFromPoints(points: Pt[], closed = true): DrawPath {
  if (points.length < 2) return emptyPath()
  return { subpaths: [{ closed, nodes: points.map((p) => node(p.x, p.y)) }] }
}

export function rectPath(x: number, y: number, w: number, h: number): DrawPath {
  return pathFromPoints([pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)], true)
}

export function linePath(x1: number, y1: number, x2: number, y2: number): DrawPath {
  return pathFromPoints([pt(x1, y1), pt(x2, y2)], false)
}

// A rounded rectangle built from four line nodes and four quarter-circle
// corners. The 0.5522847498 factor is the standard circular-arc bezier constant.
const KAPPA = 0.5522847498307936

export function roundRectPath(x: number, y: number, w: number, h: number, r: number): DrawPath {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  if (rr <= 0) return rectPath(x, y, w, h)
  const k = rr * KAPPA
  const x2 = x + w
  const y2 = y + h
  const nodes: DrawNode[] = [
    { x: x + rr, y, outX: x + rr - k, outY: y }, // placeholder handles fixed below
    { x: x2 - rr, y },
    { x: x2, y: y + rr },
    { x: x2, y: y2 - rr },
    { x: x2 - rr, y: y2 },
    { x: x + rr, y: y2 },
    { x, y: y2 - rr },
    { x, y: y + rr }
  ]
  // Top-right corner
  nodes[1].outX = x2 - rr + k
  nodes[1].outY = y
  nodes[2].inX = x2
  nodes[2].inY = y + rr - k
  // Bottom-right
  nodes[3].outX = x2
  nodes[3].outY = y2 - rr + k
  nodes[4].inX = x2 - rr + k
  nodes[4].inY = y2
  // Bottom-left
  nodes[5].outX = x + rr - k
  nodes[5].outY = y2
  nodes[6].inX = x
  nodes[6].inY = y2 - rr + k
  // Top-left
  nodes[7].outX = x
  nodes[7].outY = y + rr - k
  nodes[0].inX = x + rr - k
  nodes[0].inY = y
  delete nodes[0].outX
  delete nodes[0].outY
  return { subpaths: [{ closed: true, nodes }] }
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): DrawPath {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  const nodes: DrawNode[] = [
    { x: cx, y: cy - ry, inX: cx - kx, inY: cy - ry, outX: cx + kx, outY: cy - ry },
    { x: cx + rx, y: cy, inX: cx + rx, inY: cy - ky, outX: cx + rx, outY: cy + ky },
    { x: cx, y: cy + ry, inX: cx + kx, inY: cy + ry, outX: cx - kx, outY: cy + ry },
    { x: cx - rx, y: cy, inX: cx - rx, inY: cy + ky, outX: cx - rx, outY: cy - ky }
  ]
  return { subpaths: [{ closed: true, nodes }] }
}

/** A regular polygon inscribed in the given radius, first vertex pointing up. */
export function polygonPath(cx: number, cy: number, r: number, sides: number): DrawPath {
  const n = Math.max(3, Math.round(sides))
  const points: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    points.push(pt(cx + r * Math.cos(a), cy + r * Math.sin(a)))
  }
  return pathFromPoints(points, true)
}

/** A star: `points` outer vertices alternating with inner ones at innerRatio. */
export function starPath(cx: number, cy: number, r: number, points: number, innerRatio = 0.5): DrawPath {
  const n = Math.max(3, Math.round(points))
  const ri = Math.max(0.02, Math.min(0.98, innerRatio)) * r
  const out: Pt[] = []
  for (let i = 0; i < n * 2; i++) {
    const rad = i % 2 === 0 ? r : ri
    const a = -Math.PI / 2 + (i * Math.PI) / n
    out.push(pt(cx + rad * Math.cos(a), cy + rad * Math.sin(a)))
  }
  return pathFromPoints(out, true)
}

// ── Segments & flattening ────────────────────────────────────────────────────

export interface Cubic {
  p0: Pt
  p1: Pt
  p2: Pt
  p3: Pt
}

/**
 * The cubic segments of a subpath. A missing handle collapses to its anchor,
 * which makes a cubic that is exactly a straight line — so everything downstream
 * only ever has to understand one segment kind.
 */
export function subpathSegments(sp: DrawSubpath): Cubic[] {
  const n = sp.nodes.length
  if (n < 2) return []
  const segs: Cubic[] = []
  const last = sp.closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = sp.nodes[i]
    const b = sp.nodes[(i + 1) % n]
    segs.push({
      p0: pt(a.x, a.y),
      p1: pt(a.outX ?? a.x, a.outY ?? a.y),
      p2: pt(b.inX ?? b.x, b.inY ?? b.y),
      p3: pt(b.x, b.y)
    })
  }
  return segs
}

export function cubicAt(c: Cubic, t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const cc = 3 * mt * t * t
  const d = t * t * t
  return pt(a * c.p0.x + b * c.p1.x + cc * c.p2.x + d * c.p3.x, a * c.p0.y + b * c.p1.y + cc * c.p2.y + d * c.p3.y)
}

/** True when the cubic is (within tolerance) a straight line — no need to split. */
function cubicIsFlat(c: Cubic, tol: number): boolean {
  const d1 = distToSegment(c.p1, c.p0, c.p3)
  const d2 = distToSegment(c.p2, c.p0, c.p3)
  return Math.max(d1, d2) <= tol
}

function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: Pt, b: Pt): Pt => pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  const p01 = lerp(c.p0, c.p1)
  const p12 = lerp(c.p1, c.p2)
  const p23 = lerp(c.p2, c.p3)
  const p012 = lerp(p01, p12)
  const p123 = lerp(p12, p23)
  const mid = lerp(p012, p123)
  return [
    { p0: c.p0, p1: p01, p2: p012, p3: mid },
    { p0: mid, p1: p123, p2: p23, p3: c.p3 }
  ]
}

/**
 * Adaptive flattening: recursively halve a cubic until each piece is within
 * `tolerance` of a straight line. The depth cap keeps a pathological curve (a
 * cusp, a zero-length segment with wild handles) from recursing forever.
 */
function flattenCubic(c: Cubic, tol: number, out: Pt[], depth = 0): void {
  if (depth > 16 || cubicIsFlat(c, tol)) {
    out.push(c.p3)
    return
  }
  const [a, b] = splitCubic(c, 0.5)
  flattenCubic(a, tol, out, depth + 1)
  flattenCubic(b, tol, out, depth + 1)
}

/** A subpath as a polyline. Closed subpaths do NOT repeat the first point. */
export function flattenSubpath(sp: DrawSubpath, tolerance = 0.25): Pt[] {
  if (sp.nodes.length === 0) return []
  if (sp.nodes.length === 1) return [pt(sp.nodes[0].x, sp.nodes[0].y)]
  const out: Pt[] = [pt(sp.nodes[0].x, sp.nodes[0].y)]
  for (const seg of subpathSegments(sp)) flattenCubic(seg, tolerance, out)
  // A closed subpath's last flattened point IS its first node; drop the repeat.
  if (sp.closed && out.length > 1 && near(out[out.length - 1], out[0])) out.pop()
  return out
}

export function flattenPath(path: DrawPath, tolerance = 0.25): Pt[][] {
  return path.subpaths.map((sp) => flattenSubpath(sp, tolerance)).filter((r) => r.length >= 2)
}

// ── SVG ──────────────────────────────────────────────────────────────────────

function num(n: number): string {
  // Three decimals is well under a device pixel and keeps serialized paths small.
  const r = Math.round(n * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

export function pathToSvgD(path: DrawPath): string {
  const parts: string[] = []
  for (const sp of path.subpaths) {
    if (sp.nodes.length === 0) continue
    const first = sp.nodes[0]
    parts.push(`M ${num(first.x)} ${num(first.y)}`)
    const segs = subpathSegments(sp)
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const straight = near(seg.p1, seg.p0) && near(seg.p2, seg.p3)
      // Z already draws a straight line home, so a closed path's final straight
      // segment is redundant — emitting it would duplicate the edge and leave a
      // visible join artefact under a thick stroke.
      if (straight && sp.closed && i === segs.length - 1) break
      if (straight) parts.push(`L ${num(seg.p3.x)} ${num(seg.p3.y)}`)
      else parts.push(`C ${num(seg.p1.x)} ${num(seg.p1.y)} ${num(seg.p2.x)} ${num(seg.p2.y)} ${num(seg.p3.x)} ${num(seg.p3.y)}`)
    }
    if (sp.closed) parts.push('Z')
  }
  return parts.join(' ')
}

// ── Bounds & transforms ──────────────────────────────────────────────────────

export function pathBounds(path: DrawPath, tolerance = 0.25): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of flattenPath(path, tolerance)) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  // A path with a single node still has a position; report a zero-size box there.
  if (!Number.isFinite(minX)) {
    const n = path.subpaths[0]?.nodes[0]
    if (n) return { x: n.x, y: n.y, w: 0, h: 0 }
    return { x: 0, y: 0, w: 0, h: 0 }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function unionBox(boxes: Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function applyMatrix(m: Matrix, p: Pt): Pt {
  return pt(m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5])
}

export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  // a ∘ b — apply b first, then a (SVG's own composition order).
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ]
}

export function transformPath(path: DrawPath, m: Matrix): DrawPath {
  const mapNode = (n: DrawNode): DrawNode => {
    const a = applyMatrix(m, pt(n.x, n.y))
    const out: DrawNode = { x: a.x, y: a.y }
    if (n.inX != null && n.inY != null) {
      const i = applyMatrix(m, pt(n.inX, n.inY))
      out.inX = i.x
      out.inY = i.y
    }
    if (n.outX != null && n.outY != null) {
      const o = applyMatrix(m, pt(n.outX, n.outY))
      out.outX = o.x
      out.outY = o.y
    }
    return out
  }
  return { ...path, subpaths: path.subpaths.map((sp) => ({ closed: sp.closed, nodes: sp.nodes.map(mapNode) })) }
}

export function translatePath(path: DrawPath, dx: number, dy: number): DrawPath {
  return transformPath(path, [1, 0, 0, 1, dx, dy])
}

/** Scale a path so its bounding box becomes `target`. A zero-extent axis is left alone. */
export function fitPathToBox(path: DrawPath, target: Box): DrawPath {
  const b = pathBounds(path)
  const sx = b.w > EPS ? target.w / b.w : 1
  const sy = b.h > EPS ? target.h / b.h : 1
  return transformPath(path, [sx, 0, 0, sy, target.x - b.x * sx, target.y - b.y * sy])
}

export function rotateAbout(cx: number, cy: number, degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos]
}

// ── Hit testing ──────────────────────────────────────────────────────────────

function near(a: Pt, b: Pt, eps = EPS): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < EPS) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Signed area — positive means counter-clockwise in a y-down coordinate system. */
export function polygonArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Crossing number for one ring, used by both fill rules. */
function windingContribution(ring: Pt[], p: Pt): number {
  let w = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    if (a.y <= p.y) {
      if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++
    } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) {
      w--
    }
  }
  return w
}

export function pointInRings(rings: Pt[][], p: Pt, rule: 'nonzero' | 'evenodd' = 'nonzero'): boolean {
  let total = 0
  for (const ring of rings) total += windingContribution(ring, p)
  return rule === 'evenodd' ? total % 2 !== 0 : total !== 0
}

export function pointInPath(path: DrawPath, p: Pt, tolerance = 0.25): boolean {
  return pointInRings(flattenPath(path, tolerance), p, path.fillRule ?? 'nonzero')
}

/** Distance from a point to the path's outline, for stroke hit-testing. */
export function distanceToPath(path: DrawPath, p: Pt, tolerance = 0.25): number {
  let best = Infinity
  for (const ring of flattenPath(path, tolerance)) {
    const n = ring.length
    const last = n // rings from flattenPath are implicitly closed
    for (let i = 0; i < last; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      best = Math.min(best, distToSegment(p, a, b))
    }
  }
  return best
}

/**
 * Does a click at `p` hit this path? A filled path counts anywhere inside it; an
 * unfilled one only within half its stroke width (plus a few px of slop so thin
 * strokes stay clickable).
 */
export function hitPath(path: DrawPath, p: Pt, opts: { filled: boolean; strokeWidth?: number; slop?: number } = { filled: true }): boolean {
  const slop = opts.slop ?? 4
  if (opts.filled && pointInPath(path, p)) return true
  const halfStroke = (opts.strokeWidth ?? 0) / 2
  return distanceToPath(path, p) <= halfStroke + slop
}

// ── Freehand fitting ─────────────────────────────────────────────────────────

/** Ramer–Douglas–Peucker: drop points that are already on the line they sit between. */
export function simplifyPolyline(points: Pt[], tolerance = 1): Pt[] {
  if (points.length <= 2) return points.slice()
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let maxD = -1
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i], points[s], points[e])
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

/**
 * Turn a simplified polyline into a smooth path by giving each node Catmull-Rom
 * handles. This is what the pencil tool produces: an editable bezier path, not a
 * frozen polyline, so every point can still be dragged afterwards.
 */
export function smoothPathFromPoints(points: Pt[], closed = false, smoothing = 0.22): DrawPath {
  const p = points
  if (p.length < 2) return emptyPath()
  const n = p.length
  const nodes: DrawNode[] = p.map((q) => node(q.x, q.y))
  for (let i = 0; i < n; i++) {
    const prev = p[i === 0 ? (closed ? n - 1 : 0) : i - 1]
    const next = p[i === n - 1 ? (closed ? 0 : n - 1) : i + 1]
    const tx = (next.x - prev.x) * smoothing
    const ty = (next.y - prev.y) * smoothing
    if (closed || i > 0) {
      nodes[i].inX = p[i].x - tx
      nodes[i].inY = p[i].y - ty
    }
    if (closed || i < n - 1) {
      nodes[i].outX = p[i].x + tx
      nodes[i].outY = p[i].y + ty
    }
  }
  return { subpaths: [{ closed, nodes }] }
}

// ── Boolean operations ───────────────────────────────────────────────────────

export type BooleanOp = 'union' | 'intersect' | 'subtract' | 'exclude'

interface Seg {
  a: Pt
  b: Pt
}

function key(p: Pt): string {
  return `${Math.round(p.x * KEY_Q)},${Math.round(p.y * KEY_Q)}`
}

/**
 * Where two segments cross. Returns the parameters along each; null when they
 * are parallel or only touch outside both spans. Endpoint touches DO count —
 * dropping them would leave a chain with no place to switch polygons.
 */
function segmentIntersection(a0: Pt, a1: Pt, b0: Pt, b1: Pt): { t: number; u: number } | null {
  const rx = a1.x - a0.x
  const ry = a1.y - a0.y
  const sx = b1.x - b0.x
  const sy = b1.y - b0.y
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-12) return null // parallel or collinear
  const qpx = b0.x - a0.x
  const qpy = b0.y - a0.y
  const t = (qpx * sy - qpy * sx) / denom
  const u = (qpx * ry - qpy * rx) / denom
  const lo = -1e-9
  const hi = 1 + 1e-9
  if (t < lo || t > hi || u < lo || u > hi) return null
  return { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) }
}

/** Split every edge of `rings` at each crossing with `others`, keeping direction. */
function splitRings(rings: Pt[][], others: Pt[][]): Seg[] {
  const out: Seg[] = []
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      const ts: number[] = [0, 1]
      for (const o of others) {
        const m = o.length
        for (let j = 0; j < m; j++) {
          const hit = segmentIntersection(a, b, o[j], o[(j + 1) % m])
          if (hit) ts.push(hit.t)
        }
      }
      ts.sort((x, y) => x - y)
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k]
        const t1 = ts[k + 1]
        if (t1 - t0 < 1e-9) continue
        const p0 = pt(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0)
        const p1 = pt(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1)
        if (!near(p0, p1, 1e-9)) out.push({ a: p0, b: p1 })
      }
    }
  }
  return out
}

type Side = 'in' | 'out' | 'on-same' | 'on-opposite'

/**
 * Where does this segment sit relative to the other shape? Classification is by
 * midpoint, which is exactly why the edges were split at every crossing first —
 * a split segment is wholly inside, wholly outside, or lying on the boundary.
 *
 * The on-boundary case is what makes booleans on hand-drawn shapes survive: two
 * shapes that share an edge (a duplicate, a snapped rectangle) would otherwise
 * produce a sliver or a hole. Coincident edges running the SAME way belong to
 * both shapes' outlines; edges running OPPOSITE ways cancel.
 */
function classify(seg: Seg, others: Pt[][], rule: 'nonzero' | 'evenodd', onTol: number): Side {
  const mid = pt((seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2)
  let bestD = Infinity
  let bestDir: Pt | null = null
  for (const ring of others) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      const d = distToSegment(mid, a, b)
      if (d < bestD) {
        bestD = d
        bestDir = pt(b.x - a.x, b.y - a.y)
      }
    }
  }
  if (bestD <= onTol && bestDir) {
    const dot = (seg.b.x - seg.a.x) * bestDir.x + (seg.b.y - seg.a.y) * bestDir.y
    return dot >= 0 ? 'on-same' : 'on-opposite'
  }
  return pointInRings(others, mid, rule) ? 'in' : 'out'
}

function reverseSeg(s: Seg): Seg {
  return { a: s.b, b: s.a }
}

/**
 * Chain directed segments head-to-tail into closed rings. Where several
 * segments leave the same vertex (the shapes touch at a point), the one that
 * turns most sharply to the left is taken, which is the standard rule for
 * walking the outer boundary of an arrangement without cutting a corner off.
 */
function chainSegments(segs: Seg[]): Pt[][] {
  const byStart = new Map<string, number[]>()
  segs.forEach((s, i) => {
    const k = key(s.a)
    const list = byStart.get(k)
    if (list) list.push(i)
    else byStart.set(k, [i])
  })
  const used = new Array<boolean>(segs.length).fill(false)
  const rings: Pt[][] = []

  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue
    const ring: Pt[] = []
    let cur = start
    const startKey = key(segs[start].a)
    let guard = 0
    while (!used[cur] && guard++ <= segs.length + 1) {
      used[cur] = true
      ring.push(segs[cur].a)
      const endKey = key(segs[cur].b)
      if (endKey === startKey) break
      const candidates = (byStart.get(endKey) ?? []).filter((i) => !used[i])
      if (candidates.length === 0) break
      cur = candidates.length === 1 ? candidates[0] : pickMostLeft(segs, cur, candidates)
    }
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

/** Of the segments leaving a shared vertex, the sharpest left turn. */
function pickMostLeft(segs: Seg[], from: number, candidates: number[]): number {
  const inDir = Math.atan2(segs[from].b.y - segs[from].a.y, segs[from].b.x - segs[from].a.x)
  let best = candidates[0]
  let bestTurn = -Infinity
  for (const c of candidates) {
    const outDir = Math.atan2(segs[c].b.y - segs[c].a.y, segs[c].b.x - segs[c].a.x)
    let turn = outDir - inDir
    while (turn <= -Math.PI) turn += 2 * Math.PI
    while (turn > Math.PI) turn -= 2 * Math.PI
    if (turn > bestTurn) {
      bestTurn = turn
      best = c
    }
  }
  return best
}

function ringsToPath(rings: Pt[][]): DrawPath {
  return {
    fillRule: 'evenodd',
    subpaths: rings.filter((r) => r.length >= 3).map((r) => ({ closed: true, nodes: r.map((p) => node(p.x, p.y)) }))
  }
}

/**
 * Union / intersect / subtract / exclude of two paths.
 *
 * Both paths are flattened to polygons first, so the result is a polygonal
 * approximation of the true curve boolean — the same trade-off every 2D editor
 * that isn't a CAD kernel makes. `tolerance` controls how close that
 * approximation is; the default is a quarter of a logical pixel, which is
 * invisible on screen and in print.
 */
export function booleanPath(a: DrawPath, b: DrawPath, op: BooleanOp, tolerance = 0.25): DrawPath {
  const ringsA = flattenPath(a, tolerance)
  const ringsB = flattenPath(b, tolerance)
  if (ringsA.length === 0) return op === 'intersect' ? emptyPath() : ringsToPath(ringsB)
  if (ringsB.length === 0) return op === 'intersect' ? emptyPath() : ringsToPath(ringsA)

  if (op === 'exclude') {
    // XOR is the two one-way differences, which are disjoint by construction, so
    // their subpaths can simply be concatenated.
    const ab = booleanPath(a, b, 'subtract', tolerance)
    const ba = booleanPath(b, a, 'subtract', tolerance)
    return { fillRule: 'evenodd', subpaths: [...ab.subpaths, ...ba.subpaths] }
  }

  const ruleA = a.fillRule ?? 'nonzero'
  const ruleB = b.fillRule ?? 'nonzero'
  // "On the boundary" has to be generous enough to absorb the flattening error
  // of two curves that are geometrically the same edge.
  const onTol = Math.max(tolerance * 2, 1e-4)

  const segsA = splitRings(ringsA, ringsB)
  const segsB = splitRings(ringsB, ringsA)
  const keep: Seg[] = []

  for (const s of segsA) {
    const side = classify(s, ringsB, ruleB, onTol)
    if (op === 'union' && (side === 'out' || side === 'on-same')) keep.push(s)
    else if (op === 'intersect' && (side === 'in' || side === 'on-same')) keep.push(s)
    else if (op === 'subtract' && (side === 'out' || side === 'on-opposite')) keep.push(s)
  }
  for (const s of segsB) {
    const side = classify(s, ringsA, ruleA, onTol)
    // Coincident edges are contributed by A alone, so they are never doubled.
    if (side === 'on-same' || side === 'on-opposite') continue
    if (op === 'union' && side === 'out') keep.push(s)
    else if (op === 'intersect' && side === 'in') keep.push(s)
    // A − B: the part of B's outline inside A becomes the hole's wall, walked
    // backwards so the hole winds opposite to the outer ring.
    else if (op === 'subtract' && side === 'in') keep.push(reverseSeg(s))
  }

  return ringsToPath(chainSegments(keep))
}
