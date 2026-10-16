import { describe, it, expect } from 'vitest'
import type { TableSchema } from '../../src/shared/fields'
import { draftRowToCells } from '../../src/renderer/src/lib/tableImport'

// Help audit 14c: importing a CSV made the table and the rows, and every cell
// was blank, because the draft rows are keyed by column LABEL and the table
// reads cells by column ID. These pin the bridge between the two.
const schema: TableSchema = {
  columns: [
    { id: 'c-x-0', type: 'text-short', label: 'Item', config: {} },
    { id: 'c-x-1', type: 'number', label: 'Amount', config: {} },
    { id: 'c-x-2', type: 'checkbox', label: 'Paid', config: {} }
  ] as TableSchema['columns']
}

describe('draftRowToCells', () => {
  it('keys every cell by column id, never by label', () => {
    const cells = draftRowToCells(schema, { Item: 'Rent, May', Amount: '1200', Paid: 'no' })
    expect(Object.keys(cells).sort()).toEqual(['c-x-0', 'c-x-1', 'c-x-2'])
    expect(cells).not.toHaveProperty('Item')
    expect(cells['c-x-0']).toBe('Rent, May')
  })

  it('coerces to the column type the importer inferred', () => {
    const cells = draftRowToCells(schema, { Item: 'Groceries', Amount: '80', Paid: 'yes' })
    expect(cells['c-x-1']).toBe(80)
    expect(cells['c-x-2']).toBe(true)
  })

  it('drops keys that name no column instead of writing an unreadable cell', () => {
    const cells = draftRowToCells(schema, { Item: 'A', Stray: 'x' } as Record<string, string>)
    expect(Object.keys(cells)).toEqual(['c-x-0'])
  })
})
