import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseChatJson } from '../../src/main/ai/anthropic'

// "it added the table but not the rows" (reported 2026-10-30).
//
// create-table could define columns and nothing else, so records had to be
// separate add-table-row actions pointing back with "$<id>". Twenty records
// meant twenty-one actions: twenty-one chances for the envelope to be cut
// short, or for the model to simply stop after the table. You got an empty
// grid and a reply saying it was filled.
//
// One action carries both now. add-table-row stays for what it is for —
// adding to a table that already exists.

describe('create-table carries its rows', () => {
  function parse(action: Record<string, unknown>): ReturnType<typeof parseChatJson> {
    return parseChatJson(JSON.stringify({ reply: 'Here it is.', actions: [action] }))
  }

  const COLUMNS = [
    { label: 'Destination', type: 'text-short' },
    { label: 'Flight time', type: 'text-short' }
  ]

  it('keeps the rows the model sent', () => {
    const { proposals } = parse({
      kind: 'create-table',
      id: 'tbl-1',
      title: 'Honeymoon destinations',
      columns: COLUMNS,
      rows: [
        { Destination: 'Bali', 'Flight time': '6h' },
        { Destination: 'Fiji', 'Flight time': '7h' }
      ]
    })
    const t = proposals.find((p) => p.kind === 'create-table')
    expect(t && t.kind === 'create-table' && t.rows).toHaveLength(2)
  })

  it('a table with no rows is still a table', () => {
    const { proposals } = parse({ kind: 'create-table', title: 'Guests', columns: COLUMNS })
    const t = proposals.find((p) => p.kind === 'create-table')
    expect(t).toBeTruthy()
    expect(t && t.kind === 'create-table' && t.rows).toBeUndefined()
  })

  it('drops a malformed row rather than carrying half of one', () => {
    const { proposals } = parse({
      kind: 'create-table',
      title: 'Destinations',
      columns: COLUMNS,
      rows: [{ Destination: 'Bali' }, 'Fiji', 42, null, ['Vanuatu']]
    })
    const t = proposals.find((p) => p.kind === 'create-table')
    expect(t && t.kind === 'create-table' && t.rows).toEqual([{ Destination: 'Bali' }])
  })

  it('the prompt tells the model to use it instead of twenty row actions', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../..', 'src/main/ai/anthropic.ts'), 'utf-8')
    expect(src).toContain('ROWS GO WITH THE TABLE')
    expect(src).toMatch(/add-table-row is for adding to a[\s\S]{0,40}table that ALREADY exists/)
  })
})

describe('the card says whether rows are coming', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('../../src/renderer/src/stores/widgets', () => ({
      useWidgetStore: { getState: () => ({ widgets: [] }) }
    }))
    vi.doMock('../../src/renderer/src/stores/tables', () => ({
      useTablesStore: { getState: () => ({ ensureTableLoaded: async () => null, addRow: async () => {} }) }
    }))
  })

  it('names the row count, so an empty table is never a surprise', async () => {
    const { describeProposal } = await import('../../src/renderer/src/lib/actionExecutor')
    const withRows = describeProposal({
      id: 't1',
      kind: 'create-table',
      title: 'Destinations',
      columns: [{ label: 'Name', type: 'text-short' }],
      rows: [{ Name: 'Bali' }, { Name: 'Fiji' }]
    } as never)
    expect(withRows.subject).toContain('2 rows')

    const without = describeProposal({
      id: 't2',
      kind: 'create-table',
      title: 'Guest list',
      columns: [{ label: 'Name', type: 'text-short' }]
    } as never)
    expect(without.subject).toContain('no rows')
  })
})

describe('applying a create-table writes its rows', () => {
  const added: Array<{ tableId: string; cells: Record<string, unknown> }> = []
  const widgets: Array<Record<string, unknown>> = []

  beforeEach(() => {
    added.length = 0
    widgets.length = 0
    vi.resetModules()
    vi.doMock('../../src/renderer/src/stores/tables', () => ({
      useTablesStore: {
        getState: () => ({
          createTable: async () => ({ id: 'tbl-new', schema: { columns: [] } }),
          addRow: async (tableId: string, cells: Record<string, unknown>) => {
            added.push({ tableId, cells })
            return { id: `r${added.length}` }
          },
          ensureTableLoaded: async () => null
        })
      }
    }))
    vi.doMock('../../src/renderer/src/stores/widgets', () => ({
      useWidgetStore: {
        getState: () => ({ widgets: [], create: async (w: Record<string, unknown>) => void widgets.push(w) })
      }
    }))
  })

  const proposal = {
    id: 'tbl-1',
    kind: 'create-table' as const,
    title: 'Honeymoon destinations',
    columns: [
      { label: 'Destination', type: 'text-short' },
      { label: 'Flight time', type: 'number' }
    ],
    rows: [
      { Destination: 'Bali', 'Flight time': '6' },
      { Destination: 'Fiji', 'Flight time': '7' }
    ]
  }

  it('creates a row per record, mapped by label and coerced', async () => {
    const { applyProposal } = await import('../../src/renderer/src/lib/actionExecutor')
    const r = await applyProposal(proposal as never, { activeTaskId: 'desk-1' } as never)
    expect(r.ok).toBe(true)
    expect(added).toHaveLength(2)
    // Labels became column ids, and the number column holds a number.
    expect(Object.values(added[0].cells)).toContain('Bali')
    expect(Object.values(added[0].cells)).toContain(6)
  })

  it('says how many rows it actually added, so the message cannot overstate', async () => {
    const { applyProposal } = await import('../../src/renderer/src/lib/actionExecutor')
    const r = await applyProposal(proposal as never, { activeTaskId: 'desk-1' } as never)
    expect(r.message).toContain('2 rows')
  })

  it('a table with no rows reports no rows, and still succeeds', async () => {
    const { applyProposal } = await import('../../src/renderer/src/lib/actionExecutor')
    const r = await applyProposal(
      { ...proposal, rows: undefined } as never,
      { activeTaskId: 'desk-1' } as never
    )
    expect(r.ok).toBe(true)
    expect(added).toHaveLength(0)
    expect(r.message).not.toContain('rows')
  })
})
