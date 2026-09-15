import { useEffect, useMemo, useState } from 'react'
import type { FbRow, FbTable } from '@shared/fields'
import {
  AGGREGATION_LABEL,
  aggregationsFor,
  computeMetric,
  describeBinding,
  formatMetricValue,
  type Aggregation,
  type MetricBinding,
  type MetricFilter
} from '@shared/metricBinding'
import Icon from '../Icon'

// Pointing a card at real data.
//
// Three ways in, because people arrive knowing different things: search for the
// table by name, describe what you want and let the model build it, or set the
// aggregation and filters by hand. All three produce the same binding, and the
// preview underneath computes against the real rows the whole time -- a config
// screen that cannot show you the number it will produce is one you have to
// save and check, which is how wrong cards ship.

export interface MetricBindingEditorProps {
  binding: MetricBinding | null
  onChange: (binding: MetricBinding | null, title?: string) => void
  onClose: () => void
}

export default function MetricBindingEditor({
  binding,
  onChange,
  onClose
}: MetricBindingEditorProps): JSX.Element {
  const [tables, setTables] = useState<FbTable[] | null>(null)
  const [rows, setRows] = useState<FbRow[]>([])
  const [query, setQuery] = useState('')
  const [ask, setAsk] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiNote, setAiNote] = useState<string | null>(null)

  const api = (window as { api?: Record<string, any> }).api

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = (await api?.tables?.list?.()) ?? []
        if (alive) setTables(list)
      } catch {
        if (alive) setTables([])
      }
    })()
    return () => {
      alive = false
    }
  }, [api])

  const tableId = binding?.source.tableId
  useEffect(() => {
    let alive = true
    if (!tableId) {
      setRows([])
      return
    }
    void (async () => {
      try {
        const r = (await api?.tables?.listRows?.(tableId)) ?? []
        if (alive) setRows(r)
      } catch {
        if (alive) setRows([])
      }
    })()
    return () => {
      alive = false
    }
  }, [api, tableId])

  const table = useMemo(
    () => tables?.find((t) => t.id === tableId) ?? null,
    [tables, tableId]
  )
  const columns = table?.schema?.columns ?? []

  // Search across table names AND column names: people look for "revenue"
  // as often as they look for "Deals".
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!tables) return []
    if (!q) return tables.slice(0, 8)
    return tables
      .filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.schema?.columns ?? []).some((c) => c.label.toLowerCase().includes(q))
      )
      .slice(0, 8)
  }, [tables, query])

  const preview = useMemo(
    () => (binding ? computeMetric(rows, binding) : null),
    [rows, binding]
  )

  const patch = (p: Partial<MetricBinding>): void => {
    if (!binding) return
    onChange({ ...binding, ...p })
  }

  const chooseTable = (t: FbTable): void => {
    const firstNumber = (t.schema?.columns ?? []).find((c) => c.type === 'number')
    onChange(
      {
        source: { kind: 'table', tableId: t.id },
        // Opening on a bare row count is the one binding that is always valid,
        // whatever the table holds.
        agg: firstNumber ? 'sum' : 'count',
        columnId: firstNumber?.id
      },
      t.title
    )
    setQuery('')
  }

  const autobuild = async (): Promise<void> => {
    const q = ask.trim()
    if (!q) return
    setAiBusy(true)
    setAiNote(null)
    try {
      const res = await api?.metricBindings?.build?.(q)
      if (!res?.ok) {
        setAiNote(
          res?.needsApiKey
            ? 'No Anthropic API key set — add one in Settings → AI.'
            : res?.error || 'Could not build that.'
        )
        return
      }
      onChange(res.binding as MetricBinding, res.title)
      setAiNote(res.note ?? null)
      setAsk('')
    } finally {
      setAiBusy(false)
    }
  }

  const addFilter = (): void => {
    if (!binding || columns.length === 0) return
    patch({
      filters: [...(binding.filters ?? []), { columnId: columns[0].id, op: 'eq', value: '' }]
    })
  }
  const setFilter = (i: number, f: Partial<MetricFilter>): void => {
    if (!binding) return
    const next = [...(binding.filters ?? [])]
    next[i] = { ...next[i], ...f }
    patch({ filters: next })
  }
  const removeFilter = (i: number): void => {
    if (!binding) return
    patch({ filters: (binding.filters ?? []).filter((_, k) => k !== i) })
  }

  const aggOptions = aggregationsFor(columns.find((c) => c.id === binding?.columnId)?.type)

  return (
    <div className="flex h-full flex-col bg-[var(--surface)] text-[11px]" data-testid="metric-binding-editor">
      <div className="flex items-center gap-1.5 border-b border-[var(--line)] px-2 py-1.5">
        <Icon name="database" size={13} className="text-[var(--ink-40)]" />
        <span className="flex-1 text-[11px] font-semibold text-[var(--ink-80)]">Data source</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
          aria-label="Done"
        >
          <Icon name="check" size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2">
        {/* Describe it */}
        <div className="flex gap-1">
          <input
            className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
            placeholder="Describe it — “total won deals this quarter”"
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void autobuild()
            }}
            data-testid="metric-ask"
          />
          <button
            type="button"
            onClick={() => void autobuild()}
            disabled={aiBusy || !ask.trim()}
            className="widget-nodrag inline-flex shrink-0 items-center gap-0.5 rounded border border-[var(--line)] px-1.5 py-1 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
          >
            <Icon name={aiBusy ? 'hourglass_empty' : 'auto_awesome'} size={12} />
            {aiBusy ? '…' : 'Build'}
          </button>
        </div>
        {aiNote && <p className="text-[10px] leading-snug text-[var(--ink-50)]">{aiNote}</p>}

        {/* Or find the table */}
        <div className="flex flex-col gap-1">
          <input
            className="widget-nodrag rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
            placeholder="…or search tables and columns"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="metric-search"
          />
          {tables === null ? (
            <span className="text-[10px] text-[var(--ink-40)]">Loading tables…</span>
          ) : matches.length === 0 ? (
            <span className="text-[10px] text-[var(--ink-40)]">
              {tables.length === 0
                ? 'No tables in this workspace yet.'
                : 'Nothing matches that.'}
            </span>
          ) : (
            <div className="flex flex-col">
              {matches.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => chooseTable(t)}
                  className={`widget-nodrag flex items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-[var(--surface-sunken)] ${
                    t.id === tableId ? 'text-[var(--accent)]' : 'text-[var(--ink-70)]'
                  }`}
                >
                  <Icon name="table_chart" size={11} className="shrink-0" />
                  <span className="truncate">{t.title || 'Untitled table'}</span>
                  <span className="ml-auto shrink-0 text-[9px] text-[var(--ink-35)]">
                    {(t.schema?.columns ?? []).length} cols
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {binding && table && (
          <>
            <div className="h-px bg-[var(--line)]" />

            <label className="flex items-center gap-1.5">
              <span className="w-[58px] shrink-0 text-[var(--ink-50)]">Measure</span>
              <select
                className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-1"
                value={binding.agg}
                onChange={(e) => patch({ agg: e.target.value as Aggregation })}
              >
                {aggOptions.map((a) => (
                  <option key={a} value={a}>
                    {AGGREGATION_LABEL[a]}
                  </option>
                ))}
              </select>
            </label>

            {binding.agg !== 'count' && (
              <label className="flex items-center gap-1.5">
                <span className="w-[58px] shrink-0 text-[var(--ink-50)]">Column</span>
                <select
                  className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-1"
                  value={binding.columnId ?? ''}
                  onChange={(e) => patch({ columnId: e.target.value || undefined })}
                >
                  <option value="">Pick a column</option>
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <span className="text-[var(--ink-50)]">Only rows where</span>
                <button
                  type="button"
                  onClick={addFilter}
                  className="widget-nodrag ml-auto rounded px-1 text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
                >
                  + Add
                </button>
              </div>
              {(binding.filters ?? []).length === 0 && (
                <span className="text-[10px] text-[var(--ink-35)]">Every row counts.</span>
              )}
              {(binding.filters ?? []).map((f, i) => (
                <div key={i} className="flex items-center gap-1">
                  <select
                    className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
                    value={f.columnId}
                    onChange={(e) => setFilter(i, { columnId: e.target.value })}
                  >
                    {columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="widget-nodrag shrink-0 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
                    value={f.op}
                    onChange={(e) => setFilter(i, { op: e.target.value as MetricFilter['op'] })}
                  >
                    <option value="eq">is</option>
                    <option value="ne">is not</option>
                    <option value="contains">contains</option>
                    <option value="gt">&gt;</option>
                    <option value="gte">≥</option>
                    <option value="lt">&lt;</option>
                    <option value="lte">≤</option>
                    <option value="isTrue">is ticked</option>
                    <option value="isFalse">not ticked</option>
                    <option value="notEmpty">is set</option>
                    <option value="isEmpty">is empty</option>
                  </select>
                  {!['isTrue', 'isFalse', 'isEmpty', 'notEmpty'].includes(f.op) && (
                    <input
                      className="widget-nodrag w-[70px] shrink-0 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
                      value={String(f.value ?? '')}
                      onChange={(e) => setFilter(i, { value: e.target.value })}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeFilter(i)}
                    className="widget-nodrag shrink-0 text-[var(--ink-30)] hover:text-rose-500"
                    aria-label="Remove filter"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>

            <label className="flex items-center gap-1.5">
              <span className="w-[58px] shrink-0 text-[var(--ink-50)]">Trend by</span>
              <select
                className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-1"
                value={binding.groupBy?.columnId ?? ''}
                onChange={(e) =>
                  patch({
                    groupBy: e.target.value
                      ? { columnId: e.target.value, bucket: binding.groupBy?.bucket ?? 'month' }
                      : undefined
                  })
                }
              >
                <option value="">No trend line</option>
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              {binding.groupBy && (
                <select
                  className="widget-nodrag shrink-0 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-1"
                  value={binding.groupBy.bucket ?? 'month'}
                  onChange={(e) =>
                    patch({
                      groupBy: {
                        columnId: binding.groupBy!.columnId,
                        bucket: e.target.value as never
                      }
                    })
                  }
                >
                  <option value="day">day</option>
                  <option value="week">week</option>
                  <option value="month">month</option>
                  <option value="quarter">quarter</option>
                  <option value="year">year</option>
                </select>
              )}
            </label>

            <div className="flex items-center gap-1.5">
              <span className="w-[58px] shrink-0 text-[var(--ink-50)]">Show as</span>
              <select
                className="widget-nodrag rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-1"
                value={binding.format ?? 'plain'}
                onChange={(e) => patch({ format: e.target.value as never })}
              >
                <option value="plain">Plain</option>
                <option value="currency">Currency</option>
                <option value="percent">Percent</option>
              </select>
              <label className="widget-nodrag flex items-center gap-1 text-[var(--ink-60)]">
                <input
                  type="checkbox"
                  checked={Boolean(binding.compact)}
                  onChange={(e) => patch({ compact: e.target.checked })}
                />
                Compact
              </label>
            </div>

            {/* The preview. A config screen that cannot show the number it
                will produce is one you have to save and then go and check. */}
            <div className="rounded border border-[var(--line)] bg-[var(--surface-sunken)] px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wide text-[var(--ink-40)]">Preview</div>
              <div className="text-[18px] font-semibold tabular-nums text-[var(--ink-90)]">
                {formatMetricValue(preview?.value ?? null, binding)}
              </div>
              <div className="text-[9px] leading-snug text-[var(--ink-45)]">
                {describeBinding(binding, table)}
              </div>
              <div className="text-[9px] text-[var(--ink-40)]">
                {preview
                  ? `${preview.matched} of ${preview.total} rows${
                      preview.series.length > 0 ? ` · ${preview.series.length} points` : ''
                    }`
                  : ''}
                {preview && preview.value === null && preview.matched > 0
                  ? ' · nothing numeric to measure'
                  : ''}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
