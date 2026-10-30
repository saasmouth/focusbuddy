// One definition of a focus-dock tile's size.
//
// Three components draw a tile in that row — the widget tiles, the permanent
// action tabs and the cluster tabs — and each had its own `92, 60`. Growing
// one to fit a name (2026-10-30) would have left the other two short, so the
// row read as a mistake rather than a change. They share the numbers now.

/** Tile footprint. Wide enough for a name that is not immediately truncated. */
export const TILE_W = 128
export const TILE_H = 84

/**
 * The virtual viewport a preview is rendered into before being scaled down.
 *
 * Fixed on purpose. Scaling each preview by the widget's own pixel size meant
 * a 400px-wide note came out at 0.19x — 12px text rendered as 2px, which is
 * the "white rectangle" the dock was reported as showing. A fixed viewport
 * makes the scale a number we chose (0.4x) and makes every tile legible to
 * the same degree, however big its widget happens to be on the desk.
 */
export const PREVIEW_VW = 320
export const PREVIEW_VH = 210
