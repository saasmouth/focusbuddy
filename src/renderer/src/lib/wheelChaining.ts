// Who should a wheel gesture belong to: the widget under the cursor, or the
// canvas behind it?
//
// The canvas used to decide this by position alone — if a widget was active and
// the cursor was inside it, the wheel was the widget's and the canvas did not
// pan. That is right for a widget with a long document in it and wrong for
// everything else, because a widget that cannot scroll simply ate the gesture:
// the desk stopped moving while the pointer was over it, which is the "it
// sticks on some things" people reported after the swipe-to-widget gesture was
// removed. (That gesture was the louder half of the same complaint.)
//
// Browsers already solved this for nested scrollers; it is called scroll
// chaining. A scroller consumes the gesture only while it still has somewhere
// to go in that direction, and hands it to its parent once it hits the end. So
// the rule here is the same: the widget keeps the wheel only if something
// inside it can still scroll the way the gesture is pointing. Otherwise the
// canvas pans, and the desk never feels stuck.
//
// Kept as a pure function over plain descriptors so it can be tested without a
// DOM; `scrollChainFromEvent` below does the element walking.

export interface ScrollBox {
  /** Lowercased tag name. A `webview` is opaque — see collectScrollChain. */
  tag: string
  overflowX: string
  overflowY: string
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  scrollLeft: number
}

const SCROLLS = new Set(['auto', 'scroll', 'overlay'])

/** Does this box scroll on an axis at all (overflow allows it AND it overflows)? */
function scrollsY(b: ScrollBox): boolean {
  return SCROLLS.has(b.overflowY) && b.scrollHeight - b.clientHeight > 1
}
function scrollsX(b: ScrollBox): boolean {
  return SCROLLS.has(b.overflowX) && b.scrollWidth - b.clientWidth > 1
}

/**
 * Can anything in this chain still scroll in the gesture's direction?
 *
 * `chain` runs from the event target outward to (and including) the widget
 * root. Deltas follow the DOM convention: positive deltaY is downward.
 */
export function chainCanAbsorb(chain: ScrollBox[], deltaX: number, deltaY: number): boolean {
  // A gesture with no travel is not a scroll; let the canvas have it rather
  // than treating a stray 0,0 event as the widget's.
  if (deltaX === 0 && deltaY === 0) return false
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX)
  for (const b of chain) {
    // An embedded browser view scrolls its own document in its own process; we
    // cannot measure it, and guessing "not scrollable" would steal every
    // gesture from a page the user is reading.
    if (b.tag === 'webview' || b.tag === 'iframe') return true
    if (vertical && scrollsY(b)) {
      const room = deltaY < 0 ? b.scrollTop : b.scrollHeight - b.clientHeight - b.scrollTop
      if (room > 1) return true
    }
    if (!vertical && scrollsX(b)) {
      const room = deltaX < 0 ? b.scrollLeft : b.scrollWidth - b.clientWidth - b.scrollLeft
      if (room > 1) return true
    }
  }
  return false
}

/**
 * Walk from `target` out to `root` (inclusive) building the chain.
 * Returns an empty chain when target is not inside root.
 */
export function collectScrollChain(
  target: Element | null,
  root: Element | null,
  read: (el: Element) => ScrollBox
): ScrollBox[] {
  if (!target || !root || !root.contains(target)) return []
  const chain: ScrollBox[] = []
  let el: Element | null = target
  while (el) {
    chain.push(read(el))
    if (el === root) break
    el = el.parentElement
  }
  return chain
}

/** The DOM reader for collectScrollChain. */
export function readScrollBox(el: Element): ScrollBox {
  const cs = getComputedStyle(el)
  const h = el as HTMLElement
  return {
    tag: el.tagName.toLowerCase(),
    overflowX: cs.overflowX,
    overflowY: cs.overflowY,
    scrollWidth: h.scrollWidth,
    clientWidth: h.clientWidth,
    scrollHeight: h.scrollHeight,
    clientHeight: h.clientHeight,
    scrollTop: h.scrollTop,
    scrollLeft: h.scrollLeft
  }
}
