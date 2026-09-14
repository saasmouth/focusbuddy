import { useMemo } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useWidgetStore } from '../../stores/widgets'
import { compact, delta } from '../../lib/sparkline'

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
  /** Shown instead of the computed value when the figure is not a plain count. */
  display?: string
  /** Readings behind the number, oldest first. The change is derived from these. */
  points?: number[]
}

interface MetricsContent {
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
  useWidgetStore((s) => s.update) // subscribe: content edits repaint the panel

  if (model.cells.length === 0) {
    return (
      <WidgetFrame widget={widget} headerLabel="Metrics" headerAccent="bg-indigo-200/50 dark:bg-indigo-400/10">
        <div className="h-full w-full flex flex-col items-center justify-center gap-1.5 p-4 text-center">
          <Icon name="insights" size={20} className="text-[var(--ink-40)]" />
          <div className="fb-t-caption text-[var(--ink-60)]">No figures yet</div>
          <div className="text-[10px] text-[var(--ink-40)] leading-snug max-w-[220px]">
            A few numbers that are read together, each with the readings behind it.
          </div>
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
            const d = c.points && c.points.length > 1 ? delta(c.points) : null
            const tone =
              d?.direction === 'up' ? 'text-emerald-600'
                : d?.direction === 'down' ? 'text-rose-600'
                  : 'text-[var(--ink-50)]'
            return (
              <div key={c.label + i} className="bg-[var(--surface-raised)] px-2.5 py-2">
                <div className="fb-t-caption text-[var(--ink-50)] truncate">{c.label}</div>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-[19px] leading-none font-semibold text-[var(--ink-100)] tracking-tight">
                    {c.display ?? compact(c.value)}
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
              </div>
            )
          })}
        </div>

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
