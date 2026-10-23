import { useEffect, useState, type RefObject } from 'react'

// The PlexiiAssist pill is fixed to the window's bottom-right corner, over
// whatever app is open, and Diagrams' minimap sits in the canvas's bottom-right
// corner: the pill covered the minimap's corner, and a press there opened the
// assistant instead of panning (rails-tabs-41 shots, Diagrams-home.png). The
// minimap stays where people look for it and lifts just clear of the pill.
//
// Measured, not authored: where the pill lands depends on the open-item tray
// (it publishes --fb-pill-bottom), the window and the user's UI scale, so any
// fixed offset written here would be right in one layout only.

export const PILL_SELECTOR = '[data-testid="assistant-pill"]'

/** Clear air between the minimap and the pill, room for the pill's halo too. */
const GAP = 12

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * How far (client px) the minimap must rise so its bottom edge clears the pill.
 * `canvas` is the diagram canvas, `mini` the minimap where it sits unlifted
 * (only its left and right are read), `margin` its distance from the canvas
 * edge. 0 when the pill is absent, beside it, or below it.
 */
export function liftOverPill(canvas: Box, pill: Box | null, mini: Pick<Box, 'left' | 'right'> | null, margin: number): number {
  if (!pill || !mini) return 0
  if (pill.right <= pill.left || pill.bottom <= pill.top) return 0 // not laid out (hidden)
  const overlapsAcross = pill.left < mini.right && pill.right > mini.left
  if (!overlapsAcross) return 0
  const miniBottom = canvas.bottom - margin
  if (pill.top >= miniBottom || pill.bottom <= canvas.top) return 0
  return Math.max(0, miniBottom - pill.top + GAP)
}

/** React Flow's panel margin, in the canvas's own CSS px. */
export const MINIMAP_MARGIN = 15

/**
 * The extra bottom margin (CSS px) Diagrams gives its minimap to clear the
 * pill, kept current as the window, the canvas and the tray change.
 */
export function useMinimapPillLift(wrapRef: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [lift, setLift] = useState(0)
  useEffect(() => {
    const wrap = wrapRef.current
    if (!enabled || !wrap) {
      setLift(0)
      return
    }
    const measure = (): void => {
      const c = wrap.getBoundingClientRect()
      // CSS px inside the canvas vs client px (the user's UI scale).
      const scale = wrap.offsetWidth ? c.width / wrap.offsetWidth : 1
      const mini = wrap.querySelector('.react-flow__minimap')?.getBoundingClientRect() ?? null
      const pill = document.querySelector(PILL_SELECTOR)?.getBoundingClientRect() ?? null
      const px = liftOverPill(c, pill, mini, MINIMAP_MARGIN * scale)
      setLift(Math.ceil(px / (scale || 1)))
    }
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    // The tray moves the pill by restyling the root (--fb-pill-bottom).
    const mo = new MutationObserver(measure)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [wrapRef, enabled])
  return lift
}
