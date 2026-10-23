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

import type { SnippetBody, SnippetHostKind, SnippetKind } from '../snippets'
import { SNIPPET_KINDS, primaryKindFor } from '../snippets'
import type { ConvertDeps } from '../snippetForms'
import { convertSnippetBody } from '../snippetConvert'

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
