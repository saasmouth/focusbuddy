// SVG paste: WP-CLIPBOARD's seam with WP-IMPORT's real importer plugged in.
// SVG on the system clipboard (Figma's Copy as SVG, a code editor, a browser)
// pastes as editable vectors, exactly as File › Import SVG would bring it in.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import type { XmlDocument } from '../../../src/shared/draw/import/svg'
import type { DrawGroupNode, DrawPathNode } from '../../../src/shared/draw/model'
import { pasteSvgImporter, setImportHost } from '../../../src/renderer/src/components/documents/draw/commands/import.commands'
import {
  registerSvgPasteImporter,
  setDrawClipboardBackend,
  svgPasteImporter,
  type ClipboardReadResult,
  type DrawClipboardBackend
} from '../../../src/renderer/src/components/documents/draw/editor/clipboard'
import type { ImportDeps } from '../../../src/renderer/src/components/documents/draw/editor/importFiles'
import { blank, harness, rect, type Harness } from './harness'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function parseXml(s: string): XmlDocument {
  return new XmlDomParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} } } as never).parseFromString(s, 'image/svg+xml') as unknown as XmlDocument
}

let rasterized = 0
const deps: ImportDeps = {
  parseXml,
  rasterize: async () => {
    rasterized += 1
    return PNG
  },
  pdfPage: async () => ({ ok: false, error: 'not used' }),
  gunzip: async () => {
    throw new Error('not used')
  }
}

class Clip implements DrawClipboardBackend {
  next: ClipboardReadResult = {}
  async write(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async read(): Promise<ClipboardReadResult> {
    return this.next
  }
  async rasterize(): Promise<string | null> {
    return PNG
  }
}

// What Figma's "Copy as SVG" puts on the clipboard (as plain text).
const FIGMA = '<svg width="100" height="50" viewBox="0 0 100 50" fill="none" xmlns="http://www.w3.org/2000/svg">\n<rect width="100" height="50" fill="#FF0000"/>\n<circle cx="50" cy="25" r="10" fill="#0000FF" stroke="black" stroke-width="2"/>\n</svg>\n'

let cb: Clip
beforeEach(() => {
  cb = new Clip()
  rasterized = 0
  setDrawClipboardBackend(cb)
  setImportHost({ deps: () => deps, pick: async () => ({ ok: false, files: [], skipped: [] }), openNewDrawing: async () => {} })
  registerSvgPasteImporter(pasteSvgImporter)
})
afterEach(() => {
  setDrawClipboardBackend(null)
  setImportHost(null)
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
async function paste(h: Harness, id = 'edit.paste'): Promise<void> {
  h.run(id)
  await settle()
}

function v2(objects: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
}

describe('SVG paste, with WP-IMPORT', () => {
  it('WP-IMPORT registers its importer when the commands load', () => {
    setImportHost(null)
    expect(svgPasteImporter()).toBe(pasteSvgImporter)
  })

  it('Figma SVG text pastes as editable shapes with their colours, one undo step, and a v1 drawing stays v1', async () => {
    cb.next = { text: FIGMA }
    const h = harness(blank([]))
    await paste(h)
    const objs = h.objects()
    expect(objs.map((o) => o.type)).toEqual(['path', 'path'])
    const [r, c] = objs as DrawPathNode[]
    expect(JSON.stringify(r.fill).toLowerCase()).toContain('#ff0000')
    expect(JSON.stringify(c.fill).toLowerCase()).toContain('#0000ff')
    expect(c.stroke?.width).toBe(2)
    expect(h.state().selection.sort()).toEqual(objs.map((o) => o.id).sort())
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste'])
    expect(rasterized).toBe(0)
    expect((h.emitted.at(-1) as { schemaVersion: number }).schemaVersion).toBe(1)
  })

  it('in a v2 drawing it arrives as one group, as Illustrator pastes SVG code; Paste in Front keeps it above the selection', async () => {
    cb.next = { svg: FIGMA }
    const h = harness(v2([rect('a', 10, 10, 20, 20)]))
    h.ed.ctx.select(['a'])
    await paste(h, 'edit.pasteInFront')
    const objs = h.objects()
    expect(objs.map((o) => o.type)).toEqual(['path', 'group'])
    const g = objs[1] as DrawGroupNode
    expect(g.name).toBe('Pasted SVG')
    expect(g.children.map((n) => n.type)).toEqual(['path', 'path'])
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste in Front'])
  })

  it('what the importer cannot edit is rasterised and the report is the status', async () => {
    cb.next = {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><defs><filter id="b"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="40" height="40" fill="#00ff00" filter="url(#b)"/></svg>'
    }
    const h = harness(v2([]))
    await paste(h)
    expect(h.objects()).toHaveLength(1)
    expect(rasterized).toBeGreaterThan(0)
    expect(h.state().status).toBeTruthy()
  })

  it('broken SVG: with a picture alongside it pastes the picture and says why; alone it changes nothing and says why', async () => {
    cb.next = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>', image: { dataUrl: PNG, w: 10, h: 10 } }
    const h = harness(blank([]))
    await paste(h)
    expect(h.objects().map((o) => o.type)).toEqual(['image'])
    expect(h.state().status).toMatch(/^The SVG couldn't be read \(.+\), so it was pasted as a picture\.$/)
    cb.next = { text: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' }
    await paste(h)
    expect(h.objects()).toHaveLength(1)
    expect(h.state().status).toMatch(/^Couldn't paste the SVG: /)
    expect(h.state().past).toHaveLength(1)
  })
})
