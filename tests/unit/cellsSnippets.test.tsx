// PlexiiCells as a saved-snippet surface (docs/saved-snippets.md, "Adding a
// snippet target" and "Why a spreadsheet offers Duplicate only"): capture is
// pure and keeps formulas as written, formats, merges and validation relative
// to the block; insertion is Cells' own paste of an in-app copy (relative
// references shifted by destination minus origin, absolute kept, the cells
// under it overwritten), pads ragged rows, never touches the snippet, and
// declines with a reason when read-only, off the sheet, splitting a merge, or
// when a formula would point above row 1. Then the target's contract:
// Duplicate only, registered while mounted, withdrawn on unmount, the reason
// reaching the store verbatim, and where the commands live on the shell.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: ({ name }: { name: string }) => <i data-icon={name} /> }))
vi.mock('../../src/renderer/src/components/Tooltip', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import {
  CELLS_SNIPPET_LINKS,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  cellsSnippetTargetId,
  expandToMerges,
  insertSheetSnippet,
  sheetBodyFromSelection,
  sheetSnippetNotKept,
  subtract,
  suggestedSheetSnippetName,
  useCellsSnippetTarget,
  type SheetSnippetPlacement
} from '../../src/renderer/src/components/documents/sheet/cellsSnippets'
import { useSnippetsStore } from '../../src/renderer/src/stores/snippets'
import {
  linkModesFor,
  snippetBodyIsEmpty,
  snippetBodyMatchesKind,
  snippetMatches,
  snippetSummary,
  type SheetSnippetBody,
  type Snippet,
  type SnippetInsertResult
} from '../../src/shared/snippets'
import { emptyTab } from '../../src/renderer/src/lib/sheetBody'
import { displayCell, rewriteFormulaRefs } from '../../src/renderer/src/lib/sheetFormula'
import { writeMatrix } from '../../src/renderer/src/components/documents/sheet/sheetOps'
import { ContextBar } from '../../src/renderer/src/components/office/shell'
import { CELLS_TABS, type CCtx } from '../../src/renderer/src/components/documents/sheet/cellsRibbon'
import { buildCellsCommands } from '../../src/renderer/src/components/documents/sheet/cellsCommands'
import type { SheetMenuActions } from '../../src/renderer/src/components/documents/editor/SheetMenuBar'
import type { SheetTab } from '../../src/shared/types'
import SaveSnippetDialog from '../../src/renderer/src/components/snippets/SaveSnippetDialog'

/** A tab of `rows` × `cols` blank cells, with the given cells filled ("A1" style keys). */
function tabWith(cells: Record<string, string>, rows = 10, cols = 6, extra: Partial<SheetTab> = {}): SheetTab {
  let t: SheetTab = { ...emptyTab('Sheet 1') }
  t = { ...t, columns: Array.from({ length: cols }, (_, i) => String.fromCharCode(65 + i)), rows: Array.from({ length: rows }, () => new Array(cols).fill('')) }
  for (const [ref, v] of Object.entries(cells)) {
    const c = ref.charCodeAt(0) - 65
    const r = Number(ref.slice(1)) - 1
    t.rows[r]![c] = v
  }
  return { ...t, ...extra }
}

const cell = (t: SheetTab, ref: string): string => t.rows[Number(ref.slice(1)) - 1]?.[ref.charCodeAt(0) - 65] ?? ''
const shown = (t: SheetTab, ref: string): string => displayCell({ columns: t.columns, rows: t.rows }, Number(ref.slice(1)) - 1, ref.charCodeAt(0) - 65)

function snippetOf(body: SheetSnippetBody): Snippet {
  return {
    id: 'snip-1',
    kind: 'sheet',
    name: 'Block',
    description: '',
    body,
    tags: [],
    scope: 'personal',
    orgId: 'personal',
    authorId: null,
    revision: 1,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

let ids = 0
const at = (r: number, c: number, over: Partial<SheetSnippetPlacement> = {}): SheetSnippetPlacement => ({
  at: { r, c },
  readOnly: false,
  newId: () => `dv-test-${++ids}`,
  ...over
})

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
  }
  return o
}

// The worked example from the brief: A1=2, A2=3, A3==A1+A2.
const SUM = tabWith({ A1: '2', A2: '3', A3: '=A1+A2' })
const A1_A3 = { r0: 0, c0: 0, r1: 2, c1: 0 }

describe('capture: sheetBodyFromSelection is pure', () => {
  it('returns null with no tab, no selection, or a range with nothing in it', () => {
    expect(sheetBodyFromSelection(null, A1_A3)).toBeNull()
    expect(sheetBodyFromSelection(SUM, null)).toBeNull()
    expect(sheetBodyFromSelection(SUM, { r0: 5, c0: 3, r1: 7, c1: 4 })).toBeNull()
  })

  it('keeps formulas as written (not their values) with the range’s top-left as origin', () => {
    const body = sheetBodyFromSelection(SUM, A1_A3)!
    expect(body).toEqual({ kind: 'sheet', rows: [['2'], ['3'], ['=A1+A2']], origin: { r: 0, c: 0 } })
    expect(shown(SUM, 'A3')).toBe('5') // the displayed value is not what is stored
  })

  it('takes the full rectangle, blanks included, in any corner order', () => {
    const t = tabWith({ B2: 'x', D3: 'y' })
    expect(sheetBodyFromSelection(t, { r0: 2, c0: 3, r1: 1, c1: 1 })!.rows).toEqual([
      ['x', '', ''],
      ['', '', 'y']
    ])
  })

  it('makes formats relative to the block and leaves cells outside it behind', () => {
    const t = tabWith({ B2: 'Total', C2: '9' }, 10, 6, {
      formats: { '1,1': { bold: true }, '1,2': { numFmt: { kind: 'currency', decimals: 2, symbol: '$' } }, '0,0': { italic: true }, '1,3': {} }
    })
    const body = sheetBodyFromSelection(t, { r0: 1, c0: 1, r1: 1, c1: 3 })!
    expect(body.formats).toEqual({ '0,0': { bold: true }, '0,1': { numFmt: { kind: 'currency', decimals: 2, symbol: '$' } } })
    expect(body.origin).toEqual({ r: 1, c: 1 })
  })

  it('carries merges inside the range, relative, and widens the range to take a crossing merge whole', () => {
    const t = tabWith({ B2: 'Head' }, 10, 6, { merges: [{ r1: 1, c1: 1, r2: 1, c2: 3 }] })
    // Selecting B2:C3 cuts the B2:D2 merge; Excel's selection would take D2 too.
    expect(expandToMerges(t, { r0: 1, c0: 1, r1: 2, c1: 2 })).toEqual({ r0: 1, c0: 1, r1: 2, c1: 3 })
    const body = sheetBodyFromSelection(t, { r0: 1, c0: 1, r1: 2, c1: 2 })!
    expect(body.rows).toEqual([
      ['Head', '', ''],
      ['', '', '']
    ])
    expect(body.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 2 }])
  })

  it('clips data validation to the block, relative, keeping its order and strictness', () => {
    const t = tabWith({ B2: 'yes' }, 10, 6, {
      validations: [
        { id: 'v1', range: 'A1:C9', rule: { kind: 'list', values: ['yes', 'no'] }, strict: true },
        { id: 'v2', range: 'F1:F2', rule: { kind: 'textNotEmpty' } }
      ]
    })
    const body = sheetBodyFromSelection(t, { r0: 1, c0: 1, r1: 3, c1: 3 })!
    expect(body.validations).toEqual([{ r1: 0, c1: 0, r2: 2, c2: 1, rule: { kind: 'list', values: ['yes', 'no'] }, strict: true }])
  })

  it('never shares an object with the tab, and never changes it', () => {
    const t = deepFreeze(tabWith({ A1: 'a' }, 4, 4, { formats: { '0,0': { bold: true } }, validations: [{ id: 'v', range: 'A1', rule: { kind: 'list', values: ['a'] } }] }))
    const body = sheetBodyFromSelection(t, { r0: 0, c0: 0, r1: 0, c1: 0 })!
    expect(body.formats!['0,0']).not.toBe(t.formats!['0,0'])
    expect(body.validations![0]!.rule).not.toBe(t.validations![0]!.rule)
    expect(body.rows[0]).not.toBe(t.rows[0])
  })

  it('names what the selection has that a snippet will not keep, and nothing when it has none', () => {
    expect(sheetSnippetNotKept(SUM, A1_A3)).toBeNull()
    const t = tabWith({ A1: '1' }, 10, 6, {
      condRules: [{ id: 'c', range: 'A1:A9', op: 'gt', value: '0', bg: '#fee2e2' }],
      colWidths: { 0: 120, 5: 90 },
      rowHeights: { 8: 40 }
    })
    expect(sheetSnippetNotKept(t, A1_A3)).toBe('Conditional formatting and column widths are not saved with a snippet.')
    expect(sheetSnippetNotKept(t, { r0: 0, c0: 1, r1: 8, c1: 1 })).toBe('Row heights are not saved with a snippet.')
    expect(sheetSnippetNotKept(t, { r0: 0, c0: 0, r1: 8, c1: 0 })).toBe('Conditional formatting, column widths and row heights are not saved with a snippet.')
    expect(sheetSnippetNotKept(tabWith({}, 4, 4, { condRules: [{ id: 'c', range: 'A1', op: 'gt', value: '0' }] }), { r0: 0, c0: 0, r1: 0, c1: 0 })).toBe(
      'Conditional formatting is not saved with a snippet.'
    )
  })

  it('suggests a name from the first text that is not a formula, or from the size', () => {
    expect(suggestedSheetSnippetName({ kind: 'sheet', rows: [['=A1'], ['Quarterly totals:']] })).toBe('Quarterly totals')
    expect(suggestedSheetSnippetName({ kind: 'sheet', rows: [['=1', '=2'], ['', '']] })).toBe('2 × 2 cells')
    expect(suggestedSheetSnippetName({ kind: 'sheet', rows: [['=1']] })).toBe('Cell')
  })
})

describe('insertion: insertSheetSnippet behaves like Cells’ paste', () => {
  const body = sheetBodyFromSelection(SUM, A1_A3)!

  it('lands at the active cell, shifts the relative formula, and recalculates', () => {
    const landing = insertSheetSnippet(SUM, snippetOf(body), at(0, 2))
    if ('declined' in landing) throw new Error(landing.declined)
    expect(landing.range).toEqual({ r0: 0, c0: 2, r1: 2, c1: 2 })
    const t = landing.tab
    expect([cell(t, 'C1'), cell(t, 'C2'), cell(t, 'C3')]).toEqual(['2', '3', '=C1+C2'])
    expect(shown(t, 'C3')).toBe('5')
    // The original is untouched.
    expect([cell(t, 'A1'), cell(t, 'A2'), cell(t, 'A3')]).toEqual(['2', '3', '=A1+A2'])
  })

  it('produces exactly what Cells’ ⌘V of an in-app copy produces', () => {
    const t = tabWith({ B2: '=A1*$A$1+A$1+$A1+SUM(A1:B2)+Sheet2!A1', B3: '=B2' })
    const sel = { r0: 1, c0: 1, r1: 2, c1: 1 }
    const b = sheetBodyFromSelection(t, sel)!
    const landing = insertSheetSnippet(t, snippetOf(b), at(4, 3))
    if ('declined' in landing) throw new Error(landing.declined)
    // SheetEditor's single-cell paste: rewriteFormulaRefs by focus minus origin, then writeMatrix.
    const pasted = writeMatrix(
      t,
      4,
      3,
      b.rows.map((row) => row.map((v) => (v.startsWith('=') ? rewriteFormulaRefs(v, 4 - 1, 3 - 1) : v)))
    )
    expect(landing.tab.rows).toEqual(pasted.rows)
    // And concretely: relative parts shift, absolute parts stay, a reference
    // outside the block shifts with it, as in Excel.
    expect(cell(landing.tab, 'D5')).toBe(rewriteFormulaRefs('=A1*$A$1+A$1+$A1+SUM(A1:B2)+Sheet2!A1', 3, 2))
    expect(cell(landing.tab, 'D5')).toContain('$A$1')
    expect(cell(landing.tab, 'D5')).toMatch(/^=C4\*\$A\$1\+C\$1\+\$A4\+SUM\(C4:D5\)/)
    expect(cell(landing.tab, 'D6')).toBe('=D5')
  })

  it('writes a body with no origin literally, as an external paste', () => {
    const landing = insertSheetSnippet(SUM, snippetOf({ kind: 'sheet', rows: [['=A1']] }), at(4, 4))
    if ('declined' in landing) throw new Error(landing.declined)
    expect(cell(landing.tab, 'E5')).toBe('=A1')
  })

  it('pads ragged rows to the block’s width, overwriting the cells under them', () => {
    const t = tabWith({ B1: 'old', C2: 'old', C3: 'old' })
    const landing = insertSheetSnippet(t, snippetOf({ kind: 'sheet', rows: [['a'], ['b', 'c'], []] }), at(0, 1))
    if ('declined' in landing) throw new Error(landing.declined)
    expect(landing.range).toEqual({ r0: 0, c0: 1, r1: 2, c1: 2 })
    expect(landing.tab.rows.slice(0, 3).map((r) => r.slice(1, 3))).toEqual([
      ['a', ''],
      ['b', 'c'],
      ['', '']
    ])
  })

  it('grows the sheet when the block runs past its current edge, as paste does', () => {
    const small = tabWith({}, 2, 2)
    const landing = insertSheetSnippet(small, snippetOf(body), at(1, 1))
    if ('declined' in landing) throw new Error(landing.declined)
    expect(landing.tab.rows.length).toBe(4)
    expect(landing.tab.columns.length).toBe(2)
    expect(cell(landing.tab, 'B4')).toBe('=B2+B3')
  })

  it('never mutates the snippet or the tab', () => {
    const frozenBody = deepFreeze(sheetBodyFromSelection(tabWith({ A1: '1', A2: '=A1' }, 4, 4, { formats: { '0,0': { bold: true } } }), { r0: 0, c0: 0, r1: 1, c1: 0 })!)
    const snip = deepFreeze(snippetOf(frozenBody))
    const t = deepFreeze(tabWith({}, 4, 4))
    const landing = insertSheetSnippet(t, snip, at(1, 1))
    expect('declined' in landing).toBe(false)
    expect(frozenBody.rows).toEqual([['1'], ['=A1']])
    expect(t.rows.every((r) => r.every((v) => v === ''))).toBe(true)
  })

  it('replaces the formats under the block with the block’s own, and reads them defensively', () => {
    const t = tabWith({}, 6, 6, { formats: { '0,2': { italic: true }, '5,5': { bold: true } } })
    const b: SheetSnippetBody = {
      kind: 'sheet',
      rows: [['x', 'y']],
      origin: { r: 0, c: 0 },
      formats: { '0,0': { bold: true, evil: 'x', align: 'sideways' }, '0,1': { numFmt: { kind: 'percent', decimals: 1 } }, '7,7': { bold: true }, '0,5': 'nope' }
    }
    const landing = insertSheetSnippet(t, snippetOf(b), at(0, 2))
    if ('declined' in landing) throw new Error(landing.declined)
    expect(landing.tab.formats).toEqual({ '5,5': { bold: true }, '0,2': { bold: true }, '0,3': { numFmt: { kind: 'percent', decimals: 1 } } })
  })

  it('places the block’s merges and replaces a merge wholly under it', () => {
    const t = tabWith({}, 8, 8, { merges: [{ r1: 3, c1: 3, r2: 3, c2: 4 }, { r1: 7, c1: 0, r2: 7, c2: 1 }] })
    const b: SheetSnippetBody = { kind: 'sheet', rows: [['Head', '', ''], ['', '', '']], origin: { r: 0, c: 0 }, merges: [{ r1: 0, c1: 0, r2: 0, c2: 2 }, { r1: 1, c1: 0, r2: 5, c2: 0 }] }
    const landing = insertSheetSnippet(t, snippetOf(b), at(3, 3))
    if ('declined' in landing) throw new Error(landing.declined)
    // The out-of-block merge in the body is dropped, not stretched over the sheet.
    expect(landing.tab.merges).toEqual([{ r1: 7, c1: 0, r2: 7, c2: 1 }, { r1: 3, c1: 3, r2: 3, c2: 5 }])
  })

  it('clears validation under the block, splitting a rule around it, and lands the block’s own with fresh ids', () => {
    const t = tabWith({}, 10, 6, { validations: [{ id: 'keep', range: 'A1:C3', rule: { kind: 'textNotEmpty' } }] })
    const b: SheetSnippetBody = { kind: 'sheet', rows: [['1']], origin: { r: 0, c: 0 }, validations: [{ r1: 0, c1: 0, r2: 0, c2: 0, rule: { kind: 'number', op: 'gt', value: 0 }, strict: true }, { r1: 0, c1: 0, r2: 0, c2: 0, rule: { kind: 'bogus' } }] }
    const landing = insertSheetSnippet(t, snippetOf(b), at(1, 1))
    if ('declined' in landing) throw new Error(landing.declined)
    const v = landing.tab.validations!
    expect(v.map((x) => x.range)).toEqual(['A1:C1', 'A3:C3', 'A2', 'C2', 'B2'])
    expect(v[0]!.id).toBe('keep')
    expect(new Set(v.map((x) => x.id)).size).toBe(5)
    expect(v[4]).toMatchObject({ range: 'B2', rule: { kind: 'number', op: 'gt', value: 0 }, strict: true })
    expect(subtract({ r0: 0, c0: 0, r1: 1, c1: 1 }, { r0: 5, c0: 5, r1: 6, c1: 6 })).toEqual([{ r0: 0, c0: 0, r1: 1, c1: 1 }])
  })

  describe('declines, with a reason a person can act on', () => {
    it('when the sheet is read-only', () => {
      expect(insertSheetSnippet(SUM, snippetOf(body), at(0, 2, { readOnly: true }))).toEqual({ declined: 'This spreadsheet is read-only.' })
    })

    it('when there is no active cell', () => {
      expect(insertSheetSnippet(SUM, snippetOf(body), at(0, 0, { at: null }))).toEqual({ declined: 'Select the cell the block should start at first.' })
    })

    it('for another kind, or a body with no cells', () => {
      const wrong = { ...snippetOf(body), kind: 'slide' as const, body: { kind: 'slide' as const, elements: [] } }
      expect('declined' in insertSheetSnippet(SUM, wrong, at(0, 2))).toBe(true)
      expect(insertSheetSnippet(SUM, snippetOf({ kind: 'sheet', rows: [] }), at(0, 2))).toEqual({ declined: 'That snippet holds no cells.' })
      expect(insertSheetSnippet(SUM, snippetOf({ kind: 'sheet', rows: [[], []] }), at(0, 2))).toEqual({ declined: 'That snippet holds no cells.' })
    })

    it('when the block would run past the sheet’s last row or column', () => {
      const r = insertSheetSnippet(SUM, snippetOf(body), at(SHEET_MAX_ROWS - 2, 0))
      expect(r).toEqual({ declined: "The 3 × 1 block would run past the sheet's last row (1,048,576) from A1048575." })
      const wide = snippetOf({ kind: 'sheet', rows: [['a', 'b']] })
      expect(insertSheetSnippet(SUM, wide, at(0, SHEET_MAX_COLS - 1))).toEqual({ declined: "The 1 × 2 block would run past the sheet's last column (XFD) from XFD1." })
      // Exactly reaching the last row is fine.
      expect('declined' in insertSheetSnippet(tabWith({}, 2, 2), snippetOf(body), at(SHEET_MAX_ROWS - 3, 0))).toBe(false)
    })

    it('when it would cut through a merge on the destination', () => {
      const t = tabWith({}, 8, 8, { merges: [{ r1: 1, c1: 2, r2: 1, c2: 4 }] })
      expect(insertSheetSnippet(t, snippetOf(body), at(0, 3))).toEqual({
        declined: 'The block at D1:D3 would cut through the merged cells C2:E2. Unmerge them or choose another cell.'
      })
    })

    it('when a relative reference would point above row 1, naming the cell where it lands (paste instead yields #REF!)', () => {
      const t = tabWith({ C5: '=C4*2' })
      const b = sheetBodyFromSelection(t, { r0: 4, c0: 2, r1: 4, c1: 2 })!
      // Paste used to CLAMP this to =A1*2 — a formula that looked right and
      // multiplied the wrong cell. It now breaks the reference, like Excel.
      // A snippet insert still DECLINES up front rather than landing a broken
      // formula: a paste is a direct action the user just performed and can see
      // the result of, while inserting a saved block is offered by the picker,
      // so refusing with a reason is better than placing something broken.
      expect(rewriteFormulaRefs('=C4*2', -4, -2)).toBe('=#REF!*2')
      expect(insertSheetSnippet(t, snippetOf(b), at(0, 0))).toEqual({
        declined: 'Placed at A1, the formula landing in A1 would point above row 1 or left of column A. Insert the block lower down or further right.'
      })
      // One row lower it fits: C4 becomes A1.
      const ok = insertSheetSnippet(t, snippetOf(b), at(1, 0))
      if ('declined' in ok) throw new Error(ok.declined)
      expect(cell(ok.tab, 'A2')).toBe('=A1*2')
      // An absolute reference never shifts, so it never underflows.
      const abs = sheetBodyFromSelection(tabWith({ C5: '=$C$4*2' }), { r0: 4, c0: 2, r1: 4, c1: 2 })!
      const okAbs = insertSheetSnippet(t, snippetOf(abs), at(0, 0))
      if ('declined' in okAbs) throw new Error(okAbs.declined)
      expect(cell(okAbs.tab, 'A1')).toBe('=$C$4*2')
    })
  })
})

describe('the shared model', () => {
  it('a block with formats but no text is still worth saving; a blank one is not', () => {
    expect(snippetBodyIsEmpty({ kind: 'sheet', rows: [['', '']], formats: { '0,0': { bold: true } } })).toBe(false)
    expect(snippetBodyIsEmpty({ kind: 'sheet', rows: [['', '']], merges: [{ r1: 0, c1: 0, r2: 0, c2: 1 }] })).toBe(false)
    expect(snippetBodyIsEmpty({ kind: 'sheet', rows: [['', '']] })).toBe(true)
  })

  it('a damaged sheet body does not match its kind, so it reads back empty', () => {
    expect(snippetBodyMatchesKind('sheet', { kind: 'sheet', rows: [['a']], origin: { r: 2, c: 0 } })).toBe(true)
    expect(snippetBodyMatchesKind('sheet', { kind: 'sheet', rows: 'a' } as unknown as SheetSnippetBody)).toBe(false)
    expect(snippetBodyMatchesKind('sheet', { kind: 'sheet', rows: ['a'] } as unknown as SheetSnippetBody)).toBe(false)
    expect(snippetBodyMatchesKind('sheet', { kind: 'sheet', rows: [['a']], origin: { r: -1, c: 0 } })).toBe(false)
    expect(snippetBodyMatchesKind('sheet', { kind: 'sheet', rows: [['a']], origin: null } as unknown as SheetSnippetBody)).toBe(false)
  })

  it('a sheet snippet is found by the text in its cells', () => {
    const s = snippetOf({ kind: 'sheet', rows: [['Quarterly revenue', '=SUM(B2:B9)']] })
    expect(snippetMatches(s, { search: 'quarterly rev' })).toBe(true)
    expect(snippetMatches(s, { search: 'sum(b2' })).toBe(true)
    expect(snippetMatches(s, { search: 'payroll' })).toBe(false)
    expect(snippetSummary(s)).toBe('1 × 2 cells')
  })
})

// ── The registration, in a real React tree ───────────────────────────────────

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useSnippetsStore.setState({ targets: {}, error: null })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Sheet({ id, title, insert }: { id: string; title: string; insert: (s: Snippet) => SnippetInsertResult }): null {
  useCellsSnippetTarget(id, title, insert)
  return null
}

describe('the spreadsheet as a snippet target', () => {
  it('claims Duplicate only, and linkModesFor agrees', () => {
    expect(CELLS_SNIPPET_LINKS).toEqual(['duplicate'])
    act(() => root.render(<Sheet id=":r1:" title="Budget" insert={() => true} />))
    const target = useSnippetsStore.getState().targets[cellsSnippetTargetId(':r1:')]!
    expect(target).toBeTruthy()
    expect(target.id).toBe('sheet::r1:')
    expect(linkModesFor(target, 'sheet')).toEqual(['duplicate'])
    // Any-to-any: kinds with a conversion into cells (a document's table, a
    // text work widget) are taken as a copy; pictures are not.
    expect(linkModesFor(target, 'doc')).toEqual(['duplicate'])
    expect(linkModesFor(target, 'widget')).toEqual(['duplicate'])
    expect(linkModesFor(target, 'slide')).toEqual([])
    expect(linkModesFor(target, 'draw')).toEqual([])
    expect(target.host).toBe('sheet')
    expect(target.label).toBe('“Budget”')
  })

  it('registers each mounted spreadsheet separately and withdraws on unmount', () => {
    act(() =>
      root.render(
        <>
          <Sheet id=":a:" title="One" insert={() => true} />
          <Sheet id=":b:" title="" insert={() => true} />
        </>
      )
    )
    expect(Object.keys(useSnippetsStore.getState().targets).sort()).toEqual([cellsSnippetTargetId(':a:'), cellsSnippetTargetId(':b:')])
    expect(useSnippetsStore.getState().targets[cellsSnippetTargetId(':b:')]!.label).toBe('This spreadsheet')
    act(() => root.render(<Sheet id=":a:" title="One" insert={() => true} />))
    expect(Object.keys(useSnippetsStore.getState().targets)).toEqual([cellsSnippetTargetId(':a:')])
    act(() => root.render(<></>))
    expect(useSnippetsStore.getState().targets).toEqual({})
  })

  it('always calls the CURRENT render’s insert, refuses live outright, and its reason reaches the user verbatim', async () => {
    const first = vi.fn((): SnippetInsertResult => true)
    const reason = 'Placed at A1, the formula landing in A1 would point above row 1 or left of column A. Insert the block lower down or further right.'
    const second = vi.fn((): SnippetInsertResult => ({ ok: false, reason }))
    act(() => root.render(<Sheet id=":c:" title="S" insert={first} />))
    act(() => root.render(<Sheet id=":c:" title="S" insert={second} />))
    const target = useSnippetsStore.getState().targets[cellsSnippetTargetId(':c:')]!
    const snip = snippetOf({ kind: 'sheet', rows: [['1']] })
    expect(await target.insert(snip, 'duplicate')).toEqual({ ok: false, reason })
    expect(first).not.toHaveBeenCalled()
    expect(await target.insert(snip, 'live')).toBe(false)
    expect(second).toHaveBeenCalledTimes(1)
    expect(await useSnippetsStore.getState().insert(snip, 'duplicate', target.id)).toBe(false)
    expect(useSnippetsStore.getState().error).toBe(reason)
    expect(await useSnippetsStore.getState().insert(snip, 'live', target.id)).toBe(false)
    expect(useSnippetsStore.getState().error).toMatch(/cannot take a live snippet/)
  })
})

describe('where the commands live on the shell', () => {
  function ctx(cmds: Partial<SheetMenuActions>, readOnly = false): CCtx {
    const a = new Proxy(cmds, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (() => undefined) }) as SheetMenuActions
    return {
      a,
      // The ribbon's shared controls render from the registry now, so these
      // tests go through the real commands to reach the spies in `a`.
      commands: buildCellsCommands({
        a,
        readOnly,
        isMerged: false,
        mergeCells: () => {},
        insertLookup: () => {},
        macros: () => {},
        query: () => {},
        shortcuts: () => {}
      }),
      readOnly,
      fmt: undefined,
      isMerged: false,
      mergeCells: () => {},
      insertLookup: () => {},
      macros: () => {},
      query: () => {},
      togglePanel: () => {},
      isPanelOpen: () => false,
      sidePane: null,
      toggleSidePane: () => {}
    }
  }
  const btn = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!

  it('Insert › Insert snippet… opens the library', () => {
    const insertSnippet = vi.fn()
    act(() => root.render(<ContextBar<CCtx> testid="sheet-toolbar" tabs={CELLS_TABS} ctx={ctx({ insertSnippet })} activeTab="insert" onTabChange={() => {}} menuBar={null} />))
    expect(btn('sheet-insert-snippet').textContent).toContain('Insert snippet…')
    act(() => btn('sheet-insert-snippet').click())
    expect(insertSnippet).toHaveBeenCalledTimes(1)
  })

  it('Data › Save selection as snippet… sits with the range actions, and works on a read-only sheet', () => {
    const saveSnippet = vi.fn()
    act(() => root.render(<ContextBar<CCtx> testid="sheet-toolbar" tabs={CELLS_TABS} ctx={ctx({ saveSnippet }, true)} activeTab="data" onTabChange={() => {}} readOnly menuBar={null} />))
    expect(btn('sheet-save-snippet').textContent).toContain('Save selection as snippet…')
    expect(btn('sheet-save-snippet').disabled).toBe(false)
    act(() => btn('sheet-save-snippet').click())
    expect(saveSnippet).toHaveBeenCalledTimes(1)
  })
})

describe('the save dialog says what will not be kept', () => {
  it('shows the not-kept line when the surface supplies one, and nothing when it does not', () => {
    const t = tabWith({ A1: '1' }, 4, 4, { colWidths: { 0: 120 } })
    const sel = { r0: 0, c0: 0, r1: 0, c1: 0 }
    act(() => root.render(<SaveSnippetDialog body={sheetBodyFromSelection(t, sel)!} notKept={sheetSnippetNotKept(t, sel)} onClose={() => {}} />))
    expect(document.querySelector('[data-testid="save-snippet-not-kept"]')?.textContent).toBe('Column widths are not saved with a snippet.')
    expect(document.querySelector('[data-testid="save-snippet-preview"]')?.textContent).toBe('1 × 1 cells')
    act(() => root.render(<SaveSnippetDialog body={sheetBodyFromSelection(SUM, A1_A3)!} notKept={sheetSnippetNotKept(SUM, A1_A3)} onClose={() => {}} />))
    expect(document.querySelector('[data-testid="save-snippet-not-kept"]')).toBeNull()
  })
})
