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

/** The minimum size, in px, a widget of this kind may be resized to. */
export function minSizeFor(kind: WidgetKind | string): { w: number; h: number } {
  return MIN_BY_KIND[kind as WidgetKind] ?? BASE_MIN
}

// Kinds whose frame is not held to this table: a section sizes itself from its
// children (lib/sectionGeometry), and the minimap is pinned chrome.
const SELF_SIZED: ReadonlySet<string> = new Set(['section', 'minimap'])

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
