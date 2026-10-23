import type { BuildContext, SnippetConversion } from '../snippetConvert'
import type { WidgetSnippetBody } from '../snippets'
import { docFeatures } from '../snippetForms/tiptap'
import { rowsToGfm } from '../snippetForms/rows'
import { pictureLossy, svgDataUrl } from '../snippetForms/picture'
import { L } from '../snippetForms/lossy'
import { fitWithin, ok, pick, refusal } from './common'

/** Marks a page work widget's editor holds (StarterKit, Link). */
const PAGE_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link', 'underline'])
/** Nodes a page work widget's editor holds (StarterKit, tasks, tables). */
const PAGE_NODES = new Set([
  'paragraph', 'text', 'hardBreak', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'blockquote', 'codeBlock', 'horizontalRule', 'table', 'tableRow', 'tableHeader', 'tableCell'
])

/** Is any block aligned other than to the left? (A page widget has no alignment.) */
function hasAlignment(nodes: unknown[]): boolean {
  return nodes.some((n) => {
    const o = n as { attrs?: { textAlign?: unknown }; content?: unknown[] }
    if (!o || typeof o !== 'object') return false
    const a = o.attrs?.textAlign
    if (typeof a === 'string' && a !== 'left') return true
    return Array.isArray(o.content) && hasAlignment(o.content)
  })
}

function widget(widgetKind: string, content: string, width: number, height: number): WidgetSnippetBody {
  return { kind: 'widget', widgetKind, title: '', content, width, height, color: null }
}

/**
 * Into a desk: a work widget template. A document becomes a page widget (its
 * TipTap JSON), a sheet block a markdown widget holding a GFM table of its
 * values, text a sticky, and anything visual an image widget whose content is
 * the picture as a data: URL (a later step stores it in the file store).
 */
export function toWidget(ctx: BuildContext): SnippetConversion {
  const { body, forms } = ctx
  if (body?.kind === 'widget') return ok(structuredClone(body), [])
  const f = pick(forms, ['rows', 'docNodes', 'image', 'svg', 'text'], body)
  if (!f) return refusal(body, 'widget')
  switch (f.kind) {
    case 'rows':
      return ok(widget('markdown', rowsToGfm(f.value.rows), 460, 360), f.lossy)
    case 'docNodes': {
      const feat = docFeatures(f.value)
      const lossy = [...f.lossy]
      if (feat.images) lossy.push(L.pictures)
      if ([...feat.marks].some((m) => !PAGE_MARKS.has(m))) lossy.push(L.colourSize)
      if ([...feat.other].some((t) => !PAGE_NODES.has(t))) lossy.push(L.embeds)
      if (hasAlignment(f.value)) lossy.push(L.alignment)
      return ok(widget('page', JSON.stringify({ type: 'doc', content: f.value }), 480, 400), lossy)
    }
    case 'image':
      return ok(widget('image', f.value.src, 360, 280), f.lossy)
    case 'svg': {
      const size = fitWithin(f.value.width, f.value.height, 640, 640)
      return ok(widget('image', svgDataUrl(f.value.svg), Math.max(160, size.w), Math.max(120, size.h)), [pictureLossy(f.value.app), ...f.lossy])
    }
    case 'text':
      if (!f.value.trim()) return refusal(body, 'widget')
      return ok(widget('sticky', f.value.trim(), 240, 200), f.lossy)
    default:
      return refusal(body, 'widget')
  }
}
