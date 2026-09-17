// One shared widget-to-text extractor, used by every AI surface so "what the
// assistant can read" is identical no matter which path assembles the context.
// Before this, three separate extractors (the desk assistant's attachments, the
// assistant's prompt summary, and the desk agent's inputs) each covered a
// different, narrow set of widget kinds, which is why the AI could read some
// tools and not others. This module is the single source of truth.
//
// It is deliberately synchronous and pure. Anything that needs IO (a table's
// rows, an office document's body, a live browser page) is supplied by the
// caller through resolvers, so the same logic runs in the main process (backed
// by the DB) and in the renderer (backed by the stores and the live webview).
// It never fabricates: a widget it cannot read yields an honest short label, not
// invented content.

import type { Widget, WidgetKind } from './types'

// The widget kinds whose content is worth carrying as a FULL-text attachment —
// the deep channel every AI surface shares. Chrome-only kinds (sections,
// minimaps, timers, colour chips) are excluded: they render UI, not content.
// Lives here beside the extractor so "what can ride a request" and "what can be
// read" stay one list — the renderer's attachment gathering and the assistant's
// click-to-pin rule both consume it.
export const ATTACHABLE_WIDGET_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  'note', 'sticky', 'markdown', 'page', 'living-doc', 'card', 'custom-block', 'custom',
  'webview', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email',
  'doc', 'sheet', 'slides', 'map', 'design', 'draw',
  'table', 'chart', 'diagram', 'mindmap', 'agent', 'field',
  // Content-bearing kinds that were absent from this list, so the assistant
  // could not read them however plainly the user had pointed at them: a voice
  // note's transcript, the figures on a stat card or metrics block, a place on
  // a map, a gallery, and the desk views (tasks, calendar, inbox, contacts,
  // attention) that say what they are pointed at.
  'voice-recorder', 'stat-card', 'metrics', 'location-map', 'gallery', 'image-gen',
  'task-list', 'calendar', 'inbox', 'contacts', 'attention', 'meeting-record'
])

// A table reduced to the shape the summariser needs. The caller adapts its own
// table source (main getTable/listRows, renderer store) into this.
export interface ResolvedTable {
  title?: string
  columns: Array<{ id: string; label: string; type?: string }>
  rows: Array<Record<string, unknown>>
}

export interface WidgetTextResolvers {
  // A table widget's content is a table id; resolve it to columns + rows.
  table?: (tableId: string) => ResolvedTable | null
  // An office widget's content is a document id; resolve it to plain text.
  docText?: (docId: string) => string | null
  // A live browser/pdf/doc webview's rendered page text, when the caller has it.
  liveText?: (widgetId: string) => string | null
}

export interface WidgetText {
  kind: WidgetKind
  title: string
  text: string
  // For webview-family widgets, the URL, surfaced separately so a caller can
  // show it as the source of the attachment.
  source?: string
}

const MAX_TABLE_ROWS = 40
const MAX_MINDMAP_NODES = 200

// Collapse runs of whitespace; trim. Keeps single newlines out of the way for
// the compact prompt paths while leaving the text intact for the full paths.
function squash(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// Recursively pull text out of a Tiptap/ProseMirror node tree. Adds a newline
// after block nodes so paragraphs and headings do not run together. Shared by
// both processes (previously main and renderer had two divergent copies).
export function tiptapToText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: unknown; text?: unknown; content?: unknown }
  let out = ''
  if (typeof n.text === 'string') out += n.text
  if (Array.isArray(n.content)) {
    for (const child of n.content) out += tiptapToText(child)
  }
  if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') out += '\n'
  return out
}

// Turn a stored string that may be Tiptap JSON, HTML, or plain text into plain
// text. This is the single implementation both sides now use.
export function contentToPlainText(content: string | null | undefined): string {
  const raw = (content ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      const walked = tiptapToText(parsed)
      if (walked.trim()) return squash(walked)
    } catch {
      // fall through to tag-strip
    }
  }
  return squash(raw.replace(/<[^>]+>/g, ' '))
}

// Turn a parsed office-document body into plain text. Covers doc, sheet (both
// the V2 { sheets: [...] } shape and the legacy V1 { columns, rows } shape),
// slides, and map. Design bodies fall back to any element text. Mirrors and
// extends the main-only extractDocText so office widgets are finally readable in
// every AI surface, not just the workspace search.
export function docBodyToText(docType: string, body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  if (docType === 'doc') {
    return squash(tiptapToText(b.doc ?? b)).slice(0, 12000)
  }
  if (docType === 'sheet') {
    const tabs = Array.isArray(b.sheets)
      ? (b.sheets as Array<{ name?: string; columns?: string[]; rows?: string[][] }>)
      : // Legacy V1: columns + rows at the top level.
        [{ columns: b.columns as string[] | undefined, rows: b.rows as string[][] | undefined }]
    const parts: string[] = []
    for (const tab of tabs) {
      if (tab?.name) parts.push(String(tab.name))
      if (Array.isArray(tab?.columns)) parts.push(tab.columns.join(' | '))
      if (Array.isArray(tab?.rows)) {
        for (const row of tab.rows.slice(0, 200)) parts.push(row.join(' | '))
      }
    }
    return squash(parts.join('\n')).slice(0, 12000)
  }
  if (docType === 'slides') {
    const slides = Array.isArray(b.slides) ? (b.slides as Array<Record<string, unknown>>) : []
    const parts: string[] = []
    slides.forEach((slide, i) => {
      const els = Array.isArray(slide.elements) ? (slide.elements as Array<Record<string, unknown>>) : []
      const texts: string[] = []
      for (const el of els) {
        if (el.type !== 'text') continue
        const paras = Array.isArray(el.paragraphs) ? (el.paragraphs as Array<Record<string, unknown>>) : []
        for (const p of paras) {
          const runs = Array.isArray(p.runs) ? (p.runs as Array<{ text?: unknown }>) : []
          texts.push(runs.map((r) => (typeof r.text === 'string' ? r.text : '')).join(''))
        }
      }
      const notes = typeof slide.notes === 'string' ? slide.notes : ''
      const chunk = [texts.join('\n'), notes].filter(Boolean).join('\n')
      if (chunk.trim()) parts.push(`Slide ${i + 1}: ${chunk}`)
    })
    return squash(parts.join('\n')).slice(0, 12000)
  }
  if (docType === 'map') {
    const nodes = Array.isArray(b.nodes) ? (b.nodes as Array<Record<string, unknown>>) : []
    const edges = Array.isArray(b.edges) ? (b.edges as Array<Record<string, unknown>>) : []
    const labels = nodes
      .map((n) => {
        const data = (n.data as Record<string, unknown> | undefined) ?? {}
        return String(data.label ?? n.label ?? '')
      })
      .filter(Boolean)
    const out = [`Diagram with ${nodes.length} nodes, ${edges.length} connections`, labels.join(', ')]
    return squash(out.join('\n')).slice(0, 12000)
  }
  if (docType === 'draw') {
    // A drawing's body is LAYERS of objects, not the `elements` array the
    // design fallback below reads — so without this branch every PlexiDraw
    // document extracted to an empty string. What is sayable about artwork is
    // the words actually drawn on it (type objects) plus the layer names the
    // user chose, which is how people describe their own drawings.
    const layers = Array.isArray(b.layers) ? (b.layers as Array<Record<string, unknown>>) : []
    const words: string[] = []
    const names: string[] = []
    let objects = 0
    for (const layer of layers) {
      if (typeof layer.name === 'string' && layer.name.trim()) names.push(layer.name.trim())
      const objs = Array.isArray(layer.objects) ? (layer.objects as Array<Record<string, unknown>>) : []
      objects += objs.length
      for (const o of objs) {
        if (o.type === 'text' && typeof o.text === 'string' && o.text.trim()) words.push(o.text.trim())
      }
    }
    const shape = `Drawing: ${layers.length} layer${layers.length === 1 ? '' : 's'}, ${objects} object${objects === 1 ? '' : 's'}`
    const out = [shape, names.length ? `Layers: ${names.join(', ')}` : '', words.join('\n')]
    return squash(out.filter(Boolean).join('\n')).slice(0, 12000)
  }
  // design or unknown: best-effort element text.
  //
  // A design element carries its copy the same way a slide element does —
  // paragraphs[].runs[].text — not as a flat `text` property. Reading only the
  // flat one meant every design in the workspace extracted to nothing, so
  // designs were invisible to retrieval, embedding and enrichment alike. The
  // flat read stays as the fallback for any other element shape.
  const els = Array.isArray(b.elements) ? (b.elements as Array<Record<string, unknown>>) : []
  const txt = els
    .map((e) => {
      const paras = Array.isArray(e.paragraphs) ? (e.paragraphs as Array<Record<string, unknown>>) : []
      if (paras.length) {
        return paras
          .map((para) => {
            const runs = Array.isArray(para.runs) ? (para.runs as Array<{ text?: unknown }>) : []
            return runs.map((r) => (typeof r.text === 'string' ? r.text : '')).join('')
          })
          .filter(Boolean)
          .join('\n')
      }
      return typeof e.text === 'string' ? e.text : ''
    })
    .filter(Boolean)
    .join('\n')
  return squash(txt).slice(0, 12000)
}

function safeParse<T>(raw: string | null | undefined): T | null {
  try {
    return JSON.parse(raw || 'null') as T
  } catch {
    return null
  }
}

function tableToText(t: ResolvedTable): string {
  const header = t.columns.map((c) => c.label).join(' | ')
  const rows = t.rows
    .slice(0, MAX_TABLE_ROWS)
    .map((r) => t.columns.map((c) => String(r[c.id] ?? '')).join(' | '))
  const title = t.title ? `Table "${t.title}"` : 'Table'
  const more = t.rows.length > MAX_TABLE_ROWS ? `\n(+${t.rows.length - MAX_TABLE_ROWS} more rows)` : ''
  return [title, header, ...rows].join('\n') + more
}

function mindmapText(root: unknown): string {
  const labels: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || labels.length >= MAX_MINDMAP_NODES) return
    const n = node as { label?: unknown; children?: unknown }
    if (typeof n.label === 'string' && n.label.trim()) labels.push(n.label.trim())
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk(root)
  return labels.join('\n')
}

// The core switch. Returns readable text for any widget kind. The `text` may be
// long; callers cap it to their own budget.
export function widgetToText(w: Widget, r: WidgetTextResolvers = {}): WidgetText {
  const base = { kind: w.kind, title: w.title ?? '' }
  const raw = w.content ?? ''

  switch (w.kind) {
    case 'sticky':
    case 'note':
    case 'markdown':
      return { ...base, text: squash(raw) }

    case 'page':
    case 'living-doc':
      return { ...base, text: contentToPlainText(raw) }

    case 'image-gen': {
      // The prompt IS the description of this image, so retrieval can find "the
      // image I generated of the golden-hour desk" later. Without this the widget
      // would be a file id and nothing else — unreadable to every AI surface.
      const d = safeParse<{ prompt?: string; fileId?: string }>(raw)
      const prompt = typeof d?.prompt === 'string' ? d.prompt.trim() : ''
      if (!prompt) return { ...base, text: d?.fileId ? 'Generated image' : 'Image generator (empty)' }
      return { ...base, text: squash(`Generated image: ${prompt}`) }
    }
    case 'card': {
      const p = safeParse<{ title?: string; body?: string }>(raw)
      if (p) return { ...base, text: squash([p.title ?? '', p.body ?? ''].filter(Boolean).join('\n')) }
      return { ...base, text: squash(raw) }
    }

    case 'custom': {
      // The SPEC is what this widget is, in the user's own words. Indexing the
      // generated markup instead would fill retrieval with div soup and make the
      // widget findable by everything and nothing.
      const p = safeParse<{ spec?: string; state?: Record<string, unknown> }>(raw)
      const spec = typeof p?.spec === 'string' ? p.spec.trim() : ''
      if (!spec) return { ...base, text: 'Custom widget (not built yet)' }
      // Whatever the user typed INTO the widget is real content too, so a value
      // entered in a custom tool is searchable like any other widget's.
      const entered: string[] = []
      for (const [k, v] of Object.entries(p?.state ?? {})) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          entered.push(`${k}: ${String(v)}`)
        }
      }
      return {
        ...base,
        text: squash([`Custom widget: ${spec}`, ...entered].join('\n'))
      }
    }

    case 'custom-block': {
      const p = safeParse<{ title?: string; fields?: Array<{ label?: string; value?: unknown; type?: string }> }>(raw)
      if (p) {
        const parts = [p.title ?? '']
        for (const f of p.fields ?? []) {
          if (f.type === 'heading' || f.type === 'divider') continue
          parts.push(`${f.label ?? ''}: ${String(f.value ?? '')}`.trim())
        }
        return { ...base, text: squash(parts.filter(Boolean).join('\n')) }
      }
      return { ...base, text: contentToPlainText(raw) }
    }

    case 'table': {
      const t = raw && r.table ? r.table(raw) : null
      return { ...base, text: t ? tableToText(t) : raw ? '(table)' : '(empty table)' }
    }

    case 'field': {
      const p = safeParse<{ def?: { label?: string }; value?: unknown }>(raw)
      if (p) return { ...base, text: `${p.def?.label ?? 'Field'}: ${JSON.stringify(p.value ?? '')}` }
      return { ...base, text: squash(raw) }
    }

    case 'agent': {
      const p = safeParse<{ instruction?: string; lastOutput?: string }>(raw)
      if (p) {
        const parts = [
          p.instruction ? `Agent instruction: ${p.instruction}` : '',
          p.lastOutput ? `Latest output: ${p.lastOutput}` : ''
        ].filter(Boolean)
        return { ...base, text: squash(parts.join('\n')) }
      }
      return { ...base, text: '' }
    }

    case 'webview':
    case 'pdf':
    case 'gdoc':
    case 'gsheet':
    case 'gslide':
    case 'email': {
      const live = r.liveText ? r.liveText(w.id) : null
      const url = raw || '(no URL)'
      const text = live && live.trim() ? live : w.title ? `${w.title} (${url})` : url
      return { ...base, text, source: raw || undefined }
    }

    case 'doc':
    case 'sheet':
    case 'slides':
    case 'map':
    // Design was listed as attachable but had no case, so it fell to the
    // default placeholder both consumers reject — permanently unreadable
    // (defect #10). Its content is a document id exactly like the other
    // office kinds; the docText resolver's design branch reads element text.
    case 'design':
    // PlexiDraw artwork is the same story one app later: it renders through
    // OfficeDocWidget and stores a document id, but shipped without a case
    // here, so every drawing was unreadable to every AI surface.
    case 'draw': {
      const docText = raw && r.docText ? r.docText(raw) : null
      return { ...base, text: docText && docText.trim() ? docText : '(empty document)' }
    }

    case 'chart': {
      const p = safeParse<{
        type?: string
        title?: string
        tableId?: string | null
        series?: Array<{ columnId?: string; agg?: string; label?: string }>
      }>(raw)
      if (p) {
        const series = (p.series ?? []).map((s) => `${s.label ?? s.columnId ?? '?'} (${s.agg ?? 'sum'})`).join(', ')
        const src = p.tableId && r.table ? r.table(p.tableId) : null
        const dataNote = src ? ` over ${src.rows.length} rows of ${src.title ?? 'a table'}` : ''
        return { ...base, text: squash(`${p.type ?? 'chart'} chart${p.title ? ` "${p.title}"` : ''}: ${series}${dataNote}`) }
      }
      return { ...base, text: '(empty chart)' }
    }

    case 'diagram': {
      const p = safeParse<{ nodes?: Array<{ data?: { label?: string } }>; edges?: unknown[] }>(raw)
      if (p) {
        const labels = (p.nodes ?? []).map((n) => n.data?.label ?? '').filter(Boolean)
        return {
          ...base,
          text: squash(`Diagram: ${labels.length} shapes, ${(p.edges ?? []).length} connections\n${labels.join(', ')}`)
        }
      }
      return { ...base, text: '(empty diagram)' }
    }

    case 'mindmap': {
      const p = safeParse<{ root?: unknown }>(raw)
      const text = p?.root ? mindmapText(p.root) : ''
      return { ...base, text: text ? `Mind map:\n${text}` : '(empty mind map)' }
    }

    case 'scratchpad': {
      const p = safeParse<{ strokes?: unknown[] }>(raw)
      return { ...base, text: `(freehand drawing, ${p?.strokes?.length ?? 0} strokes)` }
    }

    case 'portal': {
      const p = safeParse<{ targetTaskId?: string | null }>(raw)
      return { ...base, text: p?.targetTaskId ? `(portal to desk ${p.targetTaskId})` : '(portal, no target)' }
    }

    case 'task-link':
      return { ...base, text: raw ? `(link to task ${raw.trim()})` : '(task link, no target)' }

    case 'file':
    case 'image':
      return { ...base, text: raw ? `File/link: ${raw}` : '(empty file)' }

    case 'calculator':
      return { ...base, text: raw ? `Calculator: ${raw}` : '(calculator)' }

    case 'color':
      return { ...base, text: raw ? `Colour ${raw}` : '(colour swatch)' }

    case 'timer': {
      const p = safeParse<{ targetSec?: number; state?: string }>(raw)
      return { ...base, text: p ? `Timer ${p.targetSec ?? 0}s (${p.state ?? 'idle'})` : '(timer)' }
    }

    case 'voice-recorder': {
      // The transcript is the whole point of a voice note, and it sits right
      // here in content — yet this kind fell to the placeholder, so a recorded
      // thought was invisible to every AI surface. Prefer the processed text
      // when the user made one; it is what they chose to keep.
      const p = safeParse<{
        transcript?: string
        processedText?: string
        mode?: string
        durationSec?: number | null
        language?: string | null
      }>(raw)
      // `processedText` is the widget's own field name for the cleaned/summarised
      // version; the raw transcript is the fallback when nothing was processed.
      const body = (p?.processedText || p?.transcript || '').trim()
      if (!body) return { ...base, text: '(voice recording, not transcribed yet)' }
      const meta = [
        p?.durationSec ? `${Math.round(p.durationSec)}s` : '',
        p?.language ? p.language : ''
      ].filter(Boolean).join(', ')
      return { ...base, text: squash(`Voice note${meta ? ` (${meta})` : ''}:\n${body}`) }
    }

    case 'stat-card': {
      // The numbers are in content. A card says whether each figure is measured
      // (bound to a table) or typed, and that distinction rides too — a typed
      // target must never read as a live measurement.
      const p = safeParse<{
        title?: string
        series?: Array<{ label?: string; value?: number; display?: string; unit?: string; caption?: string }>
        binding?: unknown
      }>(raw)
      const rows = (p?.series ?? []).map((sr) => {
        const v = sr.display ?? (typeof sr.value === 'number' ? String(sr.value) : '')
        return `${sr.label ?? 'Value'}: ${v}${sr.unit ? ` ${sr.unit}` : ''}${sr.caption ? ` — ${sr.caption}` : ''}`
      })
      if (!rows.length) return { ...base, text: p?.title ? `Stat card: ${p.title}` : '(empty stat card)' }
      const origin = p?.binding ? 'measured from a table' : 'entered by hand'
      return { ...base, text: squash([`Stat card${p?.title ? ` "${p.title}"` : ''} (${origin}):`, ...rows].join('\n')) }
    }

    case 'metrics': {
      const p = safeParse<{
        title?: string
        cells?: Array<{ label?: string; value?: number; display?: string; binding?: unknown }>
        barsLabel?: string
        source?: string
      }>(raw)
      const rows = (p?.cells ?? []).map((c) => {
        const v = c.display ?? (typeof c.value === 'number' ? String(c.value) : '')
        return `${c.label ?? 'Metric'}: ${v}${c.binding ? ' (measured)' : ''}`
      })
      if (!rows.length) return { ...base, text: p?.title ? `Metrics: ${p.title}` : '(empty metrics)' }
      const tail = [p?.barsLabel ? `Bars: ${p.barsLabel}` : '', p?.source ? `Source: ${p.source}` : ''].filter(Boolean)
      return { ...base, text: squash([`Metrics${p?.title ? ` "${p.title}"` : ''}:`, ...rows, ...tail].join('\n')) }
    }

    case 'location-map': {
      // A real place is real information; the resolved label is what the map
      // actually matched, so a wrong match is visible rather than implied.
      const p = safeParse<{ query?: string; label?: string; lat?: number; lon?: number }>(raw)
      const asked = (p?.query ?? '').trim()
      const found = (p?.label ?? '').trim()
      if (!asked && !found) return { ...base, text: '(map, no place set)' }
      const coords = typeof p?.lat === 'number' && typeof p?.lon === 'number' ? ` [${p.lat}, ${p.lon}]` : ''
      if (found && asked && found !== asked) {
        return { ...base, text: squash(`Location: ${found}${coords} (searched for "${asked}")`) }
      }
      return { ...base, text: squash(`Location: ${found || asked}${coords}`) }
    }

    case 'gallery': {
      const p = safeParse<{ fileIds?: string[] }>(raw)
      const ids = Array.isArray(p) ? (p as string[]) : (p?.fileIds ?? [])
      return { ...base, text: ids.length ? `Image gallery: ${ids.length} image${ids.length === 1 ? '' : 's'}` : '(empty gallery)' }
    }

    case 'meeting-record': {
      const id = raw.trim()
      return { ...base, text: id ? `Meeting record${w.title ? `: ${w.title}` : ''} (transcript stored separately)` : '(meeting record, no meeting)' }
    }

    case 'drive': {
      const id = raw.trim()
      return { ...base, text: id ? `Files folder bound to this desk${w.title ? `: ${w.title}` : ''}` : '(drive, no folder bound)' }
    }

    case 'video':
      return { ...base, text: raw ? `Video: ${raw}` : '(empty video)', source: raw || undefined }

    case 'webhook': {
      const p = safeParse<{ url?: string }>(raw)
      return { ...base, text: p?.url ? `Outgoing webhook to ${p.url}` : '(webhook, no URL set)' }
    }

    case 'inbound-hook': {
      const p = safeParse<{ url?: string }>(raw)
      return { ...base, text: p?.url ? `Inbound hook receiving at ${p.url}` : '(inbound hook, not registered)' }
    }

    // The view-shaped widgets. Their content is a QUERY, not the rows — the
    // rows live in the desk's own data, which every AI surface already receives
    // through the desk context. So these describe honestly what they are
    // pointed at rather than inventing rows they do not hold.
    case 'task-list': {
      const p = safeParse<{ scope?: string; filter?: string; group?: string; ranked?: boolean }>(raw)
      const bits = [
        p?.scope ? `scope ${p.scope}` : '',
        p?.filter ? `filter ${p.filter}` : '',
        p?.group && p.group !== 'none' ? `grouped by ${p.group}` : '',
        p?.ranked ? 'most pressing first' : ''
      ].filter(Boolean)
      return { ...base, text: `Task list of this desk's tasks${bits.length ? ` (${bits.join(', ')})` : ''}` }
    }

    case 'calendar': {
      const p = safeParse<{ scope?: string; filter?: unknown }>(raw)
      return { ...base, text: `Calendar of what is due${p?.scope ? ` (${p.scope})` : ''}` }
    }

    case 'inbox': {
      const p = safeParse<{ rules?: unknown; scan?: number }>(raw)
      return { ...base, text: p?.rules ? 'Inbox filtered to this desk by a saved rule' : '(inbox, no rule set)' }
    }

    case 'contacts': {
      const p = safeParse<{ activeGroup?: string }>(raw)
      return { ...base, text: `People on this desk${p?.activeGroup ? ` (group: ${p.activeGroup})` : ''}` }
    }

    case 'attention':
      return { ...base, text: "This desk's attention view: what is overdue, due and waiting" }

    case 'chat-thread': {
      const p = safeParse<{ channelName?: string }>(raw)
      return { ...base, text: p?.channelName ? `Chat thread: ${p.channelName}` : '(chat thread)' }
    }

    case 'streamdeck': {
      const p = safeParse<{ taskDeck?: { pages?: Record<string, { buttons?: Record<string, { label?: string }> }> } }>(raw)
      const labels: string[] = []
      const pages = p?.taskDeck?.pages ?? {}
      for (const page of Object.values(pages)) {
        for (const btn of Object.values(page.buttons ?? {})) if (btn?.label) labels.push(btn.label)
      }
      return { ...base, text: labels.length ? `Stream Deck: ${labels.join(', ')}` : '(stream deck)' }
    }

    default:
      // local-app-launcher, section, minimap, shape: genuine chrome. They
      // render UI and hold no content, so they get a short honest label rather
      // than raw JSON dumped into the prompt.
      return { ...base, text: w.title ? `(${w.kind}: ${w.title})` : `(${w.kind})` }
  }
}
