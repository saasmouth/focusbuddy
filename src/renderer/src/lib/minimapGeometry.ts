// The minimap's camera maths, kept pure so they can be tested without a DOM.
//
// Both bugs this module exists to prevent were failures at the EDGE of the
// mapped area, which is exactly where a minimap earns its keep — the moment you
// pan off the desk is the moment you need to be told where you are.
//
//   - The mapped box was the content extent alone, so panning past it put the
//     camera outside the map with nothing to represent it.
//   - The indicator was clamped by its origin while keeping its full width. Off
//     to the left that drew a full-width rectangle pinned to the panel edge,
//     claiming a viewport that was not there; off to the right it computed a
//     negative width, which is an invalid <rect> that browsers decline to draw,
//     so the indicator silently vanished.

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface MinimapCamera {
  panX: number
  panY: number
  zoom: number
  /** Canvas surface size in screen px. */
  viewportWidth: number
  viewportHeight: number
}

export interface Panel {
  width: number
  height: number
  padding: number
}

/** The camera's own rectangle in world units. */
export function cameraBox(cam: MinimapCamera): Box {
  const w = cam.viewportWidth / cam.zoom
  const h = cam.viewportHeight / cam.zoom
  const x = -cam.panX / cam.zoom
  const y = -cam.panY / cam.zoom
  return { minX: x, minY: y, maxX: x + w, maxY: y + h }
}

/**
 * The world region the panel maps: the content with half a viewport of air
 * around it, unioned with wherever the camera actually is.
 *
 * The padding is what keeps the map still. While the camera is over the desk
 * the union contributes nothing, so the scale does not change and the objects
 * do not slide about under the cursor as you pan. Only once the camera leaves
 * that padded region does the box grow — and then it must, because the
 * alternative is an indicator with nowhere to be drawn.
 */
export function mappedBox(content: Box | null, cam: MinimapCamera): Box | null {
  if (!content) return null
  const vw = cam.viewportWidth / cam.zoom
  const vh = cam.viewportHeight / cam.zoom
  const view = cameraBox(cam)
  return {
    minX: Math.min(content.minX - vw / 2, view.minX),
    minY: Math.min(content.minY - vh / 2, view.minY),
    maxX: Math.max(content.maxX + vw / 2, view.maxX),
    maxY: Math.max(content.maxY + vh / 2, view.maxY)
  }
}

/** Uniform scale that fits `box` inside the padded panel. */
export function mappedScale(box: Box | null, panel: Panel): number {
  if (!box) return 1
  const sx = (panel.width - 2 * panel.padding) / Math.max(1, box.maxX - box.minX)
  const sy = (panel.height - 2 * panel.padding) / Math.max(1, box.maxY - box.minY)
  return Math.min(sx, sy)
}

export interface PanelRect {
  x: number
  y: number
  w: number
  h: number
}

/** Project a world box into panel coordinates. */
export function project(box: Box, mapped: Box, scale: number, panel: Panel): PanelRect {
  return {
    x: panel.padding + (box.minX - mapped.minX) * scale,
    y: panel.padding + (box.minY - mapped.minY) * scale,
    w: (box.maxX - box.minX) * scale,
    h: (box.maxY - box.minY) * scale
  }
}

/**
 * The viewport indicator, intersected with the panel.
 *
 * Returns null when the intersection is empty, which callers must render as
 * nothing — never as a rectangle with a non-positive dimension.
 */
export function viewportIndicator(
  mapped: Box | null,
  cam: MinimapCamera,
  scale: number,
  panel: Panel
): PanelRect | null {
  if (!mapped) return null
  const r = project(cameraBox(cam), mapped, scale, panel)
  const x0 = Math.max(0, r.x)
  const y0 = Math.max(0, r.y)
  const w = Math.min(panel.width, r.x + r.w) - x0
  const h = Math.min(panel.height, r.y + r.h) - y0
  if (w <= 0 || h <= 0) return null
  return { x: x0, y: y0, w, h }
}
