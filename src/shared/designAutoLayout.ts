// PlexiDesign auto-layout — turn a document into a laid-out publication.
//
// This is the engine behind "paste your text, pick a look, get a finished
// document". It is DETERMINISTIC and needs no AI: given content blocks, a page
// size, a brand kit and a style, it produces a complete multi-page DesignBody —
// master page with running head and folio, a title opener, threaded body frames
// per column, images and pull quotes placed with text wrap, and as many pages as
// the copy actually needs.
//
// The AI layer sits ABOVE this (see LayoutPlan): it only chooses parameters —
// which style, how many columns, which real sentences to pull out, where a
// section should start a new page. It never writes copy. That separation is what
// makes the feature honest: with no API key you still get a good document, and
// with one you get better choices about the same words.
//
// The page-growing loop is the heart of it: flow the story, and while text is
// still overset, add another page of frames and flow again. That is why a
// 4,000-word paste becomes a twelve-page booklet instead of one overflowing box.

import {
  BASE_LAYER_ID,
  type DesignBody,
  type DesignLayer,
  type DesignMaster,
  type DesignPage,
  type DesignSize
} from './design'
import { flowStory, type FlowFrame, type FlowMeasurer, type FlowParaStyle, type FlowParagraph } from './designFlow'
import { contentStats, pullQuoteFrom, type ContentBlock, type ContentDoc } from './designContent'
import { DEFAULT_BRAND_KIT, type OrgBrandKit } from './brandKit'
import type { SlideElement, SlideFill, SlideShapeElement, SlideTextElement } from './types'

// ── Styles ───────────────────────────────────────────────────────────────────

export interface LayoutStyle {
  id: string
  name: string
  blurb: string
  /** Text columns inside the margin box. */
  columns: number
  /** Margin as a fraction of the page's short edge. */
  marginRatio: number
  /** Body size as a fraction of the column width — the classic measure control. */
  bodyRatio: number
  leading: number
  /** Body alignment. Justified reads as print; ragged reads as screen. */
  justify: boolean
  dropCap: boolean
  pullQuotes: boolean
  runningHead: boolean
  folio: boolean
  facing: boolean
  /** A coloured band behind the title on the opening page. */
  titleBand: boolean
  /** A rule above each heading. */
  headingRule: boolean
  /** Serif body copy, when the brand has not specified otherwise. */
  serifBody: boolean
}

export const LAYOUT_STYLES: LayoutStyle[] = [
  {
    id: 'editorial',
    name: 'Editorial',
    blurb: 'Two columns, drop cap and pull quotes. Reads like a feature article.',
    columns: 2,
    marginRatio: 0.085,
    bodyRatio: 0.038,
    leading: 1.5,
    justify: true,
    dropCap: true,
    pullQuotes: true,
    runningHead: true,
    folio: true,
    facing: false,
    titleBand: false,
    headingRule: true,
    serifBody: true
  },
  {
    id: 'report',
    name: 'Report',
    blurb: 'One wide column, generous margins, clear headings. Built to be read at a desk.',
    columns: 1,
    marginRatio: 0.11,
    bodyRatio: 0.026,
    leading: 1.6,
    justify: false,
    dropCap: false,
    pullQuotes: false,
    runningHead: true,
    folio: true,
    facing: false,
    titleBand: true,
    headingRule: false,
    serifBody: false
  },
  {
    id: 'magazine',
    name: 'Magazine',
    blurb: 'Three tight columns under a full-width title band. Dense and energetic.',
    columns: 3,
    marginRatio: 0.06,
    bodyRatio: 0.048,
    leading: 1.42,
    justify: true,
    dropCap: true,
    pullQuotes: true,
    runningHead: true,
    folio: true,
    facing: false,
    titleBand: true,
    headingRule: false,
    serifBody: false
  },
  {
    id: 'booklet',
    name: 'Booklet',
    blurb: 'Facing pages, one narrow measure, classic book proportions.',
    columns: 1,
    marginRatio: 0.12,
    bodyRatio: 0.032,
    leading: 1.55,
    justify: true,
    dropCap: false,
    pullQuotes: false,
    runningHead: false,
    folio: true,
    facing: true,
    titleBand: false,
    headingRule: false,
    serifBody: true
  },
  {
    id: 'newsletter',
    name: 'Newsletter',
    blurb: 'Two compact columns with an accent masthead. Fits a lot on a page.',
    columns: 2,
    marginRatio: 0.055,
    bodyRatio: 0.036,
    leading: 1.38,
    justify: false,
    dropCap: false,
    pullQuotes: true,
    runningHead: false,
    folio: true,
    facing: false,
    titleBand: true,
    headingRule: true,
    serifBody: false
  }
]

export function findLayoutStyle(id: string): LayoutStyle {
  return LAYOUT_STYLES.find((s) => s.id === id) ?? LAYOUT_STYLES[0]
}

/**
 * The AI's (or the heuristic's) choices about ONE document. Everything here is
 * an arrangement decision — no field can carry text the author did not write,
 * which is why `pullQuoteBlocks` names block indexes rather than quote strings.
 */
export interface LayoutPlan {
  styleId: string
  columns?: number
  /** Indexes of paragraph blocks to lift a verbatim sentence out of. */
  pullQuoteBlocks?: number[]
  /** Block indexes that should begin a new page. */
  pageBreakBlocks?: number[]
  /** How prominent each image should be. */
  imageScale?: Record<number, 'full' | 'half' | 'third'>
  /** One sentence on why, shown to the user. Never used as document copy. */
  reason?: string
}

const SERIF_STACK = 'Georgia, "Iowan Old Style", "Times New Roman", serif'

// ── Type scale ───────────────────────────────────────────────────────────────

export interface Scale {
  body: number
  lead: number
  title: number
  subtitle: number
  h1: number
  h2: number
  h3: number
  quote: number
  caption: number
  bodyFamily: string
  headFamily: string
  ink: string
  accent: string
  muted: string
}

export function typeScaleFor(style: LayoutStyle, brand: OrgBrandKit, colWidth: number): Scale {
  return typeScale(style, brand, colWidth)
}

function typeScale(style: LayoutStyle, brand: OrgBrandKit, colWidth: number): Scale {
  // The body size comes from the COLUMN width, not the page: that is what keeps
  // the measure (characters per line) in the readable 45–75 range whether the
  // layout is one wide column or three narrow ones.
  const body = clamp(colWidth * style.bodyRatio, 8.5, 22)
  const headFamily = brand.fontHeading || DEFAULT_BRAND_KIT.fontHeading
  const bodyFamily = style.serifBody ? SERIF_STACK : brand.fontBody || DEFAULT_BRAND_KIT.fontBody
  return {
    body,
    lead: body * style.leading,
    title: clamp(body * 3.4, 26, 96),
    subtitle: clamp(body * 1.5, 12, 34),
    h1: clamp(body * 1.75, 13, 40),
    h2: clamp(body * 1.32, 11, 28),
    h3: clamp(body * 1.1, 10, 22),
    quote: clamp(body * 1.6, 13, 36),
    caption: clamp(body * 0.82, 7.5, 14),
    bodyFamily,
    headFamily,
    ink: '#1c1917',
    accent: brand.colorPrimary || DEFAULT_BRAND_KIT.colorPrimary,
    muted: '#78716c'
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function font(size: number, family: string, opts: { bold?: boolean; italic?: boolean } = {}): string {
  return `${opts.italic ? 'italic ' : ''}${opts.bold ? '700 ' : ''}${round(size)}px ${family}`
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Blocks to flow paragraphs ────────────────────────────────────────────────

/**
 * Turn content blocks into the styled paragraphs the flow engine sets. The title
 * and subtitle are NOT included: they are placed as their own display frames on
 * the opening page, which is what lets them span all the columns.
 */
export function storyParagraphs(content: ContentDoc, style: LayoutStyle, scale: Scale): FlowParagraph[] {
  const out: FlowParagraph[] = []
  const bodyBase: FlowParaStyle = {
    fontSize: round(scale.body),
    lineHeight: style.leading,
    font: font(scale.body, scale.bodyFamily),
    fontFamily: scale.bodyFamily,
    align: style.justify ? 'justify' : 'left',
    color: scale.ink,
    spaceAfter: round(scale.body * 0.5),
    widowLines: 2
  }

  let firstBodyParagraph = true
  content.blocks.forEach((b, blockIndex) => {
    switch (b.kind) {
      case 'title':
      case 'subtitle':
        // Set separately, as display type on the opener.
        break
      case 'heading': {
        const size = b.level === 1 ? scale.h1 : b.level === 2 ? scale.h2 : scale.h3
        out.push({
          text: b.text,
          source: { block: blockIndex },
          style: {
            fontSize: round(size),
            lineHeight: 1.2,
            font: font(size, scale.headFamily, { bold: true }),
            fontFamily: scale.headFamily,
            bold: true,
            align: 'left',
            color: b.level === 1 ? scale.accent : scale.ink,
            spaceBefore: round(scale.body * (b.level === 1 ? 1.5 : 1.1)),
            spaceAfter: round(scale.body * 0.35),
            keepWithNext: true,
            ...(style.headingRule && b.level === 1
              ? { ruleAbove: { width: 1, thickness: Math.max(1, round(scale.body * 0.07)), color: scale.accent } }
              : {})
          }
        })
        break
      }
      case 'paragraph':
        out.push({
          text: b.text,
          source: { block: blockIndex },
          style: {
            ...bodyBase,
            ...(firstBodyParagraph && style.dropCap ? { dropCapLines: 3 } : {}),
            // Printed prose indents continuation paragraphs instead of spacing
            // them, but only when the text is justified — mixing both looks wrong.
            ...(!firstBodyParagraph && style.justify ? { indent: round(scale.body * 1.2), spaceAfter: 0 } : {})
          }
        })
        firstBodyParagraph = false
        break
      case 'list':
        b.items.forEach((item, i) => {
          out.push({
            text: item,
            source: { block: blockIndex, item: i },
            style: {
              ...bodyBase,
              align: 'left',
              leftInset: round(scale.body * 1.4),
              bullet: b.ordered ? `${i + 1}.` : '•',
              spaceAfter: round(scale.body * 0.22),
              indent: 0
            }
          })
        })
        break
      case 'quote':
        out.push({
          text: b.text,
          source: { block: blockIndex },
          style: {
            fontSize: round(scale.body * 1.05),
            lineHeight: style.leading,
            font: font(scale.body * 1.05, scale.bodyFamily, { italic: true }),
            fontFamily: scale.bodyFamily,
            italic: true,
            align: 'left',
            color: scale.muted,
            leftInset: round(scale.body * 1.2),
            rightInset: round(scale.body * 0.6),
            spaceBefore: round(scale.body * 0.7),
            spaceAfter: round(scale.body * 0.7)
          }
        })
        if (b.attribution) {
          out.push({
            text: `— ${b.attribution}`,
            style: {
              fontSize: round(scale.caption),
              lineHeight: 1.3,
              font: font(scale.caption, scale.bodyFamily),
              fontFamily: scale.bodyFamily,
              align: 'left',
              color: scale.muted,
              leftInset: round(scale.body * 1.2),
              spaceAfter: round(scale.body * 0.7)
            }
          })
        }
        break
      case 'divider':
        out.push({
          text: '· · ·',
          style: {
            fontSize: round(scale.body),
            lineHeight: 2,
            font: font(scale.body, scale.bodyFamily),
            fontFamily: scale.bodyFamily,
            align: 'center',
            color: scale.muted,
            spaceBefore: round(scale.body * 0.5),
            spaceAfter: round(scale.body * 0.5)
          }
        })
        break
      default:
        break
    }
  })
  return out
}

// ── The layout ───────────────────────────────────────────────────────────────

export interface AutoLayoutInput {
  content: ContentDoc
  size: DesignSize
  brand?: OrgBrandKit
  style?: LayoutStyle
  plan?: LayoutPlan
  measure: FlowMeasurer
  /** Safety valve so a pathological input cannot build a thousand pages. */
  maxPages?: number
}

export interface AutoLayoutResult {
  body: DesignBody
  pages: number
  /** True when the copy still did not fit inside maxPages — reported, not hidden. */
  overset: boolean
  words: number
}

let seq = 0
function id(prefix: string): string {
  seq += 1
  return `${prefix}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Build a complete, laid-out publication from a document. */
export function autoLayout(input: AutoLayoutInput): AutoLayoutResult {
  const brand = input.brand ?? DEFAULT_BRAND_KIT
  const style = input.style ?? findLayoutStyle(input.plan?.styleId ?? 'editorial')
  const plan = input.plan
  const size = input.size
  const maxPages = input.maxPages ?? 80
  const W = size.w
  const H = size.h

  const margin = Math.round(Math.min(W, H) * style.marginRatio)
  const margins = { top: margin, right: margin, bottom: margin, left: margin }
  const columns = Math.max(1, Math.min(6, plan?.columns ?? style.columns))
  const boxW = W - margins.left - margins.right
  const boxH = H - margins.top - margins.bottom
  const gutter = Math.round(Math.min(W, H) * 0.028)
  const colW = (boxW - gutter * (columns - 1)) / columns
  const scale = typeScale(style, brand, colW)

  const title = input.content.blocks.find((b) => b.kind === 'title') as { text: string } | undefined
  const subtitle = input.content.blocks.find((b) => b.kind === 'subtitle') as { text: string } | undefined

  // ── The opener: display type at the top of page one ────────────────────────
  const openerElements: SlideElement[] = []
  let openerBottom = margins.top
  if (title) {
    const bandPad = Math.round(scale.title * 0.5)
    const titleH = Math.round(scale.title * 1.22 * estimateLines(title.text, boxW, scale.title, input.measure, font(scale.title, scale.headFamily, { bold: true })))
    if (style.titleBand) {
      openerElements.push({
        id: id('band'),
        type: 'shape',
        shape: 'rect',
        x: 0,
        y: 0,
        w: W,
        h: titleH + bandPad * 2 + (subtitle ? Math.round(scale.subtitle * 1.6) : 0),
        z: 1,
        fill: { type: 'solid', color: scale.accent }
      } as SlideShapeElement)
    }
    openerElements.push(
      textElement({
        x: margins.left,
        y: style.titleBand ? bandPad : margins.top,
        w: boxW,
        h: titleH,
        z: 2,
        text: title.text,
        size: scale.title,
        family: scale.headFamily,
        bold: true,
        color: style.titleBand ? readableOn(scale.accent) : scale.ink,
        lineHeight: 1.12
      })
    )
    openerBottom = (style.titleBand ? bandPad : margins.top) + titleH
    if (subtitle) {
      const subH = Math.round(scale.subtitle * 1.4 * estimateLines(subtitle.text, boxW, scale.subtitle, input.measure, font(scale.subtitle, scale.headFamily)))
      openerElements.push(
        textElement({
          x: margins.left,
          y: openerBottom + Math.round(scale.body * 0.5),
          w: boxW,
          h: subH,
          z: 2,
          text: subtitle.text,
          size: scale.subtitle,
          family: scale.headFamily,
          color: style.titleBand ? readableOn(scale.accent) : scale.muted,
          lineHeight: 1.3
        })
      )
      openerBottom += Math.round(scale.body * 0.5) + subH
    }
    if (style.titleBand) openerBottom += bandPad
    openerBottom += Math.round(scale.body * 1.6)
  }
  const firstPageTop = Math.max(margins.top, openerBottom)

  // ── The master page: running head + folio ──────────────────────────────────
  const masterElements: SlideElement[] = []
  if (style.runningHead && title) {
    masterElements.push(
      textElement({
        x: margins.left,
        y: Math.round(margins.top * 0.42),
        w: boxW,
        h: Math.round(scale.caption * 1.6),
        z: 1,
        text: title.text,
        size: scale.caption,
        family: scale.headFamily,
        color: scale.muted,
        lineHeight: 1.3
      })
    )
    masterElements.push({
      id: id('rule'),
      type: 'shape',
      shape: 'rect',
      x: margins.left,
      y: Math.round(margins.top * 0.42) + Math.round(scale.caption * 1.9),
      w: boxW,
      h: 1,
      z: 1,
      fill: { type: 'solid', color: '#e7e5e4' }
    } as SlideShapeElement)
  }
  if (style.folio) {
    masterElements.push(
      textElement({
        x: margins.left,
        y: H - Math.round(margins.bottom * 0.62),
        w: boxW,
        h: Math.round(scale.caption * 1.6),
        z: 1,
        text: '{#}',
        size: scale.caption,
        family: scale.headFamily,
        color: scale.muted,
        align: 'center',
        lineHeight: 1.3
      })
    )
  }
  const master: DesignMaster = { id: 'master-body', name: 'Master A', elements: masterElements }

  // ── Floating objects: images and pull quotes ───────────────────────────────
  const storyId = id('story')
  const paragraphs = storyParagraphs(input.content, style, scale)
  const floats = buildFloats({ content: input.content, style, plan, scale, colW, gutter, columns, margins, boxW })

  // ── Grow pages until the copy fits ─────────────────────────────────────────
  const layers: DesignLayer[] = [{ id: BASE_LAYER_ID, name: 'Layer 1', visible: true, locked: false }]
  let pageCount = 1
  let pages: DesignPage[] = []
  let overset = true

  for (let attempt = 0; attempt < maxPages; attempt++) {
    pages = buildPages({ pageCount, columns, colW, gutter, margins, boxH, H, firstPageTop, openerElements, floats, storyId })
    const frames: FlowFrame[] = []
    pages.forEach((pg) => {
      for (const el of pg.elements) {
        if (el.type !== 'text' || (el as SlideTextElement).storyId !== storyId) continue
        frames.push({
          id: el.id,
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          obstacles: pg.elements
            .filter((o) => o.wrap?.mode === 'square')
            .map((o) => ({ x: o.x - (o.wrap?.offset ?? 0), y: o.y - (o.wrap?.offset ?? 0), w: o.w + (o.wrap?.offset ?? 0) * 2, h: o.h + (o.wrap?.offset ?? 0) * 2 }))
        })
      }
    })
    frames.sort((a, b) => (a.id < b.id ? -1 : 1))
    // Frames were created in page then column order, so the thread order is the
    // order they were pushed — restore it rather than the id sort above.
    const ordered = frames.slice().sort((a, b) => frameOrder(a.id) - frameOrder(b.id))
    const result = flowStory({ paragraphs, frames: ordered, measure: input.measure })
    overset = result.overset
    // Write the measured lines back onto their frames.
    for (const pg of pages) {
      pg.elements = pg.elements.map((el) => {
        if (el.type !== 'text' || (el as SlideTextElement).storyId !== storyId) return el
        const lines = result.byFrame[el.id] ?? []
        const isLast = ordered[ordered.length - 1]?.id === el.id
        return { ...el, flowLines: lines, overset: isLast ? result.overset : false } as SlideElement
      })
    }
    if (!overset) break
    pageCount++
    if (pageCount > maxPages) break
  }

  const background: SlideFill = { type: 'solid', color: '#ffffff' }
  const body: DesignBody = {
    schemaVersion: 1,
    width: W,
    height: H,
    background,
    elements: pages[0]?.elements ?? [],
    pages,
    activePage: 0,
    category: size.category,
    margins,
    columns: { count: columns, gutter },
    masters: [master],
    layers,
    guides: { v: [], h: [] },
    facing: style.facing,
    stories: { [storyId]: { blocks: bodyBlocks(input.content) } },
    pageNumberStart: 1,
    editingMasterId: null,
    layoutStyleId: style.id
  }

  return { body, pages: pages.length, overset, words: contentStats(input.content).words }
}

/** The blocks that belong to the flowing story (everything but the display opener). */
export function bodyBlocks(content: ContentDoc): ContentBlock[] {
  return content.blocks.filter((b) => b.kind !== 'title' && b.kind !== 'subtitle' && b.kind !== 'image')
}

// Frames are named so their thread order is recoverable from the id alone,
// which keeps the flow order stable across re-layouts.
function frameId(page: number, col: number): string {
  return `frame-${String(page).padStart(4, '0')}-${String(col).padStart(2, '0')}`
}
function frameOrder(fid: string): number {
  const m = /^frame-(\d+)-(\d+)$/.exec(fid)
  return m ? Number(m[1]) * 100 + Number(m[2]) : Number.MAX_SAFE_INTEGER
}

interface Float {
  /** Page-relative element, positioned when its page is built. */
  element: SlideElement
  /** Which page (0-based) it should land on, as a fraction through the story. */
  at: number
}

function buildFloats(input: {
  content: ContentDoc
  style: LayoutStyle
  plan?: LayoutPlan
  scale: Scale
  colW: number
  gutter: number
  columns: number
  margins: { top: number; right: number; bottom: number; left: number }
  boxW: number
}): Float[] {
  const { content, style, plan, scale, colW, gutter, columns, margins, boxW } = input
  const out: Float[] = []
  const total = Math.max(1, content.blocks.length)

  content.blocks.forEach((b, i) => {
    const at = i / total
    if (b.kind === 'image') {
      const want = plan?.imageScale?.[i] ?? (columns >= 3 ? 'half' : columns === 2 ? 'half' : 'full')
      const w = want === 'full' ? boxW : want === 'half' ? Math.min(boxW, colW * Math.min(columns, 2) + gutter) : colW
      const h = Math.round(w * 0.62)
      out.push({
        at,
        element: {
          id: id('img'),
          type: 'image',
          x: margins.left,
          y: 0,
          w: Math.round(w),
          h,
          z: 4,
          src: b.src,
          ...(b.alt ? { alt: b.alt } : {}),
          fit: 'cover',
          wrap: { mode: 'square', offset: Math.round(scale.body * 0.9) }
        } as SlideElement
      })
    }
  })

  if (style.pullQuotes) {
    // Pull quotes are lifted VERBATIM from paragraphs the plan named (or, with no
    // plan, from the longest paragraphs). Nothing is ever written here.
    const candidates =
      plan?.pullQuoteBlocks && plan.pullQuoteBlocks.length
        ? plan.pullQuoteBlocks
        : content.blocks
            .map((b, i) => ({ i, len: b.kind === 'paragraph' ? b.text.length : 0 }))
            .filter((c) => c.len > 320)
            .sort((a, b) => b.len - a.len)
            .slice(0, 3)
            .map((c) => c.i)

    for (const idx of candidates) {
      const block = content.blocks[idx]
      if (!block || block.kind !== 'paragraph') continue
      const quote = pullQuoteFrom(block.text)
      if (!quote) continue
      const w = Math.round(columns >= 2 ? colW : boxW * 0.62)
      out.push({
        at: idx / total,
        element: {
          id: id('pq'),
          type: 'text',
          x: margins.left,
          y: 0,
          w,
          h: Math.round(scale.quote * 1.35 * Math.max(2, Math.ceil(quote.length / Math.max(12, w / (scale.quote * 0.5))))),
          z: 4,
          paragraphs: [{ runs: [{ text: quote, fontSize: Math.round(scale.quote), color: scale.accent, bold: true }] }],
          fontFamily: scale.headFamily,
          wrap: { mode: 'square', offset: Math.round(scale.body * 1.1) }
        } as SlideElement
      })
    }
  }

  return out
}

function buildPages(input: {
  pageCount: number
  columns: number
  colW: number
  gutter: number
  margins: { top: number; right: number; bottom: number; left: number }
  boxH: number
  H: number
  firstPageTop: number
  openerElements: SlideElement[]
  floats: Float[]
  storyId: string
}): DesignPage[] {
  const { pageCount, columns, colW, gutter, margins, H, firstPageTop, openerElements, floats, storyId } = input
  const pages: DesignPage[] = []

  for (let p = 0; p < pageCount; p++) {
    const top = p === 0 ? firstPageTop : margins.top
    const bottom = H - margins.bottom
    const elements: SlideElement[] = p === 0 ? openerElements.map((e) => ({ ...e })) : []

    // Floats land on the page their anchor fell nearest to, alternating between
    // the top and the foot of the page so a long document does not get a row of
    // objects all in the same place.
    const mine = floats.filter((f) => Math.min(pageCount - 1, Math.floor(f.at * pageCount)) === p)
    let floatTop = top
    let floatBottom = bottom
    const placed: SlideElement[] = []
    mine.forEach((f, i) => {
      const el = { ...f.element }
      if (i % 2 === 0) {
        el.y = floatTop
        floatTop += el.h + Math.round(gutter * 0.8)
      } else {
        el.y = Math.max(floatTop, floatBottom - el.h)
        floatBottom = el.y - Math.round(gutter * 0.8)
      }
      placed.push(el)
    })
    elements.push(...placed)

    for (let c = 0; c < columns; c++) {
      elements.push({
        id: frameId(p, c),
        type: 'text',
        x: Math.round(margins.left + c * (colW + gutter)),
        y: Math.round(top),
        w: Math.round(colW),
        h: Math.round(bottom - top),
        z: 3,
        paragraphs: [],
        storyId,
        storyOrder: p * 100 + c
      } as SlideTextElement)
    }

    pages.push({ id: `pg-${p + 1}`, background: { type: 'solid', color: '#ffffff' }, elements, masterId: p === 0 ? null : undefined })
  }
  return pages
}

function textElement(o: {
  x: number
  y: number
  w: number
  h: number
  z: number
  text: string
  size: number
  family: string
  color: string
  bold?: boolean
  align?: 'left' | 'center' | 'right'
  lineHeight?: number
}): SlideTextElement {
  return {
    id: id('t'),
    type: 'text',
    x: Math.round(o.x),
    y: Math.round(o.y),
    w: Math.round(o.w),
    h: Math.round(o.h),
    z: o.z,
    fontFamily: o.family,
    paragraphs: [{ runs: [{ text: o.text, fontSize: Math.round(o.size), color: o.color, bold: o.bold }], align: o.align ?? 'left' }]
  }
}

function estimateLines(text: string, width: number, size: number, measure: FlowMeasurer, fontStr: string): number {
  const w = measure(text, fontStr)
  if (w <= 0) return Math.max(1, Math.ceil((text.length * size * 0.5) / Math.max(1, width)))
  return Math.max(1, Math.ceil(w / Math.max(1, width)))
}

/** Black or white, whichever reads on the given background. */
function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  // Relative luminance, the same test the brand kit uses for contrast.
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return lum > 0.6 ? '#1c1917' : '#ffffff'
}

// ── The no-AI planner ────────────────────────────────────────────────────────

/**
 * Choose a layout from the SHAPE of the content. This is what runs when there is
 * no AI key, and it is deliberately good enough to stand on its own: a long
 * unbroken essay wants an editorial two-column, a heading-dense document wants a
 * report, a short image-led piece wants a magazine.
 */
export function planFromContent(content: ContentDoc): LayoutPlan {
  const s = contentStats(content)
  let styleId = 'editorial'
  let reason = 'Two columns suit a continuous piece of this length.'

  if (s.words < 220) {
    styleId = 'report'
    reason = 'Short copy reads better in one wide column than in narrow ones.'
  } else if (s.headings >= Math.max(3, s.paragraphs / 4)) {
    styleId = 'report'
    reason = 'Frequent headings need a single column so each section stays clear.'
  } else if (s.images >= 2 && s.words < 1400) {
    styleId = 'magazine'
    reason = 'Several images with moderate copy suit a denser, picture-led grid.'
  } else if (s.words > 3000) {
    styleId = 'booklet'
    reason = 'At this length a booklet with facing pages is the comfortable read.'
  } else if (s.lists >= 3) {
    styleId = 'newsletter'
    reason = 'List-heavy copy fits a compact two-column newsletter.'
  }

  const pullQuoteBlocks = content.blocks
    .map((b, i) => ({ i, text: b.kind === 'paragraph' ? b.text : '' }))
    .filter((c) => c.text.length > 320 && pullQuoteFrom(c.text) !== null)
    .slice(0, 3)
    .map((c) => c.i)

  return { styleId, pullQuoteBlocks, reason }
}
