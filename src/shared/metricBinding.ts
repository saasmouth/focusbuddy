import type { FbRow, FbTable, FieldDefinition } from './fields'

// Where a number on a card actually comes from.
//
// Before this, a stat card held a number somebody typed. That is fine for a
// target and a lie for a measurement: it cannot go out of date, because it was
// never in date. A binding points the card at a real table and says how to
// reduce it, so the card is a VIEW of data rather than a copy of it.
//
// Everything here is pure. The widgets fetch rows; this decides what they mean.

export type Aggregation =
  | 'count'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'countDistinct'
  | 'countTrue'

export const AGGREGATION_LABEL: Record<Aggregation, string> = {
  count: 'Number of rows',
  sum: 'Sum',
  avg: 'Average',
  min: 'Smallest',
  max: 'Largest',
  countDistinct: 'Distinct values',
  countTrue: 'Number ticked'
}

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'notEmpty'
  | 'isTrue'
  | 'isFalse'

export interface MetricFilter {
  columnId: string
  op: FilterOp
  value?: unknown
}

export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface MetricBinding {
  /** Which table. Other source kinds can join this union without changing callers. */
  source: { kind: 'table'; tableId: string }
  /** The column being reduced. Absent for `count`, which reduces the rows themselves. */
  columnId?: string
  agg: Aggregation
  filters?: MetricFilter[]
  /** Turns one number into a series — the line behind the number. */
  groupBy?: { columnId: string; bucket?: Bucket }
  /** Presentation. */
  format?: 'plain' | 'currency' | 'percent'
  prefix?: string
  suffix?: string
  decimals?: number
  compact?: boolean
}

export interface MetricResult {
  /** null when there is genuinely nothing to compute — never 0 standing in. */
  value: number | null
  /** Ordered points when groupBy is set; empty otherwise. */
  series: Array<{ key: string; value: number }>
  /** Rows that survived the filters, so "0" can be distinguished from "no data". */
  matched: number
  /** Rows in the table before filtering. */
  total: number
}

// ── Value coercion ──────────────────────────────────────────────────────────

/** A cell as a number, or null when it simply is not one. */
export function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return null
    // Tolerate what people actually type into a table: $1,200.50 and 42%.
    const cleaned = t.replace(/[$£€,\s]/g, '').replace(/%$/, '')
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** A cell as a timestamp, or null. */
export function asDate(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

const isEmpty = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0)

const asText = (v: unknown): string =>
  v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v)

// ── Filtering ───────────────────────────────────────────────────────────────

export function rowMatches(row: FbRow, filters: readonly MetricFilter[] | undefined): boolean {
  if (!filters || filters.length === 0) return true
  // Filters are ANDed. One clause per line reads the way people describe it:
  // "won deals, this quarter, over 10k".
  return filters.every((f) => {
    const cell = row.cells?.[f.columnId]
    switch (f.op) {
      case 'isEmpty':
        return isEmpty(cell)
      case 'notEmpty':
        return !isEmpty(cell)
      case 'isTrue':
        return cell === true
      case 'isFalse':
        return cell === false || cell === undefined || cell === null
      case 'eq':
        return asText(cell).toLowerCase() === asText(f.value).toLowerCase()
      case 'ne':
        return asText(cell).toLowerCase() !== asText(f.value).toLowerCase()
      case 'contains':
        return asText(cell).toLowerCase().includes(asText(f.value).toLowerCase())
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const a = asNumber(cell) ?? asDate(cell)
        const b = asNumber(f.value) ?? asDate(f.value)
        // A comparison against something that is not a number excludes the row
        // rather than silently passing it — a filter that cannot be evaluated
        // has not been satisfied.
        if (a === null || b === null) return false
        return f.op === 'gt' ? a > b : f.op === 'gte' ? a >= b : f.op === 'lt' ? a < b : a <= b
      }
      default:
        return true
    }
  })
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function reduce(values: unknown[], agg: Aggregation): number | null {
  if (agg === 'count') return values.length
  if (agg === 'countTrue') return values.filter((v) => v === true).length
  if (agg === 'countDistinct') {
    return new Set(values.filter((v) => !isEmpty(v)).map((v) => asText(v).toLowerCase())).size
  }
  const nums = values.map(asNumber).filter((n): n is number => n !== null)
  // No numbers means no answer. Returning 0 would read as "the sum is zero",
  // which is a different and usually wrong statement.
  if (nums.length === 0) return null
  switch (agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length
    case 'min':
      return Math.min(...nums)
    case 'max':
      return Math.max(...nums)
    default:
      return null
  }
}

/** Bucket key for a grouped point. Dates bucket; everything else groups by value. */
export function bucketKey(value: unknown, bucket?: Bucket): string {
  const ts = bucket ? asDate(value) : null
  if (ts === null) return asText(value) || '—'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  switch (bucket) {
    case 'year':
      return String(d.getFullYear())
    case 'quarter':
      return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`
    case 'month':
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}`
    case 'week': {
      // ISO-ish week start (Monday), which is what people mean by "this week".
      const m = new Date(d)
      m.setDate(d.getDate() - ((d.getDay() + 6) % 7))
      return `${m.getFullYear()}-${p(m.getMonth() + 1)}-${p(m.getDate())}`
    }
    default:
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
}

export function computeMetric(rows: readonly FbRow[], binding: MetricBinding): MetricResult {
  const total = rows.length
  const matching = rows.filter((r) => rowMatches(r, binding.filters))
  const pick = (r: FbRow): unknown => (binding.columnId ? r.cells?.[binding.columnId] : undefined)

  const value = reduce(
    binding.agg === 'count' ? matching.map(() => 1) : matching.map(pick),
    binding.agg
  )

  let series: MetricResult['series'] = []
  if (binding.groupBy?.columnId) {
    const groups = new Map<string, unknown[]>()
    for (const r of matching) {
      const key = bucketKey(r.cells?.[binding.groupBy.columnId], binding.groupBy.bucket)
      const list = groups.get(key)
      const v = binding.agg === 'count' ? 1 : pick(r)
      if (list) list.push(v)
      else groups.set(key, [v])
    }
    series = [...groups.entries()]
      .map(([key, vals]) => ({ key, value: reduce(vals, binding.agg) }))
      .filter((p): p is { key: string; value: number } => p.value !== null)
      // Bucket keys are built to sort lexically into chronological order.
      .sort((a, b) => a.key.localeCompare(b.key))
  }

  return { value, series, matched: matching.length, total }
}

// ── Presentation ────────────────────────────────────────────────────────────

/** 12400 -> 12.4k. Only when asked: precision matters on most cards. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}b`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/**
 * The number as it should be read.
 *
 * `null` renders as an em dash, never as 0: a card that shows zero when it
 * means "nothing to measure" is the exact failure this whole binding exists to
 * avoid.
 */
export function formatMetricValue(value: number | null, binding: MetricBinding): string {
  if (value === null) return '—'
  const decimals =
    binding.decimals ?? (binding.agg === 'avg' || binding.format === 'percent' ? 1 : 0)
  const body = binding.compact
    ? compactNumber(Number(value.toFixed(decimals)))
    : value.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      })
  const prefix = binding.prefix ?? (binding.format === 'currency' ? '$' : '')
  const suffix = binding.suffix ?? (binding.format === 'percent' ? '%' : '')
  return `${prefix}${body}${suffix}`
}

/** A sentence saying exactly what is being counted, for the face of the card. */
export function describeBinding(binding: MetricBinding, table?: FbTable | null): string {
  const cols = table?.schema?.columns ?? []
  const nameOf = (id?: string): string =>
    cols.find((c: FieldDefinition) => c.id === id)?.label ?? id ?? ''
  const parts: string[] = []
  parts.push(
    binding.agg === 'count'
      ? 'Rows'
      : `${AGGREGATION_LABEL[binding.agg]} of ${nameOf(binding.columnId) || 'a column'}`
  )
  if (table?.title) parts.push(`in ${table.title}`)
  for (const f of binding.filters ?? []) {
    const n = nameOf(f.columnId)
    if (f.op === 'isEmpty') parts.push(`where ${n} is empty`)
    else if (f.op === 'notEmpty') parts.push(`where ${n} is set`)
    else if (f.op === 'isTrue') parts.push(`where ${n} is ticked`)
    else if (f.op === 'isFalse') parts.push(`where ${n} is not ticked`)
    else parts.push(`where ${n} ${OP_WORD[f.op] ?? f.op} ${asText(f.value)}`)
  }
  if (binding.groupBy?.columnId) {
    parts.push(`by ${nameOf(binding.groupBy.columnId)}${binding.groupBy.bucket ? ` (${binding.groupBy.bucket})` : ''}`)
  }
  return parts.join(' ')
}

const OP_WORD: Partial<Record<FilterOp, string>> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤'
}

/** Aggregations that make sense for a column of this type. */
export function aggregationsFor(type: FieldDefinition['type'] | undefined): Aggregation[] {
  switch (type) {
    case 'number':
      return ['sum', 'avg', 'min', 'max', 'count', 'countDistinct']
    case 'checkbox':
      return ['countTrue', 'count']
    case 'date':
      return ['count', 'min', 'max', 'countDistinct']
    default:
      return ['count', 'countDistinct']
  }
}
