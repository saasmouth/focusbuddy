import { useMemo } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
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
  const idx = Math.min(Math.max(model.activeIndex ?? 0, 0), Math.max(0, model.series.length - 1))
  const active = model.series[idx]

  const setTab = (i: number): void => {
    void update(widget.id, { content: JSON.stringify({ ...model, activeIndex: i }) })
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
          <div className="fb-t-caption text-[var(--ink-50)]">{active.caption ?? active.label}</div>
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
