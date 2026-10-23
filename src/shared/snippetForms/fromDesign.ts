import type { DesignSnippetBody } from '../snippets'
import type { SlideElement, SlideTextElement, SlideTextParagraph, SlideTextRun } from '../types'
import type { Form } from '../snippetForms'
import { normalizeContent, type ContentDoc } from '../designContent'
import { elementsPictureLossy, elementsText, elementsToSvg, usableElements, type ImageSrcCheck } from './picture'
import { L } from './lossy'

/**
 * A story's blocks as a text element's own paragraphs, typed the way the
 * frame sets them (its size, colour and alignment). Headings are bold and
 * larger, lists keep their bullets, quotes are italic. `marker` writes the
 * bullet into the text, for renderers that do not draw listStyle.
 */
export function storyParagraphs(doc: ContentDoc, frame: SlideTextElement, marker = false): SlideTextParagraph[] {
  const size = typeof frame.fontSize === 'number' && frame.fontSize > 0 ? frame.fontSize : 16
  const align = frame.align === 'justify' ? 'left' : frame.align
  const run = (text: string, extra: Partial<SlideTextRun> = {}): SlideTextRun => ({
    text,
    ...(frame.color ? { color: frame.color } : {}),
    fontSize: Math.round(extra.fontSize ?? size),
    ...(extra.bold ? { bold: true } : {}),
    ...(extra.italic ? { italic: true } : {})
  })
  const p = (runs: SlideTextRun[], extra: Partial<SlideTextParagraph> = {}): SlideTextParagraph => ({ runs, ...(align ? { align } : {}), ...extra })
  const out: SlideTextParagraph[] = []
  for (const b of doc.blocks) {
    switch (b.kind) {
      case 'title':
        out.push(p([run(b.text, { bold: true, fontSize: size * 2 })]))
        break
      case 'subtitle':
        out.push(p([run(b.text, { fontSize: size * 1.4 })]))
        break
      case 'heading':
        out.push(p([run(b.text, { bold: true, fontSize: size * (b.level === 1 ? 1.6 : b.level === 2 ? 1.35 : 1.15) })]))
        break
      case 'paragraph':
        out.push(p([run(b.text)]))
        break
      case 'list':
        b.items.forEach((it, i) => {
          const style = b.ordered ? 'number' : 'bullet'
          out.push(marker ? p([run(`${b.ordered ? `${i + 1}.` : '•'} ${it}`)]) : p([run(it)], { listStyle: style, bulletLevel: 0 }))
        })
        break
      case 'quote':
        out.push(p([run(b.attribution ? `${b.text} (${b.attribution})` : b.text, { italic: true })]))
        break
      default:
        break
    }
  }
  return out
}

export interface DesignAsPlain {
  /** The elements with every threaded frame's story written into its own paragraphs. */
  elements: SlideElement[]
  /** Some story ran through more than one frame. */
  linkedChains: boolean
  /** Some frame read a story at all. */
  threaded: boolean
  /** Images left out because their address is not usable (see usableElements). */
  droppedImages: number
}

/**
 * Design elements with their stories resolved into plain text frames, the
 * element model a deck (or a picture) can draw on its own. A story is written
 * whole into the FIRST frame of its chain; the frames after it are dropped
 * (`followers: 'drop'`) or kept empty (`'empty'`, so a picture keeps their
 * fills and borders). Design-only fields (story ids, flow cache, layers, wrap,
 * swatch links) are removed; a swatch fill keeps its colour.
 */
export function designAsPlainElements(body: DesignSnippetBody, followers: 'drop' | 'empty', marker = false, srcOk?: ImageSrcCheck): DesignAsPlain {
  const { elements, dropped } = usableElements(body.elements, srcOk)
  const stories = new Map<string, ContentDoc>()
  for (const [id, raw] of Object.entries(body.stories && typeof body.stories === 'object' ? body.stories : {})) {
    const doc = normalizeContent(raw)
    if (doc.blocks.length) stories.set(id, doc)
  }
  // The first frame of each chain: lowest storyOrder, then stored order.
  const firstOf = new Map<string, string>()
  const count = new Map<string, number>()
  for (const e of elements) {
    if (e.type !== 'text' || !e.storyId || !stories.has(e.storyId)) continue
    count.set(e.storyId, (count.get(e.storyId) ?? 0) + 1)
    const cur = firstOf.get(e.storyId)
    const curEl = cur ? (elements.find((x) => x.id === cur) as SlideTextElement | undefined) : undefined
    if (!curEl || (e.storyOrder ?? 0) < (curEl.storyOrder ?? 0)) firstOf.set(e.storyId, e.id)
  }
  const out: SlideElement[] = []
  for (const src of elements) {
    const e = structuredClone(src) as SlideElement & Record<string, unknown>
    delete e.layerId
    delete e.wrap
    const fill = e.fill as Record<string, unknown> | undefined
    if (fill && typeof fill === 'object' && 'swatchId' in fill) delete fill.swatchId
    if (e.type === 'text') {
      const t = e as SlideTextElement & Record<string, unknown>
      const sid = t.storyId
      delete t.storyId
      delete t.storyOrder
      delete t.flowLines
      delete t.overset
      if (sid && stories.has(sid)) {
        if (firstOf.get(sid) === t.id) t.paragraphs = storyParagraphs(stories.get(sid)!, src as SlideTextElement, marker)
        else if (followers === 'drop') continue
        else t.paragraphs = []
      }
      if (!Array.isArray(t.paragraphs)) t.paragraphs = []
      // Story typography lives on the frame; the paragraphs now carry it.
      for (const k of ['fontSize', 'lineHeight', 'align', 'color', 'paragraphSpacing', 'firstLineIndent']) delete t[k]
    }
    out.push(e as SlideElement)
  }
  return {
    elements: out,
    linkedChains: [...count.values()].some((n) => n > 1),
    threaded: count.size > 0,
    droppedImages: dropped
  }
}

export function formsOfDesign(body: DesignSnippetBody, srcOk?: ImageSrcCheck): Form[] {
  const forms: Form[] = [{ kind: 'native', value: body, lossy: [] }]
  const plain = designAsPlainElements(body, 'empty', true, srcOk)
  if (!plain.elements.length) return forms
  const lossy = elementsPictureLossy(plain.elements)
  if (plain.linkedChains) lossy.push(L.linkedFramesFirst)
  if (plain.droppedImages) lossy.push(L.unsupportedImage)
  forms.push({ kind: 'svg', value: elementsToSvg(plain.elements, 'PlexiiDesign'), lossy })
  // Words once each: a story counted in its first frame only.
  const text = elementsText(designAsPlainElements(body, 'drop', true, srcOk).elements)
  if (text) forms.push({ kind: 'text', value: text, lossy: [L.wordsOnly] })
  return forms
}
