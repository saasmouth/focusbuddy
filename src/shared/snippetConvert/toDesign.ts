import type { BuildContext, SnippetConversion } from '../snippetConvert'
import type { SlideTextElement } from '../types'
import type { ContentBlock, ContentDoc } from '../designContent'
import { parseTiptap } from '../designContent'
import { docFeatures, firstTableRows } from '../snippetForms/tiptap'
import { paragraphNode } from '../snippetForms/rows'
import { pictureLossy, svgDataUrl, usableElements } from '../snippetForms/picture'
import { L } from '../snippetForms/lossy'
import { emptyReason, estimateLines, linkRefusal, ok, pick, refusal } from './common'
import { imageElement, tableElement } from './elements'

/** The story id a converted text frame reads. Design's insert mints a fresh one. */
export const STORY_ID = 'story-0'

/**
 * Each table row as one paragraph, cells separated by a spaced bar. A story
 * has no table block, and the story parser would otherwise run every cell of a
 * table together into one word ("ItemPriceDesign1200").
 */
function tablesAsRowParagraphs(nodes: unknown[]): unknown[] {
  return nodes.flatMap((n) => {
    const node = n as { type?: string }
    if (node?.type !== 'table') return [n]
    const t = firstTableRows([n])
    return (t?.rows ?? []).filter((r) => r.some((c) => c.trim())).map((r) => paragraphNode(r.join(' | ')))
  })
}

/** A text frame reading story `STORY_ID`, sized to its words. */
function storyFrame(doc: ContentDoc): SlideTextElement {
  const w = 600
  const texts = doc.blocks.flatMap((b) => (b.kind === 'list' ? b.items : 'text' in b ? [b.text] : []))
  const lines = estimateLines(texts, w, 16)
  const h = Math.max(40, Math.round(lines * 16 * 1.5 + doc.blocks.length * 8 + 16))
  return { id: 'text-0', type: 'text', x: 0, y: 0, w, h, z: 0, paragraphs: [], storyId: STORY_ID, storyOrder: 1 }
}

/**
 * Into PlexiiDesign: page elements. Deck elements are the same model and land
 * as they are (plain text boxes keep their own paragraphs and run styling,
 * which a story would flatten). A document becomes a text frame reading a new
 * story (headings, lists and quotes kept as story blocks), a sheet block a
 * native table element, which Design's canvas and exporter both draw.
 */
export function toDesign(ctx: BuildContext): SnippetConversion {
  const { body, forms } = ctx
  if (body?.kind === 'design') return ok(structuredClone(body), [])
  if (body?.kind === 'slide') {
    const { elements, dropped } = usableElements(body.elements)
    if (!elements.length) return dropped ? { ok: false, reason: L.unsupportedImage } : { ok: false, reason: emptyReason(ctx.verb) }
    // Deck text boxes land as plain frames, each holding its own words. That
    // is faithful, but a Design user expects text to flow, so say how.
    const texts = elements.filter((e) => e.type === 'text').length
    const lossy = [...(dropped ? [L.unsupportedImage] : []), ...(texts >= 2 ? [L.textBoxesSeparate] : [])]
    return ok({ kind: 'design', elements: structuredClone(elements) }, lossy)
  }
  const f = pick(forms, ['rows', 'docNodes', 'image', 'svg', 'text'], body)
  if (!f) return linkRefusal(forms, 'design') ?? refusal(body, 'design', ctx.verb)
  switch (f.kind) {
    case 'rows':
      return ok({ kind: 'design', elements: [tableElement(f.value)] }, f.lossy)
    case 'docNodes': {
      const story = parseTiptap({ type: 'doc', content: tablesAsRowParagraphs(f.value) })
      if (!story.blocks.length) return refusal(body, 'design', ctx.verb)
      const feat = docFeatures(f.value)
      const lossy = [...f.lossy]
      if (feat.marks.size) lossy.push(L.marksPlain)
      if (feat.tables) lossy.push(L.tablesAsParagraphs)
      if (feat.linkedImages) lossy.push(L.linkedPictures)
      if (feat.codeBlocks) lossy.push(L.someStyles)
      if (feat.other.size) lossy.push(L.embeds)
      return ok({ kind: 'design', elements: [storyFrame(story)], stories: { [STORY_ID]: story } }, lossy)
    }
    case 'image':
      return ok({ kind: 'design', elements: [imageElement(f.value.src, f.value.width ?? 480, f.value.height ?? 320, f.value.alt ?? '', f.value.width !== undefined && f.value.height !== undefined)] }, f.lossy)
    case 'svg':
      return ok({ kind: 'design', elements: [imageElement(svgDataUrl(f.value.svg), f.value.width, f.value.height, `Picture from ${f.value.app}`, true)] }, [pictureLossy(f.value.app), ...f.lossy])
    case 'text': {
      const blocks: ContentBlock[] = f.value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((text) => ({ kind: 'paragraph', text }))
      if (!blocks.length) return refusal(body, 'design', ctx.verb)
      const story: ContentDoc = { blocks }
      return ok({ kind: 'design', elements: [storyFrame(story)], stories: { [STORY_ID]: story } }, f.lossy)
    }
    default:
      return refusal(body, 'design', ctx.verb)
  }
}
