import { describe, it, expect } from 'vitest'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { blank, harness, rect } from './harness'

const path = (h: ReturnType<typeof harness>, id: string): DrawPathNode => h.objects().find((o) => o.id === id) as DrawPathNode

describe('edit points tool (A)', () => {
  it('drags an anchor of the selected path; a live shape becomes a plain path', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.click(150, 150)
    h.tool('node')
    h.drag([100, 100], [80, 70])
    const p = path(h, 'r')
    expect(p.path.subpaths[0].nodes[0]).toMatchObject({ x: 80, y: 70 })
    expect(p.shapeKind).toBe('path')
  })

  it('a handle drag mirrors its partner; Alt breaks the pair', () => {
    const curve = {
      id: 'c',
      type: 'path',
      path: { subpaths: [{ closed: false, nodes: [{ x: 100, y: 100, inX: 80, inY: 100, outX: 120, outY: 100 }, { x: 200, y: 100 }] }] },
      fill: { type: 'none' },
      stroke: { paint: { type: 'solid', color: '#000' }, width: 2 }
    }
    const h = harness(blank([curve]))
    h.ed.ctx.select(['c'])
    h.tool('node')
    h.drag([120, 100], [120, 130])
    expect(path(h, 'c').path.subpaths[0].nodes[0]).toMatchObject({ outX: 120, outY: 130, inX: 80, inY: 70 })
    h.drag([120, 130], [140, 130], { alt: true })
    expect(path(h, 'c').path.subpaths[0].nodes[0]).toMatchObject({ outX: 140, outY: 130, inX: 80, inY: 70 })
  })

  it('a click away from any point selects the path under the pointer', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40), rect('b', 100, 100, 40, 40)]))
    h.tool('node')
    h.click(120, 120)
    expect(h.state().selection).toEqual(['b'])
    h.click(300, 250)
    expect(h.state().selection).toEqual([])
  })

  it('keeps its existing undo behaviour: a point drag opens no undo step of its own', () => {
    // Documented as found: the drag's previews join the step before it, so one
    // undo takes back both. Kept unchanged by the refactor; flagged for a fix.
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.click(150, 150)
    h.tool('node')
    h.drag([100, 100], [80, 70])
    expect(h.state().past).toHaveLength(0)
  })
})
