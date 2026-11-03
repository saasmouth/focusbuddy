import type { WorkcentreLayout, WorkcentreTile } from '@shared/deskLayout'

// The Workcentre view's dashboard grid: pure functions, no React, no DOM.
//
// The grid is `cols` columns wide (chosen from the view's width) and unbounded
// downwards, in rows of ROW_PX. Every object is a tile {x, y, w, h} in grid units.
// Invariants every operation keeps (tests/unit/workcentreLayout.test.ts asserts
// them after randomised sequences):
//   • no two tiles overlap
//   • every tile is on the grid: 0 ≤ x, x + w ≤ cols, 0 ≤ y, all integers
//   • every tile is at least its minimum (w ≥ minW, h ≥ minH), never wider than the grid
//   • tiles are compacted upwards (no tile can move up without overlapping)
//   • the result is deterministic for the same input
//
// Moving or resizing a tile pushes whatever it lands on downwards, then the grid
// compacts upwards — the model of react-grid-layout and the dashboards people
// know (Grafana, Notion), written here so it is small, testable and ours.
//
// What the view SHOWS is that stored layout filled (fillLayout, owner
// 2026-11-03: "auto grow to fill dead space … horizontally and vertically, in
// any direction"): every tile grows into the free space around it, down to the
// bottom of the view. Display-only — the stored sizes are the person's, and an
// axis they sized by hand (fixW / fixH) is never grown — so a tile shrinks back
// the moment something needs its room, and regrows when the room is free again.

export const ROW_PX = 24
export const GAP_PX = 12
/** Target column width; the column count follows the view's width. */
export const COL_TARGET_PX = 96
export const MIN_COLS = 4
export const MAX_COLS = 24

export interface Tile extends WorkcentreTile {
  id: string
}
export interface Mins {
  [id: string]: { w: number; h: number }
}

/** How many columns a view of this width gets. */
export function colsForWidth(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return MIN_COLS
  return Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor((px + GAP_PX) / (COL_TARGET_PX + GAP_PX))))
}

/** The width of one column, in px, for a view this wide with `cols` columns. */
export function colWidthPx(viewPx: number, cols: number): number {
  return Math.max(1, (viewPx - GAP_PX * (cols - 1)) / cols)
}

/** px → grid units (rounded up, so a minimum is never undercut). */
export function unitsFromPx(px: { w: number; h: number }, colPx: number): { w: number; h: number } {
  return {
    w: Math.max(1, Math.ceil((px.w + GAP_PX) / (colPx + GAP_PX))),
    h: Math.max(1, Math.ceil((px.h + GAP_PX) / (ROW_PX + GAP_PX)))
  }
}

/** grid units → px. */
export function pxFromUnits(u: { w: number; h: number }, colPx: number): { w: number; h: number } {
  return { w: u.w * colPx + (u.w - 1) * GAP_PX, h: u.h * ROW_PX + (u.h - 1) * GAP_PX }
}

export const collides = (a: WorkcentreTile, b: WorkcentreTile): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const order = (a: Tile, b: Tile): number => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Clamp one tile onto a `cols`-wide grid and to its minimum. Hand-set axes (fixW / fixH) travel with it. */
export function clampTile(t: Tile, cols: number, min: { w: number; h: number } = { w: 1, h: 1 }): Tile {
  const minW = Math.min(cols, Math.max(1, Math.round(min.w)))
  const minH = Math.max(1, Math.round(min.h))
  const w = Math.max(minW, Math.min(cols, Math.round(t.w)))
  const h = Math.max(minH, Math.round(t.h))
  const x = Math.max(0, Math.min(cols - w, Math.round(t.x)))
  const y = Math.max(0, Math.round(t.y))
  return { id: t.id, x, y, w, h, ...(t.fixW ? { fixW: true } : {}), ...(t.fixH ? { fixH: true } : {}) }
}

/** Move every tile up as far as it will go, in reading order. */
export function compact(tiles: Tile[]): Tile[] {
  const placed: Tile[] = []
  for (const t of [...tiles].sort(order)) {
    let y = t.y
    while (y > 0 && !placed.some((p) => collides({ ...t, y: y - 1 }, p))) y--
    // Never stop on top of something already placed (cannot happen from a valid start, but resolve anyway).
    while (placed.some((p) => collides({ ...t, y }, p))) y++
    placed.push({ ...t, y })
  }
  return placed
}

/**
 * Settle the grid around one tile the person just moved or resized: everything
 * it overlaps is pushed down below it (recursively), then the grid compacts. The
 * focus tile keeps its x, w and h; only its y may rise during compaction.
 */
function settleAround(tiles: Tile[], focusId: string): Tile[] {
  const byId = new Map(tiles.map((t) => [t.id, { ...t }]))
  const focus = byId.get(focusId)!
  const push = (mover: Tile, seen: Set<string>): void => {
    for (const other of [...byId.values()].sort(order)) {
      if (other.id === mover.id || seen.has(other.id)) continue
      if (collides(mover, other)) {
        other.y = mover.y + mover.h
        seen.add(other.id)
        push(other, seen)
        seen.delete(other.id)
      }
    }
  }
  push(focus, new Set([focus.id]))
  // The focus tile compacts with everyone else, but goes first among equals so a
  // tile dragged upwards claims the space it was dropped into.
  const rest = [...byId.values()].filter((t) => t.id !== focusId)
  const placed: Tile[] = []
  const all = [focus, ...rest].sort((a, b) => order(a, b) || (a.id === focusId ? -1 : b.id === focusId ? 1 : 0))
  for (const t of all) {
    let y = t.y
    while (y > 0 && !placed.some((p) => collides({ ...t, y: y - 1 }, p))) y--
    while (placed.some((p) => collides({ ...t, y }, p))) y++
    placed.push({ ...t, y })
  }
  return placed
}

/** First free position, scanning rows top to bottom and columns left to right. */
export function firstFit(tiles: Tile[], size: { w: number; h: number }, cols: number): { x: number; y: number } {
  const w = Math.min(cols, size.w)
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const cand = { x, y, w, h: size.h }
      if (!tiles.some((t) => collides(cand, t))) return { x, y }
    }
  }
}

export function moveTile(tiles: Tile[], id: string, to: { x: number; y: number }, cols: number, mins: Mins = {}): Tile[] {
  const t = tiles.find((x) => x.id === id)
  if (!t) return tiles
  const moved = clampTile({ ...t, x: to.x, y: to.y }, cols, mins[id])
  return settleAround(tiles.map((x) => (x.id === id ? moved : x)), id)
}

export function resizeTile(tiles: Tile[], id: string, size: { w: number; h: number }, cols: number, mins: Mins = {}): Tile[] {
  const t = tiles.find((x) => x.id === id)
  if (!t) return tiles
  const resized = clampTile({ ...t, w: size.w, h: size.h }, cols, mins[id])
  return settleAround(tiles.map((x) => (x.id === id ? resized : x)), id)
}

/**
 * The view got a different column count (the window or the menu changed width):
 * scale x and w proportionally, keep minimums, then lay tiles back in reading
 * order without overlap and compact.
 */
export function reflow(tiles: Tile[], fromCols: number, toCols: number, mins: Mins = {}): Tile[] {
  if (fromCols === toCols) return compact(tiles.map((t) => clampTile(t, toCols, mins[t.id])))
  const k = toCols / fromCols
  const scaled = [...tiles].sort(order).map((t) => clampTile({ ...t, x: Math.round(t.x * k), w: Math.max(1, Math.round(t.w * k)) }, toCols, mins[t.id]))
  const placed: Tile[] = []
  for (const t of scaled) {
    let cand = t
    if (placed.some((p) => collides(cand, p))) {
      // Keep its row if possible, else the first fit below its current row.
      let y = t.y
      let found: Tile | null = null
      while (!found) {
        for (let x = 0; x + t.w <= toCols && !found; x++) {
          const c = { ...t, x, y }
          if (!placed.some((p) => collides(c, p))) found = c
        }
        y++
      }
      cand = found
    }
    placed.push(cand)
  }
  return compact(placed)
}

/**
 * Bring a stored layout up to date with the objects on the Desk: drop tiles whose
 * object is gone, place new objects (first fit, at their preferred size), enforce
 * minimums, and reflow to the current column count. A Desk opened in Workcentre
 * for the first time therefore tiles every object (owner decision, b).
 */
export function syncLayout(
  stored: WorkcentreLayout | null | undefined,
  objects: { id: string; preferred: { w: number; h: number } }[],
  cols: number,
  mins: Mins = {},
  /** New objects dropped at a cell (Files drops): placed there with moveTile instead of first fit. */
  pending: Record<string, { x: number; y: number }> = {}
): WorkcentreLayout {
  const present = new Set(objects.map((o) => o.id))
  const storedCols = stored?.cols && stored.cols > 0 ? stored.cols : cols
  let tiles: Tile[] = Object.entries(stored?.items ?? {})
    .filter(([id]) => present.has(id))
    .map(([id, t]) => clampTile({ id, ...t }, storedCols, mins[id]))
  tiles = reflow(tiles, storedCols, cols, mins)
  // Every present object with a pending cell, new or already tiled (the
  // layout may have synced once between the create and the request).
  const dropped = objects.filter((o) => pending[o.id]).map((o) => o.id)
  for (const o of objects) {
    if (tiles.some((t) => t.id === o.id)) continue
    const size = clampTile({ id: o.id, x: 0, y: 0, ...o.preferred }, cols, mins[o.id])
    const at = firstFit(tiles, size, cols)
    tiles.push({ ...size, ...at })
  }
  tiles = compact(tiles)
  // A tile dropped at a cell claims it: neighbours are pushed down, as when a
  // tile is moved there by hand. Later drops of the same gesture are applied
  // first, so the first item ends at the drop cell and the rest flow below it.
  for (const id of [...dropped].reverse()) tiles = moveTile(tiles, id, pending[id]!, cols, mins)
  return { cols, items: Object.fromEntries(tiles.map(({ id, ...t }) => [id, t])) }
}

export const toTiles = (l: WorkcentreLayout): Tile[] => Object.entries(l.items).map(([id, t]) => ({ id, ...t }))
export const fromTiles = (cols: number, tiles: Tile[]): WorkcentreLayout => ({ cols, items: Object.fromEntries(tiles.map(({ id, ...t }) => [id, t])) })

/** The rows the grid needs (for the scroll height). */
export const gridRows = (tiles: Tile[]): number => tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0)

/** Whole grid rows that fit in a height of `px` (the visible view, for filling down to its bottom). */
export function rowsForHeight(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return 0
  return Math.max(0, Math.floor((px + GAP_PX) / (ROW_PX + GAP_PX)))
}

/** A tile's box in px, relative to the grid's top-left, on the grid's pitch. */
export function tileRectPx(t: WorkcentreTile, colPx: number): { left: number; top: number; width: number; height: number } {
  const size = pxFromUnits(t, colPx)
  return { left: t.x * (colPx + GAP_PX), top: t.y * (ROW_PX + GAP_PX), width: size.w, height: size.h }
}

/**
 * The layout as SHOWN: every tile grown into the dead space around it, in any
 * direction, until nothing more can grow. The region is `cols` wide and as tall
 * as the content or `minRows` (the visible view), whichever is taller — so the
 * last tiles reach the bottom of the view, and a hole under a short tile beside
 * a tall one is filled.
 *
 * Rules: a tile only ever GROWS (its stored rectangle stays inside what is
 * shown), never overlaps, never leaves the region, and never grows along an
 * axis set by hand (fixW / fixH). Rows go first (each tile widens right, then
 * left), then columns (each deepens down, then up), in reading order, repeated
 * until stable; the result does not depend on the order the tiles arrive in.
 * Pure: the input is not changed.
 */
export function fillLayout(tiles: Tile[], cols: number, minRows = 0): Tile[] {
  const rows = Math.max(Math.max(0, Math.floor(minRows)), gridRows(tiles))
  const out = [...tiles].sort(order).map((t) => ({ ...t }))
  if (!out.length || cols <= 0 || rows <= 0) return out
  const taken = new Uint8Array(cols * rows)
  const at = (x: number, y: number): number => y * cols + x
  const mark = (x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) taken[at(x, y)] = 1
  }
  const free = (x0: number, y0: number, w: number, h: number): boolean => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (taken[at(x, y)]) return false
    return true
  }
  for (const t of out) mark(t.x, t.y, Math.min(t.w, cols - t.x), Math.min(t.h, rows - t.y))
  // Every step claims at least one free cell, so this ends within cols × rows steps.
  for (let changed = true; changed; ) {
    changed = false
    for (const t of out) {
      if (t.fixW) continue
      while (t.x + t.w < cols && free(t.x + t.w, t.y, 1, t.h)) {
        mark(t.x + t.w, t.y, 1, t.h)
        t.w++
        changed = true
      }
      while (t.x > 0 && free(t.x - 1, t.y, 1, t.h)) {
        mark(t.x - 1, t.y, 1, t.h)
        t.x--
        t.w++
        changed = true
      }
    }
    for (const t of out) {
      if (t.fixH) continue
      while (t.y + t.h < rows && free(t.x, t.y + t.h, t.w, 1)) {
        mark(t.x, t.y + t.h, t.w, 1)
        t.h++
        changed = true
      }
      while (t.y > 0 && free(t.x, t.y - 1, t.w, 1)) {
        mark(t.x, t.y - 1, t.w, 1)
        t.y--
        t.h++
        changed = true
      }
    }
  }
  return out
}

/**
 * A resize as the person sees it: it starts from the tile's SHOWN box (which
 * fill may have grown, even leftwards or upwards), not its smaller stored one,
 * and the axis being dragged becomes hand-set (right edge → width, bottom edge
 * → height, corner → both), so fill leaves it as set from then on.
 */
export function resizeFromShown(
  base: Tile[],
  shown: Tile[],
  id: string,
  size: { w: number; h: number },
  edge: 'r' | 'b' | 'rb',
  cols: number,
  mins: Mins = {}
): Tile[] {
  const b = base.find((t) => t.id === id)
  const s = shown.find((t) => t.id === id)
  if (!b || !s) return base
  const widen = edge !== 'b'
  const deepen = edge !== 'r'
  const start: Tile = {
    ...b,
    x: widen || b.fixW ? s.x : b.x,
    y: deepen || b.fixH ? s.y : b.y,
    ...(widen ? { fixW: true } : {}),
    ...(deepen ? { fixH: true } : {})
  }
  const w = widen ? size.w : b.w
  const h = deepen ? size.h : b.h
  return resizeTile(base.map((t) => (t.id === id ? start : t)), id, { w, h }, cols, mins)
}

/** The id of the cells kept clear under the Plexii pill (never stored, never rendered as a tile). */
export const KEEP_OUT = '__corner-keep-out__'

/**
 * fillLayout, with room kept for the Plexii pill that floats over the view's
 * bottom-right corner: filled tiles reach that corner, and the last tile's
 * resize handle would sit under the pill where it cannot be grabbed.
 *
 * The tile that fill puts in the corner stops `h` rows short of the bottom,
 * leaving a strip under that one tile for the pill (the keep-out); every other
 * tile still reaches the bottom, and nothing is stranded (a small keep-out cell
 * blocking a rectangle's growth left whole columns dead). If that tile's own
 * stored size already reaches the strip, it is never shrunk below it: the strip
 * goes below the content instead, and the view scrolls that much further.
 * `h` 0 (no pill): the plain fill. Pure.
 */
export function fillWithCornerKeepOut(base: Tile[], cols: number, minRows: number, h: number): { shown: Tile[]; keep: Tile | null } {
  const plain = fillLayout(base, cols, minRows)
  if (h <= 0 || cols <= 0 || !base.length) return { shown: plain, keep: null }
  const rows = Math.max(Math.floor(minRows), gridRows(plain))
  const corner = plain.find((t) => t.x + t.w === cols && t.y + t.h === rows)
  if (!corner) return { shown: plain, keep: null } // the corner is already clear
  const stored = base.find((t) => t.id === corner.id)!
  const top = rows - h
  if (stored.y + stored.h <= top && top > corner.y) {
    const keep: Tile = { id: KEEP_OUT, x: corner.x, y: top, w: corner.w, h, fixW: true, fixH: true }
    return { shown: plain.map((t) => (t.id === corner.id ? { ...t, h: top - t.y } : t)), keep }
  }
  // Its own size reaches the corner: keep the strip below the content, under it.
  const keep: Tile = { id: KEEP_OUT, x: corner.x, y: rows, w: corner.w, h, fixW: true, fixH: true }
  const shown = fillLayout([...base, keep], cols, rows + h).filter((t) => t.id !== KEEP_OUT)
  return { shown, keep }
}

/** Hand a tile back to auto-fill: forget the sizes set by hand. */
export function fitAgain(tiles: Tile[], id: string): Tile[] {
  return tiles.map((t) => (t.id === id ? { id: t.id, x: t.x, y: t.y, w: t.w, h: t.h } : t))
}

/**
 * Put `item` at `cell`, claiming it as a hand move does (what it lands on is
 * pushed down, then the grid compacts). The same rule syncLayout applies to a
 * dropped object's pending cell, so the drop preview IS where it lands.
 */
export function placeAt(tiles: Tile[], item: Tile, cell: { x: number; y: number }, cols: number, mins: Mins = {}): Tile[] {
  const rest = tiles.filter((t) => t.id !== item.id)
  const start = clampTile({ ...item, x: cell.x, y: cell.y }, cols, mins[item.id])
  return moveTile([...rest, start], item.id, cell, cols, mins)
}
