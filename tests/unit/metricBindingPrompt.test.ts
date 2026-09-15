import { describe, it, expect } from 'vitest'
import { buildMetricBindingPrompt, type MetricSchemaTable } from '../../src/main/ai/anthropic'

// The model can only choose a column it was shown. A schema quietly omitted
// produces confident nonsense that looks exactly like a working card.

const tables: MetricSchemaTable[] = [
  {
    id: 'tbl_deals',
    title: 'Deals',
    rowCount: 42,
    columns: [
      { id: 'c_amt', label: 'Amount', type: 'number' },
      { id: 'c_stage', label: 'Stage', type: 'single-select' }
    ]
  },
  {
    id: 'tbl_tasks',
    title: 'Tasks',
    rowCount: 7,
    columns: [{ id: 'c_done', label: 'Done', type: 'checkbox' }]
  }
]

describe('buildMetricBindingPrompt', () => {
  it('lists every table with its id', () => {
    const p = buildMetricBindingPrompt('total won deals', tables)
    expect(p).toContain('tbl_deals')
    expect(p).toContain('tbl_tasks')
    expect(p).toContain('Deals')
    expect(p).toContain('Tasks')
  })

  it('lists every column with its id and type, which is what makes ids checkable', () => {
    const p = buildMetricBindingPrompt('x', tables)
    expect(p).toContain('c_amt')
    expect(p).toContain('type: number')
    expect(p).toContain('c_stage')
    expect(p).toContain('c_done')
    expect(p).toContain('type: checkbox')
  })

  it('includes the row count, so the model knows what it is measuring', () => {
    expect(buildMetricBindingPrompt('x', tables)).toContain('42 rows')
  })

  it('carries the request verbatim', () => {
    expect(buildMetricBindingPrompt('sum of won deals this quarter', tables)).toContain(
      'sum of won deals this quarter'
    )
  })

  it('says there are none rather than pretending, when the workspace is empty', () => {
    const p = buildMetricBindingPrompt('anything', [])
    expect(p).toContain('(none)')
  })

  it('survives a table with no columns', () => {
    const p = buildMetricBindingPrompt('x', [
      { id: 't', title: 'Bare', rowCount: 0, columns: [] }
    ])
    expect(p).toContain('Bare')
  })
})
