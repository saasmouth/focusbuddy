import type { BuildContext, SnippetConversion } from '../snippetConvert'
import { nodesToPlainText } from '../snippetForms/tiptap'
import { pictureLossy, svgDataUrl } from '../snippetForms/picture'
import { REASON, fitWithin, ok, pick, refusal } from './common'

/** The widest a converted picture lands in a document: Write's text column. */
export const DOC_PICTURE_MAX_WIDTH = 640

function imageNode(src: string, alt: string, width?: number): Record<string, unknown> {
  return { type: 'image', attrs: { src, alt, title: null, width: width ?? null } }
}

/**
 * Into PlexiiWrite: TipTap nodes. A sheet block is a table of what its cells
 * display, text widgets are their paragraphs and lists, a page widget its own
 * nodes, and anything visual a picture (an SVG data: URL in an image node).
 */
export function toDoc(ctx: BuildContext): SnippetConversion {
  const { body, forms } = ctx
  if (body.kind === 'doc') return ok(structuredClone(body), [])
  const f = pick(forms, ['docNodes', 'image', 'svg'], body)
  if (!f) return refusal(body, 'doc')
  if (f.kind === 'docNodes') {
    if (!f.value.length) return { ok: false, reason: REASON.empty }
    const content = structuredClone(f.value)
    return ok({ kind: 'doc', content, text: nodesToPlainText(content) }, f.lossy)
  }
  if (f.kind === 'image') {
    const v = f.value
    return ok({ kind: 'doc', content: [imageNode(v.src, v.alt ?? '', v.width ? Math.min(v.width, DOC_PICTURE_MAX_WIDTH) : undefined)], text: '' }, f.lossy)
  }
  if (f.kind === 'svg') {
    const v = f.value
    const size = fitWithin(v.width, v.height, DOC_PICTURE_MAX_WIDTH, Number.MAX_SAFE_INTEGER)
    return ok({ kind: 'doc', content: [imageNode(svgDataUrl(v.svg), `Picture from ${v.app}`, size.w)], text: '' }, [pictureLossy(v.app), ...f.lossy])
  }
  return refusal(body, 'doc')
}
