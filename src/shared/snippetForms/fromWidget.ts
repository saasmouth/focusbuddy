import type { WidgetSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'
import { formsOfDocNodes } from './fromDoc'
import { firstPipeTable, markdownLiteToNodes } from './markdownLite'
import { docFeatures, nodesToLines, nodesToPlainText } from './tiptap'
import { looksLikeHeader } from './rows'
import { L } from './lossy'

/** Work widget kinds whose content is text a person typed. */
export const TEXT_WIDGET_KINDS = new Set(['sticky', 'note', 'markdown'])
/** Work widget kinds whose content is a TipTap document. */
export const PAGE_WIDGET_KINDS = new Set(['page', 'living-doc'])

/**
 * A page widget's stored content as top-level TipTap nodes. The content is
 * the editor's JSON; anything else (legacy plain text) reads as one paragraph,
 * as the widget itself reads it.
 */
export function pageWidgetNodes(raw: string): unknown[] {
  const s = (raw ?? '').trim()
  if (!s) return []
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown
      if (Array.isArray(parsed)) return parsed
      const content = (parsed as { content?: unknown })?.content
      if (Array.isArray(content)) return content
    } catch {
      // not JSON: plain text below
    }
  }
  return markdownLiteToNodes(s, { plain: true })
}

function textWidgetForms(b: WidgetSnippetBody): Form[] {
  const raw = typeof b.content === 'string' ? b.content : ''
  if (!raw.trim()) return []
  const plain = b.widgetKind === 'sticky'
  const nodes = markdownLiteToNodes(raw, { plain })
  const f = docFeatures(nodes)
  const styled = f.marks.size > 0 || f.headings > 0 || f.quotes > 0 || f.codeBlocks > 0 || f.tables > 0
  const text = plain ? raw.replace(/\r\n?/g, '\n').trim() : nodesToPlainText(nodes).trim()
  const forms: Form[] = [{ kind: 'docNodes', value: nodes, lossy: [] }]
  if (!plain) forms.push({ kind: 'markdown', value: raw, lossy: [] })
  forms.push({ kind: 'text', value: text, lossy: styled ? [L.stylesPlain] : [] })
  const table = plain ? null : firstPipeTable(raw)
  if (table && table.rows.length) {
    const lossy: string[] = [L.formatting]
    if (table.otherText) lossy.push(L.tableOnly)
    forms.push({ kind: 'rows', value: { rows: table.rows, header: looksLikeHeader(table.rows) || table.rows.length > 1 }, lossy })
  } else {
    const lines = plain ? text.split('\n').map((l) => l.trim()).filter(Boolean) : nodesToLines(nodes)
    if (lines.length) forms.push({ kind: 'rows', value: { rows: lines.map((l) => [l]), header: false }, lossy: styled ? [L.formatting] : [] })
  }
  return forms
}

/**
 * The forms a work widget TEMPLATE can take. A widget snippet holds no widget
 * id, so outside a desk it is a conversion: text widgets read as their text,
 * page widgets as their document, an image widget as its picture. Every other
 * kind is native only, and destinations refuse it with a reason.
 */
export function formsOfWidget(body: WidgetSnippetBody): Form[] {
  const forms: Form[] = [{ kind: 'native', value: body, lossy: [] }]
  const kind = body.widgetKind
  if (TEXT_WIDGET_KINDS.has(kind)) return [...forms, ...textWidgetForms(body)]
  if (PAGE_WIDGET_KINDS.has(kind)) {
    const nodes = pageWidgetNodes(body.content)
    return nodes.length ? [...forms, ...formsOfDocNodes(nodes)] : forms
  }
  if (kind === 'image') {
    const src = (body.content ?? '').trim()
    if (src) forms.push({ kind: 'image', value: { src, ...(body.title?.trim() ? { alt: body.title.trim() } : {}) }, lossy: [] })
  }
  return forms
}
