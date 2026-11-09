// Geometry for the Home widget grid (Apple widget-picker mission, Phase 1).
// Pure functions only. The packing here is the single source of truth for
// where every widget sits: cells get explicit gridColumn/gridRow from
// packGrid's output, and drag math reads the same numbers, so CSS and pointer
// logic can never disagree — and drag targeting never measures the DOM
// mid-animation (framer's transforms would feed the springs back into the
// math and jitter).

import { widgetDef, type HomeWidgetDef, type HomeWidgetInstance, type WidgetSize } from './homeWidgetDefs'

export type { WidgetSize }

export interface SizedInstance extends HomeWidgetInstance {
  size: WidgetSize
}

// A widget only renders at sizes its def declares; anything else falls back
// to the def's default. Guards migration and swap-in-place.
export function clampSize(def: HomeWidgetDef, desired: WidgetSize): WidgetSize {
  return def.sizes.includes(desired) ? desired : def.defaultSize
}

// Migrate the v2 two-column layout: main-column widgets arrive large, rail
// widgets small, order main-then-rail, every size clamped to what the def
// actually supports.
export function sizedFromColumns(main: HomeWidgetInstance[], rail: HomeWidgetInstance[]): SizedInstance[] {
  return [
    ...main.map((it): SizedInstance => ({ ...it, size: clampSize(widgetDef(it.widget), 'lg') })),
    ...rail.map((it): SizedInstance => ({ ...it, size: clampSize(widgetDef(it.widget), 'sm') }))
  ]
}

// A brand-new board: each card at the size it arrives at. Separate from the
// migration above, so a layout somebody already has keeps the sizes it had.
export function stockSized(main: HomeWidgetInstance[], rail: HomeWidgetInstance[]): SizedInstance[] {
  return [...main, ...rail].map((it): SizedInstance => ({ ...it, size: widgetDef(it.widget).defaultSize }))
}

// Grid footprint per size, in SUBUNITS: every visual cell is a 2x2 block of
// subunits sharing the same gap, which reproduces the original cell geometry
// exactly ((W - 7g)/8 == ((W - 3g)/4 - g)/2) while opening a true app-icon
// tier: icon is one subunit, four of them in a small widget's footprint.
// Callers pass subunit columns (visual columns x SUBDIV) and subunit row
// height ((cell height - gap) / SUBDIV) in their metrics.
export const SUBDIV = 2
export const SIZE_SPAN: Record<WidgetSize, { w: number; h: number }> = {
  icon: { w: 1, h: 1 },
  sm: { w: 2, h: 2 },
  md: { w: 4, h: 2 },
  lg: { w: 4, h: 4 },
  stack: { w: 2, h: 4 }
}

export interface GridPos {
  col: number
  row: number
}

// Viewport-space measurements of the live grid, captured from the container
// once per pointer event. originX/originY are the container's content origin.
export interface GridMetrics {
  originX: number
  originY: number
  cellW: number
  cellH: number
  gap: number
  cols: number
}

// First-fit packing: scan rows top-down, columns left-right, place each item
// at the first spot its span fits. Later small widgets fill gaps left by
// earlier large ones, which keeps the board tight the way Apple's is.
export function packGrid(
  items: readonly { key: string; size: WidgetSize }[],
  cols: number
): Map<string, GridPos> {
  const out = new Map<string, GridPos>()
  const occupied: boolean[][] = []
  const rowAt = (r: number): boolean[] => {
    while (occupied.length <= r) occupied.push(new Array<boolean>(cols).fill(false))
    return occupied[r]
  }
  const fits = (col: number, row: number, w: number, h: number): boolean => {
    if (col + w > cols) return false
    for (let r = row; r < row + h; r++) {
      const line = rowAt(r)
      for (let c = col; c < col + w; c++) if (line[c]) return false
    }
    return true
  }
  const claim = (col: number, row: number, w: number, h: number): void => {
    for (let r = row; r < row + h; r++) {
      const line = rowAt(r)
      for (let c = col; c < col + w; c++) line[c] = true
    }
  }
  for (const item of items) {
    const span = SIZE_SPAN[item.size]
    const w = Math.min(span.w, cols)
    if (item.size === 'icon') {
      // Icons fill COLUMN-first within each cell-height band: the first icon
      // takes a top subrow, the next completes the column beneath it, so two
      // icons make a flush full-height column and four make a full cell.
      // Row-major would strand a half-height strip under every icon row that
      // nothing else can fill (only icons are one subunit tall) — the "weird
      // middle area" Apple's boards never show.
      placed: for (let band = 0; ; band++) {
        for (let col = 0; col < cols; col++) {
          for (let dr = 0; dr < SUBDIV; dr++) {
            const row = band * SUBDIV + dr
            if (fits(col, row, 1, 1)) {
              claim(col, row, 1, 1)
              out.set(item.key, { col, row })
              break placed
            }
          }
        }
      }
      continue
    }
    placed: for (let row = 0; ; row++) {
      for (let col = 0; col <= cols - w; col++) {
        if (fits(col, row, w, span.h)) {
          claim(col, row, w, span.h)
          out.set(item.key, { col, row })
          break placed
        }
      }
    }
  }
  return out
}

// Total rows the packed board occupies (for sizing the container if needed).
export function packedRows(
  items: readonly { key: string; size: WidgetSize }[],
  positions: Map<string, GridPos>
): number {
  let rows = 0
  for (const item of items) {
    const pos = positions.get(item.key)
    if (pos) rows = Math.max(rows, pos.row + SIZE_SPAN[item.size].h)
  }
  return rows
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

// Viewport-space rect of a cell at a packed position.
export function cellRect(pos: GridPos, size: WidgetSize, m: GridMetrics): Rect {
  const span = SIZE_SPAN[size]
  return {
    left: m.originX + pos.col * (m.cellW + m.gap),
    top: m.originY + pos.row * (m.cellH + m.gap),
    width: span.w * m.cellW + (span.w - 1) * m.gap,
    height: span.h * m.cellH + (span.h - 1) * m.gap
  }
}

// Which grid cell a viewport point falls in, clamped to the board. Used to
// throttle drag targeting: the insertion index is only recomputed when the
// pointer crosses into a different cell, which is the hysteresis that keeps
// boundaries from jittering.
export function pointerCell(x: number, y: number, m: GridMetrics): GridPos {
  const col = Math.max(0, Math.min(m.cols - 1, Math.floor((x - m.originX) / (m.cellW + m.gap))))
  const row = Math.max(0, Math.floor((y - m.originY) / (m.cellH + m.gap)))
  return { col, row }
}

// The insertion index whose resulting layout puts the dragged widget's cell
// closest to the pointer. Tries every index (lists are ≤ ~20 items and packing
// is trivial, so this is cheap) — which makes the placeholder gap always be
// exactly where the widget will land, Apple's contract. Ties resolve to the
// earliest index so repeated calls are stable.
export function bestInsertionIndex(
  others: readonly SizedInstance[],
  dragged: SizedInstance,
  x: number,
  y: number,
  m: GridMetrics
): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i <= others.length; i++) {
    const trial = [...others.slice(0, i), dragged, ...others.slice(i)]
    const pos = packGrid(trial, m.cols).get(dragged.key)
    if (!pos) continue
    const r = cellRect(pos, dragged.size, m)
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const d = (cx - x) * (cx - x) + (cy - y) * (cy - y)
    if (d < bestD - 1) {
      bestD = d
      best = i
    }
  }
  return best
}
