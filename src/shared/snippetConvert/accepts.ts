// Which kinds a host can take, DERIVED from the builders rather than listed.
//
// A target's `accepts` is what the library's kind filter offers, so it must be
// exactly the kinds a conversion INTO the host can produce. Writing that list
// by hand would let it drift from the builders: offer a kind the builder then
// refuses (an insert that always fails), or hide one it could take. So it is
// computed: each kind is offered when the host's builder converts at least one
// representative body of that kind. The probes are small, real bodies of the
// shapes each app's capture produces; nothing about them is shown to anyone.
//
// A kind is accepted when SOME body of it converts. A particular snippet of an
// accepted kind can still be refused (a table work widget into PlexiiWrite);
// the insert then shows the builder's reason verbatim.

import type { SnippetBody, SnippetHostKind, SnippetKind, WidgetSnippetBody } from '../snippets'
import { SNIPPET_KINDS, primaryKindFor } from '../snippets'
import { PDF_FIRST_PAGE, type ConvertDeps, type Form } from '../snippetForms'
import { convertForms, convertSnippetBody, type SnippetConversion } from '../snippetConvert'
import { formsOfWidget } from '../snippetForms/fromWidget'
import { looksLikeHeader, rowsToGfm, rowsToTableNode } from '../snippetForms/rows'

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const p = (text: string): unknown => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const cell = (type: 'tableHeader' | 'tableCell', text: string): unknown => ({ type, content: [p(text)] })

/** Representative bodies of every kind, as each app's capture would produce them. */
export function probeBodies(kind: SnippetKind): SnippetBody[] {
  switch (kind) {
    case 'doc':
      return [
        {
          kind: 'doc',
          content: [
            p('Payment terms'),
            { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'Item'), cell('tableHeader', 'Price')] }, { type: 'tableRow', content: [cell('tableCell', 'Pens'), cell('tableCell', '3')] }] }
          ],
          text: 'Payment terms\nItem Price\nPens 3'
        }
      ]
    case 'sheet':
      return [{ kind: 'sheet', rows: [['Item', 'Price'], ['Pens', '3']] }]
    case 'slide':
      return [
        {
          kind: 'slide',
          elements: [
            { id: 't', type: 'text', x: 0, y: 0, w: 200, h: 40, z: 1, paragraphs: [{ runs: [{ text: 'Title' }] }] },
            { id: 's', type: 'shape', shape: 'rect', x: 0, y: 60, w: 100, h: 60, z: 0, fill: { type: 'solid', color: '#e0e7ff' } }
          ] as never
        }
      ]
    case 'design':
      return [
        {
          kind: 'design',
          elements: [
            { id: 't', type: 'text', x: 0, y: 0, w: 200, h: 40, z: 1, paragraphs: [{ runs: [{ text: 'Title' }] }] },
            { id: 's', type: 'shape', shape: 'rect', x: 0, y: 60, w: 100, h: 60, z: 0, fill: { type: 'solid', color: '#e0e7ff' } }
          ] as never
        }
      ]
    case 'diagram':
      return [
        {
          kind: 'diagram',
          nodes: [
            { id: 'a', x: 0, y: 0, label: 'Start', shape: 'process', color: '#2563eb', width: 140, height: 60 },
            { id: 'b', x: 240, y: 0, label: 'End', shape: 'process', color: '#2563eb', width: 140, height: 60 }
          ],
          edges: [{ id: 'e', source: 'a', target: 'b' }]
        }
      ]
    case 'draw':
      return [
        {
          kind: 'draw',
          objects: [{ id: 'r', type: 'path', shapeKind: 'rect', path: { subpaths: [{ closed: true, nodes: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }] }] }, fill: { type: 'solid', color: '#6d5dfc' } }],
          assets: {},
          swatches: []
        }
      ]
    case 'widget': {
      const w = (widgetKind: string, content: string): SnippetBody => ({ kind: 'widget', widgetKind, title: '', content, width: 2, height: 2, color: null })
      return [
        w('sticky', 'Call the bank'),
        w('markdown', '| Plan | Price |\n|---|---|\n| Pro | 12 |'),
        w('page', JSON.stringify({ type: 'doc', content: [p('Plan')] })),
        w('image', PNG_1PX)
      ]
    }
  }
}

/** Does any representative body of `kind` convert into `to`? */
export function canConvertInto(kind: SnippetKind, to: SnippetKind, deps: ConvertDeps = {}): boolean {
  if (kind === to) return true
  return probeBodies(kind).some((b) => convertSnippetBody(b, to, deps).ok)
}

/**
 * Every kind a host can take: its own, plus each kind with a non-refused
 * conversion into what it holds natively (primaryKindFor). In SNIPPET_KINDS
 * order, so a target's list reads the same everywhere. Pass the renderer's real
 * deps: without PlexiiDraw's SVG writer, for one, a drawing has no picture and
 * so cannot go anywhere but PlexiiDraw.
 */
export function acceptsFor(host: SnippetHostKind, deps: ConvertDeps = {}): SnippetKind[] {
  const to = primaryKindFor(host)
  return SNIPPET_KINDS.filter((k) => canConvertInto(k, to, deps))
}

// ── Files: what a file dropped from the Files panel can become ───────────────
//
// The same idea for FILES: small, real forms of the shapes the Files drop
// reader produces for each kind of file (a picture that is already a row in
// Files, an SVG whose original is the file, the first page of a PDF, a link to
// a file, document or folder, and the text-like files). A destination takes a
// probe when its builder converts it; tests/unit/snippetAcceptsDrift.test.ts
// runs every probe over every office builder and every work widget acceptor
// and checks the verdict against what really lands.

/** The kinds of file a Files drop carries, one representative each. */
export const FILE_PROBES = ['raster', 'svg', 'pdfPage', 'linkFile', 'linkVideo', 'linkAudio', 'linkDocument', 'linkFolder', 'md', 'csv', 'txt'] as const
export type FileProbe = (typeof FILE_PROBES)[number]

/** An fb_files id as the probes carry it. */
export const PROBE_FILE_ID = 'f0e1d2c3-b4a5-4697-8899-aabbccddeeff'

const PROBE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect x="0" y="0" width="120" height="80" fill="#6d5dfc"/></svg>'

const link = (target: 'file' | 'document' | 'folder', href: string, title: string, mime?: string): Form => ({
  kind: 'link',
  value: { href, title, target, ...(mime ? { mime } : {}) },
  lossy: []
})

/** Representative forms of a file of each kind, as the Files drop reader would produce them. */
export function probeFileForms(probe: FileProbe): Form[] {
  switch (probe) {
    case 'raster':
      return [{ kind: 'image', value: { src: PNG_1PX, width: 1, height: 1, alt: 'Receipt.png', fileId: PROBE_FILE_ID }, lossy: [] }]
    case 'svg':
      return [{ kind: 'svg', value: { svg: PROBE_SVG, width: 120, height: 80, vector: true, app: 'the original file' }, lossy: [] }]
    case 'pdfPage':
      return [{ kind: 'image', value: { src: PNG_1PX, width: 1, height: 1, alt: 'Q3 report.pdf' }, lossy: [PDF_FIRST_PAGE] }]
    case 'linkFile':
      return [link('file', `plexii://file/${PROBE_FILE_ID}`, 'Archive.zip', 'application/zip')]
    case 'linkVideo':
      return [link('file', `plexii://file/${PROBE_FILE_ID}`, 'Demo.mp4', 'video/mp4')]
    case 'linkAudio':
      return [link('file', `plexii://file/${PROBE_FILE_ID}`, 'Call.mp3', 'audio/mpeg')]
    case 'linkDocument':
      return [link('document', 'plexii://document/doc-plan', 'Plan')]
    case 'linkFolder':
      return [link('folder', 'plexii://folder/folder-receipts', 'Receipts')]
    case 'md': {
      // A .md file reads as a markdown work widget's content does.
      const body: WidgetSnippetBody = { kind: 'widget', widgetKind: 'markdown', title: '', content: '# Plan\n\n- Call the bank\n- **Pay** the rent', width: 2, height: 2, color: null }
      return formsOfWidget(body).filter((f) => f.kind !== 'native')
    }
    case 'csv': {
      const rows = [['Item', 'Price'], ['Pens', '3']]
      const header = looksLikeHeader(rows)
      return [
        { kind: 'rows', value: { rows, header }, lossy: [] },
        { kind: 'docNodes', value: [rowsToTableNode(rows, header)], lossy: [] },
        { kind: 'markdown', value: rowsToGfm(rows), lossy: [] },
        { kind: 'text', value: rows.map((r) => r.join(',')).join('\n'), lossy: [] }
      ]
    }
    case 'txt':
      return [
        { kind: 'docNodes', value: [p('Call the bank'), p('Pay the rent')], lossy: [] },
        { kind: 'text', value: 'Call the bank\nPay the rent', lossy: [] }
      ]
  }
}

/** What a host's builder makes of one file probe (the verdict and, when it lands, the body). */
export function convertFileProbe(probe: FileProbe, to: SnippetKind, deps: ConvertDeps = {}): SnippetConversion {
  return convertForms(probeFileForms(probe), to, deps)
}

/** Every file probe a host takes, derived from its builder, in FILE_PROBES order. */
export function fileAcceptsFor(host: SnippetHostKind, deps: ConvertDeps = {}): FileProbe[] {
  const to = primaryKindFor(host)
  return FILE_PROBES.filter((probe) => convertFileProbe(probe, to, deps).ok)
}
