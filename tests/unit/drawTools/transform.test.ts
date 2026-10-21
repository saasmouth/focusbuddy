import { beforeEach, describe, it, expect } from 'vitest'
import { pathBounds } from '../../../src/shared/drawGeometry'
import { insertAnchor, nearestOnPath, reshapePath, reshapeWeights } from '../../../src/shared/draw/geometry/reshape'
import type { DrawDoc, DrawImageNode, DrawNode, DrawPathNode } from '../../../src/shared/draw/model'
import { nodeBounds } from '../../../src/shared/draw/ops'
import { transformReadout, orientationDelta } from '../../../src/renderer/src/components/documents/draw/panels/transform.panel'
import { lastTransform } from '../../../src/renderer/src/components/documents/draw/transform/apply'
import { resetTransformPrefs, setTransformPrefs } from '../../../src/renderer/src/components/documents/draw/transform/prefs'
import { transformOrigin } from '../../../src/renderer/src/components/documents/draw/tools/transformTool'
import { alignState } from '../../../src/renderer/src/components/documents/draw/commands/align.commands'
import { blank, harness, rect, type Harness } from './harness'

beforeEach(() => resetTransformPrefs())

const obj = (h: Harness, id: string): DrawNode => h.objects().find((o) => o.id === id)!
const box = (h: Harness, id: string): { x: number; y: number; w: number; h: number } => nodeBounds(obj(h, id))
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps
const expectBox = (b: { x: number; y: number; w: number; h: number }, x: number, y: number, w: number, hh: number, eps = 1e-6): void => {
  expect(near(b.x, x, eps) && near(b.y, y, eps) && near(b.w, w, eps) && near(b.h, hh, eps), JSON.stringify(b)).toBe(true)
}

/** A harness on a v2 drawing (it may hold frame matrices), with document settings. */
function v2(objects: unknown[], settings: Record<string, unknown> = {}): Harness {
  const h = harness(blank(objects))
  const doc: DrawDoc = { ...h.doc(), settings: { ...h.doc().settings, ...settings } }
  return harness(doc)
}

const image = (id: string, x: number, y: number, w: number, hh: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'image',
  x,
  y,
  w,
  h: hh,
  src: 'data:image/png;base64,iVBORw0KGgo=',
  ...extra
})

describe('Rotate tool (R)', () => {
  it('drags about the selection centre, one undo step, and the turn is counter-clockwise for an upward drag on the right', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 50)]))
    h.ed.ctx.select(['a'])
    h.key('r')
    expect(h.state().tool).toBe('rotate')
    expect(transformOrigin(h.state())).toEqual({ p: { x: 150, y: 125 }, user: false })
    // From the right of the centre, straight up the screen: a quarter turn.
    h.drag([250, 125], [150, 25], {}, 4)
    expectBox(box(h, 'a'), 125, 75, 50, 100)
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Rotate')
  })

  it('a click moves the origin; dragging then turns about it; Shift snaps to 45°', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.tool('rotate')
    h.click(100, 100)
    expect(transformOrigin(h.state())).toEqual({ p: { x: 100, y: 100 }, user: true })
    h.drag([110, 100], [101, 88], { shift: true })
    // Snapped to a 90° turn counter-clockwise about (100,100).
    expectBox(box(h, 'a'), 100, 90, 10, 10)
  })

  it('Alt-drag turns a copy; Alt-click opens the dialog at that origin', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.tool('rotate')
    h.drag([120, 105], [105, 90], { alt: true })
    expect(h.objects()).toHaveLength(2)
    expect(h.state().selection).not.toContain('a')
    expectBox(box(h, 'a'), 100, 100, 10, 10)
    expect(h.state().past[h.state().past.length - 1].label).toBe('Rotate copy')
    h.ed.ctx.select(['a'])
    h.click(50, 60, { alt: true })
    expect(h.state().dialog).toEqual({ id: 'transform-rotate', props: { origin: { x: 50, y: 60 } } })
  })

  it('Enter and the toolbox double-click open the options dialog', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.tool('rotate')
    expect(h.key('Enter').prevented).toBe(true)
    expect(h.state().dialog?.id).toBe('transform-rotate')
  })

  it('with nothing selected a click selects, and nothing turns', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.tool('rotate')
    h.click(105, 105)
    expect(h.state().selection).toEqual(['a'])
    expect(h.state().past).toHaveLength(0)
  })

  it('Transform Again repeats a copy about the same clicked origin: a ring of copies', () => {
    const h = harness(blank([rect('a', 195, 95, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.tool('rotate')
    h.click(200, 150)
    // A 90° copy about (200,150), then ⌘D twice more: four squares on a circle.
    h.drag([200, 100], [150, 150], { alt: true, shift: true }, 4)
    h.key('d', { meta: true })
    h.key('d', { meta: true })
    expect(h.objects()).toHaveLength(4)
    const centres = h.objects().map((o) => {
      const b = nodeBounds(o)
      return [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)]
    })
    expect(centres.sort()).toEqual([
      [150, 150],
      [200, 100],
      [200, 200],
      [250, 150]
    ].sort())
    expect(lastTransform(h.state())).toMatchObject({ kind: 'matrix', copy: true, origin: { kind: 'absolute' } })
  })
})

describe('Reflect tool (O)', () => {
  it('drags the axis through the origin; reflecting twice is the identity', () => {
    const h = harness(blank([rect('a', 100, 100, 40, 20)]))
    h.ed.ctx.select(['a'])
    h.key('o')
    expect(h.state().tool).toBe('reflect')
    const before = (obj(h, 'a') as DrawPathNode).path
    // A vertical axis through the centre: a left-right mirror.
    h.drag([120, 150], [120, 170])
    expectBox(box(h, 'a'), 100, 100, 40, 20)
    h.drag([120, 150], [120, 170])
    const after = (obj(h, 'a') as DrawPathNode).path
    after.subpaths[0].nodes.forEach((n, i) => {
      expect(n.x).toBeCloseTo(before.subpaths[0].nodes[i].x, 9)
      expect(n.y).toBeCloseTo(before.subpaths[0].nodes[i].y, 9)
    })
    expect(h.state().past).toHaveLength(2)
  })

  it('click to place the origin, click again to reflect across the axis to that point', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.tool('reflect')
    h.click(120, 0)
    expect(h.state().past).toHaveLength(0)
    h.click(120, 50)
    expectBox(box(h, 'a'), 130, 100, 10, 10)
  })

  it('refuses honestly to reflect text on a drawing that cannot hold a frame matrix yet, and does it on a v2 drawing', () => {
    const t = { id: 't', type: 'text', x: 10, y: 10, w: 100, text: 'Hi', fontSize: 20, fill: { type: 'solid', color: '#000' } }
    const h = harness(blank([t]))
    h.ed.ctx.select(['t'])
    h.tool('reflect')
    h.drag([60, 0], [60, 50])
    expect(h.state().past).toHaveLength(0)
    expect(h.state().status).toMatch(/newer drawing format/)
    const g = v2([t])
    g.ed.ctx.select(['t'])
    g.tool('reflect')
    g.drag([60, 0], [60, 50])
    expect((obj(g, 't') as { transform?: number[] }).transform).toBeDefined()
  })
})

describe('Scale tool (S)', () => {
  it('scales by the drag about the origin; Shift keeps it uniform; strokes scale only with the preference', () => {
    const stroke = { paint: { type: 'solid', color: '#000' }, width: 2 }
    const h = harness(blank([rect('a', 100, 100, 100, 100, { stroke })]))
    h.ed.ctx.select(['a'])
    h.key('s')
    expect(h.state().tool).toBe('scale')
    h.click(100, 100)
    h.drag([200, 200], [300, 250])
    expectBox(box(h, 'a'), 100, 100, 200, 150)
    expect((obj(h, 'a') as DrawPathNode).stroke!.width).toBe(2)
    setTransformPrefs({ scaleStrokes: true })
    h.drag([300, 250], [450, 300], { shift: true })
    const b = box(h, 'a')
    expect(b.w / b.h).toBeCloseTo(200 / 150, 6)
    expect((obj(h, 'a') as DrawPathNode).stroke!.width).toBeGreaterThan(2)
  })
})

describe('Shear tool', () => {
  it('a sideways drag slants along the horizontal axis through the origin', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 100)]))
    h.ed.ctx.select(['a'])
    h.tool('shear')
    h.click(100, 200)
    h.drag([100, 100], [150, 100])
    const p = obj(h, 'a') as DrawPathNode
    // Top edge moved right by 50, the bottom edge (on the origin's line) stayed.
    expect(p.path.subpaths[0].nodes[0]).toMatchObject({ x: 150, y: 100 })
    expect(p.path.subpaths[0].nodes[3]).toMatchObject({ x: 100, y: 200 })
    expect(p.shapeKind).toBe('path')
  })
})

describe('Free Transform (E)', () => {
  it('a corner handle scales, ⌘ on a side handle shears, outside the box rotates, inside moves (Alt: a copy)', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 100)]))
    h.ed.ctx.select(['a'])
    h.key('e')
    expect(h.state().tool).toBe('freeTransform')
    h.drag([200, 200], [300, 250])
    expectBox(box(h, 'a'), 100, 100, 200, 150)
    h.drag([200, 100], [250, 100], { meta: true })
    const p = obj(h, 'a') as DrawPathNode
    expect(p.path.subpaths[0].nodes[0].x).toBeCloseTo(150)
    expect(p.path.subpaths[0].nodes[3].x).toBeCloseTo(100)
    h.run('edit.undo')
    h.drag([180, 180], [190, 190], { alt: true })
    expect(h.objects()).toHaveLength(2)
    const n = h.state().past.length
    // Rotate ring: just outside the top-right corner.
    h.ed.ctx.select(['a'])
    h.drag([310, 90], [310, 260], {}, 6)
    expect(h.state().past.length).toBe(n + 1)
    expect(h.state().past[h.state().past.length - 1].label).toBe('Rotate')
  })
})

describe('Reshape', () => {
  it('nearestOnPath and insertAnchor add a point without changing the outline', () => {
    const path = { subpaths: [{ closed: false, nodes: [{ x: 0, y: 0, outX: 50, outY: -50 }, { x: 100, y: 0, inX: 50, inY: -50 }] }] }
    const hit = nearestOnPath(path, { x: 50, y: -30 })!
    expect(hit.seg).toBe(0)
    const { path: split, ni } = insertAnchor(path, 0, 0, hit.t)
    expect(ni).toBe(1)
    expect(split.subpaths[0].nodes).toHaveLength(3)
    const b0 = pathBounds(path)
    const b1 = pathBounds(split)
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(b1[k]).toBeCloseTo(b0[k], 6)
  })

  it('focus points move fully, the farthest anchor stays, the rest follow in proportion', () => {
    const path = { subpaths: [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }] }] }
    expect(reshapeWeights(path, [[0, 0]])[0]).toEqual([1, 0.5, 0])
    const moved = reshapePath(path, [[0, 0]], 0, 10)
    expect(moved.subpaths[0].nodes.map((n) => n.y)).toEqual([10, 5, 0])
  })

  it('click on the outline adds a focus anchor, a drag reshapes, one undo step, and a live shape becomes a path', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 100)]))
    h.ed.ctx.select(['a'])
    h.tool('reshape')
    h.drag([150, 100], [150, 80])
    const p = obj(h, 'a') as DrawPathNode
    expect(p.path.subpaths[0].nodes).toHaveLength(5)
    expect(p.shapeKind).toBe('path')
    expect(Math.min(...p.path.subpaths[0].nodes.map((n) => n.y))).toBeCloseTo(80)
    expect(h.state().past).toHaveLength(1)
  })
})

describe('Selection tool extras', () => {
  it('Alt-drag moves a copy and leaves the original; ⌘D then repeats the move with a copy', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.drag([105, 105], [155, 105], { alt: true })
    expect(h.objects()).toHaveLength(2)
    expectBox(box(h, 'a'), 100, 100, 10, 10)
    expect(h.state().past).toHaveLength(1)
    h.key('d', { meta: true })
    expect(h.objects()).toHaveLength(3)
    const xs = h.objects().map((o) => Math.round(nodeBounds(o).x)).sort((a, b) => a - b)
    expect(xs).toEqual([100, 150, 200])
  })

  it('handle scaling honours Scale Strokes & Effects', () => {
    const stroke = { paint: { type: 'solid', color: '#000' }, width: 4 }
    const h = harness(blank([rect('a', 100, 100, 100, 100, { stroke })]))
    h.ed.ctx.select(['a'])
    setTransformPrefs({ scaleStrokes: true })
    h.drag([200, 200], [300, 300])
    expect((obj(h, 'a') as DrawPathNode).stroke!.width).toBeCloseTo(8)
  })

  it('Enter with the Selection tool opens Move…', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.key('Enter')
    expect(h.state().dialog?.id).toBe('transform-move')
  })
})

describe('arrow keys', () => {
  it('nudge by the document\'s keyboard increment, ×10 with Shift, and Alt nudges a copy', () => {
    const h = v2([rect('a', 100, 100, 10, 10)], { keyIncrement: 2.5 })
    h.ed.ctx.select(['a'])
    h.key('ArrowRight')
    expect(box(h, 'a').x).toBe(102.5)
    h.key('ArrowDown', { shift: true })
    expect(box(h, 'a').y).toBe(125)
    h.key('ArrowLeft', { alt: true })
    expect(h.objects()).toHaveLength(2)
    expect(box(h, 'a').x).toBe(102.5)
    expect(nodeBounds(obj(h, h.state().selection[0])).x).toBe(100)
  })
})

describe('transform keys on a real Mac keyboard (Option changes e.key; the physical key decides)', () => {
  it('⌥⇧⌘D ("Î" from the D key) opens Transform Each; ⇧⌘M opens Move; ⌘D repeats', () => {
    const h = harness(blank([rect('a', 100, 100, 10, 10)]))
    h.ed.ctx.select(['a'])
    expect(h.key('Î', { meta: true, shift: true, alt: true, code: 'KeyD' }).prevented).toBe(true)
    expect(h.state().dialog?.id).toBe('transform-each')
    h.ed.ctx.set({ dialog: null })
    h.key('M', { meta: true, shift: true, code: 'KeyM' })
    expect(h.state().dialog?.id).toBe('transform-move')
    h.ed.ctx.set({ dialog: null })
    // ⌥→ ("→" is unchanged, Alt is read from the event) nudges a copy; ⌘D repeats it.
    h.key('ArrowRight', { alt: true, code: 'ArrowRight' })
    h.key('d', { meta: true, code: 'KeyD' })
    expect(h.objects()).toHaveLength(3)
  })
})

describe('Object › Transform commands', () => {
  it('⇧⌘M and ⌥⇧⌘D open Move and Transform Each; nothing selected keeps them off', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.key('m', { meta: true, shift: true })
    expect(h.state().dialog).toBeNull()
    h.ed.ctx.select(['a'])
    h.key('M', { meta: true, shift: true })
    expect(h.state().dialog?.id).toBe('transform-move')
    h.ed.store.setState({ dialog: null })
    h.key('Î', { meta: true, shift: true, alt: true, code: 'KeyD' })
    expect(h.state().dialog?.id).toBe('transform-each')
  })

  it('Flip Horizontal mirrors about the reference point; on v1 drawings text cannot be flipped (honestly disabled)', async () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    setTransformPrefs({ refPoint: 'l' })
    h.run('object.flipHorizontal')
    expectBox(box(h, 'a'), -10, 0, 10, 10)
    const t = harness(blank([{ id: 't', type: 'text', x: 0, y: 0, w: 50, text: 'x', fontSize: 12, fill: { type: 'solid', color: '#000' } }]))
    t.ed.ctx.select(['t'])
    const { commandById } = await import('../../../src/renderer/src/components/documents/draw/commands/registry')
    expect(commandById('object.flipHorizontal')!.enabled!(t.ed.ctx)).toBe(false)
  })

  it('Reset Bounding Box is enabled only for turned frames on a drawing that can hold a matrix', async () => {
    const { commandById } = await import('../../../src/renderer/src/components/documents/draw/commands/registry')
    const reset = commandById('object.transform.resetBoundingBox')!
    const v1 = harness(blank([image('i', 0, 0, 40, 30, { rotation: 30 })]))
    v1.ed.ctx.select(['i'])
    expect(reset.enabled!(v1.ed.ctx)).toBe(false)
    const h = v2([image('i', 0, 0, 40, 30, { rotation: 30 }), rect('a', 0, 0, 5, 5)])
    h.ed.ctx.select(['a'])
    expect(reset.enabled!(h.ed.ctx)).toBe(false)
    h.ed.ctx.select(['i'])
    expect(reset.enabled!(h.ed.ctx)).toBe(true)
    h.run('object.transform.resetBoundingBox')
    const i = obj(h, 'i') as DrawImageNode
    expect(i.rotation).toBeUndefined()
    expect(transformReadout(h.doc(), ['i'])!.rotate).toBeCloseTo(-30)
  })

  it('Transform Again replays a Transform Each, and is off until something has been transformed', async () => {
    const { commandById } = await import('../../../src/renderer/src/components/documents/draw/commands/registry')
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 100, 0, 10, 10)]))
    h.ed.ctx.select(['a', 'b'])
    expect(commandById('object.transformAgain')!.enabled!(h.ed.ctx)).toBe(false)
    h.run('object.transform.apply', { matrix: [2, 0, 0, 2, 0, 0], label: 'Scale' })
    expect(commandById('object.transformAgain')!.enabled!(h.ed.ctx)).toBe(true)
    expect(box(h, 'b')).toEqual({ x: 200, y: 0, w: 20, h: 20 })
    h.run('object.transform.apply', { matrix: 'nope' })
    expect(h.state().status).toMatch(/not a valid matrix/)
  })
})

describe('Transform panel maths', () => {
  it('reads X/Y/W/H of the editable selection and a frame\'s own turn', () => {
    const h = harness(blank([rect('a', 10, 20, 30, 40), image('i', 0, 0, 40, 30, { rotation: -45 }), rect('lk', 500, 500, 5, 5, { locked: true })]))
    const r = transformReadout(h.doc(), ['a', 'lk'])!
    expect(r.ids).toEqual(['a'])
    expect(r.box).toEqual({ x: 10, y: 20, w: 30, h: 40 })
    expect(r.rotate).toBe(0)
    expect(transformReadout(h.doc(), ['i'])!.rotate).toBeCloseTo(45)
    expect(transformReadout(h.doc(), ['lk'])).toBeNull()
  })

  it('typing a rotation or shear applies the difference from what the node has', () => {
    const img = { id: 'i', type: 'image', x: 0, y: 0, w: 40, h: 30, assetId: 'x', rotation: -30 } as DrawImageNode
    const d = orientationDelta(img, { rotate: 50 })!
    // Turning by a further 20° counter-clockwise: internal -20°.
    expect(Math.atan2(d[1], d[0]) * (180 / Math.PI)).toBeCloseTo(-20)
    const s = orientationDelta(null, { shear: 30 })!
    expect(s[2]).toBeCloseTo(-Math.tan(Math.PI / 6))
  })
})

describe('Align panel commands', () => {
  it('clicking a selected object makes it the key object; aligning then leaves the key where it is', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 50, 40, 20, 20), rect('c', 100, 10, 10, 10)]))
    h.ed.ctx.select(['a', 'b', 'c'])
    h.run('object.alignTo.key')
    h.click(60, 50)
    expect(alignState(h.state())).toMatchObject({ to: 'key', keyId: 'b' })
    expect(h.state().selection).toEqual(['a', 'b', 'c'])
    h.run('object.align.top')
    expect(['a', 'b', 'c'].map((id) => box(h, id).y)).toEqual([40, 40, 40])
    expect(box(h, 'b').x).toBe(50)
  })

  it('distribute spacing by an exact value from the key object, as one undo step', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 50, 0, 20, 20), rect('c', 100, 0, 10, 10)]))
    h.ed.ctx.select(['a', 'b', 'c'])
    h.run('object.alignTo.key')
    h.run('object.alignKey', 'a')
    h.run('object.alignSpacing', 15)
    h.run('object.distributeSpacing.h')
    expect(['a', 'b', 'c'].map((id) => box(h, id).x)).toEqual([0, 25, 60])
    expect(h.state().past).toHaveLength(1)
  })

  it('align to artboard moves even a multi-selection to the page edge', () => {
    const h = harness(blank([rect('a', 10, 10, 10, 10), rect('b', 50, 50, 10, 10)]))
    h.ed.ctx.select(['a', 'b'])
    h.run('object.alignTo.artboard')
    h.run('object.align.right')
    expect(['a', 'b'].map((id) => box(h, id).x + box(h, id).w)).toEqual([400, 400])
  })
})
