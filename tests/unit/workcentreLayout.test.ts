// The Workcentre dashboard grid (lib/workcentreLayout): the invariants every
// operation must keep, checked after hand-picked cases and after long randomised
// sequences of moves, resizes, reflows and syncs.

import { describe, expect, it } from 'vitest'
import {
  clampTile,
  collides,
  colsForWidth,
  compact,
  firstFit,
  moveTile,
  pxFromUnits,
  reflow,
  resizeTile,
  syncLayout,
  toTiles,
  unitsFromPx,
  MAX_COLS,
  MIN_COLS,
  type Mins,
  type Tile
} from '../../src/renderer/src/lib/workcentreLayout'
import { minSizeFor, BASE_MIN } from '../../src/renderer/src/lib/widgetSizing'
import { WIDGET_CATALOG } from '../../src/renderer/src/lib/widgetCatalog'

function invariants(tiles: Tile[], cols: number, mins: Mins = {}): void {
  for (const t of tiles) {
    expect(Number.isInteger(t.x) && Number.isInteger(t.y) && Number.isInteger(t.w) && Number.isInteger(t.h), `${t.id} integer`).toBe(true)
    expect(t.x, `${t.id} x ≥ 0`).toBeGreaterThanOrEqual(0)
    expect(t.y, `${t.id} y ≥ 0`).toBeGreaterThanOrEqual(0)
    expect(t.x + t.w, `${t.id} inside ${cols} cols`).toBeLessThanOrEqual(cols)
    const m = mins[t.id]
    if (m) {
      expect(t.w, `${t.id} ≥ min w`).toBeGreaterThanOrEqual(Math.min(cols, m.w))
      expect(t.h, `${t.id} ≥ min h`).toBeGreaterThanOrEqual(m.h)
    }
  }
  for (let i = 0; i < tiles.length; i++)
    for (let j = i + 1; j < tiles.length; j++) expect(collides(tiles[i]!, tiles[j]!), `${tiles[i]!.id} overlaps ${tiles[j]!.id}`).toBe(false)
  // compacted: no tile can move up one row without colliding (or leaving the grid)
  for (const t of tiles) {
    if (t.y === 0) continue
    const up = { ...t, y: t.y - 1 }
    expect(tiles.some((o) => o.id !== t.id && collides(up, o)), `${t.id} could rise`).toBe(true)
  }
}

describe('columns and units', () => {
  it('the column count follows the width, clamped', () => {
    expect(colsForWidth(0)).toBe(MIN_COLS)
    expect(colsForWidth(300)).toBe(MIN_COLS)
    expect(colsForWidth(1300)).toBe(12)
    expect(colsForWidth(100_000)).toBe(MAX_COLS)
  })
  it('px ↔ units round-trip never undercuts a minimum', () => {
    for (const colPx of [60, 84, 96, 120]) {
      for (const px of [{ w: 180, h: 120 }, { w: 320, h: 240 }, { w: 999, h: 33 }]) {
        const u = unitsFromPx(px, colPx)
        const back = pxFromUnits(u, colPx)
        expect(back.w).toBeGreaterThanOrEqual(px.w)
        expect(back.h).toBeGreaterThanOrEqual(px.h)
      }
    }
  })
})

describe('operations', () => {
  const base = (): Tile[] => [
    { id: 'a', x: 0, y: 0, w: 4, h: 4 },
    { id: 'b', x: 4, y: 0, w: 4, h: 4 },
    { id: 'c', x: 0, y: 4, w: 8, h: 3 }
  ]
  it('moving a tile onto another pushes it down; the grid compacts', () => {
    const out = moveTile(base(), 'c', { x: 0, y: 0 }, 12)
    invariants(out, 12)
    const c = out.find((t) => t.id === 'c')!
    expect([c.x, c.y]).toEqual([0, 0]) // the dragged tile claims the spot it was dropped on
    expect(out.find((t) => t.id === 'a')!.y).toBe(3) // pushed below it
  })
  it('resizing grows into neighbours by pushing them down, and respects the minimum', () => {
    const mins: Mins = { a: { w: 3, h: 3 } }
    const grown = resizeTile(base(), 'a', { w: 8, h: 6 }, 12, mins)
    invariants(grown, 12, mins)
    expect(grown.find((t) => t.id === 'b')!.y).toBeGreaterThanOrEqual(6)
    const shrunk = resizeTile(base(), 'a', { w: 1, h: 1 }, 12, mins)
    expect([shrunk.find((t) => t.id === 'a')!.w, shrunk.find((t) => t.id === 'a')!.h]).toEqual([3, 3])
  })
  it('a tile is never wider than the grid, and is pulled back onto it', () => {
    expect(clampTile({ id: 'x', x: 10, y: -3, w: 99, h: 2 }, 12)).toEqual({ id: 'x', x: 0, y: 0, w: 12, h: 2 })
  })
  it('first fit finds the earliest hole', () => {
    expect(firstFit(base(), { w: 4, h: 2 }, 12)).toEqual({ x: 8, y: 0 })
    expect(firstFit(base(), { w: 12, h: 2 }, 12)).toEqual({ x: 0, y: 7 })
  })
  it('reflow to fewer columns keeps every tile on the grid and nothing overlapping', () => {
    const wide: Tile[] = [
      { id: 'a', x: 0, y: 0, w: 6, h: 4 },
      { id: 'b', x: 6, y: 0, w: 6, h: 4 },
      { id: 'c', x: 0, y: 4, w: 12, h: 2 }
    ]
    const out = reflow(wide, 12, 4, { a: { w: 3, h: 2 } })
    invariants(out, 4, { a: { w: 3, h: 2 } })
  })
})

describe('sync with the objects on the Desk', () => {
  it('a Desk opened for the first time tiles every object (owner decision b)', () => {
    const objs = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id, i) => ({ id, preferred: { w: 3 + (i % 3), h: 4 + i } }))
    const l = syncLayout(null, objs, 12)
    expect(Object.keys(l.items).sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
    invariants(toTiles(l), 12)
  })
  it('drops tiles whose object is gone, places new ones, keeps the rest where they were', () => {
    const stored = { cols: 12, items: { keep: { x: 0, y: 0, w: 6, h: 4 }, gone: { x: 6, y: 0, w: 6, h: 4 } } }
    const l = syncLayout(stored, [{ id: 'keep', preferred: { w: 6, h: 4 } }, { id: 'new', preferred: { w: 4, h: 3 } }], 12)
    expect(Object.keys(l.items).sort()).toEqual(['keep', 'new'])
    expect(l.items.keep).toEqual({ x: 0, y: 0, w: 6, h: 4 })
    invariants(toTiles(l), 12)
  })
  it('a stored layout from a wider window reflows to the current column count', () => {
    const stored = { cols: 16, items: { a: { x: 0, y: 0, w: 8, h: 4 }, b: { x: 8, y: 0, w: 8, h: 4 } } }
    const l = syncLayout(stored, [{ id: 'a', preferred: { w: 8, h: 4 } }, { id: 'b', preferred: { w: 8, h: 4 } }], 8)
    expect(l.cols).toBe(8)
    invariants(toTiles(l), 8)
  })
})

describe('randomised sequences keep every invariant', () => {
  // A small seeded PRNG so a failure is reproducible.
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i: 200 random moves, resizes and reflows', (seed) => {
    const r = rng(seed)
    let cols = 12
    const ids = Array.from({ length: 9 }, (_, i) => `t${i}`)
    const mins: Mins = Object.fromEntries(ids.map((id, i) => [id, { w: 1 + (i % 3), h: 2 + (i % 4) }]))
    let tiles = toTiles(syncLayout(null, ids.map((id) => ({ id, preferred: { w: 2 + Math.floor(r() * 5), h: 2 + Math.floor(r() * 6) } })), cols, mins))
    for (let step = 0; step < 200; step++) {
      const id = ids[Math.floor(r() * ids.length)]!
      const op = r()
      if (op < 0.45) tiles = moveTile(tiles, id, { x: Math.floor(r() * cols), y: Math.floor(r() * 30) }, cols, mins)
      else if (op < 0.9) tiles = resizeTile(tiles, id, { w: 1 + Math.floor(r() * cols), h: 1 + Math.floor(r() * 12) }, cols, mins)
      else {
        const next = [4, 6, 8, 12, 16, 24][Math.floor(r() * 6)]!
        tiles = reflow(tiles, cols, next, mins)
        cols = next
      }
      invariants(tiles, cols, mins)
    }
  })
  it('is deterministic', () => {
    const objs = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, preferred: { w: 3 + i, h: 2 + i } }))
    expect(syncLayout(null, objs, 10)).toEqual(syncLayout(null, objs, 10))
    expect(compact(toTiles(syncLayout(null, objs, 10)))).toEqual(compact(toTiles(syncLayout(null, objs, 10))))
  })
})

describe('minimum sizes (shared by the canvas and Workcentre)', () => {
  it('every catalog kind has a usable minimum and none is above a sensible ceiling', () => {
    for (const entry of WIDGET_CATALOG) {
      const m = minSizeFor(entry.kind)
      expect(m.w, entry.kind).toBeGreaterThanOrEqual(BASE_MIN.w)
      expect(m.h, entry.kind).toBeGreaterThanOrEqual(BASE_MIN.h)
      expect(m.w, entry.kind).toBeLessThanOrEqual(400)
      expect(m.h, entry.kind).toBeLessThanOrEqual(300)
    }
  })
  it('every minimum is a multiple of the canvas GRID, so the floor is itself a snapped size', () => {
    for (const entry of WIDGET_CATALOG) {
      const m = minSizeFor(entry.kind)
      expect(m.w % 20, entry.kind).toBe(0)
      expect(m.h % 20, entry.kind).toBe(0)
    }
  })

  it('full editors need more room than the base', () => {
    for (const k of ['doc', 'sheet', 'slides', 'design', 'draw', 'map']) expect(minSizeFor(k).w).toBeGreaterThan(BASE_MIN.w)
  })
})
