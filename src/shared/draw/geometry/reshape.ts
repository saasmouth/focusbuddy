// The Reshape tool's geometry: find the nearest point on a path, add an anchor
// there without changing the shape (de Casteljau split), and drag a set of
// FOCUS anchors so the rest of the path follows proportionally -- the focus
// points move the whole way, the anchors farthest from them stay put, and
// everything in between moves in proportion to how close it is.

import { cubicAt, subpathSegments, type DrawNode, type DrawPath, type Pt } from '../../drawGeometry'

export interface PathHit {
  /** Subpath index. */
  si: number
  /** Index of the segment's first anchor (the segment runs to the next one, wrapping on a closed subpath). */
  seg: number
  t: number
  point: Pt
  dist: number
}

/** The point on `path` nearest `p` (sampled, then refined), or null for an empty path. */
export function nearestOnPath(path: DrawPath, p: Pt): PathHit | null {
  let best: PathHit | null = null
  path.subpaths.forEach((sp, si) => {
    subpathSegments(sp).forEach((c, seg) => {
      const N = 48
      let bt = 0
      let bd = Infinity
      for (let i = 0; i <= N; i++) {
        const t = i / N
        const q = cubicAt(c, t)
        const d = Math.hypot(q.x - p.x, q.y - p.y)
        if (d < bd) {
          bd = d
          bt = t
        }
      }
      // Refine by halving steps around the best sample.
      let step = 1 / N
      for (let k = 0; k < 20; k++) {
        step /= 2
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue
          const q = cubicAt(c, t)
          const d = Math.hypot(q.x - p.x, q.y - p.y)
          if (d < bd) {
            bd = d
            bt = t
          }
        }
      }
      if (!best || bd < best.dist) best = { si, seg, t: bt, point: cubicAt(c, bt), dist: bd }
    })
  })
  return best
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/**
 * Add an anchor at parameter `t` of segment `seg` of subpath `si`. The outline
 * is unchanged: a curved segment is split into two exact halves; a straight
 * one gets a plain corner anchor. Returns the new path and the new anchor's index.
 */
export function insertAnchor(path: DrawPath, si: number, seg: number, t: number): { path: DrawPath; ni: number } {
  const sp = path.subpaths[si]
  const n = sp.nodes.length
  const ai = seg
  const bi = (seg + 1) % n
  const a = sp.nodes[ai]
  const b = sp.nodes[bi]
  const straight = a.outX == null && b.inX == null
  const nodes = sp.nodes.slice()
  let mid: DrawNode
  if (straight) {
    const q = lerp(a, b, t)
    mid = { x: q.x, y: q.y }
  } else {
    const p0 = { x: a.x, y: a.y }
    const p1 = { x: a.outX ?? a.x, y: a.outY ?? a.y }
    const p2 = { x: b.inX ?? b.x, y: b.inY ?? b.y }
    const p3 = { x: b.x, y: b.y }
    const q0 = lerp(p0, p1, t)
    const q1 = lerp(p1, p2, t)
    const q2 = lerp(p2, p3, t)
    const r0 = lerp(q0, q1, t)
    const r1 = lerp(q1, q2, t)
    const s = lerp(r0, r1, t)
    mid = { x: s.x, y: s.y, inX: r0.x, inY: r0.y, outX: r1.x, outY: r1.y }
    nodes[ai] = { ...a, outX: q0.x, outY: q0.y }
    nodes[bi] = { ...b, inX: q2.x, inY: q2.y }
  }
  nodes.splice(ai + 1, 0, mid)
  return { path: { ...path, subpaths: path.subpaths.map((x, i) => (i === si ? { ...x, nodes } : x)) }, ni: ai + 1 }
}

export type AnchorRef = readonly [si: number, ni: number]

/**
 * How far each anchor moves when the focus anchors move the whole way: 1 at a
 * focus anchor, 0 at the anchor farthest from every focus anchor, and in
 * proportion to distance in between.
 */
export function reshapeWeights(path: DrawPath, focus: AnchorRef[]): number[][] {
  const fpts = focus.map(([si, ni]) => path.subpaths[si]?.nodes[ni]).filter((n): n is DrawNode => !!n)
  const isFocus = (si: number, ni: number): boolean => focus.some(([a, b]) => a === si && b === ni)
  const dist = path.subpaths.map((sp, si) => sp.nodes.map((n, ni) => (isFocus(si, ni) ? 0 : Math.min(...fpts.map((f) => Math.hypot(n.x - f.x, n.y - f.y))))))
  const far = Math.max(0, ...dist.flat().filter(Number.isFinite))
  return dist.map((row) => row.map((d) => (!fpts.length ? 0 : far > 1e-9 ? 1 - d / far : 1)))
}

/** Move the focus anchors by (dx, dy) and the rest of the path proportionally. */
export function reshapePath(path: DrawPath, focus: AnchorRef[], dx: number, dy: number): DrawPath {
  const w = reshapeWeights(path, focus)
  return {
    ...path,
    subpaths: path.subpaths.map((sp, si) => ({
      ...sp,
      nodes: sp.nodes.map((n, ni) => {
        const k = w[si][ni]
        if (k <= 0) return n
        const mx = dx * k
        const my = dy * k
        return {
          x: n.x + mx,
          y: n.y + my,
          ...(n.inX != null ? { inX: n.inX + mx, inY: (n.inY ?? n.y) + my } : {}),
          ...(n.outX != null ? { outX: n.outX + mx, outY: (n.outY ?? n.y) + my } : {})
        }
      })
    }))
  }
}
