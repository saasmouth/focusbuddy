// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  routeOrthogonal,
  sideToward,
  anchorOn,
  segmentHitsRect,
  simplify,
  routeToPath,
  type RouteRect,
  type RoutePoint
} from '../../src/shared/mapRouting'

// The diagram app drew every connector as a straight line between two border
// points, so a link from the first box to the third went through the second.
// These tests are mostly one property stated several ways: a routed connector
// must not pass through a shape. Everything else is shape and tidiness.

const r = (x: number, y: number, w = 100, h = 60): RouteRect => ({ x, y, w, h })

/** Every segment of a route, as pairs. */
const segments = (pts: RoutePoint[]): Array<[RoutePoint, RoutePoint]> =>
  pts.slice(0, -1).map((p, i) => [p, pts[i + 1]] as [RoutePoint, RoutePoint])

/** Does any segment cross this box, allowing a small tolerance for stubs? */
const crosses = (pts: RoutePoint[], box: RouteRect, shrink = 1): boolean => {
  const tight = { x: box.x + shrink, y: box.y + shrink, w: box.w - shrink * 2, h: box.h - shrink * 2 }
  return segments(pts).some(([a, b]) => segmentHitsRect(a, b, tight))
}

const isOrthogonal = (pts: RoutePoint[]): boolean =>
  segments(pts).every(([a, b]) => Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01)

describe('which side a connector leaves by', () => {
  it('goes right when the target is to the right', () => {
    expect(sideToward(r(0, 0), r(300, 0))).toBe('right')
    expect(sideToward(r(300, 0), r(0, 0))).toBe('left')
  })

  it('goes down when the target is below', () => {
    expect(sideToward(r(0, 0), r(0, 300))).toBe('bottom')
    expect(sideToward(r(0, 300), r(0, 0))).toBe('top')
  })

  it('prefers the axis the boxes do NOT overlap on', () => {
    // Side by side with a big vertical overlap: a person draws this
    // left-to-right, even though the centres differ on both axes.
    expect(sideToward(r(0, 0, 100, 400), r(200, 180, 100, 60))).toBe('right')
    // Stacked with a big horizontal overlap: top-to-bottom.
    expect(sideToward(r(0, 0, 400, 60), r(180, 200, 60, 60))).toBe('bottom')
  })
})

describe('anchors', () => {
  it('sit on the border, with the stub outside it', () => {
    const box = r(100, 100, 100, 60)
    expect(anchorOn(box, 'right', 16)).toEqual({ at: { x: 200, y: 130 }, stub: { x: 216, y: 130 } })
    expect(anchorOn(box, 'top', 16)).toEqual({ at: { x: 150, y: 100 }, stub: { x: 150, y: 84 } })
  })
})

describe('routing', () => {
  it('produces an axis-aligned path that starts and ends on the boxes', () => {
    const a = r(0, 0)
    const b = r(400, 200)
    const pts = routeOrthogonal(a, b, [a, b])
    expect(pts.length).toBeGreaterThanOrEqual(2)
    expect(isOrthogonal(pts)).toBe(true)
    // First point on a's border, last on b's.
    expect(pts[0].x === a.x + a.w || pts[0].y === a.y + a.h || pts[0].x === a.x || pts[0].y === a.y).toBe(true)
  })

  it('takes a simple elbow when nothing is in the way', () => {
    const a = r(0, 0)
    const b = r(400, 200)
    // Two boxes, clear space: at most start, corner, corner, end.
    expect(routeOrthogonal(a, b, [a, b]).length).toBeLessThanOrEqual(5)
  })

  it('goes AROUND a box sitting between the endpoints', () => {
    // The original failure: three boxes in a row, first to third.
    const a = r(0, 0)
    const mid = r(200, 0)
    const b = r(400, 0)
    const pts = routeOrthogonal(a, b, [a, mid, b])
    expect(crosses(pts, mid)).toBe(false)
    expect(isOrthogonal(pts)).toBe(true)
    // It has to leave the straight line to get past, so it must bend.
    expect(pts.length).toBeGreaterThan(2)
  })

  it('goes around a wall of boxes', () => {
    const a = r(0, 200)
    const b = r(600, 200)
    const wall = [r(300, 0, 60, 160), r(300, 170, 60, 160), r(300, 340, 60, 160)]
    const pts = routeOrthogonal(a, b, [a, b, ...wall])
    for (const w of wall) expect(crosses(pts, w)).toBe(false)
    expect(isOrthogonal(pts)).toBe(true)
  })

  it('never returns an empty route, even when the target is walled in', () => {
    // A connector in the wrong place is cosmetic; one that vanishes reads as
    // lost data, so the fallback is a straight line rather than nothing.
    const a = r(0, 0)
    const b = r(400, 400, 40, 40)
    const cage = [r(360, 360, 120, 20), r(360, 460, 120, 20), r(360, 360, 20, 120), r(460, 360, 20, 120)]
    const pts = routeOrthogonal(a, b, [a, b, ...cage])
    expect(pts.length).toBeGreaterThanOrEqual(2)
    expect(isOrthogonal(pts)).toBe(true)
  })

  it('honours an explicit side', () => {
    const a = r(200, 200)
    const b = r(600, 200)
    const pts = routeOrthogonal(a, b, [a, b], { fromSide: 'left' })
    // Leaving left means the first step goes left, away from the target.
    expect(pts[1].x).toBeLessThan(pts[0].x)
  })

  it('prefers fewer bends as the turn penalty rises', () => {
    const a = r(0, 0)
    const mid = r(200, 40, 60, 60)
    const b = r(400, 0)
    const lax = routeOrthogonal(a, b, [a, mid, b], { turnPenalty: 0 })
    const strict = routeOrthogonal(a, b, [a, mid, b], { turnPenalty: 400 })
    expect(strict.length).toBeLessThanOrEqual(lax.length)
  })

  it('keeps clear of boxes by roughly the clearance', () => {
    const a = r(0, 0)
    const mid = r(200, 0)
    const b = r(400, 0)
    const pts = routeOrthogonal(a, b, [a, mid, b], { clearance: 24 })
    // Inflating the obstacle by slightly less than the clearance must still
    // not be crossed.
    expect(crosses(pts, { x: mid.x - 20, y: mid.y - 20, w: mid.w + 40, h: mid.h + 40 })).toBe(false)
  })
})

describe('the property that matters, over many layouts', () => {
  it('never routes through an obstacle', () => {
    // Deterministic pseudo-random layouts: a fixed seed, so a failure is
    // reproducible rather than a Tuesday mystery.
    let seed = 12345
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    let checked = 0
    // Several seeds, not one. A single seed proves the router handles the
    // layouts that seed happens to produce, which is how a property test ends
    // up tuned to its own fixture.
    const SEEDS = [12345, 777, 2026, 99991]
    for (const s0 of SEEDS) {
      seed = s0
      runTrials()
    }
    function runTrials(): void {
    for (let trial = 0; trial < 200; trial++) {
      const a = r(rnd(200), rnd(200))
      const b = r(400 + rnd(200), rnd(400))
      const obstacles = Array.from({ length: 1 + rnd(4) }, () => r(150 + rnd(300), rnd(400), 60 + rnd(80), 40 + rnd(60)))
      const pts = routeOrthogonal(a, b, [a, b, ...obstacles])
      expect(isOrthogonal(pts)).toBe(true)
      for (const o of obstacles) {
        // Skip obstacles overlapping an endpoint box: the stub legitimately
        // starts inside them and no route could avoid that.
        const overlapsEnd =
          segmentHitsRect({ x: a.x, y: a.y }, { x: a.x + a.w, y: a.y + a.h }, o) ||
          segmentHitsRect({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, o)
        if (overlapsEnd) continue
        expect(crosses(pts, o, 2)).toBe(false)
        checked++
      }
    }
    }
    // Guards the loop against passing because everything was skipped.
    expect(checked).toBeGreaterThan(400)
  })

  it('moves to a free port when the natural one starts inside a shape', () => {
    // Found by the sweep: an obstacle pressed against the target's left edge
    // contained the target's own left-hand stub. The stub could not be routed
    // away from, so the obstacle was ignored and the connector drove straight
    // through it. A person would come in from below instead.
    const a = r(88, 72)
    const b = r(408, 256)
    const blocker = r(314, 208, 84, 84)
    const pts = routeOrthogonal(a, b, [a, b, blocker])
    expect(crosses(pts, blocker, 2)).toBe(false)
    expect(isOrthogonal(pts)).toBe(true)
  })
})

describe('simplify', () => {
  it('drops collinear midpoints and duplicates', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }])).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }])
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 9 }])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 9 }])
  })

  it('keeps real corners', () => {
    const corner = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    expect(simplify(corner)).toEqual(corner)
  })
})

describe('routeToPath', () => {
  it('writes a plain polyline when the radius is zero', () => {
    expect(routeToPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M0 0 L10 0')
  })

  it('rounds corners without overshooting a short leg', () => {
    // Radius 50 on a 10px leg would otherwise curve past the next corner.
    const d = routeToPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 50)
    expect(d).toContain('Q')
    const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
    expect(Math.max(...nums)).toBeLessThanOrEqual(10)
  })

  it('returns nothing for a degenerate route', () => {
    expect(routeToPath([{ x: 1, y: 1 }])).toBe('')
  })
})
