// PlexiDesign text flow — the typesetting engine under threaded stories.
//
// A STORY is a sequence of styled PARAGRAPHS (a title, headings, body copy,
// lists, pull quotes). It is poured into an ordered chain of FRAMES: fill the
// first, carry what is left into the second, and so on. What will not fit in the
// last frame is OVERSET — reported, never silently dropped.
//
// Per-paragraph styling is what makes this a layout engine rather than a text
// box. One story can hold a 40pt heading, 10pt body and an indented pull quote,
// each with its own leading and space-before/after, all flowing as one thread
// across pages. The engine also does the things that separate typeset pages from
// a wall of text:
//
//   keep-with-next   a heading never strands itself at the foot of a column
//   widows/orphans   a paragraph does not leave one lonely line behind or ahead
//   text wrap        lines dodge the bounding boxes of objects set to wrap
//   drop caps        an oversized initial that the first lines indent around
//
// Measurement is injected, so the editor measures with the browser's own font
// engine (exact, and cached onto the frame so export matches the screen) while
// tests measure with a deterministic stand-in.

import { longestFittingPrefix } from './hyphenate'

export interface FlowBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A rhythm that text can be locked to, so columns line up across a page.
 *
 * In PAGE coordinates, not frame coordinates — that is the whole point. Two
 * columns only align if they are measured against the same ruler, and a frame
 * sitting 7px lower than its neighbour must not get its own private grid.
 *
 * HONEST LIMIT: this positions LINE BOXES, not true baselines. The renderer
 * centres text in a CSS line box, so where the baseline falls inside it
 * depends on the font's ascent — a metric the engine never sees, since it
 * measures through a width-only callback. With one line height, which is the
 * case body copy cares about, line boxes on the grid mean baselines on the
 * grid, and columns align exactly. Mixed sizes locked to the same grid will
 * align their line boxes rather than their baselines, and may sit a fraction
 * of a point out from a true metric grid.
 */
export interface BaselineGrid {
  /** Distance between grid lines, in px. Usually the body line height. */
  spacing: number
  /** Where the first grid line sits, in page coordinates. Defaults to 0. */
  offset?: number
}

export interface FlowFrame extends FlowBox {
  id: string
  /**
   * Obstacles specific to this frame, overriding the call-level list. A story
   * threads across PAGES and every page has its own coordinate space, so without
   * per-frame obstacles an image on page 1 would push text around on page 2.
   */
  obstacles?: FlowBox[]
}

/** How one paragraph is set. Everything the engine and the renderer both need. */
export interface FlowParaStyle {
  fontSize: number
  /** Multiplier on fontSize. */
  lineHeight: number
  /** CSS font shorthand handed to the measurer — must match the render font. */
  font: string
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  color?: string
  align: 'left' | 'center' | 'right' | 'justify'
  letterSpacing?: number
  /** Vertical space before / after the paragraph, in px. */
  spaceBefore?: number
  spaceAfter?: number
  /** First-line indent, in px. */
  indent?: number
  /** Indent applied to the whole paragraph (lists, block quotes), in px. */
  leftInset?: number
  rightInset?: number
  /** A marker drawn in the left inset on the first line (a bullet or a number). */
  bullet?: string
  /** Do not let this paragraph be the last thing in a frame — headings use it. */
  keepWithNext?: boolean
  /** Minimum lines of this paragraph that must stay together at a frame edge. */
  widowLines?: number
  /** An oversized initial spanning this many lines. */
  dropCapLines?: number
  /**
   * Break long words across lines when it helps the line fit.
   *
   * Per paragraph style, as in InDesign, and worth having off by default:
   * hyphenation earns its place in justified columns, where the alternative
   * is stretched spaces, and is mostly a nuisance in a ragged-right heading.
   */
  hyphenate?: boolean
  /**
   * Lock this paragraph's lines to the document's baseline grid.
   *
   * Per paragraph style, as in InDesign: body copy locks so columns line up
   * across the page, while a heading or a caption usually should not, because
   * forcing a 24pt heading onto a 15px rhythm leaves a gap wherever the two
   * do not divide.
   */
  snapToGrid?: boolean
  /** A rule drawn above the paragraph, as a fraction of the column width. */
  ruleAbove?: { width: number; thickness: number; color: string }
}

export interface FlowParagraph {
  text: string
  style: FlowParaStyle
  /**
   * Where this paragraph's words came from in the story document, so a caret on
   * the page can be mapped back to the block the author edits. Absent for
   * generated paragraphs (a quote's attribution line, a divider ornament) which
   * are therefore not directly editable.
   */
  source?: { block: number; item?: number }
}

/** One laid-out line, positioned relative to its frame's top-left corner. */
export interface FlowLine {
  x: number
  y: number
  /** The width available to this line — what justification stretches to. */
  w: number
  text: string
  /** The last line of a paragraph is never justified, exactly as in print. */
  lastOfPara: boolean
  // The resolved style, carried per line so the renderer and the exporter draw
  // identical type without having to re-resolve anything.
  size: number
  lh: number
  align: FlowParaStyle['align']
  family?: string
  bold?: boolean
  italic?: boolean
  color?: string
  letterSpacing?: number
  /** Present on a paragraph's first line when it has a marker. */
  bullet?: string
  /**
   * This line is a FOOTNOTE at the foot of the frame, not body copy.
   *
   * Notes are stored in the frame's lines so they render and export through
   * the same path as everything else, which is why every consumer of those
   * lines has to be able to tell them apart: a click on a note must not place
   * a caret in the body text, and a note must not be counted when the advisor
   * measures the body's line length.
   */
  footnote?: boolean
  // ── Where these characters came from ───────────────────────────────────────
  // The index of the paragraph in the flowed array, and the half-open character
  // range of that paragraph's text this line holds. Together they are what lets
  // a click on the page become a caret in the story, and a caret in the story
  // become a blinking bar on the page.
  para: number
  start: number
  end: number
  /** Present on a drop-cap line: the initial, drawn oversized in the indent. */
  dropCap?: { text: string; size: number; width: number }
  /** Present when a rule is drawn above this line. */
  rule?: { width: number; thickness: number; color: string }
}

export interface FlowResult {
  byFrame: Record<string, FlowLine[]>
  /** True when paragraphs remained after the final frame was filled. */
  overset: boolean
  /** The paragraph index the overflow starts at, for "continue on a new page". */
  oversetFrom: number | null
  /** How much vertical space the overflow needs, so the caller can size a frame. */
  oversetHeight: number
}

export type FlowMeasurer = (text: string, font: string) => number

export function defaultParaStyle(fontSize = 16): FlowParaStyle {
  return {
    fontSize,
    lineHeight: 1.45,
    font: `${fontSize}px Inter, system-ui, sans-serif`,
    align: 'left',
    spaceAfter: Math.round(fontSize * 0.55)
  }
}

/**
 * The horizontal stretches of [x0, x1] still free between `top` and `bottom`,
 * once every overlapping obstacle has been cut out. Returned left to right.
 */
export function freeIntervals(x0: number, x1: number, top: number, bottom: number, obstacles: FlowBox[], offset = 0): Array<[number, number]> {
  let spans: Array<[number, number]> = [[x0, x1]]
  for (const ob of obstacles) {
    const oTop = ob.y - offset
    const oBottom = ob.y + ob.h + offset
    // A line only has to dodge an obstacle it actually shares height with.
    if (oBottom <= top || oTop >= bottom) continue
    const oLeft = ob.x - offset
    const oRight = ob.x + ob.w + offset
    const next: Array<[number, number]> = []
    for (const [s, e] of spans) {
      if (oRight <= s || oLeft >= e) {
        next.push([s, e])
        continue
      }
      if (oLeft > s) next.push([s, Math.min(oLeft, e)])
      if (oRight < e) next.push([Math.max(oRight, s), e])
    }
    spans = next
  }
  return spans.filter(([s, e]) => e - s > 0)
}

interface Cursor {
  /** Index of the paragraph being set. */
  para: number
  /** Index of the next word within that paragraph. */
  word: number
}

/**
 * Pour styled paragraphs through `frames` in order. Frames are used in the order
 * given — that order IS the thread, so re-threading is a matter of reordering.
 */
export function flowStory(input: {
  paragraphs: FlowParagraph[]
  frames: FlowFrame[]
  /** Page-coordinate boxes text must flow around, when a frame has none of its own. */
  obstacles?: FlowBox[]
  /** Gap kept between the text and an obstacle. */
  wrapOffset?: number
  /** The document's baseline grid, when it has one. */
  grid?: BaselineGrid
  measure: FlowMeasurer
}): FlowResult {
  const { paragraphs, frames, measure } = input
  const obstacles = input.obstacles ?? []
  const wrapOffset = input.wrapOffset ?? 0
  const grid = input.grid && input.grid.spacing > 0 ? input.grid : null

  const byFrame: Record<string, FlowLine[]> = {}
  const cursor: Cursor = { para: 0, word: 0 }

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi]
    const lines: FlowLine[] = []
    byFrame[frame.id] = lines
    const isLastFrame = fi === frames.length - 1
    let y = 0

    while (cursor.para < paragraphs.length) {
      const para = paragraphs[cursor.para]
      const st = para.style
      const lineH = st.fontSize * st.lineHeight
      const startingPara = cursor.word === 0

      if (startingPara) {
        // Space before only applies when the paragraph does not start a frame —
        // a column should not begin with a gap.
        const before = lines.length === 0 ? 0 : st.spaceBefore ?? 0
        if (y + before + lineH > frame.h + 0.01) break
        y += before
      }

      // An empty paragraph is a deliberate blank. It still emits a zero-width
      // line so a caret has somewhere to sit — without one, an empty paragraph
      // would be invisible AND unclickable.
      const words = splitWordsWithOffsets(para.text)
      if (words.length === 0) {
        if (y + lineH > frame.h + 0.01) break
        lines.push({
          x: 0,
          y,
          w: frame.w,
          text: '',
          lastOfPara: true,
          size: st.fontSize,
          lh: lineH,
          align: st.align,
          para: cursor.para,
          start: 0,
          end: 0,
          ...(st.fontFamily ? { family: st.fontFamily } : {}),
          ...(st.color ? { color: st.color } : {})
        })
        cursor.para++
        cursor.word = 0
        y += lineH + (st.spaceAfter ?? 0)
        continue
      }

      if (y + lineH > frame.h + 0.01) break

      // A heading must not strand itself: if it cannot be followed by at least
      // one line of the next paragraph in this frame, push the whole thing on.
      if (startingPara && st.keepWithNext && !isLastFrame) {
        const next = paragraphs[cursor.para + 1]
        const nextLh = next ? next.style.fontSize * next.style.lineHeight + (next.style.spaceBefore ?? 0) : 0
        if (y + lineH + nextLh > frame.h + 0.01) break
      }

      // Lock to the grid, when the document has one and this style asks.
      //
      // Two steps, and both are needed. Snapping only the first line puts the
      // paragraph on the grid and lets every line after it drift off again;
      // quantising only the line height keeps the rhythm but starts it
      // wherever the previous paragraph happened to end. Together they put
      // every line of the paragraph on a grid line.
      let para2 = para
      if (grid && st.snapToGrid) {
        const offset = grid.offset ?? 0
        const pageY = frame.y + y
        // Forward only: pulling a line UP to a nearer grid line would overlap
        // whatever sits above it.
        const snappedPage = offset + Math.ceil((pageY - offset) / grid.spacing - 1e-6) * grid.spacing
        y = snappedPage - frame.y
        const quantised = Math.ceil((lineH - 1e-6) / grid.spacing) * grid.spacing
        if (quantised > 0 && Math.abs(quantised - lineH) > 1e-6) {
          para2 = { ...para, style: { ...st, lineHeight: quantised / st.fontSize } }
        }
        // Re-check the fit: snapping pushes text DOWN, so a line that fitted
        // before the snap may not fit after it.
        if (y + Math.max(lineH, quantised) > frame.h + 0.01) break
      }

      const set = setParagraph({
        para: para2,
        paraIndex: cursor.para,
        words,
        startWord: cursor.word,
        frame,
        top: y,
        obstacles: frame.obstacles ?? obstacles,
        wrapOffset,
        measure,
        allowPartial: !startingPara || isLastFrame || true
      })

      // Orphan control: a paragraph that could only fit one line here, with more
      // to come, is moved whole to the next frame rather than leaving a stub.
      const widow = Math.max(1, st.widowLines ?? 2)
      if (
        startingPara &&
        !isLastFrame &&
        set.lines.length > 0 &&
        set.lines.length < widow &&
        set.nextWord < words.length &&
        lines.length > 0
      ) {
        break
      }

      if (set.lines.length === 0) {
        // Nothing fitted (every stretch at this height was blocked and the frame
        // has no room left) — move on to the next frame.
        break
      }

      for (const l of set.lines) lines.push(l)
      y = set.bottom
      cursor.word = set.nextWord

      if (cursor.word >= words.length) {
        cursor.para++
        cursor.word = 0
        y += st.spaceAfter ?? 0
      } else {
        // The paragraph is still going but this frame is full.
        break
      }
    }
  }

  const overset = cursor.para < paragraphs.length
  let oversetHeight = 0
  if (overset) {
    for (let i = cursor.para; i < paragraphs.length; i++) {
      const st = paragraphs[i].style
      const words = splitWordsWithOffsets(paragraphs[i].text)
      // A rough column-agnostic estimate: enough to tell the caller how much
      // room the rest needs, which is all "add a page" has to know.
      const perLine = Math.max(1, Math.round(60))
      const est = Math.max(1, Math.ceil(words.length / perLine))
      oversetHeight += est * st.fontSize * st.lineHeight + (st.spaceAfter ?? 0)
    }
  }

  return { byFrame, overset, oversetFrom: overset ? cursor.para : null, oversetHeight }
}

interface Word {
  text: string
  start: number
  end: number
}

/**
 * The words of a paragraph WITH their character offsets. The offsets are what
 * make the page editable: a line knows exactly which slice of the source text it
 * is showing, so a click can be turned into a character index.
 */
function splitWordsWithOffsets(text: string): Word[] {
  const out: Word[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/**
 * Set as much of one paragraph as fits in `frame` starting at `top`, honouring
 * wrap obstacles, indents, bullets and drop caps.
 */
function setParagraph(input: {
  para: FlowParagraph
  paraIndex: number
  words: Word[]
  startWord: number
  frame: FlowFrame
  top: number
  obstacles: FlowBox[]
  wrapOffset: number
  measure: FlowMeasurer
  allowPartial: boolean
}): { lines: FlowLine[]; bottom: number; nextWord: number } {
  const { para, words, frame, obstacles, wrapOffset, measure } = input
  const st = para.style
  const lineH = st.fontSize * st.lineHeight
  const spacing = st.letterSpacing ?? 0
  const widthOf = (s: string): number => measure(s, st.font) + spacing * Math.max(0, s.length - 1)
  // A stretch narrower than this cannot hold anything useful, so it is skipped
  // rather than filled with one broken character per line.
  const minSpan = Math.max(st.fontSize * 1.5, 8)

  const leftInset = st.leftInset ?? 0
  const rightInset = st.rightInset ?? 0
  const colLeft = frame.x + leftInset
  const colRight = frame.x + frame.w - rightInset

  // Drop cap geometry: the initial occupies `dropCapLines` lines of height, and
  // those lines indent past it.
  let cap: { text: string; size: number; width: number; lines: number } | null = null
  if (input.startWord === 0 && st.dropCapLines && st.dropCapLines > 1 && words[0]) {
    // words are {text,start,end} now that lines carry character ranges.
    const letter = words[0].text[0]
    const capSize = lineH * st.dropCapLines * 0.82
    const capFont = st.font.replace(/(\d+(?:\.\d+)?)px/, `${Math.round(capSize)}px`)
    cap = { text: letter, size: capSize, width: measure(letter, capFont) * 1.06, lines: st.dropCapLines }
  }

  const lines: FlowLine[] = []
  let y = input.top
  let wi = input.startWord
  let first = true
  let capLinesLeft = cap ? cap.lines : 0
  // The first word loses its initial letter when a drop cap takes it; the
  // character range still covers it, so the caret can sit before the cap.
  // How far into the current word we already are, when the line before it
  // ended mid-word. Zero for every word that was placed whole.
  let tail = 0
  const wordAt = (i: number): string => {
    const raw = cap && i === 0 ? words[0].text.slice(1) : words[i].text
    return i === wi ? raw.slice(tail) : raw
  }

  while (wi < words.length) {
    if (y + lineH > frame.h + 0.01) break

    const capIndent = capLinesLeft > 0 && cap ? cap.width + st.fontSize * 0.12 : 0
    const spans = freeIntervals(colLeft + capIndent, colRight, frame.y + y, frame.y + y + lineH, obstacles, wrapOffset)
    const usable = spans.filter(([s, e]) => e - s >= minSpan)
    if (usable.length === 0) {
      // Every stretch at this height is blocked — drop a line and try again.
      y += lineH
      if (capLinesLeft > 0) capLinesLeft--
      continue
    }

    let placedOnThisLine = false
    for (const [s, e] of usable) {
      if (wi >= words.length) break
      const indent = first && st.indent ? st.indent : 0
      const spanW = e - s - indent
      if (spanW < minSpan) continue

      let line = ''
      let lineStart = -1
      let lineEnd = -1
      while (wi < words.length) {
        const word = wordAt(wi)
        if (word === '') {
          wi++
          continue
        }
        const candidate = line ? `${line} ${word}` : word
        // A single word wider than the column is still placed, whole: an
        // overflowing word is visible and fixable, a missing one is not.
        if (line !== '' && widthOf(candidate) > spanW) {
          // Before giving up on the word, try breaking it.
          //
          // Only when the REMAINDER is certain to land on another line of this
          // same frame. setParagraph hands the caller a word index, not a
          // character offset inside a word, so a tail left dangling at a frame
          // edge would be re-emitted whole in the next frame — the same text
          // twice. Requiring room for one more line here keeps the tail inside
          // this call, which is the only place that can represent it.
          const roomForAnother = y + lineH * 2 <= frame.h + 0.01
          const hyphenated =
            st.hyphenate && roomForAnother
              ? longestFittingPrefix(word, (c) => widthOf(`${line} ${c}`) <= spanW)
              : null
          if (hyphenated) {
            if (lineStart < 0) lineStart = words[wi].start + tail
            line = `${line} ${hyphenated.prefix}`
            lineEnd = words[wi].start + tail + hyphenated.at
            tail += hyphenated.at
          }
          break
        }
        if (lineStart < 0) lineStart = words[wi].start + tail
        lineEnd = words[wi].end
        line = candidate
        tail = 0
        wi++
      }
      if (line === '') continue

      placedOnThisLine = true
      lines.push({
        x: s - frame.x + indent,
        y,
        w: spanW,
        text: line,
        lastOfPara: wi >= words.length,
        para: input.paraIndex,
        start: lineStart,
        end: lineEnd,
        size: st.fontSize,
        lh: lineH,
        align: st.align,
        ...(st.fontFamily ? { family: st.fontFamily } : {}),
        ...(st.bold ? { bold: true } : {}),
        ...(st.italic ? { italic: true } : {}),
        ...(st.color ? { color: st.color } : {}),
        ...(spacing ? { letterSpacing: spacing } : {}),
        ...(first && st.bullet ? { bullet: st.bullet } : {}),
        ...(first && cap ? { dropCap: { text: cap.text, size: cap.size, width: cap.width } } : {}),
        ...(first && st.ruleAbove ? { rule: st.ruleAbove } : {})
      })
      first = false
    }

    if (!placedOnThisLine) {
      y += lineH
      if (capLinesLeft > 0) capLinesLeft--
      continue
    }

    y += lineH
    if (capLinesLeft > 0) capLinesLeft--
  }

  return { lines, bottom: y, nextWord: wi }
}

// ── Page-number tokens ───────────────────────────────────────────────────────

/**
 * Resolve the automatic page-number tokens a master page can carry.
 *
 *   {#}      the page's own number
 *   {pages}  the total page count
 *
 * Braces were chosen over InDesign's single "A" marker character because a
 * visible token is legible in a plain text field and cannot be typed by accident
 * in ordinary prose.
 */
export function resolvePageTokens(text: string, ctx: { page: number; pages: number }): string {
  return text.replace(/\{#\}/g, String(ctx.page)).replace(/\{pages\}/g, String(ctx.pages))
}

export function hasPageToken(text: string): boolean {
  return /\{#\}|\{pages\}/.test(text)
}
