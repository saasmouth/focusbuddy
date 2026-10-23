// Stacking order (Deck and Design share slideOps): undo must be able to put it
// back, and a multi-selection keeps its own relative order (f0's review).
import { describe, expect, it } from 'vitest'
import { reorderMany, reorderZ } from '../../src/renderer/src/components/documents/slides/slideOps'
import type { Slide } from '../../src/shared/types'

const el = (id: string, z: number) => ({ id, type: 'shape' as const, shape: 'rect' as const, x: 0, y: 0, w: 10, h: 10, z })
const slideOf = (...els: ReturnType<typeof el>[]): Slide => ({ id: 's', notes: '', elements: els }) as unknown as Slide
const zs = (s: Slide): Record<string, number> => Object.fromEntries((s.elements ?? []).map((e) => [e.id, e.z]))

describe('reorderZ leaves the body it was given untouched (the undo snapshot)', () => {
  for (const dir of ['front', 'backmost', 'forward', 'back'] as const) {
    it(dir, () => {
      const before = slideOf(el('a', 1), el('b', 2), el('c', 3))
      const snapshot = JSON.stringify(before)
      reorderZ(before, 'b', dir)
      expect(JSON.stringify(before), 'the previous body still has the old stacking').toBe(snapshot)
    })
  }
})

describe('reorderMany keeps the selection’s own order', () => {
  it('to front: B then A selected, A was under B, A stays under B, both above C', () => {
    const s = reorderMany(slideOf(el('a', 1), el('b', 2), el('c', 3)), ['b', 'a'], 'front')
    const z = zs(s)
    expect(z.a).toBeLessThan(z.b)
    expect(z.a).toBeGreaterThan(z.c)
  })
  it('to back: keeps A under B, both below C', () => {
    const s = reorderMany(slideOf(el('c', 1), el('a', 2), el('b', 3)), ['b', 'a'], 'backmost')
    const z = zs(s)
    expect(z.a).toBeLessThan(z.b)
    expect(z.b).toBeLessThan(z.c)
  })
  it('does not touch the body it was given', () => {
    const before = slideOf(el('a', 1), el('b', 2), el('c', 3))
    const snapshot = JSON.stringify(before)
    reorderMany(before, ['a', 'b'], 'front')
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})
