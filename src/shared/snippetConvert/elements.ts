// Slide/design elements built from forms. Deck and Design share one element
// model (shared/types SlideElement), so both builders use these. Ids are
// derived (`table-0`, `text-0`): the destination's paste engine mints real ones.

import type { SlideImageElement, SlideTableElement, SlideTextElement, SlideTextParagraph, SlideTextRun } from '../types'
import type { RowsValue } from '../snippetForms'
import { L } from '../snippetForms/lossy'
import { estimateLines, fitWithin } from './common'

/** Deck's page. A converted block is sized to sit on it. */
export const PAGE = { w: 1280, h: 720 }

export function tableElement(v: RowsValue, id = 'table-0'): SlideTableElement {
  const cols = v.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const fontSize = 16
  return {
    id,
    type: 'table',
    x: 0,
    y: 0,
    w: Math.min(PAGE.w - 80, Math.max(160, cols * 160)),
    h: Math.min(PAGE.h - 80, Math.max(40, v.rows.length * 40)),
    z: 0,
    cells: v.rows.map((r) => [...r, ...Array<string>(cols - r.length).fill('')]),
    ...(v.header ? { headerRow: true } : {}),
    fontSize
  }
}

/**
 * An image element. `natural` says the size is the picture's real one (an SVG
 * we drew); otherwise it is only a frame to start from and is not recorded as
 * the image's natural size, which aspect-lock and "fit to image" would trust.
 */
export function imageElement(src: string, width: number, height: number, alt: string, natural: boolean, id = 'image-0'): SlideImageElement {
  const size = fitWithin(width, height, PAGE.w - 80, PAGE.h - 80)
  return {
    id,
    type: 'image',
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
    z: 0,
    src,
    fit: 'contain',
    ...(natural ? { lockAspect: true, naturalW: Math.round(width), naturalH: Math.round(height) } : {}),
    ...(alt ? { alt } : {})
  }
}

/** A text box holding paragraphs, sized to its words. */
export function textBox(paragraphs: SlideTextParagraph[], id = 'text-0'): SlideTextElement {
  const w = 760
  const size = paragraphs.reduce((m, p) => Math.max(m, ...p.runs.map((r) => r.fontSize ?? 24)), 24)
  const lines = estimateLines(paragraphs.map((p) => p.runs.map((r) => r.text).join('')), w - 24, size)
  const h = Math.min(PAGE.h - 80, Math.max(48, Math.round(lines * size * 1.3 + 24)))
  return { id, type: 'text', x: 0, y: 0, w, h, z: 0, paragraphs }
}

/** Plain lines as paragraphs of one run each. */
export function lineParagraphs(text: string): SlideTextParagraph[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => ({ runs: [{ text: l, fontSize: 24 }] }))
}

interface Tip {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: Tip[]
  marks?: Array<{ type?: string }>
}

const SLIDE_MARKS = new Set(['bold', 'italic', 'underline'])
const HEADING_SIZE: Record<number, number> = { 1: 40, 2: 32, 3: 28 }

/**
 * TipTap nodes as a text box's paragraphs, keeping what a slide paragraph can
 * hold: bold, italic and underline runs, heading size, bullet and numbered
 * lists with their nesting. What it cannot hold is reported.
 */
export function docNodesToParagraphs(nodes: unknown[]): { paragraphs: SlideTextParagraph[]; lossy: string[] } {
  const out: SlideTextParagraph[] = []
  const lossy = new Set<string>()
  const runsOf = (n: Tip, base: Partial<SlideTextRun>): SlideTextRun[][] => {
    // Split at hard breaks: a slide paragraph has no line break inside it.
    const lines: SlideTextRun[][] = [[]]
    const walk = (k: Tip, inherited: Partial<SlideTextRun>): void => {
      if (k.type === 'hardBreak') {
        lines.push([])
        return
      }
      if (typeof k.text === 'string') {
        const r: SlideTextRun = { text: k.text, ...inherited }
        for (const m of k.marks ?? []) {
          if (m.type === 'bold') r.bold = true
          else if (m.type === 'italic') r.italic = true
          else if (m.type === 'underline') r.underline = true
          else if (m.type === 'link') lossy.add(L.linksPlain)
          else if (m.type && !SLIDE_MARKS.has(m.type)) lossy.add(L.someStyles)
        }
        lines[lines.length - 1].push(r)
        return
      }
      if (k.type === 'image') {
        lossy.add(L.pictures)
        return
      }
      for (const c of k.content ?? []) walk(c, inherited)
    }
    for (const c of n.content ?? []) walk(c, base)
    return lines
  }
  const block = (n: Tip, ctx: { level: number; list?: 'bullet' | 'number'; italic?: boolean }): void => {
    const base: Partial<SlideTextRun> = { fontSize: 24, ...(ctx.italic ? { italic: true } : {}) }
    switch (n.type) {
      case 'paragraph':
      case 'heading': {
        const level = Number(n.attrs?.level ?? 0)
        const extra: Partial<SlideTextRun> = n.type === 'heading' ? { bold: true, fontSize: HEADING_SIZE[level] ?? 26 } : {}
        for (const runs of runsOf(n, { ...base, ...extra })) {
          out.push({ runs: runs.length ? runs : [{ text: '', ...base }], ...(ctx.list ? { listStyle: ctx.list, bulletLevel: ctx.level } : {}) })
          ctx = { ...ctx, list: undefined }
        }
        return
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        for (const item of n.content ?? []) {
          let first = true
          for (const c of item.content ?? []) {
            if (c.type === 'bulletList' || c.type === 'orderedList' || c.type === 'taskList') {
              block(c, { ...ctx, level: ctx.level + 1, list: undefined })
              continue
            }
            block(c, { ...ctx, list: first ? (n.type === 'orderedList' ? 'number' : 'bullet') : undefined })
            first = false
          }
        }
        if (n.type === 'taskList') lossy.add(L.someStyles)
        return
      case 'blockquote':
        for (const c of n.content ?? []) block(c, { ...ctx, italic: true })
        return
      case 'codeBlock':
        lossy.add(L.someStyles)
        for (const line of (n.content ?? []).map((t) => t.text ?? '').join('').split('\n')) out.push({ runs: [{ text: line, ...base }] })
        return
      case 'table':
        lossy.add(L.tablesAsLines)
        for (const row of n.content ?? []) {
          const cells = (row.content ?? []).map((cell) => runsOf({ content: (cell.content ?? []).flatMap((p) => p.content ?? []) }, base).flat().map((r) => r.text).join(''))
          out.push({ runs: [{ text: cells.join('\t'), ...base }] })
        }
        return
      case 'image':
        lossy.add(L.pictures)
        return
      case 'horizontalRule':
        return
      default:
        if (n.type && n.type !== 'text') lossy.add(L.embeds)
        for (const c of n.content ?? []) block(c, ctx)
    }
  }
  for (const n of nodes) if (n && typeof n === 'object') block(n as Tip, { level: 0 })
  return { paragraphs: out, lossy: [...lossy] }
}
