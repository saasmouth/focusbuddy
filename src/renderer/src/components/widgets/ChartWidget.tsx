import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from 'recharts'
import type { Widget } from '@shared/types'
import type { FbTable, FbRow, FieldDefinition } from '@shared/fields'
import {
  type ChartConfig,
  type ChartType,
  type Aggregation,
  CHART_PALETTE,
  CHART_TYPE_LABELS,
  CHART_TYPE_ICONS,
  AGG_LABELS,
  defaultChartConfig,
  computeChartData,
  seriesKey,
  seriesLabel,
  cellToLabel
} from '@shared/charts'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useTablesStore } from '../../stores/tables'
import { useWidgetStore } from '../../stores/widgets'
import { useWidgetReadOnly } from '../../lib/widgetSurface'

// PlexiDash chart widget. Binds to a Table (the typed fb_tables store), reads its
// real rows, and renders an aggregated bar / line / area / pie / KPI view. The
// config (which table, chart type, category column, series + aggregation) lives
// in widget.content as JSON, exactly like the table widget stores its schema.
// Nothing is fabricated: an unbound chart shows a picker, an empty table shows an
// honest empty state, and every number is aggregated from real cells.

const CHART_TYPES: ChartType[] = ['bar', 'line', 'area', 'pie', 'kpi']
const AGGS: Aggregation[] = ['sum', 'avg', 'count', 'min', 'max']

function parseConfig(content: string | null | undefined): ChartConfig {
  if (!content) return defaultChartConfig()
  try {
    const c = JSON.parse(content) as Partial<ChartConfig>
    return {
      tableId: c.tableId ?? null,
      type: c.type ?? 'bar',
      xColumnId: c.xColumnId ?? null,
      series: Array.isArray(c.series) ? c.series : [],
      title: c.title
    }
  } catch {
    return defaultChartConfig()
  }
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function ChartWidget({ widget }: Props): JSX.Element {
  const config = useMemo(() => parseConfig(widget.content), [widget.content])
  const updateWidget = useWidgetStore((s) => s.update)

  const tablesById = useTablesStore((s) => s.tables)
  const rowsByTable = useTablesStore((s) => s.rows)
  const ensureTable = useTablesStore((s) => s.ensureTableLoaded)
  const ensureRows = useTablesStore((s) => s.ensureRowsLoaded)

  // Every table the user could chart, for the picker. Loaded once from the
  // store's source of record (not fabricated) and refreshed when the picker opens.
  const [allTables, setAllTables] = useState<FbTable[]>([])
  const [editing, setEditing] = useState(false)
  // A viewer (read-only, lib/widgetSurface): the chart and its title. The data
  // panel never opens, and no control to change the chart is drawn.
  const readOnly = useWidgetReadOnly()

  const loadTableList = async (): Promise<void> => {
    const list = await window.api.tables.list().catch(() => [] as FbTable[])
    setAllTables(list)
  }

  // Open the editor by default on a brand-new, unbound chart so the first thing
  // the user sees is "pick your data", not an empty canvas.
  useEffect(() => {
    if (!config.tableId && !readOnly) {
      setEditing(true)
      void loadTableList()
    }
  }, [config.tableId, readOnly])

  // Pull the bound table's schema + rows into the store so they render live and
  // update when the underlying data changes.
  useEffect(() => {
    if (!config.tableId) return
    void ensureTable(config.tableId).then((t) => {
      if (t) void ensureRows(config.tableId as string)
    })
  }, [config.tableId, ensureTable, ensureRows])

  const table = config.tableId ? tablesById[config.tableId] : null
  const columns: FieldDefinition[] = table?.schema.columns ?? []
  const rows: FbRow[] = config.tableId ? rowsByTable[config.tableId] ?? [] : []

  function save(next: ChartConfig): void {
    void updateWidget(widget.id, { content: JSON.stringify(next) })
  }

  // Resolve select-option ids to their labels on the category axis so a pie /
  // bar reads "Marketing", not an opaque option id.
  function labelForCell(columnId: string, value: unknown): string {
    const col = columns.find((c) => c.id === columnId)
    if (col && (col.type === 'single-select' || col.type === 'multi-select')) {
      const opts = (col.config as { options?: { id: string; label: string }[] }).options ?? []
      if (Array.isArray(value)) {
        const labels = value.map((id) => opts.find((o) => o.id === id)?.label ?? String(id))
        return labels.length ? labels.join(', ') : '(empty)'
      }
      const o = opts.find((opt) => opt.id === value)
      return o ? o.label : cellToLabel(value)
    }
    return cellToLabel(value)
  }

  const computed = useMemo(
    () => computeChartData(config, rows, columns, labelForCell),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, rows, columns]
  )

  const headerLabel = config.title?.trim() || (table ? `${table.title} chart` : 'Chart')

  return (
    <WidgetFrame widget={widget} headerLabel={headerLabel} headerAccent="bg-indigo-300/50 dark:bg-indigo-400/20">
      <div className="h-full w-full flex flex-col bg-[var(--surface-raised)]" data-testid="chart-widget">
        {/* Toolbar: title, type quick-switch, edit toggle. */}
        <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--edge-soft)]">
          <Icon name={CHART_TYPE_ICONS[config.type]} size={15} className="text-indigo-500 shrink-0" />
          {readOnly ? (
            <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-[var(--ink-90)]">{config.title ?? ''}</span>
          ) : (
          <>
          <input
            value={config.title ?? ''}
            onChange={(e) => save({ ...config, title: e.target.value })}
            placeholder="Untitled chart"
            className="flex-1 min-w-0 bg-transparent text-[13px] font-semibold text-[var(--ink-90)] placeholder:text-[var(--ink-30)]"
          />
          <button
            onClick={() => {
              setEditing((v) => !v)
              if (!editing) void loadTableList()
            }}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
              editing ? 'bg-indigo-500 text-white' : 'text-indigo-500 hover:bg-indigo-500/10'
            }`}
            data-testid="chart-edit-toggle"
            title="Configure chart data"
          >
            <Icon name="tune" size={12} />
            <span>Data</span>
          </button>
          </>
          )}
        </div>

        {editing && !readOnly && (
          <ChartConfigPanel
            config={config}
            tables={allTables}
            columns={columns}
            onChange={save}
          />
        )}

        <div className="flex-1 min-h-0 p-2">
          <ChartCanvas config={config} columns={columns} computed={computed} readOnly={readOnly} />
        </div>
      </div>
    </WidgetFrame>
  )
}

// ── The chart surface ───────────────────────────────────────────────────────

function ChartCanvas({
  config,
  columns,
  computed,
  readOnly = false
}: {
  config: ChartConfig
  columns: FieldDefinition[]
  computed: ReturnType<typeof computeChartData>
  /** A viewer has no Data panel, so the empty states do not point at one. */
  readOnly?: boolean
}): JSX.Element {
  if (!config.tableId) {
    return <EmptyState icon="add_chart" text={readOnly ? 'This chart has no data yet.' : 'Pick a table and a value to chart in the Data panel.'} />
  }
  if (config.series.length === 0) {
    return <EmptyState icon="functions" text={readOnly ? 'This chart has no values yet.' : 'Add at least one value series in the Data panel.'} />
  }
  // Applies to KPI too: a metric over a table with no rows shows the honest
  // empty state rather than a bold "0" that reads like a real measured value.
  if (computed.empty) {
    return <EmptyState icon="table_rows" text="This table has no rows yet. The chart fills in as data arrives." />
  }

  if (config.type === 'kpi') {
    const s = config.series[0]
    const val = computed.kpi
    return (
      <div className="h-full w-full flex flex-col items-center justify-center">
        <div className="text-[42px] leading-none font-bold tabular-nums text-[var(--ink-100)]">
          {val === null ? '—' : formatNumber(val)}
        </div>
        <div className="mt-2 text-[12px] text-[var(--ink-50)] text-center px-3">
          {seriesLabel(s, columns)}
        </div>
      </div>
    )
  }

  const axisTick = { fontSize: 10, fill: 'currentColor' }
  const gridStroke = 'currentColor'

  if (config.type === 'pie') {
    const s = config.series[0]
    const key = seriesKey(s, 0)
    const pieData = computed.data.map((d) => ({ name: d.x, value: Number(d[key] ?? 0) }))
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={pieData} dataKey="value" nameKey="name" outerRadius="78%" label>
            {pieData.map((_, i) => (
              <Cell key={i} fill={config.series[0].color ?? CHART_PALETTE[i % CHART_PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  const seriesEls = config.series.map((s, i) => {
    const key = seriesKey(s, i)
    const color = s.color ?? CHART_PALETTE[i % CHART_PALETTE.length]
    const name = seriesLabel(s, columns)
    if (config.type === 'line') {
      return <Line key={key} type="monotone" dataKey={key} name={name} stroke={color} strokeWidth={2} dot={false} />
    }
    if (config.type === 'area') {
      return <Area key={key} type="monotone" dataKey={key} name={name} stroke={color} fill={color} fillOpacity={0.18} />
    }
    return <Bar key={key} dataKey={key} name={name} fill={color} radius={[3, 3, 0, 0]} />
  })

  const common = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} strokeOpacity={0.12} />
      <XAxis dataKey="x" tick={axisTick} stroke={gridStroke} strokeOpacity={0.3} />
      <YAxis tick={axisTick} stroke={gridStroke} strokeOpacity={0.3} width={36} />
      <Tooltip contentStyle={{ fontSize: 11 }} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
    </>
  )

  return (
    <ResponsiveContainer width="100%" height="100%">
      {config.type === 'line' ? (
        <LineChart data={computed.data} className="text-[var(--ink-50)]">
          {common}
          {seriesEls}
        </LineChart>
      ) : config.type === 'area' ? (
        <AreaChart data={computed.data} className="text-[var(--ink-50)]">
          {common}
          {seriesEls}
        </AreaChart>
      ) : (
        <BarChart data={computed.data} className="text-[var(--ink-50)]">
          {common}
          {seriesEls}
        </BarChart>
      )}
    </ResponsiveContainer>
  )
}

function EmptyState({ icon, text }: { icon: string; text: string }): JSX.Element {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-center px-6">
      <Icon name={icon} size={26} className="text-[var(--ink-30)]" />
      <p className="mt-2 text-[12px] text-[var(--ink-50)] leading-relaxed max-w-[240px]">{text}</p>
    </div>
  )
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

// ── Config panel ────────────────────────────────────────────────────────────

function ChartConfigPanel({
  config,
  tables,
  columns,
  onChange
}: {
  config: ChartConfig
  tables: FbTable[]
  columns: FieldDefinition[]
  onChange: (next: ChartConfig) => void
}): JSX.Element {
  const selectCls =
    'text-[11px] bg-[var(--surface-sunken)] rounded px-1.5 py-1 text-[var(--ink-100)] focus:border-accent'

  return (
    <div className="shrink-0 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] px-2.5 py-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[10px] uppercase tracking-wider text-[var(--ink-40)]">Table</label>
        <select
          value={config.tableId ?? ''}
          onChange={(e) => onChange({ ...config, tableId: e.target.value || null, xColumnId: null, series: [] })}
          className={selectCls}
          data-testid="chart-table-select"
        >
          <option value="">Choose a table…</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title || 'Untitled table'}
            </option>
          ))}
        </select>

        <label className="text-[10px] uppercase tracking-wider text-[var(--ink-40)] ml-1">Type</label>
        <div className="inline-flex rounded-md bg-[var(--surface-sunken)] overflow-hidden">
          {CHART_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => onChange({ ...config, type: t })}
              className={`px-1.5 py-1 text-[11px] inline-flex items-center gap-1 ${
                config.type === t
                  ? 'bg-indigo-500 text-white'
                  : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
              }`}
              title={CHART_TYPE_LABELS[t]}
            >
              <Icon name={CHART_TYPE_ICONS[t]} size={12} />
            </button>
          ))}
        </div>
      </div>

      {config.type !== 'kpi' && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[10px] uppercase tracking-wider text-[var(--ink-40)]">Group by</label>
          <select
            value={config.xColumnId ?? ''}
            onChange={(e) => onChange({ ...config, xColumnId: e.target.value || null })}
            className={selectCls}
            data-testid="chart-x-select"
            disabled={!config.tableId}
          >
            <option value="">All rows (one group)</option>
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Series editor. KPI uses a single series; the others allow several. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-wider text-[var(--ink-40)]">
            {config.type === 'kpi' ? 'Metric' : 'Values'}
          </label>
          {(config.type !== 'kpi' || config.series.length === 0) && (
            <button
              onClick={() => {
                const first = columns[0]
                if (!first) return
                const next = config.type === 'kpi' ? [] : config.series
                onChange({ ...config, series: [...next, { columnId: first.id, agg: 'sum' }] })
              }}
              className="text-[11px] text-indigo-500 hover:bg-indigo-500/10 rounded px-1.5 py-0.5 inline-flex items-center gap-1 disabled:opacity-40"
              disabled={!config.tableId || columns.length === 0}
              data-testid="chart-add-series"
            >
              <Icon name="add" size={12} /> Add value
            </button>
          )}
        </div>

        {config.series.length === 0 ? (
          <p className="text-[11px] text-[var(--ink-40)]">
            No value yet. Add one to draw the chart.
          </p>
        ) : (
          (config.type === 'kpi' ? config.series.slice(0, 1) : config.series).map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <select
                value={s.agg}
                onChange={(e) => {
                  const series = [...config.series]
                  series[i] = { ...s, agg: e.target.value as Aggregation }
                  onChange({ ...config, series })
                }}
                className={selectCls}
              >
                {AGGS.map((a) => (
                  <option key={a} value={a}>
                    {AGG_LABELS[a]}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-[var(--ink-40)]">of</span>
              <select
                value={s.columnId}
                onChange={(e) => {
                  const series = [...config.series]
                  series[i] = { ...s, columnId: e.target.value }
                  onChange({ ...config, series })
                }}
                className={`${selectCls} flex-1`}
              >
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => onChange({ ...config, series: config.series.filter((_, j) => j !== i) })}
                className="text-[var(--ink-40)] hover:text-red-600 p-0.5"
                title="Remove value"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
