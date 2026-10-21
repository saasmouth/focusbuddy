import { describe, it, expect } from 'vitest'
import type { DrawDocRasterLayer } from '../../../src/shared/draw/model'
import { blank, harness } from './harness'

function withPaintLayer(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return blank([], {
    activeLayerId: 'P1',
    layers: [
      { id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] },
      { id: 'P1', kind: 'raster', name: 'Paint', visible: true, locked: false, opacity: 1, blend: 'normal', src: '', ...extra }
    ]
  }, 64, 48)
}

describe('brush tool (B)', () => {
  it('with no paint layer, the first gesture makes one and says so; the next stroke paints', () => {
    const h = harness(blank([], {}, 64, 48))
    h.tool('brush')
    h.drag([5, 5], [40, 20])
    const layers = h.doc().layers
    expect(layers.map((l) => l.kind)).toEqual(['vector', 'raster'])
    expect(h.state().status).toBe('Added a paint layer for you — draw away.')
    const id = layers[1].id
    expect(h.raster.painted(id)).toBe(0)
    h.drag([5, 5], [40, 20])
    expect(h.raster.painted(id)).toBeGreaterThan(0)
  })

  it('one stroke is one undo step, and its pixels are committed to the asset store', () => {
    const h = harness(withPaintLayer())
    h.tool('brush')
    h.drag([5, 5], [50, 30], {}, 5)
    const layer = h.doc().layers[1] as DrawDocRasterLayer
    expect(layer.assetId).toMatch(/^asset-[0-9a-f]{32}$/)
    expect(h.doc().assets[layer.assetId!].dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(h.state().past).toHaveLength(1)
    expect(h.state().scratchVisible).toBe(false)
  })

  it('a locked paint layer is not painted on, and says why', () => {
    const h = harness(withPaintLayer({ locked: true }))
    h.tool('brush')
    h.drag([5, 5], [40, 20])
    expect(h.raster.painted('P1')).toBe(0)
    expect(h.state().status).toBe('That paint layer is locked — unlock it to paint on it.')
  })

  it('a layer whose surface has not mounted yet asks for the stroke again', () => {
    const h = harness(withPaintLayer())
    h.raster.unmounted.add('P1')
    h.tool('brush')
    h.drag([5, 5], [40, 20])
    expect(h.state().status).toBe('That paint layer is not ready yet — try the stroke again.')
    expect(h.state().past).toHaveLength(0)
  })
})

describe('eraser tool (E)', () => {
  it('removes painted pixels where it passes', () => {
    const h = harness(withPaintLayer())
    for (let x = 0; x < 64; x++) for (let y = 0; y < 48; y++) h.raster.setPixel('P1', x, y, [0, 0, 0, 255])
    h.tool('eraser')
    h.drag([5, 24], [60, 24], {}, 6)
    expect(h.raster.sample('P1', { x: 30, y: 24 })).toBeNull()
    expect(h.raster.sample('P1', { x: 30, y: 2 })).toBe('#000000')
  })
})

describe('paint bucket tool (G)', () => {
  it('fills the clicked region with the fill colour as one undo step', () => {
    const h = harness(withPaintLayer())
    h.tool('bucket')
    h.click(10, 10)
    expect(h.raster.sample('P1', { x: 63, y: 47 })).toBe('#6d5dfc')
    expect(h.state().past).toHaveLength(1)
  })

  it('an area already that colour reports so and records nothing', () => {
    const h = harness(withPaintLayer())
    h.tool('bucket')
    h.click(10, 10)
    h.click(10, 10)
    expect(h.state().status).toBe('That area is already this colour.')
    expect(h.state().past).toHaveLength(1)
  })
})
