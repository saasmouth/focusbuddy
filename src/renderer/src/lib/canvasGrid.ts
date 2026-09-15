// The tidy grid: snapping while you drag, and a reflow that cleans up a desk.
//
// A free canvas is the point of this product -- put anything anywhere -- but
// "anywhere" and "three pixels off" are not the same thing, and a desk worked on
// for a week reads as noise long before it is actually disorganised.
//
// This is ONLY the snapping: while dragging and resizing, positions and sizes
// land on a grid, so new drift never appears.
//
// It is deliberately not a reflow. lib/autoArrange.ts already packs a desk into
// rows of a shared height with the leftover width distributed so rows sit flush
// -- the 'flow' mode -- which is the whole of what a tidy command should do. A
// second implementation of that was written here before anybody looked, and
// deleted once somebody did.

/**
 * The unit everything lands on -- position AND size.
 *
 * Small enough to feel free, big enough to align. What matters more than the
 * number is that it is ONE number: dragging, resizing and the drop commit
 * disagreed before -- Rnd stepped in 20s while the commit rounded to 8 -- so a
 * widget dragged to a tidy spot was quietly moved off it on release, which is
 * exactly the drift a grid exists to prevent.
 */
export const GRID = 20

export interface GridBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/** Round one value onto the grid. */
export const snap = (v: number, grid = GRID): number => Math.round(v / grid) * grid

/** Round a box's position onto the grid, leaving its size alone. */
export function snapPosition(box: GridBox, grid = GRID): { x: number; y: number } {
  return { x: snap(box.x, grid), y: snap(box.y, grid) }
}

/**
 * Round a box's size onto the grid, never below one grid cell.
 *
 * Sizes snap independently of positions: a widget resized from its top-left
 * corner would otherwise drift by the rounding of the opposite edge.
 */
export function snapSize(box: GridBox, grid = GRID): { width: number; height: number } {
  return {
    width: Math.max(grid, snap(box.width, grid)),
    height: Math.max(grid, snap(box.height, grid))
  }
}
