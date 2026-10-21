import type { FbDocument, SheetBody, SlidesBody, MapBody, DocType } from '@shared/types'
import type { DocumentSnapshot, DocFolderSnapshot, DocFolderEntry } from './shareSnapshot'
import { SHARE_SNAPSHOT_VERSION } from './shareSnapshot'
import { docToHtml } from './docHtml'
import { normalizeBody, activeTab, colLabel } from './sheetBody'
import { displayCell, makeWorkbook } from './sheetFormula'
import { normalizeMapBody } from '@shared/mapGraph'
import { mapToSvg } from '@shared/mapExport'

// Build a read-only, browser-renderable snapshot of an office document. The body
// is rendered to safe, structural HTML here on the desktop (where the editors and
// their helpers live), so the public viewer can show it without bundling any of
// the office editors. The honesty rule carries over: computed sheet cells show
// their real value (or #ERR), never a fabricated one.

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sheetHtml(body: SheetBody): string {
  const v2 = normalizeBody(body)
  const tab = activeTab(v2)
  const grid = { columns: tab.columns, rows: tab.rows }
  const wb = makeWorkbook(v2.sheets)
  const head = tab.columns.map((c, i) => `<th>${esc(c || colLabel(i))}</th>`).join('')
  const rows = tab.rows
    .map((_row, r) => {
      const cells = tab.columns.map((_, c) => `<td>${esc(displayCell(grid, r, c, wb))}</td>`).join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  return `<table class="office-sheet"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
}

// Pull readable text out of a slides body without depending on the editor: each
// slide becomes a section with whatever text its elements carry.
function slidesHtml(body: SlidesBody): string {
  const slides = Array.isArray(body.slides) ? body.slides : []
  if (!slides.length) return '<p>(empty deck)</p>'
  return slides
    .map((s, i) => {
      const parts: string[] = []
      const elements = (s as { elements?: unknown[] }).elements
      const collect = (node: unknown): void => {
        if (!node || typeof node !== 'object') return
        const n = node as { text?: string; runs?: unknown[]; paragraphs?: unknown[]; children?: unknown[] }
        if (typeof n.text === 'string' && n.text.trim()) parts.push(n.text)
        for (const key of ['runs', 'paragraphs', 'children'] as const) {
          const arr = n[key]
          if (Array.isArray(arr)) arr.forEach(collect)
        }
      }
      if (Array.isArray(elements)) elements.forEach(collect)
      const title = (s as { title?: string }).title
      const body = parts.map((p) => `<p>${esc(p)}</p>`).join('')
      return `<section class="office-slide"><h3>${esc(title || `Slide ${i + 1}`)}</h3>${body}</section>`
    })
    .join('')
}

function mapHtml(body: MapBody): string {
  const m = normalizeMapBody(body)
  const labelOf = (id: string): string => m.nodes.find((n) => n.id === id)?.label || id
  const nodes = m.nodes.map((n) => `<li>${esc(n.label || '(unnamed)')} <em>(${esc(n.shape)})</em></li>`).join('')
  const edges = m.edges
    .map((e) => `<li>${esc(labelOf(e.source))} → ${esc(labelOf(e.target))}${e.label ? ` <em>(${esc(e.label)})</em>` : ''}</li>`)
    .join('')
  // The picture first (the same renderer as export), then a text outline for
  // screen readers and search.
  let picture = ''
  try {
    picture = m.nodes.length ? `<div class="office-map-svg" style="overflow:auto;max-width:100%">${mapToSvg(m, { padding: 24 }).svg}</div>` : ''
  } catch {
    picture = ''
  }
  return `<div class="office-map">${picture}<h4>Nodes</h4><ul>${nodes || '<li>(none)</li>'}</ul><h4>Connections</h4><ul>${edges || '<li>(none)</li>'}</ul></div>`
}

// Render a document's body to read-only HTML for the viewer. Per-type, honest:
// computed sheet cells show their real value or #ERR, never a fabricated one.
export function documentHtml(docType: DocType, body: unknown): string {
  try {
    if (docType === 'doc') return docToHtml(body as Parameters<typeof docToHtml>[0])
    if (docType === 'sheet') return sheetHtml(body as SheetBody)
    if (docType === 'slides') return slidesHtml(body as SlidesBody)
    if (docType === 'map') return mapHtml(body as MapBody)
    // Designs are visual canvases; a faithful read-only HTML render is out of
    // scope for the share viewer in v1, so show an honest placeholder.
    return '<p>(design preview is not available in the shared viewer yet)</p>'
  } catch {
    return '<p>(preview unavailable)</p>'
  }
}

export function buildDocumentSnapshot(doc: FbDocument, fromHandle: string): DocumentSnapshot {
  return {
    _version: SHARE_SNAPSHOT_VERSION,
    kind: 'document',
    fromHandle,
    capturedAt: Date.now(),
    title: doc.title || 'Untitled',
    docType: doc.docType,
    html: documentHtml(doc.docType, doc.body)
  }
}

// Walk a Drive folder (fb_files) into a shareable tree. Each document carries
// both its rendered html (browser view) and its raw body (copy-import). Files
// that aren't documents are skipped — they have no body to render or import.
async function buildEntries(parentId: string | null): Promise<DocFolderEntry[]> {
  const entries = await window.api.fileManager.list(parentId)
  const out: DocFolderEntry[] = []
  for (const e of entries) {
    if (e.kind === 'folder') {
      out.push({ type: 'folder', name: e.name, items: await buildEntries(e.id) })
    } else if (e.kind === 'doc' && e.docId) {
      const doc = await window.api.documents.get(e.docId)
      if (doc) {
        out.push({
          type: 'document',
          name: doc.title || 'Untitled',
          docType: doc.docType,
          html: documentHtml(doc.docType, doc.body),
          body: doc.body
        })
      }
    }
  }
  return out
}

export async function buildFolderShareSnapshot(
  folderId: string,
  name: string,
  fromHandle: string
): Promise<DocFolderSnapshot> {
  return {
    _version: SHARE_SNAPSHOT_VERSION,
    kind: 'docfolder',
    fromHandle,
    capturedAt: Date.now(),
    name: name || 'Folder',
    items: await buildEntries(folderId)
  }
}

// Import-side helpers (materialize, countDocs) live in officeShareImport.ts so
// they stay free of the editor/HTML imports this module pulls in.
