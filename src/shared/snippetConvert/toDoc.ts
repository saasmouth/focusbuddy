import type { BuildContext, SnippetConversion } from '../snippetConvert'
import type { LinkValue } from '../snippetForms'
import { nodesToPlainText } from '../snippetForms/tiptap'
import { pictureLossy, svgDataUrl } from '../snippetForms/picture'
import { REASON, emptyReason, fitWithin, isSafeLinkHref, ok, pick, refusal } from './common'

/** The widest a converted picture lands in a document: Write's text column. */
export const DOC_PICTURE_MAX_WIDTH = 640

function imageNode(src: string, alt: string, width?: number): Record<string, unknown> {
  return { type: 'image', attrs: { src, alt, title: null, width: width ?? null } }
}

/** The document id a `plexii://document/<id>` link names, or null. */
export function linkedDocumentId(href: string): string | null {
  const m = /^plexii:\/\/document\/([^/?#]+)$/i.exec(href.trim())
  if (!m) return null
  try {
    const id = decodeURIComponent(m[1])
    return id.trim() ? id : null
  } catch {
    return null
  }
}

/**
 * A link as PlexiiWrite holds it. A document is a DocEmbedNode, exactly the
 * node Write's own insertDocEmbed(documentId) inserts, so the document shows
 * as its live card. Anything else (a file, a folder) is a paragraph holding
 * the title under a link mark (Write's Link registers `plexii`, so the link
 * survives saving and export).
 */
export function linkNodes(v: LinkValue): unknown[] {
  const documentId = v.target === 'document' ? linkedDocumentId(v.href) : null
  if (documentId) return [{ type: 'docEmbed', attrs: { documentId } }]
  const title = v.title.trim() || v.href
  return [{ type: 'paragraph', content: [{ type: 'text', text: title, marks: [{ type: 'link', attrs: { href: v.href.trim() } }] }] }]
}

/**
 * Into PlexiiWrite: TipTap nodes. A sheet block is a table of what its cells
 * display, text widgets are their paragraphs and lists, a page widget its own
 * nodes, and anything visual a picture (an SVG data: URL in an image node).
 */
export function toDoc(ctx: BuildContext): SnippetConversion {
  const { body, forms } = ctx
  if (body?.kind === 'doc') return ok(structuredClone(body), [])
  const f = pick(forms, ['docNodes', 'image', 'svg', 'link'], body)
  if (!f) return refusal(body, 'doc', ctx.verb)
  if (f.kind === 'docNodes') {
    if (!f.value.length) return { ok: false, reason: emptyReason(ctx.verb) }
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
  if (f.kind === 'link') {
    if (!isSafeLinkHref(f.value.href)) return { ok: false, reason: REASON.linkUnsafe }
    const content = linkNodes(f.value)
    return ok({ kind: 'doc', content, text: nodesToPlainText(content) }, f.lossy)
  }
  return refusal(body, 'doc', ctx.verb)
}
