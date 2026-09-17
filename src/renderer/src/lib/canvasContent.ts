// Gather the deep, full-text content the user has open on the canvas so the
// assistant can act on it (e.g. "add the events from this booking page to my
// calendar"). This is the rich channel: full text for the focused widget and a
// few others, capped so a huge page cannot flood the request. The assistant's
// prompt separately carries a shorter summary of every widget. Both now go
// through the one shared extractor (src/shared/widgetText.ts), so coverage is
// identical everywhere and every data-bearing widget kind is readable, not just
// notes and browsers. No fabrication: a widget we cannot read is skipped.

import type { ChatAttachment, WidgetKind, WidgetLink } from '@shared/types'
import { useWidgetStore } from '../stores/widgets'
import { useTablesStore } from '../stores/tables'
import { useLinksStore } from '../stores/links'
import { extractWebviewText } from './webviewRegistry'
import {
  widgetToText,
  contentToPlainText,
  docBodyToText,
  ATTACHABLE_WIDGET_KINDS,
  type WidgetTextResolvers,
  type ResolvedTable
} from '@shared/widgetText'

const WEBVIEW_KINDS = new Set<WidgetKind>(['webview', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email'])
const OFFICE_KINDS = new Set<WidgetKind>(['doc', 'sheet', 'slides', 'map', 'design', 'draw'])

// Kinds worth sending as a FULL-text attachment (the deep channel). Canonical
// list lives beside the shared extractor (ATTACHABLE_WIDGET_KINDS) so the
// assistant's click-to-pin rule and this gathering agree on what can ride.
const ATTACH_KINDS = ATTACHABLE_WIDGET_KINDS

// M1 defect #21: at 8, widget #9 on a busy desk silently never rode as context.
// The prompt-side budget in chatMentions/renderAttachments (24000 chars total)
// is what actually bounds the request, so the count cap can be generous — it
// exists to stop pathological desks, not to ration normal ones.
const MAX_WIDGETS = 24
const PER_WIDGET = 8000

// Re-exported so other renderer code keeps a single plaintext implementation.
export { contentToPlainText as plainTextFromContent }

// The human relationship a wire expresses, from the focused widget's point of
// view. Used to label linked attachments so the assistant knows WHY a widget is
// included, not just that it is.
function wireRelationship(link: WidgetLink): string {
  if (link.type === 'transform') return link.verb ? `feeds (${link.verb}) into` : 'transforms into'
  if (link.type === 'mirror') return 'mirrors'
  return 'is linked as context to'
}

export async function gatherCanvasAttachments(
  taskId: string | null,
  // A widget the user explicitly pinned as the conversation's primary reference
  // (Phase 3a.1). It outranks even the focused widget, so it always survives
  // the MAX_WIDGETS cut and rides the request first.
  pinnedWidgetId?: string
): Promise<ChatAttachment[]> {
  const state = useWidgetStore.getState()
  const focusedId = state.focusedWidgetId
  const all = state.widgets.filter((w) => (taskId ? w.taskId === taskId : true))
  const candidates = all.filter((w) => ATTACH_KINDS.has(w.kind))

  // Link-aware selection: when a widget is focused, the widgets wired to it
  // (either direction, enabled links) are pulled in as context even if they
  // would not otherwise make the position-based cut. This is what makes "ask
  // about this, and its linked spec/notes come too" actually work. Each linked
  // widget is annotated with the relationship so the model uses it correctly.
  const links = useLinksStore.getState().links.filter((l) => l.enabled !== false)
  const linkedRel = new Map<string, string>()
  if (focusedId) {
    for (const l of links) {
      if (l.sourceWidgetId === focusedId) linkedRel.set(l.targetWidgetId, wireRelationship(l))
      else if (l.targetWidgetId === focusedId) linkedRel.set(l.sourceWidgetId, wireRelationship(l))
    }
  }

  // Order: pinned first, then focused, then widgets linked to the focused one,
  // then the rest.
  const rank = (w: { id: string }): number =>
    w.id === pinnedWidgetId ? 0 : w.id === focusedId ? 1 : linkedRel.has(w.id) ? 2 : 3
  candidates.sort((a, b) => rank(a) - rank(b))
  const chosen = candidates.slice(0, MAX_WIDGETS)

  // Pre-load the async sources (live pages, table rows, office bodies) for the
  // chosen widgets, then hand the shared extractor synchronous resolvers.
  const liveText = new Map<string, string>()
  const tableCache = new Map<string, ResolvedTable | null>()
  const docCache = new Map<string, string | null>()
  const tables = useTablesStore.getState()

  const loadTable = async (tableId: string): Promise<void> => {
    if (tableCache.has(tableId)) return
    try {
      const tbl = await tables.ensureTableLoaded(tableId)
      const rows = await tables.ensureRowsLoaded(tableId)
      tableCache.set(
        tableId,
        tbl
          ? {
              title: tbl.title,
              columns: tbl.schema.columns.map((c) => ({ id: c.id, label: c.label, type: c.type })),
              rows: rows.map((r) => r.cells)
            }
          : null
      )
    } catch {
      tableCache.set(tableId, null)
    }
  }

  await Promise.all(
    chosen.map(async (w) => {
      if (WEBVIEW_KINDS.has(w.kind)) {
        const t = await extractWebviewText(w.id)
        if (t) liveText.set(w.id, t)
      } else if (w.kind === 'table' && w.content) {
        await loadTable(w.content)
      } else if (w.kind === 'chart' && w.content) {
        try {
          const cfg = JSON.parse(w.content) as { tableId?: string | null }
          if (cfg.tableId) await loadTable(cfg.tableId)
        } catch {
          // ignore malformed chart config
        }
      } else if (OFFICE_KINDS.has(w.kind) && w.content) {
        try {
          const d = await window.api.documents.get(w.content)
          docCache.set(w.content, d ? docBodyToText(d.docType, d.body) : null)
        } catch {
          docCache.set(w.content, null)
        }
      }
    })
  )

  const resolvers: WidgetTextResolvers = {
    table: (id) => tableCache.get(id) ?? null,
    docText: (id) => docCache.get(id) ?? null,
    liveText: (id) => liveText.get(id) ?? null
  }

  const out: ChatAttachment[] = []
  for (const w of chosen) {
    // Defect #20: a browser/PDF whose live page could not be read used to
    // VANISH from context entirely — "you have a PDF open, ask about its
    // deadline, and Plexii does not know a PDF is open." It now rides as an
    // honest one-liner (kind + URL + the fact it is unread), matching the
    // mention path's honesty rule (#6): disclose, never guess, never omit.
    if (WEBVIEW_KINDS.has(w.kind) && !liveText.has(w.id)) {
      const url = (w.content || '').trim()
      out.push({
        widgetId: w.id,
        kind: labelForKind(w.kind),
        title: w.title || '',
        source: url || undefined,
        text: `(This ${labelForKind(w.kind)} widget is open on the desk${
          url ? ` at ${url}` : ''
        }, but its page text could not be read. If asked about its contents, say so rather than guessing.)`
      })
      continue
    }
    const r = widgetToText(w, resolvers)
    let text = (r.text ?? '').trim()
    // Skip empty widgets and pure placeholders like "(empty document)".
    if (!text || /^\(.*\)$/.test(text)) continue
    const rel = linkedRel.get(w.id)
    if (rel) text = `[This widget ${rel} the item you are focused on]\n${text}`
    out.push({
      widgetId: w.id,
      kind: labelForKind(w.kind),
      title: w.title || '',
      source: r.source,
      text: text.slice(0, PER_WIDGET)
    })
  }
  return out
}

function labelForKind(kind: WidgetKind): string {
  switch (kind) {
    case 'webview':
      return 'browser page'
    case 'pdf':
      return 'PDF'
    case 'gdoc':
      return 'Google Doc'
    case 'gsheet':
      return 'Google Sheet'
    case 'gslide':
      return 'Google Slides'
    case 'email':
      return 'email'
    case 'page':
    case 'living-doc':
    case 'doc':
      return 'document'
    case 'sheet':
      return 'spreadsheet'
    case 'slides':
      return 'slides'
    case 'map':
      return 'diagram'
    case 'table':
      return 'table'
    case 'chart':
      return 'chart'
    case 'diagram':
      return 'diagram'
    case 'mindmap':
      return 'mind map'
    case 'agent':
      return 'desk agent'
    case 'field':
      return 'field'
    case 'design':
      return 'design'
    case 'draw':
      return 'drawing'
    // The kinds that only became attachable once the extractor could read them.
    // Without a label here they all fall to the default and the assistant is
    // told a voice note, a stat card and a map are each "a note" — which is
    // simply untrue, and it is the label the model reasons about.
    case 'voice-recorder':
      return 'voice note'
    case 'stat-card':
      return 'stat card'
    case 'metrics':
      return 'metrics'
    case 'location-map':
      return 'location map'
    case 'gallery':
      return 'image gallery'
    case 'image-gen':
      return 'generated image'
    case 'task-list':
      return 'task list'
    case 'calendar':
      return 'calendar'
    case 'inbox':
      return 'inbox'
    case 'contacts':
      return 'contacts'
    case 'attention':
      return 'attention view'
    case 'meeting-record':
      return 'meeting record'
    default:
      return 'note'
  }
}

// Test handle (mirrors the __fbBrowserAgent probe): lets an e2e assemble the
// real attachment set from real widgets in the real store, so "can the
// assistant actually read this widget kind" is answered end-to-end rather than
// at the extractor alone.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbCanvasContext?: typeof gatherCanvasAttachments }).__fbCanvasContext =
    gatherCanvasAttachments
}
