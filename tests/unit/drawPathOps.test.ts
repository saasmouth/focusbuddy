// WP-PATH: the pure geometry under anchor editing (de Casteljau splitting,
// nearest point, roots and intersections, Schneider fitting, simplify) and the
// document operations built on it (add/delete/convert anchors, scissors, join,
// average, knife, path eraser, smooth, corner rounding).
//
// Randomised checks use a fixed-seed generator, so a failure always replays.

import { describe, it, expect } from 'vitest'
import { flattenSubpath, polygonArea, type DrawPath, type DrawSubpath, type Pt } from '../../src/shared/drawGeometry'
import {
  cubicLength,
  derivativeAt,
  dist,
  intersectLineCubic,
  isStraight,
  maxDeviation,
  nearestOnCubic,
  nearestOnPath,
  pointAt,
  segmentOf,
  solveCubic,
  solveQuadratic,
  splitCubicAt,
  subCubic,
  tAtLength,
  type Cubic
} from '../../src/shared/draw/geometry/bezier'
import { anchorAngle, curvatureNodes, fitCubics, fitSingleCubic, simplifySubpath, simplifyTolerance, smoothRun } from '../../src/shared/draw/geometry/fit'
import {
  cutSubpath,
  deleteAnchorsBreaking,
  dragHandle,
  eraseSubpath,
  extractRange,
  insertAnchor,
  isSmoothNode,
  joinEnds,
  knifePath,
  removeAnchors,
  reshapeCubic,
  roundCorners,
  toCorner,
  toSmooth
} from '../../src/shared/draw/geometry/pathEdit'
import {
  addAnchor,
  addMidpointAnchors,
  alignAnchors,
  allAnchorsOf,
  averageAnchors,
  convertAnchors,
  cutAtAnchors,
  cutPathAt,
  deleteAnchorsBreak,
  dragSegment,
  erasePaths,
  extendSubpath,
  joinEndpoints,
  joinPathsByEnds,
  knifeCut,
  moveAnchors,
  moveHandle,
  removeAnchorsJoined,
  roundAnchorCorners,
  simplifyPaths,
  smoothPaths
} from '../../src/shared/draw/ops/path'
import type { DrawDoc, DrawPathNode } from '../../src/shared/draw/model'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import { vectorLayersOf } from '../../src/shared/draw/tree'

// ── Helpers ──────────────────────────────────────────────────────────────────

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomCubic(r: () => number, size = 200): Cubic {
  const p = (): Pt => ({ x: r() * size, y: r() * size })
  return { p0: p(), p1: p(), p2: p(), p3: p() }
}

const sp = (closed: boolean, ...pts: Array<[number, number]>): DrawSubpath => ({ closed, nodes: pts.map(([x, y]) => ({ x, y })) })

function area(path: DrawPath): number {
  return path.subpaths.reduce((s, x) => s + polygonArea(flattenSubpath(x, 0.05)), 0)
}

function absArea(path: DrawPath): number {
  return Math.abs(area(path))
}

/** Max distance from samples of `a` to `b`, both ways. */
function hausdorff(a: DrawPath, b: DrawPath): number {
  return Math.max(maxDeviation(a, b), maxDeviation(b, a))
}

function doc(objects: unknown[], extra: Record<string, unknown> = {}): DrawDoc {
  return normalizeDrawDoc({
    schemaVersion: 1,
    width: 400,
    height: 300,
    background: { type: 'solid', color: '#ffffff' },
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    ...extra
  })
}

function pathObj(id: string, subpaths: DrawSubpath[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'path', path: { subpaths }, fill: { type: 'solid', color: '#6d5dfc' }, stroke: { paint: { type: 'solid', color: '#000000' }, width: 2 }, ...extra }
}

function objs(d: DrawDoc): DrawPathNode[] {
  return vectorLayersOf(d).flatMap((l) => l.objects) as DrawPathNode[]
}

function obj(d: DrawDoc, id: string): DrawPathNode {
  return objs(d).find((o) => o.id === id)!
}

const CIRCLE: DrawSubpath = (() => {
  // A circle of radius 50 at (100, 100), four cubic arcs.
  const k = 0.5522847498 * 50
  return {
    closed: true,
    nodes: [
      { x: 150, y: 100, inX: 150, inY: 100 - k, outX: 150, outY: 100 + k },
      { x: 100, y: 150, inX: 100 + k, inY: 150, outX: 100 - k, outY: 150 },
      { x: 50, y: 100, inX: 50, inY: 100 + k, outX: 50, outY: 100 - k },
      { x: 100, y: 50, inX: 100 - k, inY: 50, outX: 100 + k, outY: 50 }
    ]
  }
})()

// ── Bezier core ──────────────────────────────────────────────────────────────

describe('de Casteljau splitting', () => {
  it('the two halves trace exactly the original curve (randomised)', () => {
    const r = rng(1)
    for (let i = 0; i < 200; i++) {
      const c = randomCubic(r)
      const t = 0.05 + r() * 0.9
      const [a, b] = splitCubicAt(c, t)
      for (let k = 0; k <= 10; k++) {
        const u = k / 10
        expect(dist(pointAt(a, u), pointAt(c, t * u))).toBeLessThan(1e-9)
        expect(dist(pointAt(b, u), pointAt(c, t + (1 - t) * u))).toBeLessThan(1e-9)
      }
      expect(a.p3).toEqual(b.p0)
    }
  })

  it('subCubic extracts [t0, t1]', () => {
    const r = rng(2)
    for (let i = 0; i < 100; i++) {
      const c = randomCubic(r)
      const t0 = r() * 0.5
      const t1 = 0.5 + r() * 0.5
      const s = subCubic(c, t0, t1)
      for (let k = 0; k <= 8; k++) expect(dist(pointAt(s, k / 8), pointAt(c, t0 + ((t1 - t0) * k) / 8))).toBeLessThan(1e-8)
    }
  })

  it('arc length matches a dense polyline, and tAtLength inverts it', () => {
    const r = rng(3)
    for (let i = 0; i < 50; i++) {
      const c = randomCubic(r)
      let poly = 0
      let prev = c.p0
      for (let k = 1; k <= 4000; k++) {
        const p = pointAt(c, k / 4000)
        poly += dist(prev, p)
        prev = p
      }
      const L = cubicLength(c)
      expect(Math.abs(L - poly)).toBeLessThan(0.05 + poly * 1e-4)
      const t = tAtLength(c, L / 3)
      expect(Math.abs(cubicLength(subCubic(c, 0, t)) - L / 3)).toBeLessThan(0.05)
    }
  })

  it('straightness: a line with handles on the chord is straight; a bent one is not', () => {
    expect(isStraight({ p0: { x: 0, y: 0 }, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 }, p3: { x: 10, y: 0 } })).toBe(true)
    expect(isStraight({ p0: { x: 0, y: 0 }, p1: { x: 3, y: 0 }, p2: { x: 7, y: 0 }, p3: { x: 10, y: 0 } })).toBe(true)
    expect(isStraight({ p0: { x: 0, y: 0 }, p1: { x: 3, y: 1 }, p2: { x: 7, y: 0 }, p3: { x: 10, y: 0 } })).toBe(false)
    // A handle overshooting the chord is a loop back, not a line.
    expect(isStraight({ p0: { x: 0, y: 0 }, p1: { x: 20, y: 0 }, p2: { x: 7, y: 0 }, p3: { x: 10, y: 0 } })).toBe(false)
  })
})

describe('nearest point on a bezier', () => {
  it('agrees with a brute-force dense scan (randomised)', () => {
    const r = rng(4)
    for (let i = 0; i < 300; i++) {
      const c = randomCubic(r)
      const p = { x: r() * 260 - 30, y: r() * 260 - 30 }
      let brute = Infinity
      for (let k = 0; k <= 5000; k++) brute = Math.min(brute, dist(pointAt(c, k / 5000), p))
      const h = nearestOnCubic(c, p)
      expect(h.dist).toBeLessThanOrEqual(brute + 1e-6)
      expect(Math.abs(h.dist - brute)).toBeLessThan(0.05)
      expect(dist(h.point, pointAt(c, h.t))).toBeLessThan(1e-9)
    }
  })

  it('at the true minimum the offset is perpendicular to the curve (interior hits)', () => {
    const r = rng(5)
    let checked = 0
    for (let i = 0; i < 200; i++) {
      const c = randomCubic(r)
      const p = { x: r() * 200, y: r() * 200 }
      const h = nearestOnCubic(c, p)
      if (h.t < 1e-3 || h.t > 1 - 1e-3 || h.dist < 1e-3) continue
      const d = derivativeAt(c, h.t)
      const off = { x: h.point.x - p.x, y: h.point.y - p.y }
      const cos = (d.x * off.x + d.y * off.y) / (Math.hypot(d.x, d.y) * Math.hypot(off.x, off.y))
      expect(Math.abs(cos)).toBeLessThan(1e-3)
      checked++
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('nearestOnPath names the subpath and segment', () => {
    const path: DrawPath = { subpaths: [sp(true, [0, 0], [100, 0], [100, 100], [0, 100])] }
    const h = nearestOnPath(path, { x: 103, y: 50 })!
    expect(h).toMatchObject({ si: 0, seg: 1 })
    expect(h.t).toBeCloseTo(0.5, 6)
    expect(h.dist).toBeCloseTo(3, 6)
  })
})

describe('roots and intersections', () => {
  it('solveCubic finds every real root of random cubics with known roots', () => {
    const r = rng(6)
    for (let i = 0; i < 300; i++) {
      const roots = [r() * 4 - 2, r() * 4 - 2, r() * 4 - 2]
      const k = 0.5 + r() * 3
      // k (t - r1)(t - r2)(t - r3)
      const [a, b, c] = roots
      const got = solveCubic(k, -k * (a + b + c), k * (a * b + b * c + a * c), -k * a * b * c)
      for (const want of roots) expect(Math.min(...got.map((g) => Math.abs(g - want)))).toBeLessThan(1e-4)
    }
    expect(solveQuadratic(1, -3, 2).sort()).toEqual([1, 2])
    expect(solveQuadratic(0, 2, -4)).toEqual([2])
    expect(solveQuadratic(1, 0, 1)).toEqual([])
  })

  it('line/cubic crossings lie on both, and match a polyline count (randomised)', () => {
    const r = rng(7)
    for (let i = 0; i < 200; i++) {
      const c = randomCubic(r)
      const a = { x: r() * 200, y: -20 }
      const b = { x: r() * 200, y: 220 }
      const hits = intersectLineCubic(c, a, b)
      for (const h of hits) {
        expect(dist(pointAt(c, h.t), h.point)).toBeLessThan(1e-6)
        const onLine = { x: a.x + (b.x - a.x) * h.u, y: a.y + (b.y - a.y) * h.u }
        expect(dist(onLine, h.point)).toBeLessThan(1e-5)
      }
      // Count sign changes of the signed distance along a dense sampling.
      const sd = (p: Pt): number => (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)
      let changes = 0
      let prev = sd(pointAt(c, 0))
      for (let k = 1; k <= 2000; k++) {
        const cur = sd(pointAt(c, k / 2000))
        if (Math.sign(cur) !== Math.sign(prev) && cur !== 0) changes++
        prev = cur
      }
      expect(hits.length).toBe(changes)
    }
  })
})

// ── Fitting ──────────────────────────────────────────────────────────────────

describe('Schneider fitting', () => {
  it('every sample lies within the requested error of the fitted chain (randomised)', () => {
    const r = rng(8)
    for (let i = 0; i < 40; i++) {
      // A wobbly random curve: a sum of sines.
      const pts: Pt[] = []
      const a1 = r() * 40
      const a2 = r() * 15
      for (let k = 0; k <= 120; k++) pts.push({ x: k * 3, y: 100 + a1 * Math.sin(k / 12) + a2 * Math.sin(k / 4 + r() * 0.01) })
      const err = 0.5 + r() * 2
      const cubics = fitCubics(pts, err)
      expect(cubics.length).toBeGreaterThan(0)
      const path: DrawPath = { subpaths: [{ closed: false, nodes: cubics.flatMap((c, j) => (j === 0 ? [{ x: c.p0.x, y: c.p0.y, outX: c.p1.x, outY: c.p1.y }] : [])).concat([]) }] }
      void path
      for (const p of pts) {
        const best = Math.min(...cubics.map((c) => nearestOnCubic(c, p).dist))
        expect(best).toBeLessThanOrEqual(err * 1.05)
      }
      // Consecutive cubics are joined.
      for (let j = 1; j < cubics.length; j++) expect(dist(cubics[j - 1].p3, cubics[j].p0)).toBeLessThan(1e-9)
    }
  })

  it('a single-cubic fit recovers a cubic from its own samples and tangents', () => {
    const r = rng(9)
    for (let i = 0; i < 50; i++) {
      const c = randomCubic(r)
      const pts = Array.from({ length: 40 }, (_, k) => pointAt(c, k / 39))
      const t1 = derivativeAt(c, 0)
      const t2 = derivativeAt(c, 1)
      const n1 = Math.hypot(t1.x, t1.y)
      const n2 = Math.hypot(t2.x, t2.y)
      if (n1 < 1 || n2 < 1) continue
      const tan1 = { x: t1.x / n1, y: t1.y / n1 }
      const tan2 = { x: -t2.x / n2, y: -t2.y / n2 }
      // With the true parameters the least-squares solve is exact.
      const exact = fitSingleCubic(pts, tan1, tan2, pts.map((_, k) => k / 39))
      expect(dist(exact.p1, c.p1)).toBeLessThan(1e-6)
      expect(dist(exact.p2, c.p2)).toBeLessThan(1e-6)
      // (Without them -- chord-length guesses -- a looping cubic is beyond one
      // segment's reach; fitCubics then splits, which the test above covers.)
    }
  })

  it('the curvature spline passes through every point and is smooth at smooth points', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 0, corner: true },
      { x: 150, y: 40 },
      { x: 200, y: 0 }
    ]
    const nodes = curvatureNodes(pts, false)
    expect(nodes.map((n) => [n.x, n.y])).toEqual(pts.map((p) => [p.x, p.y]))
    expect(isSmoothNode(nodes[1])).toBe(true)
    expect(nodes[2].inX).toBeUndefined()
    expect(nodes[2].outX).toBeUndefined()
    expect(nodes[0].outX).toBeDefined() // the first segment bends into the curve
    expect(nodes[0].inX).toBeUndefined()
  })
})

describe('simplify', () => {
  it('reduces a densely sampled curve to a few anchors within the tolerance', () => {
    const nodes = Array.from({ length: 120 }, (_, k) => ({ x: k * 2, y: 100 + 40 * Math.sin(k / 15) }))
    const src: DrawSubpath = { closed: false, nodes }
    const tol = 0.5
    const out = simplifySubpath(src, tol, 135, false)
    expect(out.nodes.length).toBeLessThan(20)
    expect(out.nodes[0]).toMatchObject({ x: 0, y: 100 })
    expect(out.nodes[out.nodes.length - 1]).toMatchObject({ x: nodes[119].x, y: nodes[119].y })
    expect(maxDeviation({ subpaths: [src] }, { subpaths: [out] })).toBeLessThan(tol * 2)
  })

  it('keeps a rectangle\'s sharp corners as they are', () => {
    const rectSp = sp(true, [0, 0], [100, 0], [100, 60], [0, 60])
    const out = simplifySubpath(rectSp, 1, 135, false)
    expect(hausdorff({ subpaths: [rectSp] }, { subpaths: [out] })).toBeLessThan(1e-6)
    for (const c of [
      [0, 0],
      [100, 0],
      [100, 60],
      [0, 60]
    ])
      expect(out.nodes.some((n) => n.x === c[0] && n.y === c[1] && n.inX == null && n.outX == null)).toBe(true)
  })

  it('a low angle threshold lets corners smooth out; straight-lines mode has no handles', () => {
    const zig = sp(false, ...Array.from({ length: 30 }, (_, k): [number, number] => [k * 10, k % 2 ? 6 : 0]))
    const smooth = simplifySubpath(zig, 4, 0, false)
    expect(smooth.nodes.length).toBeLessThan(zig.nodes.length)
    const straight = simplifySubpath({ closed: false, nodes: Array.from({ length: 60 }, (_, k) => ({ x: k * 4, y: 50 * Math.sin(k / 10) })) }, 1, 135, true)
    expect(straight.nodes.every((n) => n.inX == null && n.outX == null)).toBe(true)
    expect(straight.nodes.length).toBeLessThan(60)
  })

  it('a smooth closed curve stays smooth and closed', () => {
    const dense = { closed: true, nodes: Array.from({ length: 72 }, (_, k) => ({ x: 100 + 50 * Math.cos((k * Math.PI) / 36), y: 100 + 50 * Math.sin((k * Math.PI) / 36) })) }
    const out = simplifySubpath(dense, simplifyTolerance(50, 141), 135, false)
    expect(out.closed).toBe(true)
    expect(out.nodes.length).toBeLessThan(12)
    expect(maxDeviation({ subpaths: [dense] }, { subpaths: [out] })).toBeLessThan(1.5)
  })

  it('precision 100 is tighter than precision 0', () => {
    expect(simplifyTolerance(100, 200)).toBeLessThan(simplifyTolerance(50, 200))
    expect(simplifyTolerance(50, 200)).toBeLessThan(simplifyTolerance(0, 200))
  })

  it('anchorAngle: 90 at a square corner, 180 at a smooth point and at open ends', () => {
    expect(anchorAngle(sp(true, [0, 0], [100, 0], [100, 100]), 1)).toBeCloseTo(90, 6)
    expect(anchorAngle(CIRCLE, 0)).toBeCloseTo(180, 6)
    expect(anchorAngle(sp(false, [0, 0], [10, 0]), 0)).toBe(180)
  })
})

// ── Anchor editing on subpaths ───────────────────────────────────────────────

describe('add and delete anchors', () => {
  it('adding an anchor at t leaves the shape unchanged (sampled distance < 0.01, randomised)', () => {
    const r = rng(10)
    for (let i = 0; i < 100; i++) {
      const c = randomCubic(r)
      const src: DrawSubpath = { closed: false, nodes: [{ x: c.p0.x, y: c.p0.y, outX: c.p1.x, outY: c.p1.y }, { x: c.p3.x, y: c.p3.y, inX: c.p2.x, inY: c.p2.y }] }
      const t = 0.05 + r() * 0.9
      const { sp: out, ni } = insertAnchor(src, 0, t)
      expect(ni).toBe(1)
      expect(out.nodes).toHaveLength(3)
      expect(dist(out.nodes[1], pointAt(c, t))).toBeLessThan(1e-9)
      expect(hausdorff({ subpaths: [src] }, { subpaths: [out] })).toBeLessThan(0.01)
    }
  })

  it('adding on a straight segment adds a corner with no handles; on a closed loop it wraps', () => {
    const sq = sp(true, [0, 0], [100, 0], [100, 100], [0, 100])
    const { sp: out, ni } = insertAnchor(sq, 3, 0.5)
    expect(ni).toBe(4)
    expect(out.nodes[4]).toEqual({ x: 0, y: 50 })
    const circ = insertAnchor(CIRCLE, 3, 0.25).sp
    expect(hausdorff({ subpaths: [CIRCLE] }, { subpaths: [circ] })).toBeLessThan(0.01)
  })

  it('deleting the anchor just added re-fits the segment to within tolerance', () => {
    const r = rng(11)
    for (let i = 0; i < 60; i++) {
      // Random smooth-ish open curve with 3 anchors.
      const c = randomCubic(r)
      const src: DrawSubpath = { closed: false, nodes: [{ x: c.p0.x, y: c.p0.y, outX: c.p1.x, outY: c.p1.y }, { x: c.p3.x, y: c.p3.y, inX: c.p2.x, inY: c.p2.y }] }
      const added = insertAnchor(src, 0, 0.3 + r() * 0.4).sp
      const back = removeAnchors(added, [1])!
      expect(back.nodes).toHaveLength(2)
      // One cubic carries the whole curve again: within 1% of its size.
      const size = Math.max(dist(c.p0, c.p3), 1)
      expect(hausdorff({ subpaths: [src] }, { subpaths: [back] })).toBeLessThan(0.02 * size + 0.5)
    }
  })

  it('deleting a corner of a polygon joins its neighbours with a straight line', () => {
    const sq = sp(true, [0, 0], [100, 0], [100, 100], [0, 100])
    const tri = removeAnchors(sq, [2])!
    expect(tri.nodes).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }])
    expect(tri.closed).toBe(true)
    expect(removeAnchors(sp(false, [0, 0], [10, 0]), [0])).toBeNull()
    // An open end just goes.
    expect(removeAnchors(sp(false, [0, 0], [10, 0], [20, 5]), [0])!.nodes).toEqual([{ x: 10, y: 0 }, { x: 20, y: 5 }])
  })

  it('Delete-key removal breaks the path around the anchors', () => {
    expect(deleteAnchorsBreaking(sp(false, [0, 0], [10, 0], [20, 0], [30, 0], [40, 0]), [2]).map((x) => x.nodes.length)).toEqual([2, 2])
    const opened = deleteAnchorsBreaking(sp(true, [0, 0], [10, 0], [10, 10], [0, 10]), [0])
    expect(opened).toHaveLength(1)
    expect(opened[0]).toEqual(sp(false, [10, 0], [10, 10], [0, 10]))
    expect(deleteAnchorsBreaking(sp(false, [0, 0], [10, 0], [20, 0]), [1])).toEqual([]) // lone points go too
  })
})

describe('convert and handles', () => {
  it('corner retracts; smooth pulls handles out along the neighbours\' chord', () => {
    expect(toCorner(CIRCLE, 0)).toEqual({ x: 150, y: 100 })
    const tri = sp(true, [0, 0], [100, 0], [50, 80])
    const s = toSmooth(tri, 1)
    expect(isSmoothNode(s)).toBe(true)
    expect(s.x).toBe(100)
    // Already smooth stays exactly.
    expect(toSmooth(CIRCLE, 0)).toBe(CIRCLE.nodes[0])
  })

  it('a smooth handle drag keeps the partner opposite at its own length; mirror copies it; free leaves it', () => {
    const n = { x: 0, y: 0, inX: -10, inY: 0, outX: 30, outY: 0 }
    const sm = dragHandle(n, 'out', { x: 0, y: 40 }, 'smooth')
    expect(sm.outY).toBe(40)
    expect(sm.inX).toBeCloseTo(0, 9)
    expect(sm.inY).toBeCloseTo(-10, 9)
    const mi = dragHandle(n, 'out', { x: 0, y: 40 }, 'mirror')
    expect(mi.inX).toBeCloseTo(0, 9)
    expect(mi.inY).toBe(-40)
    expect(dragHandle(n, 'out', { x: 0, y: 40 }, 'free')).toMatchObject({ inX: -10, inY: 0 })
  })

  it('reshaping a segment makes it pass through the dragged point at the same t', () => {
    const r = rng(12)
    for (let i = 0; i < 100; i++) {
      const c = randomCubic(r)
      const t = 0.1 + r() * 0.8
      const target = { x: r() * 200, y: r() * 200 }
      const out = reshapeCubic(c, t, target)
      expect(dist(pointAt(out, t), target)).toBeLessThan(1e-8)
      expect(out.p0).toBe(c.p0)
      expect(out.p3).toBe(c.p3)
    }
  })
})

describe('cut, join, average', () => {
  it('scissors split an open path into two; a closed path cut once opens there', () => {
    const line = sp(false, [0, 0], [100, 0])
    // t is the cubic's own parameter (what the nearest-point search reports).
    const at = pointAt(segmentOf(line, 0), 0.25)
    const [a, b] = cutSubpath(line, [{ seg: 0, t: 0.25 }])
    expect(a.nodes).toEqual([{ x: 0, y: 0 }, at])
    expect(b.nodes).toEqual([at, { x: 100, y: 0 }])
    const opened = cutSubpath(CIRCLE, [{ seg: 1, t: 0.5 }])
    expect(opened).toHaveLength(1)
    expect(opened[0].closed).toBe(false)
    expect(hausdorff({ subpaths: [CIRCLE] }, { subpaths: opened })).toBeLessThan(0.01)
    const twice = cutSubpath(CIRCLE, [{ seg: 0, t: 0.5 }, { seg: 2, t: 0.5 }])
    expect(twice).toHaveLength(2)
    const total = twice.reduce((s, x) => s + segLen(x), 0)
    expect(Math.abs(total - segLen(CIRCLE))).toBeLessThan(0.05)
    // Cutting at an open end does nothing.
    expect(cutSubpath(line, [{ seg: 0, t: 0 }])).toEqual([line])
  })

  it('extractRange keeps interior anchors exactly', () => {
    const z = sp(false, [0, 0], [10, 10], [20, 0], [30, 10])
    const piece = extractRange(z, 0.5, 2.5)!
    expect(piece.nodes.map((n) => [n.x, n.y])).toEqual([
      [5, 5],
      [10, 10],
      [20, 0],
      [25, 5]
    ])
  })

  it('joinEnds: a gap becomes a straight segment; touching ends merge into one anchor; one subpath closes', () => {
    const a = sp(false, [0, 0], [10, 0])
    const b = sp(false, [20, 0], [30, 0])
    expect(joinEnds(a, 'end', b, 'start').nodes.map((n) => n.x)).toEqual([0, 10, 20, 30])
    expect(joinEnds(a, 'start', b, 'end').nodes.map((n) => n.x)).toEqual([10, 0, 30, 20])
    const touching = sp(false, [10, 0], [10, 10])
    expect(joinEnds(a, 'end', touching, 'start').nodes).toHaveLength(3)
    const avg = joinEnds(a, 'end', b, 'start', true)
    expect(avg.nodes.map((n) => n.x)).toEqual([0, 15, 30])
    const u = sp(false, [0, 0], [10, 0], [10, 10], [0, 10])
    expect(joinEnds(u, 'end', null, 'start')).toEqual({ ...u, closed: true })
    const ring = joinEnds(sp(false, [0, 0], [10, 0], [10, 10], [0, 0.001]), 'end', null, 'start')
    expect(ring.closed).toBe(true)
    expect(ring.nodes).toHaveLength(3)
  })
})

function segLen(x: DrawSubpath): number {
  let s = 0
  const n = x.closed ? x.nodes.length : x.nodes.length - 1
  for (let i = 0; i < n; i++) s += cubicLength(segmentOf(x, i))
  return s
}

describe('round corners', () => {
  it('a rounded square corner is a quarter circle of the radius', () => {
    const sq = sp(true, [0, 0], [100, 0], [100, 100], [0, 100])
    const out = roundCorners(sq, [1], 20)
    expect(out.nodes).toHaveLength(5)
    expect(out.nodes[1].x).toBeCloseTo(80, 9)
    expect(out.nodes[1].y).toBeCloseTo(0, 9)
    expect(out.nodes[2].x).toBeCloseTo(100, 9)
    expect(out.nodes[2].y).toBeCloseTo(20, 9)
    // Every point of the arc is 20 from the centre (80, 20).
    const arc = segmentOf(out, 1)
    for (let k = 0; k <= 10; k++) expect(Math.abs(dist(pointAt(arc, k / 10), { x: 80, y: 20 }) - 20)).toBeLessThan(0.03)
  })

  it('the radius is clamped so roundings on a shared side never overlap', () => {
    const sq = sp(true, [0, 0], [100, 0], [100, 100], [0, 100])
    const out = roundCorners(sq, [0, 1, 2, 3], 500)
    // Fully rounded: a circle of radius 50.
    expect(out.nodes).toHaveLength(8)
    for (const n of out.nodes) expect(Math.abs(dist(n, { x: 50, y: 50 }) - 50)).toBeLessThan(1e-6)
  })
})

describe('knife', () => {
  const square: DrawPath = { subpaths: [sp(true, [0, 0], [100, 0], [100, 100], [0, 100])] }

  it('a line across a square makes two pieces whose areas add up', () => {
    const pieces = knifePath(square, [
      { x: 40, y: -10 },
      { x: 60, y: 110 }
    ])!
    expect(pieces).toHaveLength(2)
    const areas = pieces.map(absArea)
    expect(areas[0] + areas[1]).toBeCloseTo(10000, 3)
    expect(Math.min(...areas)).toBeCloseTo(5000, 3)
  })

  it('a freehand zigzag cut follows the line', () => {
    const pieces = knifePath(square, [
      { x: -10, y: 50 },
      { x: 30, y: 30 },
      { x: 60, y: 70 },
      { x: 110, y: 50 }
    ])!
    expect(pieces).toHaveLength(2)
    expect(pieces.map(absArea).reduce((a, b) => a + b)).toBeCloseTo(10000, 3)
    // The cut edge contains the knife's interior vertices.
    const all = pieces.flatMap((p) => p.subpaths.flatMap((x) => x.nodes))
    expect(all.some((n) => n.x === 30 && n.y === 30)).toBe(true)
    expect(all.some((n) => n.x === 60 && n.y === 70)).toBe(true)
  })

  it('two passes cut three pieces; a line that never crosses does nothing', () => {
    const pieces = knifePath(square, [
      { x: 30, y: -10 },
      { x: 30, y: 110 },
      { x: 70, y: 110 },
      { x: 70, y: -10 }
    ])!
    expect(pieces).toHaveLength(3)
    expect(pieces.map(absArea).reduce((a, b) => a + b)).toBeCloseTo(10000, 3)
    expect(knifePath(square, [{ x: 10, y: 10 }, { x: 90, y: 90 }])).toBeNull()
    expect(knifePath(square, [{ x: 200, y: 0 }, { x: 300, y: 300 }])).toBeNull()
  })

  it('cutting a circle keeps the curves (pieces are cubic arcs, not polygons)', () => {
    const pieces = knifePath({ subpaths: [CIRCLE] }, [
      { x: 0, y: 100 },
      { x: 200, y: 100 }
    ])!
    expect(pieces).toHaveLength(2)
    for (const p of pieces) expect(p.subpaths[0].nodes.some((n) => n.inX != null || n.outX != null)).toBe(true)
    expect(pieces.map(absArea).reduce((a, b) => a + b)).toBeCloseTo(Math.PI * 2500, -1)
  })

  it('a ring cut straight through falls into two pieces with no hole left', () => {
    const ring: DrawPath = { fillRule: 'evenodd', subpaths: [sp(true, [0, 0], [100, 0], [100, 100], [0, 100]), sp(true, [30, 30], [70, 30], [70, 70], [30, 70])] }
    const pieces = knifePath(ring, [
      { x: 50, y: -10 },
      { x: 50, y: 110 }
    ])!
    expect(pieces).toHaveLength(2)
    for (const p of pieces) expect(p.subpaths).toHaveLength(1)
    expect(pieces.map(absArea).reduce((a, b) => a + b)).toBeCloseTo(10000 - 1600, 3)
  })

  it('an open path is not cut', () => {
    expect(knifePath({ subpaths: [sp(false, [0, 0], [100, 0], [100, 100])] }, [{ x: 50, y: -10 }, { x: 50, y: 110 }])).toBeNull()
  })
})

describe('path eraser and smooth', () => {
  it('erasing the middle of a line leaves two pieces with a gap of the eraser\'s width', () => {
    const line = sp(false, [0, 0], [100, 0])
    const pieces = eraseSubpath(line, [{ x: 50, y: -20 }, { x: 50, y: 20 }], 5)
    expect(pieces).toHaveLength(2)
    expect(pieces[0].nodes[1].x).toBeCloseTo(45, 4)
    expect(pieces[1].nodes[0].x).toBeCloseTo(55, 4)
    expect(eraseSubpath(line, [{ x: 50, y: 50 }], 5)[0]).toBe(line)
    expect(eraseSubpath(line, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 5)).toEqual([])
  })

  it('erasing a closed path opens it in one piece', () => {
    const pieces = eraseSubpath(CIRCLE, [{ x: 150, y: 90 }, { x: 150, y: 110 }], 3)
    expect(pieces).toHaveLength(1)
    expect(pieces[0].closed).toBe(false)
  })

  it('smoothing a jagged run reduces its turning while keeping its ends', () => {
    const jag = Array.from({ length: 21 }, (_, k) => ({ x: k * 10, y: k % 2 ? 8 : 0 }))
    const out = smoothRun(jag, 2, 18, 3, 4)
    expect(out[0]).toEqual(jag[0])
    expect(out[out.length - 1]).toEqual(jag[20])
    expect(out.length).toBeLessThan(jag.length)
  })
})

// ── Document operations ──────────────────────────────────────────────────────

describe('document ops', () => {
  it('moveAnchors moves only the named anchors; a live shape becomes a plain path', () => {
    const d = doc([{ ...pathObj('r', [sp(true, [0, 0], [100, 0], [100, 100], [0, 100])]), shapeKind: 'rect' }])
    const next = moveAnchors(d, [{ id: 'r', si: 0, ni: 1 }, { id: 'r', si: 0, ni: 2 }], 20, 0)
    expect(obj(next, 'r').path.subpaths[0].nodes.map((n) => n.x)).toEqual([0, 120, 120, 0])
    expect(obj(next, 'r').shapeKind).toBe('path')
    expect(moveAnchors(d, [{ id: 'r', si: 0, ni: 1 }], 0, 0)).toBe(d)
  })

  it('locked, hidden and locked-layer paths are never edited', () => {
    const square = [sp(true, [0, 0], [100, 0], [100, 100], [0, 100])]
    const d = doc([pathObj('a', square, { locked: true }), pathObj('b', square, { hidden: true })])
    const refs = [...allAnchorsOf(d, 'a'), ...allAnchorsOf(d, 'b')]
    expect(moveAnchors(d, refs, 5, 5).layers).toEqual(d.layers)
    expect(removeAnchorsJoined(d, refs).layers).toEqual(d.layers)
    expect(convertAnchors(d, refs, 'smooth').layers).toEqual(d.layers)
    expect(knifeCut(d, ['a', 'b'], [{ x: 50, y: -10 }, { x: 50, y: 110 }]).ids).toEqual([])
    const lockedLayer = normalizeDrawDoc({ ...JSON.parse(JSON.stringify({ schemaVersion: 1, width: 400, height: 300, background: { type: 'none' }, activeLayerId: 'L1' })), layers: [{ id: 'L1', kind: 'vector', name: 'L', visible: true, locked: true, opacity: 1, blend: 'normal', objects: [pathObj('c', square)] }] })
    expect(moveAnchors(lockedLayer, allAnchorsOf(lockedLayer, 'c'), 5, 5).layers).toEqual(lockedLayer.layers)
  })

  it('addAnchor returns the new anchor; addMidpointAnchors doubles the anchors', () => {
    const d = doc([pathObj('p', [sp(true, [0, 0], [100, 0], [100, 100], [0, 100])])])
    const { doc: next, ref } = addAnchor(d, 'p', 0, 0, 0.5)
    expect(ref).toEqual({ id: 'p', si: 0, ni: 1 })
    expect(obj(next, 'p').path.subpaths[0].nodes[1]).toEqual({ x: 50, y: 0 })
    expect(obj(addMidpointAnchors(d, ['p']), 'p').path.subpaths[0].nodes).toHaveLength(8)
  })

  it('removing every anchor of a path deletes it; the Delete key splits a single path into separate objects', () => {
    const d = doc([pathObj('p', [sp(false, [0, 0], [10, 0], [20, 0], [30, 0], [40, 0])])])
    expect(objs(removeAnchorsJoined(d, allAnchorsOf(d, 'p')))).toHaveLength(0)
    const { doc: broken, ids } = deleteAnchorsBreak(d, [{ id: 'p', si: 0, ni: 2 }])
    expect(objs(broken)).toHaveLength(2)
    expect(ids[0]).toBe('p')
    expect(objs(broken).map((o) => o.path.subpaths[0].nodes.length)).toEqual([2, 2])
  })

  it('scissors on a single path makes two objects in its place in the stack, with its appearance', () => {
    const d = doc([pathObj('under', [sp(false, [0, 50], [10, 50])]), pathObj('p', [sp(false, [0, 0], [100, 0])], { stroke: { paint: { type: 'solid', color: '#ff0000' }, width: 7 } }), pathObj('over', [sp(false, [0, 90], [10, 90])])])
    const { doc: next, ids } = cutPathAt(d, 'p', [{ si: 0, seg: 0, t: 0.5 }])
    expect(objs(next).map((o) => o.id)).toEqual(['under', ...ids, 'over'])
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(obj(next, id).stroke?.width).toBe(7)
    expect(cutAtAnchors(d, [{ id: 'p', si: 0, ni: 0 }]).doc).toBe(d)
  })

  it('join connects the nearest endpoints of two lines into one path (⌘J)', () => {
    const d = doc([pathObj('a', [sp(false, [0, 0], [100, 0])]), pathObj('b', [sp(false, [200, 0], [110, 0])])])
    const r = joinPathsByEnds(d, ['a', 'b'])!
    expect(objs(r.doc)).toHaveLength(1)
    expect(obj(r.doc, 'a').path.subpaths[0].nodes.map((n) => n.x)).toEqual([0, 100, 110, 200])
    // A single open path closes.
    const u = doc([pathObj('u', [sp(false, [0, 0], [100, 0], [100, 100])])])
    expect(obj(joinPathsByEnds(u, ['u'])!.doc, 'u').path.subpaths[0].closed).toBe(true)
    // Closed paths have nothing to join.
    expect(joinPathsByEnds(doc([pathObj('c', [sp(true, [0, 0], [1, 0], [1, 1])])]), ['c'])).toBeNull()
  })

  it('join of two named endpoints, with Average', () => {
    const d = doc([pathObj('a', [sp(false, [0, 0], [100, 0])]), pathObj('b', [sp(false, [120, 20], [200, 20])])])
    const r = joinEndpoints(d, { id: 'a', si: 0, end: 'end' }, { id: 'b', si: 0, end: 'start' }, true)!
    expect(obj(r.doc, 'a').path.subpaths[0].nodes).toEqual([{ x: 0, y: 0 }, { x: 110, y: 10 }, { x: 200, y: 20 }])
    expect(joinEndpoints(d, { id: 'a', si: 0, end: 'end' }, { id: 'a', si: 0, end: 'end' })).toBeNull()
  })

  it('average lines anchors up horizontally, vertically, or onto one point', () => {
    const d = doc([pathObj('p', [sp(false, [0, 0], [100, 40], [50, 80])])])
    const refs = allAnchorsOf(d, 'p')
    expect(obj(averageAnchors(d, refs, 'horizontal'), 'p').path.subpaths[0].nodes.map((n) => n.y)).toEqual([40, 40, 40])
    expect(obj(averageAnchors(d, refs, 'vertical'), 'p').path.subpaths[0].nodes.map((n) => n.x)).toEqual([50, 50, 50])
    expect(obj(averageAnchors(d, refs, 'both'), 'p').path.subpaths[0].nodes.every((n) => n.x === 50 && n.y === 40)).toBe(true)
    expect(averageAnchors(d, refs.slice(0, 1), 'both')).toBe(d)
  })

  it('align anchors to the left / vertical centre', () => {
    const d = doc([pathObj('p', [sp(false, [0, 0], [100, 40], [50, 80])])])
    const refs = allAnchorsOf(d, 'p')
    expect(obj(alignAnchors(d, refs, 'left'), 'p').path.subpaths[0].nodes.map((n) => n.x)).toEqual([0, 0, 0])
    expect(obj(alignAnchors(d, refs, 'vcenter'), 'p').path.subpaths[0].nodes.map((n) => n.y)).toEqual([40, 40, 40])
  })

  it('convert to corner and back to smooth', () => {
    const d = doc([pathObj('c', [CIRCLE])])
    const corner = convertAnchors(d, [{ id: 'c', si: 0, ni: 0 }], 'corner')
    expect(obj(corner, 'c').path.subpaths[0].nodes[0]).toEqual({ x: 150, y: 100 })
    const back = convertAnchors(corner, [{ id: 'c', si: 0, ni: 0 }], 'smooth')
    expect(isSmoothNode(obj(back, 'c').path.subpaths[0].nodes[0])).toBe(true)
    expect(convertAnchors(back, [{ id: 'c', si: 0, ni: 0 }], 'smooth')).toBe(back)
  })

  it('moveHandle and dragSegment', () => {
    const d = doc([pathObj('c', [CIRCLE])])
    const m = moveHandle(d, { id: 'c', si: 0, ni: 0 }, 'out', { x: 170, y: 120 }, 'free')
    expect(obj(m, 'c').path.subpaths[0].nodes[0]).toMatchObject({ outX: 170, outY: 120, inX: 150 })
    const line = doc([pathObj('l', [sp(false, [0, 0], [100, 0])])])
    expect(obj(dragSegment(line, 'l', 0, 0, 0.5, { x: 50, y: 10 }, { x: 50, y: 0 }), 'l').path.subpaths[0].nodes).toEqual([{ x: 0, y: 10 }, { x: 100, y: 10 }])
    const curved = dragSegment(d, 'c', 0, 0, 0.5, { x: 150, y: 150 }, pointAt(segmentOf(CIRCLE, 0), 0.5))
    expect(dist(pointAt(segmentOf(obj(curved, 'c').path.subpaths[0], 0), 0.5), { x: 150, y: 150 })).toBeLessThan(1e-6)
  })

  it('simplifyPaths, smoothPaths, erasePaths, knifeCut and roundAnchorCorners on a document', () => {
    const dense = sp(false, ...Array.from({ length: 80 }, (_, k): [number, number] => [k * 3, 100 + 30 * Math.sin(k / 10)]))
    const d = doc([pathObj('w', [dense]), pathObj('sq', [sp(true, [0, 0], [100, 0], [100, 100], [0, 100])])])
    expect(obj(simplifyPaths(d, ['w'], { precision: 50, angleThreshold: 135, straightLines: false }), 'w').path.subpaths[0].nodes.length).toBeLessThan(20)
    const sm = smoothPaths(d, ['w'], [{ x: 120, y: 100 }], 40, 80)
    expect(obj(sm, 'w').path.subpaths[0].nodes.length).toBeLessThan(80)
    const er = erasePaths(d, ['w'], [{ x: 120, y: 80 }, { x: 120, y: 130 }], 4)
    expect(er.ids).toHaveLength(2)
    const k = knifeCut(d, ['sq'], [{ x: 50, y: -10 }, { x: 50, y: 110 }])
    expect(k.ids).toHaveLength(2)
    expect(k.ids[0]).toBe('sq')
    const rc = roundAnchorCorners(d, [{ id: 'sq', si: 0, ni: 0 }], 10)
    expect(obj(rc.doc, 'sq').path.subpaths[0].nodes).toHaveLength(5)
    expect(rc.refs).toEqual([{ id: 'sq', si: 0, ni: 0 }, { id: 'sq', si: 0, ni: 1 }])
  })

  it('extendSubpath continues an open path from either end and can close it', () => {
    const d = doc([pathObj('p', [sp(false, [0, 0], [100, 0])])])
    const fromEnd = extendSubpath(d, { id: 'p', si: 0, end: 'end' }, [{ x: 100, y: 0 }, { x: 100, y: 100 }], false)
    expect(obj(fromEnd, 'p').path.subpaths[0].nodes.map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [100, 0],
      [100, 100]
    ])
    const fromStart = extendSubpath(d, { id: 'p', si: 0, end: 'start' }, [{ x: 0, y: 0 }, { x: 0, y: 100 }], true)
    const s = obj(fromStart, 'p').path.subpaths[0]
    expect(s.closed).toBe(true)
    expect(s.nodes.map((n) => [n.x, n.y])).toEqual([
      [100, 0],
      [0, 0],
      [0, 100]
    ])
  })

  it('anchors inside a transformed group are edited in the group\'s space', () => {
    const d = normalizeDrawDoc({
      schemaVersion: 2,
      minWriterVersion: 2,
      artboards: [{ id: 'ab', name: 'A', x: 0, y: 0, w: 400, h: 300, background: { type: 'none' } }],
      layers: [
        {
          id: 'L1',
          kind: 'vector',
          name: 'L',
          visible: true,
          locked: false,
          opacity: 1,
          blend: 'normal',
          objects: [{ id: 'g', type: 'group', transform: [2, 0, 0, 2, 10, 10], children: [pathObj('p', [sp(false, [0, 0], [10, 0])])] }]
        }
      ],
      assets: {},
      swatches: [],
      guides: [],
      settings: {}
    })
    const next = moveAnchors(d, [{ id: 'p', si: 0, ni: 1 }], 20, 0)
    const g = vectorLayersOf(next)[0].objects[0]
    expect(g.type === 'group' && (g.children[0] as DrawPathNode).path.subpaths[0].nodes[1]).toEqual({ x: 20, y: 0 })
  })
})
