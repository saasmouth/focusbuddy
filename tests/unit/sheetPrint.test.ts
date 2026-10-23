// @vitest-environment node
// PlexiiCells on paper (4.3.41): the paging, the gridlines setting and the print
// area, from the tab's model to the HTML both Print… and Download ▸ PDF render.
import { describe, it, expect } from 'vitest'
import {
  bands,
  paginateSheet,
  paperForLocale,
  paperGeometry,
  printableSize,
  sheetPrintHtml,
  type SheetPrintModel
} from '../../src/shared/sheetPrint'
import { sheetPrintModel, usedRange, SHEET_DEFAULT_COL_W } from '../../src/renderer/src/lib/sheetPrintModel'
import { setPrintArea, setShowGridlines, pageSetupOf, rangeToA1, remapPrintArea, remapTabPrintArea } from '../../src/renderer/src/lib/sheetPageSetup'
import { normalizeBody } from '../../src/renderer/src/lib/sheetBody'
import type { SheetBodyV2, SheetTab } from '../../src/shared/types'

const A4 = paperGeometry('a4')

function tab(rows: string[][], extra: Partial<SheetTab> = {}): SheetTab {
  const n = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return { id: 't1', name: 'Sheet 1', columns: Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)), rows, ...extra }
}
const body = (t: SheetTab): SheetBodyV2 => ({ version: 2, sheets: [t], activeSheet: 0 })

/** Which page (0-based) holds a cell, from the rendered HTML. */
function pageOf(html: string, key: string): number {
  const sections = html.split('<section class="page"').slice(1)
  return sections.findIndex((s) => s.includes(`data-cell="${key}"`) && new RegExp(`data-cell="${key}"[^>]*>[^<]+<`).test(s))
}

describe('paper', () => {
  it('comes from the locale: A4 here, Letter where Letter is the norm', () => {
    expect(paperForLocale('en-AU')).toBe('a4')
    expect(paperForLocale('en-GB')).toBe('a4')
    expect(paperForLocale('de-DE')).toBe('a4')
    expect(paperForLocale('en-US')).toBe('letter')
    expect(paperForLocale('fr-CA')).toBe('letter')
    expect(paperForLocale('es_MX')).toBe('letter')
    expect(paperForLocale('en')).toBe('a4')
    expect(paperForLocale(undefined)).toBe('a4')
  })

  it('A4 is 210×297 mm at 96 dpi, with Excel’s Normal margins inside it', () => {
    expect(A4.width).toBeCloseTo(793.7, 1)
    expect(A4.height).toBeCloseTo(1122.5, 1)
    const area = printableSize(A4)
    expect(area.width).toBeCloseTo(793.7 - 1.4 * 96, 1)
    expect(area.height).toBeCloseTo(1122.5 - 1.5 * 96, 1)
  })
})

describe('paging: over, then down', () => {
  it('splits into bands that fit, and gives an oversized item a band of its own', () => {
    expect(bands([100, 100, 100], 250)).toEqual([{ start: 0, end: 1 }, { start: 2, end: 2 }])
    expect(bands([400, 50], 300)).toEqual([{ start: 0, end: 0 }, { start: 1, end: 1 }])
    expect(bands([], 300)).toEqual([])
  })

  it('a used range two pages wide prints as two pages, each cell on the page its column falls on', () => {
    // 16 columns of 64 px = 1024 px; A4's printable width is ~659 px (10 columns).
    const row = Array.from({ length: 16 }, (_, c) => `c${c}`)
    const model = sheetPrintModel(body(tab([row, row])))
    expect(model.cols).toHaveLength(16)
    const perPage = Math.floor(printableSize(A4).width / SHEET_DEFAULT_COL_W)
    expect(perPage).toBe(10)
    const pages = paginateSheet(model, A4)
    expect(pages).toHaveLength(2)
    expect(pages[0].cols).toEqual({ start: 0, end: 9 })
    expect(pages[1].cols).toEqual({ start: 10, end: 15 })
    const html = sheetPrintHtml(model, A4)
    expect(html.split('<section class="page"').length - 1).toBe(2)
    expect(pageOf(html, '0,0')).toBe(0)
    expect(pageOf(html, '0,9')).toBe(0)
    expect(pageOf(html, '0,10')).toBe(1)
    expect(pageOf(html, '1,15')).toBe(1)
  })

  it('goes across before it goes down', () => {
    // 2 column bands × 2 row bands: rows of 600 px force a second row band.
    const model: SheetPrintModel = {
      sheetName: 'S',
      cols: Array.from({ length: 12 }, (_, c) => ({ c, w: 64 })),
      rows: [{ r: 0, h: 600 }, { r: 1, h: 600 }],
      cells: {},
      showGridlines: true
    }
    const pages = paginateSheet(model, A4)
    expect(pages.map((p) => [p.rows.start, p.cols.start])).toEqual([[0, 0], [0, 10], [1, 0], [1, 10]])
  })

  it('an empty tab prints one blank page, never zero', () => {
    const model = sheetPrintModel(body(tab([['', ''], ['', '']])))
    expect(paginateSheet(model, A4)).toEqual([])
    expect(sheetPrintHtml(model, A4).split('<section class="page"').length - 1).toBe(1)
  })
})

describe('what a cell prints', () => {
  it('is what the grid shows: formulas computed, number formats applied, numbers right-aligned', () => {
    const t = tab([['Item', 'Cost'], ['Paper', '12.5'], ['Total', '=B2*2']], {
      formats: { '1,1': { numFmt: { kind: 'currency', decimals: 2, symbol: '$' } }, '0,0': { bold: true } }
    })
    const m = sheetPrintModel(body(t))
    expect(m.cells['2,1'].text).toBe('25')
    expect(m.cells['2,1'].align).toBe('right')
    expect(m.cells['1,1'].text).toBe('$12.50')
    expect(m.cells['0,0'].bold).toBe(true)
    expect(m.cells['0,0'].align).toBe('left')
  })

  it('error values print red, as on screen', () => {
    const m = sheetPrintModel(body(tab([['=1/0']])))
    expect(m.cells['0,0'].text).toMatch(/^#/)
    expect(m.cells['0,0'].color).toBe('#ef4444')
  })

  it('rows hidden by a collapsed group are not printed', () => {
    const t = tab([['a'], ['b'], ['c'], ['d']], { rowGroups: [{ start: 0, end: 2, collapsed: true }] })
    expect(sheetPrintModel(body(t)).rows.map((r) => r.r)).toEqual([0, 3])
  })

  it('escapes cell text, so a cell cannot inject markup', () => {
    const m = sheetPrintModel(body(tab([['<img src=x onerror=alert(1)>']])))
    const html = sheetPrintHtml(m, A4)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
  })
})

describe('gridlines', () => {
  it('print by default (an old sheet has no setting)', () => {
    const m = sheetPrintModel(body(tab([['a']])))
    expect(m.showGridlines).toBe(true)
    expect(sheetPrintHtml(m, A4)).toContain('<table class="grid">')
  })

  it('off renders none: no table carries the gridline class, and no cell border is drawn', () => {
    const off = setShowGridlines(body(tab([['a', 'b'], ['c', 'd']])), 0, false)
    const m = sheetPrintModel(off)
    expect(m.showGridlines).toBe(false)
    const html = sheetPrintHtml(m, A4)
    expect(html).not.toContain('<table class="grid">')
    expect(html).toContain('<table class="nogrid">')
    // The only rule that paints a cell border is scoped to table.grid.
    expect(html).toMatch(/table\.grid td \{ border-color: #d4d4d4; \}/)
    expect(html).toMatch(/td \{[^}]*border: 1px solid transparent;/)
  })
})

describe('print area', () => {
  it('absent: the used range (values, fills and merges), not the whole grid', () => {
    const t = tab([['', '', ''], ['', 'x', ''], ['', '', '']], { formats: { '2,2': { bg: '#ffff00' } } })
    expect(usedRange(t)).toEqual({ r1: 1, c1: 1, r2: 2, c2: 2 })
    const m = sheetPrintModel(body(t))
    expect(m.rows.map((r) => r.r)).toEqual([1, 2])
    expect(m.cols.map((c) => c.c)).toEqual([1, 2])
  })

  it('set: exactly that range, even past the used range', () => {
    const b = setPrintArea(body(tab([['a', 'b', 'c'], ['d', 'e', 'f']])), 0, 'B1:C4')
    expect(b.sheets[0].printArea).toBe('B1:C4')
    const m = sheetPrintModel(b)
    expect(m.cols.map((c) => c.c)).toEqual([1, 2])
    expect(m.rows.map((r) => r.r)).toEqual([0, 1, 2, 3])
  })

  it('from a selection box, normalised to A1; null clears it; nonsense is refused', () => {
    const b0 = body(tab([['a']]))
    const b1 = setPrintArea(b0, 0, { r1: 9, c1: 3, r2: 0, c2: 0 })
    expect(b1.sheets[0].printArea).toBe('A1:D10')
    expect(setPrintArea(b0, 0, '$b$2:$c$3').sheets[0].printArea).toBe('B2:C3')
    expect(setPrintArea(b0, 0, 'not a range')).toBe(b0)
    const cleared = setPrintArea(b1, 0, null)
    expect('printArea' in cleared.sheets[0]).toBe(false)
    expect(rangeToA1({ r1: 0, c1: 0, r2: 0, c2: 0 })).toBe('A1')
  })
})

describe('page setup on the body', () => {
  it('back on the defaults, a sheet is exactly what it was before page setup existed', () => {
    const before = body(tab([['a']]))
    const after = setShowGridlines(setPrintArea(setPrintArea(setShowGridlines(before, 0, false), 0, 'A1:B2'), 0, null), 0, true)
    expect(after).toEqual(before)
    expect(pageSetupOf(after.sheets[0])).toEqual({ showGridlines: true, printArea: null })
  })

  it('touches only the tab it is given', () => {
    const b: SheetBodyV2 = { version: 2, sheets: [tab([['a']]), { ...tab([['b']]), id: 't2', name: 'Sheet 2' }], activeSheet: 0 }
    const out = setShowGridlines(b, 1, false)
    expect(out.sheets[0]).toBe(b.sheets[0])
    expect(out.sheets[1].showGridlines).toBe(false)
    expect(setShowGridlines(b, 7, false)).toBe(b)
  })

  it('an old sheet round-trips unchanged, and the normaliser keeps both new fields', () => {
    // A v1 body (the legacy shape) and a v2 body saved before page setup existed.
    const v1 = { columns: ['A', 'B'], rows: [['1', '2']] }
    const n1 = normalizeBody(v1 as never)
    expect('showGridlines' in n1.sheets[0]).toBe(false)
    expect('printArea' in n1.sheets[0]).toBe(false)
    const oldV2 = body(tab([['x', '=A1']], { colWidths: { 0: 90 } }))
    expect(normalizeBody(JSON.parse(JSON.stringify(oldV2)))).toEqual(oldV2)
    // The Design normaliser once dropped fields it did not list; this one must not.
    const withSetup = setPrintArea(setShowGridlines(oldV2, 0, false), 0, 'A1:B1')
    const roundTrip = normalizeBody(JSON.parse(JSON.stringify(withSetup)))
    expect(roundTrip.sheets[0].showGridlines).toBe(false)
    expect(roundTrip.sheets[0].printArea).toBe('A1:B1')
    expect(roundTrip).toEqual(withSetup)
  })
})

describe('print area through structural edits (the maps fixFormulas uses)', () => {
  const insertRow = (at: number) => (r: number) => (r >= at ? r + 1 : r)
  const deleteRow = (at: number) => (r: number) => (r === at ? null : r > at ? r - 1 : r)
  const insertCol = insertRow
  const deleteCol = deleteRow
  const id = (i: number) => i

  it('a row inserted above moves the area with the data', () => {
    expect(remapPrintArea('B2:F30', insertRow(0), id)).toBe('B3:F31')
  })

  it('a row inserted inside grows it; a column inserted left of it moves it', () => {
    expect(remapPrintArea('B2:F30', insertRow(10), id)).toBe('B2:F31')
    expect(remapPrintArea('B2:F30', id, insertCol(0))).toBe('C2:G30')
  })

  it('an edit below or right of the area leaves it alone', () => {
    expect(remapPrintArea('B2:F30', insertRow(40), id)).toBe('B2:F30')
    expect(remapPrintArea('B2:F30', id, deleteCol(9))).toBe('B2:F30')
  })

  it('deleting some of its rows trims it to the rows that remain', () => {
    expect(remapPrintArea('B2:F30', deleteRow(1), id)).toBe('B2:F29')
    expect(remapPrintArea('B2:F30', deleteRow(0), id)).toBe('B1:F29')
  })

  it('deleting all of its rows, or all of its columns, CLEARS it, never repoints it', () => {
    expect(remapPrintArea('A3', deleteRow(2), id)).toBeUndefined()
    expect(remapPrintArea('C1:C9', id, deleteCol(2))).toBeUndefined()
  })

  it('on a tab: moved with the data, cleared field when gone, untouched when absent', () => {
    const t0 = tab([['a']], { printArea: 'B2:F30' })
    expect(remapTabPrintArea(t0, insertRow(0), id).printArea).toBe('B3:F31')
    const gone = remapTabPrintArea(tab([['a']], { printArea: 'A1' }), deleteRow(0), id)
    expect('printArea' in gone).toBe(false)
    const plain = tab([['a']])
    expect(remapTabPrintArea(plain, insertRow(0), id)).toBe(plain)
  })
})
