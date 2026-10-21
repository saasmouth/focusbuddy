import { describe, it, expect } from 'vitest'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { pointAt, segmentOf } from '../../../src/shared/draw/geometry/bezier'
import { selectedAnchors } from '../../../src/renderer/src/components/documents/draw/editor/anchorSelection'
import { blank, harness, rect } from './harness'

const path = (h: ReturnType<typeof harness>, id: string): DrawPathNode => h.objects().find((o) => o.id === id) as DrawPathNode
const nodes = (h: ReturnType<typeof harness>, id: string) => path(h, id).path.subpaths[0].nodes

function line(id: string, pts: Array<[number, number]>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'path', path: { subpaths: [{ closed: false, nodes: pts.map(([x, y]) => ({ x, y })) }] }, fill: { type: 'none' }, stroke: { paint: { type: 'solid', color: '#000' }, width: 2 }, ...extra }
}

const curve = {
  id: 'c',
  type: 'path',
  path: { subpaths: [{ closed: false, nodes: [{ x: 100, y: 100, inX: 80, inY: 100, outX: 120, outY: 100 }, { x: 200, y: 100 }] }] },
  fill: { type: 'none' },
  stroke: { paint: { type: 'solid', color: '#000' }, width: 2 }
}

describe('Direct Selection (A)', () => {
  it('drags an anchor of a path that was not even selected; a live shape becomes a plain path', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('direct')
    h.drag([100, 100], [80, 70])
    expect(nodes(h, 'r')[0]).toMatchObject({ x: 80, y: 70 })
    expect(nodes(h, 'r')[1]).toMatchObject({ x: 200, y: 100 })
    expect(path(h, 'r').shapeKind).toBe('path')
    expect(h.state().selection).toEqual(['r'])
    expect(h.state().anchors).toEqual({ r: [[0, 0]] })
  })

  it('a smooth point\'s handle drag keeps the other handle in line at its own length; Alt breaks the pair', () => {
    const h = harness(blank([curve]))
    h.ed.ctx.select(['c'])
    h.tool('direct')
    h.drag([120, 100], [120, 130])
    const n = nodes(h, 'c')[0]
    expect(n).toMatchObject({ outX: 120, outY: 130 })
    // In line with the out handle, still 20 long.
    expect(Math.hypot(n.inX! - 100, n.inY! - 100)).toBeCloseTo(20, 9)
    expect((n.inX! - 100) * 30 - (n.inY! - 100) * 20).toBeCloseTo(0, 6)
    const before = { inX: n.inX, inY: n.inY }
    h.drag([120, 130], [140, 130], { alt: true })
    expect(nodes(h, 'c')[0]).toMatchObject({ outX: 140, outY: 130, ...before })
  })

  it('a click inside a filled path selects all of it; on empty canvas it clears', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40), rect('b', 100, 100, 40, 40)]))
    h.tool('direct')
    h.click(120, 120)
    expect(h.state().selection).toEqual(['b'])
    expect(h.state().anchors).toEqual({})
    expect(selectedAnchors(h.state())).toHaveLength(4)
    h.click(300, 250)
    expect(h.state().selection).toEqual([])
  })

  it('a click on a segment selects its two end anchors; Shift-click adds and removes anchors', () => {
    const h = harness(blank([line('l', [[0, 50], [100, 50], [200, 50], [300, 50]])]))
    h.tool('direct')
    h.click(150, 50)
    expect(h.state().anchors).toEqual({ l: [[0, 1], [0, 2]] })
    h.click(300, 50, { shift: true })
    expect(h.state().anchors.l).toHaveLength(3)
    h.click(100, 50, { shift: true })
    expect(h.state().anchors).toEqual({ l: [[0, 2], [0, 3]] })
  })

  it('Alt-click on an anchor or segment selects the whole path', () => {
    const h = harness(blank([line('l', [[0, 50], [100, 50], [200, 50]])]))
    h.tool('direct')
    h.click(150, 50, { alt: true })
    expect(h.state().selection).toEqual(['l'])
    expect(h.state().anchors).toEqual({})
    expect(selectedAnchors(h.state())).toHaveLength(3)
  })

  it('a marquee selects the anchors inside it, across paths; Shift-marquee adds', () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40), rect('b', 100, 10, 40, 40)]))
    h.tool('direct')
    h.drag([0, 0], [120, 30])
    expect(h.state().selection.sort()).toEqual(['a', 'b'])
    expect(h.state().anchors).toEqual({ a: [[0, 0], [0, 1]], b: [[0, 0]] })
    h.drag([155, 60], [130, 40], { shift: true })
    expect(h.state().anchors.b).toEqual([[0, 0], [0, 2]])
  })

  it('dragging one selected anchor moves every selected anchor; Shift keeps the move at 45°', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('direct')
    h.click(100, 100)
    h.click(200, 100, { shift: true })
    // Shift is pressed after the drag starts (Shift-pressing an anchor deselects it).
    h.down(100, 100)
    h.move(115, 106, { shift: true })
    h.move(130, 112, { shift: true })
    h.up(130, 112, { shift: true })
    // Constrained to horizontal: the dominant axis.
    expect(nodes(h, 'r').map((n) => [n.x, n.y])).toEqual([
      [130, 100],
      [230, 100],
      [200, 200],
      [100, 200]
    ])
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Move anchor points')
  })

  it('an anchor of a path selected as an OBJECT is picked on its own and dragged alone', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.click(150, 150) // the Selection tool: the whole object
    h.tool('direct')
    h.drag([100, 100], [80, 60])
    expect(nodes(h, 'r').map((n) => [n.x, n.y])).toEqual([
      [80, 60],
      [200, 100],
      [200, 200],
      [100, 200]
    ])
    expect(path(h, 'r').shapeKind).toBe('path')
  })

  it('a marquee over every anchor, then a drag on one of them, moves them all', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('direct')
    h.drag([90, 90], [210, 210])
    h.drag([100, 100], [110, 100])
    expect(nodes(h, 'r').map((n) => n.x)).toEqual([110, 210, 210, 110])
  })

  it('a plain click on one of several selected anchors selects just it', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('direct')
    h.click(150, 150)
    expect(selectedAnchors(h.state())).toHaveLength(4)
    h.click(200, 200)
    expect(h.state().anchors).toEqual({ r: [[0, 2]] })
    expect(h.state().past).toHaveLength(0)
  })

  it('arrow keys nudge only the selected anchors, by the keyboard increment (Shift ×10)', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('direct')
    h.click(200, 200)
    h.key('ArrowRight')
    expect(nodes(h, 'r')[2]).toMatchObject({ x: 201, y: 200 })
    expect(nodes(h, 'r')[1]).toMatchObject({ x: 200, y: 100 })
    h.key('ArrowDown', { shift: true })
    expect(nodes(h, 'r')[2]).toMatchObject({ x: 201, y: 210 })
    h.ed.store.setState((s) => ({ doc: { ...s.doc, settings: { ...s.doc.settings, keyIncrement: 4 } } }))
    h.key('ArrowLeft', { shift: true })
    expect(nodes(h, 'r')[2]).toMatchObject({ x: 161, y: 210 })
    expect(h.state().past.map((p) => p.label)).toEqual(['Nudge anchor points', 'Nudge anchor points', 'Nudge anchor points'])
  })

  it('the keyboard increment also applies to whole objects', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.ed.store.setState((s) => ({ doc: { ...s.doc, settings: { ...s.doc.settings, keyIncrement: 2.5 } } }))
    h.click(150, 150)
    h.key('ArrowRight')
    expect(nodes(h, 'r')[0]).toMatchObject({ x: 102.5 })
  })

  it('Delete removes the selected anchors with their segments; the path falls apart there', () => {
    const h = harness(blank([line('l', [[0, 50], [100, 50], [200, 50], [300, 50], [400, 50]])]))
    h.tool('direct')
    h.click(200, 50)
    h.key('Delete')
    expect(h.objects()).toHaveLength(2)
    expect(h.objects().map((o) => (o as DrawPathNode).path.subpaths[0].nodes.length)).toEqual([2, 2])
    expect(h.state().past.at(-1)!.label).toBe('Delete anchor points')
    h.ed.history.undo()
    expect(h.objects()).toHaveLength(1)
  })

  it('a curved segment dragged alone reshapes through the pointer; a straight one moves with its anchors', () => {
    const arc = { ...curve, path: { subpaths: [{ closed: false, nodes: [{ x: 0, y: 100, outX: 0, outY: 50 }, { x: 200, y: 100, inX: 200, inY: 50 }] }] } }
    const h = harness(blank([arc, line('l', [[0, 250], [200, 250]])]))
    h.tool('direct')
    const mid = pointAt(segmentOf(path(h, 'c').path.subpaths[0], 0), 0.5)
    h.drag([mid.x, mid.y], [mid.x, mid.y - 30])
    const sp = path(h, 'c').path.subpaths[0]
    expect(sp.nodes[0]).toMatchObject({ x: 0, y: 100 })
    expect(sp.nodes[1]).toMatchObject({ x: 200, y: 100 })
    expect(pointAt(segmentOf(sp, 0), 0.5).y).toBeCloseTo(mid.y - 30, 0)
    h.drag([100, 250], [100, 270])
    expect(nodes(h, 'l')).toEqual([{ x: 0, y: 270 }, { x: 200, y: 270 }])
  })

  it('the corner widget of a selected corner rounds it, as one undo step', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('direct')
    h.click(200, 100)
    // The widget sits 16px inside the corner along its bisector.
    const w = { x: 200 - 16 / Math.SQRT2, y: 100 + 16 / Math.SQRT2 }
    h.drag([w.x, w.y], [w.x - 10, w.y + 10], {}, 4)
    const ns = nodes(h, 'r')
    expect(ns).toHaveLength(5)
    expect(ns[1].outX).toBeDefined()
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Round corners')
    expect(selectedAnchors(h.state())).toHaveLength(2)
  })

  it('a point drag is ONE undo step of its own; undo restores the shape, live parameters included', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('rect')
    h.drag([300, 50], [350, 90])
    h.tool('direct')
    h.drag([100, 100], [80, 70], {}, 5)
    expect(h.state().past).toHaveLength(2)
    h.ed.history.undo()
    expect(nodes(h, 'r')[0]).toMatchObject({ x: 100, y: 100 })
    expect(path(h, 'r').shapeKind).toBe('rect')
    expect(h.objects()).toHaveLength(2)
  })

  it('locked paths and paths on locked layers cannot be picked or moved', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100, { locked: true })]))
    h.tool('direct')
    h.drag([100, 100], [80, 70])
    expect(nodes(h, 'r')[0]).toMatchObject({ x: 100, y: 100 })
    expect(h.state().past).toHaveLength(0)
  })

  it('on a read-only drawing it can only look', () => {
    const h = harness({ ...blank([rect('r', 100, 100, 100, 100)]), schemaVersion: 3 })
    h.tool('direct')
    h.drag([100, 100], [80, 70])
    expect(nodes(h, 'r')[0]).toMatchObject({ x: 100, y: 100 })
  })
})

describe('Direct Selection inside groups (WP-OBJ x WP-PATH)', () => {
  const v2 = (objects: unknown[]): Record<string, unknown> => ({
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 800, h: 600, background: { type: 'solid', color: '#ffffff' } }],
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  })

  it('picks an anchor of a path inside a scaled group where it is drawn, and drags it on screen', () => {
    // The group doubles its members: the rectangle's corner (10, 10) is drawn at (20, 20).
    const h = harness(v2([{ id: 'g', type: 'group', transform: [2, 0, 0, 2, 0, 0], children: [rect('r', 10, 10, 50, 50)] }]))
    h.tool('direct')
    h.ed.ctx.set({ snapOn: false })
    h.click(20, 20)
    expect(h.state().selection).toEqual(['r'])
    expect(selectedAnchors(h.state())).toHaveLength(1)
    h.drag([20, 20], [30, 40])
    const g = h.objects()[0] as { children: DrawPathNode[] }
    const moved = g.children[0].path.subpaths[0].nodes.find((n) => Math.abs(n.x - 15) < 1e-6 && Math.abs(n.y - 20) < 1e-6)
    expect(moved, 'the corner moves by (10, 20) on screen, (5, 10) in the group').toBeTruthy()
  })

  it('a click on a picture inside a group selects the picture itself, not its group', () => {
    const img = { id: 'i', type: 'image', x: 100, y: 100, w: 40, h: 40, assetId: 'asset-00000000000000000000000000000000' }
    const h = harness({
      ...v2([{ id: 'g', type: 'group', children: [img, rect('r', 300, 300, 10, 10)] }]),
      assets: { 'asset-00000000000000000000000000000000': { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', w: 1, h: 1 } }
    })
    h.tool('direct')
    h.click(120, 120)
    expect(h.state().selection).toEqual(['i'])
  })
})
