import { useEffect, useState, type RefObject } from 'react'

// Keeping a bottom-right overlay off the desk's bottom-right controls.
//
// The desk keeps three controls in that corner — the Plexii pill (the primary
// action), the minimap and the automations button — and they already dodge each
// other: the pill publishes its footprint and the other two read it
// (pillGeometry, AssistantOverlay). What none of them could dodge was something
// arriving ON TOP. The feature-spotlight card docks bottom-right at z-[230],
// over all three, and it is NOT modal: there is no scrim to say the app is
// busy, so a press on the minimap simply did nothing — no panel, no feedback,
// nothing on screen to explain it. That is the same dead click the pill itself
// caused when it grew to 52px, recorded in pillGeometry's own history.
//
// MEASURED, NOT AUTHORED, for the reason pillClearance.ts gives about the
// Diagrams minimap: where this chrome lands depends on the open-item tray
// (which restyles --fb-pill-bottom), on whether the pill is showing at all, on
// whether the minimap panel is open (100px tall, 160 wide, inside the same
// container as its toggle), on the window and on the user's UI scale. Any fixed
// offset written here would be right in one layout and wrong in the next — and
// wrong here means a control nobody can press.
//
// The overlay RISES rather than the controls moving. The controls' positions are
// deliberate (the pill's corner is a 2026-10-09 decision, and the other two are
// placed relative to it); a transient first-run card is the thing that should
// give way, and lifting it clears every control in that corner at once,
// including ones added later.

/** The desk chrome that lives in the bottom-right corner. */
export const CORNER_CHROME_SELECTOR = '[data-testid="assistant-pill"], [data-minimap-fab], [data-automations-fab]'

/** Clear air between the overlay and the chrome, room for the pill's halo too. */
const GAP = 12

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * How far (client px) a bottom-right overlay must rise so its bottom edge
 * clears every piece of corner chrome it overlaps across.
 *
 * `overlay` is where the overlay sits UNLIFTED — its own lifted rect must never
 * be fed back in, or the lift oscillates: less overlap gives a smaller lift,
 * which restores the overlap. pillClearance avoids the same trap by computing
 * the minimap's unlifted edge rather than reading it.
 *
 * 0 when nothing is in the way, which is the common case once the card is gone.
 */
export function liftOverCornerChrome(overlay: Box, chrome: readonly Box[], gap = GAP): number {
  let lift = 0
  for (const c of chrome) {
    // A hidden or unlaid-out element reports an empty rect at 0,0; it is not
    // in anybody's way, and treating it as being at the origin would lift the
    // overlay by the height of the window.
    if (c.right <= c.left || c.bottom <= c.top) continue
    // Beside it, not under it.
    if (c.left >= overlay.right || c.right <= overlay.left) continue
    // Entirely below the overlay's bottom edge: nothing to clear.
    if (c.top >= overlay.bottom) continue
    lift = Math.max(lift, overlay.bottom - c.top + gap)
  }
  return Math.ceil(lift)
}

/**
 * The extra bottom offset (client px) a bottom-right overlay needs to stay off
 * the corner controls, kept current as the tray, the window, the pill and the
 * minimap panel change.
 *
 * `baseBottomPx` is the overlay's own resting offset from the window bottom —
 * passed in rather than measured, for the oscillation reason above.
 */
export function useCornerChromeLift(
  ref: RefObject<HTMLElement | null>,
  baseBottomPx: number,
  enabled: boolean
): number {
  const [lift, setLift] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) {
      setLift(0)
      return
    }
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      // Left and right are unaffected by a vertical lift, so they can be read
      // from the element as it now stands; the bottom edge cannot.
      const overlay: Box = {
        left: r.left,
        right: r.right,
        top: 0,
        bottom: window.innerHeight - baseBottomPx
      }
      const chrome = [...document.querySelectorAll(CORNER_CHROME_SELECTOR)].map((c) => c.getBoundingClientRect())
      setLift(liftOverCornerChrome(overlay, chrome))
    }
    const raf = requestAnimationFrame(measure)
    // The overlay itself, and each piece of chrome: the minimap's container
    // grows when its panel opens (the panel is inside it), which no observer on
    // the overlay alone would see.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const c of document.querySelectorAll(CORNER_CHROME_SELECTOR)) ro.observe(c)
    // The tray moves the pill by restyling the root (--fb-pill-bottom), and the
    // pill publishes its corner vars the same way.
    const mo = new MutationObserver(measure)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    // Chrome mounting or unmounting after we subscribed (the pill hides while
    // the assistant is open, the automations button comes and goes with a desk).
    const tree = new MutationObserver(measure)
    tree.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      tree.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [ref, baseBottomPx, enabled])
  return lift
}
