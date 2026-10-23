import type { SheetBodyV2, SheetCellFormat, SheetTab } from '@shared/types'
import type { SheetSnippetBody } from '@shared/snippets'
import { emptyTab, fmtKey, normalizeBody, parseFmtKey } from '../../../lib/sheetBody'

// A sheet snippet, wrapped as a workbook so PlexiiCells can edit it, and
// unwrapped back afterwards.
//
// Pure on both sides, because the whole value is in the round trip: a snippet
// edited twice must be the same shape as a snippet edited once.
//
// THE WRAPPER IS BIGGER THAN THE SNIPPET, ON PURPOSE. A 2x2 block in a 2x2 grid
// leaves nowhere to type, so the session opens with room around it. Which makes
// trimming on the way out the important half — see unwrapSheetSnippet.

/** Minimum editing room around the block, in columns and rows. */
const MIN_COLS = 6
const MIN_ROWS = 14

export function wrapSheetSnippet(body: SheetSnippetBody, tabName = 'Snippet'): SheetBodyV2 {
  const rows = body.rows ?? []
  const width = rows.reduce((w, r) => Math.max(w, r.length), 1)
  const tab = emptyTab(tabName, Math.max(width, MIN_COLS), Math.max(rows.length, MIN_ROWS))
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
      tab.rows[r]![c] = rows[r]![c] ?? ''
    }
  }
  // The snippet's formats are already keyed relative to the block's top-left,
  // and the block lands at 0,0 here, so they transfer unchanged.
  if (body.formats && Object.keys(body.formats).length) {
    tab.formats = { ...(body.formats as Record<string, SheetCellFormat>) }
  }
  // Through normalizeBody rather than hand-built, so every invariant the rest of
  // Cells relies on holds without this file having to know what they are.
  return normalizeBody({ version: 2, sheets: [tab], activeSheet: 0 })
}

export function unwrapSheetSnippet(doc: SheetBodyV2): SheetSnippetBody {
  const tab: SheetTab | undefined = doc.sheets[0]
  if (!tab) return { kind: 'sheet', rows: [] }

  // TRIM BACK TO THE CONTENT. Without this the snippet grows by the editing room
  // every time it is opened and saved — a 2x2 block becomes 6x14 of mostly blank
  // cells, and then inserts as 6x14 everywhere it is used. The same class of bug
  // as a design snippet quietly growing a margins box.
  let lastRow = -1
  let lastCol = -1
  for (let r = 0; r < tab.rows.length; r++) {
    const row = tab.rows[r] ?? []
    for (let c = 0; c < row.length; c++) {
      if ((row[c] ?? '') !== '') {
        if (r > lastRow) lastRow = r
        if (c > lastCol) lastCol = c
      }
    }
  }
  if (lastRow < 0) return { kind: 'sheet', rows: [] }

  const rows = tab.rows.slice(0, lastRow + 1).map((row) => {
    const kept = row.slice(0, lastCol + 1)
    // Pad short rows so the block is rectangular, which is what every consumer
    // of a sheet body expects; ragged rows are padded on insert anyway.
    while (kept.length < lastCol + 1) kept.push('')
    return kept.map((v) => v ?? '')
  })

  // Formats outside the trimmed block are dropped rather than carried. Keeping
  // them would accumulate styling for cells the snippet no longer has, which
  // would then reappear if the block later grew.
  const formats: Record<string, SheetCellFormat> = {}
  for (const [key, value] of Object.entries(tab.formats ?? {})) {
    const at = parseFmtKey(key)
    if (!at) continue
    if (at.r > lastRow || at.c > lastCol) continue
    formats[fmtKey(at.r, at.c)] = value as SheetCellFormat
  }

  return {
    kind: 'sheet',
    rows,
    ...(Object.keys(formats).length ? { formats } : {})
  }
}
