// Table cell-selection, copy, paste and fill helpers. Copy writes what the table
// shows; paste coerces per column type and, when growing, adds the rows a long
// paste needs (otherwise clips and reports it); fill continues each line's series.

import { describe, it, expect } from 'vitest'
import {
  normCellRange, inCellRange, cellsToTsv, cellsToHtml, cellDisplayText, planTablePaste, fillTarget, planTableFill, htmlTableMatrix
} from '@renderer/lib/tableSelection'
import type { FbRow, FieldDefinition } from '@shared/fields'

function col(id: string, label: string, type: FieldDefinition['type'] = 'text-short'): FieldDefinition {
  return { id, type, label, config: {} } as FieldDefinition
}
function row(id: string, cells: Record<string, unknown>): FbRow {
  return { id, tableId: 't', cells, sortOrder: 0, createdAt: 0, updatedAt: 0 }
}

const columns = [col('c1', 'Name'), col('c2', 'City'), col('c3', 'Count', 'number')]
const rows = [
  row('r1', { c1: 'Ann', c2: 'NYC', c3: 1 }),
  row('r2', { c1: 'Bob', c2: 'LA', c3: 2 }),
  row('r3', { c1: 'Cy', c2: 'SF', c3: 3 })
]

describe('normCellRange / inCellRange', () => {
  it('normalizes regardless of drag direction', () => {
    expect(normCellRange({ r: 2, c: 3 }, { r: 0, c: 1 })).toEqual({ r0: 0, c0: 1, r1: 2, c1: 3 })
  })
  it('membership test', () => {
    const range = { r0: 0, c0: 0, r1: 1, c1: 1 }
    expect(inCellRange(range, 1, 1)).toBe(true)
    expect(inCellRange(range, 2, 0)).toBe(false)
    expect(inCellRange(null, 0, 0)).toBe(false)
  })
})

describe('cellsToTsv', () => {
  it('serializes a selected range to TSV', () => {
    const tsv = cellsToTsv(rows, columns, { r0: 0, c0: 0, r1: 1, c1: 1 })
    expect(tsv).toBe('Ann\tNYC\nBob\tLA')
  })
})

describe('planTablePaste', () => {
  it('fills a whole selection from a single clipboard cell', () => {
    const plan = planTablePaste({
      rows,
      columns,
      range: { r0: 0, c0: 0, r1: 1, c1: 0 },
      matrix: [['Zed']]
    })
    expect(plan.clippedRows).toBe(0)
    expect(plan.updates).toEqual([
      { rowId: 'r1', cells: { c1: 'Zed' } },
      { rowId: 'r2', cells: { c1: 'Zed' } }
    ])
  })

  it('writes a block from the top-left, coercing per column type', () => {
    const plan = planTablePaste({
      rows,
      columns,
      range: { r0: 0, c0: 1, r1: 0, c1: 1 },
      matrix: [
        ['Paris', '10'],
        ['Rome', '20']
      ]
    })
    // c2 is text, c3 is number -> '10' coerces to 10
    expect(plan.updates).toEqual([
      { rowId: 'r1', cells: { c2: 'Paris', c3: 10 } },
      { rowId: 'r2', cells: { c2: 'Rome', c3: 20 } }
    ])
    expect(plan.clippedRows).toBe(0)
  })

  it('clips to existing rows and reports the overflow', () => {
    const plan = planTablePaste({
      rows,
      columns,
      range: { r0: 2, c0: 0, r1: 2, c1: 0 },
      matrix: [['x'], ['y'], ['z']] // 3 rows starting at row index 2 -> needs rows 2,3,4
    })
    expect(plan.updates).toEqual([{ rowId: 'r3', cells: { c1: 'x' } }])
    expect(plan.clippedRows).toBe(2)
  })
})

describe('copy writes what the table shows', () => {
  const when = { id: 'w', type: 'date', label: 'When', config: {} } as FieldDefinition
  const at = { id: 'a', type: 'date', label: 'At', config: { withTime: true } } as FieldDefinition
  const st = { id: 's', type: 'single-select', label: 'Status', config: { options: [{ id: 'o1', label: 'Open' }, { id: 'o2', label: 'Done' }] } } as FieldDefinition
  const tags = { id: 't', type: 'multi-select', label: 'Tags', config: { options: [{ id: 'x', label: 'Red' }, { id: 'y', label: 'Blue' }] } } as FieldDefinition
  const day = Date.UTC(2026, 10, 19, 9, 30)

  it('dates as the day (and time) the cell shows, choices by label', () => {
    expect(cellDisplayText(day, when)).toBe('2026-11-19')
    expect(cellDisplayText(day, at)).toBe('2026-11-19T09:30')
    expect(cellDisplayText('o2', st)).toBe('Done')
    expect(cellDisplayText(['y', 'x'], tags)).toBe('Blue, Red')
    expect(cellDisplayText(null, when)).toBe('')
    expect(cellDisplayText(true, null)).toBe('true')
  })

  it('round-trips: what is copied pastes back to the same stored value', () => {
    const r = [row('r1', { w: Date.UTC(2026, 10, 19), s: 'o1' })]
    const tsv = cellsToTsv(r, [when, st], { r0: 0, c0: 0, r1: 0, c1: 1 })
    expect(tsv).toBe('2026-11-19\tOpen')
    const plan = planTablePaste({ rows: r, columns: [when, st], range: { r0: 0, c0: 0, r1: 0, c1: 0 }, matrix: [tsv.split('\t')] })
    expect(plan.updates).toEqual([{ rowId: 'r1', cells: { w: Date.UTC(2026, 10, 19), s: 'o1' } }])
  })

  it('a tab or line break inside a cell does not split it', () => {
    const r = [row('r1', { c1: 'two\nlines', c2: 'a\tb' })]
    expect(cellsToTsv(r, columns, { r0: 0, c0: 0, r1: 0, c1: 1 })).toBe('two lines\ta b')
  })

  it('as an HTML table, escaped', () => {
    const r = [row('r1', { c1: 'A & <b>', c2: 'x' }), row('r2', { c1: 'B', c2: 'y' })]
    const html = cellsToHtml(r, columns, { r0: 0, c0: 0, r1: 1, c1: 1 })
    expect(html).toContain('<table><tbody><tr><td>A &amp; &lt;b&gt;</td><td>x</td></tr><tr><td>B</td><td>y</td></tr></tbody></table>')
  })
})

describe('a long paste grows the table', () => {
  it('rows past the end become new rows, coerced, and nothing is clipped', () => {
    const plan = planTablePaste({ rows, columns, range: { r0: 2, c0: 1, r1: 2, c1: 2 }, matrix: [['A', '7'], ['B', 'x'], ['C', '9']], grow: true })
    expect(plan.updates).toEqual([{ rowId: 'r3', cells: { c2: 'A', c3: 7 } }])
    expect(plan.newRows).toEqual([{ c2: 'B', c3: null }, { c2: 'C', c3: 9 }])
    expect(plan.clippedRows).toBe(0)
  })
})

describe('fill', () => {
  it('goes along the axis the pointer moved further out on', () => {
    const src = { r0: 0, c0: 0, r1: 1, c1: 0 }
    expect(fillTarget(src, { r: 1, c: 0 })).toBeNull()
    expect(fillTarget(src, { r: 4, c: 1 })).toEqual({ dir: 'down', range: { r0: 0, c0: 0, r1: 4, c1: 0 } })
    expect(fillTarget(src, { r: 1, c: 3 })).toEqual({ dir: 'right', range: { r0: 0, c0: 0, r1: 1, c1: 3 } })
    expect(fillTarget({ r0: 2, c0: 2, r1: 2, c1: 2 }, { r: 0, c: 2 })).toEqual({ dir: 'up', range: { r0: 0, c0: 2, r1: 2, c1: 2 } })
  })

  const many = [
    row('a', { c1: 'Item 1', c2: 'NYC', c3: 1 }),
    row('b', { c1: '', c2: '', c3: 2 }),
    row('c', { c1: '', c2: '', c3: null }),
    row('d', { c1: '', c2: '', c3: null })
  ]

  it('down continues a number series and text with a number, per column', () => {
    const up = planTableFill({ rows: many, columns, source: { r0: 0, c0: 2, r1: 1, c1: 2 }, target: { dir: 'down', range: { r0: 0, c0: 2, r1: 3, c1: 2 } } })
    expect(up).toEqual([{ rowId: 'c', cells: { c3: 3 } }, { rowId: 'd', cells: { c3: 4 } }])
    const items = planTableFill({ rows: many, columns, source: { r0: 0, c0: 0, r1: 0, c1: 0 }, target: { dir: 'down', range: { r0: 0, c0: 0, r1: 2, c1: 0 } } })
    expect(items).toEqual([{ rowId: 'b', cells: { c1: 'Item 2' } }, { rowId: 'c', cells: { c1: 'Item 3' } }])
  })

  it('across copies plain text and coerces into the column it lands in', () => {
    const fill = planTableFill({ rows: many, columns, source: { r0: 0, c0: 1, r1: 0, c1: 1 }, target: { dir: 'right', range: { r0: 0, c0: 1, r1: 0, c1: 2 } } })
    expect(fill).toEqual([{ rowId: 'a', cells: { c3: null } }])
  })

  it('up continues the series backwards', () => {
    const r = [row('a', {}), row('b', {}), row('c', { c3: 5 }), row('d', { c3: 6 })]
    const fill = planTableFill({ rows: r, columns, source: { r0: 2, c0: 2, r1: 3, c1: 2 }, target: { dir: 'up', range: { r0: 0, c0: 2, r1: 3, c1: 2 } } })
    expect(fill).toEqual([{ rowId: 'b', cells: { c3: 4 } }, { rowId: 'a', cells: { c3: 3 } }])
  })

  it('dates step a day at a time', () => {
    const when = { id: 'w', type: 'date', label: 'When', config: {} } as FieldDefinition
    const r = [row('a', { w: Date.UTC(2026, 10, 30) }), row('b', {})]
    const fill = planTableFill({ rows: r, columns: [when], source: { r0: 0, c0: 0, r1: 0, c1: 0 }, target: { dir: 'down', range: { r0: 0, c0: 0, r1: 1, c1: 0 } } })
    expect(fill).toEqual([{ rowId: 'b', cells: { w: Date.UTC(2026, 11, 1) } }])
  })
})

describe('an HTML table on the clipboard', () => {
  it('reads rows of cell text; no table is null', () => {
    expect(htmlTableMatrix('<table><tr><th>Name</th><th> City </th></tr><tr><td>Ann</td><td>New\n York</td></tr></table>')).toEqual([
      ['Name', 'City'],
      ['Ann', 'New York']
    ])
    expect(htmlTableMatrix('<p>no table</p>')).toBeNull()
  })
})
