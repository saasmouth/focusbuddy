// Rows of cell values in the shapes other apps hold them: PlexiiWrite's TipTap
// table, a GFM table, tab-separated text. Pure.

import { gfmTable, padRows } from './tiptap'

const NUMERIC = /^[-+]?[$€£¥]?\s*\(?[-+]?\d[\d,]*(\.\d+)?\)?\s*%?$/

/**
 * Does the first row read as column headings? Every filled cell is text that
 * is not a number, at least one is filled, and there is something under it.
 * A block of figures never gets a bold first row it did not have.
 */
export function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false
  const first = rows[0].map((c) => c.trim()).filter(Boolean)
  if (!first.length) return false
  return first.every((c) => !NUMERIC.test(c) && !/^#[A-Z/0!?]+$/.test(c))
}

/** A TipTap paragraph holding `text`, newlines as hard breaks; an empty one for no text. */
export function paragraphNode(text: string, marks?: Array<{ type: string }>): Record<string, unknown> {
  if (!text) return { type: 'paragraph' }
  const content: Array<Record<string, unknown>> = []
  text.split('\n').forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' })
    if (line) content.push(marks?.length ? { type: 'text', text: line, marks } : { type: 'text', text: line })
  })
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

/**
 * Rows as one PlexiiWrite table node: TableKit's table/tableRow, with
 * tableHeader cells for a heading row and tableCell otherwise, each holding
 * one paragraph (the shape Write itself stores). Ragged rows are padded.
 */
export function rowsToTableNode(rows: string[][], header: boolean): Record<string, unknown> {
  const padded = padRows(rows)
  return {
    type: 'table',
    content: padded.map((row, r) => ({
      type: 'tableRow',
      content: row.map((cell) => ({
        type: header && r === 0 ? 'tableHeader' : 'tableCell',
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: [paragraphNode(cell)]
      }))
    }))
  }
}

/** Rows as a GFM table. Cells' pipes are escaped and their newlines become spaces. */
export function rowsToGfm(rows: string[][]): string {
  return gfmTable(rows.map((r) => r.map((c) => c.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim())))
}

/** Rows as tab-separated text, one line per row (what a spreadsheet pastes). */
export function rowsToTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
}
