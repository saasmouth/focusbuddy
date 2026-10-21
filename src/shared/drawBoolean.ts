// Pathfinder — boolean operations on vector paths.
//
// Unite, intersect, subtract and exclude are the operations every vector tool
// is expected to have, and the one thing you cannot build shapes without. The
// path model already anticipated them: DrawShapeKind's comment says a live
// shape drops to 'path' "once a boolean or a node edit changes the geometry".
//
// HONEST LIMIT, because it shows in the output. This works on FLATTENED
// geometry: curves are approximated by line segments at a tolerance before
// clipping, so the result of a boolean involving a curve is a polygon that
// follows that curve closely rather than a curve. Illustrator refits beziers
// afterwards; this does not, yet. At the default tolerance the deviation is
// well under a tenth of a pixel, so it looks right and prints right, but a
// node-edit of the result shows many nodes where a curve used to be. Straight
// -edged shapes are unaffected and come out exactly.
//
// The algorithm is split-and-classify rather than Greiner-Hormann or
// Martinez-Rueda:
//
//   1. Flatten both operands to rings of points.
//   2. Split every edge of each at its intersections with the other, so no
//      edge crosses the other outline any more.
//   3. Each resulting segment is therefore wholly inside or wholly outside
//      the other shape, which a single midpoint test settles.
//   4. Keep the segments the operation calls for, flipping direction where a
//      subtraction needs the clip's outline to run the other way.
//   5. Chain what is left back into closed rings.
//
// It is chosen for being verifiable: every step is a predicate that can be
// tested on its own, and the whole thing can be checked by AREA against
// shapes whose answer is known by arithmetic. Greiner-Hormann is shorter and
// silently wrong on shared vertices; Martinez-Rueda is better and much harder
// to be sure of.

import { flattenPath, pathFromPoints, type DrawPath, type Pt } from './drawGeometry'

export type BoolOp = 'unite' | 'intersect' | 'subtract' | 'exclude'

/** A closed ring of points; the final point joins back to the first. */
export type Ring = Pt[]

// Coordinates are snapped to this grid before clipping. Endpoint chaining
// compares points for equality, and two values that differ in the last bit of
// a float are the difference between a closed ring and a dropped edge.
const GRID = 1e-6
const EPS = 1e-9
// How far off a segment to sample when deciding which side is which. Large
// enough to clear the snapping grid, small enough that nothing else fits
// between the probe and the line.
const PROBE = 1e-4

const snap = (v: number): number => Math.round(v / GRID) * GRID
const same = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < GRID && Math.abs(a.y - b.y) < GRID
const keyOf = (p: Pt): string => `${snap(p.x)},${snap(p.y)}`

/** Twice the signed area; positive is counter-clockwise in SVG's y-down space. */
export function ringArea(r: Ring): number {
  let s = 0
  for (let i = 0; i < r.length; i++) {
    const a = r[i]
    const b = r[(i + 1) % r.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

/** Total unsigned area of a set of rings, holes subtracted. */
export function ringsArea(rings: Ring[]): number {
  return Math.abs(rings.reduce((t, r) => t + ringArea(r), 0))
}

/**
 * Even-odd containment: is the point inside an odd number of rings?
 *
 * Even-odd rather than winding because the operands come from arbitrary
 * artwork whose ring directions cannot be relied on — a hole drawn the same
 * way round as its outline is common, and a winding test would call it solid.
 */
export function pointInRings(p: Pt, rings: Ring[]): boolean {
  let inside = false
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]
      const b = r[(i + 1) % r.length]
      // Half-open on y so a vertex is counted once, not twice.
      if (a.y > p.y !== b.y > p.y) {
        const t = (p.y - a.y) / (b.y - a.y)
        if (p.x < a.x + t * (b.x - a.x)) inside = !inside
      }
    }
  }
  return inside
}

interface Hit {
  t: number
  p: Pt
}

/** Where segment a1->a2 crosses b1->b2, as a position along a. */
function crossings(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Hit | null {
  const rx = a2.x - a1.x
  const ry = a2.y - a1.y
  const sx = b2.x - b1.x
  const sy = b2.y - b1.y
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < EPS) return null // parallel or collinear
  const t = ((b1.x - a1.x) * sy - (b1.y - a1.y) * sx) / denom
  const u = ((b1.x - a1.x) * ry - (b1.y - a1.y) * rx) / denom
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null
  return { t, p: { x: a1.x + t * rx, y: a1.y + t * ry } }
}

/**
 * Where a segment sits relative to the other operand.
 *
 * 'on' is the case that every naive implementation gets wrong, and it is not
 * exotic: two rectangles sharing an edge, or a shape subtracted from a copy of
 * itself. A coincident edge lies on the other outline, so a midpoint
 * containment test is answering a question with no answer, and whichever way
 * it falls is luck. It has to be detected and decided per operation.
 *
 * 'onSame'     the two shapes lie on the SAME side of the shared edge
 *              (a shape against its own copy).
 * 'onOpposite' they lie on opposite sides (two tiles meeting at a seam).
 */
type SegClass = 'in' | 'out' | 'onSame' | 'onOpposite'

interface Seg {
  a: Pt
  b: Pt
  cls: SegClass
}

/** Split every edge of `rings` wherever it meets `against`, and classify. */
function splitAndClassify(rings: Ring[], against: Ring[]): Seg[] {
  const out: Seg[] = []
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]
      const b = r[(i + 1) % r.length]
      if (same(a, b)) continue
      const hits: Hit[] = []
      for (const o of against) {
        for (let j = 0; j < o.length; j++) {
          const h = crossings(a, b, o[j], o[(j + 1) % o.length])
          if (h && h.t > EPS && h.t < 1 - EPS) hits.push(h)
        }
      }
      hits.sort((p, q) => p.t - q.t)
      let cur = a
      for (const h of hits) {
        if (!same(cur, h.p)) out.push({ a: cur, b: h.p, cls: 'out' })
        cur = h.p
      }
      if (!same(cur, b)) out.push({ a: cur, b, cls: 'out' })
    }
  }
  // No segment crosses the other outline now, so sampling just off each side
  // of its midpoint settles it. Probing both sides rather than the midpoint
  // itself is what makes a coincident edge detectable at all: on such an edge
  // the midpoint is on BOTH outlines and tells you nothing.
  for (const s of out) {
    const mx = (s.a.x + s.b.x) / 2
    const my = (s.a.y + s.b.y) / 2
    const dx = s.b.x - s.a.x
    const dy = s.b.y - s.a.y
    const len = Math.hypot(dx, dy) || 1
    // A probe shorter than the snapping grid would land back on the line.
    const px = (-dy / len) * PROBE
    const py = (dx / len) * PROBE
    const plusB = pointInRings({ x: mx + px, y: my + py }, against)
    const minusB = pointInRings({ x: mx - px, y: my - py }, against)
    if (plusB === minusB) {
      s.cls = plusB ? 'in' : 'out'
      continue
    }
    // Straddles the other outline, so it IS the other outline here. Which way
    // round decides what each operation should do with it.
    const plusOwn = pointInRings({ x: mx + px, y: my + py }, rings)
    s.cls = plusOwn === plusB ? 'onSame' : 'onOpposite'
  }
  return out
}

/** Join segments end-to-end into closed rings. */
function chain(segs: Seg[]): Ring[] {
  const byStart = new Map<string, Seg[]>()
  for (const s of segs) {
    const k = keyOf(s.a)
    const list = byStart.get(k)
    if (list) list.push(s)
    else byStart.set(k, [s])
  }
  const used = new Set<Seg>()
  const rings: Ring[] = []

  for (const seed of segs) {
    if (used.has(seed)) continue
    const ring: Pt[] = [seed.a]
    let cur = seed
    used.add(cur)
    // Bounded: a ring cannot be longer than the segment list, and without the
    // guard a malformed adjacency map would spin forever inside a render.
    for (let guard = segs.length + 1; guard > 0; guard--) {
      ring.push(cur.b)
      if (same(cur.b, seed.a)) break
      const next = (byStart.get(keyOf(cur.b)) ?? []).find((s) => !used.has(s))
      if (!next) break
      used.add(next)
      cur = next
    }
    // Drop open chains and slivers: a ring needs three distinct corners, and
    // a zero-area loop is a numerical artefact rather than a shape.
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) {
      ring.pop()
      if (ring.length >= 3 && Math.abs(ringArea(ring)) > GRID) rings.push(ring)
    }
  }
  return rings
}

const reversed = (s: Seg): Seg => ({ a: s.b, b: s.a, cls: s.cls })

/** Boolean on rings. Both inputs are even-odd ring sets. */
export function polygonBoolean(a: Ring[], b: Ring[], op: BoolOp): Ring[] {
  if (!a.length) return op === 'intersect' ? [] : op === 'subtract' ? [] : b.map((r) => [...r])
  if (!b.length) return op === 'intersect' ? [] : a.map((r) => [...r])

  const sa = splitAndClassify(a, b)
  const sb = splitAndClassify(b, a)

  // Coincident edges are taken from A only, never both, or the shared run is
  // chained twice and the ring closes on itself.
  switch (op) {
    case 'unite':
      // A seam between two touching tiles is interior to the union, so an
      // opposite-facing coincidence is dropped; a shape united with its own
      // copy keeps one of each shared edge.
      return chain([
        ...sa.filter((s) => s.cls === 'out' || s.cls === 'onSame'),
        ...sb.filter((s) => s.cls === 'out')
      ])
    case 'intersect':
      return chain([
        ...sa.filter((s) => s.cls === 'in' || s.cls === 'onSame'),
        ...sb.filter((s) => s.cls === 'in')
      ])
    case 'subtract':
      // A's outside, plus B's inside running backwards so a hole's outline
      // opposes the shell it sits in. A shared edge survives only where the
      // shapes face apart: subtracting a shape from its own copy must leave
      // nothing, while a neighbour sharing a seam takes nothing away.
      return chain([
        ...sa.filter((s) => s.cls === 'out' || s.cls === 'onOpposite'),
        ...sb.filter((s) => s.cls === 'in').map(reversed)
      ])
    case 'exclude':
      // Built from two subtractions rather than chained directly. Throwing
      // every segment at the chainer does not work: at each crossing FOUR
      // ends now meet, two from each shape, and picking a continuation by
      // endpoint alone pairs them arbitrarily — the rings close, the areas
      // are wrong, and nothing looks obviously broken. (A−B) ∪ (B−A) is the
      // same region, reuses a path already proved by area, and the two parts
      // are disjoint so their rings simply concatenate under even-odd.
      return [...polygonBoolean(a, b, 'subtract'), ...polygonBoolean(b, a, 'subtract')]
    default:
      return []
  }
}

/**
 * Boolean on two paths.
 *
 * The result always carries fillRule 'evenodd': a subtraction produces a shell
 * and a hole as two separate rings, and under 'nonzero' whether the hole reads
 * as a hole depends on the direction it happens to have been chained in.
 * Even-odd makes it a property of the geometry rather than of the walk.
 */
export function booleanPath(a: DrawPath, b: DrawPath, op: BoolOp, tolerance = 0.25): DrawPath {
  const ra = flattenPath(a, tolerance).filter((r) => r.length >= 3)
  const rb = flattenPath(b, tolerance).filter((r) => r.length >= 3)
  const rings = polygonBoolean(ra, rb, op)
  if (!rings.length) return { subpaths: [], fillRule: 'evenodd' }
  const out = rings.map((r) => pathFromPoints(r, true).subpaths[0])
  return { subpaths: out, fillRule: 'evenodd' }
}

/** Fold a boolean across several paths, left to right. */
export function booleanPaths(paths: DrawPath[], op: BoolOp, tolerance = 0.25): DrawPath {
  if (!paths.length) return { subpaths: [], fillRule: 'evenodd' }
  return paths.slice(1).reduce((acc, p) => booleanPath(acc, p, op, tolerance), paths[0])
}
