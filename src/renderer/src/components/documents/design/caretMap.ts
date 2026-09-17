// Mapping between a caret in the story and a blinking bar on the page.
//
// This is the piece that makes a laid-out page editable. The flow engine records,
// for every line it sets, which paragraph it came from and which characters of
// that paragraph it holds. With that, both directions are just arithmetic:
//
//   caret -> point   find the line holding the offset, measure the text before
//                    it, and that is where the bar goes
//   point -> caret   find the line under the click, binary-search the character
//                    whose edge is nearest the x, and that is the offset
//
// Everything here works in PAGE coordinates (the frame's own origin plus the
// line's position), because that is what the canvas overlay draws in.

import type { DesignBody } from '@shared/design'
import { storyFrames } from '@shared/design'
import type { FlowLine, FlowMeasurer, FlowParagraph } from '@shared/designFlow'
import { compareCarets, orderedSelection, slots, type DocCaret, type DocSelection } from '@shared/designTextEdit'
import type { ContentDoc } from '@shared/designContent'
import type { SlideTextElement } from '@shared/types'

export interface CaretPoint {
  /** Page index the caret is on, so the editor can follow it across pages. */
  pageIndex: number
  frameId: string
  /** Page coordinates. */
  x: number
  y: number
  h: number
}

export interface SelectionRect {
  pageIndex: number
  x: number
  y: number
  w: number
  h: number
}

interface PlacedLine {
  line: FlowLine
  frame: SlideTextElement
  pageIndex: number
}

/** Every line of a story, in thread order, with the frame and page it landed on. */
export function placedLines(design: DesignBody, storyId: string): PlacedLine[] {
  const out: PlacedLine[] = []
  for (const { pageIndex, element } of storyFrames(design, storyId)) {
    for (const line of element.flowLines ?? []) out.push({ line, frame: element, pageIndex })
  }
  return out
}

/** The CSS font shorthand a line was set in, so measuring matches rendering. */
export function lineFont(line: FlowLine): string {
  return `${line.italic ? 'italic ' : ''}${line.bold ? '700 ' : ''}${line.size}px ${line.family ?? 'Inter, system-ui, sans-serif'}`
}

function widthOf(text: string, line: FlowLine, measure: FlowMeasurer): number {
  return measure(text, lineFont(line)) + (line.letterSpacing ?? 0) * Math.max(0, text.length - 1)
}

/** Which flowed paragraph a document caret belongs to, or -1. */
export function paragraphIndexOf(paragraphs: FlowParagraph[], caret: DocCaret): number {
  return paragraphs.findIndex((p) => p.source && p.source.block === caret.block && (p.source.item ?? -1) === (caret.item ?? -1))
}

/**
 * Where the caret sits on the page. Returns null when the caret's paragraph is
 * not set anywhere — which is the honest answer for text that is currently
 * overset, and is why the editor can then offer to add a page.
 */
export function caretToPoint(
  design: DesignBody,
  storyId: string,
  paragraphs: FlowParagraph[],
  caret: DocCaret,
  measure: FlowMeasurer
): CaretPoint | null {
  const pi = paragraphIndexOf(paragraphs, caret)
  if (pi < 0) return null
  const lines = placedLines(design, storyId).filter((p) => p.line.para === pi)
  if (lines.length === 0) return null

  let hit = lines.find((p) => caret.offset >= p.line.start && caret.offset <= p.line.end)
  if (!hit) hit = caret.offset < lines[0].line.start ? lines[0] : lines[lines.length - 1]

  const source = paragraphs[pi].text
  const clamped = Math.max(hit.line.start, Math.min(hit.line.end, caret.offset))
  // The line's own text is the source slice with runs of whitespace collapsed to
  // single spaces, so measuring the slice directly would drift. Measure the
  // rendered text up to the same word boundary instead.
  const before = renderedPrefix(source, hit.line, clamped)
  return {
    pageIndex: hit.pageIndex,
    frameId: hit.frame.id,
    x: hit.frame.x + hit.line.x + widthOf(before, hit.line, measure),
    y: hit.frame.y + hit.line.y,
    h: hit.line.lh
  }
}

/**
 * The part of a line's RENDERED text that precedes a source offset. A line holds
 * a slice of the paragraph with its internal whitespace normalised, so the two
 * are walked in step rather than sliced by index.
 */
export function renderedPrefix(source: string, line: FlowLine, offset: number): string {
  const slice = source.slice(line.start, Math.max(line.start, offset))
  // The rendered line joins words with single spaces; do the same to the prefix.
  const words = slice.split(/\s+/)
  const trailingSpace = /\s$/.test(slice) && slice !== ''
  const joined = words.filter((w, i) => w !== '' || i === 0).join(' ')
  return trailingSpace && !joined.endsWith(' ') ? `${joined} ` : joined
}

/** The source offset a rendered-prefix length corresponds to. */
function offsetForRenderedLength(source: string, line: FlowLine, renderedLen: number): number {
  let rendered = 0
  let i = line.start
  let lastWasSpace = true
  while (i < line.end && rendered < renderedLen) {
    const ch = source[i]
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        rendered += 1
        lastWasSpace = true
      }
    } else {
      rendered += 1
      lastWasSpace = false
    }
    i++
  }
  return i
}

/**
 * The caret nearest a point on the page. Used by clicking and by dragging a
 * selection, so both land on the same character the eye expects.
 */
export function pointToCaret(
  design: DesignBody,
  storyId: string,
  paragraphs: FlowParagraph[],
  point: { pageIndex: number; x: number; y: number },
  measure: FlowMeasurer
): DocCaret | null {
  const lines = placedLines(design, storyId).filter((p) => p.pageIndex === point.pageIndex)
  if (lines.length === 0) return null

  // The line whose band contains the y, else the vertically nearest one.
  let best: PlacedLine | null = null
  let bestDist = Infinity
  for (const p of lines) {
    const top = p.frame.y + p.line.y
    const bottom = top + p.line.lh
    const dy = point.y < top ? top - point.y : point.y > bottom ? point.y - bottom : 0
    // Ties on y are broken by horizontal distance, which is what makes clicking
    // in a multi-column layout land in the column under the pointer.
    const left = p.frame.x + p.line.x
    const right = left + p.line.w
    const dx = point.x < left ? left - point.x : point.x > right ? point.x - right : 0
    const dist = dy * 1000 + dx
    if (dist < bestDist) {
      bestDist = dist
      best = p
    }
  }
  if (!best) return null

  const para = paragraphs[best.line.para]
  if (!para?.source) return null
  const source = para.text
  const localX = point.x - (best.frame.x + best.line.x)

  // Walk the rendered characters and stop at the one whose midpoint the click
  // passed — the standard "nearest character edge" rule.
  const rendered = best.line.text
  let chosen = rendered.length
  let prevW = 0
  for (let n = 1; n <= rendered.length; n++) {
    const w = widthOf(rendered.slice(0, n), best.line, measure)
    if (localX < (prevW + w) / 2) {
      chosen = n - 1
      break
    }
    prevW = w
  }

  return {
    block: para.source.block,
    ...(para.source.item !== undefined ? { item: para.source.item } : {}),
    offset: offsetForRenderedLength(source, best.line, chosen)
  }
}

/** The highlight rectangles for a selection, one per line it touches. */
export function selectionRects(
  design: DesignBody,
  storyId: string,
  paragraphs: FlowParagraph[],
  doc: ContentDoc,
  sel: DocSelection,
  measure: FlowMeasurer
): SelectionRect[] {
  if (compareCarets(doc, sel.anchor, sel.focus) === 0) return []
  const { from, to } = orderedSelection(doc, sel)
  const order = slots(doc)
  const slotOf = (c: DocCaret): number => order.findIndex((s) => s.block === c.block && (s.item ?? -1) === (c.item ?? -1))
  const fromSlot = slotOf(from)
  const toSlot = slotOf(to)
  if (fromSlot < 0 || toSlot < 0) return []

  const rects: SelectionRect[] = []
  for (const placed of placedLines(design, storyId)) {
    const para = paragraphs[placed.line.para]
    if (!para?.source) continue
    const s = order.findIndex((x) => x.block === para.source!.block && (x.item ?? -1) === (para.source!.item ?? -1))
    if (s < fromSlot || s > toSlot) continue

    // How much of THIS line falls inside the selection.
    const startOffset = s === fromSlot ? Math.max(placed.line.start, from.offset) : placed.line.start
    const endOffset = s === toSlot ? Math.min(placed.line.end, to.offset) : placed.line.end
    if (endOffset <= startOffset) {
      // A wholly-selected empty line still shows a thin marker so the user can
      // see the blank paragraph is part of the selection.
      if (s > fromSlot && s < toSlot && placed.line.text === '') {
        rects.push({ pageIndex: placed.pageIndex, x: placed.frame.x + placed.line.x, y: placed.frame.y + placed.line.y, w: placed.line.size * 0.4, h: placed.line.lh })
      }
      continue
    }
    const head = renderedPrefix(para.text, placed.line, startOffset)
    const through = renderedPrefix(para.text, placed.line, endOffset)
    const x0 = widthOf(head, placed.line, measure)
    const x1 = widthOf(through, placed.line, measure)
    if (x1 <= x0) continue
    rects.push({
      pageIndex: placed.pageIndex,
      x: placed.frame.x + placed.line.x + x0,
      y: placed.frame.y + placed.line.y,
      w: x1 - x0,
      h: placed.line.lh
    })
  }
  return rects
}

/** Move the caret one line up or down, keeping its horizontal position. */
export function caretVertical(
  design: DesignBody,
  storyId: string,
  paragraphs: FlowParagraph[],
  caret: DocCaret,
  direction: -1 | 1,
  measure: FlowMeasurer
): DocCaret | null {
  const point = caretToPoint(design, storyId, paragraphs, caret, measure)
  if (!point) return null
  const all = placedLines(design, storyId)
  const idx = all.findIndex((p) => p.frame.id === point.frameId && p.frame.y + p.line.y === point.y && p.line.para === paragraphIndexOf(paragraphs, caret))
  const target = all[(idx < 0 ? 0 : idx) + direction]
  if (!target) return null
  return pointToCaret(
    design,
    storyId,
    paragraphs,
    { pageIndex: target.pageIndex, x: point.x, y: target.frame.y + target.line.y + target.line.lh / 2 },
    measure
  )
}
