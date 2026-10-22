// PlexiiDraw viewport maths: pure functions, so the zoom and pan behaviour can
// be tested without a DOM.

/** The zoom range the studio allows. */
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 16

export function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
}

/** One ⌘/Ctrl-wheel notch: in for a wheel turned away from you, out for towards. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return clampZoom(zoom * (deltaY < 0 ? 1.1 : 1 / 1.1))
}

/**
 * Where to scroll so the artboard point that was under the pointer before a
 * zoom is under it again after.
 *
 * `docX/docY` is the artboard point that was under the pointer, `stageLeft/Top`
 * is where the artboard's top-left corner sits on screen AFTER the zoom has been
 * laid out, and `zoom` is the new zoom. The point now sits at
 * `stageLeft + docX * zoom`; the scroll moves by however far that is from the
 * pointer. The browser clamps the result to the scrollable range, so when the
 * artboard is smaller than the window (and therefore centred, with nothing to
 * scroll) the anchor holds as closely as the layout allows.
 */
export function scrollToKeepPoint(input: {
  docX: number
  docY: number
  clientX: number
  clientY: number
  stageLeft: number
  stageTop: number
  zoom: number
  scrollLeft: number
  scrollTop: number
}): { scrollLeft: number; scrollTop: number } {
  const nowX = input.stageLeft + input.docX * input.zoom
  const nowY = input.stageTop + input.docY * input.zoom
  return { scrollLeft: input.scrollLeft + (nowX - input.clientX), scrollTop: input.scrollTop + (nowY - input.clientY) }
}

type Rect = { x: number; y: number; w: number; h: number }

const inside = (a: Rect, b: Rect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const btm = Math.min(a.y + a.h, b.y + b.h)
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null
}

/** How far past the visible part the drawn window reaches, as a fraction of the visible size on each side. */
export const RENDER_OVERSCAN = 0.5

/**
 * The part of the pasteboard the canvas actually draws (4.3.41): the visible
 * part of the window, in document units, plus RENDER_OVERSCAN of it on every
 * side, inside the pasteboard. The art's SVG layers and the overlay are sized
 * to this window, never to the whole 227-inch pasteboard, so zooming in on a
 * huge canvas never makes a huge element.
 *
 * The window only moves when the visible part leaves it (or the zoom
 * changes, which changes its size on screen), so scrolling within it
 * re-renders nothing. Before the canvas is laid out (`visible` null) it is
 * the artboards (`fallback`), as the stage always was.
 */
export function renderWindow(input: { visible: Rect | null; current: Rect | null; extent: Rect; fallback: Rect; zoomChanged: boolean }): Rect {
  const { visible, current, extent, fallback, zoomChanged } = input
  if (!visible || !(visible.w > 0) || !(visible.h > 0)) return current ?? intersect(fallback, extent) ?? fallback
  if (current && !zoomChanged && inside(visible, current)) return current
  const ox = visible.w * RENDER_OVERSCAN
  const oy = visible.h * RENDER_OVERSCAN
  const grown = { x: visible.x - ox, y: visible.y - oy, w: visible.w + 2 * ox, h: visible.h + 2 * oy }
  const w = intersect(grown, extent) ?? intersect(fallback, extent) ?? fallback
  // Whole document units, outwards, so the window never cuts a pixel row.
  const x = Math.floor(w.x)
  const y = Math.floor(w.y)
  return { x, y, w: Math.ceil(w.x + w.w) - x, h: Math.ceil(w.y + w.h) - y }
}
