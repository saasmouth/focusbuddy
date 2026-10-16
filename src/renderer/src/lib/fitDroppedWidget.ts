// How big a thing dropped on a desk is allowed to be.
//
// "Apps when dragged to the desk should be no larger than 3/4 of the view
// width and 3/4 of the view height."
//
// The browser widget opens at 1920×1080 on purpose — sites lay out for that
// width, so a page renders the way it was designed rather than in a narrowed
// column, and the catalogue's note says the canvas zoom is what makes a widget
// that size comfortable. That reasoning holds for a widget you deliberately
// resize to. It does not hold for a drop: on a laptop the thing you just
// dragged lands bigger than the window, so the first thing you have to do is
// zoom out or resize it before you can see what you dropped.
//
// MEASURED IN CANVAS UNITS AGAINST THE CURRENT ZOOM, which is the part worth
// getting right. "Three quarters of the view" is a statement about what the
// user sees, not about canvas coordinates. At 50% zoom the visible canvas is
// twice as wide in canvas units, so a widget may be twice as wide and still
// fill three quarters of the screen. Capping in raw canvas units instead would
// make a drop shrink as you zoom out, which is backwards.
//
// SCALED, NOT CLAMPED PER SIDE. Clamping width and height independently turns
// a 16:9 browser into whatever shape the window happens to be. Both axes are
// scaled by the same factor, so a dropped app keeps its proportions and simply
// arrives smaller.

/** The fraction of the visible canvas a dropped widget may occupy. */
export const DROP_VIEW_FRACTION = 0.75

/**
 * Never shrink below this, even in a very small window.
 *
 * A widget scaled to fit a short window can end up too small to show anything,
 * which is a worse outcome than one slightly larger than the cap — you can
 * drag a too-big widget, but a 60px browser shows nothing at all.
 */
export const MIN_DROP_WIDTH = 240
export const MIN_DROP_HEIGHT = 160

export interface Size {
  width: number
  height: number
}

/**
 * Shrink a widget's default size to fit the visible canvas, keeping its shape.
 *
 * `viewWidth`/`viewHeight` are the canvas viewport in SCREEN pixels (what
 * getBoundingClientRect reports); `zoom` converts them to canvas units.
 * Returns the original size unchanged when it already fits — a small widget is
 * never enlarged, because the cap is a ceiling and not a target.
 */
export function fitDroppedWidget(
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
  zoom: number
): Size {
  // A zero or nonsense viewport (measured before layout, a hidden canvas) must
  // not collapse the widget to nothing. Leave it alone and let the user resize.
  if (!(viewWidth > 0) || !(viewHeight > 0) || !(zoom > 0)) {
    return { width, height }
  }
  if (!(width > 0) || !(height > 0)) return { width, height }

  const maxWidth = (viewWidth / zoom) * DROP_VIEW_FRACTION
  const maxHeight = (viewHeight / zoom) * DROP_VIEW_FRACTION

  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  if (scale >= 1) return { width, height }

  return {
    width: Math.max(MIN_DROP_WIDTH, Math.round(width * scale)),
    height: Math.max(MIN_DROP_HEIGHT, Math.round(height * scale))
  }
}
