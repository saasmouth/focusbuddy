// WP-PATH pen extensions: continue / close / connect open paths, automatic
// add and delete on selected paths, Alt / Shift / Space while placing, the
// last-point click, ⌘Z inside the pen, and ⌘ borrowing Direct Selection.

import { describe, it, expect } from 'vitest'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { blank, harness, rect } from './harness'

const obj = (h: ReturnType<typeof harness>, id: string): DrawPathNode => h.objects().find((o) => o.id === id) as DrawPathNode
const pts = (h: ReturnType<typeof harness>, id: string): number[][] => obj(h, id).path.subpaths[0].nodes.map((n) => [n.x, n.y])

function line(id: string, p: Array<[number, number]>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'path', path: { subpaths: [{ closed: false, nodes: p.map(([x, y]) => ({ x, y })) }] }, fill: { type: 'none' }, stroke: { paint: { type: 'solid', color: '#ff0000' }, width: 5 }, ...extra }
}

describe('pen: continuing, closing and connecting', () => {
  it('clicking the END of an open path continues it; the path keeps its id and appearance', () => {
    const h = harness(blank([line('l', [[10, 10], [100, 10]])]))
    h.tool('pen')
    h.click(100, 10)
    h.click(100, 100)
    h.key('Enter')
    expect(h.objects()).toHaveLength(1)
    expect(pts(h, 'l')).toEqual([
      [10, 10],
      [100, 10],
      [100, 100]
    ])
    expect(obj(h, 'l').stroke?.width).toBe(5)
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Pen')
  })

  it('continuing from the START extends that end; clicking the far end closes it', () => {
    const h = harness(blank([line('l', [[10, 10], [100, 10]])]))
    h.tool('pen')
    h.click(10, 10)
    h.click(10, 100)
    h.click(100, 10) // the other end
    const sp = obj(h, 'l').path.subpaths[0]
    expect(sp.closed).toBe(true)
    expect(sp.nodes.map((n) => [n.x, n.y])).toEqual([
      [100, 10],
      [10, 10],
      [10, 100]
    ])
  })

  it('finishing on another open path\'s end joins the two paths into one', () => {
    const h = harness(blank([line('a', [[10, 10], [100, 10]]), line('b', [[200, 100], [300, 100]], { stroke: { paint: { type: 'solid', color: '#00f' }, width: 3 } })]))
    h.tool('pen')
    h.click(100, 10) // continue a
    h.click(150, 50)
    h.click(200, 100) // b's start
    expect(h.objects()).toHaveLength(1)
    const only = h.objects()[0] as DrawPathNode
    expect(only.path.subpaths[0].nodes.map((n) => [n.x, n.y])).toEqual([
      [300, 100],
      [200, 100],
      [150, 50],
      [100, 10],
      [10, 10]
    ])
    expect(h.state().past).toHaveLength(1)
  })

  it('a NEW path ending on an open end joins onto that path, which keeps its own look', () => {
    const h = harness(blank([line('b', [[200, 100], [300, 100]])]))
    h.tool('pen')
    h.click(50, 50)
    h.click(120, 50)
    h.click(200, 100)
    expect(h.objects()).toHaveLength(1)
    expect(obj(h, 'b').path.subpaths[0].nodes).toHaveLength(4)
    expect(obj(h, 'b').stroke?.width).toBe(5)
  })
})

describe('pen: automatic add and delete over a selected path', () => {
  it('a click on a selected path\'s segment adds an anchor; on its anchor deletes it', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.click(150, 150) // select it with the Selection tool
    h.tool('pen')
    h.click(150, 100)
    expect(obj(h, 'r').path.subpaths[0].nodes).toHaveLength(5)
    expect(h.state().past.at(-1)!.label).toBe('Add anchor point')
    expect(h.state().pen).toBeNull()
    h.click(150, 100)
    expect(obj(h, 'r').path.subpaths[0].nodes).toHaveLength(4)
    expect(h.state().past.at(-1)!.label).toBe('Delete anchor point')
  })

  it('an UNselected path is drawn over, not edited', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('pen')
    h.click(150, 100)
    expect(h.state().pen).toHaveLength(1)
    expect(obj(h, 'r').path.subpaths[0].nodes).toHaveLength(4)
  })

  it('Alt over a selected path\'s anchor converts it (a drag pulls out smooth handles)', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.click(150, 150)
    h.tool('pen')
    h.drag([200, 100], [220, 120], { alt: true })
    expect(obj(h, 'r').path.subpaths[0].nodes[1]).toMatchObject({ x: 200, y: 100, outX: 220, outY: 120, inX: 180, inY: 80 })
    expect(h.state().pen).toBeNull()
  })
})

describe('pen: modifiers while placing', () => {
  it('Alt while dragging moves only the outgoing handle', () => {
    const h = harness()
    h.tool('pen')
    h.down(50, 50)
    h.move(70, 40)
    h.move(80, 60, { alt: true })
    h.up(80, 60, { alt: true })
    expect(h.state().pen![0]).toMatchObject({ x: 50, y: 50, outX: 80, outY: 60, inX: 30, inY: 60 })
  })

  it('Shift keeps a new point at 45° steps from the last one, and a dragged handle too', () => {
    const h = harness()
    h.tool('pen')
    h.click(10, 10)
    h.click(110, 18, { shift: true })
    expect(h.state().pen![1]).toMatchObject({ x: 110, y: 10 })
    h.drag([203, 97], [230, 128], { shift: true })
    const n = h.state().pen![2]
    // 45° from (110, 10): the point lands on the diagonal...
    expect(n.x).toBeCloseTo(200, 9)
    expect(n.y).toBeCloseTo(100, 9)
    // ...and so does the handle.
    expect(n.outX! - n.x).toBeCloseTo(n.outY! - n.y, 6)
  })

  it('Space while the mouse is down moves the point being placed', () => {
    const h = harness()
    h.tool('pen')
    h.down(50, 50)
    h.move(60, 50)
    h.key(' ')
    h.move(80, 70)
    h.keyUp('Space')
    h.up(80, 70)
    const n = h.state().pen![0]
    expect(n).toMatchObject({ x: 70, y: 70, outX: 80, outY: 70, inX: 60, inY: 70 })
  })

  it('clicking the last point retracts its outgoing handle; a drag from it pulls one out on its own', () => {
    const h = harness()
    h.tool('pen')
    h.click(10, 10)
    h.drag([100, 10], [130, 40])
    expect(h.state().pen![1].outX).toBe(130)
    h.click(100, 10)
    expect(h.state().pen![1].outX).toBeUndefined()
    expect(h.state().pen![1].inX).toBe(70)
    h.drag([100, 10], [100, 60])
    expect(h.state().pen![1]).toMatchObject({ outX: 100, outY: 60, inX: 70, inY: -20 })
    expect(h.state().pen).toHaveLength(2)
  })

  it('dragging on the first point closes the path with a curved closing segment', () => {
    const h = harness()
    h.tool('pen')
    h.click(10, 10)
    h.click(100, 10)
    h.click(100, 100)
    h.drag([10, 10], [10, -20])
    const p = h.objects()[0] as DrawPathNode
    expect(p.path.subpaths[0].closed).toBe(true)
    expect(p.path.subpaths[0].nodes[0]).toMatchObject({ x: 10, y: 10, outX: 10, outY: -20, inX: 10, inY: 40 })
  })
})

describe('pen: ⌘Z and ⌘', () => {
  it('⌘Z inside the pen takes back the last point; with no pen path it undoes', () => {
    const h = harness(blank([rect('r', 300, 200, 20, 20)]))
    h.tool('rect')
    h.drag([10, 200], [40, 230])
    h.tool('pen')
    h.click(10, 10)
    h.click(50, 10)
    h.click(50, 50)
    h.key('z', { meta: true })
    expect(h.state().pen).toHaveLength(2)
    h.key('z', { meta: true })
    h.key('z', { meta: true })
    expect(h.state().pen).toBeNull()
    expect(h.objects()).toHaveLength(2)
    h.key('z', { meta: true }) // now a real undo: the rectangle
    expect(h.objects()).toHaveLength(1)
  })

  it('⌘ borrows Direct Selection: ⌘-drag moves an anchor of an existing path', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('pen')
    h.drag([100, 100], [90, 90], { meta: true })
    expect(obj(h, 'r').path.subpaths[0].nodes[0]).toMatchObject({ x: 90, y: 90 })
    expect(h.state().tool).toBe('pen')
    expect(h.state().pen).toBeNull()
  })

  it('⌘-click on empty canvas ends the path in progress', () => {
    const h = harness()
    h.tool('pen')
    h.click(10, 10)
    h.click(60, 10)
    h.click(300, 250, { meta: true })
    expect(h.state().pen).toBeNull()
    expect(h.objects()).toHaveLength(1)
  })
})
