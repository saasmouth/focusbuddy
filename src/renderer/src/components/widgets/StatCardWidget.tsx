import { useEffect, useMemo, useState } from 'react'
import type { Widget } from '@shared/types'
import type { FbRow } from '@shared/fields'
import {
  computeMetric,
  formatMetricValue,
  type MetricBinding
} from '@shared/metricBinding'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import MetricBindingEditor from './MetricBindingEditor'
import { useWidgetStore } from '../../stores/widgets'
import { sparklinePath, delta, compact } from '../../lib/sparkline'

// One number worth watching, its direction of travel, and how it got there.
//
// The point of the card is the THIRD of those. A number on its own is trivia
// and a number with an arrow is an assertion; the line underneath is what lets
// somebody decide whether the arrow means anything. So the sparkline is not
// decoration and is drawn even when the series is short.
//
// Tabs switch between series held in the same widget, which is how these are
// actually read -- sales, then rentals, then growth -- rather than as four
// separate cards competing for the same corner of a desk.

export interface StatSeries {
  label: string
  value?: number
  /** Shown instead of the number when the value is not a plain quantity. */
  display?: string
  unit?: string
  points: number[]
  /** Said under the number: what the series is, or over what period. */
  caption?: string
}

export interface StatCardContent {
  title?: string
  series: StatSeries[]
  activeIndex?: number
  /**
   * Where the number comes from, when it comes from somewhere.
   *
   * With a binding the card is a VIEW of a table and `series` is ignored;
   * without one it holds whatever was typed into it. Both are legitimate -- a
   * target is typed, a measurement is bound -- and the card says which it is
   * rather than letting a stale number pass for a live one.
   */
  binding?: MetricBinding | null
}

const EMPTY: StatCardContent = { series: [] }

function parse(raw: string | null | undefined): StatCardContent {
  if (!raw) return EMPTY
  try {
    const p = JSON.parse(raw) as StatCardContent
    return Array.isArray(p?.series) ? { ...p, series: p.series } : EMPTY
  } catch {
    return EMPTY
  }
}

export default function StatCardWidget({ widget }: { widget: Widget }): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const model = useMemo(() => parse(widget.content), [widget.content])
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<FbRow[]>([])
  const [rowError, setRowError] = useState<string | null>(null)

  const binding = model.binding ?? null
  const tableId = binding?.source.tableId

  // Live rows for a bound card, refreshed whenever ANY writer changes the
  // table — a card that only updates when you reopen the desk is a screenshot.
  useEffect(() => {
    if (!tableId) {
      setRows([])
      setRowError(null)
      return
    }
    const api = (window as { api?: Record<string, any> }).api
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const r = (await api?.tables?.listRows?.(tableId)) ?? []
        if (alive) {
          setRows(r)
          setRowError(null)
        }
      } catch (e) {
        if (alive) {
          setRows([])
          setRowError(e instanceof Error ? e.message : String(e))
        }
      }
    }
    void load()
    const off = api?.tables?.onRowsChanged?.((changed: string) => {
      if (changed === tableId) void load()
    })
    return () => {
      alive = false
      if (typeof off === 'function') off()
    }
  }, [tableId])

  const computed = useMemo(
    () => (binding ? computeMetric(rows, binding) : null),
    [rows, binding]
  )

  const setBinding = (next: MetricBinding | null, title?: string): void => {
    void update(widget.id, {
      content: JSON.stringify({
        ...model,
        binding: next,
        title: title ?? model.title
      })
    })
  }

  const idx = Math.min(Math.max(model.activeIndex ?? 0, 0), Math.max(0, model.series.length - 1))
  const active = model.series[idx]

  const setTab = (i: number): void => {
    void update(widget.id, { content: JSON.stringify({ ...model, activeIndex: i }) })
  }

  if (editing) {
    return (
      <WidgetFrame
        widget={widget}
        headerLabel={model.title || 'stat'}
        headerAccent="bg-sky-200/50 dark:bg-sky-400/10"
      >
        <MetricBindingEditor
          binding={binding}
          onChange={setBinding}
          onClose={() => setEditing(false)}
        />
      </WidgetFrame>
    )
  }

  // A bound card computes from the table and says so.
  if (binding && computed) {
    const d = delta(computed.series.map((p) => p.value))
    const tone =
      d?.direction === 'up'
        ? 'text-emerald-600'
        : d?.direction === 'down'
          ? 'text-rose-600'
          : 'text-[var(--ink-50)]'
    const stroke =
      d?.direction === 'up'
        ? 'rgb(5 150 105)'
        : d?.direction === 'down'
          ? 'rgb(225 29 72)'
          : 'rgb(120 120 130)'
    return (
      <WidgetFrame
        widget={widget}
        headerLabel={model.title || 'stat'}
        headerAccent="bg-sky-200/50 dark:bg-sky-400/10"
      >
        <div className="flex h-full w-full flex-col bg-[var(--surface-raised)]">
          <div className="px-3 pt-2">
            <div className="flex items-center gap-1">
              <span className="fb-t-caption truncate text-[var(--ink-50)]">
                {model.title || 'Measured'}
              </span>
              <button
                type="button"
                onClick={() => setEditing(true)}
                title="Change the data source"
                className="widget-nodrag ml-auto rounded p-0.5 text-[var(--ink-35)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
              >
                <Icon name="tune" size={12} />
              </button>
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="text-[26px] font-semibold leading-none tracking-tight text-[var(--ink-100)]">
                {formatMetricValue(computed.value, binding)}
              </span>
              {d && computed.series.length > 1 && (
                <span className={`inline-flex items-center gap-0.5 text-[12px] font-medium ${tone}`}>
                  <Icon
                    name={
                      d.direction === 'down'
                        ? 'arrow_downward'
                        : d.direction === 'up'
                          ? 'arrow_upward'
                          : 'remove'
                    }
                    size={12}
                  />
                  {d.pct === 0 && d.direction !== 'flat' ? '—' : `${Math.abs(d.pct).toFixed(1)}%`}
                </span>
              )}
            </div>
            {/* Where the number came from, on the face of the card. A measured
                number whose source is invisible cannot be checked or trusted. */}
            <div className="mt-0.5 truncate text-[9px] text-[var(--ink-40)]">
              {rowError
                ? `Could not read the table: ${rowError}`
                : computed.total === 0
                  ? 'The table is empty'
                  : `${computed.matched} of ${computed.total} rows`}
            </div>
          </div>
          <div className="min-h-0 flex-1 px-1.5 pb-1.5 pt-1.5">
            {computed.series.length > 1 ? (
              <svg width="100%" height="100%" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden>
                <path
                  d={sparklinePath(computed.series.map((p) => p.value), 300, 100, 6)}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : null}
          </div>
        </div>
      </WidgetFrame>
    )
  }

  if (!active) {
    return (
      <WidgetFrame widget={widget} headerLabel="stat" headerAccent="bg-sky-200/50 dark:bg-sky-400/10">
        <div className="h-full w-full flex flex-col items-center justify-center gap-1.5 p-4 text-center">
          <Icon name="monitoring" size={20} className="text-[var(--ink-40)]" />
          <div className="fb-t-caption text-[var(--ink-60)]">No figures yet</div>
          <div className="text-[10px] text-[var(--ink-40)] leading-snug max-w-[200px]">
            This card shows one number, how it is moving, and the readings behind it.
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="widget-nodrag mt-1 rounded-md border border-[var(--line)] px-2 py-1 text-[10px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          >
            Connect it to a table
          </button>
        </div>
      </WidgetFrame>
    )
  }

  const d = delta(active.points)
  const shown = active.display ?? (active.value !== undefined ? compact(active.value) : '—')
  const tone =
    d?.direction === 'up' ? 'text-emerald-600' : d?.direction === 'down' ? 'text-rose-600' : 'text-[var(--ink-50)]'
  const stroke =
    d?.direction === 'up' ? 'rgb(5 150 105)' : d?.direction === 'down' ? 'rgb(225 29 72)' : 'rgb(120 120 130)'

  return (
    <WidgetFrame widget={widget} headerLabel={model.title || 'stat'} headerAccent="bg-sky-200/50 dark:bg-sky-400/10">
      <div className="h-full w-full flex flex-col bg-[var(--surface-raised)]">
        {model.series.length > 1 && (
          <div className="flex items-center gap-1 px-2.5 pt-2 pb-1 flex-wrap">
            {model.series.map((s, i) => (
              <button
                key={s.label + i}
                onClick={() => setTab(i)}
                className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${
                  i === idx
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        <div className="px-3 pt-1.5">
          <div className="flex items-center gap-1">
            <span className="fb-t-caption truncate text-[var(--ink-50)]">
              {active.caption ?? active.label}
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Connect this card to a table"
              className="widget-nodrag ml-auto rounded p-0.5 text-[var(--ink-35)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
            >
              <Icon name="tune" size={12} />
            </button>
          </div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-[26px] leading-none font-semibold text-[var(--ink-100)] tracking-tight">
              {shown}
              {active.unit && <span className="text-[15px] font-medium text-[var(--ink-60)] ml-0.5">{active.unit}</span>}
            </span>
            {d && (
              <span className={`inline-flex items-center gap-0.5 text-[12px] font-medium ${tone}`}>
                <Icon name={d.direction === 'down' ? 'arrow_downward' : d.direction === 'up' ? 'arrow_upward' : 'remove'} size={12} />
                {/* A base of zero has no honest percentage, so the direction is
                    shown without a number rather than as an infinity. */}
                {d.pct === 0 && d.direction !== 'flat' ? '—' : `${Math.abs(d.pct).toFixed(1)}%`}
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 px-1.5 pb-1.5 pt-2">
          <svg width="100%" height="100%" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden>
            <path d={sparklinePath(active.points, 300, 100, 6)} fill="none" stroke={stroke} strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      </div>
    </WidgetFrame>
  )
}
