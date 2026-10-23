// Find and replace over a design's text, for the shared RecordFindReplace panel.
//
// Design is the awkward one of the office apps, which is why it was the last
// exception (SPEC §9.6). Its text lives in two different places:
//
//   - THREADED STORIES. A story is a ContentDoc of typed blocks held ONCE in
//     DesignBody.stories, and the frames that show it each render a slice the
//     flow engine works out. The text is not in the frames at all, so searching
//     the frames would find nothing and replacing in them would be writing to a
//     cache.
//   - UNTHREADED FRAMES. An ordinary text element with its own paragraphs and
//     formatted runs, like Deck's text boxes.
//
// So records come from both, and a replacement goes back to whichever holds the
// text. Pure on purpose — no React, no editor state — so every rule here is
// testable by calling it, which is also what keeps DesignEditor's share of this
// down to state and wiring.

import {
  storyFrames,
  withPages,
  type DesignBody,
  type DesignPage
} from '@shared/design'
import { paragraphsForStory } from '@shared/designStories'
import type { ContentBlock } from '@shared/designContent'
import type { SlideElement, SlideTextElement } from '@shared/types'
import { replaceInRuns, type FindRecord, type RecordHit } from '../../../lib/recordFind'

/**
 * A record's key, and what it addresses.
 *
 *   s|<storyId>|<block>          a story block's own text
 *   s|<storyId>|<block>|<item>   one item of a list block
 *   f|<pageIndex>|<elementId>|<para>   a paragraph of an unthreaded frame
 *
 * Stories are keyed by their BLOCK rather than by the laid-out paragraph,
 * because the block is what the author edits and what a replacement must be
 * written back to. The laid-out paragraphs are used only to decide which frame
 * to show a hit in.
 */
const STORY = 's'
const FRAME = 'f'

/** The text a block carries, or null for a block that holds none (a divider). */
function blockOwnText(b: ContentBlock): string | null {
  switch (b.kind) {
    case 'title':
    case 'subtitle':
    case 'heading':
    case 'paragraph':
    case 'quote':
    case 'footnote':
      return b.text
    default:
      return null
  }
}

/** The same text, written back. Returns the block unchanged if it holds none. */
function withBlockText(b: ContentBlock, text: string): ContentBlock {
  switch (b.kind) {
    case 'title':
    case 'subtitle':
    case 'heading':
    case 'paragraph':
    case 'quote':
    case 'footnote':
      return { ...b, text }
    default:
      return b
  }
}

/** Every searchable piece of text in the design, in reading order. */
export function designFindRecords(design: DesignBody): FindRecord[] {
  const out: FindRecord[] = []
  const base = withPages(design)
  const pages = base.pages ?? []

  // Stories first, in story-id order, so the chain reads as one piece of
  // writing rather than jumping between the frames that happen to show it.
  for (const [storyId, doc] of Object.entries(base.stories ?? {})) {
    doc.blocks.forEach((b, bi) => {
      const own = blockOwnText(b)
      if (own !== null) {
        out.push({ key: `${STORY}|${storyId}|${bi}`, text: own })
        return
      }
      // A list's items are separate records: each is its own paragraph on the
      // page, and replacing in one must not disturb the others.
      if (b.kind === 'list') b.items.forEach((item, ii) => out.push({ key: `${STORY}|${storyId}|${bi}|${ii}`, text: item }))
    })
  }

  // Then the frames that carry their own text. A frame with a storyId is a
  // VIEW of a story: its paragraphs are the flow engine's output, so including
  // them would both double every hit and offer a replacement that the next
  // re-flow would discard.
  pages.forEach((pg, pageIndex) => {
    for (const el of pg.elements) {
      if (el.type !== 'text' || el.storyId) continue
      el.paragraphs.forEach((p, pi) =>
        out.push({ key: `${FRAME}|${pageIndex}|${el.id}|${pi}`, text: p.runs.map((r) => r.text).join('') })
      )
    }
  })
  return out
}

/** Where a hit should be shown: the page to switch to and the frame to select. */
export interface HitTarget {
  pageIndex: number
  elementId: string
}

/**
 * The frame a hit belongs to.
 *
 * For an unthreaded frame the key says it outright. For a story it does not:
 * the text is in the story, and which frame shows it depends on the layout. So
 * the chain's frames are walked in thread order, counting the paragraphs each
 * one laid out (`lastOfPara` marks a paragraph's final line), and the hit's
 * paragraph is matched by the flow engine's own `source` mapping rather than
 * by comparing text — which duplicate paragraphs would make ambiguous.
 *
 * APPROXIMATE IN ONE STATED WAY: a paragraph that SPILLS across a frame
 * boundary is attributed to the frame it STARTS in. A match in the spilled
 * remainder therefore selects the earlier frame — where the reader's eye picks
 * that paragraph up — rather than the one the matched characters land in.
 * Attributing it exactly would mean trusting that the laid-out line texts
 * re-concatenate to the paragraph character for character, which hyphenation
 * and trimmed line breaks make untrue. Approved as the boundary (9d, E-14
 * follow-up); covered by a test so it stays a decision rather than a drift.
 */
export function frameForRecord(design: DesignBody, key: string): HitTarget | null {
  const parts = key.split('|')
  const base = withPages(design)
  const pages = base.pages ?? []

  if (parts[0] === FRAME) {
    const pageIndex = Number(parts[1])
    const elementId = parts[2] ?? ''
    return pages[pageIndex]?.elements.some((e) => e.id === elementId) ? { pageIndex, elementId } : null
  }
  if (parts[0] !== STORY) return null

  const storyId = parts[1] ?? ''
  const block = Number(parts[2])
  const item = parts[3] === undefined ? undefined : Number(parts[3])
  const chain = storyFrames(base, storyId)
  if (!chain.length) return null

  // Which laid-out paragraph this block is, by the flow's own source map.
  const flow = paragraphsForStory(base, storyId)
  const ordinal = flow.findIndex((p) => p.source?.block === block && p.source?.item === item)
  // A block the flow did not lay out (an empty story, or one never flowed)
  // still has a sensible home: the first frame of its chain.
  if (ordinal < 0) return { pageIndex: chain[0]!.pageIndex, elementId: chain[0]!.element.id }

  let seen = 0
  for (const link of chain) {
    const ends = (link.element.flowLines ?? []).filter((l) => l.lastOfPara).length
    // `seen` is how many paragraphs ENDED before this frame, so a paragraph
    // that starts here has an ordinal below the running total.
    if (ordinal < seen + Math.max(ends, 1)) return { pageIndex: link.pageIndex, elementId: link.element.id }
    seen += ends
  }
  // Past the end of what was laid out (overset text): the last frame holds it.
  const last = chain[chain.length - 1]!
  return { pageIndex: last.pageIndex, elementId: last.element.id }
}

/** One frame's paragraphs with the given hits replaced, keeping run formatting. */
function replaceInFrame(el: SlideTextElement, perPara: Map<number, RecordHit[]>, replacement: string): SlideTextElement {
  return {
    ...el,
    paragraphs: el.paragraphs.map((p, pi) => {
      const hits = perPara.get(pi)
      return hits ? { ...p, runs: replaceInRuns(p.runs, hits, replacement) } : p
    })
  }
}

/**
 * The whole design with every hit replaced — ONE new body, for ONE undo entry.
 *
 * The caller commits this once. Replace-all across twenty frames must not be
 * twenty steps on the undo stack, which is the behaviour Deck and Cells have
 * and the reason this returns a body rather than applying anything itself.
 *
 * THE ACTIVE PAGE IS WRITTEN TWICE, deliberately. A design body stores the
 * active page's elements both at the top level and in `pages[active]`, and the
 * editor's syncActivePage mirrors the top level over the page on every commit.
 * Updating only the page array would therefore be silently undone at the moment
 * of saving — the trap already documented in designSwatches.ts.
 */
export function applyDesignReplacements(
  design: DesignBody,
  hits: RecordHit[],
  replacement: string
): DesignBody {
  if (!hits.length) return design
  const base = withPages(design)
  const active = base.activePage ?? 0

  // Group the hits by what they address.
  const storyHits = new Map<string, RecordHit[]>()
  const frameHits = new Map<string, Map<number, RecordHit[]>>()
  for (const h of hits) {
    const parts = h.key.split('|')
    if (parts[0] === STORY) storyHits.set(h.key, [...(storyHits.get(h.key) ?? []), h])
    else if (parts[0] === FRAME) {
      const elKey = `${parts[1]}|${parts[2]}`
      const perPara = frameHits.get(elKey) ?? new Map<number, RecordHit[]>()
      const pi = Number(parts[3])
      perPara.set(pi, [...(perPara.get(pi) ?? []), h])
      frameHits.set(elKey, perPara)
    }
  }

  // Stories.
  const stories = { ...(base.stories ?? {}) }
  for (const [key, hs] of storyHits) {
    const [, storyId, blockStr, itemStr] = key.split('|')
    const doc = stories[storyId!]
    if (!doc) continue
    const bi = Number(blockStr)
    const blocks = doc.blocks.map((b, i) => {
      if (i !== bi) return b
      if (itemStr === undefined) {
        const own = blockOwnText(b)
        return own === null ? b : withBlockText(b, spliceAll(own, hs, replacement))
      }
      if (b.kind !== 'list') return b
      const ii = Number(itemStr)
      return { ...b, items: b.items.map((it, j) => (j === ii ? spliceAll(it, hs, replacement) : it)) }
    })
    stories[storyId!] = { ...doc, blocks }
  }

  // Frames, page by page.
  const nextPage = (pg: DesignPage, pageIndex: number): DesignPage => {
    let touched = false
    const elements: SlideElement[] = pg.elements.map((el) => {
      if (el.type !== 'text' || el.storyId) return el
      const perPara = frameHits.get(`${pageIndex}|${el.id}`)
      if (!perPara) return el
      touched = true
      return replaceInFrame(el, perPara, replacement)
    })
    return touched ? { ...pg, elements } : pg
  }
  const pages = (base.pages ?? []).map(nextPage)

  return {
    ...base,
    stories,
    pages,
    // The top-level mirror of the active page. Without this the active page's
    // replacements are discarded by syncActivePage on commit.
    elements: pages[active]?.elements ?? base.elements
  }
}

/** Apply every hit in one string, right to left so earlier offsets stay valid. */
function spliceAll(text: string, hits: RecordHit[], replacement: string): string {
  let out = text
  for (const h of [...hits].sort((a, b) => b.start - a.start)) out = out.slice(0, h.start) + replacement + out.slice(h.end)
  return out
}
