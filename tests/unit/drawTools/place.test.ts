import { describe, it, expect, afterEach } from 'vitest'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import { harness, blank, rect, withDocument, withOlderPeer } from './harness'
import { bytesToBase64 } from '../../../src/shared/draw/import/imageInfo'
import type { XmlDocument } from '../../../src/shared/draw/import/svg'
import type { DrawDoc, DrawGroupNode, DrawImageNode, DrawNode, DrawPathNode } from '../../../src/shared/draw/model'
import { drawDocCompatibility } from '../../../src/shared/draw/compat'
import { isV1Representable } from '../../../src/shared/draw/migrate'
import { normalizeDrawDoc } from '../../../src/shared/draw/normalize'
import { loadPlaceCursor, placeRect, type PlaceItem } from '../../../src/renderer/src/components/documents/draw/editor/place'
import { importStructure, prepareFile, type ImportDeps, type ImportFile } from '../../../src/renderer/src/components/documents/draw/editor/importFiles'
import { dragHasFiles, placeDroppedFiles } from '../../../src/renderer/src/components/documents/draw/editor/fileDrop'
import { setImportHost, type ImportHost } from '../../../src/renderer/src/components/documents/draw/commands/import.commands'
import { commandById } from '../../../src/renderer/src/components/documents/draw/commands/registry'

// File › Place, Import SVG, Open SVG, Replace image and file drops (WP-IMPORT),
// driven through the real editor with the side effects faked: XML via
// @xmldom/xmldom, rasterising and PDF rendering by stand-ins that return a real
// (tiny) PNG.

function png(w: number, h: number, ppi?: number): Uint8Array {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
  const chunk = (type: string, data: number[]): void => {
    parts.push(...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0)
  }
  chunk('IHDR', [...u32(w), ...u32(h), 8, 6, 0, 0, 0])
  if (ppi) chunk('pHYs', [...u32(Math.round(ppi / 0.0254)), ...u32(Math.round(ppi / 0.0254)), 1])
  chunk('IEND', [])
  return new Uint8Array(parts)
}

const PNG_URL = `data:image/png;base64,${bytesToBase64(png(2, 2))}`

function parseXml(s: string): XmlDocument {
  return new XmlDomParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} } } as never).parseFromString(s, 'image/svg+xml') as unknown as XmlDocument
}

const pdfCalls: number[] = []
const deps: ImportDeps = {
  parseXml,
  rasterize: async () => PNG_URL,
  pdfPage: async (_bytes, page) => {
    pdfCalls.push(page)
    return page <= 3 ? { ok: true, dataUrl: PNG_URL, w: 612, h: 792, pages: 3 } : { ok: false, error: 'no such page' }
  },
  gunzip: async () => {
    throw new Error('not used')
  }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const SVG = enc(
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50" fill="#ff0000"/><circle cx="50" cy="25" r="10" fill="#0000ff" stroke="#000" stroke-width="2"/></svg>'
)

function item(name: string, w: number, h: number): PlaceItem {
  return {
    name,
    label: 'image',
    size: { w, h },
    make: (r) => ({ nodes: [{ id: `img-${name}`, type: 'image', x: r.x, y: r.y, w: r.w, h: r.h, assetId: 'asset-00000000000000000000000000000000' }], assets: { 'asset-00000000000000000000000000000000': { mime: 'image/png', dataUrl: PNG_URL, w: 2, h: 2 } } })
  }
}

function v2Body(objects: unknown[] = []): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'a1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick()
}

function all(nodes: DrawNode[]): DrawNode[] {
  return nodes.flatMap((n) => (n.type === 'group' ? [n, ...all(n.children)] : [n]))
}

afterEach(() => setImportHost(null))

describe('the place cursor', () => {
  it('a click places the next file at actual size, top-left at the click, as one undo step', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    loadPlaceCursor(h.ed.ctx, [item('one', 120, 80), item('two', 40, 40)])
    expect(h.state().tool).toBe('place')
    h.click(50, 60)
    const placed = h.objects().find((o) => o.id === 'img-one') as DrawImageNode
    expect(placed).toMatchObject({ x: 50, y: 60, w: 120, h: 80 })
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Place image')
    expect(h.state().selection).toEqual(['img-one'])
    // The next file is loaded; placing it ends the cursor.
    expect(h.state().placing?.items.map((i) => i.name)).toEqual(['two'])
    h.click(0, 0)
    expect(h.state().placing).toBeNull()
    expect(h.state().tool).toBe('select')
  })

  it('a drag places it into the dragged box at its own proportions, in any direction', () => {
    expect(placeRect({ size: { w: 100, h: 50 } }, { x: 10, y: 10 }, { x: 210, y: 30 })).toEqual({ x: 10, y: 10, w: 200, h: 100 })
    expect(placeRect({ size: { w: 100, h: 50 } }, { x: 100, y: 100 }, { x: 80, y: 20 })).toEqual({ x: -60, y: 20, w: 160, h: 80 })
    const h = harness(blank())
    loadPlaceCursor(h.ed.ctx, [item('one', 100, 50)])
    h.drag([20, 20], [120, 40])
    expect(h.objects()[0]).toMatchObject({ x: 20, y: 20, w: 100, h: 50 })
  })

  it('Escape discards the file in the cursor; another tool unloads them all', () => {
    const h = harness(blank())
    loadPlaceCursor(h.ed.ctx, [item('one', 10, 10), item('two', 10, 10)])
    h.key('Escape')
    expect(h.state().placing?.items.map((i) => i.name)).toEqual(['two'])
    h.key('Escape')
    expect(h.state().placing).toBeNull()
    expect(h.objects()).toHaveLength(0)
    loadPlaceCursor(h.ed.ctx, [item('one', 10, 10)])
    h.ed.ctx.setTool('rect')
    expect(h.state().placing).toBeNull()
  })

  it('a read-only drawing places nothing, and Place is off there', () => {
    const h = harness({ ...blank(), schemaVersion: 3 })
    expect(commandById('file.place')!.enabled!(h.ed.ctx)).toBe(false)
    loadPlaceCursor(h.ed.ctx, [item('one', 10, 10)])
    h.click(5, 5)
    expect(h.objects()).toHaveLength(0)
  })

  it('the place tool is hidden from the toolbox', async () => {
    const { drawTools } = await import('../../../src/renderer/src/components/documents/draw/tools/registry')
    expect(drawTools().find((t) => t.id === 'place')?.hidden).toBe(true)
  })
})

describe('preparing files', () => {
  const opts = { structure: 'v2' as const, newId: ((): ((p: string) => string) => {
    let n = 0
    return (p) => `${p}-${++n}`
  })() }

  it('an image: embedded, actual size from its declared resolution', async () => {
    const it1 = await prepareFile({ name: 'shot.png', bytes: png(400, 200, 144) }, deps, opts)
    expect('error' in it1).toBe(false)
    const p = it1 as PlaceItem
    expect(p.size.w).toBeCloseTo(200)
    expect(p.size.h).toBeCloseTo(100)
    const made = p.make({ x: 1, y: 2, w: 200, h: 100 })
    const img = made.nodes[0] as DrawImageNode
    expect(img).toMatchObject({ type: 'image', x: 1, y: 2, w: 200, h: 100, name: 'shot' })
    expect(made.assets[img.assetId].dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(made.assets[img.assetId]).toMatchObject({ w: 400, h: 200 })
    // On an "A4 at 150 dpi" drawing the same picture is physically bigger.
    const a4 = (await prepareFile({ name: 'shot.png', bytes: png(400, 200, 144) }, deps, { ...opts, docDpi: 150 })) as PlaceItem
    expect(a4.size.w).toBeCloseTo(400 * (150 / 144))
  })

  it('an SVG: editable art in one group named after the file (v2), or loose objects (v1)', async () => {
    const v2 = (await prepareFile({ name: 'logo.svg', bytes: SVG }, deps, opts)) as PlaceItem
    expect(v2.label).toBe('SVG')
    expect(v2.size).toEqual({ w: 100, h: 50 })
    const made = v2.make({ x: 10, y: 10, w: 200, h: 100 })
    const g = made.nodes[0] as DrawGroupNode
    expect(g).toMatchObject({ type: 'group', name: 'logo' })
    const [r, c] = g.children as DrawPathNode[]
    // Scaled 2x into the box, strokes with it.
    expect(r.path.subpaths[0].nodes[2]).toMatchObject({ x: 210, y: 110 })
    expect(c.stroke?.width).toBe(4)
    // Every placement gets fresh ids.
    expect(v2.make({ x: 0, y: 0, w: 100, h: 50 }).nodes[0].id).not.toBe(g.id)
    const v1 = (await prepareFile({ name: 'logo.svg', bytes: SVG }, deps, { ...opts, structure: 'v1' })) as PlaceItem
    expect(v1.make({ x: 0, y: 0, w: 100, h: 50 }).nodes.map((n) => n.type)).toEqual(['path', 'path'])
  })

  it('a PDF page and a PDF-compatible .ai: an image of the page at its size in points, honestly labelled', async () => {
    const pdf = (await prepareFile({ name: 'flyer.pdf', bytes: enc('%PDF-1.7\n') }, deps, { ...opts, page: 2 })) as PlaceItem
    expect(pdf.label).toBe('PDF page 2 of 3')
    expect(pdf.size).toEqual({ w: 612, h: 792 })
    expect(pdf.report?.[0]).toMatch(/placed as an image of page 2/)
    const ai = (await prepareFile({ name: 'art.ai', bytes: enc('%PDF-1.6\n%AI') }, deps, opts)) as PlaceItem
    expect(ai.report?.[0]).toMatch(/PDF-compatible content: Illustrator's own editing data is a private format/)
  })

  it('refuses what it cannot place, saying why, by content not name', async () => {
    expect(await prepareFile({ name: 'x.eps', bytes: enc('%!PS-Adobe-3.0 EPSF') }, deps, opts)).toEqual({ error: expect.stringMatching(/EPS needs a PostScript interpreter/) })
    expect(await prepareFile({ name: 'evil.png', bytes: enc('<html><script>alert(1)</script>') }, deps, opts)).toEqual({ error: expect.stringMatching(/not an image, SVG or PDF/) })
    expect(await prepareFile({ name: 'bad.svg', bytes: enc('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>') }, deps, opts)).toEqual({ error: expect.stringMatching(/external entity/) })
    expect(await prepareFile({ name: 'p.pdf', bytes: enc('%PDF-1.4') }, deps, { ...opts, page: 9 })).toEqual({ error: 'p.pdf: no such page' })
  })
})

describe('the drawing format a placement may use', () => {
  it('a v1 drawing takes groups (v2 writes are on); in a v1-only live session it stays v1; a v2 drawing always does', () => {
    expect(importStructure(harness(blank()).state())).toBe('v2')
    const h1 = withOlderPeer(harness(blank()))
    expect(importStructure(h1.state())).toBe('v1')
    expect(importStructure(withOlderPeer(harness(v2Body())).state())).toBe('v2')
    const h2 = harness(v2Body())
    expect(importStructure(h2.state())).toBe('v2')
  })

  it('placing an SVG into a v1 drawing makes it v2; in a v1-only live session it stays writable as v1', async () => {
    const n = harness(blank())
    await placeDroppedFiles(n.ed.ctx, [{ name: 'logo.svg', bytes: SVG }], { x: 0, y: 0 }, deps)
    expect((n.emitted.at(-1) as { schemaVersion: number }).schemaVersion).toBe(2)
    const h = withOlderPeer(harness(blank()))
    await placeDroppedFiles(h.ed.ctx, [{ name: 'logo.svg', bytes: SVG }], { x: 0, y: 0 }, deps)
    expect(isV1Representable(h.doc())).toBe(true)
    expect((h.emitted.at(-1) as { schemaVersion: number }).schemaVersion).toBe(1)
  })
})

describe('dropping files on the canvas', () => {
  it('places each at the drop point at actual size, cascading, as one undo step', async () => {
    const h = harness(v2Body())
    const files: ImportFile[] = [
      { name: 'a.png', bytes: png(30, 20) },
      { name: 'logo.svg', bytes: SVG },
      { name: 'notes.txt', bytes: enc('hello') }
    ]
    await placeDroppedFiles(h.ed.ctx, files, { x: 100, y: 50 }, deps)
    const objs = h.objects()
    expect(objs.map((o) => o.type)).toEqual(['image', 'group'])
    expect(objs[0]).toMatchObject({ x: 100, y: 50, w: 30, h: 20 })
    expect(all([objs[1]]).filter((n) => n.type === 'path')[0]).toMatchObject({ path: { subpaths: [{ nodes: [{ x: 116, y: 66 }, {}, {}, {}] }] } })
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Place 2 files')
    // The file that could not be placed is said.
    expect(h.state().dialog).toMatchObject({ id: 'import-report', props: { reports: [{ name: 'Not placed', lines: [expect.stringMatching(/notes\.txt/)] }] } })
    h.run('edit.undo')
    expect(h.objects()).toHaveLength(0)
  })

  it('a read-only drawing refuses drops, honestly', async () => {
    const h = harness({ ...blank(), schemaVersion: 3 })
    await placeDroppedFiles(h.ed.ctx, [{ name: 'a.png', bytes: png(3, 3) }], { x: 0, y: 0 }, deps)
    expect(h.objects()).toHaveLength(1 - 1)
    expect(h.state().status).toMatch(/read-only/)
  })

  it('recognises a desktop file drag', () => {
    expect(dragHasFiles({ types: ['Files'] })).toBe(true)
    expect(dragHasFiles({ types: ['text/plain', 'application/x-plexii-widget'] })).toBe(false)
  })
})

describe('the File menu commands', () => {
  function host(files: ImportFile[]): ImportHost {
    return { deps: () => deps, pick: async () => ({ ok: files.length > 0, files, skipped: [] }) }
  }
  it('Place… loads the cursor with the picked files', async () => {
    setImportHost(host([{ name: 'a.png', bytes: png(10, 10) }, { name: 'logo.svg', bytes: SVG }]))
    const h = harness(blank())
    h.run('file.place')
    await settle()
    expect(h.state().tool).toBe('place')
    expect(h.state().placing?.items.map((i) => i.name)).toEqual(['a.png', 'logo.svg'])
  })

  it('Place… with a multi-page PDF asks which page first', async () => {
    setImportHost(host([{ name: 'deck.pdf', bytes: enc('%PDF-1.7') }]))
    const h = harness(blank())
    h.run('file.place')
    await settle()
    expect(h.state().dialog).toMatchObject({ id: 'place-pdf-page', props: { pages: 3 } })
    pdfCalls.length = 0
    h.run('file.placePdfPage', { page: 3 })
    await settle()
    expect(pdfCalls).toEqual([3])
    expect(h.state().placing?.items[0].label).toBe('PDF page 3 of 3')
  })

  it('Place as template… is only on where a template layer can be stored, and makes one', async () => {
    expect(commandById('file.placeTemplate')!.enabled!(withOlderPeer(harness(blank())).ed.ctx)).toBe(false)
    expect(commandById('file.placeTemplate')!.enabled!(harness(blank()).ed.ctx)).toBe(true)
    setImportHost(host([{ name: 'sketch.png', bytes: png(50, 40) }]))
    const h = harness(v2Body())
    expect(commandById('file.placeTemplate')!.enabled!(h.ed.ctx)).toBe(true)
    h.run('file.placeTemplate')
    await settle()
    h.click(0, 0)
    const layer = h.doc().layers.at(-1)!
    expect(layer).toMatchObject({ kind: 'vector', template: true, locked: true, name: 'Template: sketch.png' })
    expect(h.state().past.at(-1)?.label).toBe('Place as template')
  })

  it('Import SVG… brings the art in at the file\'s own coordinates, with the import report', async () => {
    setImportHost(host([{ name: 'fx.svg', bytes: enc('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><rect x="5" y="5" width="10" height="10" filter="url(#f)"/><rect x="20" y="20" width="10" height="10"/></svg>') }]))
    const h = harness(v2Body())
    h.run('file.importSvg')
    await settle()
    const g = h.objects()[0] as DrawGroupNode
    expect(g.type).toBe('group')
    expect(g.children.map((c) => c.type)).toEqual(['image', 'path'])
    expect((g.children[1] as DrawPathNode).path.subpaths[0].nodes[0]).toEqual({ x: 20, y: 20 })
    // The filtered element is an embedded image of itself, and the report says so.
    const img = g.children[0] as DrawImageNode
    expect(h.doc().assets[img.assetId].dataUrl).toBe(PNG_URL)
    expect(JSON.stringify(h.state().dialog)).toMatch(/1 filter was not editable here and was rasterised/)
    expect(h.state().past.at(-1)?.label).toBe('Import SVG')
  })

  it('Open SVG… makes a new drawing in the format this build writes', async () => {
    const opened: Array<{ title: string; body: unknown }> = []
    setImportHost(host([{ name: 'poster.svg', bytes: SVG }]))
    const h = withDocument(harness(blank()), { newDocument: async (init) => void opened.push(init!) })
    h.run('file.openSvg')
    await settle()
    expect(opened).toHaveLength(1)
    expect(opened[0].title).toBe('poster')
    const body = opened[0].body as { schemaVersion: number; artboards: Array<{ w: number; h: number }> }
    // v2 writes are on: a new drawing is stored as v2 (builds from local.6 open it read-only, older ones may not).
    expect(body.schemaVersion).toBe(2)
    expect(body.artboards[0]).toMatchObject({ w: 100, h: 50 })
    expect(drawDocCompatibility(body).readOnly).toBe(false)
    const doc: DrawDoc = normalizeDrawDoc(body)
    // The full-page red rect became the page colour.
    expect(doc.artboards[0].background).toEqual({ type: 'solid', color: '#ff0000' })
  })

  it('Open SVG… shows the report first when something could not come in', async () => {
    const opened: Array<{ title: string; body: unknown }> = []
    setImportHost(host([{ name: 'm.svg', bytes: enc('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/a.png" width="5" height="5"/><rect width="2" height="2"/></svg>') }]))
    const h = withDocument(harness(blank()), { newDocument: async (init) => void opened.push(init!) })
    h.run('file.openSvg')
    await settle()
    expect(opened).toHaveLength(0)
    const d = h.state().dialog!
    expect(d.id).toBe('import-report')
    expect(JSON.stringify(d.props)).toMatch(/linked image was not imported/)
    ;(d.props as { action: { run: () => void } }).action.run()
    await settle()
    expect(opened).toHaveLength(1)
  })

  it('Replace image… swaps the picture and keeps its scale and position; it is on only for one image', async () => {
    const body = v2Body([{ id: 'pic', type: 'image', x: 10, y: 20, w: 50, h: 25, assetId: 'asset-11111111111111111111111111111111', rotation: 15 }])
    ;(body as { assets: unknown }).assets = { 'asset-11111111111111111111111111111111': { mime: 'image/png', dataUrl: PNG_URL, w: 100, h: 50 } }
    const h = harness(body)
    expect(commandById('file.replaceImage')!.enabled!(h.ed.ctx)).toBe(false)
    h.ed.ctx.select(['pic'])
    expect(commandById('file.replaceImage')!.enabled!(h.ed.ctx)).toBe(true)
    setImportHost(host([{ name: 'new.png', bytes: png(40, 40) }]))
    h.run('file.replaceImage')
    await settle()
    const pic = h.objects()[0] as DrawImageNode
    // Shown at half its pixel size before, so the new 40 x 40 picture is 20 x 20.
    expect(pic).toMatchObject({ id: 'pic', x: 10, y: 20, w: 20, h: 20, rotation: 15, name: 'new' })
    expect(pic.assetId).not.toBe('asset-11111111111111111111111111111111')
    expect(h.state().past.at(-1)?.label).toBe('Replace image')
  })
})
