import type { WidgetKind } from './types'

// The smallest a work widget, file or tool can be made, in CSS pixels, shared by
// the free canvas (react-rnd's minWidth/minHeight) and the Workcentre view (its
// minimum tile in grid units). One table, so a tile and a canvas widget can never
// disagree about what "too small to use" means. There is deliberately NO maximum:
// the owner's ask is that anything can be sized to show all of itself.

/** The floor every kind gets: react-rnd's drag-handle threshold, a multiple of the canvas GRID. */
export const BASE_MIN = { w: 180, h: 120 } as const

// Kinds that are unusable smaller than the base: full editors and viewports need
// room for their own chrome (a toolbar row, a menu bar, scroll bars).
const MIN_BY_KIND: Partial<Record<WidgetKind, { w: number; h: number }>> = {
  doc: { w: 320, h: 240 },
  sheet: { w: 320, h: 240 },
  slides: { w: 320, h: 240 },
  map: { w: 320, h: 240 },
  design: { w: 320, h: 240 },
  draw: { w: 320, h: 240 },
  diagram: { w: 320, h: 240 },
  webview: { w: 320, h: 240 },
  pdf: { w: 280, h: 240 },
  gdoc: { w: 320, h: 240 },
  gsheet: { w: 320, h: 240 },
  gslide: { w: 320, h: 240 },
  table: { w: 280, h: 160 },
  chart: { w: 240, h: 160 },
  'chat-thread': { w: 260, h: 200 },
  'mail-thread': { w: 260, h: 200 }
}

/**
 * The ceiling on the header's Grow press (+50% a press), in px. Not a maximum
 * size: a widget can still be dragged or tiled larger. It only stops one runaway
 * run of presses from filling the desk (owner, 4.3.41, 6aa80f61 raised it from
 * 1400 x 900 so anything can be grown to show all of itself). The Grow button's
 * tooltip states it, so it is read from here rather than restated.
 */
export const GROW_CEILING = { w: 4800, h: 3200 } as const

/** The minimum size, in px, a widget of this kind may be resized to. */
export function minSizeFor(kind: WidgetKind | string): { w: number; h: number } {
  return MIN_BY_KIND[kind as WidgetKind] ?? BASE_MIN
}

// Kinds whose frame is not held to this table: a section sizes itself from its
// children (lib/sectionGeometry), and the minimap is pinned chrome.
const SELF_SIZED: ReadonlySet<string> = new Set(['section', 'minimap'])

// ── Tables: wide enough to show their columns ───────────────────────────────
//
// The catalog spawns every table at 680px (2026-10-30: "make tables large
// enough to show all columns by default"). That fits three columns and the
// add-column gutter; a table with six was born needing a horizontal scroll to
// see what it was for, which is the one thing a table must not hide.
//
// These mirror TableWidget's own geometry. They live here, in shared, because
// the size has to be decided where the widget is CREATED — in the renderer's
// materialise path and in main's action executor — and those must not import
// a component to find out how wide a column is.

/** The row-handle gutter on the left (the delete-row control). */
export const TABLE_ROW_HANDLE_W = 32
/** The add-column gutter on the right (the "+" and the AI button). */
export const TABLE_ADD_COL_W = 64
/** A column with no widthHint of its own. */
export const TABLE_DEFAULT_COL_W = 160
/** Frame border plus a scrollbar gutter. Generous: too wide is a non-event, too narrow is the bug. */
export const TABLE_FRAME_CHROME_W = 16
/**
 * The widest a table is BORN. Past this a horizontal scroll is the better
 * answer — a 12-column table opened at 2000px would not fit the screen, and a
 * widget wider than the desk is worse than one that scrolls.
 */
export const TABLE_MAX_BORN_W = 1280

/**
 * How wide a table widget must be to show these columns without scrolling,
 * clamped to the kind minimum and to TABLE_MAX_BORN_W.
 *
 * Takes the columns rather than a count so a schema that already carries
 * widthHints is measured, not estimated.
 */
export function tableFitWidth(
  // A column shape with no widthHint at all is normal — the AI's columns have
  // none until someone drags a divider — so the property is optional on an
  // otherwise unconstrained object rather than required.
  columns: ReadonlyArray<{ widthHint?: number | null | undefined }> | number
): number {
  const sum =
    typeof columns === 'number'
      ? columns * TABLE_DEFAULT_COL_W
      : columns.reduce((t, c) => t + (c.widthHint ?? TABLE_DEFAULT_COL_W), 0)
  const needed = TABLE_ROW_HANDLE_W + TABLE_ADD_COL_W + sum + TABLE_FRAME_CHROME_W
  return Math.min(TABLE_MAX_BORN_W, Math.max(minSizeFor('table').w, needed))
}

/**
 * Raise a stored width/height to the kind's minimum, so a widget is stored at
 * the size its frame renders. The canvas frame (react-rnd minWidth/minHeight)
 * never draws a widget smaller than this; without the clamp, a widget created
 * or resized through the API, an agent or MCP could keep a smaller stored size
 * than it shows, and anything that reads the store (Tidy, the Workcentre, sync)
 * worked from a size nobody can see. Only the fields present are touched.
 */
export function clampToKindMin<T extends { width?: number; height?: number }>(kind: string, size: T): T {
  if (SELF_SIZED.has(kind)) return size
  const min = minSizeFor(kind)
  const out = { ...size }
  if (typeof out.width === 'number' && Number.isFinite(out.width) && out.width < min.w) out.width = min.w
  if (typeof out.height === 'number' && Number.isFinite(out.height) && out.height < min.h) out.height = min.h
  return out
}
