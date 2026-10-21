// Parity with the 4.3.39 connector router (src/shared/mapRouting.ts, by d2).
// PlexiiDiagrams now routes every connector through src/shared/diagram/routing.ts,
// so each guarantee mapRouting.test.ts pinned is restated here against the new
// router, before the old one is removed. Same layouts, same seeds, same bars.
//
// Not ported, deliberately: `turnPenalty` (a tuning knob of the old A*, with no
// user-visible promise; the new router has its own bend cost) and
// sideToward/anchorOn/simplify (internal helpers; their observable effects are
// covered by the route-level tests below).
import { describe, expect, it } from 'vitest'
import { routeAll, pathFromPoints, routingInvariants, type Route } from '../../src/shared/diagram/routing'
import type { MapEdge, MapNode } from '../../src/shared/types'

type Pt = { x: number; y: number }
type Rect = { x: number; y: number; w: number; h: number }

const r = (x: number, y: number, w = 100, h = 60): Rect => ({ x, y, w, h })
let n = 0
const node = (b: Rect, id = `n${n++}`): MapNode => ({ id, x: b.x, y: b.y, width: b.w, height: b.h, label: '', shape: 'process', color: '#000' })

function route(a: Rect, b: Rect, obstacles: Rect[], edge: Partial<MapEdge> = {}, opts: Parameters<typeof routeAll>[2] = {}): Pt[] {
  const na = node(a, 'a')
  const nb = node(b, 'b')
  const nodes = [na, nb, ...obstacles.map((o) => node(o))]
  const routes: Map<string, Route> = routeAll(nodes, [{ id: 'e', source: 'a', target: 'b', ...edge }], opts)
  return routes.get('e')!.points
}

const segments = (pts: Pt[]): [Pt, Pt][] => pts.slice(0, -1).map((p, i) => [p, pts[i + 1]!])

// Axis-aligned segment against a rectangle's interior.
function segmentHitsRect(a: Pt, b: Pt, box: Rect): boolean {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  return maxX > box.x && minX < box.x + box.w && maxY > box.y && minY < box.y + box.h
}
const crosses = (pts: Pt[], box: Rect, shrink = 1): boolean => {
  const tight = { x: box.x + shrink, y: box.y + shrink, w: box.w - shrink * 2, h: box.h - shrink * 2 }
  return segments(pts).some(([a, b]) => segmentHitsRect(a, b, tight))
}
const isOrthogonal = (pts: Pt[]): boolean => segments(pts).every(([a, b]) => Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01)
const onBorder = (p: Pt, b: Rect): boolean =>
  p.x >= b.x - 0.5 && p.x <= b.x + b.w + 0.5 && p.y >= b.y - 0.5 && p.y <= b.y + b.h + 0.5 &&
  (Math.abs(p.x - b.x) < 0.5 || Math.abs(p.x - b.x - b.w) < 0.5 || Math.abs(p.y - b.y) < 0.5 || Math.abs(p.y - b.y - b.h) < 0.5)

describe('routing parity', () => {
  it('produces an axis-aligned path that starts and ends on the boxes', () => {
    const a = r(0, 0)
    const b = r(300, 200)
    const pts = route(a, b, [])
    expect(isOrthogonal(pts)).toBe(true)
    expect(onBorder(pts[0]!, a)).toBe(true)
    expect(onBorder(pts[pts.length - 1]!, b)).toBe(true)
  })

  it('takes a simple elbow when nothing is in the way', () => {
    const pts = route(r(0, 0), r(300, 200), [])
    expect(pts.length).toBeLessThanOrEqual(4)
  })

  it('goes AROUND a box sitting between the endpoints', () => {
    const mid = r(200, 0)
    const pts = route(r(0, 0), r(400, 0), [mid])
    expect(crosses(pts, mid)).toBe(false)
    expect(isOrthogonal(pts)).toBe(true)
    expect(pts.length).toBeGreaterThan(2)
  })

  it('goes around a wall of boxes', () => {
    const wall = [r(300, 0, 60, 160), r(300, 170, 60, 160), r(300, 340, 60, 160)]
    const pts = route(r(0, 200), r(600, 200), wall)
    for (const w of wall) expect(crosses(pts, w)).toBe(false)
    expect(isOrthogonal(pts)).toBe(true)
  })

  it('never returns an empty route, even when the target is walled in', () => {
    // d2's cage: its walls sit inside the clearance of the target's stubs, so
    // the router frees the wall a stub starts in (an anchor inside an obstacle
    // could otherwise have no route at all). With no opening, crossing one wall
    // is the honest answer; crossing several would not be.
    const cage = [r(360, 360, 120, 20), r(360, 460, 120, 20), r(360, 360, 20, 120), r(460, 360, 20, 120)]
    const pts = route(r(0, 0), r(400, 400, 40, 40), cage)
    expect(pts.length).toBeGreaterThanOrEqual(2)
    expect(isOrthogonal(pts)).toBe(true)
    expect(cage.filter((w) => crosses(pts, w)).length).toBeLessThanOrEqual(1)
  })

  it('the true last resort (no region wide enough) is still a well-formed route', () => {
    // A sealed cage set back beyond the stubs' clearance: nothing is freed, the
    // bounded widening (80, 400, every obstacle, one outer ring) finds nothing,
    // and the router falls back to an elbow. d2's point: that path deserves the
    // happy path's scrutiny, because a fallback that always "works" hides
    // failures.
    const a = r(0, 0)
    const b = r(400, 400, 40, 40)
    const cage = [r(330, 330, 180, 20), r(330, 490, 180, 20), r(330, 330, 20, 180), r(490, 330, 20, 180)]
    const before = routingInvariants.fallbacks
    const pts = route(a, b, cage)
    expect(routingInvariants.fallbacks).toBe(before + 1) // it really is the fallback
    expect(pts.length).toBeGreaterThanOrEqual(2)
    expect(isOrthogonal(pts)).toBe(true)
    expect(onBorder(pts[0]!, a)).toBe(true)
    expect(onBorder(pts[pts.length - 1]!, b)).toBe(true)
    // Bounded: within the two shapes' extent plus their stubs.
    const STUB = 16
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(Math.min(a.x, b.x) - STUB - 0.5)
      expect(p.x).toBeLessThanOrEqual(Math.max(a.x + a.w, b.x + b.w) + STUB + 0.5)
      expect(p.y).toBeGreaterThanOrEqual(Math.min(a.y, b.y) - STUB - 0.5)
      expect(p.y).toBeLessThanOrEqual(Math.max(a.y + a.h, b.y + b.h) + STUB + 0.5)
    }
    // and the export still draws it as a real path, not an empty one
    expect(pathFromPoints(pts, 'orthogonal', { cornerRadius: 8 })).toMatch(/^M/)
  })

  it('honours an explicit side', () => {
    const pts = route(r(200, 200), r(600, 200), [], { sourceHandle: 'left' })
    expect(pts[1]!.x).toBeLessThan(pts[0]!.x)
  })

  it('keeps clear of boxes by roughly the clearance', () => {
    const mid = r(200, 0)
    const pts = route(r(0, 0), r(400, 0), [mid], {}, { margin: 24 })
    expect(crosses(pts, { x: mid.x - 20, y: mid.y - 20, w: mid.w + 40, h: mid.h + 40 })).toBe(false)
  })
})

describe('the property that matters, over many layouts (parity)', () => {
  it('never routes through an obstacle', () => {
    let seed = 0
    const rnd = (k: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % k
    }
    let checked = 0
    routingInvariants.regionEscapes = 0
    for (const s0 of [12345, 777, 2026, 99991]) {
      seed = s0
      for (let trial = 0; trial < 200; trial++) {
        const a = r(rnd(200), rnd(200))
        const b = r(400 + rnd(200), rnd(400))
        const obstacles = Array.from({ length: 1 + rnd(4) }, () => r(150 + rnd(300), rnd(400), 60 + rnd(80), 40 + rnd(60)))
        const pts = route(a, b, obstacles)
        expect(isOrthogonal(pts)).toBe(true)
        for (const o of obstacles) {
          const overlapsEnd = segmentHitsRect({ x: a.x, y: a.y }, { x: a.x + a.w, y: a.y + a.h }, o) || segmentHitsRect({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, o)
          if (overlapsEnd) continue
          expect(crosses(pts, o, 2), `seed ${s0} trial ${trial}`).toBe(false)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(400)
    // d2's lesson: a route can avoid every shape and still have been computed
    // in the wrong frame. Every searched route must lie inside its region.
    expect(routingInvariants.regionEscapes).toBe(0)
  })

  it('moves to a free port when the natural one starts inside a shape', () => {
    const blocker = r(314, 208, 84, 84)
    const pts = route(r(88, 72), r(408, 256), [blocker])
    expect(crosses(pts, blocker, 2)).toBe(false)
    expect(isOrthogonal(pts)).toBe(true)
  })
})

describe('path output parity', () => {
  it('writes a plain polyline when the radius is zero', () => {
    const d = pathFromPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], 'orthogonal', { cornerRadius: 0 })
    expect(d).not.toMatch(/[QCA]/)
  })

  it('rounds corners without overshooting a short leg', () => {
    // A 10px leg with a 40px radius: the curve may use at most half of it.
    const d = pathFromPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 200, y: 10 }], 'orthogonal', { cornerRadius: 40 })
    expect(d).toMatch(/[QA]/)
    const nums = [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]))
    const ys = nums.filter((_, i) => i % 2 === 1)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-0.01)
    expect(Math.max(...ys)).toBeLessThanOrEqual(10.01)
  })

  it('returns nothing for a degenerate route', () => {
    expect(pathFromPoints([], 'orthogonal')).toBe('')
    expect(pathFromPoints([{ x: 1, y: 1 }], 'orthogonal')).toBe('')
  })
})
