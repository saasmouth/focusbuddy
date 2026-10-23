// When may edge-pan start? Only when the POINTER moved into the edge zone.
//
// The pan loop in useEdgePan reads a cursor position that pointer events keep
// up to date. Some of those events are not the user moving anything: Chromium
// dispatches a "fake" mousemove at the old screen point whenever the content
// under a resting cursor changes (a scroll, a layout shift, the dock widening
// --fb-dock-inset), and HTML5 drags repeat dragover every ~50 ms while the
// cursor holds still. Re-reading the position from such an event is right —
// the cursor's position RELATIVE to the canvas has changed — but it must not
// be what starts a pan. Otherwise a pointer resting just outside the zone near
// the dock lands "inside" it because the surface or the zone moved under it,
// and the desk drifts away at ~750 px/s for as long as the hand rests there.
//
// So the state machine below separates the two questions:
//   - is the cursor in the zone?            (every event answers this)
//   - did the cursor get there by moving?   (only a real move answers yes)
// It arms on a real move that ends inside the zone, stays armed while the
// cursor stays in the zone (holding a dragged widget still at the edge keeps
// panning, which is the point of edge-pan), and disarms the moment the cursor
// is outside the zone or gone, however that happened.

export interface PointerSample {
  clientX: number
  clientY: number
  /** MouseEvent.movementX/Y: the OS delta. 0 on Chromium's fake moves and on dragover. */
  movementX?: number
  movementY?: number
}

export interface EdgePanArming {
  /**
   * Feed one pointer event that landed on the canvas. `inZone` says whether
   * the position it implies is inside the edge zone. Returns whether edge-pan
   * is armed after this event.
   */
  observe(sample: PointerSample, inZone: boolean): boolean
  /** Record where the pointer is without judging the zone (events off the canvas). */
  note(sample: PointerSample): void
  /** The cursor left the canvas, a drag ended, or the surface changed: disarm. */
  disarm(): void
  readonly armed: boolean
}

export function createEdgePanArming(): EdgePanArming {
  let last: { x: number; y: number } | null = null
  let armed = false

  function moved(s: PointerSample): boolean {
    if (last) return s.clientX !== last.x || s.clientY !== last.y
    // No earlier position to compare with (the first event this hook sees):
    // only the OS delta can say the pointer moved. A fake move reports 0.
    return (s.movementX ?? 0) !== 0 || (s.movementY ?? 0) !== 0
  }

  return {
    observe(sample, inZone) {
      const didMove = moved(sample)
      last = { x: sample.clientX, y: sample.clientY }
      if (!inZone) armed = false
      else if (didMove) armed = true
      // In the zone without moving: keep whatever state we had. An armed pan
      // carries on (the hand is holding still at the edge); an unarmed cursor
      // that the zone slid under stays unarmed.
      return armed
    },
    note(sample) {
      last = { x: sample.clientX, y: sample.clientY }
    },
    disarm() {
      armed = false
    },
    get armed() {
      return armed
    }
  }
}

/**
 * How far in from each canvas edge the pointer starts the desk panning
 * (useEdgePan's default margin). Anything the desk frames for the user to work
 * on has to sit clear of it, or reaching for it pans it away.
 */
export const EDGE_PAN_MARGIN = 80

/** Whether a canvas-relative point is inside the edge zone of a `width` x `height` viewport. */
export function isInEdgeZone(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  margin: number
): boolean {
  if (margin <= 0) return false
  return (
    pos.x < margin ||
    pos.y < margin ||
    size.width - pos.x < margin ||
    size.height - pos.y < margin
  )
}
