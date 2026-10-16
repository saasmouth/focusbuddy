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

// ── The canvas viewport, published once and read everywhere ─────────────────
//
// WHY A MODULE-LEVEL VALUE AND NOT A PROP. The cap has to apply to everything
// that opens a widget — a drag, the palette, a context-menu add, a keyboard
// shortcut, an AI build, a command-bar action. Fifty-three call sites across
// fourteen files read a catalogue default, so threading a viewport through
// them is how you end up with the inconsistency this was meant to remove:
// patch the three you remember and the rest keep opening at 1920x1080.
//
// So Canvas publishes its measured viewport here, and the one place that
// decides a new widget's size reads it. Nothing else changes.

let viewport: { width: number; height: number; zoom: number } | null = null

export function setCanvasViewport(width: number, height: number, zoom: number): void {
  viewport = { width, height, zoom }
}

/**
 * The viewport to fit against.
 *
 * Falls back to the window when the canvas has never been measured — a
 * shortcut or a command-bar action can create a widget while you are on
 * another surface entirely, and "no canvas on screen" must not mean "no cap".
 * The window is bigger than the canvas (which sits inside the sidebar and
 * header), so the fallback is slightly generous rather than wrong.
 */
export function canvasViewport(): { width: number; height: number; zoom: number } {
  if (viewport && viewport.width > 0 && viewport.height > 0) return viewport
  if (typeof window !== 'undefined' && window.innerWidth > 0) {
    return { width: window.innerWidth, height: window.innerHeight, zoom: viewport?.zoom ?? 1 }
  }
  return { width: 0, height: 0, zoom: 1 }
}

/**
 * Fit a new widget's size to the view, but ONLY when that size is the
 * catalogue's untouched default.
 *
 * This is the distinction that makes a single central cap safe. A draft whose
 * size equals the default is "whatever this kind opens at" — nobody chose
 * 1920x1080, it is just what Browser ships with, and it is exactly what
 * should shrink to fit. A draft with any other size came from somewhere
 * deliberate: a duplicate of a widget the user resized, a template saved at a
 * chosen size, a sync from another device. Those are left exactly alone.
 *
 * `x`/`y` are shifted by half the width delta so the widget keeps the centre
 * the caller intended; without it a shrunk widget lands offset from the
 * cursor that dropped it.
 */
export function fitNewWidgetToView<
  T extends { kind: string; width?: number; height?: number; x?: number; y?: number }
>(draft: T, defaultsFor: (kind: string) => { width: number; height: number } | null): T {
  const def = defaultsFor(draft.kind)
  if (!def) return draft
  if (draft.width !== def.width || draft.height !== def.height) return draft

  const view = canvasViewport()
  const fitted = fitDroppedWidget(def.width, def.height, view.width, view.height, view.zoom)
  if (fitted.width === def.width && fitted.height === def.height) return draft

  const dx = Math.round((def.width - fitted.width) / 2)
  return {
    ...draft,
    width: fitted.width,
    height: fitted.height,
    ...(typeof draft.x === 'number' ? { x: draft.x + dx } : {})
  }
}
