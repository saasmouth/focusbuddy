// Realistic snippet bodies for the conversion tests, captured the way each
// app captures a selection (its own *BodyFromSelection), so the converter is
// tested against what the apps really store rather than hand-shaped guesses.

import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import { Editor } from '@tiptap/core'
import type { XmlDocument } from '../../src/shared/draw/import/svg'
import type { DesignSnippetBody, DiagramSnippetBody, DocSnippetBody, DrawSnippetBody, SheetSnippetBody, SlideSnippetBody, WidgetSnippetBody } from '../../src/shared/snippets'
import type { DesignBody } from '../../src/shared/design'
import type { MapEdge, MapNode, SheetTab, SlideElement } from '../../src/shared/types'
import type { ConvertDeps } from '../../src/shared/snippetConvert'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import { buildDocExtensions } from '../../src/renderer/src/components/documents/editor/extensions'
import { docBodyFromSelection } from '../../src/renderer/src/components/documents/editor/docSnippets'
import { sheetBodyFromSelection } from '../../src/renderer/src/components/documents/sheet/cellsSnippets'
import { slideBodyFromSelection } from '../../src/renderer/src/components/documents/slides/deckSnippets'
import { designBodyFromSelection } from '../../src/renderer/src/components/documents/design/designSnippets'
import { diagramBodyFromSelection } from '../../src/renderer/src/components/documents/diagram/diagramSnippets'
import { drawBodyFromSelection } from '../../src/renderer/src/components/documents/draw/editor/drawSnippets'
import { drawBodyToSvg, evaluateSheetBlock, importSvgAsDraw } from '../../src/renderer/src/lib/snippetConvertDeps'

/** A standards XML DOM, as the Draw import tests use (the app uses Chromium's DOMParser). */
export function parseXml(s: string): XmlDocument {
  const errors: string[] = []
  const doc = new XmlDomParser({
    errorHandler: { warning: () => {}, error: (m: string) => errors.push(String(m)), fatalError: (m: string) => errors.push(String(m)) }
  } as never).parseFromString(s, 'image/svg+xml') as unknown as XmlDocument
  if (!errors.length) return doc
  return new XmlDomParser().parseFromString(`<parsererror>${errors[0].replace(/[<&]/g, ' ')}</parsererror>`, 'text/xml') as unknown as XmlDocument
}

/** The real renderer deps, with the XML parser swapped for one that runs under vitest. */
export const DEPS: ConvertDeps = {
  evaluateSheet: evaluateSheetBlock,
  drawToSvg: drawBodyToSvg,
  svgToDraw: (svg) => importSvgAsDraw(svg, parseXml)
}

export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ── PlexiiWrite ──────────────────────────────────────────────────────────────

/** Select everything in a headless Write editor and capture it as Write does. */
export function docFrom(html: string): DocSnippetBody {
  const editor = new Editor({ extensions: buildDocExtensions({ interactive: false }) as never, content: html })
  editor.commands.selectAll()
  const body = docBodyFromSelection(editor as never)
  editor.destroy()
  if (!body) throw new Error('nothing captured')
  return body
}

export const DOC_HTML =
  '<h2>Payment terms</h2>' +
  '<p>Pay within <strong>30 days</strong> of the <a href="https://example.test/inv">invoice</a>.</p>' +
  '<ul><li><p>Bank transfer</p></li><li><p>Card</p></li></ul>' +
  '<table><tbody><tr><th><p>Item</p></th><th><p>Price</p></th></tr><tr><td><p>Design</p></td><td><p>1200</p></td></tr></tbody></table>'

export const doc = (): DocSnippetBody => docFrom(DOC_HTML)

// ── PlexiiCells ──────────────────────────────────────────────────────────────

export function sheet(): SheetSnippetBody {
  const rows = [
    ['', '', '', '', ''],
    ['', 'Item', 'Qty', 'Price', 'Total'],
    ['', 'Pens', '2', '3', '=C3*D3'],
    ['', 'Pads', '4', '5', '=C4*D4'],
    ['', 'Sum', '', '', '=SUM(E3:E4)']
  ]
  const tab: SheetTab = { id: 'tab-1', name: 'Sheet1', columns: ['A', 'B', 'C', 'D', 'E'], rows, formats: { '1,1': { bold: true } } as SheetTab['formats'] }
  const body = sheetBodyFromSelection(tab, { r0: 1, c0: 1, r1: 4, c1: 4 })
  if (!body) throw new Error('nothing captured')
  return body
}

// ── PlexiiDeck ───────────────────────────────────────────────────────────────

export function slide(): SlideSnippetBody {
  const elements = [
    { id: 't1', type: 'text', x: 300, y: 120, w: 400, h: 80, z: 3, paragraphs: [{ runs: [{ text: 'Quarterly ', bold: true }, { text: 'results' }] }, { runs: [{ text: 'Up 12%' }], listStyle: 'bullet' }] },
    { id: 's1', type: 'shape', shape: 'roundRect', x: 280, y: 100, w: 440, h: 140, z: 1, fill: { type: 'solid', color: '#e0e7ff' } },
    { id: 'i1', type: 'image', x: 740, y: 120, w: 80, h: 80, z: 2, src: PNG }
  ] as unknown as SlideElement[]
  const body = slideBodyFromSelection({ id: 'sl1', notes: '', elements }, ['t1', 's1', 'i1'])
  if (!body) throw new Error('nothing captured')
  return body
}

// ── PlexiiDesign ─────────────────────────────────────────────────────────────

export const STORY = { blocks: [{ kind: 'heading', level: 1, text: 'Annual report' }, { kind: 'paragraph', text: 'Revenue grew in every region.' }] }

export function design(): DesignSnippetBody {
  const shape = { id: 's1', type: 'shape', shape: 'rect', x: 200, y: 100, w: 300, h: 200, z: 1, fill: { type: 'solid', color: '#ff0000', swatchId: 'spot-red' } }
  const plain = { id: 'p1', type: 'text', x: 220, y: 320, w: 280, h: 40, z: 3, paragraphs: [{ runs: [{ text: 'Plain caption', fontSize: 14 }] }] }
  const f1 = { id: 'f1', type: 'text', x: 520, y: 100, w: 200, h: 120, z: 4, paragraphs: [], storyId: 'story-a', storyOrder: 1, fontSize: 12 }
  const f2 = { id: 'f2', type: 'text', x: 520, y: 260, w: 200, h: 120, z: 5, paragraphs: [], storyId: 'story-a', storyOrder: 2 }
  const page = [shape, plain, f1, f2] as unknown as SlideElement[]
  const d: DesignBody = {
    schemaVersion: 1,
    width: 1000,
    height: 800,
    elements: page,
    pages: [{ id: 'pg-1', elements: page }],
    activePage: 0,
    stories: { 'story-a': STORY } as DesignBody['stories'],
    swatches: [{ id: 'spot-red', name: 'Pantone Red', color: '#ff0000' }]
  }
  const body = designBodyFromSelection(d, ['s1', 'p1', 'f1', 'f2'])
  if (!body) throw new Error('nothing captured')
  return body
}

// ── PlexiiDiagrams ───────────────────────────────────────────────────────────

export function diagram(): DiagramSnippetBody {
  const nodes: MapNode[] = [
    { id: 'a', x: 100, y: 100, label: 'Start', shape: 'process', color: '#2563eb', width: 140, height: 60 },
    { id: 'b', x: 340, y: 100, label: 'Approved?', shape: 'decision', color: '#2563eb', width: 140, height: 80 }
  ]
  const edges: MapEdge[] = [{ id: 'e1', source: 'a', target: 'b', label: 'submit' }]
  const body = diagramBodyFromSelection({ nodes, edges }, { nodes: new Set(['a', 'b']), edges: new Set() })
  if (!body) throw new Error('nothing captured')
  return body
}

// ── PlexiiDraw ───────────────────────────────────────────────────────────────

export function draw(): DrawSnippetBody {
  const doc = normalizeDrawDoc({
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
    activeLayerId: 'L1',
    layers: [
      {
        id: 'L1',
        kind: 'vector',
        name: 'Layer 1',
        visible: true,
        locked: false,
        opacity: 1,
        blend: 'normal',
        objects: [
          { id: 'r1', type: 'path', shapeKind: 'rect', path: { subpaths: [{ closed: true, nodes: [{ x: 50, y: 40 }, { x: 150, y: 40 }, { x: 150, y: 100 }, { x: 50, y: 100 }] }] }, fill: { type: 'solid', color: '#6d5dfc' } },
          { id: 't1', type: 'text', x: 60, y: 120, w: 160, text: 'Logo mark', fontSize: 18, fill: { type: 'solid', color: '#111111' } }
        ]
      }
    ],
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  })
  const body = drawBodyFromSelection(doc, ['r1', 't1'])
  if (!body) throw new Error('nothing captured')
  return body
}

// ── Work widgets (widgetBodyFromWidget's shape) ──────────────────────────────

export function widget(widgetKind: string, content: string, title = ''): WidgetSnippetBody {
  return { kind: 'widget', widgetKind, title, content, width: 300, height: 240, color: null }
}

export const STICKY = widget('sticky', 'Call the bank\n- confirm limit\n- ask about fees')
export const MARKDOWN = widget('markdown', '## Prices\n\n| Plan | Price |\n|---|---|\n| Pro | $12 |\n| Team | $15 |\n\nAll prices **per month**.')
export const PAGE = widget('page', JSON.stringify({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Ship it.' }] }] }))
export const IMAGE = widget('image', 'https://example.test/logo.png', 'Logo')
export const CARD = widget('card', JSON.stringify({ title: 'Lead', body: 'Acme' }))
export const TABLE = widget('table', 'tbl-123')
