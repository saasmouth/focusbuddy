// Pure structural operations on a spreadsheet tab.
//
// Every mutation returns a new SheetTab (immutable), so the editor can snapshot
// for undo and React can diff cheaply. Crucially, inserting or deleting rows and
// columns also shifts the sparse format map and column widths so formatting
// follows its cells. Formula references are intentionally NOT reindexed in this
// pass (a documented limit surfaced in the UI): inserting a row will not rewrite
// =SUM(A1:A3).

import type { SheetCellFormat, SheetTab } from '@shared/types'
import { colLabel, fmtKey, parseFmtKey, reletterColumns } from '../../../lib/sheetBody'
import { parseTsv as parseTsvShared } from '@shared/gridClipboard'

// Re-exported from the shared clipboard module so the sheet and the table parse
// copied ranges with one implementation.
export const parseTsv = parseTsvShared

export interface CellRange {
  r0: number
  c0: number
  r1: number
  c1: number
}

export function normalizeRange(a: { r: number; c: number }, b: { r: number; c: number }): CellRange {
  return {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c)
  }
}

export function rangeCells(range: CellRange): Array<{ r: number; c: number }> {
  const out: Array<{ r: number; c: number }> = []
  for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) out.push({ r, c })
  return out
}

export function setCell(tab: SheetTab, r: number, c: number, value: string): SheetTab {
  const rows = tab.rows.map((row, ri) => (ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row))
  return { ...tab, rows }
}

export function setColumnName(tab: SheetTab, c: number, name: string): SheetTab {
  return { ...tab, columns: tab.columns.map((col, ci) => (ci === c ? name : col)) }
}

export function addRow(tab: SheetTab): SheetTab {
  return { ...tab, rows: [...tab.rows, new Array(tab.columns.length).fill('')] }
}

export function addColumn(tab: SheetTab): SheetTab {
  return {
    ...tab,
    columns: [...tab.columns, colLabel(tab.columns.length)],
    rows: tab.rows.map((row) => [...row, ''])
  }
}

// Remap the format map after a row/column insert or delete. `axis` selects which
// coordinate shifts; `at` is the insert/delete index; `delta` is +1 (insert) or
// -1 (delete).
function shiftFormats(
  formats: Record<string, SheetCellFormat> | undefined,
  axis: 'row' | 'col',
  at: number,
  delta: 1 | -1
): Record<string, SheetCellFormat> | undefined {
  if (!formats) return formats
  const next: Record<string, SheetCellFormat> = {}
  for (const [key, fmt] of Object.entries(formats)) {
    const { r, c } = parseFmtKey(key)
    const coord = axis === 'row' ? r : c
    if (delta === -1 && coord === at) continue // deleted line's formats drop
    const shifted = coord >= at ? coord + delta : coord
    const nr = axis === 'row' ? shifted : r
    const nc = axis === 'col' ? shifted : c
    next[fmtKey(nr, nc)] = fmt
  }
  return next
}

function shiftWidths(
  widths: Record<number, number> | undefined,
  at: number,
  delta: 1 | -1
): Record<number, number> | undefined {
  if (!widths) return widths
  const next: Record<number, number> = {}
  for (const [k, w] of Object.entries(widths)) {
    const c = Number(k)
    if (delta === -1 && c === at) continue
    next[c >= at ? c + delta : c] = w
  }
  return next
}

export function insertRowAt(tab: SheetTab, index: number): SheetTab {
  const rows = [...tab.rows]
  rows.splice(index, 0, new Array(tab.columns.length).fill(''))
  return {
    ...tab,
    rows,
    formats: shiftFormats(tab.formats, 'row', index, 1),
    rowHeights: shiftWidths(tab.rowHeights, index, 1)
  }
}

export function deleteRowAt(tab: SheetTab, index: number): SheetTab {
  if (tab.rows.length <= 1) return tab
  const rows = tab.rows.filter((_, i) => i !== index)
  return {
    ...tab,
    rows,
    formats: shiftFormats(tab.formats, 'row', index, -1),
    rowHeights: shiftWidths(tab.rowHeights, index, -1)
  }
}

export function insertColAt(tab: SheetTab, index: number): SheetTab {
  // The new column is unnamed (its own letter); the ones it pushes right keep
  // their names, and a default name follows its column's new letter.
  const columns = reletterColumns(
    tab.columns,
    Array.from({ length: tab.columns.length + 1 }, (_, i) => (i === index ? -1 : i < index ? i : i - 1))
  )
  const rows = tab.rows.map((row) => {
    const r = [...row]
    r.splice(index, 0, '')
    return r
  })
  return {
    ...tab,
    columns,
    rows,
    formats: shiftFormats(tab.formats, 'col', index, 1),
    colWidths: shiftWidths(tab.colWidths, index, 1)
  }
}

export function deleteColAt(tab: SheetTab, index: number): SheetTab {
  if (tab.columns.length <= 1) return tab
  return {
    ...tab,
    columns: reletterColumns(
      tab.columns,
      Array.from({ length: tab.columns.length - 1 }, (_, i) => (i < index ? i : i + 1))
    ),
    rows: tab.rows.map((row) => row.filter((_, i) => i !== index)),
    formats: shiftFormats(tab.formats, 'col', index, -1),
    colWidths: shiftWidths(tab.colWidths, index, -1)
  }
}

// Reorder the format map / column widths through an explicit new-order array,
// where order[newIndex] = oldIndex. Used by row/column drag-reorder.
function reorderFormats(
  formats: Record<string, SheetCellFormat> | undefined,
  order: number[],
  axis: 'row' | 'col'
): Record<string, SheetCellFormat> | undefined {
  if (!formats) return formats
  const oldToNew: number[] = []
  order.forEach((oldIdx, newIdx) => (oldToNew[oldIdx] = newIdx))
  const next: Record<string, SheetCellFormat> = {}
  for (const [key, fmt] of Object.entries(formats)) {
    const { r, c } = parseFmtKey(key)
    const nr = axis === 'row' ? oldToNew[r] ?? r : r
    const nc = axis === 'col' ? oldToNew[c] ?? c : c
    next[fmtKey(nr, nc)] = fmt
  }
  return next
}

// Reorder rows to match `order` (order[newIndex] = oldIndex). Formula references
// are not rewritten here; the editor does that via remapFormulaRefs so a reorder
// can keep formulas pointing at the same data.
export function reorderRows(tab: SheetTab, order: number[]): SheetTab {
  const oldToNew: number[] = []
  order.forEach((oldIdx, newIdx) => (oldToNew[oldIdx] = newIdx))
  const heights = tab.rowHeights
    ? Object.fromEntries(
        Object.entries(tab.rowHeights).map(([k, h]) => [oldToNew[Number(k)] ?? Number(k), h])
      )
    : tab.rowHeights
  return {
    ...tab,
    rows: order.map((oi) => tab.rows[oi] ?? new Array(tab.columns.length).fill('')),
    formats: reorderFormats(tab.formats, order, 'row'),
    rowHeights: heights
  }
}

// Reorder columns to match `order` (order[newIndex] = oldIndex), carrying each
// column's header, cells, format and width to its new position.
export function reorderColumns(tab: SheetTab, order: number[]): SheetTab {
  const oldToNew: number[] = []
  order.forEach((oldIdx, newIdx) => (oldToNew[oldIdx] = newIdx))
  const widths = tab.colWidths
    ? Object.fromEntries(
        Object.entries(tab.colWidths).map(([k, w]) => [oldToNew[Number(k)] ?? Number(k), w])
      )
    : tab.colWidths
  return {
    ...tab,
    columns: reletterColumns(tab.columns, order),
    rows: tab.rows.map((row) => order.map((oi) => row[oi] ?? '')),
    formats: reorderFormats(tab.formats, order, 'col'),
    colWidths: widths
  }
}

// Build the new-order array for moving a contiguous block of `count` lines that
// starts at `from` so the block lands starting at index `to` (0-based, in the
// final array). order[newIndex] = oldIndex.
export function moveOrder(n: number, from: number, count: number, to: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  const block = order.splice(from, count)
  const clampedTo = Math.max(0, Math.min(to, order.length))
  order.splice(clampedTo, 0, ...block)
  return order
}

// Merge a format patch into every cell of a range.
export function applyFormat(tab: SheetTab, range: CellRange, patch: Partial<SheetCellFormat>): SheetTab {
  const formats = { ...(tab.formats ?? {}) }
  for (const { r, c } of rangeCells(range)) {
    const key = fmtKey(r, c)
    formats[key] = { ...formats[key], ...patch }
  }
  return { ...tab, formats }
}

// Write a matrix of values starting at the top-left of a range (used by paste,
// fill and AI). Grows the tab if the matrix overflows.
export function writeMatrix(tab: SheetTab, top: number, left: number, matrix: string[][]): SheetTab {
  const needRows = top + matrix.length
  const needCols = left + Math.max(0, ...matrix.map((r) => r.length))
  let columns = tab.columns
  let rows = tab.rows.map((r) => [...r])
  while (columns.length < needCols) columns = [...columns, colLabel(columns.length)]
  while (rows.length < needRows) rows.push(new Array(columns.length).fill(''))
  rows = rows.map((r) => {
    while (r.length < columns.length) r.push('')
    return r
  })
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      rows[top + i][left + j] = matrix[i][j]
    }
  }
  return { ...tab, columns, rows }
}

// Write one value into every cell of a range. This is the Ctrl+Enter / paste-a-
// single-cell-over-a-selection behaviour from Excel and Sheets. `transform`
// lets the caller adjust the value per target cell (used to relative-rewrite a
// formula so each filled cell points at its own row/column).
export function fillSelection(
  tab: SheetTab,
  range: CellRange,
  value: string,
  transform?: (value: string, r: number, c: number, anchorR: number, anchorC: number) => string
): SheetTab {
  const rows = tab.rows.map((r) => [...r])
  // Grow to cover the range so a selection past the current extent still fills.
  let columns = tab.columns
  while (columns.length <= range.c1) columns = [...columns, colLabel(columns.length)]
  while (rows.length <= range.r1) rows.push(new Array(columns.length).fill(''))
  rows.forEach((r) => {
    while (r.length < columns.length) r.push('')
  })
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      rows[r][c] = transform ? transform(value, r, c, range.r0, range.c0) : value
    }
  }
  return { ...tab, columns, rows }
}

// Paste a block tiled to fill a target range. When the range is an exact
// multiple of the block in each axis, the block repeats to fill it (Excel/Sheets
// behaviour); otherwise the block is written once at the range's top-left and the
// tab grows as needed (matching writeMatrix). `transform` adjusts each written
// value (relative formula rewrite) given its source offset within the block.
export function tileMatrix(
  tab: SheetTab,
  range: CellRange,
  matrix: string[][],
  transform?: (value: string, destR: number, destC: number, srcRowOffset: number, srcColOffset: number) => string
): SheetTab {
  const blockRows = matrix.length
  const blockCols = Math.max(0, ...matrix.map((r) => r.length))
  if (!blockRows || !blockCols) return tab
  const selRows = range.r1 - range.r0 + 1
  const selCols = range.c1 - range.c0 + 1
  // Only tile when the selection is a clean multiple of the block in both axes
  // and is larger than a single placement; otherwise place once at the corner.
  const tiles =
    selRows % blockRows === 0 &&
    selCols % blockCols === 0 &&
    (selRows > blockRows || selCols > blockCols)
  if (!tiles) {
    const out = transform
      ? matrix.map((row, i) => row.map((v, j) => transform(v, range.r0 + i, range.c0 + j, i, j)))
      : matrix
    return writeMatrix(tab, range.r0, range.c0, out)
  }
  const rows = tab.rows.map((r) => [...r])
  let columns = tab.columns
  while (columns.length <= range.c1) columns = [...columns, colLabel(columns.length)]
  while (rows.length <= range.r1) rows.push(new Array(columns.length).fill(''))
  rows.forEach((r) => {
    while (r.length < columns.length) r.push('')
  })
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      const si = (r - range.r0) % blockRows
      const sj = (c - range.c0) % blockCols
      const v = matrix[si]?.[sj] ?? ''
      rows[r][c] = transform ? transform(v, r, c, si, sj) : v
    }
  }
  return { ...tab, columns, rows }
}

// How far down a fill should extend when the user double-clicks the fill handle:
// the last contiguous filled row of the nearest neighbour column (left first,
// else right), bounded below the source range. Returns the source's bottom row
// when there is no neighbouring data to follow (nothing to extend into).
export function dataExtentBelow(tab: SheetTab, range: CellRange): number {
  const lastRow = tab.rows.length - 1
  const neighbour = (col: number): number | null => {
    if (col < 0 || col >= tab.columns.length) return null
    let end = range.r1
    for (let r = range.r1 + 1; r <= lastRow; r++) {
      if ((tab.rows[r]?.[col] ?? '').trim() === '') break
      end = r
    }
    return end > range.r1 ? end : null
  }
  const left = neighbour(range.c0 - 1)
  if (left !== null) return left
  const right = neighbour(range.c1 + 1)
  if (right !== null) return right
  return range.r1
}

// Fill the whole range with the value(s) from its first row (fill down).
export function fillDown(tab: SheetTab, range: CellRange): SheetTab {
  let rows = tab.rows.map((r) => [...r])
  for (let c = range.c0; c <= range.c1; c++) {
    const src = rows[range.r0]?.[c] ?? ''
    for (let r = range.r0 + 1; r <= range.r1; r++) rows[r][c] = src
  }
  return { ...tab, rows }
}

// Fill the whole range with the value(s) from its first column (fill right).
export function fillRight(tab: SheetTab, range: CellRange): SheetTab {
  const rows = tab.rows.map((r) => [...r])
  for (let r = range.r0; r <= range.r1; r++) {
    const src = rows[r]?.[range.c0] ?? ''
    for (let c = range.c0 + 1; c <= range.c1; c++) rows[r][c] = src
  }
  return { ...tab, rows }
}

// Sort the data rows by a column. A header row is not assumed; the caller can
// exclude it by sorting a sub-range later. Numbers sort numerically, text
// alphabetically, with numbers before text.
export function sortByColumn(tab: SheetTab, col: number, dir: 'asc' | 'desc'): SheetTab {
  const rows = [...tab.rows]
  rows.sort((a, b) => {
    const av = a[col] ?? ''
    const bv = b[col] ?? ''
    const an = Number(av)
    const bn = Number(bv)
    const aNum = av.trim() !== '' && Number.isFinite(an)
    const bNum = bv.trim() !== '' && Number.isFinite(bn)
    let cmp: number
    if (aNum && bNum) cmp = an - bn
    else if (aNum) cmp = -1
    else if (bNum) cmp = 1
    else cmp = av.localeCompare(bv)
    return dir === 'asc' ? cmp : -cmp
  })
  return { ...tab, rows }
}

export function setColWidth(tab: SheetTab, col: number, width: number): SheetTab {
  return { ...tab, colWidths: { ...(tab.colWidths ?? {}), [col]: Math.max(48, Math.round(width)) } }
}

export function setRowHeight(tab: SheetTab, row: number, height: number): SheetTab {
  return { ...tab, rowHeights: { ...(tab.rowHeights ?? {}), [row]: Math.max(20, Math.round(height)) } }
}

// Serialize a range to TSV for the clipboard, using raw cell text.
export function rangeToTsv(tab: SheetTab, range: CellRange): string {
  const lines: string[] = []
  for (let r = range.r0; r <= range.r1; r++) {
    const cells: string[] = []
    for (let c = range.c0; c <= range.c1; c++) cells.push(tab.rows[r]?.[c] ?? '')
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}
