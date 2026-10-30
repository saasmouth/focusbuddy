import { describe, it, expect, vi, beforeEach } from 'vitest'

// A researched table must ARRIVE populated (ADR-0011).
//
// The owner's report was "tables with columns and rows populated" not
// happening. Half of that was the assistant claiming work it never did
// (ADR-0010). The other half is here: an AiBuildSuggestion could describe
// columns and nothing else, so even a perfect answer produced an empty grid.
//
// Two things under test: the label→cell mapping the model's rows go through,
// and that materializeSuggestion actually writes them.

vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: { getState: () => ({ widgets: [] }) }
}))
vi.mock('../../src/renderer/src/stores/tables', () => ({
  useTablesStore: { getState: () => ({ ensureTableLoaded: async () => null, addRow: async () => {} }) }
}))

describe('cellsFromAiRow — the model writes labels, the table wants ids', () => {
  const columns = [
    { id: 'c1', label: 'Title', type: 'text-short', config: {} },
    { id: 'c2', label: 'Status', type: 'text-short', config: {} },
    { id: 'c3', label: 'Price', type: 'number', config: {} }
  ]

  it('maps labels onto column ids', async () => {
    const { cellsFromAiRow } = await import('../../src/renderer/src/lib/actionExecutor')
    const { cells } = cellsFromAiRow(columns, { Title: 'Aeron', Status: 'Shortlist' })
    expect(cells).toEqual({ c1: 'Aeron', c2: 'Shortlist' })
  })

  it('accepts a column id just as readily', async () => {
    const { cellsFromAiRow } = await import('../../src/renderer/src/lib/actionExecutor')
    expect(cellsFromAiRow(columns, { c1: 'Aeron' }).cells).toEqual({ c1: 'Aeron' })
  })

  it('is case- and whitespace-insensitive about labels', async () => {
    const { cellsFromAiRow } = await import('../../src/renderer/src/lib/actionExecutor')
    expect(cellsFromAiRow(columns, { '  status ': 'Done' }).cells).toEqual({ c2: 'Done' })
  })

  it('coerces to the column type rather than storing the model’s string', async () => {
    const { cellsFromAiRow } = await import('../../src/renderer/src/lib/actionExecutor')
    expect(cellsFromAiRow(columns, { Price: '1395' }).cells).toEqual({ c3: 1395 })
  })

  it('reports an unknown column instead of silently losing it', async () => {
    const { cellsFromAiRow } = await import('../../src/renderer/src/lib/actionExecutor')
    const { cells, unrecognised } = cellsFromAiRow(columns, { Title: 'Aeron', Colour: 'Graphite' })
    expect(cells).toEqual({ c1: 'Aeron' })
    expect(unrecognised).toEqual(['Colour'])
  })
})

describe('materializeSuggestion — rows land with the table', () => {
  const created: Array<{ tableId: string; cells: Record<string, unknown> }> = []

  beforeEach(() => {
    created.length = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        tables: {
          create: async () => ({ id: 'tbl-new' }),
          createRow: async (draft: { tableId: string; cells: Record<string, unknown> }) => {
            created.push(draft)
            return { id: `row-${created.length}` }
          }
        }
      }
    }
  })

  const suggestion = {
    id: 's1',
    kind: 'table' as const,
    title: 'Chairs',
    reason: 'researched [W1]',
    tableSchema: {
      columns: [
        { id: 'c1', type: 'text-short', label: 'Model', config: {} },
        { id: 'c2', type: 'number', label: 'Price', config: {} }
      ],
      rows: [
        { Model: 'Aeron', Price: '1395' },
        { Model: 'Embody', Price: '1795' }
      ]
    }
  }

  it('creates a row per researched record, mapped and coerced', async () => {
    const { materializeSuggestion } = await import('../../src/renderer/src/lib/materializeSuggestion')
    const out = await materializeSuggestion(suggestion, 'desk-1')
    expect(out.content).toBe('tbl-new')
    expect(created).toEqual([
      { tableId: 'tbl-new', cells: { c1: 'Aeron', c2: 1395 } },
      { tableId: 'tbl-new', cells: { c1: 'Embody', c2: 1795 } }
    ])
  })

  it('creates no rows when the suggestion carries none — the old behaviour, intact', async () => {
    const { materializeSuggestion } = await import('../../src/renderer/src/lib/materializeSuggestion')
    await materializeSuggestion(
      { ...suggestion, tableSchema: { columns: suggestion.tableSchema.columns } },
      'desk-1'
    )
    expect(created).toEqual([])
  })

  it('skips a row that maps to nothing rather than failing the table', async () => {
    const { materializeSuggestion } = await import('../../src/renderer/src/lib/materializeSuggestion')
    await materializeSuggestion(
      {
        ...suggestion,
        tableSchema: {
          columns: suggestion.tableSchema.columns,
          rows: [{ Nonsense: 'x' }, { Model: 'Aeron' }]
        }
      },
      'desk-1'
    )
    expect(created).toEqual([{ tableId: 'tbl-new', cells: { c1: 'Aeron' } }])
  })
})
