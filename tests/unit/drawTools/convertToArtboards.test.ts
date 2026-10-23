// Object › Artboards › Convert to Artboards (4.3.41): which shapes count as
// rectangles, the artboards they become (named in reading order), the shapes
// removed, one undo step, the disabled reason and the gates.

import { describe, expect, it } from 'vitest'
import type { DrawDoc, DrawPathNode } from '../../../src/shared/draw/model'
import { convertToArtboards, convertibleRectangles, isAxisAlignedRectPath, rectangleArtboardBox } from '../../../src/shared/draw/ops'
import { commandById } from '../../../src/renderer/src/components/documents/draw/commands/registry'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import { blank, harness, rect, withOlderPeer } from './harness'

const path = (id: string, nodes: Array<Record<string, number>>, extra: Record<string, unknown> = {}): DrawPathNode =>
  ({ id, type: 'path', path: { subpaths: [{ closed: true, nodes }] }, fill: { type: 'solid', color: '#000000' }, ...extra }) as DrawPathNode

function v2(objects: unknown[], artboards = [{ id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300 }]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: artboards.map((a) => ({ background: { type: 'solid', color: '#ffffff' }, ...a })),
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
}

describe('what counts as a rectangle', () => {
  it('a straight, closed, axis-aligned four-corner path, in either winding, with or without a repeated closing point', () => {
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]))).toBe(true)
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 0 }]))).toBe(true)
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }, { x: 0, y: 0 }]))).toBe(true)
    // Handles sitting on their anchors are still straight sides.
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0, inX: 0, inY: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]))).toBe(true)
  })

  it('not: curved sides, a rotated or skewed outline, a bow tie, an open path, a rounded rectangle, an ellipse, a flat one, two subpaths', () => {
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0, outX: 5, outY: -3 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]))).toBe(false)
    expect(isAxisAlignedRectPath(path('a', [{ x: 5, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 5 }]))).toBe(false)
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 5 }, { x: 2, y: 5 }]))).toBe(false)
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 0 }, { x: 0, y: 5 }]))).toBe(false)
    const open = path('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }])
    open.path.subpaths[0].closed = false
    expect(isAxisAlignedRectPath(open)).toBe(false)
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }], { shapeKind: 'roundRect' }))).toBe(false)
    expect(isAxisAlignedRectPath(path('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }]))).toBe(false)
    const two = path('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }])
    two.path.subpaths.push({ ...two.path.subpaths[0] })
    expect(isAxisAlignedRectPath(two)).toBe(false)
  })

  it('inside a group that moves or scales it: its box where it is drawn; a rotated group refuses', () => {
    const moved = { id: 'g', type: 'group', transform: [2, 0, 0, 2, 100, 50], children: [rect('r', 0, 0, 10, 20)] }
    const h = harness(v2([moved]))
    expect(rectangleArtboardBox(h.doc(), 'r')).toEqual({ x: 100, y: 50, w: 20, h: 40 })
    const turned = { id: 'g', type: 'group', transform: [0, 1, -1, 0, 0, 0], children: [rect('r', 0, 0, 10, 20)] }
    expect(rectangleArtboardBox(harness(v2([turned])).doc(), 'r')).toBeNull()
  })
})

describe('convertToArtboards (pure)', () => {
  it('makes one artboard per rectangle in reading order, named on from the existing ones, removes the shapes, leaves the rest', () => {
    const doc = harness(v2([rect('right', 600, 0, 100, 80), rect('below', 0, 500, 50, 50), rect('left', 450, 0, 100, 80), { ...rect('other', 0, 0, 10, 10), shapeKind: 'ellipse', path: { subpaths: [{ closed: true, nodes: [{ x: 0, y: 0, outX: 5, outY: -2 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }] } }])).doc()
    let n = 0
    const r = convertToArtboards(doc, ['right', 'below', 'left', 'other'], () => `ab${++n}`)
    expect(r.removed).toEqual(['left', 'right', 'below'])
    expect(r.doc.artboards.map((a) => [a.name, a.x, a.y, a.w, a.h])).toEqual([
      ['Artboard 1', 0, 0, 400, 300],
      ['Artboard 2', 450, 0, 100, 80],
      ['Artboard 3', 600, 0, 100, 80],
      ['Artboard 4', 0, 500, 50, 50]
    ])
    expect(r.doc.activeArtboardId).toBe('ab3')
    const left = (r.doc.layers[0] as { objects: Array<{ id: string }> }).objects.map((o) => o.id)
    expect(left).toEqual(['other'])
  })

  it('locked or hidden rectangles are not converted; nothing convertible changes nothing', () => {
    const doc = harness(v2([rect('locked', 0, 0, 10, 10, { locked: true }), rect('hidden', 20, 0, 10, 10, { hidden: true })])).doc() as DrawDoc
    const r = convertToArtboards(doc, ['locked', 'hidden'], () => 'x')
    expect(r.doc).toBe(doc)
    expect(r.created).toEqual([])
    expect(convertibleRectangles(doc, ['locked', 'hidden'])).toEqual([])
  })
})

describe('Object › Artboards › Convert to Artboards', () => {
  it('is disabled with a reason until a rectangle is selected; then converts in ONE undo step and says what it made', () => {
    const h = harness(blank([rect('a', 500, 10, 100, 60), rect('b', 10, 10, 30, 30, { shapeKind: 'ellipse', path: { subpaths: [{ closed: true, nodes: [{ x: 10, y: 10, outX: 20, outY: 0 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }] }] } })]))
    const c = commandById('artboard.convert')!
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe('Select one or more rectangles.')
    h.ed.ctx.select(['b'])
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    const item = buildMenu(h.ed.ctx, 'object').find((i) => i.kind === 'submenu' && i.label === 'Artboards') as { items: Array<{ label: string; disabled?: boolean; hint?: string }> }
    expect(item.items.find((i) => i.label === 'Convert to Artboards')).toMatchObject({ disabled: true, hint: 'Select one or more rectangles.' })
    // Running it anyway (a key) explains and changes nothing.
    h.run('artboard.convert')
    expect(h.state().past).toHaveLength(0)
    expect(h.state().status).toMatch(/Select one or more rectangles/)

    h.ed.ctx.select(['a', 'b'])
    expect(c.enabled!(h.ed.ctx)).toBe(true)
    h.run('artboard.convert')
    expect(h.doc().artboards.map((a) => [a.name, a.x, a.y, a.w, a.h])).toEqual([
      ['Artboard 1', 0, 0, 400, 300],
      ['Artboard 2', 500, 10, 100, 60]
    ])
    expect(h.objects().map((o) => o.id)).toEqual(['b'])
    expect(h.state().selection).toEqual(['b'])
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Convert to Artboard')
    expect(h.state().status).toBe('Made artboard: Artboard 2.')
    h.run('edit.undo')
    expect(h.doc().artboards).toHaveLength(1)
    expect(h.objects().map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('refuses, saying why, in a drawing that must stay v1 for a live session, and on a read-only drawing', () => {
    const live = withOlderPeer(harness(blank([rect('a', 500, 10, 100, 60)])))
    live.ed.ctx.select(['a'])
    const c = commandById('artboard.convert')!
    expect(c.enabled!(live.ed.ctx)).toBe(false)
    expect(c.disabledReason!(live.ed.ctx)).toMatch(/Artboards can't be added or changed/)
    live.run('artboard.convert')
    expect(live.doc().artboards).toHaveLength(1)
    const ro = harness(blank([rect('a', 500, 10, 100, 60)]))
    ro.ed.ctx.select(['a'])
    ro.ed.store.setState({ readOnly: true })
    expect(c.enabled!(ro.ed.ctx)).toBe(false)
    ro.run('artboard.convert')
    expect(ro.doc().artboards).toHaveLength(1)
  })
})
