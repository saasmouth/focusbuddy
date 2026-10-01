import { effectivePos, isFocusable } from './focusNavOrder'
import type { Widget } from '@shared/types'

// Driving the camera around a desk with the arrow keys and trackpad swipes.
//
// Pure: no store, no DOM, no React. The caller measures the viewport and applies
// the result. That is what makes the awkward parts -- which widget is "to the
// right", and how far to zoom -- testable without a running canvas.
//
// Why this is not focus mode. Focus mode already walks widgets with the arrow
// keys, but it does so by opening each one in a full-screen overlay. That is the
// right thing when you want to work inside one widget and the wrong thing when
// you are looking for something: you cannot see where you are on the desk, and
// leaving means closing the overlay. This moves the CAMERA instead. The desk
// stays the desk; the widget you arrived at is simply in front of you, at a size
// you can use.

/** Canvas zoom bounds. The one definition -- the store imports these. */
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 2

export const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))

export type CameraDir = 'left' | 'right' | 'up' | 'down'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** The viewport, in screen px, as the canvas surface measures it. */
export interface Viewport {
  width: number
  height: number
  /**
   * Screen-x where the usable canvas starts: the dock column covers everything
   * left of it. Every target-pan computation has to add this or the camera
   * centres the widget underneath the dock, which looks like the jump simply
   * went to the wrong place.
   */
  dockInset: number
}

export interface CameraTarget {
  zoom: number
  panX: number
  panY: number
}

/**
 * How much bigger than its designed size navigation may make a widget.
 *
 * A widget's layout is built for its own pixel dimensions, so blowing it up to
 * fill the viewport is both blurry and, more to the point, indistinguishable
 * from focus mode -- which is the thing this feature exists to avoid. A little
 * magnification is still worth it: arriving from a zoomed-out overview at
 * exactly 1.0 can leave a small widget looking lost in the middle of a large
 * screen. Tunable, because it is a matter of taste and screen size.
 */
export const NAV_ZOOM_MAX_DEFAULT = 1.25

/** Breathing room left around the widget you navigate to, in screen px. */
const PAD = 48

/**
 * The widgets the camera will stop at.
 *
 * Deliberately the same set focus mode walks (isFocusable): real, live windows,
 * excluding archived ones, section containers -- scaffolding, not a destination
 * -- and pinned widgets, which are docked to the screen and so are already in
 * front of you wherever the camera goes. Sharing the predicate means the arrow
 * keys, the focus dock and the minimap cannot disagree about what is navigable.
 */
export function navigableWidgets(widgets: Widget[]): Widget[] {
  return widgets.filter(isFocusable)
}

/** A widget's absolute box on the canvas, with section children translated. */
export function widgetBox(w: Widget, byId: Map<string, Widget>): Box {
  const { x, y } = effectivePos(w, byId)
  return { x, y, w: Math.max(1, w.width), h: Math.max(1, w.height) }
}

const centreOf = (b: Box): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/**
 * Weight on sideways distance when choosing the next widget in a direction.
 *
 * There is no angular cone. A cone means a widget can be unreachable from where
 * you are standing, and then an arrow key does nothing for a reason the user
 * cannot see. Instead every widget on the correct side is a candidate and
 * off-axis distance is simply penalised, so a widget straight ahead beats a
 * closer one far off to the side, and nothing is ever stranded.
 */
const PERP_PENALTY = 2

/**
 * The widget the camera should move to when `dir` is pressed from `fromId`.
 *
 * Null when there is nothing on that side. Deliberately no wrapping: at the
 * right-hand edge of the desk, pressing → again should do nothing. Teleporting
 * back to the far left looks identical to the camera losing its place, and the
 * desk's whole value is that position means something.
 */
export function nextInDirection(
  widgets: Widget[],
  fromId: string | null,
  dir: CameraDir
): Widget | null {
  const items = navigableWidgets(widgets)
  if (items.length === 0) return null
  const byId = new Map(widgets.map((w) => [w.id, w]))
  const from = items.find((w) => w.id === fromId)
  if (!from) return null

  const here = centreOf(widgetBox(from, byId))
  const horizontal = dir === 'left' || dir === 'right'
  const sign = dir === 'right' || dir === 'down' ? 1 : -1

  let best: Widget | null = null
  let bestScore = Infinity
  for (const w of items) {
    if (w.id === from.id) continue
    const c = centreOf(widgetBox(w, byId))
    const along = (horizontal ? c.x - here.x : c.y - here.y) * sign
    // Strictly on the correct side. A widget whose centre sits level with this
    // one is not "to the right" of it, however much it overlaps.
    if (along <= 0) continue
    const perp = Math.abs(horizontal ? c.y - here.y : c.x - here.x)
    const score = along + PERP_PENALTY * perp
    // createdAt breaks exact ties so two identically placed widgets resolve the
    // same way on every reload, matching focusNavOrder's convention.
    if (score < bestScore || (score === bestScore && best && w.createdAt < best.createdAt)) {
      best = w
      bestScore = score
    }
  }
  return best
}

/** Nearest navigable widget to a point in canvas space. */
export function nearestToPoint(
  widgets: Widget[],
  point: { x: number; y: number }
): Widget | null {
  const items = navigableWidgets(widgets)
  if (items.length === 0) return null
  const byId = new Map(widgets.map((w) => [w.id, w]))
  let best: Widget | null = null
  let bestD = Infinity
  for (const w of items) {
    const c = centreOf(widgetBox(w, byId))
    const d = (c.x - point.x) ** 2 + (c.y - point.y) ** 2
    if (d < bestD || (d === bestD && best && w.createdAt < best.createdAt)) {
      best = w
      bestD = d
    }
  }
  return best
}

/**
 * Where the camera has to be for `box` to sit centred and usable.
 *
 * Zoom fits the widget inside the viewport with padding, then is capped so a
 * small widget is not magnified past the point of being a takeover, and finally
 * clamped to what the canvas allows. The consequence worth stating: an oversized
 * widget zooms OUT. "Appropriate to use" has to include being able to see all of
 * it, and a 1400px-wide widget framed at 100% on a 1200px viewport hides its own
 * right-hand edge -- including, on several widgets here, the controls.
 */
export function navCamera(
  box: Box,
  viewport: Viewport,
  opts?: { maxMagnify?: number }
): CameraTarget {
  const visibleW = Math.max(1, viewport.width - viewport.dockInset)
  const visibleH = Math.max(1, viewport.height)
  const maxMagnify = Math.max(ZOOM_MIN, opts?.maxMagnify ?? NAV_ZOOM_MAX_DEFAULT)

  // Padding is dropped on an axis too small to afford it, so a narrow window
  // still fits the widget instead of being handed a negative target size.
  const availW = visibleW > 3 * PAD ? visibleW - 2 * PAD : visibleW
  const availH = visibleH > 3 * PAD ? visibleH - 2 * PAD : visibleH

  const fit = Math.min(availW / box.w, availH / box.h)
  const zoom = clampZoom(Math.min(fit, maxMagnify))

  const c = centreOf(box)
  return {
    zoom,
    panX: viewport.dockInset + visibleW / 2 - c.x * zoom,
    panY: visibleH / 2 - c.y * zoom
  }
}

/** The canvas-space point currently at the centre of the viewport. */
export function viewportCentreInCanvas(
  camera: { panX: number; panY: number; zoom: number },
  viewport: Viewport
): { x: number; y: number } {
  const visibleW = Math.max(1, viewport.width - viewport.dockInset)
  return {
    x: (viewport.dockInset + visibleW / 2 - camera.panX) / camera.zoom,
    y: (viewport.height / 2 - camera.panY) / camera.zoom
  }
}
