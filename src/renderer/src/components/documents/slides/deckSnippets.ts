import { useEffect, useRef } from 'react'
import type { Slide, SlideElement } from '@shared/types'
import type { Snippet, SnippetTarget, SlideSnippetBody } from '@shared/snippets'
import {
  buildElementClipboard,
  elementsPlainText,
  ELEMENT_CLIP_KIND,
  ELEMENT_CLIP_VERSION,
  parseElementClipboard,
  pasteElements
} from '@shared/elementClipboard'
import { registerSnippetTarget } from '../../../stores/snippets'
import { insertIntoOffice, officeAccepts } from '../../../lib/officeSnippets'

// PlexiiDeck as a snippet surface: how selected slide elements become a saved
// snippet, and how a saved one gets back onto a slide.
//
// A snippet behaves exactly like copy and paste, because it IS copy and paste
// with a name: capture runs the clipboard's own builder (z-sorted deep copy)
// and insertion runs the clipboard's own paste engine (fresh ids deeply,
// groups remapped so the copy never joins the original's group, z above
// everything on the slide, clamped onto the page). Linked data travels the
// way a paste carries it: a chart keeps its sheet `source` so Refresh still
// works, an image keeps its `src`, a work-widget embed keeps its `widgetId`
// and stays a live embed of that widget.
//
// DUPLICATE ONLY, on purpose. See "Why a deck offers Duplicate only" in
// docs/saved-snippets.md. In short: a deck has no element that renders other
// elements, so a live slide snippet would need a second, parallel element tree
// through the canvas, thumbnails, presenting, Morph, and both exporters; and
// snippets do not sync yet (ORG_SNIPPETS_SYNC), while decks are co-edited and
// presented from other machines, where every live instance would render as
// missing. Offering Live would be a promise the deck cannot keep.

/** The page a deck is laid out on when its body names no size. */
export const DECK_PAGE = { w: 1280, h: 720 }

/**
 * Turn the selected elements on a slide into a slide snippet body.
 *
 * Pure. Returns null when nothing is selected (or the ids match nothing on
 * this slide), rather than an empty body: the caller must tell "nothing to
 * save" from "saved something empty".
 *
 * Positions are made relative to the selection's top-left, as the snippet
 * contract requires: where the block sat on this slide is not part of what
 * makes it reusable, and the destination decides where it lands. Relative
 * z order is kept (0..n-1), and so are group ids, which a paste remaps.
 */
export function slideBodyFromSelection(slide: Slide | null | undefined, selectedIds: readonly string[]): SlideSnippetBody | null {
  if (!slide || selectedIds.length === 0) return null
  const ids = new Set(selectedIds)
  const picked = (slide.elements ?? []).filter((e) => ids.has(e.id))
  if (picked.length === 0) return null
  // The clipboard's builder: sorted by z, deep-cloned, so nothing in the body
  // shares an object with the live deck.
  const { elements } = buildElementClipboard(picked, DECK_PAGE)
  const minX = Math.min(...elements.map((e) => e.x))
  const minY = Math.min(...elements.map((e) => e.y))
  const out = elements.map((e, i) => translate({ ...e, z: i }, -minX, -minY))
  return { kind: 'slide', elements: out }
}

/** A default name for the save dialog: the first words in the block, or what it holds. */
export function suggestedSlideSnippetName(body: SlideSnippetBody): string {
  const els = body.elements as SlideElement[]
  const first = elementsPlainText(els)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (first) {
    const cut = first.length > 60 ? first.slice(0, 57).replace(/\s+\S*$/, '') : first
    return cut.replace(/[:.,;\s]+$/, '')
  }
  if (els.length === 1) return TYPE_NAME[els[0]?.type ?? ''] ?? 'Slide element'
  return `${els.length} slide elements`
}

const TYPE_NAME: Record<string, string> = {
  text: 'Text box',
  shape: 'Shape',
  line: 'Line',
  image: 'Image',
  table: 'Table',
  chart: 'Chart',
  widget: 'Work widget embed'
}

export interface SlideSnippetPlacement {
  /** The page being inserted onto. */
  canvas: { w: number; h: number }
  /** Highest z currently on the slide, so the block lands on top. */
  topZ: number
  /** Mints an element id the way the editor does. */
  newId: () => string
  /** The deck cannot be edited right now (presenting, read-only). */
  readOnly: boolean
}

/**
 * The elements a slide snippet inserts as, or null when the deck declines.
 *
 * Pure, and never mutates the snippet: the body is untrusted (it has been
 * through the database, which another version of the app may have written),
 * so it goes through the clipboard's own validating parser, which clones it
 * and drops anything that cannot be drawn. Then the block is centred on the
 * page and handed to the paste engine with no nudge, which mints fresh ids,
 * remaps groups, stacks it above the slide and clamps it onto the page.
 *
 * Declines (null) when the deck is read-only, the snippet is not a slide
 * snippet, or nothing in it is drawable.
 */
export function slideElementsFromSnippet(snippet: Snippet, at: SlideSnippetPlacement): SlideElement[] | null {
  if (at.readOnly) return null
  if (snippet.kind !== 'slide' || snippet.body.kind !== 'slide') return null
  const clip = parseElementClipboard(
    JSON.stringify({ kind: ELEMENT_CLIP_KIND, version: ELEMENT_CLIP_VERSION, source: at.canvas, elements: snippet.body.elements })
  )
  if (!clip) return null
  const minX = Math.min(...clip.elements.map((e) => e.x))
  const minY = Math.min(...clip.elements.map((e) => e.y))
  const w = Math.max(...clip.elements.map((e) => e.x + e.w)) - minX
  const h = Math.max(...clip.elements.map((e) => e.y + e.h)) - minY
  // Centred: the body carries no position of its own, so the destination
  // decides, and the middle of the slide is where a person is looking.
  const dx = Math.round((at.canvas.w - w) / 2) - minX
  const dy = Math.round((at.canvas.h - h) / 2) - minY
  const centred = { ...clip, elements: clip.elements.map((e) => translate(e, dx, dy)) }
  const pasted = pasteElements(centred, { canvas: at.canvas, topZ: at.topZ, newId: at.newId, offset: 0 })
  // The paste engine moves x/y only. A line's stored end point travels with
  // it here, so the element stays self-consistent whatever reads it next.
  return pasted.map((e, i) => {
    const src = centred.elements[i]
    return src ? translateLineEnd(e, e.x - src.x, e.y - src.y) : e
  })
}

/**
 * Register a mounted deck as a place slide snippets can go.
 *
 * `instanceId` is the MOUNTED SURFACE (the editor's React `useId`), not the
 * document: two decks open side by side, or the same deck in a desk widget and
 * in the editor, are separate destinations, and a closed deck is none.
 *
 * `insert` changes every render (it closes over the current slide), so it is
 * read through a ref that is updated each render rather than re-registering on
 * every keystroke. The registry therefore never calls a stale closure: it calls
 * the ref, and the ref is always this render's function.
 */
export function useDeckSnippetTarget(instanceId: string, title: string, insert: (snippet: Snippet) => boolean): void {
  const ref = useRef(insert)
  ref.current = insert
  useEffect(() => registerSnippetTarget(deckSnippetTarget(instanceId, title, (s) => ref.current(s))), [instanceId, title])
}

/**
 * The target a mounted deck registers. Pure, so its contract is unit-testable.
 * Every kind with a conversion into slide elements is accepted (a sheet block
 * as Deck's table, a document as a text box, art as a picture), converted and
 * then inserted through the same paste engine as a slide snippet.
 */
export function deckSnippetTarget(instanceId: string, title: string, insert: (snippet: Snippet) => boolean): SnippetTarget {
  return {
    id: deckSnippetTargetId(instanceId),
    label: title?.trim() ? `“${title.trim()}”` : 'This deck',
    accepts: officeAccepts('slide'),
    host: 'slide',
    supports: DECK_SNIPPET_LINKS,
    insert: (snippet, link) => insertIntoOffice(snippet, link, 'slide', (s, l) => (l === 'duplicate' ? insert(s) : false))
  }
}

/** The link modes a deck honours. Exported so the unit test asserts the real list. */
export const DECK_SNIPPET_LINKS: SnippetTarget['supports'] = ['duplicate']

/** The registry id for a deck surface. One place, so host and picker agree. */
export function deckSnippetTargetId(instanceId: string): string {
  return `slides:${instanceId}`
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Move an element (and a line's far end) by dx, dy. */
export function translate(e: SlideElement, dx: number, dy: number): SlideElement {
  return translateLineEnd({ ...e, x: e.x + dx, y: e.y + dy } as SlideElement, dx, dy)
}

function translateLineEnd(e: SlideElement, dx: number, dy: number): SlideElement {
  if (e.type !== 'line' || (dx === 0 && dy === 0)) return e
  const l = e as SlideElement & { x2?: number; y2?: number }
  return {
    ...l,
    ...(Number.isFinite(l.x2) ? { x2: (l.x2 as number) + dx } : {}),
    ...(Number.isFinite(l.y2) ? { y2: (l.y2 as number) + dy } : {})
  } as SlideElement
}
