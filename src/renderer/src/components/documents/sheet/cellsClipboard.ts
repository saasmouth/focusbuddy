// What a PlexiiCells copy puts on the clipboard (shared/cellsClipboardFormat.ts
// says why the two flavours, and what the envelope holds).
//
// Pure: the tab, the selection and how a cell displays go in, the two strings
// come out, so the payload is unit-testable without a grid. The TSV is
// sheetOps.rangeToTsv of the selection, exactly what ⌘C has always written;
// the body is sheetBodyFromSelection, the SAME capture "Save selection as
// snippet" uses, so a paste and a saved snippet of one range are the same
// body. There is no second serialiser.

import type { SheetTab } from '@shared/types'
import { buildCellsClipboard, serializeCellsClipboard } from '@shared/cellsClipboardFormat'
import { sheetBodyFromSelection } from './cellsSnippets'
import { rangeToTsv, type CellRange } from './sheetOps'

export interface CellsCopy {
  /** text/plain: the selection as TSV, unchanged. */
  tsv: string
  /** The envelope under CELLS_CLIP_MIME; null when the range holds nothing a snippet would. */
  json: string | null
  /** The block's top-left on the sheet (what Cells' own paste shifts formulas by). */
  origin: { r: number; c: number }
}

/**
 * The clipboard payload for copying `selection` of `tab`. `display(r, c)` is
 * what the cell at sheet coordinates r, c shows (Cells' formula engine over the
 * whole workbook, as the grid renders it).
 */
export function cellsCopyPayload(tab: SheetTab, selection: CellRange, display: (r: number, c: number) => string): CellsCopy {
  const tsv = rangeToTsv(tab, selection)
  const origin = { r: selection.r0, c: selection.c0 }
  const body = sheetBodyFromSelection(tab, selection)
  if (!body) return { tsv, json: null, origin }
  const o = body.origin ?? origin
  const width = Math.max(0, ...body.rows.map((r) => r.length))

  // The copied columns' widths, by column of the block, where the sheet set one.
  const widths: Record<number, number> = {}
  for (let j = 0; j < width; j++) {
    const w = tab.colWidths?.[o.c + j]
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) widths[j] = w
  }
  if (Object.keys(widths).length) body.colWidths = widths

  // What the cells displayed, only when that is not simply their input.
  const values = body.rows.map((row, i) => row.map((_, j) => display(o.r + i, o.c + j)))
  const differs = values.some((row, i) => row.some((v, j) => v !== body.rows[i][j]))
  return { tsv, json: serializeCellsClipboard(buildCellsClipboard(body, differs ? values : null)), origin }
}
