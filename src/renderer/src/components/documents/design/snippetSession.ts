// Editing a design SNIPPET in PlexiiDesign, with no document anywhere.
//
// "Open original" on a converted snippet opens it in the app that owns its
// kind, as a real editor, and Save writes back to the snippet master so every
// live instance everywhere follows. Nothing is persisted but the snippet:
// there is no document row, no id, nothing in the DB.
//
// DesignEditor already supports that: it takes its content by props with no
// id and no document read, and with no documentOps (a snippet session has no
// document) its File menu offers no document items. But it edits a
// DesignBody, and a snippet is { kind, elements, stories?, swatches? } with
// no size and no pages. These two functions are the join: a body in memory
// for the length of the session, and the snippet back out when Save runs.
// SnippetDesignSession (components/snippets) holds the body in state between.
//
// THE WRAPPER IS NEVER PERSISTED. That is what keeps this from being "a
// document the user did not ask for": the test is whether Save writes the
// wrapper or the snippet, and unwrap() is what makes it the snippet.
//
// SWATCHES. A fill can name a swatch, and on INSERT those names are resolved
// against the destination document's palette. In a session there is no
// destination — the snippet is the subject — so the snippet's own carried
// swatches become the palette. Every fill.swatchId then resolves against the
// palette it was saved with: nothing dangling, nothing invented, and the
// invariant designSwatches keeps (a fill's cached colour agrees with the
// swatch it names) holds because the swatch it names is present.

import { normalizeDesignBody, type DesignBody } from '@shared/design'
import type { DesignSnippetBody } from '@shared/snippets'
import type { SlideElement } from '@shared/types'

/** Room around the art, so a snippet does not open with its edges on the page edge. */
const MARGIN = 48
/** A page for a snippet whose elements are all at the origin, or that has none. */
const FALLBACK = { w: 800, h: 600 }

export interface WrapOptions {
  /** A page at least this big, so a tiny snippet does not open as a stamp. */
  minWidth?: number
  minHeight?: number
}

/**
 * The snippet as a document to edit.
 *
 * The page is sized to the art plus a margin rather than to any preset: the
 * snippet has no size of its own, and a letter page around a logo would make
 * the thing being edited a speck in the middle of it.
 */
export function wrapDesignSnippet(body: DesignSnippetBody, opts: WrapOptions = {}): DesignBody {
  const elements = (Array.isArray(body.elements) ? body.elements : []) as SlideElement[]
  let right = 0
  let bottom = 0
  for (const el of elements) {
    const x = Number.isFinite(el?.x) ? el.x : 0
    const y = Number.isFinite(el?.y) ? el.y : 0
    const w = Number.isFinite(el?.w) ? el.w : 0
    const h = Number.isFinite(el?.h) ? el.h : 0
    right = Math.max(right, x + w)
    bottom = Math.max(bottom, y + h)
  }
  const width = Math.max(opts.minWidth ?? 320, Math.round(right ? right + MARGIN : FALLBACK.w))
  const height = Math.max(opts.minHeight ?? 240, Math.round(bottom ? bottom + MARGIN : FALLBACK.h))
  // normalizeDesignBody materialises the single page and mirrors it, and
  // carries stories, swatches and the rest through (it used to drop
  // swatches, which would have lost the palette on the first render — see
  // "stop the normaliser deleting the user's palette", 4.3.41).
  return normalizeDesignBody({
    width,
    height,
    elements,
    ...(body.stories ? { stories: body.stories } : {}),
    ...(body.swatches ? { swatches: body.swatches } : {})
  })
}

/**
 * The snippet back out of the edited document.
 *
 * Only what a snippet carries: the elements of the one page, the stories the
 * threaded frames among them read, and the palette. Page size, guides,
 * margins, masters and the rest of a document's furniture belong to the
 * wrapper and are deliberately dropped — a snippet that quietly grew a
 * margins box would change how it inserts everywhere it is used.
 */
export function unwrapDesignSnippet(doc: DesignBody): DesignSnippetBody {
  // The PAGE is canonical and doc.elements mirrors it (syncActivePage keeps
  // them the same array), so the page wins if a caller ever hands over a
  // document where the two disagree. Preferring the mirror would mean saving
  // a stale copy of the work over the real one.
  const page = doc.pages?.[doc.activePage ?? 0]
  const elements = (page?.elements ?? doc.elements ?? []) as SlideElement[]
  // Only the stories the surviving frames actually read: a story whose frames
  // were deleted during the session would otherwise ride along forever.
  const used = new Set(
    elements
      .map((el) => (el as { storyId?: unknown }).storyId)
      .filter((id): id is string => typeof id === 'string' && id !== '')
  )
  const stories: Record<string, unknown> = {}
  for (const [id, story] of Object.entries(doc.stories ?? {})) if (used.has(id)) stories[id] = story
  // Likewise the swatches the fills name, plus any the person left locked
  // (a brand colour they did not use this time is still part of the set).
  const named = new Set(
    elements
      .map((el) => (el as { fill?: { swatchId?: unknown } }).fill?.swatchId)
      .filter((id): id is string => typeof id === 'string' && id !== '')
  )
  const swatches = (doc.swatches ?? []).filter((s) => named.has(s.id) || s.locked === true)
  return {
    kind: 'design',
    elements,
    ...(Object.keys(stories).length ? { stories } : {}),
    ...(swatches.length ? { swatches } : {})
  }
}
