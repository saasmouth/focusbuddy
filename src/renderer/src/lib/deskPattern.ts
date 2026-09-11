// The desk paper's geometry: where the pattern layer sits and how far it moves.
//
// The paper is one composited layer behind the canvas. Panning only translates
// it, wrapped to one super-tile so the offset stays small and the translation
// is invisible. Zooming changes only its cell size.
//
// The cell size follows the camera EXACTLY. It was once quantised to 5% steps
// to spare the layer a repaint during a zoom gesture, which was a reasonable
// aim and the wrong lever: a cell size is a geometry, so a 2.5% error is
// invisible on one cell and compounds with distance, and the whole dot field
// jumped about 70px across a 1400px viewport each time the camera crossed a
// step. On a Mac trackpad a pinch arrives as ctrl+wheel during ordinary
// two-finger scrolling, so those steps were crossed while the user believed
// they were only panning. The repaint is now avoided by holding the layer's
// inset constant instead, so a zoom changes paint and never layout.

/** Dot cell, world px. */
export const DOT_CELL = 42
/** Grid cell, world px. */
export const GRID_CELL = 56
/**
 * The super-tile: LCM(42, 56). Translating by a whole number of these leaves
 * both patterns looking identical, which is what makes the wrap invisible.
 */
export const SUPER_TILE = 168

/**
 * The layer's inset on the top and left, in screen px — one super-tile at
 * maximum zoom, held CONSTANT so that changing the cell size never re-runs
 * layout. It is duplicated as a literal in globals.css (`.desk-pattern-layer`);
 * deskPattern.test.ts pins the two together along with the zoom ceiling that
 * makes the number correct.
 */
export const PATTERN_INSET_PX = 336

/**
 * The multiplier the stylesheet applies to the cell sizes (`--fb-desk-zoom`).
 *
 * It is the camera's zoom, unrounded, and that is the whole point: quantising
 * it is what made the paper jump. Anything that wants to spare the layer a
 * repaint must do it without changing this number.
 */
export function patternScale(zoom: number): number {
  return zoom
}

/** Screen-space size of one dot cell at `zoom`. */
export function dotCellPx(zoom: number): number {
  return DOT_CELL * patternScale(zoom)
}

/** Screen-space size of one super-tile at `zoom`. */
export function superTilePx(zoom: number): number {
  return SUPER_TILE * zoom
}

/**
 * How far to translate the pattern layer for a given camera, wrapped into
 * [0, superTilePx) so the layer never travels further than its own inset.
 */
export function patternOffset(pan: number, zoom: number): number {
  const tile = superTilePx(zoom)
  return ((pan % tile) + tile) % tile
}
