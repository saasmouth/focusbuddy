// PlexiiCells' clipboard flavour (shared/cellsClipboardFormat.ts) and what a
// Cells copy writes (documents/sheet/cellsClipboard.ts).
//
// The envelope on PlexiiDraw's pattern: it round-trips; a version this build
// does not know is REFUSED with its own sentence, never guessed at; anything
// malformed is not a Cells copy at all. The payload: the text/plain beside it
// is exactly the TSV ⌘C always wrote, and the body is exactly what "Save
// selection as snippet" captures of the same range, plus the copied columns'
// widths and what the cells displayed.

import { describe, expect, it } from 'vitest'
import {
  buildCellsClipboard,
  parseCellsClipboard,
  serializeCellsClipboard,
  CELLS_CLIPBOARD_KIND,
  CELLS_CLIPBOARD_VERSION,
  CELLS_CLIP_MIME,
  CELLS_NEWER_REFUSAL
} from '../../src/shared/cellsClipboardFormat'
import { cellsCopyPayload } from '../../src/renderer/src/components/documents/sheet/cellsClipboard'
import { sheetBodyFromSelection } from '../../src/renderer/src/components/documents/sheet/cellsSnippets'
import { rangeToTsv } from '../../src/renderer/src/components/documents/sheet/sheetOps'
import { displayCell, makeWorkbook } from '../../src/renderer/src/lib/sheetFormula'
import { emptyTab } from '../../src/renderer/src/lib/sheetBody'
import type { SheetSnippetBody } from '../../src/shared/snippets'
import type { SheetTab } from '../../src/shared/types'

/** A tab of `rows` × `cols` blank cells, with the given cells filled ("A1" style keys). */
function tabWith(cells: Record<string, string>, extra: Partial<SheetTab> = {}, rows = 8, cols = 6): SheetTab {
  let t: SheetTab = { ...emptyTab('Sheet 1') }
  t = { ...t, columns: Array.from({ length: cols }, (_, i) => String.fromCharCode(65 + i)), rows: Array.from({ length: rows }, () => new Array(cols).fill('')) }
  for (const [ref, v] of Object.entries(cells)) t.rows[Number(ref.slice(1)) - 1][ref.charCodeAt(0) - 65] = v
  return { ...t, ...extra }
}

/** How the grid displays a cell: Cells' engine over the whole workbook. */
function displayOf(tab: SheetTab): (r: number, c: number) => string {
  const wb = makeWorkbook([tab])
  const grid = { columns: tab.columns, rows: tab.rows }
  return (r, c) => displayCell(grid, r, c, wb)
}

const BODY: SheetSnippetBody = {
  kind: 'sheet',
  rows: [
    ['Item', 'Qty', 'Total'],
    ['Pens', '2', '=B3*$E$1']
  ],
  origin: { r: 1, c: 0 },
  formats: { '0,0': { bold: true }, '1,2': { bg: '#fde68a' } },
  merges: [],
  colWidths: { 0: 180 }
}

describe('the envelope', () => {
  it('round-trips: kind, version, body and the displayed values', () => {
    const json = serializeCellsClipboard(buildCellsClipboard(BODY, [['Item', 'Qty', 'Total'], ['Pens', '2', '6']]))
    const raw = JSON.parse(json)
    expect(raw.kind).toBe(CELLS_CLIPBOARD_KIND)
    expect(raw.version).toBe(CELLS_CLIPBOARD_VERSION)
    const back = parseCellsClipboard(json)
    expect(back).toEqual({ body: BODY, values: [['Item', 'Qty', 'Total'], ['Pens', '2', '6']] })
    // A fresh object: nothing the caller holds is shared.
    if (!back || !('body' in back)) throw new Error('expected a readable Cells envelope')
    expect(back.body.rows).not.toBe(BODY.rows)
  })

  it('values are optional, and absent when not given', () => {
    const back = parseCellsClipboard(serializeCellsClipboard(buildCellsClipboard(BODY)))
    expect(back).toEqual({ body: BODY, values: null })
  })

  it('a version this build does not know is refused with its own sentence, never guessed at', () => {
    for (const version of [2, 0, '1', undefined]) {
      const json = JSON.stringify({ kind: CELLS_CLIPBOARD_KIND, version, body: BODY })
      expect(parseCellsClipboard(json)).toEqual({ refused: CELLS_NEWER_REFUSAL })
    }
    expect(CELLS_NEWER_REFUSAL).toMatch(/newer PlexiiCells/)
  })

  it('malformed is not a Cells copy at all', () => {
    const env = (body: unknown): string => JSON.stringify({ kind: CELLS_CLIPBOARD_KIND, version: 1, body })
    for (const bad of [
      '',
      'Item\tQty',
      '{not json',
      JSON.stringify({ kind: 'plexiidraw/clipboard', version: 1, body: BODY }),
      JSON.stringify([1, 2]),
      env(null),
      env({ kind: 'doc', rows: [['a']] }),
      env({ kind: 'sheet' }),
      env({ kind: 'sheet', rows: 'a\tb' }),
      env({ kind: 'sheet', rows: [['a', 3]] }),
      env({ kind: 'sheet', rows: [] }),
      env({ kind: 'sheet', rows: [[]] })
    ]) {
      expect(parseCellsClipboard(bad)).toBeNull()
    }
    expect(parseCellsClipboard(null)).toBeNull()
  })

  it('only well-formed parts are kept: a bad origin, widths or values are dropped, never trusted', () => {
    const json = JSON.stringify({
      kind: CELLS_CLIPBOARD_KIND,
      version: 1,
      body: { kind: 'sheet', rows: [['a', 'b']], origin: { r: -1, c: 0 }, formats: 'bold', colWidths: { 0: 90, 1: -5, x: 4, 2: 'wide' } },
      // One cell short: a value could land in the wrong cell, so none are used.
      values: [['a']]
    })
    expect(parseCellsClipboard(json)).toEqual({ body: { kind: 'sheet', rows: [['a', 'b']], colWidths: { 0: 90 } }, values: null })
  })

  it('the private type is one of ours, so the main process hands it to a paste (application/x-plexii-*)', () => {
    expect(CELLS_CLIP_MIME).toMatch(/^application\/x-plexii-[a-z0-9.+-]+$/)
  })
})

describe('what a Cells copy writes', () => {
  const TAB = tabWith(
    { E1: '3', A2: 'Item', B2: 'Qty', C2: 'Total', A3: 'Pens', B3: '2', C3: '=B3*$E$1' },
    { formats: { '1,0': { bold: true }, '2,2': { bg: '#fde68a' } }, colWidths: { 0: 180, 4: 60 } }
  )
  const SEL = { r0: 1, c0: 0, r1: 2, c1: 2 }

  it('text/plain is exactly the TSV ⌘C has always written', () => {
    const out = cellsCopyPayload(TAB, SEL, displayOf(TAB))
    expect(out.tsv).toBe(rangeToTsv(TAB, SEL))
    expect(out.tsv).toBe('Item\tQty\tTotal\nPens\t2\t=B3*$E$1')
    expect(out.origin).toEqual({ r: 1, c: 0 })
  })

  it('the flavour is the saved-snippet capture of the range, plus the copied columns’ widths and what the cells showed', () => {
    const out = cellsCopyPayload(TAB, SEL, displayOf(TAB))
    const back = parseCellsClipboard(out.json)
    if (!back || !('body' in back)) throw new Error('expected a readable Cells envelope')
    const snippet = sheetBodyFromSelection(TAB, SEL)!
    expect(back.body).toEqual({ ...snippet, colWidths: { 0: 180 } })
    // C3 reads E1, outside the copied range: the copy carries the 6 the sheet showed.
    expect(back.values).toEqual([
      ['Item', 'Qty', 'Total'],
      ['Pens', '2', '6']
    ])
  })

  it('no values when every cell shows its input; no flavour at all for a range holding nothing', () => {
    const plain = tabWith({ A1: 'a', B1: 'b' })
    const out = cellsCopyPayload(plain, { r0: 0, c0: 0, r1: 0, c1: 1 }, displayOf(plain))
    expect(JSON.parse(out.json!).values).toBeUndefined()
    const empty = cellsCopyPayload(plain, { r0: 4, c0: 0, r1: 5, c1: 1 }, displayOf(plain))
    expect(empty.json).toBeNull()
    expect(empty.tsv).toBe('\t\n\t')
  })
})
