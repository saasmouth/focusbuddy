import type { BuildContext, SnippetConversion } from '../snippetConvert'
import { designAsPlainElements } from '../snippetForms/fromDesign'
import { pictureLossy, svgDataUrl } from '../snippetForms/picture'
import { L } from '../snippetForms/lossy'
import { REASON, ok, pick, refusal } from './common'
import { docNodesToParagraphs, imageElement, lineParagraphs, tableElement, textBox } from './elements'

/**
 * Into PlexiiDeck: slide elements. Design elements are the same model, so they
 * stay shapes, images, tables and text (a threaded story becomes one text box
 * holding it). A sheet block is Deck's native table with computed values, a
 * document a text box keeping bold, italic, headings and lists, a drawing or
 * diagram a picture.
 */
export function toSlide(ctx: BuildContext): SnippetConversion {
  const { body, forms } = ctx
  if (body?.kind === 'slide') return ok(structuredClone(body), [])
  if (body?.kind === 'design') {
    const plain = designAsPlainElements(body, 'drop')
    if (!plain.elements.length) return { ok: false, reason: REASON.empty }
    return ok({ kind: 'slide', elements: plain.elements }, [...(plain.linkedChains ? [L.linkedFrames] : []), ...(plain.droppedImages ? [L.unsupportedImage] : [])])
  }
  const f = pick(forms, ['rows', 'docNodes', 'image', 'svg', 'text'], body)
  if (!f) return refusal(body, 'slide')
  switch (f.kind) {
    case 'rows':
      return ok({ kind: 'slide', elements: [tableElement(f.value)] }, f.lossy)
    case 'docNodes': {
      const { paragraphs, lossy } = docNodesToParagraphs(f.value)
      if (!paragraphs.length) return refusal(body, 'slide')
      return ok({ kind: 'slide', elements: [textBox(paragraphs)] }, [...f.lossy, ...lossy])
    }
    case 'image':
      return ok({ kind: 'slide', elements: [imageElement(f.value.src, f.value.width ?? 480, f.value.height ?? 320, f.value.alt ?? '', f.value.width !== undefined && f.value.height !== undefined)] }, f.lossy)
    case 'svg':
      return ok({ kind: 'slide', elements: [imageElement(svgDataUrl(f.value.svg), f.value.width, f.value.height, `Picture from ${f.value.app}`, true)] }, [pictureLossy(f.value.app), ...f.lossy])
    case 'text':
      if (!f.value.trim()) return refusal(body, 'slide')
      return ok({ kind: 'slide', elements: [textBox(lineParagraphs(f.value))] }, f.lossy)
    default:
      return refusal(body, 'slide')
  }
}
