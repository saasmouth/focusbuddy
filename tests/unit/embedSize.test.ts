// A dropped embed starts the shape of its content (owner, 4.3.44).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentAspect, fitEmbedBox } from '../../src/renderer/src/components/documents/embed/embedSize'

const sheet = (rows: number, cols: number): unknown => ({
  version: 2,
  activeSheet: 0,
  sheets: [{ id: 't', name: 'Sheet1', columns: Array.from({ length: cols }, (_, i) => String.fromCharCode(65 + i)), rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'x')) }]
})

describe('documentAspect', () => {
  it('a deck is a 16:9 slide', async () => {
    expect(await documentAspect('slides', { slides: [] })).toBeCloseTo(9 / 16)
  })

  it('a design is its page', async () => {
    expect(await documentAspect('design', { width: 1080, height: 1350 })).toBeCloseTo(1.25)
  })

  it('a drawing is its artboard', async () => {
    const body = { schemaVersion: 2, artboards: [{ id: 'a', name: 'A', x: 0, y: 0, w: 800, h: 1200, background: { type: 'solid', color: '#fff' } }], layers: [] }
    expect(await documentAspect('draw', body)).toBeCloseTo(1.5)
  })

  it('a diagram laid out across is wide, one laid out down is tall', async () => {
    const across = { nodes: [{ id: 'a', x: 0, y: 0, label: 'A' }, { id: 'b', x: 600, y: 0, label: 'B' }, { id: 'c', x: 1200, y: 0, label: 'C' }], edges: [] }
    const down = { nodes: [{ id: 'a', x: 0, y: 0, label: 'A' }, { id: 'b', x: 0, y: 600, label: 'B' }, { id: 'c', x: 0, y: 1200, label: 'C' }], edges: [] }
    expect(await documentAspect('map', across)).toBeLessThan(1)
    expect(await documentAspect('map', down)).toBeGreaterThan(1)
  })

  it('a long narrow sheet is tall, a short wide one is wide', async () => {
    expect(await documentAspect('sheet', sheet(20, 2))).toBeGreaterThan(1)
    expect(await documentAspect('sheet', sheet(3, 8))).toBeLessThan(1)
  })

  it('running text has no shape of its own', async () => {
    expect(await documentAspect('doc', { type: 'doc', content: [] })).toBeNull()
  })
})

describe('fitEmbedBox', () => {
  afterEach(() => vi.unstubAllGlobals())
  const withDoc = (docType: string, body: unknown): void => {
    vi.stubGlobal('window', { api: { documents: { get: async () => ({ id: 'd', docType, body }) } } })
  }

  it('keeps the default width and takes the content height', async () => {
    withDoc('slides', { slides: [] })
    expect(await fitEmbedBox('doc:d', { w: 480, h: 320, maxH: 600 })).toEqual({ w: 480, h: 270 })
  })

  it('narrows tall content rather than running past the host', async () => {
    withDoc('design', { width: 1000, height: 3000 })
    expect(await fitEmbedBox('doc:d', { w: 400, h: 280, maxH: 600 })).toEqual({ w: 200, h: 600 })
  })

  it('keeps the default box when the content has no shape, or cannot be read', async () => {
    withDoc('doc', { type: 'doc', content: [] })
    expect(await fitEmbedBox('doc:d', { w: 320, h: 220, maxH: 520 })).toEqual({ w: 320, h: 220 })
    vi.stubGlobal('window', { api: { documents: { get: async () => { throw new Error('offline') } } } })
    expect(await fitEmbedBox('doc:d', { w: 320, h: 220, maxH: 520 })).toEqual({ w: 320, h: 220 })
  })
})
