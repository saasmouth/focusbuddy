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

/** Clamp one tile onto a `cols`-wide grid and to its minimum. */
export function clampTile(t: Tile, cols: number, min: { w: number; h: number } = { w: 1, h: 1 }): Tile {
  const minW = Math.min(cols, Math.max(1, Math.round(min.w)))
  const minH = Math.max(1, Math.round(min.h))
  const w = Math.max(minW, Math.min(cols, Math.round(t.w)))
  const h = Math.max(minH, Math.round(t.h))
  const x = Math.max(0, Math.min(cols - w, Math.round(t.x)))
  const y = Math.max(0, Math.round(t.y))
  return { id: t.id, x, y, w, h }
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
