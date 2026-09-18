// Shared placement for the floating chrome that overlays the desk (the control
// pill, the breadcrumb, the toolbar, the presence bar, the minimap FAB, context
// menus, popovers). Each such element carries the data-floating-menu attribute.
// A movable menu resolves its position against the live rects of the others so
// they dynamically avoid each other and never sit off-screen, instead of
// stacking. Reading the rects straight from the DOM means any element that opts
// in by adding the attribute is avoided automatically, with no per-component
// wiring.

import type { MenuRect } from '../stores/overlay'

const MARGIN = 8

// Every floating menu currently on screen except the one asking (and anything
// inside it). Elements with zero size are skipped so a collapsed or unmounted
// node never counts as an obstacle.
export function collectMenuRects(exclude: Element | null): MenuRect[] {
  const out: MenuRect[] = []
  const nodes = document.querySelectorAll<HTMLElement>('[data-floating-menu]')
  nodes.forEach((el) => {
    if (exclude && (el === exclude || el.contains(exclude) || exclude.contains(el))) return
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  })
  return out
}

function overlaps(l: number, t: number, w: number, h: number, o: MenuRect): boolean {
  return l < o.right && l + w > o.left && t < o.bottom && t + h > o.top
}

function clampToViewport(left: number, top: number, w: number, h: number): { left: number; top: number } {
  const maxLeft = Math.max(MARGIN, window.innerWidth - w - MARGIN)
  const maxTop = Math.max(MARGIN, window.innerHeight - h - MARGIN)
  return {
    left: Math.min(Math.max(MARGIN, left), maxLeft),
    top: Math.min(Math.max(MARGIN, top), maxTop)
  }
}

// Resolve the top for a menu that must stay horizontally centered (the control
// pill's default mode). Dodging is vertical-only: starting at desiredTop, the
// menu is pushed straight down below any obstacle it overlaps, so it never
// trades its centering for a sideways shove. Falls back to the clamped desired
// top if the column is too crowded to clear. Returns desiredTop unchanged when
// the centered spot is already clear, so callers can treat "same value" as
// "no dodge needed".
export function resolveCenteredTop(
  desiredTop: number,
  w: number,
  h: number,
  obstacles: MenuRect[]
): number {
  const left = (window.innerWidth - w) / 2
  const maxTop = Math.max(MARGIN, window.innerHeight - h - MARGIN)
  let top = Math.min(Math.max(MARGIN, desiredTop), maxTop)
  for (let pass = 0; pass < 6; pass++) {
    const hit = obstacles.find((o) => overlaps(left, top, w, h, o))
    if (!hit) return top
    const pushed = hit.bottom + MARGIN
    if (pushed > maxTop) return Math.min(Math.max(MARGIN, desiredTop), maxTop) // crowded; best effort
    top = pushed
  }
  return top
}

// Resolve a desired top-left for a w x h menu so it stays on screen and does not
// overlap any obstacle. Uses minimal-translation nudges: on each pass it finds
// the obstacle it overlaps most and pushes out along the cheapest axis, then
// re-clamps, repeating a few times so clearing one obstacle that pushes it into
// another still settles. If it cannot find a clear spot (a very crowded or tiny
// viewport) it returns the best clamped position rather than looping forever.
export function resolvePosition(
  desiredLeft: number,
  desiredTop: number,
  w: number,
  h: number,
  obstacles: MenuRect[]
): { left: number; top: number } {
  let { left, top } = clampToViewport(desiredLeft, desiredTop, w, h)
  for (let pass = 0; pass < 6; pass++) {
    let worst: MenuRect | null = null
    let worstArea = 0
    for (const o of obstacles) {
      if (!overlaps(left, top, w, h, o)) continue
      const ox = Math.min(left + w, o.right) - Math.max(left, o.left)
      const oy = Math.min(top + h, o.bottom) - Math.max(top, o.top)
      const area = Math.max(0, ox) * Math.max(0, oy)
      if (area > worstArea) {
        worstArea = area
        worst = o
      }
    }
    if (!worst) break
    // Four ways out of this obstacle; pick the smallest move that fits on screen.
    const pushLeft = worst.left - w - MARGIN
    const pushRight = worst.right + MARGIN
    const pushUp = worst.top - h - MARGIN
    const pushDown = worst.bottom + MARGIN
    const options = [
      { left: pushLeft, top, cost: Math.abs(pushLeft - left) },
      { left: pushRight, top, cost: Math.abs(pushRight - left) },
      { left, top: pushUp, cost: Math.abs(pushUp - top) },
      { left, top: pushDown, cost: Math.abs(pushDown - top) }
    ]
      .filter(
        (c) =>
          c.left >= MARGIN &&
          c.left <= window.innerWidth - w - MARGIN &&
          c.top >= MARGIN &&
          c.top <= window.innerHeight - h - MARGIN
      )
      .sort((a, b) => a.cost - b.cost)
    if (options.length === 0) break // nowhere on-screen clears it; keep best effort
    left = options[0].left
    top = options[0].top
  }
  return { left, top }
}

// Whether a minimisable surface starts minimised. Pure so it can be tested
// without rendering: it decides a first impression, and the ways to get it
// wrong (ignoring a stored preference, or letting a responsive default
// override an explicit one) are all silent.
export function initialMinimized(
  stored: string | null,
  opts: { breakpoint: number; defaultMinimized?: boolean; innerWidth: number }
): boolean {
  // What the user last chose always wins, on any window size.
  if (stored === '1') return true
  if (stored === '0') return false
  // Failing that, a surface may declare it starts out of the way regardless of
  // window size -- a panel nobody asked for should not be a document's first
  // impression, least of all in a widget on a desk.
  if (opts.defaultMinimized !== undefined) return opts.defaultMinimized
  return opts.innerWidth < opts.breakpoint
}
