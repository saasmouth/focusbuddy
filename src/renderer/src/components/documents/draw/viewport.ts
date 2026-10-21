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
