import { describe, it, expect } from 'vitest'
import {
  asNumber,
  asDate,
  rowMatches,
  computeMetric,
  bucketKey,
  formatMetricValue,
  compactNumber,
  describeBinding,
  aggregationsFor,
  type MetricBinding
} from '../../src/shared/metricBinding'
import type { FbRow, FbTable } from '../../src/shared/fields'

const row = (cells: Record<string, unknown>, i = 0): FbRow =>
  ({ id: `r${i}`, tableId: 't', cells, sortOrder: i, createdAt: 0, updatedAt: 0 }) as FbRow

const TABLE = {
  id: 't',
  taskId: null,
  title: 'Deals',
  schema: {
    columns: [
      { id: 'amt', type: 'number', label: 'Amount', config: {} },
      { id: 'stage', type: 'single-select', label: 'Stage', config: {} },
      { id: 'won', type: 'checkbox', label: 'Won', config: {} },
      { id: 'closed', type: 'date', label: 'Closed', config: {} }
    ]
  },
  createdAt: 0,
  updatedAt: 0
} as unknown as FbTable

const base: MetricBinding = { source: { kind: 'table', tableId: 't' }, agg: 'count' }

describe('asNumber', () => {
  it('reads plain numbers and numeric strings', () => {
    expect(asNumber(42)).toBe(42)
    expect(asNumber('42')).toBe(42)
  })
  it('tolerates what people actually type into a table', () => {
    expect(asNumber('$1,200.50')).toBe(1200.5)
    expect(asNumber('42%')).toBe(42)
    expect(asNumber(' 7 ')).toBe(7)
  })
  it('treats a checkbox as one or zero', () => {
    expect(asNumber(true)).toBe(1)
    expect(asNumber(false)).toBe(0)
  })
  it('returns null for things that are not numbers, rather than 0', () => {
    // The whole point: "not a number" and "zero" are different answers.
    expect(asNumber('')).toBeNull()
    expect(asNumber('abc')).toBeNull()
    expect(asNumber(null)).toBeNull()
    expect(asNumber(undefined)).toBeNull()
    expect(asNumber(NaN)).toBeNull()
  })
})

describe('asDate', () => {
  it('reads ISO strings and epoch numbers', () => {
    expect(asDate('2026-09-15')).toBe(Date.parse('2026-09-15'))
    expect(asDate(1700000000000)).toBe(1700000000000)
  })
  it('returns null for nonsense', () => {
    expect(asDate('not a date')).toBeNull()
    expect(asDate('')).toBeNull()
  })
})

describe('rowMatches', () => {
  const r = row({ amt: 500, stage: 'Won', won: true, note: '' })

  it('passes everything when there are no filters', () => {
    expect(rowMatches(r, undefined)).toBe(true)
    expect(rowMatches(r, [])).toBe(true)
  })
  it('compares text case-insensitively', () => {
    expect(rowMatches(r, [{ columnId: 'stage', op: 'eq', value: 'won' }])).toBe(true)
    expect(rowMatches(r, [{ columnId: 'stage', op: 'ne', value: 'won' }])).toBe(false)
  })
  it('handles contains, empty and ticked', () => {
    expect(rowMatches(r, [{ columnId: 'stage', op: 'contains', value: 'o' }])).toBe(true)
    expect(rowMatches(r, [{ columnId: 'note', op: 'isEmpty' }])).toBe(true)
    expect(rowMatches(r, [{ columnId: 'won', op: 'isTrue' }])).toBe(true)
    expect(rowMatches(r, [{ columnId: 'won', op: 'isFalse' }])).toBe(false)
  })
  it('treats a missing checkbox as not ticked', () => {
    expect(rowMatches(row({}), [{ columnId: 'won', op: 'isFalse' }])).toBe(true)
  })
  it('ANDs several filters', () => {
    expect(
      rowMatches(r, [
        { columnId: 'stage', op: 'eq', value: 'Won' },
        { columnId: 'amt', op: 'gt', value: 400 }
      ])
    ).toBe(true)
    expect(
      rowMatches(r, [
        { columnId: 'stage', op: 'eq', value: 'Won' },
        { columnId: 'amt', op: 'gt', value: 900 }
      ])
    ).toBe(false)
  })
  it('EXCLUDES a row when a comparison cannot be evaluated', () => {
    // A filter that cannot be evaluated has not been satisfied. Passing the row
    // would quietly inflate every total.
    expect(rowMatches(row({ amt: 'n/a' }), [{ columnId: 'amt', op: 'gt', value: 10 }])).toBe(false)
    expect(rowMatches(row({}), [{ columnId: 'amt', op: 'lte', value: 10 }])).toBe(false)
  })
  it('compares dates', () => {
    expect(
      rowMatches(row({ closed: '2026-09-15' }), [
        { columnId: 'closed', op: 'gte', value: '2026-09-01' }
      ])
    ).toBe(true)
  })
})

describe('computeMetric', () => {
  const rows = [
    row({ amt: 100, stage: 'Won', won: true, closed: '2026-09-02' }, 0),
    row({ amt: 200, stage: 'Won', won: true, closed: '2026-09-10' }, 1),
    row({ amt: 50, stage: 'Lost', won: false, closed: '2026-10-05' }, 2),
    row({ amt: 'n/a', stage: 'Open', closed: '' }, 3)
  ]

  it('counts rows', () => {
    expect(computeMetric(rows, base).value).toBe(4)
  })
  it('sums a column, ignoring cells that are not numbers', () => {
    expect(computeMetric(rows, { ...base, agg: 'sum', columnId: 'amt' }).value).toBe(350)
  })
  it('averages only the numeric cells', () => {
    expect(computeMetric(rows, { ...base, agg: 'avg', columnId: 'amt' }).value).toBeCloseTo(116.667, 2)
  })
  it('finds min and max', () => {
    expect(computeMetric(rows, { ...base, agg: 'min', columnId: 'amt' }).value).toBe(50)
    expect(computeMetric(rows, { ...base, agg: 'max', columnId: 'amt' }).value).toBe(200)
  })
  it('counts ticked boxes', () => {
    expect(computeMetric(rows, { ...base, agg: 'countTrue', columnId: 'won' }).value).toBe(2)
  })
  it('counts distinct values, ignoring blanks', () => {
    expect(computeMetric(rows, { ...base, agg: 'countDistinct', columnId: 'stage' }).value).toBe(3)
  })
  it('applies filters before aggregating', () => {
    const r = computeMetric(rows, {
      ...base,
      agg: 'sum',
      columnId: 'amt',
      filters: [{ columnId: 'stage', op: 'eq', value: 'Won' }]
    })
    expect(r.value).toBe(300)
    expect(r.matched).toBe(2)
    expect(r.total).toBe(4)
  })

  it('returns null — not 0 — when there is nothing numeric to reduce', () => {
    // The distinction the whole module exists for: "no data" must not render
    // as a confident zero.
    const r = computeMetric([row({ amt: 'x' })], { ...base, agg: 'sum', columnId: 'amt' })
    expect(r.value).toBeNull()
  })

  it('returns 0 for a count of nothing, which genuinely IS zero', () => {
    const r = computeMetric([], base)
    expect(r.value).toBe(0)
    expect(r.matched).toBe(0)
  })

  it('reports matched and total so 0 can be told from no data', () => {
    const r = computeMetric(rows, {
      ...base,
      filters: [{ columnId: 'stage', op: 'eq', value: 'Nothing' }]
    })
    expect(r.matched).toBe(0)
    expect(r.total).toBe(4)
  })

  it('groups into a series, in chronological order', () => {
    const r = computeMetric(rows, {
      ...base,
      agg: 'sum',
      columnId: 'amt',
      groupBy: { columnId: 'closed', bucket: 'month' }
    })
    expect(r.series).toEqual([
      { key: '2026-09', value: 300 },
      { key: '2026-10', value: 50 }
    ])
  })

  it('has no series when nothing is grouped', () => {
    expect(computeMetric(rows, base).series).toEqual([])
  })
})

describe('bucketKey', () => {
  it('buckets by day, month, quarter and year', () => {
    const d = '2026-09-15T10:00:00Z'
    expect(bucketKey(d, 'day')).toMatch(/^2026-09-15$/)
    expect(bucketKey(d, 'month')).toBe('2026-09')
    expect(bucketKey(d, 'quarter')).toBe('2026 Q3')
    expect(bucketKey(d, 'year')).toBe('2026')
  })
  it('buckets a week to its Monday', () => {
    // 2026-09-15 is a Tuesday; its week starts the 14th.
    expect(bucketKey('2026-09-15T10:00:00Z', 'week')).toBe('2026-09-14')
  })
  it('groups non-dates by their own value', () => {
    expect(bucketKey('Won')).toBe('Won')
  })
  it('gives blanks a visible key rather than an empty one', () => {
    expect(bucketKey('')).toBe('—')
    expect(bucketKey(null)).toBe('—')
  })
})

describe('formatMetricValue', () => {
  it('shows a dash for no value, never a zero', () => {
    expect(formatMetricValue(null, base)).toBe('—')
  })
  it('shows a real zero as zero', () => {
    expect(formatMetricValue(0, base)).toBe('0')
  })
  it('applies currency and percent affixes', () => {
    expect(formatMetricValue(1200, { ...base, format: 'currency' })).toBe('$1,200')
    expect(formatMetricValue(42, { ...base, format: 'percent' })).toBe('42.0%')
  })
  it('honours explicit prefix, suffix and decimals', () => {
    expect(
      formatMetricValue(3.14159, { ...base, prefix: '~', suffix: ' km', decimals: 2 })
    ).toBe('~3.14 km')
  })
  it('compacts only when asked', () => {
    expect(formatMetricValue(12400, base)).toBe('12,400')
    expect(formatMetricValue(12400, { ...base, compact: true })).toBe('12.4k')
  })
  it('defaults an average to one decimal', () => {
    expect(formatMetricValue(116.6667, { ...base, agg: 'avg' })).toBe('116.7')
  })
})

describe('compactNumber', () => {
  it('scales into k, m and b', () => {
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1500)).toBe('1.5k')
    expect(compactNumber(2_000_000)).toBe('2m')
    expect(compactNumber(3_400_000_000)).toBe('3.4b')
  })
  it('handles negatives', () => {
    expect(compactNumber(-1500)).toBe('-1.5k')
  })
})

describe('describeBinding', () => {
  it('says what is being counted, using real column names', () => {
    expect(
      describeBinding(
        {
          ...base,
          agg: 'sum',
          columnId: 'amt',
          filters: [{ columnId: 'stage', op: 'eq', value: 'Won' }]
        },
        TABLE
      )
    ).toBe('Sum of Amount in Deals where Stage is Won')
  })
  it('describes a bare count', () => {
    expect(describeBinding(base, TABLE)).toBe('Rows in Deals')
  })
  it('survives having no table to name', () => {
    expect(describeBinding(base, null)).toBe('Rows')
  })
})

describe('aggregationsFor', () => {
  it('offers arithmetic only where it means something', () => {
    expect(aggregationsFor('number')).toContain('sum')
    expect(aggregationsFor('text-short')).not.toContain('sum')
    expect(aggregationsFor('checkbox')).toContain('countTrue')
    expect(aggregationsFor(undefined)).toContain('count')
  })
})
