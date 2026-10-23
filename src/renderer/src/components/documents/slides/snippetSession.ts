import type { Slide, SlideElement, SlidesBody } from '@shared/types'
import type { SlideSnippetBody } from '@shared/snippets'
import { DECK_PAGE, translate } from './deckSnippets'

// A slide snippet opened in PlexiiDeck (SnippetEditSessionView's registry,
// "Open original"). A SlideSnippetBody is a fragment, one or more slide
// elements, not a deck, and SlidesEditor cannot edit elements without a slide
// around them. So the session wraps the fragment in an IN-MEMORY one-slide deck
// (9d's ruling): the elements sit centred on a blank slide, the editor runs with
// its slide navigator hidden, and unwrapping reads slide one's elements back.
// The deck is never persisted; only the snippet is saved, by the host.
//
// Unwrapping keeps the snippet's own contract, the one capture
// (slideBodyFromSelection) sets: positions relative to the fragment's top-left,
// elements in z order with z renumbered from 0. Ids are kept, so saving an
// unchanged session writes back the same body.

export const SNIPPET_SLIDE_ID = 'snippet-session-slide'

function bounds(els: SlideElement[]): { x: number; y: number; w: number; h: number } {
  if (els.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...els.map((e) => e.x))
  const y = Math.min(...els.map((e) => e.y))
  const r = Math.max(...els.map((e) => e.x + (e.w ?? 0)))
  const b = Math.max(...els.map((e) => e.y + (e.h ?? 0)))
  return { x, y, w: r - x, h: b - y }
}

/** The fragment → a one-slide deck, the fragment centred on the page. */
export function wrapSlideSnippet(body: SlideSnippetBody): SlidesBody {
  const els = body.elements as SlideElement[]
  const box = bounds(els)
  const dx = Math.max(0, Math.round((DECK_PAGE.w - box.w) / 2)) - box.x
  const dy = Math.max(0, Math.round((DECK_PAGE.h - box.h) / 2)) - box.y
  const slide: Slide = {
    id: SNIPPET_SLIDE_ID,
    notes: '',
    layout: 'blank',
    elements: els.map((e) => translate(e, dx, dy)),
    schemaVersion: 2
  }
  return { slides: [slide], size: { ...DECK_PAGE }, schemaVersion: 2 }
}

/** SlidesEditor's deck → the fragment: slide one's elements, at the fragment's top-left. */
export function unwrapSlideSnippet(deck: SlidesBody): SlideSnippetBody {
  const els = [...((deck.slides[0]?.elements ?? []) as SlideElement[])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
  if (els.length === 0) return { kind: 'slide', elements: [] }
  const box = bounds(els)
  return { kind: 'slide', elements: els.map((e, i) => translate({ ...e, z: i }, -box.x, -box.y)) }
}
