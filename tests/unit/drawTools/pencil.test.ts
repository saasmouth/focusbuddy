import { describe, it, expect } from 'vitest'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { harness } from './harness'

describe('pencil tool (N)', () => {
  it('a freehand stroke becomes a smoothed, simplified open path in the brush colour', () => {
    const h = harness()
    h.tool('pencil')
    h.down(10, 10)
    for (let i = 1; i <= 40; i++) h.move(10 + i * 5, 10 + Math.sin(i / 4) * 30)
    h.up(210, 10)
    const p = h.objects()[0] as DrawPathNode
    expect(p.shapeKind).toBe('pencil')
    expect(p.fill).toEqual({ type: 'none' })
    expect(p.stroke).toMatchObject({ width: 2, cap: 'round', join: 'round', paint: { type: 'solid', color: '#6d5dfc' } })
    expect(p.path.subpaths[0].closed).toBe(false)
    // Simplified: far fewer anchors than raw points, with bezier handles.
    expect(p.path.subpaths[0].nodes.length).toBeLessThan(40)
    expect(p.path.subpaths[0].nodes.some((n) => n.outX != null)).toBe(true)
    expect(h.state().past).toHaveLength(1)
  })

  it('a click with no movement draws nothing', () => {
    const h = harness()
    h.tool('pencil')
    h.click(10, 10)
    expect(h.objects()).toHaveLength(0)
  })

  it('uses the current stroke when one is set', () => {
    const h = harness()
    h.ed.store.setState({ stroke: { paint: { type: 'solid', color: '#ff0000' }, width: 7 } })
    h.tool('pencil')
    h.drag([10, 10], [100, 100], {}, 6)
    expect((h.objects()[0] as DrawPathNode).stroke).toEqual({ paint: { type: 'solid', color: '#ff0000' }, width: 7 })
  })
})
