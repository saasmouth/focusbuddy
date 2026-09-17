// Threading PlexiDesign's stories through their frames.
//
// The bridge between the document model (design.ts), the content model
// (designContent.ts) and the pure typesetting engine (designFlow.ts): it gathers
// each story's chain of frames and the obstacles on each frame's own page, turns
// the story's blocks into styled paragraphs, runs the flow, and writes the
// result back onto the frames as their `flowLines` cache plus an `overset` flag
// on the last one.
//
// It is a separate module because design.ts and designFlow.ts must not import
// each other in a cycle, and because keeping it pure means the whole threading
// behaviour is testable without a DOM.

import { storyFrames, storyIds, wrapObstacles, type DesignBody, type DesignPage } from './design'
import { flowStory, type FlowBox, type FlowFrame, type FlowMeasurer, type FlowParagraph } from './designFlow'
import { findLayoutStyle, storyParagraphs, typeScaleFor } from './designAutoLayout'
import { parsePlainText, toPlainText, type ContentDoc } from './designContent'
import { DEFAULT_BRAND_KIT, type OrgBrandKit } from './brandKit'
import type { SlideElement, SlideTextElement } from './types'

/** A wrap obstacle already grown by its own offset, ready for the flow engine. */
function expandedObstacles(page: DesignPage, exclude: string[]): FlowBox[] {
  return wrapObstacles(page, exclude).map((o) => ({
    x: o.x - o.offset,
    y: o.y - o.offset,
    w: o.w + o.offset * 2,
    h: o.h + o.offset * 2
  }))
}

/**
 * The styled paragraphs for one story, built from its blocks through the same
 * type scale the auto-layout engine uses — so text typed into a story afterwards
 * is set exactly like the text the wizard laid out.
 */
export function paragraphsForStory(design: DesignBody, storyId: string, brand: OrgBrandKit = DEFAULT_BRAND_KIT): FlowParagraph[] {
  const doc = design.stories?.[storyId]
  if (!doc || doc.blocks.length === 0) return []
  const style = findLayoutStyle(design.layoutStyleId ?? 'editorial')
  const columns = design.columns?.count ?? 1
  const gutter = design.columns?.gutter ?? 0
  const m = design.margins
  const boxW = m ? design.width - m.left - m.right : design.width
  const colW = (boxW - gutter * (columns - 1)) / Math.max(1, columns)
  // The same type scale the wizard used, so text typed into a story afterwards
  // is set exactly like the text the wizard laid out.
  return storyParagraphs(doc, style, typeScaleFor(style, brand, colW))
}

/**
 * Re-flow every story in the document and return a body whose frames carry the
 * fresh `flowLines`.
 *
 * The returned body is a new object only when something actually changed, so a
 * no-op re-flow (the common case on every render) neither re-renders the canvas
 * nor lands on the undo stack.
 */
export function applyStoryFlows(design: DesignBody, measure: FlowMeasurer, brand: OrgBrandKit = DEFAULT_BRAND_KIT): DesignBody {
  const ids = storyIds(design)
  if (ids.length === 0) return design
  const pages = design.pages ?? []

  // frameId -> what the flow engine produced for it.
  const results = new Map<string, { lines: SlideTextElement['flowLines']; overset: boolean }>()

  for (const storyId of ids) {
    const chain = storyFrames(design, storyId)
    if (chain.length === 0) continue
    const paragraphs = paragraphsForStory(design, storyId, brand)

    // Each frame carries the obstacles of ITS OWN page, minus this story's own
    // frames — a frame never wraps around itself or its siblings.
    const ownIds = chain.map((c) => c.element.id)
    const frames: FlowFrame[] = chain.map((c) => ({
      id: c.element.id,
      x: c.element.x,
      y: c.element.y,
      w: c.element.w,
      h: c.element.h,
      obstacles: pages[c.pageIndex] ? expandedObstacles(pages[c.pageIndex], ownIds) : []
    }))

    const result = flowStory({ paragraphs, frames, measure })
    chain.forEach((c, i) => {
      results.set(c.element.id, {
        lines: result.byFrame[c.element.id] ?? [],
        // Only the LAST frame of a chain can be overset; the others simply
        // handed their remainder on.
        overset: i === chain.length - 1 ? result.overset : false
      })
    })
  }

  let changed = false
  const nextPages = pages.map((pg) => {
    let pageChanged = false
    const elements = pg.elements.map((el) => {
      if (el.type !== 'text' || !el.storyId) return el
      const r = results.get(el.id)
      if (!r) return el
      if (sameLines(el.flowLines, r.lines) && (el.overset ?? false) === r.overset) return el
      pageChanged = true
      return { ...el, flowLines: r.lines, overset: r.overset } as SlideElement
    })
    if (!pageChanged) return pg
    changed = true
    return { ...pg, elements }
  })

  if (!changed) return design
  const activePage = design.activePage ?? 0
  const active = nextPages[activePage]
  return {
    ...design,
    pages: nextPages,
    elements: active ? active.elements : design.elements,
    background: active ? active.background ?? design.background : design.background
  }
}

function sameLines(a: SlideTextElement['flowLines'], b: SlideTextElement['flowLines']): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].x !== b[i].x ||
      a[i].y !== b[i].y ||
      a[i].w !== b[i].w ||
      a[i].text !== b[i].text ||
      a[i].lastOfPara !== b[i].lastOfPara ||
      a[i].size !== b[i].size
    ) {
      return false
    }
  }
  return true
}

// ── Story editing ────────────────────────────────────────────────────────────

/** The story's text as the story editor shows it (markdown-ish, round-trippable). */
export function storyText(design: DesignBody, storyId: string): string {
  const doc = design.stories?.[storyId]
  return doc ? toPlainText(doc) : ''
}

/** Replace a story's content from the story editor's text. */
export function setStoryText(design: DesignBody, storyId: string, text: string): DesignBody {
  const doc = parsePlainText(text, { firstLineIsTitle: false })
  return { ...design, stories: { ...(design.stories ?? {}), [storyId]: doc } }
}

export function setStoryContent(design: DesignBody, storyId: string, doc: ContentDoc): DesignBody {
  return { ...design, stories: { ...(design.stories ?? {}), [storyId]: doc } }
}

// ── Chain editing ────────────────────────────────────────────────────────────

/**
 * Link `targetId` into `sourceId`'s story, immediately after it. When the source
 * has no story yet, a new one is minted from its own paragraph text — so
 * "thread these two frames" works on frames that were typed into normally.
 */
export function linkFrames(design: DesignBody, sourceId: string, targetId: string): DesignBody {
  if (sourceId === targetId) return design
  const pages = design.pages ?? []
  const find = (fid: string): SlideTextElement | undefined => {
    for (const pg of pages) {
      const el = pg.elements.find((e) => e.id === fid)
      if (el && el.type === 'text') return el
    }
    return undefined
  }
  const source = find(sourceId)
  const target = find(targetId)
  if (!source || !target) return design
  // A frame already in another story is not silently stolen.
  if (target.storyId && target.storyId !== source.storyId) return design

  const stories = { ...(design.stories ?? {}) }
  let storyId = source.storyId
  if (!storyId) {
    storyId = `story-${Date.now().toString(36)}`
    const combined = [plainTextOf(source), target.storyId ? '' : plainTextOf(target)].filter((t) => t.trim()).join('\n\n')
    stories[storyId] = parsePlainText(combined, { firstLineIsTitle: false })
  } else if (!target.storyId) {
    // Bringing an already-typed frame into an existing story appends its words
    // rather than throwing them away.
    const existing = toPlainText(stories[storyId] ?? { blocks: [] })
    const extra = plainTextOf(target).trim()
    stories[storyId] = parsePlainText(extra ? `${existing}\n\n${extra}` : existing, { firstLineIsTitle: false })
  }

  const chain = storyFrames({ ...design, stories }, storyId)
  const sourceOrder = chain.find((c) => c.element.id === sourceId)?.element.storyOrder ?? 1

  const nextPages = pages.map((pg) => ({
    ...pg,
    elements: pg.elements.map((el) => {
      if (el.type !== 'text') return el
      if (el.id === sourceId) return { ...el, storyId, storyOrder: sourceOrder, paragraphs: [] }
      if (el.id === targetId) return { ...el, storyId, storyOrder: sourceOrder + 0.5, paragraphs: [] }
      return el
    })
  }))

  // Re-number the chain to clean integers so later inserts have room again.
  return renumber({ ...design, stories, pages: nextPages }, storyId)
}

function plainTextOf(el: SlideTextElement): string {
  return el.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')
}

/** Rewrite a story's frame order to 1, 2, 3… preserving the current sequence. */
export function renumber(design: DesignBody, storyId: string): DesignBody {
  const chain = storyFrames(design, storyId)
  const order = new Map(chain.map((c, i) => [c.element.id, i + 1]))
  const pages = (design.pages ?? []).map((pg) => ({
    ...pg,
    elements: pg.elements.map((el) => (el.type === 'text' && order.has(el.id) ? { ...el, storyOrder: order.get(el.id)! } : el))
  }))
  const activePage = design.activePage ?? 0
  return { ...design, pages, elements: pages[activePage] ? pages[activePage].elements : design.elements }
}

/**
 * Take a frame out of its story. Its share of the text is NOT deleted — it stays
 * in the story and re-flows into the remaining frames, which is what unlinking
 * means in a layout program. The unlinked frame becomes an ordinary empty frame.
 */
export function unlinkFrame(design: DesignBody, frameId: string): DesignBody {
  const pages = (design.pages ?? []).map((pg) => ({
    ...pg,
    elements: pg.elements.map((el) =>
      el.type === 'text' && el.id === frameId
        ? ({ ...el, storyId: undefined, storyOrder: undefined, flowLines: undefined, overset: undefined } as SlideElement)
        : el
    )
  }))
  const activePage = design.activePage ?? 0
  return { ...design, pages, elements: pages[activePage] ? pages[activePage].elements : design.elements }
}

/** Drop a story entirely when its last frame has gone, so no orphan text lingers. */
export function pruneOrphanStories(design: DesignBody): DesignBody {
  if (!design.stories) return design
  const live = new Set(storyIds(design))
  const kept: Record<string, ContentDoc> = {}
  let dropped = false
  for (const [sid, doc] of Object.entries(design.stories)) {
    if (live.has(sid)) kept[sid] = doc
    else dropped = true
  }
  if (!dropped) return design
  return { ...design, stories: kept }
}
