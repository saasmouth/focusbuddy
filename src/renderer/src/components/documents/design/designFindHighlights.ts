// Showing a find hit IN the text, not just selecting the frame it is in.
//
// 9d caught this from a screenshot: Design selected the right frame but left
// the reader to spot the word themselves, while every other app's Find marks
// the hit. The marks are a DECORATION — worked out at render time from the
// query and thrown away — so finding never writes to the document, which is
// the same rule the comment anchors follow and the reason a read-only design
// can still be searched.
//
// WHY MATCH THE RENDERED TEXT rather than map the hits' offsets onto it. A
// hit's offsets are into a STORY BLOCK; the text on the page is the flow
// engine's lines, which are a different cut of the same words. Mapping between
// them means trusting that line texts re-concatenate to the block character for
// character, and hyphenation and trimmed line breaks make that untrue — the
// same reason frame attribution in designFind.ts is approximate. Running the
// SAME matcher over the rendered text needs no mapping and cannot drift.
//
// WHICH ONE IS CURRENT does need the hit, because "the third match" only means
// something in document order. A rendered unit is attributed to its record —
// exactly for an unthreaded frame, and through the flow engine's own paragraph
// source map for a story — and the hit's index among the matches of that record
// picks the occurrence to emphasise.
//
// STATED LIMIT: a match broken ACROSS a line break renders as two partial
// marks, and is not counted as one occurrence for the current-hit index. The
// flow engine breaks on word boundaries, so this needs a match that spans a
// space; it is marked, just not emphasised. Noted here rather than hidden
// because the alternative is pretending the two cuts of the text agree.

import { findMatches, type FindOptions } from '../../../lib/docFind'
import type { RecordHit } from '../../../lib/recordFind'
import { storyFrames, type DesignBody } from '@shared/design'
import { paragraphsForStory } from '@shared/designStories'
import type { SlideTextElement } from '@shared/types'

export interface Mark {
  start: number
  end: number
  /** The hit the panel is showing now, drawn more strongly than the rest. */
  current: boolean
}

/**
 * Marks for one text element, keyed by the index of the thing that renders it:
 * a flow line for a threaded frame, a paragraph for an unthreaded one.
 */
export type ElementMarks = Map<number, Mark[]>

/** The record a hit addresses, and which match of that record it is. */
function currentWithin(records: string[], hit: RecordHit | null, query: string, opts: FindOptions): number | null {
  if (!hit) return null
  const text = records[0]
  if (text === undefined) return null
  // How many matches of this record start before the current one.
  return findMatches(text, query, opts).findIndex((m) => m.start === hit.start)
}

/**
 * Where to draw marks in a frame's rendered text.
 *
 * `current` is the hit the panel is on, or null while nothing is stepped to.
 * An empty query means no marks at all, which is what clearing the field does.
 */
export function marksForElement(
  design: DesignBody,
  el: SlideTextElement,
  query: string,
  opts: FindOptions,
  current: RecordHit | null
): ElementMarks {
  const out: ElementMarks = new Map()
  if (!query) return out

  // ── A frame showing a threaded story ──────────────────────────────────────
  if (el.flowLines?.length && el.storyId) {
    const storyId = el.storyId
    // Which paragraph each line belongs to: paragraphs that ENDED in earlier
    // frames of the chain, plus the ones that end above this line.
    const chain = storyFrames(design, storyId)
    let before = 0
    for (const link of chain) {
      if (link.element.id === el.id) break
      before += (link.element.flowLines ?? []).filter((l) => l.lastOfPara).length
    }
    const flow = paragraphsForStory(design, storyId)
    // The current hit's block, and which match of that block it is.
    const curKey = current?.key.split('|') ?? null
    const curBlock = curKey && curKey[0] === 's' && curKey[1] === storyId ? Number(curKey[2]) : null
    const curItem = curKey && curKey[3] !== undefined ? Number(curKey[3]) : undefined
    const curIndex =
      curBlock === null
        ? null
        : currentWithin(
            [
              (() => {
                const b = design.stories?.[storyId]?.blocks[curBlock]
                if (!b) return ''
                if (curItem !== undefined) return b.kind === 'list' ? b.items[curItem] ?? '' : ''
                return (b as { text?: string }).text ?? ''
              })()
            ],
            current,
            query,
            opts
          )

    let para = before
    // Occurrences seen so far in the paragraph being walked, so the index
    // continues across the lines a paragraph is broken into.
    let seenInPara = 0
    let walkingPara = para
    el.flowLines.forEach((ln, i) => {
      if (para !== walkingPara) {
        walkingPara = para
        seenInPara = 0
      }
      const src = flow[para]?.source
      const isCurrentPara = curBlock !== null && src?.block === curBlock && src?.item === curItem
      const ms = findMatches(ln.text, query, opts)
      if (ms.length) {
        out.set(
          i,
          ms.map((m, k) => ({
            start: m.start,
            end: m.end,
            current: isCurrentPara && curIndex !== null && seenInPara + k === curIndex
          }))
        )
      }
      seenInPara += ms.length
      if (ln.lastOfPara) para += 1
    })
    return out
  }

  // ── A frame carrying its own paragraphs ───────────────────────────────────
  const curKey = current?.key.split('|') ?? null
  const curPara = curKey && curKey[0] === 'f' && curKey[2] === el.id ? Number(curKey[3]) : null
  el.paragraphs.forEach((p, pi) => {
    const text = p.runs.map((r) => r.text).join('')
    const ms = findMatches(text, query, opts)
    if (!ms.length) return
    // Exact here: the paragraph IS the record, so the hit's offsets are this
    // text's offsets and the current match is the one that starts where it does.
    out.set(
      pi,
      ms.map((m) => ({ start: m.start, end: m.end, current: curPara === pi && current?.start === m.start }))
    )
  })
  return out
}

/** Split a string into runs, marked or not, for rendering. */
export function splitByMarks(text: string, marks: Mark[] | undefined): Array<{ text: string; mark: Mark | null }> {
  if (!marks?.length) return [{ text, mark: null }]
  const out: Array<{ text: string; mark: Mark | null }> = []
  let at = 0
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    if (m.start > at) out.push({ text: text.slice(at, m.start), mark: null })
    out.push({ text: text.slice(m.start, m.end), mark: m })
    at = m.end
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: null })
  return out
}
