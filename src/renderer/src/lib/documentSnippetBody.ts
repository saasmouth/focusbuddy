// A whole STORED document as a snippet body, for a document dropped from Files
// with ⌥ (insert a copy of its content) or into an app that cannot hold a link
// to it (PlexiiDeck takes a document's text as a text box).
//
// Each document type goes through its app's OWN capture function, the same one
// copy, paste and "Save as snippet" use, so a document dropped here and the same
// content copied from its app land identically:
//   doc     the document's TipTap content
//   sheet   the first tab's used range (sheetBodyFromSelection over it)
//   slides  slide 1 (slideBodyFromSelection with every element)
//   design  page 1 (designBodyFromSelection with every element)
//   map     page 1 (diagramBodyFromSelection with every node; edges follow)
//   draw    the drawing (snippetFromDrawBody)
//   widget  the work widget file as a widget body
// Only what the matrix asks for: the FIRST tab, slide and page, as the app's
// insert of a snippet of that block would land.

import type { FbDocument } from '@shared/types'
import type { SnippetBody, WidgetSnippetBody } from '@shared/snippets'
import type { SlidesBody, SheetBody } from '@shared/types'
import { parseDocBody } from '../components/documents/editor/headingStyles'
import { nodesToPlainText } from '@shared/snippetForms/tiptap'
import { normalizeBody } from './sheetBody'
import { sheetBodyFromSelection } from '../components/documents/sheet/cellsSnippets'
import { slideBodyFromSelection } from '../components/documents/slides/deckSnippets'
import { designBodyFromSelection } from '../components/documents/design/designSnippets'
import { diagramBodyFromSelection } from '../components/documents/diagram/diagramSnippets'
import { normalizeDesignBody, withPages } from '@shared/design'
import { normalizeMapBody } from '@shared/mapGraph'
import { getPage } from '@shared/diagram/pages'
import { snippetFromDrawBody } from '@shared/draw/snippetBody'
import { parseWidgetFileBody } from '@shared/widgetFiles'

export interface DocumentBodyResult {
  body: SnippetBody | null
  /** What the copy leaves out (the other tabs, slides, pages), plain and British. */
  lossy: string[]
}

const more = (n: number, one: string, many: string): string[] => (n > 1 ? [n === 2 ? one : many] : [])

/** The first tab's used range: every row and column that holds something. */
function usedRange(tab: { rows: string[][]; columns: string[] }): { r0: number; c0: number; r1: number; c1: number } | null {
  let r1 = -1
  let c1 = -1
  tab.rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (String(v ?? '').trim() !== '') {
        if (r > r1) r1 = r
        if (c > c1) c1 = c
      }
    })
  )
  return r1 < 0 ? null : { r0: 0, c0: 0, r1, c1 }
}

export function documentSnippetBody(doc: Pick<FbDocument, 'docType' | 'body' | 'title'>): DocumentBodyResult {
  const raw = doc.body as unknown
  try {
    switch (doc.docType) {
      case 'doc': {
        const content = (parseDocBody(raw).doc as { content?: unknown[] })?.content ?? []
        return { body: content.length ? { kind: 'doc', content, text: nodesToPlainText(content) } : null, lossy: [] }
      }
      case 'sheet': {
        const v2 = normalizeBody(raw as SheetBody)
        const tab = v2.sheets[0]
        const range = tab ? usedRange(tab) : null
        return {
          body: tab && range ? sheetBodyFromSelection(tab, range) : null,
          lossy: more(v2.sheets.length, 'Only the first sheet comes in.', 'Only the first sheet comes in.')
        }
      }
      case 'slides': {
        const deck = raw as SlidesBody
        const slide = deck?.slides?.[0]
        const ids = (slide?.elements ?? []).map((e) => (e as { id: string }).id)
        return {
          body: slide ? slideBodyFromSelection(slide, ids) : null,
          lossy: more(deck?.slides?.length ?? 0, 'Only the first slide comes in.', 'Only the first slide comes in.')
        }
      }
      case 'design': {
        const d = withPages(normalizeDesignBody(raw))
        const page = d.pages?.[0]
        const elements = page?.elements ?? d.elements ?? []
        const first = { ...d, editingMasterId: undefined, activePage: 0, elements }
        return {
          body: designBodyFromSelection(first, elements.map((e) => (e as { id: string }).id)),
          lossy: more(d.pages?.length ?? 1, 'Only the first page comes in.', 'Only the first page comes in.')
        }
      }
      case 'map': {
        const b = normalizeMapBody(raw)
        const g = getPage(b, 0)
        const nodes = new Set((g.nodes as Array<{ id: string }>).map((n) => n.id))
        const edges = new Set((g.edges as Array<{ id: string }>).map((e) => e.id))
        return {
          body: diagramBodyFromSelection(g, { nodes, edges }),
          lossy: more(1 + ((b as { pages?: unknown[] }).pages?.length ?? 0), 'Only the first page comes in.', 'Only the first page comes in.')
        }
      }
      case 'draw': {
        const r = snippetFromDrawBody(raw)
        return { body: r.body.objects.length ? r.body : null, lossy: r.lost }
      }
      case 'widget': {
        const w = parseWidgetFileBody(raw)
        if (!w) return { body: null, lossy: [] }
        const body: WidgetSnippetBody = {
          kind: 'widget',
          widgetKind: w.kind,
          title: doc.title ?? '',
          content: typeof w.content === 'string' ? w.content : JSON.stringify(w.content ?? ''),
          width: 360,
          height: 280,
          color: (w.color as string | null) ?? null
        }
        return { body, lossy: [] }
      }
      default:
        return { body: null, lossy: [] }
    }
  } catch {
    // A body this build cannot read is no content, never a guess.
    return { body: null, lossy: [] }
  }
}
