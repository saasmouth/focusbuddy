// The active PlexiiCells tab as paper wants it: what Print… and Download ▸ PDF
// render (shared/sheetPrint.ts lays it out; main prints or saves it).
//
// Every cell is what the grid SHOWS, computed by the grid's own steps
// (sheet/SheetGrid.tsx): the formula engine's displayCell (spills included),
// the cell's format with any matching conditional "compare" rule over it, then
// the number format; numbers right-aligned unless the cell says otherwise;
// error values red. Rows and columns the grid hides (collapsed outline groups,
// active filters) are not printed, as in Excel.
//
// Everything else on the tab reaches the paper, drawn by the code that draws
// it on screen, or marked where it cannot be:
//   conditional formats  colour scales, data bars and icon sets through the
//                        grid's own functions (colorScaleColor, dataBarPct,
//                        iconForValue) over the same per-rule min/max
//   sparklines           the grid's own SparklineCell, rendered to static SVG
//   charts               a snapshot of the chart the editor drew (the shared
//                        PlexiChart in the editor's chart list); a chart that is
//                        not on screen prints as a marked placeholder
//   pivot tables         computePivot, with the pivot table's own number format
//   placed work widgets  live content cannot be printed faithfully, so each
//                        prints as a marked box with its name at its spot
// The grid's purple tint on spilled values is an editing cue, so the paper
// prints them in the cell's own colour.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SheetBodyV2, SheetTab } from '@shared/types'
import type { SheetPrintBlock, SheetPrintCell, SheetPrintModel, SheetPrintOverlay } from '@shared/sheetPrint'
import { buildSpillMap, displayCell, makeNames, makeWorkbook, sparklineForCell, type Grid } from './sheetFormula'
import {
  applyCondFormat,
  colorScaleColor,
  condNumber,
  dataBarPct,
  iconForValue,
  isRowHidden,
  isVisualCond,
  parseA1Range,
  rangeHas
} from './sheetCond'
import { computePivot } from './sheetPivot'
import { SparklineCell, ROW_HEADER_W, HEADER_H } from '../components/documents/sheet/SheetGrid'
import { fmt as pivotNumber } from '../components/documents/sheet/SheetPivot'
import { formatValue } from '@shared/sheetFormat'
import { activeTab, cellFormat } from './sheetBody'

// The editor's defaults (SheetEditor DEFAULT_COL_W / DEFAULT_ROW_H): Excel's
// 8.43-character column and 15pt row, at 96 dpi.
export const SHEET_DEFAULT_COL_W = 64
export const SHEET_DEFAULT_ROW_H = 20

const ERROR_VALUE = /^#(ERR|DIV\/0!|N\/A|VALUE!|NAME\?|NUM!|REF!|SPILL!)$/

export interface CellBox {
  r1: number
  c1: number
  r2: number
  c2: number
}

/**
 * The used range: the smallest box holding every cell with a value, a fill, or
 * a merge. Null for a tab with nothing on it.
 */
export function usedRange(tab: SheetTab): CellBox | null {
  let box: CellBox | null = null
  const add = (r: number, c: number): void => {
    if (!box) box = { r1: r, c1: c, r2: r, c2: c }
    else box = { r1: Math.min(box.r1, r), c1: Math.min(box.c1, c), r2: Math.max(box.r2, r), c2: Math.max(box.c2, c) }
  }
  tab.rows.forEach((row, r) => row.forEach((v, c) => (typeof v === 'string' && v.trim() !== '' ? add(r, c) : undefined)))
  for (const [key, f] of Object.entries(tab.formats ?? {})) {
    if (!f?.bg) continue
    const [r, c] = key.split(',').map(Number)
    if (Number.isInteger(r) && Number.isInteger(c)) add(r, c)
  }
  for (const m of tab.merges ?? []) {
    add(m.r1, m.c1)
    add(m.r2, m.c2)
  }
  return box
}

/** What a tab prints: its print area when it has a valid one, else the used range. */
export function printBox(tab: SheetTab): CellBox | null {
  if (tab.printArea) {
    const p = parseA1Range(tab.printArea)
    if (p) return p
  }
  return usedRange(tab)
}

function hiddenRowsOf(tab: SheetTab, grid: Grid, workbook: ReturnType<typeof makeWorkbook>): Set<number> {
  const set = new Set<number>()
  for (const g of tab.rowGroups ?? []) if (g.collapsed) for (let r = g.start + 1; r <= g.end; r++) set.add(r)
  const filters = tab.filters
  const cols = filters ? Object.keys(filters).map(Number).filter((c) => filters[c]?.length) : []
  if (cols.length && filters) {
    for (let r = 0; r < tab.rows.length; r++) {
      const values: Record<number, string> = {}
      for (const c of cols) values[c] = displayCell(grid, r, c, workbook)
      if (isRowHidden(values, filters)) set.add(r)
    }
  }
  return set
}

function hiddenColsOf(tab: SheetTab): Set<number> {
  const set = new Set<number>()
  for (const g of tab.colGroups ?? []) if (g.collapsed) for (let c = g.start + 1; c <= g.end; c++) set.add(c)
  return set
}

/** "1:2" / "$3" → zero-based inclusive rows, or null. */
export function parseRowRange(text: string | undefined): { r1: number; r2: number } | null {
  const m = /^\s*\$?(\d+)\s*(?::\s*\$?(\d+)\s*)?$/.exec(text ?? '')
  if (!m) return null
  const a = parseInt(m[1], 10) - 1
  const b = (m[2] ? parseInt(m[2], 10) : a + 1) - 1
  if (a < 0 || b < 0) return null
  return { r1: Math.min(a, b), r2: Math.max(a, b) }
}

/** What the editor knows at print time that the body alone does not. */
export interface SheetPrintExtras {
  /** chart id → the chart's drawing as the editor shows it (outer HTML of its rendered chart). */
  chartSnapshots?: Record<string, { html: string; w: number; h: number }>
  /** placed widget id → its name, for its placeholder. */
  widgetNames?: Record<string, string>
}

const PIVOT_ESC = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A pivot table as paper: computePivot's result in the pivot table's layout and number format. */
function pivotHtml(tab: SheetTab, spec: NonNullable<SheetTab['pivots']>[number]): { html: string; w: number; h: number } | null {
  const grid = { columns: tab.columns, rows: tab.rows }
  const res = computePivot((r, c) => displayCell(grid, r, c), spec)
  if (!res) return null
  const cross = res.colFieldLabel != null
  const head = `<tr><th>${PIVOT_ESC(res.rowFieldLabel)}</th>${cross ? res.colKeys.map((k) => `<th class="n">${PIVOT_ESC(k)}</th>`).join('') : ''}<th class="n">${res.agg === 'count' ? 'Count' : 'Total'}</th></tr>`
  const rows = res.rows
    .map((row) => `<tr><td>${PIVOT_ESC(row.key || '(blank)')}</td>${cross ? row.cells.map((v) => `<td class="n">${PIVOT_ESC(pivotNumber(v))}</td>`).join('') : ''}<td class="n b">${PIVOT_ESC(pivotNumber(row.total))}</td></tr>`)
    .join('')
  const total = `<tr class="gt"><td>Grand total</td>${cross ? res.colKeys.map(() => '<td></td>').join('') : ''}<td class="n b">${PIVOT_ESC(pivotNumber(res.grandTotal))}</td></tr>`
  const cols = 2 + (cross ? res.colKeys.length : 0)
  const w = Math.min(640, 120 + cols * 90)
  const h = 26 * (res.rows.length + 2) + 4
  return {
    html: `<table class="pivot" style="width:${w}px;border-collapse:collapse;font:10pt Arial,Helvetica,sans-serif"><thead>${head}</thead><tbody>${rows}${total}</tbody></table><style>.pivot th,.pivot td{padding:4px 8px;border-bottom:1px solid #e2e2e2;text-align:left}.pivot .n{text-align:right}.pivot .b{font-weight:700}.pivot .gt td{font-weight:700;border-top:2px solid #999}</style>`,
    w,
    h
  }
}

/** The model for a workbook's ACTIVE tab (or `tabIndex`). */
export function sheetPrintModel(body: SheetBodyV2, tabIndex?: number, extras: SheetPrintExtras = {}): SheetPrintModel {
  const tab = tabIndex === undefined ? activeTab(body) : body.sheets[tabIndex] ?? activeTab(body)
  const workbook = makeWorkbook(body.sheets)
  const names = makeNames(body.names)
  const grid: Grid = { columns: tab.columns, rows: tab.rows }
  const box = printBox(tab)
  const model: SheetPrintModel = { sheetName: tab.name, cols: [], rows: [], cells: {}, showGridlines: tab.showGridlines !== false }
  if (!box) return model
  const hiddenRows = hiddenRowsOf(tab, grid, workbook)
  const hiddenCols = hiddenColsOf(tab)
  for (let c = box.c1; c <= box.c2; c++) if (!hiddenCols.has(c)) model.cols.push({ c, w: tab.colWidths?.[c] ?? SHEET_DEFAULT_COL_W })
  const repeat = parseRowRange(tab.repeatRows)
  const isRepeat = (r: number): boolean => !!repeat && r >= repeat.r1 && r <= repeat.r2
  // Repeat rows print at the top of every page (page 1 included), so they are
  // not also printed in their place.
  for (let r = box.r1; r <= box.r2; r++) if (!hiddenRows.has(r) && !isRepeat(r)) model.rows.push({ r, h: tab.rowHeights?.[r] ?? SHEET_DEFAULT_ROW_H })
  if (repeat) {
    model.repeatRows = []
    for (let r = repeat.r1; r <= repeat.r2; r++) if (!hiddenRows.has(r)) model.repeatRows.push({ r, h: tab.rowHeights?.[r] ?? SHEET_DEFAULT_ROW_H })
    if (!model.repeatRows.length) delete model.repeatRows
  }
  const spill = buildSpillMap(grid, workbook, names)
  // The conditional decorations' per-rule min/max, exactly as SheetGrid's condStats computes them.
  const condStats = (tab.condRules ?? []).filter(isVisualCond).map((rule) => {
    const rg = parseA1Range(rule.range)
    let min = Infinity
    let max = -Infinity
    if (rg) {
      for (let r = rg.r1; r <= rg.r2; r++) {
        for (let c = rg.c1; c <= rg.c2; c++) {
          const n = condNumber(displayCell(grid, r, c, workbook, spill, names))
          if (n !== null) {
            if (n < min) min = n
            if (n > max) max = n
          }
        }
      }
    }
    return { rule, min, max, ok: min <= max }
  })
  for (const { r } of [...(model.repeatRows ?? []), ...model.rows]) {
    for (const { c } of model.cols) {
      const computed = displayCell(grid, r, c, workbook, spill, names)
      const fmt = applyCondFormat(cellFormat(tab, r, c), tab.condRules, r, c, computed)
      const text = formatValue(computed, fmt?.numFmt)
      // The grid's rich conditional formats: colour scale, data bar, icon set.
      let scaleBg: string | undefined
      let bar: SheetPrintCell['bar']
      let icon: SheetPrintCell['icon']
      const cv = condStats.length ? condNumber(computed) : null
      if (cv !== null) {
        for (const s of condStats) {
          if (!s.ok || !rangeHas(s.rule.range, r, c)) continue
          if (s.rule.kind === 'colorScale') scaleBg = colorScaleColor(s.rule, cv, s.min, s.max) ?? scaleBg
          else if (s.rule.kind === 'dataBar') bar = { pct: dataBarPct(cv, s.min, s.max), color: s.rule.barColor ?? '#63be7b' }
          else if (s.rule.kind === 'iconSet') icon = iconForValue(s.rule, cv, s.min, s.max) ?? icon
        }
      }
      // A =SPARKLINE(...) cell: the grid's own SparklineCell, as static SVG.
      const sparkline = sparklineForCell(grid, r, c, workbook, names)
      const width = tab.colWidths?.[c] ?? SHEET_DEFAULT_COL_W
      const svg = sparkline
        ? renderToStaticMarkup(createElement(SparklineCell, { r, c, values: sparkline.values, type: sparkline.type, width: width - 16 }))
        : undefined
      if (!text && !fmt?.bg && !scaleBg && !svg) continue
      const cell: SheetPrintCell = { text: svg ? '' : text }
      if (svg) cell.svg = svg
      if (bar) cell.bar = bar
      if (icon) cell.icon = icon
      if (fmt?.bold) cell.bold = true
      if (fmt?.italic) cell.italic = true
      if (fmt?.underline) cell.underline = true
      const color = ERROR_VALUE.test(computed) ? '#ef4444' : fmt?.color
      if (color) cell.color = color
      const bg = scaleBg ?? fmt?.bg
      if (bg) cell.bg = bg
      if (fmt?.fontFamily) cell.fontFamily = fmt.fontFamily
      cell.align = fmt?.align ?? (computed !== '' && Number.isFinite(Number(computed)) ? 'right' : 'left')
      model.cells[`${r},${c}`] = cell
    }
  }
  const inBox = (m: { r1: number; c1: number; r2: number; c2: number }): boolean =>
    m.r1 >= box.r1 && m.c1 >= box.c1 && m.r2 <= box.r2 && m.c2 <= box.c2
  const merges = (tab.merges ?? []).filter(inBox)
  if (merges.length) model.merges = merges.map((m) => ({ r1: m.r1, c1: m.c1, r2: m.r2, c2: m.c2 }))

  // Placed work widgets, at their spot in PRINTED sheet space (hidden and
  // unprinted columns/rows taken out). One whose top-left is outside the
  // printed cells is outside the print, as in Excel.
  const colAt = new Map(model.cols.map((col, i) => [col.c, i]))
  const rowAt = new Map(model.rows.map((row, i) => [row.r, i]))
  const colX = (i: number): number => model.cols.slice(0, i).reduce((s, x) => s + x.w, 0)
  const rowY = (i: number): number => model.rows.slice(0, i).reduce((s, x) => s + x.h, 0)
  const widthOf = (c: number): number => tab.colWidths?.[c] ?? SHEET_DEFAULT_COL_W
  const heightOf = (r: number): number => tab.rowHeights?.[r] ?? SHEET_DEFAULT_ROW_H
  /** A point on the editor's sheet surface (cellOffset space) → printed space, or null if not printed. */
  const toPrinted = (x: number, y: number): { x: number; y: number } | null => {
    let c = 0
    let left = ROW_HEADER_W
    while (c < tab.columns.length - 1 && left + widthOf(c) <= x) left += widthOf(c++)
    let r = 0
    let top = HEADER_H
    while (r < tab.rows.length - 1 && top + heightOf(r) <= y) top += heightOf(r++)
    const ci = colAt.get(c)
    const ri = rowAt.get(r)
    if (ci === undefined || ri === undefined) return null
    return { x: colX(ci) + Math.max(0, x - left), y: rowY(ri) + Math.max(0, y - top) }
  }
  const overlays: SheetPrintOverlay[] = []
  for (const pl of tab.widgets ?? []) {
    let at: { x: number; y: number } | null
    if (pl.mode === 'cell') {
      const ci = colAt.get(pl.c ?? 0)
      const ri = rowAt.get(pl.r ?? 0)
      at = ci === undefined || ri === undefined ? null : { x: colX(ci), y: rowY(ri) }
    } else at = toPrinted(pl.x ?? 0, pl.y ?? 0)
    if (!at) continue
    const name = extras.widgetNames?.[pl.widgetId] ?? extras.widgetNames?.[pl.id]
    overlays.push({ ...at, w: pl.w, h: pl.h, label: `${name || 'Work widget'} · live work widget, not printed` })
  }
  if (overlays.length) model.overlays = overlays

  // Charts and pivot tables, after the cells (on screen they sit below the grid).
  const blocks: SheetPrintBlock[] = []
  for (const spec of tab.charts ?? []) {
    const label = spec.title || `${spec.type[0].toUpperCase()}${spec.type.slice(1)} chart`
    const snap = extras.chartSnapshots?.[spec.id]
    blocks.push(snap ? { label, html: snap.html, w: snap.w, h: snap.h } : { label: `${label} · chart not on screen, not printed`, w: 480, h: 220 })
  }
  for (const spec of tab.pivots ?? []) {
    const label = spec.title || 'Pivot table'
    const p = pivotHtml(tab, spec)
    blocks.push(p ? { label, ...p } : { label: `${label} · its source range is not valid, not printed`, w: 480, h: 80 })
  }
  if (blocks.length) model.blocks = blocks
  return model
}
