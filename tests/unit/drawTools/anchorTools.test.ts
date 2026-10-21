// WP-PATH: the anchor tools (Add / Delete / Anchor Point, Scissors, Lasso,
// Knife, Path Eraser, Smooth, Curvature) and the Object > Path commands (Join,
// Average, Simplify, Add / Remove Anchor Points, Cut at anchors, convert,
// align, corner radius), driven through the real editor.

import { describe, it, expect } from 'vitest'
import { flattenSubpath, polygonArea } from '../../../src/shared/drawGeometry'
import { isSmoothNode } from '../../../src/shared/draw/geometry/pathEdit'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { selectedAnchors } from '../../../src/renderer/src/components/documents/draw/editor/anchorSelection'
import { commandById } from '../../../src/renderer/src/components/documents/draw/commands/registry'
import { blank, harness, rect } from './harness'

type H = ReturnType<typeof harness>
const obj = (h: H, id: string): DrawPathNode => h.objects().find((o) => o.id === id) as DrawPathNode
const nodes = (h: H, id: string) => obj(h, id).path.subpaths[0].nodes
const paths = (h: H): DrawPathNode[] => h.objects() as DrawPathNode[]
const enabled = (h: H, id: string): boolean => {
  const c = commandById(id)!
  return !c.enabled || c.enabled(h.ed.ctx)
}

function line(id: string, p: Array<[number, number]>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'path', path: { subpaths: [{ closed: false, nodes: p.map(([x, y]) => ({ x, y })) }] }, fill: { type: 'none' }, stroke: { paint: { type: 'solid', color: '#000' }, width: 2 }, ...extra }
}

describe('Add / Delete / Anchor Point tools', () => {
  it('+ adds an anchor on any path\'s segment without changing its shape; Alt deletes', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.key('+')
    expect(h.state().tool).toBe('addAnchor')
    h.click(150, 100)
    expect(nodes(h, 'r')).toHaveLength(5)
    expect(nodes(h, 'r')[1]).toEqual({ x: 150, y: 100 })
    expect(h.state().anchors).toEqual({ r: [[0, 1]] })
    h.click(150, 100, { alt: true })
    expect(nodes(h, 'r')).toHaveLength(4)
    h.click(10, 10) // not on a path: nothing
    expect(h.state().past).toHaveLength(2)
  })

  it('- deletes an anchor and keeps the path joined', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.key('-')
    expect(h.state().tool).toBe('deleteAnchor')
    h.click(200, 200)
    expect(nodes(h, 'r')).toEqual([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 100, y: 200 }])
    expect(obj(h, 'r').path.subpaths[0].closed).toBe(true)
    expect(h.state().past.at(-1)!.label).toBe('Delete anchor point')
  })

  it('⇧C picks the Anchor Point tool: click a smooth point -> corner; drag a corner -> smooth', () => {
    const smooth = { id: 'c', type: 'path', path: { subpaths: [{ closed: false, nodes: [{ x: 0, y: 100 }, { x: 100, y: 100, inX: 80, inY: 100, outX: 120, outY: 100 }, { x: 200, y: 100 }] }] }, fill: { type: 'none' }, stroke: { paint: { type: 'solid', color: '#000' }, width: 2 } }
    const h = harness(blank([smooth]))
    h.key('C', { shift: true })
    expect(h.state().tool).toBe('anchorConvert')
    h.click(100, 100)
    expect(nodes(h, 'c')[1]).toEqual({ x: 100, y: 100 })
    h.drag([100, 100], [130, 80])
    expect(nodes(h, 'c')[1]).toMatchObject({ outX: 130, outY: 80, inX: 70, inY: 120 })
    expect(isSmoothNode(nodes(h, 'c')[1])).toBe(true)
    // Dragging one handle now moves it alone.
    h.drag([130, 80], [130, 60])
    expect(nodes(h, 'c')[1]).toMatchObject({ outX: 130, outY: 60, inX: 70, inY: 120 })
    expect(h.state().past.map((p) => p.label)).toEqual(['Convert anchor point', 'Convert anchor point', 'Move handle'])
  })

  it('the Anchor Point tool bends a straight segment', () => {
    const h = harness(blank([line('l', [[0, 100], [200, 100]])]))
    h.key('C', { shift: true })
    h.drag([100, 100], [100, 60])
    const ns = nodes(h, 'l')
    expect(ns[0].outX).toBeDefined()
    expect(ns[1].inX).toBeDefined()
  })
})

describe('Scissors and cutting', () => {
  it('C cuts an open path in two at the click, leaving the new ends selected', () => {
    const h = harness(blank([line('l', [[0, 100], [200, 100]])]))
    h.key('c')
    expect(h.state().tool).toBe('scissors')
    h.click(100, 100)
    expect(paths(h)).toHaveLength(2)
    expect(selectedAnchors(h.state())).toHaveLength(2)
    expect(h.state().past.at(-1)!.label).toBe('Scissors')
  })

  it('cutting a closed rectangle once opens it; a second cut splits it', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.key('c')
    h.click(150, 100)
    expect(paths(h)).toHaveLength(1)
    expect(obj(h, 'r').path.subpaths[0].closed).toBe(false)
    h.click(150, 200)
    expect(paths(h)).toHaveLength(2)
  })

  it('Cut Path at Selected Anchor Points and Remove Anchor Points act on the picked anchors', () => {
    const h = harness(blank([line('l', [[0, 100], [100, 100], [200, 100], [300, 100]])]))
    h.tool('direct')
    h.click(100, 100)
    expect(enabled(h, 'path.cutAtAnchors')).toBe(true)
    h.run('path.cutAtAnchors')
    expect(paths(h)).toHaveLength(2)
    const h2 = harness(blank([line('l', [[0, 100], [100, 100], [200, 100], [300, 100]])]))
    h2.tool('direct')
    h2.click(100, 100)
    h2.run('path.removeAnchors')
    expect(nodes(h2, 'l')).toHaveLength(3)
    expect(h2.state().anchors).toEqual({ l: [] })
    expect(enabled(h2, 'path.removeAnchors')).toBe(false)
  })
})

describe('Lasso', () => {
  it('Q selects the anchors inside the drawn loop; Alt takes away', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.key('q')
    const loop = (pts: Array<[number, number]>, m = {}): void => {
      h.down(pts[0][0], pts[0][1], m)
      for (const p of pts.slice(1)) h.move(p[0], p[1], m)
      h.up(pts[pts.length - 1][0], pts[pts.length - 1][1], m)
    }
    loop([[90, 90], [210, 90], [210, 120], [90, 120]])
    expect(h.state().anchors).toEqual({ r: [[0, 0], [0, 1]] })
    loop([[190, 90], [210, 90], [210, 110], [190, 110]], { alt: true })
    expect(h.state().anchors).toEqual({ r: [[0, 0]] })
  })
})

describe('Knife, Path Eraser, Smooth', () => {
  it('the knife cuts a filled rectangle into two pieces that keep its look', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('knife')
    h.drag([150, 80], [150, 220], {}, 6)
    expect(paths(h)).toHaveLength(2)
    const areas = paths(h).map((p) => Math.abs(polygonArea(flattenSubpath(p.path.subpaths[0]))))
    expect(areas[0]).toBeCloseTo(5000, 3)
    expect(areas[1]).toBeCloseTo(5000, 3)
    for (const p of paths(h)) expect(p.fill).toEqual(obj(h, 'r').fill)
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Knife')
    // What is handed to the host for saving holds no object twice (the IPC
    // payload check refuses that as "cyclic data").
    const seen = new Set<object>()
    const once = (v: unknown): boolean => {
      if (!v || typeof v !== 'object') return true
      if (seen.has(v as object)) return false
      seen.add(v as object)
      return Object.values(v as Record<string, unknown>).every(once)
    }
    expect(once(h.emitted.at(-1))).toBe(true)
  })

  it('a knife stroke that does not cross a shape says so and changes nothing', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('knife')
    h.drag([120, 120], [180, 180])
    expect(paths(h)).toHaveLength(1)
    expect(h.state().past).toHaveLength(0)
    expect(h.state().status).toMatch(/Nothing was cut/)
  })

  it('Alt makes the knife cut straight', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('knife')
    h.down(80, 150, { alt: true })
    h.move(130, 100, { alt: true })
    h.move(220, 150, { alt: true })
    h.up(220, 150, { alt: true })
    expect(paths(h)).toHaveLength(2)
    // A straight horizontal cut: every corner is on y = 100, 150 or 200.
    expect(paths(h).every((p) => p.path.subpaths[0].nodes.every((n) => [100, 150, 200].some((y) => Math.abs(n.y - y) < 1e-6)))).toBe(true)
  })

  it('the path eraser removes the stretch under it from the selected path', () => {
    const h = harness(blank([line('l', [[0, 100], [300, 100]])]))
    h.click(150, 100)
    h.tool('pathEraser')
    h.drag([150, 80], [150, 120])
    expect(paths(h)).toHaveLength(2)
    expect(h.state().past.at(-1)!.label).toBe('Path Eraser')
    // Nothing selected: it says what to do instead.
    h.ed.ctx.select([])
    h.drag([50, 80], [50, 120])
    expect(h.state().status).toMatch(/Select the path/)
  })

  it('the smooth tool smooths the stretch it is dragged along, as one step', () => {
    const zig = line('z', Array.from({ length: 21 }, (_, k): [number, number] => [k * 10, 100 + (k % 2 ? 6 : 0)]))
    const h = harness(blank([zig]))
    h.click(100, 100)
    h.tool('smooth')
    h.drag([20, 103], [180, 103], {}, 16)
    expect(nodes(h, 'z').length).toBeLessThan(21)
    expect(nodes(h, 'z')[0]).toEqual({ x: 0, y: 100 })
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Smooth')
  })
})

describe('Join tool', () => {
  it('scrubbing from one open end to another joins them; a scrub with no ends says so', () => {
    const h = harness(blank([line('a', [[0, 100], [100, 100]]), line('b', [[140, 100], [240, 100]])]))
    h.tool('join')
    h.drag([98, 95], [142, 105], {}, 4)
    expect(paths(h)).toHaveLength(1)
    expect(paths(h)[0].path.subpaths[0].nodes.map((n) => n.x)).toEqual([0, 100, 140, 240])
    expect(h.state().past.at(-1)!.label).toBe('Join')
    h.drag([300, 250], [350, 260])
    expect(h.state().status).toMatch(/Scrub from one open end/)
  })
})

describe('Curvature', () => {
  it('⇧~ picks it; clicks make a smooth path through every point; Escape finishes it as one step', () => {
    const h = harness()
    h.key('~', { shift: true })
    expect(h.state().tool).toBe('curvature')
    h.click(10, 100)
    h.click(60, 40)
    h.click(110, 100)
    h.click(160, 40)
    expect(h.objects()).toHaveLength(0)
    h.key('Escape')
    const p = paths(h)[0]
    expect(p.path.subpaths[0].nodes.map((n) => [n.x, n.y])).toEqual([
      [10, 100],
      [60, 40],
      [110, 100],
      [160, 40]
    ])
    expect(isSmoothNode(p.path.subpaths[0].nodes[1])).toBe(true)
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Curvature')
  })

  it('Alt-click places a corner; clicking the first point closes the path', () => {
    const h = harness()
    h.tool('curvature')
    h.click(10, 10)
    h.click(100, 10, { alt: true })
    h.click(100, 100)
    h.click(10, 10)
    const sp = paths(h)[0].path.subpaths[0]
    expect(sp.closed).toBe(true)
    expect(sp.nodes[1]).toEqual({ x: 100, y: 10 })
  })

  it('on an existing path, dragging an anchor re-flows the curve through it; double-click toggles corner', () => {
    const h = harness(blank([line('l', [[0, 100], [100, 100], [200, 100]])]))
    h.tool('curvature')
    h.click(100, 100, { detail: 2 })
    expect(isSmoothNode(nodes(h, 'l')[1])).toBe(true)
    h.drag([100, 100], [100, 50])
    const mid = nodes(h, 'l')[1]
    expect(mid).toMatchObject({ x: 100, y: 50 })
    expect(isSmoothNode(mid)).toBe(true)
    h.click(100, 50, { detail: 2 })
    expect(nodes(h, 'l')[1]).toEqual({ x: 100, y: 50 })
  })
})

describe('Object > Path commands', () => {
  it('⌘J joins two selected open paths by their nearest ends; it is off for closed paths', () => {
    const h = harness(blank([line('a', [[0, 0], [100, 0]]), line('b', [[200, 0], [120, 0]])]))
    h.key('a', { meta: true })
    expect(enabled(h, 'path.join')).toBe(true)
    h.key('j', { meta: true })
    expect(paths(h)).toHaveLength(1)
    expect(nodes(h, 'a').map((n) => n.x)).toEqual([0, 100, 120, 200])
    expect(h.state().past.at(-1)!.label).toBe('Join')
    const closed = harness(blank([rect('r', 0, 0, 10, 10)]))
    closed.key('a', { meta: true })
    expect(enabled(closed, 'path.join')).toBe(false)
  })

  it('⌘J with two end anchors picked joins exactly those; ⌥⇧⌘J averages them first', () => {
    const h = harness(blank([line('a', [[0, 0], [100, 0]]), line('b', [[120, 20], [200, 20]])]))
    h.tool('direct')
    h.click(100, 0)
    h.click(120, 20, { shift: true })
    h.key('j', { meta: true, shift: true, alt: true })
    expect(paths(h)).toHaveLength(1)
    expect(paths(h)[0].path.subpaths[0].nodes.map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [110, 10],
      [200, 20]
    ])
    expect(h.state().past.at(-1)!.label).toBe('Average & Join')
  })

  it('⌥⌘J opens Average; Average lines the selected anchors up', () => {
    const h = harness(blank([line('l', [[0, 0], [100, 40], [50, 80]])]))
    h.tool('direct')
    h.drag([-10, -10], [110, 50]) // the first two anchors
    h.click(50, 80, { shift: true }) // and the third
    h.key('j', { meta: true, alt: true })
    expect(h.state().dialog).toEqual({ id: 'average' })
    h.run('path.averageApply', 'horizontal')
    expect(nodes(h, 'l').map((n) => n.y)).toEqual([40, 40, 40])
  })

  it('Average is off with fewer than two anchors', () => {
    const h = harness(blank([line('l', [[0, 0], [100, 40]])]))
    h.tool('direct')
    h.click(0, 0)
    expect(enabled(h, 'path.average')).toBe(false)
  })

  it('Simplify opens its dialog only with a path selected; Add Anchor Points doubles the anchors', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    expect(enabled(h, 'path.simplify')).toBe(false)
    h.click(150, 150)
    h.run('path.simplify')
    expect(h.state().dialog).toEqual({ id: 'simplify' })
    h.run('path.addAnchorPoints')
    expect(nodes(h, 'r')).toHaveLength(8)
  })

  it('convert, align and corner radius from the Anchor points panel commands', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('direct')
    h.click(200, 100)
    h.run('path.convertSmooth')
    expect(isSmoothNode(nodes(h, 'r')[1])).toBe(true)
    h.run('path.convertCorner')
    expect(nodes(h, 'r')[1]).toEqual({ x: 200, y: 100 })
    h.run('path.cornerRadius', 20)
    expect(nodes(h, 'r')).toHaveLength(5)
    expect(selectedAnchors(h.state())).toHaveLength(2)
    const g = harness(blank([line('l', [[0, 0], [100, 40], [50, 80]])]))
    g.tool('direct')
    g.drag([-10, -10], [200, 200])
    g.run('path.alignAnchors.left')
    expect(nodes(g, 'l').map((n) => n.x)).toEqual([0, 0, 0])
  })

  it('every path command is off on a read-only drawing', () => {
    const h = harness({ ...blank([line('a', [[0, 0], [100, 0]])]), schemaVersion: 3 })
    h.key('a', { meta: true })
    for (const id of ['path.join', 'path.averageJoin', 'path.average', 'path.simplify', 'path.addAnchorPoints', 'path.removeAnchors', 'path.cutAtAnchors', 'path.convertCorner', 'path.convertSmooth', 'path.cornerRadius'])
      expect(enabled(h, id), id).toBe(false)
  })
})
