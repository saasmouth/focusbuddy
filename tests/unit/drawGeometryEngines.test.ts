// @vitest-environment node
//
// The geometry engines behind one interface (src/shared/draw/geometry): the
// in-house flattening boolean, paper.js 0.12.18 and Clipper2 0.4.0 (wasm).
// Every engine must pass the 120-layout area-identity sweep that guards the
// in-house boolean (drawGeometry.test.ts keeps its own copy), and the engines
// must agree with each other. Numbers and the reasoning are in the spike
// report, /private/tmp/claude-501/draw-plan/GEOMETRY-SPIKE.md.

import { beforeAll, describe, expect, it } from 'vitest'
import { ellipsePath, flattenPath, pathToSvgD, polygonArea, rectPath, starPath, type BooleanOp, type DrawPath } from '../../src/shared/drawGeometry'
import { invalidResult, type EngineId, type GeometryEngine } from '../../src/shared/draw/geometry/engine'
import { loadGeometryEngine } from '../../src/shared/draw/geometry/load'

const engines: Partial<Record<EngineId, GeometryEngine>> = {}
beforeAll(async () => {
  for (const id of ['inhouse', 'paper', 'clipper'] as EngineId[]) engines[id] = await loadGeometryEngine(id)
})

/** |net area|: a result may be wound either way; a hole wound like its shell would still show (as shell + hole). */
function area(p: DrawPath): number {
  return Math.abs(flattenPath(p, 0.05).reduce((s, r) => s + polygonArea(r), 0))
}

function rnd(state: { s: number }, n: number): number {
  state.s = (state.s * 1103515245 + 12345) & 0x7fffffff
  return state.s % n
}

/** The identity sweep: worst absolute and relative error over `layouts` random pairs. */
function sweep(e: GeometryEngine, gen: (s: { s: number }, which: 'p' | 'q') => DrawPath, layouts = 120): { checked: number; worst: number; worstRel: number } {
  const s = { s: 4242 }
  let worst = 0
  let worstRel = 0
  let checked = 0
  for (let i = 0; i < layouts; i++) {
    const p = gen(s, 'p')
    const q = gen(s, 'q')
    const op = (o: BooleanOp, a = p, b = q): number => area(e.boolean(a, b, o))
    const union = op('union')
    const inter = op('intersect')
    const xor = op('exclude')
    const errs = [Math.abs(union + inter - (area(p) + area(q))), Math.abs(xor - (union - inter)), Math.abs(op('subtract') + op('subtract', q, p) - xor)]
    const m = Math.max(...errs)
    worst = Math.max(worst, m)
    worstRel = Math.max(worstRel, m / (area(p) + area(q)))
    checked++
  }
  return { checked, worst, worstRel }
}

const RECTS = (s: { s: number }, w: 'p' | 'q'): DrawPath =>
  w === 'p' ? rectPath(rnd(s, 50), rnd(s, 50), 20 + rnd(s, 80), 20 + rnd(s, 80)) : rectPath(rnd(s, 100), rnd(s, 100), 20 + rnd(s, 80), 20 + rnd(s, 80))
const ELLIPSES = (s: { s: number }): DrawPath => ellipsePath(20 + rnd(s, 100), 20 + rnd(s, 100), 10 + rnd(s, 60), 10 + rnd(s, 60))
const STARS = (s: { s: number }): DrawPath => starPath(30 + rnd(s, 100), 30 + rnd(s, 100), 20 + rnd(s, 50), 4 + rnd(s, 6), 0.3 + rnd(s, 50) / 100)

describe.each(['inhouse', 'paper', 'clipper'] as EngineId[])('%s engine', (id) => {
  it('passes the 120-layout area-identity sweep on rectangles (under 1 square px)', () => {
    const r = sweep(engines[id]!, RECTS)
    expect(r.checked).toBe(120)
    expect(r.worst).toBeLessThan(1)
  })

  it('agrees with the in-house engine on the rectangle sweep, per operation, within 1 square px', () => {
    const s = { s: 777 }
    for (let i = 0; i < 60; i++) {
      const p = RECTS(s, 'p')
      const q = RECTS(s, 'q')
      for (const op of ['union', 'intersect', 'subtract', 'exclude'] as BooleanOp[]) {
        expect(Math.abs(area(engines[id]!.boolean(p, q, op)) - area(engines.inhouse!.boolean(p, q, op)))).toBeLessThan(1)
      }
    }
  })

  it('handles the edge cases without throwing or returning broken geometry', () => {
    const e = engines[id]!
    const A = rectPath(0, 0, 100, 100)
    const shared = e.boolean(A, rectPath(100, 0, 100, 100), 'union')
    expect(area(shared)).toBeCloseTo(20000, 0)
    expect(shared.subpaths).toHaveLength(1)
    expect(area(e.boolean(A, rectPath(0, 0, 100, 100), 'subtract'))).toBeLessThan(0.01)
    const hole = e.boolean(A, rectPath(25, 25, 50, 50), 'subtract')
    expect(hole.subpaths).toHaveLength(2)
    expect(area(hole)).toBeCloseTo(7500, 0)
    expect(area(e.boolean(A, { subpaths: [] }, 'union'))).toBeCloseTo(10000, 0)
    for (const r of [shared, hole]) expect(invalidResult(r)).toBeNull()
  })
})

describe('curved input', () => {
  it('paper.js and Clipper2 keep the identities on ellipses and stars (paper: exact curves; Clipper2: within its 0.25px flattening)', () => {
    for (const id of ['paper', 'clipper'] as EngineId[]) {
      for (const gen of [ELLIPSES, STARS]) {
        const r = sweep(engines[id]!, gen)
        expect(r.worstRel, id).toBeLessThan(0.01)
      }
    }
  })

  // KNOWN DEFECT, found by the Phase 0 spike: the in-house boolean returns
  // wrong regions when two curved shapes overlap thinly (e.g. two ellipses
  // whose union it returns as two rings and whose overlap it measures as a
  // sliver). Rectangles are fine. Pinned with `fails` so this test turns red
  // -- and must be updated -- the day the in-house engine is fixed or retired.
  it.fails('the in-house engine keeps the identities on ellipses', () => {
    expect(sweep(engines.inhouse!, ELLIPSES).worstRel).toBeLessThan(0.01)
  })

  it('a concrete case: two thinly overlapping ellipses -- paper.js and Clipper2 agree, in-house does not', () => {
    const s = { s: 4242 }
    const p = ELLIPSES(s)
    const q = ELLIPSES(s)
    const paperU = area(engines.paper!.boolean(p, q, 'union'))
    const clipU = area(engines.clipper!.boolean(p, q, 'union'))
    const inU = area(engines.inhouse!.boolean(p, q, 'union'))
    expect(Math.abs(paperU - clipU) / paperU).toBeLessThan(0.01)
    expect(Math.abs(inU - paperU) / paperU).toBeGreaterThan(0.01)
    expect(engines.paper!.boolean(p, q, 'union').subpaths).toHaveLength(1)
  })

  it('only paper.js preserves curves: circle minus circle stays cubic', () => {
    const c1 = ellipsePath(0, 0, 50, 50)
    const c2 = ellipsePath(50, 0, 50, 50)
    const lens = 2 * 2500 * (Math.PI / 3 - Math.sqrt(3) / 4)
    const truth = Math.PI * 2500 - lens
    const viaPaper = engines.paper!.boolean(c1, c2, 'subtract')
    expect(pathToSvgD(viaPaper)).toContain('C ')
    expect(viaPaper.subpaths[0].nodes.length).toBeLessThanOrEqual(8)
    expect(Math.abs(area(viaPaper) - truth)).toBeLessThan(1)
    for (const id of ['inhouse', 'clipper'] as EngineId[]) {
      const r = engines[id]!.boolean(c1, c2, 'subtract')
      expect(pathToSvgD(r), id).not.toContain('C ')
      expect(r.subpaths[0].nodes.length, id).toBeGreaterThan(40)
    }
  })
})

describe('Clipper2 offset and outline stroke', () => {
  const c = (): GeometryEngine => engines.clipper!

  it('offsets a square exactly with mitred joins, and within arc tolerance with round ones', () => {
    expect(area(c().offset!(rectPath(0, 0, 100, 100), 10, { join: 'miter' }))).toBeCloseTo(14400, 1)
    expect(area(c().offset!(rectPath(0, 0, 100, 100), -10, { join: 'miter' }))).toBeCloseTo(6400, 1)
    const round = area(c().offset!(rectPath(0, 0, 100, 100), 10, { join: 'round' }))
    expect(Math.abs(round - (14400 - (4 - Math.PI) * 100)) / round).toBeLessThan(0.001)
  })

  it('offsets a circle to the circle of the new radius', () => {
    const grown = area(c().offset!(ellipsePath(0, 0, 50, 50), 10, { join: 'round' }))
    expect(Math.abs(grown - Math.PI * 3600) / grown).toBeLessThan(0.001)
  })

  it('area grows monotonically with the offset on convex input, and offset(offset(p, d), -d) returns p', () => {
    const star = starPath(0, 0, 50, 6, 0.8)
    let last = 0
    for (const d of [-4, -2, 0.5, 2, 4, 8]) {
      const a = area(c().offset!(star, d, { join: 'round' }))
      expect(a).toBeGreaterThan(last)
      last = a
    }
    const sq = rectPath(0, 0, 80, 60)
    const back = c().offset!(c().offset!(sq, 7, { join: 'miter' }), -7, { join: 'miter' })
    expect(area(back)).toBeCloseTo(4800, 0)
  })

  it('a shape thinner than twice the inset vanishes rather than inverting', () => {
    expect(area(c().offset!(rectPath(0, 0, 100, 5), -3, { join: 'miter' }))).toBe(0)
  })

  it('outlines a stroke: butt and round caps, and a closed path as a ring', () => {
    const line: DrawPath = { subpaths: [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }] }
    expect(area(c().outlineStroke!(line, { width: 10, cap: 'butt' }))).toBeCloseTo(1000, 1)
    const capped = area(c().outlineStroke!(line, { width: 10, cap: 'round', join: 'round' }))
    expect(Math.abs(capped - (1000 + Math.PI * 25)) / capped).toBeLessThan(0.002)
    const ring = c().outlineStroke!(rectPath(0, 0, 100, 100), { width: 10, join: 'miter' })
    expect(ring.subpaths).toHaveLength(2)
    expect(area(ring)).toBeCloseTo(110 * 110 - 90 * 90, 0)
  })
})

describe('loading', () => {
  it('each engine says where it can run', () => {
    expect([engines.inhouse!, engines.paper!, engines.clipper!].map((e) => [e.id, e.runsInRenderer, e.preservesCurves])).toEqual([
      ['inhouse', true, false],
      ['paper', true, true],
      ['clipper', false, false]
    ])
  })

  it('Clipper2 refuses to load in a renderer, saying why', async () => {
    const { createClipperEngine } = await import('../../src/shared/draw/geometry/clipperEngine')
    const proc = process as unknown as { type?: string }
    proc.type = 'renderer'
    try {
      await expect(createClipperEngine()).rejects.toThrow(/main process only/)
    } finally {
      delete proc.type
    }
  })

  it('an engine is loaded once and reused', async () => {
    expect(await loadGeometryEngine('paper')).toBe(engines.paper)
  })

  it('invalidResult names what is wrong with a result', () => {
    expect(invalidResult({ subpaths: [{ closed: true, nodes: [{ x: 0, y: NaN }] }] })).toBe('a non-finite coordinate')
    expect(invalidResult({ subpaths: [{ closed: true, nodes: [] }] })).toBe('an empty subpath')
    expect(invalidResult(rectPath(0, 0, 1, 1))).toBeNull()
  })
})
