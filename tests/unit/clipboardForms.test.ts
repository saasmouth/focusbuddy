// The clipboard as conversion forms (renderer/src/lib/clipboardForms.ts), from
// plain data as the main process reads it. The property that matters: a copy
// from one of our apps becomes EXACTLY the body that app's own snippet capture
// makes of the same selection, so ⌘V and Insert snippet land identically.
// Then: an envelope version this build does not know is refused, never
// guessed; foreign SVG, pictures, HTML and text become the forms the builders
// take; and a PlexiiCells copy is recognised only while it is still on the
// clipboard.

import { afterEach, describe, expect, it } from 'vitest'
import { formsFromClipboardRead, markCellsCopy, readClipboardForms, readFromDataTransfer, resetCellsCopy, svgSize, DIAGRAM_CLIP_MIME } from '../../src/renderer/src/lib/clipboardForms'
import { buildClipboard } from '../../src/renderer/src/components/documents/draw/editor/clipboard'
import { drawBodyFromSelection } from '../../src/renderer/src/components/documents/draw/editor/drawSnippets'
import { slideBodyFromSelection } from '../../src/renderer/src/components/documents/slides/deckSnippets'
import { designBodyFromSelection } from '../../src/renderer/src/components/documents/design/designSnippets'
import { diagramBodyFromSelection } from '../../src/renderer/src/components/documents/diagram/diagramSnippets'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import { buildElementClipboard, serializeElementClipboard, ELEMENT_CLIP_MIME } from '../../src/shared/elementClipboard'
import { copySelection } from '../../src/shared/diagram/ops'
import { convertForms } from '../../src/shared/snippetConvert'
import { formsOf } from '../../src/shared/snippetForms'
import type { MapEdge, MapNode, SlideElement } from '../../src/shared/types'
import * as F from './snippetConvertFixtures'

afterEach(() => resetCellsCopy())

function drawDoc(): ReturnType<typeof normalizeDrawDoc> {
  return normalizeDrawDoc({
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
    activeLayerId: 'L1',
    layers: [
      {
        id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal',
        objects: [
          { id: 'r1', type: 'path', shapeKind: 'rect', path: { subpaths: [{ closed: true, nodes: [{ x: 50, y: 40 }, { x: 150, y: 40 }, { x: 150, y: 100 }, { x: 50, y: 100 }] }] }, fill: { type: 'solid', color: '#6d5dfc' } },
          { id: 't1', type: 'text', x: 60, y: 120, w: 160, text: 'Logo mark', fontSize: 18, fill: { type: 'solid', color: '#111111' } }
        ]
      }
    ],
    assets: {}, swatches: [], guides: [], settings: {}
  })
}

const SLIDE_ELS = [
  { id: 't1', type: 'text', x: 300, y: 120, w: 400, h: 80, z: 3, paragraphs: [{ runs: [{ text: 'Quarterly ', bold: true }, { text: 'results' }] }] },
  { id: 's1', type: 'shape', shape: 'roundRect', x: 280, y: 100, w: 440, h: 140, z: 1, fill: { type: 'solid', color: '#e0e7ff' } }
] as unknown as SlideElement[]

describe('a copy from one of our apps is that app’s own snippet body', () => {
  it('PlexiiDraw: the same objects, assets and swatches a saved snippet of the selection holds', () => {
    const doc = drawDoc()
    const built = buildClipboard(doc, ['r1', 't1'])!
    const r = formsFromClipboardRead({ drawNative: built.json, svg: built.svg, text: 'Logo mark' }, { deps: F.DEPS })
    expect(r.source).toBe('PlexiiDraw')
    expect(r.kind).toBe('draw')
    const native = r.forms[0]
    expect(native.kind).toBe('native')
    const snippet = drawBodyFromSelection(doc, ['r1', 't1'])!
    expect(native.value).toEqual(snippet)
    // And so it converts exactly as the snippet does.
    expect(convertForms(r.forms, 'doc', F.DEPS)).toEqual(convertForms(formsOf(snippet, F.DEPS), 'doc', F.DEPS))
  })

  it('PlexiiDraw: an envelope version this build does not know is refused, never guessed at', () => {
    const doc = drawDoc()
    const payload = { ...buildClipboard(doc, ['r1'])!.payload, version: 2 }
    const r = formsFromClipboardRead({ drawNative: JSON.stringify(payload), text: 'x' })
    expect(r.forms).toEqual([])
    expect(r.refused).toBe('This was copied from a newer PlexiiDraw, which this version cannot read. Update PlexiiDraw to paste it here.')
  })

  it('PlexiiDraw: objects a newer PlexiiDraw made are left out, and every form says so', () => {
    const doc = drawDoc()
    const payload = buildClipboard(doc, ['r1'])!.payload
    const withFuture = { ...payload, nodes: [...payload.nodes, { id: 'z', type: 'hologram', x: 0, y: 0 }] }
    const r = formsFromClipboardRead({ drawNative: JSON.stringify(withFuture) }, { deps: F.DEPS })
    expect(r.kind).toBe('draw')
    for (const f of r.forms) expect(f.lossy).toContain('1 object made in a newer PlexiiDraw was left out.')
    // Deep copies: the parsed objects share nothing with the payload.
    const objs = (r.forms[0].value as { objects: unknown[] }).objects
    expect(objs).toHaveLength(1)
  })

  it('PlexiiDeck: the elements as slideBodyFromSelection takes them', () => {
    const clip = buildElementClipboard(SLIDE_ELS, { w: 1280, h: 720 }, undefined, 'slide')
    const r = formsFromClipboardRead({ custom: { [ELEMENT_CLIP_MIME]: serializeElementClipboard(clip) }, text: 'Quarterly results' })
    expect(r.source).toBe('PlexiiDeck')
    expect(r.forms[0].value).toEqual(slideBodyFromSelection({ id: 'x', notes: '', elements: SLIDE_ELS } as never, ['t1', 's1']))
  })

  it('PlexiiDesign: elements and the stories threaded frames read, as designBodyFromSelection takes them', () => {
    const f1 = { id: 'f1', type: 'text', x: 520, y: 100, w: 200, h: 120, z: 4, paragraphs: [], storyId: 'story-a', storyOrder: 1 }
    const f2 = { id: 'f2', type: 'text', x: 520, y: 260, w: 200, h: 120, z: 5, paragraphs: [], storyId: 'story-a', storyOrder: 2 }
    const els = [...SLIDE_ELS, f1, f2] as unknown as SlideElement[]
    const stories = { 'story-a': F.STORY }
    const clip = buildElementClipboard(els, { w: 1000, h: 800 }, stories, 'design')
    const r = formsFromClipboardRead({ custom: { [ELEMENT_CLIP_MIME]: serializeElementClipboard(clip) } })
    expect(r.source).toBe('PlexiiDesign')
    const ids = ['t1', 's1', 'f1', 'f2']
    const design = { schemaVersion: 1, width: 1000, height: 800, elements: els, pages: [{ id: 'p', elements: els }], activePage: 0, stories, swatches: [] }
    expect(r.forms[0].value).toEqual(designBodyFromSelection(design as never, ids))
  })

  it('a Deck/Design copy from a build without the app tag reads by what it holds', () => {
    const clip = buildElementClipboard(SLIDE_ELS, { w: 1280, h: 720 })
    const r = formsFromClipboardRead({ custom: { [ELEMENT_CLIP_MIME]: serializeElementClipboard(clip) } })
    expect(r.kind).toBe('slide')
  })

  it('PlexiiDiagrams: the clip, from its private type or from its text, as diagramBodyFromSelection takes it', () => {
    const nodes: MapNode[] = [
      { id: 'a', x: 100, y: 100, label: 'Start', shape: 'process', color: '#2563eb', width: 140, height: 60 },
      { id: 'b', x: 340, y: 100, label: 'Done', shape: 'process', color: '#2563eb', width: 140, height: 60 }
    ]
    const edges: MapEdge[] = [{ id: 'e1', source: 'a', target: 'b' }]
    const json = JSON.stringify(copySelection({ nodes, edges }, { nodes: new Set(['a', 'b']), edges: new Set() }))
    const want = diagramBodyFromSelection({ nodes, edges }, { nodes: new Set(['a', 'b']), edges: new Set() })
    const viaType = formsFromClipboardRead({ custom: { [DIAGRAM_CLIP_MIME]: json }, text: json })
    expect(viaType.source).toBe('PlexiiDiagrams')
    expect(viaType.forms[0].value).toEqual(want)
    const viaText = formsFromClipboardRead({ text: json })
    expect(viaText.forms[0].value).toEqual(want)
  })

  it('PlexiiCells: its copy is a sheet body (formulas as written, at their origin) only while it is still on the clipboard', () => {
    const tsv = 'Qty\tPrice\tTotal\n2\t3\t=A2*B2'
    markCellsCopy(tsv, { r: 0, c: 0 })
    const r = formsFromClipboardRead({ text: tsv }, { deps: F.DEPS })
    expect(r.source).toBe('PlexiiCells')
    expect(r.forms[0].value).toEqual({ kind: 'sheet', rows: [['Qty', 'Price', 'Total'], ['2', '3', '=A2*B2']], origin: { r: 0, c: 0 } })
    // Elsewhere it lands as what the cells display.
    const rows = r.forms.find((f) => f.kind === 'rows')!
    expect((rows.value as { rows: string[][] }).rows[1]).toEqual(['2', '3', '6'])
    // Something else on the clipboard is not a Cells copy, however it looks.
    const other = formsFromClipboardRead({ text: 'Qty\tPrice\n9\t9' }, { deps: F.DEPS })
    expect(other.source).toBeNull()
  })
})

describe('content from anywhere else', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80"/></svg>'

  it('SVG first, sized from its own attributes, its original named honestly', () => {
    const r = formsFromClipboardRead({ svg: SVG, image: { dataUrl: F.PNG, w: 240, h: 160 }, text: 'x' })
    expect(r.source).toBeNull()
    expect(r.forms.map((f) => f.kind)).toEqual(['svg', 'image', 'docNodes', 'text'])
    expect(r.forms[0].value).toMatchObject({ width: 120, height: 80, vector: true, app: 'the app it came from' })
    expect(r.forms[1].value).toEqual({ src: F.PNG, width: 240, height: 160 })
    const doc = convertForms(r.forms, 'doc')
    expect(doc.ok && doc.lossy).toEqual(['It becomes a picture: edit it in the app it came from.'])
  })

  it('svgSize reads width/height, then the viewBox, then falls back', () => {
    expect(svgSize('<svg width="40px" height="30">')).toEqual({ w: 40, h: 30 })
    expect(svgSize('<svg viewBox="0 0 64 48">')).toEqual({ w: 64, h: 48 })
    expect(svgSize('<svg>')).toEqual({ w: 300, h: 150 })
  })

  it('HTML becomes document nodes, and a table its rows', () => {
    const html = '<table><tr><th>Item</th><th>Price</th></tr><tr><td>Pens</td><td>3</td></tr></table>'
    const r = formsFromClipboardRead({ html, text: 'Item\tPrice\nPens\t3' }, { htmlToNodes: () => [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Price' }] }] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pens' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '3' }] }] }] }] }] })
    expect(r.forms.map((f) => f.kind)).toEqual(['docNodes', 'rows', 'text'])
    expect(r.forms[1].value).toEqual({ rows: [['Item', 'Price'], ['Pens', '3']], header: true })
  })

  it('HTML through PlexiiWrite’s own sanitising importer', () => {
    const r = formsFromClipboardRead({ html: '<p>Hello <b>there</b></p><script>alert(1)</script>' })
    expect(r.forms[0].kind).toBe('docNodes')
    expect(JSON.stringify(r.forms[0].value)).not.toContain('alert')
    expect(JSON.stringify(r.forms[0].value)).toContain('there')
  })

  it('TSV text is rows and a table; plain text is paragraphs and text', () => {
    const tsv = formsFromClipboardRead({ text: 'a\tb\n1\t2\n' })
    expect(tsv.forms.map((f) => f.kind)).toEqual(['rows', 'docNodes', 'text'])
    expect(tsv.forms[0].value).toEqual({ rows: [['a', 'b'], ['1', '2']], header: true })
    const plain = formsFromClipboardRead({ text: 'One\r\nTwo' })
    expect(plain.forms.map((f) => f.kind)).toEqual(['docNodes', 'text'])
    expect(plain.forms[1].value).toBe('One\nTwo')
  })

  it('an empty clipboard has no forms', () => {
    expect(formsFromClipboardRead({})).toEqual({ forms: [], source: null, kind: null })
    expect(formsFromClipboardRead({ text: '   ' }).forms).toEqual([])
  })
})

describe('reading', () => {
  it('a paste event’s DataTransfer, where the main process cannot be asked', async () => {
    const data = { getData: (t: string) => ({ [ELEMENT_CLIP_MIME]: serializeElementClipboard(buildElementClipboard(SLIDE_ELS, { w: 1, h: 1 }, undefined, 'slide')), 'text/plain': 'Quarterly results' })[t] ?? '' } as unknown as DataTransfer
    expect(Object.keys(readFromDataTransfer(data).custom ?? {})).toEqual([ELEMENT_CLIP_MIME])
    const r = await readClipboardForms(data, { deps: F.DEPS })
    expect(r.kind).toBe('slide')
  })

  it('the main process when it is there', async () => {
    const g = globalThis as unknown as { api?: unknown }
    const before = g.api
    g.api = { snippets: { readClipboard: async () => ({ text: 'Hello' }) } }
    try {
      const r = await readClipboardForms(null, { deps: F.DEPS })
      expect(r.forms.map((f) => f.kind)).toEqual(['docNodes', 'text'])
    } finally {
      g.api = before
    }
  })
})
