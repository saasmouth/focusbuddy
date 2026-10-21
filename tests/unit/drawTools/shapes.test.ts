import { describe, it, expect } from 'vitest'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { nodeBounds } from '../../../src/shared/draw/ops'
import { harness } from './harness'

const SHAPES = [
  { id: 'rect', kind: 'rect', params: {} },
  { id: 'roundRect', kind: 'roundRect', params: { cornerRadius: 9 } },
  { id: 'ellipse', kind: 'ellipse', params: {} },
  { id: 'polygon', kind: 'polygon', params: { sides: 6 } },
  { id: 'star', kind: 'star', params: { sides: 5, innerRatio: 0.5 } }
] as const

describe.each(SHAPES)('$id tool', ({ id, kind, params }) => {
  it('a drag commits a live shape filling the dragged box, selects it, and returns to Select', () => {
    const h = harness()
    h.tool(id)
    h.drag([20, 30], [120, 90])
    const p = h.objects()[0] as DrawPathNode
    expect(p.shapeKind).toBe(kind)
    expect(p).toMatchObject(params)
    const b = nodeBounds(p)
    expect(b.x).toBeCloseTo(20, 6)
    expect(b.y).toBeCloseTo(30, 6)
    expect(b.w).toBeCloseTo(100, 6)
    expect(b.h).toBeCloseTo(60, 6)
    expect(p.fill).toEqual({ type: 'solid', color: '#6d5dfc' })
    expect(h.state().selection).toEqual([p.id])
    expect(h.state().tool).toBe('select')
    expect(h.state().past).toHaveLength(1)
  })

  it('Shift makes it square', () => {
    const h = harness()
    h.tool(id)
    h.drag([20, 30], [120, 60], { shift: true })
    const b = nodeBounds(h.objects()[0])
    expect(b.w).toBeCloseTo(b.h, 6)
    expect(b.w).toBeCloseTo(100, 6)
  })

  it('a click without a drag makes nothing and keeps the tool', () => {
    const h = harness()
    h.tool(id)
    h.click(20, 30)
    expect(h.objects()).toHaveLength(0)
    expect(h.state().tool).toBe(id)
  })
})

describe('line tool (L)', () => {
  it('draws from the press point to the release point, unfilled, with the default stroke', () => {
    const h = harness()
    h.tool('line')
    h.drag([20, 30], [120, 90])
    const p = h.objects()[0] as DrawPathNode
    expect(p.shapeKind).toBe('line')
    expect(p.fill).toEqual({ type: 'none' })
    expect(p.stroke).toEqual({ paint: { type: 'solid', color: '#1c1917' }, width: 2, cap: 'round' })
    expect(p.path.subpaths[0].nodes.map((n) => [n.x, n.y])).toEqual([
      [20, 30],
      [120, 90]
    ])
  })
})
