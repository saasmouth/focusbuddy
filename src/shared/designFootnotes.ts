// Footnotes — a marker in the text, the note at the foot of the frame the
// marker landed in.
//
// THE CIRCULARITY, which is the whole problem and the reason this is its own
// module. A note takes vertical space from the bottom of its frame. Less
// space means less text fits. Less text means the marker that summoned the
// note may move to the NEXT frame — taking its note with it, freeing the
// space, letting more text fit, which may pull the marker back. A naive
// implementation either ignores this and draws notes for markers that are no
// longer on the page, or oscillates forever.
//
// It is solved the way InDesign solves it: flow, see where the markers
// landed, reserve the space those notes need, flow again, and repeat until
// nothing moves. Convergence is NOT guaranteed — the oscillation above is
// real — so the loop is bounded and, when it does not settle, returns the
// last result that was internally consistent rather than the prettiest one.
// A page with a note one line lower than ideal is fine; a page whose note
// belongs to a marker printed overleaf is not.
//
// Pure: rectangles, strings and a measure callback in, placements out.

import { flowStory, type FlowFrame, type FlowParagraph, type FlowParaStyle, type FlowResult, type FlowMeasurer, type BaselineGrid } from './designFlow'

export interface FootnoteDef {
  id: string
  /** The note itself, as plain text. */
  text: string
}

export interface FootnotePlacement {
  frameId: string
  /** Notes on this frame, in the order their markers appear. */
  notes: Array<{ id: string; marker: string; text: string }>
  /** Vertical space the notes occupy, including the separator rule. */
  height: number
}

export interface FootnoteLayout {
  flow: FlowResult
  placements: FootnotePlacement[]
  /** True when the loop hit its bound without settling. */
  unsettled: boolean
}

const SUPERSCRIPTS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹']

/**
 * The marker for note n, as real superscript characters.
 *
 * Real characters rather than a rendering instruction, because the flow
 * engine measures text to break lines. A marker the measurer cannot see is a
 * marker that makes its line slightly too long, and the error accumulates
 * down a justified column.
 */
export function footnoteMarker(n: number): string {
  if (n <= 0) return ''
  return String(n)
    .split('')
    .map((d) => SUPERSCRIPTS[Number(d)] ?? '')
    .join('')
}

/** Number notes 1..n in the order their markers appear in the story. */
export function numberFootnotes(order: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const id of order) if (!out.has(id)) out.set(id, footnoteMarker(out.size + 1))
  return out
}

/**
 * Which note ids are referenced, in reading order.
 *
 * A reference is written into the paragraph text as the marker character
 * plus the id in a zero-width wrapper, which keeps the width honest while
 * leaving the id recoverable. Paragraphs carry their refs explicitly instead,
 * because parsing text for metadata is how text stops being text.
 */
export function referencedIds(paragraphs: FootnoteRefParagraph[]): string[] {
  const out: string[] = []
  for (const p of paragraphs) for (const r of p.footnoteRefs ?? []) out.push(r.id)
  return out
}

export interface FootnoteRefParagraph extends FlowParagraph {
  /** Note references in this paragraph, with their character offsets. */
  footnoteRefs?: Array<{ id: string; offset: number }>
}

export interface FootnoteOptions {
  /** Type the notes are set in. Smaller than body, as in print. */
  style: FlowParaStyle
  /** Space between the text above and the first note. */
  gap?: number
  /** Height of the separator rule above the notes. */
  ruleHeight?: number
  /** Give up after this many passes. Default 4. */
  maxPasses?: number
}

/** Height one note needs in a column of the given width. */
function noteHeight(text: string, width: number, style: FlowParaStyle, measure: FlowMeasurer): number {
  if (width <= 0) return style.fontSize * style.lineHeight
  const w = measure(text, style.font)
  const lines = Math.max(1, Math.ceil(w / width))
  return lines * style.fontSize * style.lineHeight
}

/**
 * Flow a story and place its footnotes, settling the two against each other.
 *
 * `frames` are the full frames; each pass shortens them by the space its
 * notes need and flows again.
 */
export function layoutWithFootnotes(input: {
  paragraphs: FootnoteRefParagraph[]
  frames: FlowFrame[]
  notes: FootnoteDef[]
  measure: FlowMeasurer
  grid?: BaselineGrid
  options: FootnoteOptions
}): FootnoteLayout {
  const { paragraphs, frames, notes, measure, grid, options } = input
  const gap = options.gap ?? options.style.fontSize * 0.8
  const rule = options.ruleHeight ?? 1
  const maxPasses = options.maxPasses ?? 4
  const byId = new Map(notes.map((n) => [n.id, n]))

  // Numbering follows reading order in the STORY, not the page, so a note
  // keeps its number when the text reflows onto a different page.
  const numbers = numberFootnotes(referencedIds(paragraphs))

  let reserves: Record<string, number> = {}
  let flow = flowStory({ paragraphs, frames, measure, grid })
  let placements: FootnotePlacement[] = []
  let unsettled = true

  for (let pass = 0; pass < maxPasses; pass++) {
    const shortened = frames.map((f) => ({ ...f, h: Math.max(0, f.h - (reserves[f.id] ?? 0)) }))
    flow = flowStory({ paragraphs, frames: shortened, measure, grid })

    // Which markers landed in which frame, from the character ranges the
    // flow engine reports — the same ranges that turn a click into a caret.
    const next: FootnotePlacement[] = []
    const nextReserves: Record<string, number> = {}
    for (const f of frames) {
      const lines = flow.byFrame[f.id] ?? []
      const here: FootnotePlacement['notes'] = []
      for (const l of lines) {
        const refs = paragraphs[l.para]?.footnoteRefs ?? []
        for (const r of refs) {
          if (r.offset < l.start || r.offset >= l.end) continue
          const def = byId.get(r.id)
          if (!def || here.some((n) => n.id === r.id)) continue
          here.push({ id: r.id, marker: numbers.get(r.id) ?? '', text: def.text })
        }
      }
      const h = here.length
        ? gap + rule + here.reduce((t, n) => t + noteHeight(`${n.marker} ${n.text}`, f.w, options.style, measure), 0)
        : 0
      next.push({ frameId: f.id, notes: here, height: h })
      if (h > 0) nextReserves[f.id] = h
    }

    const same =
      Object.keys(nextReserves).length === Object.keys(reserves).length &&
      Object.entries(nextReserves).every(([k, v]) => Math.abs((reserves[k] ?? 0) - v) < 0.5)
    placements = next
    reserves = nextReserves
    if (same) {
      unsettled = false
      break
    }
  }

  return { flow, placements, unsettled }
}
