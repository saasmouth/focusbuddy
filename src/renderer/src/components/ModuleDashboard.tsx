import { useState } from 'react'
import Icon from './Icon'
import PlexiiIcon from './PlexiiIcon'
import type { EntityRef } from '../lib/plexiiIconMap'

/** Module dashboards that are an entity with a Plexii icon of its own. */
const MODULE_ENTITY: Record<string, EntityRef> = {
  forms: { kind: 'tool', id: 'forms' },
  flows: { kind: 'tool', id: 'flows' },
  meet: { kind: 'app', id: 'meet' }
}
import { DashboardHeader, StatTile, RailCard, StatusPill, PLEXI_CARD, Sparkline, type Tone } from './plexi'

// A recent-item card on the dashboard's recent grid.
export interface ModuleItem {
  id: string
  title: string
  subtitle?: string
  meta?: string
  status?: { tone: 'accent' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet' | 'stone'; label: string }
  onOpen: () => void
}

// The one global, info-rich module dashboard. Every module landing (Reports,
// Flows, Forms, Build, Meet, ...) fills in the same declarative config, so the
// suite reads as one product instead of a set of bespoke home screens. Built
// entirely on the shared plexi primitives and tokens. No-fakery is structural:
// every number, delta and chart point is passed in from real computation, a
// missing baseline simply omits the delta, and a section with no data renders an
// honest "nothing yet" state with a module-specific hint rather than an empty
// chart that could read as real.

export interface DashboardStat {
  icon: string
  label: string
  value: string | number
  tone?: Tone
  delta?: { dir: 'up' | 'down' | 'flat'; text: string }
  hint?: string
  sparkline?: number[]
}

export interface DashboardTimeline {
  title: string
  points: number[] // real per-bucket counts, oldest first
  bucketLabel: string // e.g. "last 8 weeks", "last 14 days"
  unit: string // e.g. "reports", "responses"
  tone?: Tone
  emptyHint: string
}

export interface DashboardBreakdownItem {
  label: string
  value: number
  tone?: Tone
}

export interface DashboardBreakdown {
  title: string
  icon?: string
  items: DashboardBreakdownItem[]
  emptyHint: string
}

export interface DashboardActivityItem {
  id: string
  icon?: string
  text: string
  meta?: string
  tone?: Tone
}

export interface ModuleDashboardProps {
  moduleKey: string
  title: string
  greeting?: string
  subtitle?: string
  icon: string
  accentClass: string
  actions?: React.ReactNode
  stats: DashboardStat[]
  timeline?: DashboardTimeline
  breakdown?: DashboardBreakdown
  activity?: { items: DashboardActivityItem[]; onViewAll?: () => void }
  recentItems?: { label?: string; items: ModuleItem[]; emptyHint: string; onCreate?: () => void; createLabel?: string }
  /** Rendered inside a page that already carries its own hero header and
   *  padding (PlexiMeet's paper page): no outer padding, no title block, no
   *  Customize door — the tiles start level with whatever sits beside them. */
  embedded?: boolean
}

type SectionId = 'stats' | 'chart' | 'breakdown' | 'activity' | 'recent'

function loadHidden(key: string): Set<SectionId> {
  try {
    const raw = localStorage.getItem(`plexi.moduledash.${key}`)
    return new Set(raw ? (JSON.parse(raw) as SectionId[]) : [])
  } catch {
    return new Set()
  }
}
function saveHidden(key: string, hidden: Set<SectionId>): void {
  localStorage.setItem(`plexi.moduledash.${key}`, JSON.stringify([...hidden]))
}

// A labelled vertical bar chart for a real time-series, rendered with flex so it
// fills the panel. Bars at zero show a faint stub, an honest gap, not a blank.
function BarChartPanel({ timeline }: { timeline: DashboardTimeline }): JSX.Element {
  const { points, tone = 'accent', unit, bucketLabel, emptyHint } = timeline
  const total = points.reduce((a, c) => a + c, 0)
  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2">
        <Icon name="bar_chart" size={24} className="text-[var(--ink-30)]" />
        <p className="text-[12px] text-[var(--ink-50)]">No activity yet</p>
        <p className="text-[11px] text-[var(--ink-30)] text-center max-w-[200px]">{emptyHint}</p>
      </div>
    )
  }
  const max = Math.max(...points, 1)
  const barTone =
    tone === 'accent'
      ? 'bg-[rgb(var(--accent))]'
      : tone === 'emerald'
        ? 'bg-emerald-500'
        : tone === 'amber'
          ? 'bg-amber-500'
          : tone === 'rose'
            ? 'bg-rose-500'
            : tone === 'violet'
              ? 'bg-violet-500'
              : tone === 'sky'
                ? 'bg-sky-500'
                : 'bg-stone-400'
  return (
    <div>
      <div className="flex items-end gap-1 h-28">
        {points.map((v, i) => (
          <div key={i} className="flex-1 flex flex-col justify-end items-center" title={`${v} ${unit}`}>
            <div
              className={`w-full rounded-t ${v === 0 ? 'bg-[var(--edge-soft)] opacity-50' : barTone}`}
              style={{ height: `${Math.max(3, (v / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--ink-50)]">
        <span>{total} {unit} · {bucketLabel}</span>
        <span className="fb-tabular">peak {max}</span>
      </div>
    </div>
  )
}

function BreakdownBody({ breakdown }: { breakdown: DashboardBreakdown }): JSX.Element {
  if (breakdown.items.length === 0) {
    return <p className="text-[12px] text-[var(--ink-50)]">{breakdown.emptyHint}</p>
  }
  const max = Math.max(...breakdown.items.map((i) => i.value), 1)
  return (
    <div className="space-y-2">
      {breakdown.items.map((it) => (
        <div key={it.label} className="flex items-center gap-2">
          <StatusPill tone={it.tone ?? 'accent'} label={it.label} />
          <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
            <div
              className={`h-full rounded-full ${
                it.tone === 'emerald' ? 'bg-emerald-500' : it.tone === 'amber' ? 'bg-amber-500' : it.tone === 'rose' ? 'bg-rose-500' : it.tone === 'violet' ? 'bg-violet-500' : it.tone === 'sky' ? 'bg-sky-500' : it.tone === 'stone' ? 'bg-stone-400' : 'bg-[rgb(var(--accent))]'
              }`}
              style={{ width: `${(it.value / max) * 100}%` }}
            />
          </div>
          <span className="text-[12px] fb-tabular text-[var(--ink-80)] w-7 text-right">{it.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function ModuleDashboard(props: ModuleDashboardProps): JSX.Element {
  const { moduleKey, title, greeting, subtitle, icon, accentClass, actions, stats, timeline, breakdown, activity, recentItems, embedded } = props
  const [hidden, setHidden] = useState<Set<SectionId>>(() => loadHidden(moduleKey))
  const [customizing, setCustomizing] = useState(false)

  function toggle(id: SectionId): void {
    setHidden((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      saveHidden(moduleKey, next)
      return next
    })
  }

  const sectionOpts: { id: SectionId; label: string; available: boolean }[] = [
    { id: 'stats', label: 'Overview tiles', available: stats.length > 0 },
    { id: 'chart', label: timeline?.title ?? 'Trend', available: !!timeline },
    { id: 'breakdown', label: breakdown?.title ?? 'Breakdown', available: !!breakdown },
    { id: 'activity', label: 'Recent activity', available: !!activity?.items.length },
    { id: 'recent', label: recentItems?.label ?? 'Recent', available: !!recentItems }
  ]

  const show = (id: SectionId): boolean => !hidden.has(id)

  return (
    <div className={embedded ? 'min-w-0' : 'flex-1 min-w-0 overflow-auto'} data-testid={`module-dashboard-${moduleKey}`}>
      <div className={embedded ? 'w-full' : 'w-full px-8 py-6'}>
        {/* Embedded (PlexiMeet's paper page): the host page carries the hero and
            there is no Customize — the tiles start level with the rail. */}
        {!embedded && (
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            {MODULE_ENTITY[moduleKey] ? (
              <PlexiiIcon
                kind={MODULE_ENTITY[moduleKey].kind}
                id={MODULE_ENTITY[moduleKey].id}
                size={28}
                fallback={icon}
                fallbackFilled
                className="shrink-0"
                fallbackClassName={`mt-0.5 ${accentClass}`}
              />
            ) : (
              <Icon name={icon} size={22} className={`mt-0.5 shrink-0 ${accentClass}`} filled />
            )}
            <DashboardHeader title={title} greeting={greeting} subtitle={subtitle} />
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setCustomizing((v) => !v)}
                data-testid={`module-dashboard-customize-${moduleKey}`}
                className="fb-btn-surface inline-flex items-center gap-1.5 h-9 px-3 text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
              >
                <Icon name="tune" size={15} /> Customize
              </button>
              {customizing && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setCustomizing(false)} />
                  <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 mt-1.5 z-20 w-56 p-2">
                    <p className="px-2 py-1 text-[11px] text-[var(--ink-50)]">Sections on this dashboard</p>
                    {sectionOpts.filter((s) => s.available).map((s) => (
                      <label key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-sunken)] cursor-pointer">
                        <input type="checkbox" checked={!hidden.has(s.id)} onChange={() => toggle(s.id)} className="accent-[rgb(var(--accent))]" />
                        <span className="text-[12.5px] text-[var(--ink-90)]">{s.label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
            {actions}
          </div>
        </div>
        )}

        {show('stats') && stats.length > 0 && (
          <div className={`${embedded ? '' : 'mt-5 '}grid grid-cols-2 sm:grid-cols-4 gap-3`}>
            {stats.map((s) => (
              <div key={s.label} className="relative">
                <StatTile icon={s.icon} label={s.label} value={s.value} tone={s.tone} delta={s.delta} hint={s.hint} />
                {s.sparkline && s.sparkline.length >= 2 && (
                  <div className="absolute bottom-3 right-3 opacity-80 pointer-events-none">
                    <Sparkline points={s.sparkline} tone={s.tone ?? 'accent'} width={56} height={20} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
          {/* Main column */}
          <div className="space-y-4 min-w-0">
            {show('chart') && timeline && (
              <RailCard title={timeline.title} icon="show_chart" tone={timeline.tone ?? 'accent'}>
                <BarChartPanel timeline={timeline} />
              </RailCard>
            )}
            {show('recent') && recentItems && (
              <RailCard
                title={recentItems.label ?? 'Recent'}
                icon="history"
                action={recentItems.onCreate ? { label: recentItems.createLabel ?? 'New', onClick: recentItems.onCreate } : undefined}
              >
                {recentItems.items.length === 0 ? (
                  <div className="py-8 text-center">
                    <p className="text-[12.5px] text-[var(--ink-50)] max-w-sm mx-auto leading-relaxed">{recentItems.emptyHint}</p>
                    {recentItems.onCreate && (
                      <button
                        onClick={recentItems.onCreate}
                        data-testid={`module-dashboard-create-${moduleKey}`}
                        className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[rgb(var(--accent))] text-white text-[12px] font-medium hover:bg-[rgb(var(--accent-hover))]"
                      >
                        <Icon name="add" size={15} /> {recentItems.createLabel ?? 'New'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {recentItems.items.map((it) => (
                      <button
                        key={it.id}
                        onClick={it.onOpen}
                        data-testid={`module-dashboard-item-${it.id}`}
                        className={`${PLEXI_CARD} p-3 text-left hover:border-[rgb(var(--accent)/0.40)] transition-colors`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-[13px] font-semibold text-[var(--ink-100)] truncate">{it.title || 'Untitled'}</h4>
                          {it.status && <StatusPill tone={it.status.tone} label={it.status.label} dot={false} />}
                        </div>
                        {it.subtitle && <p className="mt-0.5 text-[11.5px] text-[var(--ink-70)] truncate">{it.subtitle}</p>}
                        {it.meta && <p className="mt-1 text-[10.5px] text-[var(--ink-50)] fb-tabular">{it.meta}</p>}
                      </button>
                    ))}
                  </div>
                )}
              </RailCard>
            )}
          </div>

          {/* Right rail */}
          <div className="space-y-4">
            {show('breakdown') && breakdown && (
              <RailCard title={breakdown.title} icon={breakdown.icon ?? 'donut_small'}>
                <BreakdownBody breakdown={breakdown} />
              </RailCard>
            )}
            {show('activity') && activity && activity.items.length > 0 && (
              <RailCard title="Recent activity" icon="bolt" action={activity.onViewAll ? { label: 'View all', onClick: activity.onViewAll } : undefined}>
                <div className="space-y-2.5">
                  {activity.items.map((a) => (
                    <div key={a.id} className="flex items-start gap-2">
                      <Icon name={a.icon ?? 'circle'} size={14} className={`mt-0.5 shrink-0 ${a.tone === 'emerald' ? 'text-emerald-500' : a.tone === 'rose' ? 'text-rose-500' : a.tone === 'amber' ? 'text-amber-500' : 'text-[var(--ink-50)]'}`} />
                      <div className="min-w-0">
                        <p className="text-[12px] text-[var(--ink-90)] leading-snug">{a.text}</p>
                        {a.meta && <p className="text-[10.5px] text-[var(--ink-50)] fb-tabular">{a.meta}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </RailCard>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
