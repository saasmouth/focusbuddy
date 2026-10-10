// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { validateChartConfig, type ChartTableShape } from '../../src/shared/charts'

// A chart config is almost entirely REAL IDS — the table it reads, the column
// grouped on, the column behind each series. A model cannot invent those, and
// every way it fails when it tries is QUIET:
//
//   unknown tableId   → the widget is unbound and looks broken
//   unknown columnId  → an empty series, which reads as "no data"
//   text under `sum`  → an honest zero, so the chart draws a flat line
//
// That last one is the dangerous one: nothing errors, and the chart is
// confidently wrong. So the expert is handed the real tables to choose from and
// its answer is checked here before it is ever written. Refusing beats drawing.

const sales: ChartTableShape = {
  id: 'tbl-sales',
  title: 'Sales',
  columns: [
    { id: 'c-month', label: 'Month', type: 'single-select' },
    { id: 'c-revenue', label: 'Revenue', type: 'number' },
    { id: 'c-rep', label: 'Rep', type: 'text-short' }
  ]
}
const tables = [sales]

const ok = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tableId: 'tbl-sales',
  type: 'bar',
  xColumnId: 'c-month',
  series: [{ columnId: 'c-revenue', agg: 'sum' }],
  ...over
})

describe('a config grounded in real ids is accepted', () => {
  it('accepts revenue by month', () => {
    expect(validateChartConfig(ok(), tables)).toEqual({ ok: true })
  })

  it('accepts no grouping column — every row in one bucket', () => {
    expect(validateChartConfig(ok({ xColumnId: null, type: 'kpi' }), tables).ok).toBe(true)
  })

  it('accepts count over a non-numeric column, which is legitimate', () => {
    // `count` counts ROWS; the column only labels the series.
    expect(
      validateChartConfig(ok({ series: [{ columnId: 'c-rep', agg: 'count' }] }), tables).ok
    ).toBe(true)
  })
})

describe('invented ids are refused by name, not shrugged at', () => {
  it('refuses a table that does not exist', () => {
    const r = validateChartConfig(ok({ tableId: 'tbl-made-up' }), tables)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('tbl-made-up')
  })

  it('refuses a series column that is not in that table', () => {
    const r = validateChartConfig(ok({ series: [{ columnId: 'c-nope', agg: 'sum' }] }), tables)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('Sales has no column')
  })

  it('refuses a grouping column that is not in that table', () => {
    const r = validateChartConfig(ok({ xColumnId: 'c-nope' }), tables)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('c-nope')
  })
})

describe('the quiet failures are the ones worth catching', () => {
  it('refuses arithmetic over a text column, and says what to do instead', () => {
    // This is the dangerous case: nothing throws, the aggregate is zero, and
    // the chart draws a flat line through nothing.
    const r = validateChartConfig(ok({ series: [{ columnId: 'c-rep', agg: 'sum' }] }), tables)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('Rep holds text-short')
    expect(r.ok === false && r.reason).toContain('Use count, or pick a number column')
  })

  it('refuses arithmetic over a select column too', () => {
    expect(
      validateChartConfig(ok({ series: [{ columnId: 'c-month', agg: 'avg' }] }), tables).ok
    ).toBe(false)
  })

  it('refuses a pie with nothing to slice by', () => {
    const r = validateChartConfig(ok({ type: 'pie', xColumnId: null }), tables)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('slice by')
  })

  it('refuses a KPI with several series, since it renders one number', () => {
    const r = validateChartConfig(
      ok({
        type: 'kpi',
        series: [
          { columnId: 'c-revenue', agg: 'sum' },
          { columnId: 'c-revenue', agg: 'avg' }
        ]
      }),
      tables
    )
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('one series')
  })
})

describe('the shape itself is checked', () => {
  it('refuses a config that is not one', () => {
    expect(validateChartConfig(null, tables).ok).toBe(false)
    expect(validateChartConfig(undefined, tables).ok).toBe(false)
  })

  it('refuses an unknown chart type', () => {
    const r = validateChartConfig(ok({ type: 'donut' }), tables)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('donut')
  })

  it('refuses an unknown aggregation', () => {
    const r = validateChartConfig(ok({ series: [{ columnId: 'c-revenue', agg: 'median' }] }), tables)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('median')
  })

  it('refuses no table at all, which is the unbound state', () => {
    expect(validateChartConfig(ok({ tableId: null }), tables).ok).toBe(false)
  })

  it('refuses an empty series list', () => {
    const r = validateChartConfig(ok({ series: [] }), tables)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('at least one series')
  })

  it('refuses a series with no column', () => {
    expect(validateChartConfig(ok({ series: [{ agg: 'sum' }] }), tables).ok).toBe(false)
  })
})
