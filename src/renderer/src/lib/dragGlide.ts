// Click-and-drag to scroll, with a glide on release — the desk's own grab-pan
// feel, for views that scroll like a page (the Workcentre). The owner asked
// for it in 4.3.43 ("can't scroll or click glide from Workcentre").
//
// The physics is pure so it can be tested without a DOM: the release velocity
// decays by a constant friction each frame until it is too slow to see.

/** Per-frame (16.7 ms) velocity retained during a glide. */
export const GLIDE_FRICTION = 0.94
/** Below this speed (px per frame) the glide stops. */
export const GLIDE_MIN_SPEED = 0.15

/** Successive per-frame offsets of a glide that starts at velocity (vx, vy) px/frame. */
export function glideSteps(vx: number, vy: number, friction = GLIDE_FRICTION, minSpeed = GLIDE_MIN_SPEED): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let x = vx
  let y = vy
  for (let i = 0; i < 600 && Math.hypot(x, y) >= minSpeed; i++) {
    out.push([x, y])
    x *= friction
    y *= friction
  }
  return out
}

/**
 * Wire drag-to-scroll with glide onto a scroller. `startsDrag` decides whether
 * a press may begin one — never on a tile, a control or text, which keep their
 * own meaning. Returns the cleanup.
 */
export function attachDragGlide(el: HTMLElement, startsDrag: (target: Element) => boolean): () => void {
  let drag: { id: number; x: number; y: number; t: number; vx: number; vy: number } | null = null
  let raf = 0
  const stopGlide = (): void => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }
  const onDown = (e: PointerEvent): void => {
    stopGlide()
    if (e.button !== 0 || !(e.target instanceof Element) || !startsDrag(e.target)) return
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, vx: 0, vy: 0 }
    el.setPointerCapture?.(e.pointerId)
    el.style.cursor = 'grabbing'
    e.preventDefault()
  }
  const onMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    const dt = Math.max(1, e.timeStamp - drag.t)
    el.scrollLeft -= dx
    el.scrollTop -= dy
    // Velocity in px per 16.7 ms frame, smoothed so one jittery sample does not decide the glide.
    drag.vx = 0.7 * drag.vx + 0.3 * ((-dx / dt) * 16.7)
    drag.vy = 0.7 * drag.vy + 0.3 * ((-dy / dt) * 16.7)
    drag.x = e.clientX
    drag.y = e.clientY
    drag.t = e.timeStamp
  }
  const onUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    const steps = e.timeStamp - drag.t < 80 ? glideSteps(drag.vx, drag.vy) : [] // a held stop does not glide
    drag = null
    el.style.cursor = ''
    let i = 0
    const tick = (): void => {
      const s = steps[i++]
      if (!s) {
        raf = 0
        return
      }
      el.scrollLeft += s[0]
      el.scrollTop += s[1]
      raf = requestAnimationFrame(tick)
    }
    if (steps.length) raf = requestAnimationFrame(tick)
  }
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
  el.addEventListener('wheel', stopGlide, { passive: true })
  return () => {
    stopGlide()
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onUp)
    el.removeEventListener('wheel', stopGlide)
  }
}
