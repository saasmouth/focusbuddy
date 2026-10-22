// Paint layers follow their artboard (4.3.41). A paint layer belongs to an
// artboard by its own origin and extent (its frame): ON it when the frame lies
// wholly inside, and its PAGE-SIZED paint when the frame is exactly the
// artboard. Moving carries the paint with the art (frames only, no pixels);
// resizing re-lays page-sized paint onto the new size, unscaled; each is one
// undo step. Pure ops first, then the editor (tool, tab, panel, Rearrange,
// Document › Artboard size), then the frame on screen, in export and on load.

import { describe, expect, it } from 'vitest'
import type { DrawDoc, DrawDocRasterLayer } from '../../../src/shared/draw/model'
import { normalizeDrawDoc } from '../../../src/shared/draw/normalize'
import { normPaintFrame } from '../../../src/shared/draw/fields/paintFrame'
import {
  applyPaintFollow,
  moveArtboards,
  paintOnArtboard,
  planPaintFollow,
  rasterLayerFrame,
  rearrangeArtboards
} from '../../../src/shared/draw/ops'
import { drawDocToSvg } from '../../../src/shared/draw/svg'
import { harness, rect } from './harness'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

type Board = { id: string; x: number; y: number; w: number; h: number }
type Paint = { id: string; assetId?: string; frame?: { x: number; y: number; w: number; h: number }; locked?: boolean }

function doc(boards: Board[], paints: Paint[], objects: unknown[] = []): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: boards.map((b, i) => ({ name: `Artboard ${i + 1}`, background: { type: 'solid', color: '#ffffff' }, ...b })),
    activeArtboardId: boards[0].id,
    layers: [
      { id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects },
      ...paints.map((p) => ({ kind: 'raster', name: p.id, visible: true, locked: !!p.locked, opacity: 1, blend: 'normal', ...p }))
    ],
    activeLayerId: 'L1',
    assets: { a1: { mime: 'image/png', dataUrl: PNG }, a2: { mime: 'image/png', dataUrl: PNG2 } },
    swatches: [],
    guides: [],
    settings: {}
  }
}

const TWO = [
  { id: 'artboard-1', x: 0, y: 0, w: 400, h: 300 },
  { id: 'b2', x: 500, y: 0, w: 200, h: 100 }
]

const paintLayer = (d: DrawDoc, id: string) => d.layers.find((l) => l.id === id) as DrawDocRasterLayer

describe('which paint belongs to an artboard (ops)', () => {
  it('a paint layer with no frame lies on the first page at the origin; a frame says where it lies', () => {
    const d = harness(doc(TWO, [{ id: 'P', assetId: 'a1' }, { id: 'Q', assetId: 'a2', frame: { x: 500, y: 0, w: 200, h: 100 } }])).doc()
    expect(rasterLayerFrame(d, paintLayer(d, 'P'))).toEqual({ x: 0, y: 0, w: 400, h: 300 })
    expect(rasterLayerFrame(d, paintLayer(d, 'Q'))).toEqual({ x: 500, y: 0, w: 200, h: 100 })
    expect(paintOnArtboard(d, d.artboards[0])).toEqual(['P'])
    expect(paintOnArtboard(d, d.artboards[1])).toEqual(['Q'])
  })

  it('a locked paint layer, or one sticking out of the artboard, is not on it', () => {
    const d = harness(doc(TWO, [{ id: 'P', assetId: 'a1', locked: true }, { id: 'Q', assetId: 'a2', frame: { x: 450, y: 0, w: 200, h: 100 } }])).doc()
    expect(paintOnArtboard(d, d.artboards[0])).toEqual([])
    expect(paintOnArtboard(d, d.artboards[1])).toEqual([])
  })
})

describe('moving an artboard carries its paint with its art (ops)', () => {
  it('moveArtboards with the art: the frame moves with the art, by the same whole amount; pixels untouched', () => {
    const d = harness(doc(TWO, [{ id: 'P', assetId: 'a1' }, { id: 'Q', assetId: 'a2', frame: { x: 500, y: 0, w: 200, h: 100 } }], [rect('r', 10, 10, 20, 20)])).doc()
    const m = moveArtboards(d, ['artboard-1'], 30.4, -20)
    expect(paintLayer(m, 'P').frame).toEqual({ x: 30, y: -20, w: 400, h: 300 })
    expect(paintLayer(m, 'P').assetId).toBe('a1')
    // The other artboard's paint stays.
    expect(paintLayer(m, 'Q')).toBe(paintLayer(d, 'Q'))
    // The art moved by the same amount.
    const r = (m.layers[0] as { objects: Array<{ path: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }> }).objects[0]
    expect(r.path.subpaths[0].nodes[0]).toEqual({ x: 40, y: -10 })
  })

  it('without "Move/Copy Artwork with Artboard" neither the art nor the paint moves', () => {
    const d = harness(doc(TWO, [{ id: 'P', assetId: 'a1' }])).doc()
    expect(paintLayer(moveArtboards(d, ['artboard-1'], 30, 0, false), 'P')).toBe(paintLayer(d, 'P'))
  })

  it('Rearrange All carries each artboard’s paint to its new place', () => {
    const boards = [
      { id: 'artboard-1', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b2', x: 300, y: 300, w: 100, h: 100 }
    ]
    const d = harness(doc(boards, [{ id: 'P', assetId: 'a1', frame: { x: 300, y: 300, w: 100, h: 100 } }])).doc()
    const r = rearrangeArtboards(d, { layout: 'row', count: 2, spacing: 10, withArt: true })
    expect(r.artboards.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [110, 0]
    ])
    expect(paintLayer(r, 'P').frame).toEqual({ x: 110, y: 0, w: 100, h: 100 })
  })
})

describe('resizing an artboard re-lays its page-sized paint (ops)', () => {
  it('plans a re-lay only for unlocked paint exactly the artboard’s size and place, only when the size changes', () => {
    const d = harness(doc(TWO, [{ id: 'P', assetId: 'a1' }, { id: 'S', assetId: 'a2', frame: { x: 10, y: 10, w: 50, h: 50 } }, { id: 'L', assetId: 'a2', locked: true }])).doc()
    const from = d.artboards[0]
    // Grown leftwards by 40: the old pixels sit 40 in on the new canvas.
    expect(planPaintFollow(d, from, { x: -40, y: 0, w: 440, h: 300 })).toEqual([{ layerId: 'P', from: { x: 0, y: 0, w: 400, h: 300 }, to: { x: -40, y: 0, w: 440, h: 300 }, dx: 40, dy: 0 }])
    // Moved only: nothing to re-lay (moving goes through moveArtboards).
    expect(planPaintFollow(d, from, { x: 30, y: 30, w: 400, h: 300 })).toEqual([])
    // A shift (Document › Artboard size's anchor) moves the pixels with the art.
    expect(planPaintFollow(d, from, { x: 0, y: 0, w: 600, h: 500 }, { dx: 100, dy: 100 })[0]).toMatchObject({ dx: 100, dy: 100 })
  })

  it('applies new pixels and frames; the default frame is not written; a layer that could not be re-laid is left alone', () => {
    const d = harness(doc([{ id: 'artboard-1', x: 0, y: 0, w: 400, h: 300 }], [{ id: 'P', assetId: 'a1' }, { id: 'E' }])).doc()
    const plans = planPaintFollow(d, d.artboards[0], { x: 0, y: 0, w: 500, h: 300 })
    expect(plans.map((p) => p.layerId)).toEqual(['P', 'E'])
    // The artboard itself becomes 500 wide, so the default frame is 500 wide too: nothing new is written.
    const sized = { ...d, artboards: [{ ...d.artboards[0], w: 500 }] }
    const out = applyPaintFollow(sized, plans, { P: 'a2', E: undefined })
    expect(paintLayer(out, 'P')).toMatchObject({ assetId: 'a2' })
    expect(paintLayer(out, 'P').frame).toBeUndefined()
    expect(paintLayer(out, 'E').assetId).toBeUndefined()
    // With no new pixels for P, P keeps its old frame and picture.
    expect(paintLayer(applyPaintFollow(sized, plans, {}), 'P')).toBe(paintLayer(sized, 'P'))
  })
})

describe('in the editor: one undo step each, art and pixels together', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('the Artboard tool moves an artboard with its art and its paint in one step; undo puts both back', () => {
    const h = harness(doc(TWO, [{ id: 'P', assetId: 'a1' }], [rect('r', 10, 10, 20, 20)]))
    h.tool('artboard')
    h.drag([200, 150], [260, 190])
    expect(h.doc().artboards[0]).toMatchObject({ x: 60, y: 40 })
    expect(paintLayer(h.doc(), 'P').frame).toEqual({ x: 60, y: 40, w: 400, h: 300 })
    const r = h.objects().find((o) => o.id === 'r') as { path: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }
    expect(r.path.subpaths[0].nodes[0]).toEqual({ x: 70, y: 50 })
    expect(h.state().past).toHaveLength(1)
    expect(h.raster.reframes).toHaveLength(0) // a move never touches the pixels
    h.run('edit.undo')
    expect(paintLayer(h.doc(), 'P').frame).toBeUndefined()
    expect(h.doc().artboards[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('the Artboard tab’s W re-lays the page’s paint at the new size, unscaled, in one step; undo restores pixels and size', async () => {
    const h = harness(doc(TWO, [{ id: 'P', assetId: 'a1' }]))
    await h.ed.ctx.run('artboard.patch', { id: 'artboard-1', patch: { w: 640 }, label: 'Artboard size' })
    await settle()
    expect(h.raster.reframes).toEqual([{ src: PNG, from: { w: 400, h: 300 }, to: { w: 640, h: 300 }, dx: 0, dy: 0 }])
    const p = paintLayer(h.doc(), 'P')
    expect(p.assetId).not.toBe('a1')
    expect(h.doc().assets[p.assetId!]).toMatchObject({ w: 640, h: 300 })
    expect(rasterLayerFrame(h.doc(), p)).toEqual({ x: 0, y: 0, w: 640, h: 300 })
    expect(h.state().past).toHaveLength(1)
    h.run('edit.undo')
    expect(paintLayer(h.doc(), 'P').assetId).toBe('a1')
    expect(h.doc().artboards[0].w).toBe(400)
  })

  it('resizing with the tool’s left handle keeps the pixels where they were in the document, in the same undo step', async () => {
    const h = harness(doc(TWO, [{ id: 'P', assetId: 'a1' }]))
    h.ed.ctx.run('artboard.activate', 'artboard-1')
    h.tool('artboard')
    h.drag([0, 150], [-50, 150]) // the west handle
    await settle()
    expect(h.doc().artboards[0]).toMatchObject({ x: -50, w: 450 })
    expect(h.raster.reframes).toEqual([{ src: PNG, from: { w: 400, h: 300 }, to: { w: 450, h: 300 }, dx: 50, dy: 0 }])
    expect(paintLayer(h.doc(), 'P').frame).toEqual({ x: -50, y: 0, w: 450, h: 300 })
    expect(h.state().past).toHaveLength(1)
    h.run('edit.undo')
    expect(paintLayer(h.doc(), 'P')).toMatchObject({ assetId: 'a1' })
    expect(paintLayer(h.doc(), 'P').frame).toBeUndefined()
  })

  it('Document › Artboard size from the centre (one artboard): the pixels move with the art by the anchor offset', async () => {
    const h = harness(doc([{ id: 'artboard-1', x: 0, y: 0, w: 400, h: 300 }], [{ id: 'P', assetId: 'a1' }]))
    await h.ed.ctx.run('document.resize', { w: 600, h: 500, anchor: 'c' })
    await settle()
    expect(h.raster.reframes).toEqual([{ src: PNG, from: { w: 400, h: 300 }, to: { w: 600, h: 500 }, dx: 100, dy: 100 }])
    // Still the first page at the origin: no frame written.
    expect(paintLayer(h.doc(), 'P').frame).toBeUndefined()
    expect(h.state().past).toHaveLength(1)
  })

  it('a picture that cannot be decoded is never blanked: that layer stays as it was', async () => {
    const h = harness(doc(TWO, [{ id: 'P', assetId: 'a1' }]))
    h.raster.undecodable.add(PNG)
    await h.ed.ctx.run('artboard.patch', { id: 'artboard-1', patch: { w: 640 } })
    await settle()
    expect(h.doc().artboards[0].w).toBe(640)
    expect(paintLayer(h.doc(), 'P')).toMatchObject({ assetId: 'a1' })
    expect(paintLayer(h.doc(), 'P').frame).toBeUndefined()
  })

  it('a brush stroke on paint that has moved lands where it is drawn', () => {
    const h = harness(doc(TWO, [{ id: 'P', frame: { x: 500, y: 0, w: 200, h: 100 } }]))
    h.ed.store.setState({ doc: { ...h.doc(), activeLayerId: 'P' } })
    h.tool('brush')
    h.drag([510, 10], [530, 10])
    // Painted near the layer's own top-left, not off its canvas.
    expect(h.raster.painted('P')).toBeGreaterThan(0)
    expect(h.raster.sample('P', { x: 520, y: 10 })).not.toBeNull()
    expect(h.raster.sample('P', { x: 20, y: 10 })).toBeNull()
  })
})

describe('the frame on load and in export', () => {
  it('normalising keeps a valid frame and drops a bad one', () => {
    expect(normPaintFrame({ x: 1.4, y: -2, w: 10.6, h: 3 })).toEqual({ x: 1, y: -2, w: 11, h: 3 })
    expect(normPaintFrame({ x: 'a', y: 0, w: 1, h: 1 })).toBeUndefined()
    expect(normPaintFrame({ x: 0, y: 0, w: 0, h: 1 })).toBeUndefined()
    expect(normPaintFrame({ x: 0, y: 0, w: 20000, h: 1 })).toBeUndefined()
    const n = normalizeDrawDoc(doc(TWO, [{ id: 'P', assetId: 'a1', frame: { x: 500, y: 0, w: 200, h: 100 } }, { id: 'Q', assetId: 'a2', frame: { x: 'bad' } as never }]))
    expect(paintLayer(n, 'P').frame).toEqual({ x: 500, y: 0, w: 200, h: 100 })
    expect(paintLayer(n, 'Q').frame).toBeUndefined()
  })

  it('export draws the paint where it lies', () => {
    const n = normalizeDrawDoc(doc(TWO, [{ id: 'P', assetId: 'a1', frame: { x: 500, y: 0, w: 200, h: 100 } }]))
    const svg = drawDocToSvg(n, { artboardId: 'b2' } as never)
    expect(svg).toMatch(/<image href="data:image\/png[^"]*" x="500" y="0" width="200" height="100"/)
  })
})
