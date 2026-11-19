// Pure helpers for cell-range selection, copy, paste and fill in the typed
// Table work widget. The table stores rows as objects keyed by column id (unlike
// the sheet's positional string grid), so paste coerces each value to the
// destination column's type via coerceCellValue: a bad value becomes the typed
// empty/null, never a fabricated one.
//
// What goes on the clipboard is what the table SHOWS (a date as 2026-11-19, a
// choice by its label), as TSV for spreadsheets and as an HTML table for
// documents and mail. Stored forms (epoch milliseconds, option ids) mean
// nothing anywhere else, and coerceCellValue reads the shown forms back.

import type { FbRow, FieldDefinition } from '@shared/fields'
import { coerceCellValue } from './actionExecutor'
import { extendSeries } from './sheetFill'

export interface RC {
  r: number
  c: number
}

export interface RCRange {
  r0: number
  c0: number
  r1: number
  c1: number
}

export function normCellRange(a: RC, b: RC): RCRange {
  return {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c)
  }
}

export function inCellRange(range: RCRange | null, r: number, c: number): boolean {
  if (!range) return false
  return r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1
}

/**
 * A stored cell value as the table shows it, as plain text. Choices by their
 * label, dates as the day (or day and time) the cell shows, numbers as written,
 * checkboxes as true/false: every form coerceCellValue reads back.
 */
export function cellDisplayText(v: unknown, col?: Pick<FieldDefinition, 'type' | 'config'> | null): string {
  if (v == null) return ''
  const type = col?.type
  if (type === 'date' && typeof v === 'number' && Number.isFinite(v)) {
    const withTime = !!(col?.config as { withTime?: boolean } | undefined)?.withTime
    return new Date(v).toISOString().slice(0, withTime ? 16 : 10)
  }
  if (type === 'single-select' || type === 'multi-select') {
    const options = ((col?.config as { options?: Array<{ id: string; label: string }> } | undefined)?.options) ?? []
    const label = (id: unknown): string => options.find((o) => o.id === id)?.label ?? String(id)
    return Array.isArray(v) ? v.map(label).join(', ') : label(v)
  }
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/** The selected range as rows of shown text. */
export function rangeMatrix(rows: FbRow[], columns: FieldDefinition[], range: RCRange): string[][] {
  const out: string[][] = []
  for (let r = range.r0; r <= range.r1; r++) {
    const cells: string[] = []
    for (let c = range.c0; c <= range.c1; c++) {
      const col = columns[c]
      // A tab or line break inside a cell would split it into two cells or
      // two rows in TSV; spreadsheets read a space there.
      cells.push(col ? cellDisplayText(rows[r]?.cells[col.id], col).replace(/[\t\r\n]+/g, ' ') : '')
    }
    out.push(cells)
  }
  return out
}

// Serialize a selected range of table cells to TSV.
export function cellsToTsv(rows: FbRow[], columns: FieldDefinition[], range: RCRange): string {
  return rangeMatrix(rows, columns, range)
    .map((cells) => cells.join('\t'))
    .join('\n')
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The same range as an HTML table: what Write, Mail, Word and Google Docs keep
 * as rows and columns (Sheets and Excel read either). The column names are a
 * header row only when the whole width of the table is copied with its first
 * row, so a block from the middle stays a plain block.
 */
export function cellsToHtml(rows: FbRow[], columns: FieldDefinition[], range: RCRange): string {
  const body = rangeMatrix(rows, columns, range)
    .map((cells) => `<tr>${cells.map((t) => `<td>${escapeHtml(t)}</td>`).join('')}</tr>`)
    .join('')
  return `<meta charset="utf-8"><table><tbody>${body}</tbody></table>`
}

export interface TablePastePlan {
  updates: { rowId: string; cells: Record<string, unknown> }[]
  /** Rows the paste runs past the end of the table, as cells for new rows (grow). */
  newRows: Record<string, unknown>[]
  clippedRows: number // rows the paste would have needed but that don't exist (when not growing)
}

// Compute the row updates for pasting `matrix` into the table selection.
// A single clipboard cell fills the whole selection; a block is written from the
// selection's top-left at its own size. Values are coerced per destination
// column. Rows past the end of the table become new rows when `grow` is set
// (what a spreadsheet does: the paste lands whole); otherwise the paste is
// clipped and the count reported so the caller can say so.
export function planTablePaste(opts: {
  rows: FbRow[]
  columns: FieldDefinition[]
  range: RCRange
  matrix: string[][]
  grow?: boolean
}): TablePastePlan {
  const { rows, columns, range, matrix } = opts
  const single = matrix.length === 1 && matrix[0].length === 1
  const updatesMap = new Map<string, Record<string, unknown>>()
  const newRows: Record<string, unknown>[] = []

  const writeCell = (rIndex: number, cIndex: number, raw: string): void => {
    const col = columns[cIndex]
    if (!col) return
    const value = coerceCellValue(col.type, raw, col.config)
    const row = rows[rIndex]
    if (!row) {
      if (!opts.grow) return
      const k = rIndex - rows.length
      while (newRows.length <= k) newRows.push({})
      newRows[k][col.id] = value
      return
    }
    const cur = updatesMap.get(row.id) ?? {}
    cur[col.id] = value
    updatesMap.set(row.id, cur)
  }

  let neededRows = 0
  if (single) {
    const raw = matrix[0][0]
    for (let r = range.r0; r <= range.r1; r++)
      for (let c = range.c0; c <= range.c1; c++) writeCell(r, c, raw)
    neededRows = range.r1 + 1
  } else {
    for (let i = 0; i < matrix.length; i++)
      for (let j = 0; j < matrix[i].length; j++) writeCell(range.r0 + i, range.c0 + j, matrix[i][j])
    neededRows = range.r0 + matrix.length
  }

  return {
    updates: Array.from(updatesMap.entries()).map(([rowId, cells]) => ({ rowId, cells })),
    newRows,
    clippedRows: opts.grow ? 0 : Math.max(0, neededRows - rows.length)
  }
}

/**
 * Which way a fill handle dragged from `source` to the cell under the pointer
 * goes, and the range it covers (source included), along ONE axis: the one the
 * pointer has moved further out on, as in Sheets and Excel. Null while the
 * pointer is still inside the source.
 */
export function fillTarget(source: RCRange, at: RC): { dir: 'down' | 'up' | 'right' | 'left'; range: RCRange } | null {
  const down = at.r - source.r1
  const up = source.r0 - at.r
  const right = at.c - source.c1
  const left = source.c0 - at.c
  const best = Math.max(down, up, right, left)
  if (best <= 0) return null
  if (best === down) return { dir: 'down', range: { ...source, r1: at.r } }
  if (best === up) return { dir: 'up', range: { ...source, r0: at.r } }
  if (best === right) return { dir: 'right', range: { ...source, c1: at.c } }
  return { dir: 'left', range: { ...source, c0: at.c } }
}

/**
 * The cell updates a fill makes: each line along the fill (a column when
 * filling down or up, a row when filling across) continues its own source
 * values with the sheet's series rules (lib/sheetFill: 1, 2 → 3, 4; dates;
 * months; "Item 1" → "Item 2"; anything else repeats), coerced to the column
 * each value lands in. The source itself is never rewritten.
 */
export function planTableFill(opts: {
  rows: FbRow[]
  columns: FieldDefinition[]
  source: RCRange
  target: { dir: 'down' | 'up' | 'right' | 'left'; range: RCRange }
}): { rowId: string; cells: Record<string, unknown> }[] {
  const { rows, columns, source, target } = opts
  const updates = new Map<string, Record<string, unknown>>()
  const text = (r: number, c: number): string => cellDisplayText(rows[r]?.cells[columns[c]?.id ?? ''], columns[c])
  const put = (r: number, c: number, raw: string): void => {
    const row = rows[r]
    const col = columns[c]
    if (!row || !col) return
    const cur = updates.get(row.id) ?? {}
    cur[col.id] = coerceCellValue(col.type, raw, col.config)
    updates.set(row.id, cur)
  }
  const keep = (v: string): string => v
  const { dir, range } = target
  if (dir === 'down' || dir === 'up') {
    const count = dir === 'down' ? range.r1 - source.r1 : source.r0 - range.r0
    for (let c = source.c0; c <= source.c1; c++) {
      const seed: string[] = []
      for (let r = source.r0; r <= source.r1; r++) seed.push(text(r, c))
      const ordered = dir === 'down' ? seed : [...seed].reverse()
      const next = extendSeries(ordered, count, keep)
      next.forEach((v, k) => put(dir === 'down' ? source.r1 + 1 + k : source.r0 - 1 - k, c, v))
    }
  } else {
    const count = dir === 'right' ? range.c1 - source.c1 : source.c0 - range.c0
    for (let r = source.r0; r <= source.r1; r++) {
      const seed: string[] = []
      for (let c = source.c0; c <= source.c1; c++) seed.push(text(r, c))
      const ordered = dir === 'right' ? seed : [...seed].reverse()
      const next = extendSeries(ordered, count, keep)
      next.forEach((v, k) => put(r, dir === 'right' ? source.c1 + 1 + k : source.c0 - 1 - k, v))
    }
  }
  return Array.from(updates.entries()).map(([rowId, cells]) => ({ rowId, cells }))
}

/**
 * A table in pasted HTML (a web page, Word, Numbers) as rows of cell text, for
 * a clipboard that carries no tab-separated text. Null when it holds no table.
 */
export function htmlTableMatrix(html: string): string[][] | null {
  if (!html || !/<table[\s>]/i.test(html) || typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return null
  const out: string[][] = []
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.querySelectorAll('th, td')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())
    if (cells.length) out.push(cells)
  }
  return out.length ? out : null
}
