import { describe, it, expect } from 'vitest'
import { syncLayout, toTiles, collides } from '../../src/renderer/src/lib/workcentreLayout'

describe('Workcentre: a tile dropped at a cell claims it', () => {
  const objects = [
    { id: 'a', preferred: { w: 4, h: 4 } },
    { id: 'b', preferred: { w: 4, h: 4 } }
  ]
  it('without a pending cell, a new object goes to first fit', () => {
    const l = syncLayout(null, [...objects, { id: 'n', preferred: { w: 4, h: 4 } }], 12)
    expect(l.items.n).toMatchObject({ x: 8, y: 0 })
  })
  it('a new object with a pending cell lands there, and nothing overlaps', () => {
    const l = syncLayout(null, [...objects, { id: 'n', preferred: { w: 4, h: 4 } }], 12, {}, { n: { x: 0, y: 0 } })
    expect(l.items.n).toMatchObject({ x: 0, y: 0 })
    const t = toTiles(l)
    for (const p of t) for (const q of t) if (p.id !== q.id) expect(collides(p, q)).toBe(false)
  })
  it('an object the layout already tiled still moves to its pending cell (a sync can land between the create and the request)', () => {
    const first = syncLayout(null, [...objects, { id: 'n', preferred: { w: 4, h: 4 } }], 12)
    const again = syncLayout(first, [...objects, { id: 'n', preferred: { w: 4, h: 4 } }], 12, {}, { n: { x: 4, y: 0 } })
    expect(again.items.n).toMatchObject({ x: 4, y: 0 })
  })
  it('several dropped at one cell: the first takes it, the rest flow below', () => {
    const objs = [...objects, { id: 'n1', preferred: { w: 4, h: 4 } }, { id: 'n2', preferred: { w: 4, h: 4 } }]
    const l = syncLayout(null, objs, 12, {}, { n1: { x: 8, y: 0 }, n2: { x: 8, y: 0 } })
    expect(l.items.n1).toMatchObject({ x: 8, y: 0 })
    expect(l.items.n2!.x).toBe(8)
    expect(l.items.n2!.y).toBeGreaterThanOrEqual(4)
  })
})
