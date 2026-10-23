// Spreadsheet body normalization and tab helpers.
//
// On disk a sheet body may be the legacy v1 shape ({ columns, rows }) or the v2
// shape ({ version: 2, sheets: [...] }). Every consumer funnels the raw body
// through normalizeBody first, so the rest of the editor only ever deals with
// v2. The lift is one-way and happens in memory; the file is only rewritten as
// v2 once the user edits and the body is saved back.

import type {
  SheetBody,
  SheetBodyV2,
  SheetCellFormat,
  SheetTab
} from '@shared/types'

export function isV2(body: SheetBody): body is SheetBodyV2 {
  return (body as SheetBodyV2).version === 2 && Array.isArray((body as SheetBodyV2).sheets)
}

let tabSeq = 0
function tabId(): string {
  tabSeq += 1
  return `st-${tabSeq}-${tabSeq.toString(36)}`
}

// Lift any body to v2. A v1 grid becomes a single tab named "Sheet 1". A v2 body
// is returned as-is (with light defensive defaults).
export function normalizeBody(body: SheetBody): SheetBodyV2 {
  if (isV2(body)) {
    const sheets = body.sheets.length
      ? body.sheets.map((s) => ({ ...s, columns: [...s.columns], rows: s.rows.map((r) => [...r]) }))
      : [emptyTab('Sheet 1')]
    return {
      version: 2,
      sheets,
      activeSheet: clampIndex(body.activeSheet ?? 0, sheets.length),
      ...(body.names ? { names: body.names } : {})
    }
  }
  const v1 = body as { columns?: string[]; rows?: string[][] }
  const columns = Array.isArray(v1.columns) && v1.columns.length ? [...v1.columns] : ['A', 'B', 'C']
  const rows = Array.isArray(v1.rows) ? v1.rows.map((r) => [...r]) : []
  return {
    version: 2,
    sheets: [{ id: tabId(), name: 'Sheet 1', columns, rows }],
    activeSheet: 0
  }
}

export function emptyTab(name: string, cols = 4, rows = 12): SheetTab {
  const columns = Array.from({ length: cols }, (_, i) => colLabel(i))
  return {
    id: tabId(),
    name,
    columns,
    rows: Array.from({ length: rows }, () => new Array(cols).fill(''))
  }
}

// "A", "B", ... "Z", "AA" — spreadsheet column labels.
export function colLabel(n: number): string {
  let s = ''
  n += 1
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/**
 * A column's own name, for its heading. Every column starts out named after its
 * letter (emptyTab, addColumn), and that default is not a name the user gave
 * it, so it reads as none: the heading already shows the letter, and showing it
 * twice made every new sheet read "A A", "B B" (rails-tabs-41 shots).
 */
export function columnName(name: string, c: number): string {
  return name === colLabel(c) ? '' : name
}

/**
 * Column names after columns move: a column still on its default name (its old
 * letter) takes the letter of its new place, so a default never goes stale and
 * shows up as a name ("B" sitting in column C). A name the user gave travels.
 * `from[newIndex]` is the old index, or -1 for a column that is new.
 */
export function reletterColumns(columns: string[], from: number[]): string[] {
  return from.map((old, i) => {
    if (old < 0) return colLabel(i)
    const name = columns[old] ?? colLabel(old)
    return name === colLabel(old) ? colLabel(i) : name
  })
}

function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i)) return 0
  return Math.max(0, Math.min(len - 1, Math.floor(i)))
}

export function activeTab(body: SheetBodyV2): SheetTab {
  return body.sheets[clampIndex(body.activeSheet ?? 0, body.sheets.length)]
}

// Replace one tab immutably and return a new body.
export function withTab(body: SheetBodyV2, index: number, next: SheetTab): SheetBodyV2 {
  const sheets = body.sheets.map((s, i) => (i === index ? next : s))
  return { ...body, sheets }
}

// Format-map key helpers.
export function fmtKey(r: number, c: number): string {
  return `${r},${c}`
}
export function parseFmtKey(key: string): { r: number; c: number } {
  const [r, c] = key.split(',').map(Number)
  return { r, c }
}

// Read a cell's format (or undefined). Safe against a missing format map.
export function cellFormat(tab: SheetTab, r: number, c: number): SheetCellFormat | undefined {
  return tab.formats?.[fmtKey(r, c)]
}
