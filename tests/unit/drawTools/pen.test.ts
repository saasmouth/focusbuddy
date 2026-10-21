import { describe, it, expect } from 'vitest'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { harness } from './harness'

const last = (h: ReturnType<typeof harness>): DrawPathNode => h.objects()[h.objects().length - 1] as DrawPathNode

describe('pen tool (P)', () => {
  it('clicks place corner points; clicking the first point closes the path with the fill', () => {
    const h = harness()
    h.tool('pen')
    h.click(10, 10)
    h.click(100, 10)
    h.click(100, 100)
    expect(h.objects()).toHaveLength(0) // nothing in the document until finished
    h.click(12, 11) // within 8px of the first point
    const p = last(h)
    expect(p.shapeKind).toBe('pen')
    expect(p.path.subpaths[0].closed).toBe(true)
    expect(p.path.subpaths[0].nodes).toHaveLength(3)
    expect(p.fill).toEqual({ type: 'solid', color: '#6d5dfc' })
    expect(h.state().selection).toEqual([p.id])
    expect(h.state().past).toHaveLength(1)
  })

  it('a drag after placing a point pulls out mirrored handles', () => {
    const h = harness()
    h.tool('pen')
    h.drag([50, 50], [70, 40])
    expect(h.state().pen?.[0]).toMatchObject({ x: 50, y: 50, outX: 70, outY: 40, inX: 30, inY: 60 })
  })

  it('Enter, Escape and a double-click each finish an OPEN path with no fill', () => {
    for (const finish of ['enter', 'escape', 'dblclick'] as const) {
      const h = harness()
      h.tool('pen')
      h.click(10, 10)
      h.click(60, 60)
      if (finish === 'enter') h.key('Enter')
      else if (finish === 'escape') h.key('Escape')
      else h.dblclick()
      const p = last(h)
      expect(p.path.subpaths[0].closed).toBe(false)
      expect(p.fill).toEqual({ type: 'none' })
      expect(p.stroke?.width).toBe(2)
      expect(h.state().pen).toBeNull()
    }
  })

  it('a single point is discarded, not committed', () => {
    const h = harness()
    h.tool('pen')
    h.click(10, 10)
    h.key('Enter')
    expect(h.objects()).toHaveLength(0)
    expect(h.state().pen).toBeNull()
  })
})
