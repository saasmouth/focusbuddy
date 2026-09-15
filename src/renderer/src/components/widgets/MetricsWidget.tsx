import { useEffect, useMemo, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import MetricBindingEditor from './MetricBindingEditor'
import { useWidgetStore } from '../../stores/widgets'
import { compact, delta } from '../../lib/sparkline'
import type { FbRow } from '@shared/fields'
import { computeMetric, formatMetricValue, type MetricBinding } from '@shared/metricBinding'

/**
 * Live rows for every table any cell is bound to.
 *
 * Fetched once per distinct table rather than once per cell -- four cells off
 * the same table is the normal case, and four identical reads of it is not.
 */
function useBoundRows(cells: MetricCell[]): Record<string, FbRow[]> {
  const [rowsByTable, setRowsByTable] = useState<Record<string, FbRow[]>>({})
  const tableIds = useMemo(
    () =>
      [...new Set(cells.map((c) => c.binding?.source.tableId).filter((x): x is string => Boolean(x)))].sort(),
    [cells]
  )
  const key = tableIds.join(',')

  useEffect(() => {
    if (tableIds.length === 0) {
      setRowsByTable({})
      return
    }
    const api = (window as { api?: Record<string, any> }).api
    let alive = true
    const load = async (): Promise<void> => {
      const out: Record<string, FbRow[]> = {}
      for (const id of tableIds) {
        try {
          out[id] = (await api?.tables?.listRows?.(id)) ?? []
        } catch {
          // A table that cannot be read contributes no rows, so its cells show
          // a dash rather than a number left over from last time.
          out[id] = []
        }
      }
      if (alive) setRowsByTable(out)
    }
    void load()
    const off = api?.tables?.onRowsChanged?.((changed: string) => {
      if (tableIds.includes(changed)) void load()
    })
    return () => {
      alive = false
      if (typeof off === 'function') off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return rowsByTable
}

// Several numbers that are read together.
//
// A stat-card answers "how is this one figure moving". This answers "how is the
// campaign going", which is four figures nobody reads one at a time -- and four
// separate cards is how a desk ends up with a corner of competing rectangles.
//
// Every cell carries its own history, so the change shown beside it is derived
// from the readings rather than typed in beside them. A delta somebody typed is
// a claim; a delta computed from the series is a fact about the series.

export interface MetricCell {
  label: string
  value: number
  /**
   * Where this cell's number comes from, when it is measured rather than typed.
   * A bound cell recomputes from the table; an unbound one keeps `value`.
   */
  binding?: MetricBinding | null
  /** Shown instead of the computed value when the figure is not a plain count. */
  display?: string
  /** Readings behind the number, oldest first. The change is derived from these. */
  points?: number[]
}

interface MetricsContent {
  /** The cell currently being pointed at a data source, by index. */
  editingCell?: number | null
  title?: string
  cells: MetricCell[]
  /** Optional bars under the cells: a period-by-period read of the headline. */
  bars?: number[]
  barsLabel?: string
  /** Where the numbers came from, said out loud rather than implied. */
  source?: string
}

function parse(raw: string | null | undefined): MetricsContent {
  if (!raw) return { cells: [] }
  try {
    const p = JSON.parse(raw) as MetricsContent
    return Array.isArray(p?.cells) ? p : { cells: [] }
  } catch {
    return { cells: [] }
  }
}

export default function MetricsWidget({ widget }: { widget: Widget }): JSX.Element {
  const model = useMemo(() => parse(widget.content), [widget.content])
  const update = useWidgetStore((s) => s.update)
  const rowsByTable = useBoundRows(model.cells)

  const editingCell = model.editingCell ?? null
  const setEditingCell = (i: number | null): void => {
    void update(widget.id, { content: JSON.stringify({ ...model, editingCell: i }) })
  }
  const setCellBinding = (i: number, binding: MetricBinding | null, title?: string): void => {
    const cells = model.cells.map((c, k) =>
      k === i ? { ...c, binding, label: title ?? c.label } : c
    )
    void update(widget.id, { content: JSON.stringify({ ...model, cells }) })
  }

  /**
   * Add a cell and open its editor.
   *
   * Without this a fresh widget was a dead end: the configure control is
   * per-cell, so with no cells there was nothing to click and no way to point
   * the widget at anything.
   */
  const addCell = (): void => {
    const cells = [...model.cells, { label: 'New figure', value: 0 }]
    void update(widget.id, {
      content: JSON.stringify({ ...model, cells, editingCell: cells.length - 1 })
    })
  }

  /** A cell's number: computed when bound, otherwise the one that was typed. */
  const readCell = (c: MetricCell): { text: string; points: number[]; note?: string } => {
    if (!c.binding) {
      return { text: c.display ?? compact(c.value), points: c.points ?? [] }
    }
    const res = computeMetric(rowsByTable[c.binding.source.tableId] ?? [], c.binding)
    return {
      text: formatMetricValue(res.value, c.binding),
      points: res.series.map((p) => p.value),
      note: res.total === 0 ? 'no rows' : `${res.matched}/${res.total}`
    }
  }

  if (editingCell !== null && model.cells[editingCell]) {
    return (
      <WidgetFrame
        widget={widget}
        headerLabel={model.title || 'Metrics'}
        headerAccent="bg-indigo-200/50 dark:bg-indigo-400/10"
      >
        <MetricBindingEditor
          binding={model.cells[editingCell].binding ?? null}
          onChange={(b, title) => setCellBinding(editingCell, b, title)}
          onClose={() => setEditingCell(null)}
        />
      </WidgetFrame>
    )
  }

  if (model.cells.length === 0) {
    return (
      <WidgetFrame widget={widget} headerLabel="Metrics" headerAccent="bg-indigo-200/50 dark:bg-indigo-400/10">
        <div className="h-full w-full flex flex-col items-center justify-center gap-1.5 p-4 text-center">
          <Icon name="insights" size={20} className="text-[var(--ink-40)]" />
          <div className="fb-t-caption text-[var(--ink-60)]">No figures yet</div>
          <div className="text-[10px] text-[var(--ink-40)] leading-snug max-w-[220px]">
            A few numbers that are read together, each with the readings behind it.
          </div>
          <button
            type="button"
            onClick={addCell}
            data-testid="metrics-add-cell"
            className="widget-nodrag mt-1 rounded-md border border-[var(--line)] px-2 py-1 text-[10px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          >
            Add a number
          </button>
        </div>
      </WidgetFrame>
    )
  }

  const maxBar = Math.max(1, ...(model.bars ?? [1]))

  return (
    <WidgetFrame widget={widget} headerLabel={model.title || 'Metrics'} headerAccent="bg-indigo-200/50 dark:bg-indigo-400/10">
      <div className="h-full w-full flex flex-col bg-[var(--surface-raised)] overflow-auto">
        <div className="grid grid-cols-2 gap-px bg-[color:var(--edge-soft)]">
          {model.cells.map((c, i) => {
            const read = readCell(c)
            const d = read.points.length > 1 ? delta(read.points) : null
            const tone =
              d?.direction === 'up' ? 'text-emerald-600'
                : d?.direction === 'down' ? 'text-rose-600'
                  : 'text-[var(--ink-50)]'
            return (
              <div key={c.label + i} className="group/cell bg-[var(--surface-raised)] px-2.5 py-2">
                <div className="flex items-center gap-1">
                  <span className="fb-t-caption truncate text-[var(--ink-50)]">{c.label}</span>
                  <button
                    type="button"
                    onClick={() => setEditingCell(i)}
                    title={c.binding ? 'Change this cell’s data source' : 'Connect this cell to a table'}
                    className="widget-nodrag ml-auto rounded p-0.5 text-[var(--ink-30)] opacity-0 transition-opacity hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)] group-hover/cell:opacity-100"
                  >
                    <Icon name="tune" size={11} />
                  </button>
                </div>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-[19px] leading-none font-semibold text-[var(--ink-100)] tracking-tight">
                    {read.text}
                  </span>
                  {d && (
                    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${tone}`}>
                      <Icon
                        name={d.direction === 'down' ? 'arrow_downward' : d.direction === 'up' ? 'arrow_upward' : 'remove'}
                        size={11}
                      />
                      {d.pct === 0 && d.direction !== 'flat' ? '—' : `${Math.abs(d.pct).toFixed(0)}%`}
                    </span>
                  )}
                </div>
                {read.note && (
                  <div className="mt-0.5 text-[9px] text-[var(--ink-35)]">{read.note} rows</div>
                )}
              </div>
            )
          })}
        </div>

        <button
          type="button"
          onClick={addCell}
          data-testid="metrics-add-cell"
          className="widget-nodrag self-start px-2.5 py-1 text-[10px] text-[var(--ink-45)] hover:text-[var(--ink-80)]"
        >
          + Add a number
        </button>

        {model.bars && model.bars.length > 0 && (
          <div className="px-2.5 pt-2.5 pb-2">
            {model.barsLabel && (
              <div className="fb-t-caption text-[var(--ink-50)] mb-1.5">{model.barsLabel}</div>
            )}
            <div className="flex items-end gap-[3px] h-[46px]">
              {model.bars.map((b, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t-[2px] bg-accent/70 min-h-[2px]"
                  style={{ height: `${Math.max(4, (b / maxBar) * 100)}%` }}
                  title={String(b)}
                />
              ))}
            </div>
          </div>
        )}

        {model.source && (
          <div className="mt-auto px-2.5 pb-2 text-[10px] text-[var(--ink-40)] truncate" title={model.source}>
            {model.source}
          </div>
        )}
      </div>
    </WidgetFrame>
  )
}
