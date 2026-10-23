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
// Not on paper yet: colour scales, data bars and icon sets (they need the whole
// range's statistics, which belong in a later pass), sparklines, charts and
// placed work widgets. The grid's purple tint on spilled values is an editing
// cue, so the paper prints them in the cell's own colour.

import type { SheetBodyV2, SheetTab } from '@shared/types'
import type { SheetPrintCell, SheetPrintModel } from '@shared/sheetPrint'
import { buildSpillMap, displayCell, makeNames, makeWorkbook, type Grid } from './sheetFormula'
import { applyCondFormat, isRowHidden, parseA1Range } from './sheetCond'
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

/** The model for a workbook's ACTIVE tab (or `tabIndex`). */
export function sheetPrintModel(body: SheetBodyV2, tabIndex?: number): SheetPrintModel {
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
  for (let r = box.r1; r <= box.r2; r++) if (!hiddenRows.has(r)) model.rows.push({ r, h: tab.rowHeights?.[r] ?? SHEET_DEFAULT_ROW_H })
  const spill = buildSpillMap(grid, workbook, names)
  for (const { r } of model.rows) {
    for (const { c } of model.cols) {
      const computed = displayCell(grid, r, c, workbook, spill, names)
      const fmt = applyCondFormat(cellFormat(tab, r, c), tab.condRules, r, c, computed)
      const text = formatValue(computed, fmt?.numFmt)
      if (!text && !fmt?.bg) continue
      const cell: SheetPrintCell = { text }
      if (fmt?.bold) cell.bold = true
      if (fmt?.italic) cell.italic = true
      if (fmt?.underline) cell.underline = true
      const color = ERROR_VALUE.test(computed) ? '#ef4444' : fmt?.color
      if (color) cell.color = color
      if (fmt?.bg) cell.bg = fmt.bg
      if (fmt?.fontFamily) cell.fontFamily = fmt.fontFamily
      cell.align = fmt?.align ?? (computed !== '' && Number.isFinite(Number(computed)) ? 'right' : 'left')
      model.cells[`${r},${c}`] = cell
    }
  }
  const inBox = (m: { r1: number; c1: number; r2: number; c2: number }): boolean =>
    m.r1 >= box.r1 && m.c1 >= box.c1 && m.r2 <= box.r2 && m.c2 <= box.c2
  const merges = (tab.merges ?? []).filter(inBox)
  if (merges.length) model.merges = merges.map((m) => ({ r1: m.r1, c1: m.c1, r2: m.r2, c2: m.c2 }))
  return model
}
