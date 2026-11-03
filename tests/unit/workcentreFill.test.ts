// The Workcentre fills its dead space (owner, 2026-11-03): "make it so widgets
// auto grow to fill dead space … it should expand them horizontally and
// vertically to fill space in any direction", and snap like the multi-app focus
// view, with a preview of where a dragged or dropped thing will land.
//
// fillLayout is DISPLAY-ONLY: the stored layout keeps each tile's own size, and
// what you see is that layout grown into the free space around it. A size set
// by hand (fixW / fixH, from a resize) is never grown on that axis, so shrinking
// a tile gives its room to the neighbours instead of springing back.

import { describe, expect, it } from 'vitest'
import {
  clampTile,
  collides,
  compact,
  fillWithCornerKeepOut,
  KEEP_OUT,
  fillLayout,
  fitAgain,
  gridRows,
  moveTile,
  placeAt,
  reflow,
  resizeFromShown,
  resizeTile,
  rowsForHeight,
  syncLayout,
  tileRectPx,
  toTiles,
  ROW_PX,
  GAP_PX,
  type Tile
} from '../../src/renderer/src/lib/workcentreLayout'

const byId = (ts: Tile[]): Record<string, Tile> => Object.fromEntries(ts.map((t) => [t.id, t]))
const strip = (t: Tile): Omit<Tile, 'fixW' | 'fixH'> => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h })

/** Can tile t grow by one cell in any direction it is allowed to, into free space inside the region? */
function canGrow(t: Tile, all: Tile[], cols: number, rows: number): string | null {
  const others = all.filter((o) => o.id !== t.id)
  const free = (r: { x: number; y: number; w: number; h: number }): boolean => !others.some((o) => collides(r, o))
  if (!t.fixW && t.x + t.w < cols && free({ x: t.x + t.w, y: t.y, w: 1, h: t.h })) return 'right'
  if (!t.fixW && t.x > 0 && free({ x: t.x - 1, y: t.y, w: 1, h: t.h })) return 'left'
  if (!t.fixH && t.y + t.h < rows && free({ x: t.x, y: t.y + t.h, w: t.w, h: 1 })) return 'down'
  if (!t.fixH && t.y > 0 && free({ x: t.x, y: t.y - 1, w: t.w, h: 1 })) return 'up'
  return null
}

describe('fillLayout — dead space is filled in every direction', () => {
  it('a lone tile fills the whole view', () => {
    const shown = fillLayout([{ id: 'a', x: 0, y: 0, w: 3, h: 4 }], 12, 10)
    expect(shown.map(strip)).toEqual([{ id: 'a', x: 0, y: 0, w: 12, h: 10 }])
  })

  it('a row that stops short of the right edge widens to it', () => {
    const s = byId(fillLayout([{ id: 'a', x: 0, y: 0, w: 4, h: 6 }, { id: 'b', x: 4, y: 0, w: 4, h: 6 }], 12, 6))
    expect(s.a!.x + s.a!.w).toBe(s.b!.x) // still touching
    expect(s.b!.x + s.b!.w).toBe(12) // the row reaches the edge
  })

  it('a tile beside a taller neighbour grows down into the hole under it', () => {
    const s = byId(fillLayout([{ id: 'a', x: 0, y: 0, w: 6, h: 4 }, { id: 'b', x: 6, y: 0, w: 6, h: 10 }], 12, 0))
    expect(s.a).toMatchObject({ x: 0, y: 0, w: 6, h: 10 })
    expect(s.b).toMatchObject({ x: 6, y: 0, w: 6, h: 10 })
  })

  it('a gap to the LEFT of a tile is taken by growing left', () => {
    // b sits below a short a, but starts at column 3; columns 0–2 under a are free.
    const s = byId(fillLayout([{ id: 'a', x: 0, y: 0, w: 12, h: 2 }, { id: 'b', x: 3, y: 2, w: 9, h: 4 }], 12, 0))
    expect(s.b).toMatchObject({ x: 0, y: 2, w: 12, h: 4 })
  })

  it('the last row stretches to the bottom of the view; content taller than the view is not shortened', () => {
    const tiles: Tile[] = [{ id: 'a', x: 0, y: 0, w: 12, h: 4 }, { id: 'b', x: 0, y: 4, w: 12, h: 4 }]
    expect(byId(fillLayout(tiles, 12, 20)).b).toMatchObject({ y: 4, h: 16 })
    expect(byId(fillLayout(tiles, 12, 5)).b).toMatchObject({ y: 4, h: 4 })
  })

  it('never grows a hand-set axis: the neighbour takes the room instead', () => {
    // a was made narrow by hand (fixW); b, beside it, is not fixed.
    const s = byId(fillLayout([{ id: 'a', x: 0, y: 0, w: 3, h: 6, fixW: true }, { id: 'b', x: 3, y: 0, w: 3, h: 6 }], 12, 6))
    expect(s.a).toMatchObject({ x: 0, w: 3 })
    expect(s.b).toMatchObject({ x: 3, w: 9 })
    // fixH: the height stays, even with a whole view of room below.
    expect(byId(fillLayout([{ id: 'c', x: 0, y: 0, w: 4, h: 3, fixH: true }], 12, 20)).c).toMatchObject({ y: 0, h: 3, w: 12 })
  })

  it('does not change the stored tiles it was given', () => {
    const base: Tile[] = [{ id: 'a', x: 0, y: 0, w: 3, h: 4 }]
    fillLayout(base, 12, 10)
    expect(base).toEqual([{ id: 'a', x: 0, y: 0, w: 3, h: 4 }])
  })
})

describe('fillLayout — invariants after randomised layouts', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('seed %i', (seed) => {
    const r = rng(seed)
    const cols = 4 + Math.floor(r() * 16)
    const n = 1 + Math.floor(r() * 9)
    const objects = Array.from({ length: n }, (_, i) => ({ id: `o${i}`, preferred: { w: 1 + Math.floor(r() * Math.min(cols, 8)), h: 1 + Math.floor(r() * 10) } }))
    let base = toTiles(syncLayout(null, objects, cols))
    for (let i = 0; i < 20; i++) {
      const t = base[Math.floor(r() * base.length)]!
      base = r() < 0.5 ? moveTile(base, t.id, { x: Math.floor(r() * cols), y: Math.floor(r() * 12) }, cols) : resizeTile(base, t.id, { w: 1 + Math.floor(r() * cols), h: 1 + Math.floor(r() * 8) }, cols)
    }
    base = base.map((t) => ({ ...t, ...(r() < 0.3 ? { fixW: true } : {}), ...(r() < 0.3 ? { fixH: true } : {}) }))
    const viewRows = Math.floor(r() * 30)
    const shown = fillLayout(base, cols, viewRows)
    const rows = Math.max(viewRows, gridRows(base))
    const b = byId(base)
    expect(shown).toHaveLength(base.length)
    for (const t of shown) {
      const o = b[t.id]!
      // on the grid, inside the region
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.x + t.w).toBeLessThanOrEqual(cols)
      expect(t.y + t.h).toBeLessThanOrEqual(rows)
      // only ever grows: the stored rectangle is inside the shown one
      expect(t.x <= o.x && t.y <= o.y && t.x + t.w >= o.x + o.w && t.y + t.h >= o.y + o.h, `${t.id} contains its stored rect`).toBe(true)
      // a hand-set axis is exactly as set
      if (o.fixW) expect([t.x, t.w]).toEqual([o.x, o.w])
      if (o.fixH) expect([t.y, t.h]).toEqual([o.y, o.h])
      // maximal: nothing left that this tile could still grow into
      expect(canGrow(t, shown, cols, rows), `${t.id} could still grow`).toBeNull()
    }
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(collides(shown[i]!, shown[j]!)).toBe(false)
    // deterministic, whatever order the tiles arrive in
    const shuffled = [...base].sort(() => r() - 0.5)
    expect(byId(fillLayout(shuffled, cols, viewRows))).toEqual(byId(shown))
  })
})

describe('hand-set sizes travel with the tile', () => {
  it('clampTile, moves, resizes, compaction, reflow and sync keep fixW / fixH', () => {
    const t: Tile = { id: 'a', x: 0, y: 0, w: 4, h: 4, fixW: true, fixH: true }
    expect(clampTile(t, 12)).toMatchObject({ fixW: true, fixH: true })
    expect(clampTile({ id: 'b', x: 0, y: 0, w: 4, h: 4 }, 12)).not.toHaveProperty('fixW')
    const tiles: Tile[] = [t, { id: 'b', x: 4, y: 0, w: 4, h: 4 }]
    expect(byId(moveTile(tiles, 'a', { x: 6, y: 2 }, 12)).a).toMatchObject({ fixW: true, fixH: true })
    expect(byId(resizeTile(tiles, 'b', { w: 6, h: 2 }, 12)).a).toMatchObject({ fixW: true, fixH: true })
    expect(byId(compact(tiles)).a).toMatchObject({ fixW: true, fixH: true })
    expect(byId(reflow(tiles, 12, 8)).a).toMatchObject({ fixW: true, fixH: true })
    const stored = { cols: 12, items: { a: { x: 0, y: 0, w: 4, h: 4, fixW: true }, b: { x: 4, y: 0, w: 4, h: 4 } } }
    const synced = syncLayout(stored, [{ id: 'a', preferred: { w: 1, h: 1 } }, { id: 'b', preferred: { w: 1, h: 1 } }], 12)
    expect(synced.items.a).toEqual({ x: 0, y: 0, w: 4, h: 4, fixW: true })
    expect(synced.items.b).toEqual({ x: 4, y: 0, w: 4, h: 4 })
  })

  it('fitAgain hands a tile back to auto-fill', () => {
    const tiles: Tile[] = [{ id: 'a', x: 0, y: 0, w: 3, h: 3, fixW: true, fixH: true }]
    const back = fitAgain(tiles, 'a')
    expect(back[0]).toEqual({ id: 'a', x: 0, y: 0, w: 3, h: 3 })
    expect(fillLayout(back, 12, 10)[0]).toMatchObject({ w: 12, h: 10 })
  })
})

describe('resizeFromShown — a resize starts from the tile you SEE', () => {
  const base: Tile[] = [{ id: 'a', x: 0, y: 0, w: 3, h: 3 }, { id: 'b', x: 0, y: 3, w: 3, h: 3 }]
  const shown = fillLayout(base, 12, 6) // a shows as 12 × 3, b as 12 × 3

  it("dragging the right edge sets the width from the shown width and fixes only the width", () => {
    const s = byId(shown)
    const out = byId(resizeFromShown(base, shown, 'a', { w: s.a!.w - 4, h: s.a!.h }, 'r', 12))
    expect(out.a).toMatchObject({ x: 0, w: 8, fixW: true })
    expect(out.a!.fixH).toBeUndefined()
    // b is untouched, and in the filled view a no longer springs back to full width
    expect(byId(fillLayout(Object.values(out), 12, 6)).a).toMatchObject({ w: 8 })
  })

  it('the bottom edge fixes only the height; the corner fixes both', () => {
    const s = byId(shown)
    expect(byId(resizeFromShown(base, shown, 'a', { w: s.a!.w, h: 5 }, 'b', 12)).a).toMatchObject({ h: 5, fixH: true })
    expect(byId(resizeFromShown(base, shown, 'a', { w: 6, h: 5 }, 'rb', 12)).a).toMatchObject({ w: 6, h: 5, fixW: true, fixH: true })
  })

  it('a tile that grew LEFT keeps its shown left edge when resized from the right', () => {
    const b2: Tile[] = [{ id: 'top', x: 0, y: 0, w: 12, h: 2, fixH: true }, { id: 'c', x: 5, y: 2, w: 3, h: 2, fixH: true }]
    const sh = fillLayout(b2, 12, 4)
    expect(byId(sh).c).toMatchObject({ x: 0, w: 12 })
    expect(byId(resizeFromShown(b2, sh, 'c', { w: 6, h: 2 }, 'r', 12)).c).toMatchObject({ x: 0, w: 6, fixW: true })
  })
})

describe('placeAt — the drop preview is exactly where the drop lands', () => {
  it.each([
    [{ x: 0, y: 0 }],
    [{ x: 5, y: 3 }],
    [{ x: 11, y: 40 }]
  ])('cell %j', (cell) => {
    const stored = { cols: 12, items: { a: { x: 0, y: 0, w: 6, h: 4 }, b: { x: 6, y: 0, w: 6, h: 6 }, c: { x: 0, y: 4, w: 4, h: 4 } } }
    const objects = ['a', 'b', 'c'].map((id) => ({ id, preferred: { w: 1, h: 1 } }))
    const size = { w: 4, h: 6 }
    // What the view previews while the thing is held over the cell …
    const preview = placeAt(toTiles(stored), { id: 'new', x: 0, y: 0, ...size }, cell, 12)
    // … and what syncLayout does once the dropped object exists with a pending cell.
    const landed = toTiles(syncLayout(stored, [...objects, { id: 'new', preferred: size }], 12, {}, { new: cell }))
    expect(byId(preview)).toEqual(byId(landed))
    expect(byId(preview).new!.x).toBe(Math.min(cell.x, 12 - size.w))
  })
})

describe('geometry helpers', () => {
  it('rowsForHeight is the number of whole rows that fit', () => {
    expect(rowsForHeight(0)).toBe(0)
    expect(rowsForHeight(ROW_PX)).toBe(1)
    expect(rowsForHeight(ROW_PX * 10 + GAP_PX * 9)).toBe(10)
    expect(rowsForHeight(ROW_PX * 10 + GAP_PX * 9 - 1)).toBe(9)
  })
  it('tileRectPx places a tile on the same pitch as the grid', () => {
    expect(tileRectPx({ x: 2, y: 1, w: 3, h: 2 }, 100)).toEqual({ left: 2 * (100 + GAP_PX), top: ROW_PX + GAP_PX, width: 3 * 100 + 2 * GAP_PX, height: 2 * ROW_PX + GAP_PX })
  })
})

describe('fillWithCornerKeepOut — room for the Plexii pill under the bottom-right tile only', () => {
  it('a short desk: the bottom-right tile stops a strip short; every other tile reaches the bottom', () => {
    const base: Tile[] = [{ id: 'a', x: 0, y: 0, w: 6, h: 4 }, { id: 'b', x: 6, y: 0, w: 6, h: 4 }]
    const { shown, keep } = fillWithCornerKeepOut(base, 12, 10, 2)
    const s = byId(shown)
    expect(s.a).toMatchObject({ x: 0, y: 0, w: 6, h: 10 })
    expect(s.b).toMatchObject({ x: 6, y: 0, w: 6, h: 8 })
    expect(keep).toMatchObject({ id: KEEP_OUT, x: 6, y: 8, w: 6, h: 2 }) // exactly under b
  })

  it('nothing is stranded: the rest of the corner column stays with the tile that took it', () => {
    // a narrow column of tiles on the right above a wide tile: fill gives the column to the wide one.
    const base: Tile[] = [
      { id: 'left', x: 0, y: 0, w: 6, h: 6 },
      { id: 'top', x: 6, y: 0, w: 6, h: 3 },
      { id: 'wide', x: 6, y: 3, w: 4, h: 3 }
    ]
    const { shown, keep } = fillWithCornerKeepOut(base, 12, 10, 2)
    const s = byId(shown)
    const all = [...shown, keep!]
    // every cell of the region is a tile or the keep-out: no dead column
    for (let y = 0; y < 10; y++) for (let x = 0; x < 12; x++) expect(all.some((t) => collides(t, { x, y, w: 1, h: 1 })), `cell ${x},${y}`).toBe(true)
    expect(keep!.x + keep!.w).toBe(12)
    expect(s.left!.y + s.left!.h).toBe(10)
  })

  it('a tile whose own size already reaches the corner keeps it; the strip goes below the content', () => {
    const base: Tile[] = [{ id: 'a', x: 0, y: 0, w: 12, h: 12 }]
    const { shown, keep } = fillWithCornerKeepOut(base, 12, 10, 2)
    expect(byId(shown).a).toMatchObject({ x: 0, y: 0, w: 12, h: 12 }) // never shrunk below its stored size
    expect(keep).toMatchObject({ x: 0, y: 12, w: 12, h: 2 })
  })

  it('no pill (h 0): the plain fill, no keep-out', () => {
    const base: Tile[] = [{ id: 'a', x: 0, y: 0, w: 3, h: 3 }]
    expect(fillWithCornerKeepOut(base, 12, 10, 0)).toEqual({ shown: fillLayout(base, 12, 10), keep: null })
  })

  it('the stored tiles are not changed', () => {
    const base: Tile[] = [{ id: 'a', x: 0, y: 0, w: 3, h: 3 }]
    fillWithCornerKeepOut(base, 12, 10, 2)
    expect(base).toEqual([{ id: 'a', x: 0, y: 0, w: 3, h: 3 }])
  })
})
