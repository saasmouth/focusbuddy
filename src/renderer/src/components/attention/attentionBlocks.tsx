import { useEffect, useMemo, useState } from 'react'
import type { FbNode, TimeBlock } from '@shared/types'
import { useWorkItemStore } from '../../stores/workItems'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { useAssistantChrome } from '../../stores/assistantChrome'
import { useTimeBlockStore } from '../../stores/timeBlocks'
import WeekTimeGrid from '../views/WeekTimeGrid'
import { quietWinLines } from '../../lib/completionDetect'
import Icon from '../Icon'
import { queueTint, toneTriplet } from '../../lib/attentionQueues'
import {
  pulseCounts,
  overdueRadar,
  activityFeed,
  statusBreakdown,
  trendLines,
  startRecommendations,
  kpiMetrics,
  dayTimeline,
  type KpiKey
} from '../../lib/attentionAnalytics'
import { startPromptForItem } from '../../lib/startPrompt'
import { WidgetItemRow } from './WidgetItemRow'
import { CalendarBlockRow } from './CalendarBlockRow'

// DEC-048/049 — the command-center blocks. ONE component per widget with a
// `variant` prop (compact | full | band) — never a fork per surface.
// Same data, same styles, branching only where the display genuinely
// differs, so a fix propagates to every surface (the Attention page, the
// home dashboard, the desk widget) and the variants cannot drift.
//
// Every block reads the ATTENTION layer (useWorkItemStore) — these replace
// the home widgets that were wired to the legacy desk-task data.

// DEC-049 — a third variant, 'band': the wide, across-the-top shape the
// command center's header region uses (KPI tiles, the AI strip). Same
// component, same data, one more display branch — never a separate widget.
export type BlockVariant = 'compact' | 'full' | 'band'

export function useAttentionData(): FbNode[] {
  const items = useWorkItemStore((s) => s.items)
  const loaded = useWorkItemStore((s) => s.loaded)
  const refresh = useWorkItemStore((s) => s.refresh)
  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])
  return items
}

function BlockShell({
  title,
  icon,
  tone,
  count,
  variant,
  trailing,
  children
}: {
  title: string
  icon: string
  /** A PlexiSuite-family hex (attentionQueues.QUEUE_COLOR values) — subtle. */
  tone: string
  count?: number
  variant: BlockVariant
  /** Header-right control (a disclosure, a filter reset…). */
  trailing?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <section
      className={`fb-glass-card rounded-[var(--radius-card)] ${
        variant === 'compact' ? 'p-3' : 'p-4'
      } flex flex-col min-h-0`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-md shrink-0"
          style={{ backgroundColor: queueTint(tone, 0.12), color: tone }}
        >
          <Icon name={icon} size={14} />
        </span>
        <span className="fb-t-label text-[var(--ink-70)] flex-1 min-w-0 truncate">{title}</span>
        {count !== undefined && (
          <span className="fb-t-label text-[var(--ink-40)] fb-tabular">{count}</span>
        )}
        {trailing}
      </div>
      {/* DEC-132 — a tile-sized block scrolls its body instead of clipping it. */}
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </section>
  )
}

// DEC-129 — MiniRow (a plain line that jumped to the Attention page) is
// retired: every work-item row in a block is the DEC-128 WidgetItemRow, and
// every calendar block is a CalendarBlockRow — the same three depths in place
// (title at rest · a click opens the summary and actions · a double-click
// opens the full item) as the Attention widget, so the home tiles cannot
// behave differently from the widget beside them.

const useGoAttention = (): (() => void) => useViewStore((s) => s.goAttention)

// ── Pulse ───────────────────────────────────────────────────────────────────

export function AttentionPulseBlock({ variant }: { variant: BlockVariant }): JSX.Element {
  const items = useAttentionData()
  const goAttention = useGoAttention()
  const nowMs = Date.now()
  const p = useMemo(() => pulseCounts(items, nowMs), [items, nowMs])
  const stats = [
    { label: 'Open', value: p.open, tone: '#0ea5e9' },
    { label: 'Due today', value: p.dueToday, tone: '#f59e0b' },
    { label: 'Overdue', value: p.overdue, tone: '#ef4444' },
    { label: 'Closed · 7d', value: p.closed7d, tone: '#10b981' }
  ]
  const max = Math.max(1, ...p.closedByDay)
  return (
    <BlockShell title="Pulse" icon="monitoring" tone="#8b5cf6" variant={variant}>
      <div className={`grid gap-2 ${variant === 'full' ? 'grid-cols-4' : 'grid-cols-2'}`}>
        {stats.map((s) => (
          <button
            key={s.label}
            onClick={goAttention}
            className="rounded-lg px-2.5 py-2 text-left fb-press"
            style={{ backgroundColor: queueTint(s.tone, 0.08) }}
          >
            <div className="text-[16px] font-semibold fb-tabular text-[var(--ink-100)]">{s.value}</div>
            <div className="fb-t-caption text-[var(--ink-50)]">{s.label}</div>
          </button>
        ))}
      </div>
      {variant === 'full' && (
        <div className="mt-3">
          <div className="fb-t-caption text-[var(--ink-40)] mb-1">Closed per day · 2 weeks</div>
          <div className="flex items-end gap-[3px] h-10">
            {p.closedByDay.map((n, i) => (
              <div
                key={i}
                title={`${n} closed`}
                className="flex-1 rounded-sm"
                style={{
                  height: `${Math.max(8, (n / max) * 100)}%`,
                  backgroundColor: queueTint('#10b981', n === 0 ? 0.12 : 0.55)
                }}
              />
            ))}
          </div>
        </div>
      )}
    </BlockShell>
  )
}

// ── Overdue radar ───────────────────────────────────────────────────────────

export function OverdueRadarBlock({ variant }: { variant: BlockVariant }): JSX.Element {
  const items = useAttentionData()
  const nowMs = Date.now()
  const { overdue, dueSoon } = useMemo(() => overdueRadar(items, nowMs), [items, nowMs])
  const shown = variant === 'full' ? 8 : 3
  return (
    <BlockShell title="Overdue radar" icon="priority_high" tone="#ef4444" count={overdue.length} variant={variant}>
      {overdue.length === 0 ? (
        <div className="text-[11.5px] text-[var(--ink-30)]">Nothing overdue. Empty is the goal.</div>
      ) : (
        <div className="flex flex-col gap-1">
          {overdue.slice(0, shown).map((i) => (
            <WidgetItemRow key={i.id} i={i} dense nowMs={nowMs} />
          ))}
        </div>
      )}
      {variant === 'full' && dueSoon.length > 0 && (
        <div className="mt-2 pt-2 border-t border-[var(--edge-soft)]">
          <div className="fb-t-caption text-[var(--ink-40)] mb-0.5">Next 48 hours</div>
          <div className="flex flex-col gap-1">
            {dueSoon.slice(0, 5).map((i) => (
              <WidgetItemRow key={i.id} i={i} dense nowMs={nowMs} />
            ))}
          </div>
        </div>
      )}
    </BlockShell>
  )
}

// ── Today's agenda ──────────────────────────────────────────────────────────

export function AgendaBlock({ variant }: { variant: BlockVariant }): JSX.Element {
  const items = useAttentionData()
  const goCalendar = useViewStore((s) => s.goCalendar)
  const nowMs = Date.now()
  // A change-signal only — never the range itself (see below).
  const timeBlockTick = useTimeBlockStore((s) => s.blocks.length)
  // DEC-049/051 — the day's REAL shape: the calendar's own blocks for today
  // merged with the work that is due in it.
  //
  // This block READS the calendar; it must never write the shared view range.
  // The time-block store holds ONE range for whatever surface last asked, and
  // WeekTimeGrid loads a whole week into it — a widget calling loadRange()
  // would narrow that range to today underneath an open calendar, blanking
  // the rest of its week until it remounted. So we fetch today's blocks
  // directly into local state and leave the store alone.
  const [blocks, setBlocks] = useState<TimeBlock[]>([])
  const dayKey = new Date().toDateString()
  useEffect(() => {
    let alive = true
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    const to = new Date()
    to.setHours(23, 59, 59, 999)
    void window.api.timeBlocks
      .list(from.getTime(), to.getTime())
      .then((rows) => {
        if (alive) setBlocks(rows)
      })
      .catch(() => {
        /* the day simply shows its work items */
      })
    return () => {
      alive = false
    }
    // Re-fetch when the calendar changes under us, and when the day rolls over.
  }, [dayKey, timeBlockTick])

  const timeline = useMemo(() => dayTimeline(items, blocks, nowMs), [items, blocks, nowMs])
  const shown = variant === 'compact' ? 4 : 9
  return (
    <BlockShell
      title="Today"
      icon="event"
      tone="#10b981"
      count={timeline.length || undefined}
      variant={variant}
      trailing={
        variant !== 'compact' ? (
          <button
            onClick={goCalendar}
            title="Open the calendar"
            className="fb-t-caption text-[var(--ink-40)] hover:text-[var(--ink-100)] fb-press"
          >
            Calendar
          </button>
        ) : undefined
      }
    >
      {variant !== 'compact' ? (
        /* DEC-052 — the rail is a REAL day column, not a list: the same grid
           the Calendar page renders wide, narrow. Drag an item from the queues
           onto it to book time; deadlines ride above it; blocks drag/resize
           in place. (The compact home/desk widget keeps the read-only list
           below — a canvas tile is for glancing, not planning.) */
        <div className="-mx-1" data-testid="rail-day-grid">
          <WeekTimeGrid
            weekStart={new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())}
            days={1}
            compact
          />
        </div>
      ) : timeline.length === 0 ? (
        <div className="text-[11.5px] text-[var(--ink-30)]">Nothing scheduled or due today.</div>
      ) : (
        <div className="h-full overflow-y-auto flex flex-col gap-1" data-testid="agenda-rows">
          {/* DEC-129 — each line is a row with the three depths: a calendar
              block (a meeting or focus time) is a CalendarBlockRow, dated work
              is the DEC-128 WidgetItemRow. Nothing here jumps to a page on a
              click; the pages are doors inside each row's summary. */}
          {timeline.slice(0, shown).map((e) => {
            if (e.kind === 'event') {
              const block = blocks.find((b) => b.id === e.id)
              return block ? (
                <CalendarBlockRow key={`ev:${e.id}`} block={block} nowMs={nowMs} />
              ) : null
            }
            return <WidgetItemRow key={`it:${e.id}`} i={e.item} dense nowMs={nowMs} />
          })}
          {timeline.length > shown && (
            <div className="fb-t-caption text-[var(--ink-30)] pt-1">
              +{timeline.length - shown} more today
            </div>
          )}
        </div>
      )}
    </BlockShell>
  )
}

// ── Recent activity ─────────────────────────────────────────────────────────

export function RecentActivityBlock({ variant }: { variant: BlockVariant }): JSX.Element {
  const items = useAttentionData()
  const goAttention = useGoAttention()
  const nowMs = Date.now()
  const feed = useMemo(() => activityFeed(items, nowMs, variant === 'full' ? 12 : 5), [items, nowMs, variant])
  return (
    <BlockShell title="Recent activity" icon="history" tone="#6366f1" variant={variant}>
      {feed.length === 0 ? (
        <div className="text-[11.5px] text-[var(--ink-30)]">Quiet week so far.</div>
      ) : (
        <div className="flex flex-col">
          {feed.map((e) => (
            <button
              key={`${e.kind}:${e.item.id}:${e.atMs}`}
              onClick={goAttention}
              className="w-full flex items-center gap-2 py-1 text-left fb-press min-w-0"
            >
              <Icon
                name={e.kind === 'closed' ? 'task_alt' : 'add_circle'}
                size={12}
                className={e.kind === 'closed' ? 'text-emerald-500' : 'text-[var(--ink-40)]'}
              />
              <span className="text-[12px] text-[var(--ink-80)] truncate flex-1 min-w-0">{e.item.title}</span>
              <span className="fb-t-caption text-[var(--ink-30)] shrink-0">
                {e.kind === 'closed' ? e.item.workItemState : 'new'}
              </span>
            </button>
          ))}
        </div>
      )}
    </BlockShell>
  )
}

// ── Analytics: breakdown + trends ───────────────────────────────────────────

export function AnalyticsBlock({
  variant,
  /** DEC-049 — the band's tiles double as filters. The active key is owned by
   *  the page (it filters the queues); the block just reflects and reports. */
  activeKpi,
  onPickKpi
}: {
  variant: BlockVariant
  activeKpi?: KpiKey | null
  onPickKpi?: (k: KpiKey) => void
}): JSX.Element {
  const items = useAttentionData()
  const nowMs = Date.now()
  const rows = useMemo(() => statusBreakdown(items, nowMs), [items, nowMs])
  const trends = useMemo(() => trendLines(items, nowMs), [items, nowMs])
  // DEC-052 #7 — quiet wins from the ledger: work that happened without a
  // checkbox still counts (desks closed, sittings finished). Device-local.
  const [quietWins, setQuietWins] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void window.api.signals
      .list(Date.now() - 7 * 86_400_000)
      .then((sig) => {
        if (alive) setQuietWins(quietWinLines(sig, Date.now()))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const shown = variant === 'compact' ? rows.slice(0, 3) : rows
  const kpis = useMemo(() => kpiMetrics(items, nowMs), [items, nowMs])
  const pulse = useMemo(() => pulseCounts(items, nowMs), [items, nowMs])
  const [openBreakdown, setOpenBreakdown] = useState(false)

  // ── The band: KPI tiles across the top, CRM-dashboard style ───────────────
  if (variant === 'band') {
    const max = Math.max(1, ...pulse.closedByDay)
    return (
      <BlockShell
        title="Analytics"
        icon="insights"
        tone="#0ea5e9"
        variant={variant}
        trailing={
          <button
            onClick={() => setOpenBreakdown((v) => !v)}
            className={`fb-t-caption fb-press inline-flex items-center gap-1 h-7 px-2 rounded-[var(--radius-chip)] border transition-colors ${
              openBreakdown
                ? 'border-[rgb(var(--accent))] text-[rgb(var(--accent))] bg-accent/10'
                : 'border-[var(--edge-soft)] text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:border-[var(--edge-strong)]'
            }`}
          >
            <Icon name={openBreakdown ? 'expand_less' : 'expand_more'} size={13} />
            Breakdown
          </button>
        }
      >
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          {kpis.map((m) => {
            const on = activeKpi === m.key
            return (
              <button
                key={m.key}
                onClick={() => onPickKpi?.(m.key)}
                title={
                  onPickKpi
                    ? on
                      ? 'Showing only these — press again to clear'
                      : `Show only ${m.label.toLowerCase()}`
                    : undefined
                }
                data-on={on ? 'true' : 'false'}
                className="fb-kpi-tile rounded-xl px-3 py-2.5 text-left fb-press"
                style={
                  {
                    '--kpi-tone': toneTriplet(m.tone),
                    color: m.tone
                  } as React.CSSProperties
                }
              >
                <div className="text-[23px] leading-none font-semibold fb-tabular tracking-tight text-[var(--ink-100)]">
                  {m.value}
                </div>
                <div
                  className={`fb-t-caption mt-1.5 truncate ${
                    on ? 'font-semibold' : 'font-medium'
                  }`}
                  style={{ color: on ? m.tone : 'var(--ink-60)' }}
                >
                  {m.label}
                </div>
                {m.hint && (
                  // --ink-40 is the "faint meta" token; --ink-30 is documented
                  // decorative-only (hairlines), and this is text.
                  <div className="fb-t-caption text-[var(--ink-40)] truncate">{m.hint}</div>
                )}
              </button>
            )
          })}
        </div>
        {(trends.length > 0 || pulse.closedByDay.some((n) => n > 0)) && (
          <div className="mt-3 flex items-center gap-5 flex-wrap">
            {pulse.closedByDay.some((n) => n > 0) && (
              <div
                className="flex items-center gap-2 shrink-0"
                title={`Closed per day: ${pulse.closedByDay.join(', ')}`}
              >
                <div className="flex items-end gap-[3px] h-7 w-[104px]">
                  {pulse.closedByDay.map((n, i) => (
                    <div
                      key={i}
                      className="flex-1 rounded-t-[2px] self-end transition-[height] duration-300"
                      style={{
                        height: n === 0 ? '3px' : `${Math.max(16, (n / max) * 100)}%`,
                        background:
                          n === 0
                            ? queueTint('#64748b', 0.22)
                            : `linear-gradient(180deg, ${queueTint('#10b981', 0.85)} 0%, ${queueTint('#10b981', 0.45)} 100%)`
                      }}
                    />
                  ))}
                </div>
                <span className="fb-t-caption text-[var(--ink-30)] whitespace-nowrap">
                  closed · 14d
                </span>
              </div>
            )}
            {trends.length > 0 && (
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                {trends.slice(0, 2).map((t) => (
                  <div key={t} className="flex items-start gap-1.5 text-[11.5px] text-[var(--ink-60)]">
                    <Icon name="trending_up" size={12} className="mt-0.5 shrink-0 text-[var(--ink-30)]" />
                    <span className="truncate">{t}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {openBreakdown && (
          <div className="mt-3 pt-3 border-t border-[var(--edge-soft)] grid gap-x-6 gap-y-1.5 md:grid-cols-2">
            {rows.length === 0 ? (
              <div className="text-[11.5px] text-[var(--ink-30)]">Numbers appear as tasks do.</div>
            ) : (
              rows.map((r) => {
                const activeN = r.notStarted + r.inProgress + r.waiting
                const denom = Math.max(1, activeN + r.done7d)
                const seg = (n: number): string => `${(n / denom) * 100}%`
                return (
                  <div key={r.queue} className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="fb-t-caption text-[var(--ink-60)] w-20 truncate">{r.label}</span>
                      <div className="fb-stat-track flex-1 h-2 rounded-full overflow-hidden flex bg-[var(--surface-sunken)]">
                        <div className="fb-stat-seg" style={{ width: seg(r.done7d), backgroundColor: queueTint('#10b981', 0.75) }} />
                        <div className="fb-stat-seg" style={{ width: seg(r.inProgress), backgroundColor: queueTint('#0ea5e9', 0.75) }} />
                        <div className="fb-stat-seg" style={{ width: seg(r.waiting), backgroundColor: queueTint('#f59e0b', 0.65) }} />
                        <div className="fb-stat-seg" style={{ width: seg(r.notStarted), backgroundColor: queueTint('#64748b', 0.3) }} />
                      </div>
                      <span className="fb-t-caption fb-tabular text-[var(--ink-40)] w-6 text-right">
                        {activeN}
                      </span>
                    </div>
                    <div className="fb-t-caption text-[var(--ink-30)] ml-[88px]">
                      {r.done7d} done · {r.inProgress} in progress · {r.waiting} waiting ·{' '}
                      {r.notStarted} not started
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}
      </BlockShell>
    )
  }

  return (
    <BlockShell title="Analytics" icon="insights" tone="#0ea5e9" variant={variant}>
      {shown.length === 0 ? (
        <div className="text-[11.5px] text-[var(--ink-30)]">Numbers appear as tasks do.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {shown.map((r) => {
            const activeN = r.notStarted + r.inProgress + r.waiting
            const denom = Math.max(1, activeN + r.done7d)
            const seg = (n: number): string => `${(n / denom) * 100}%`
            return (
              <div key={r.queue} className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="fb-t-caption text-[var(--ink-60)] w-20 truncate">{r.label}</span>
                  <div className="fb-stat-track flex-1 h-2 rounded-full overflow-hidden flex bg-[var(--surface-sunken)]">
                    <div className="fb-stat-seg" style={{ width: seg(r.done7d), backgroundColor: queueTint('#10b981', 0.75) }} />
                    <div className="fb-stat-seg" style={{ width: seg(r.inProgress), backgroundColor: queueTint('#0ea5e9', 0.75) }} />
                    <div className="fb-stat-seg" style={{ width: seg(r.waiting), backgroundColor: queueTint('#f59e0b', 0.65) }} />
                    <div className="fb-stat-seg" style={{ width: seg(r.notStarted), backgroundColor: queueTint('#64748b', 0.3) }} />
                  </div>
                  <span className="fb-t-caption fb-tabular text-[var(--ink-40)] w-8 text-right">
                    {activeN}
                  </span>
                </div>
                {variant === 'full' && (
                  <div className="fb-t-caption text-[var(--ink-30)] ml-[88px]">
                    {r.done7d} done · {r.inProgress} in progress · {r.waiting} waiting · {r.notStarted} not started
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {(trends.length > 0 || quietWins.length > 0) && (
        <div className={`${variant === 'full' ? 'mt-3 pt-2 border-t border-[var(--edge-soft)]' : 'mt-2'} flex flex-col gap-1`}>
          {(variant === 'full' ? trends : trends.slice(0, 1)).map((t) => (
            <div key={t} className="flex items-start gap-1.5 text-[11.5px] text-[var(--ink-60)]">
              <Icon name="trending_up" size={12} className="mt-0.5 shrink-0 text-[var(--ink-30)]" />
              {t}
            </div>
          ))}
          {(variant === 'full' ? quietWins : quietWins.slice(0, 1)).map((l) => (
            <div key={l} className="flex items-start gap-1.5 text-[11.5px] text-[var(--ink-60)]">
              <Icon name="eco" size={12} className="mt-0.5 shrink-0 text-emerald-500" />
              {l}
            </div>
          ))}
        </div>
      )}
    </BlockShell>
  )
}

// ── Start here — the recommendation strip ───────────────────────────────────

export function StartHereBlock({ variant }: { variant: BlockVariant }): JSX.Element {
  const items = useAttentionData()
  const nodes = useNodeStore((s) => s.nodes)
  const setActive = useNodeStore((s) => s.setActive)
  const goTask = useViewStore((s) => s.goTask)
  const openAssistant = useAssistantChrome((s) => s.openPanel)
  const nowMs = Date.now()
  const recs = useMemo(
    () => startRecommendations(items, nowMs, variant === 'compact' ? 2 : 3),
    [items, nowMs, variant]
  )
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const [ask, setAsk] = useState('')

  /** Every hand-off STAGES the composer and never sends (DEC-038): the
   *  assistant must not start acting because the operator glanced at a
   *  dashboard. He reads it, edits it, presses send. */
  const stagePrompt = (prompt: string, deskId?: string | null): void => {
    if (deskId && nodes.some((n) => n.id === deskId && n.kind === 'task')) {
      setActive(deskId)
      goTask(deskId)
    }
    useAssistantChrome.getState().setTab('chat')
    openAssistant()
    const stage = (): void => {
      window.dispatchEvent(new CustomEvent('fb:composer-stage', { detail: prompt }))
    }
    stage()
    setTimeout(stage, 400)
  }

  const start = (i: FbNode): void => {
    const prompt = startPromptForItem(i, nodesById)
    stagePrompt(prompt, i.parentId)
  }

  /** The band's prompt box: the question travels WITH the queue's shape, so
   *  the assistant answers about the real backlog rather than in the
   *  abstract. Still staged, never sent. */
  const askPlexii = (): void => {
    const q = ask.trim()
    if (!q) return
    const top = recs.map((r, n) => `${n + 1}. ${r.item.title} — ${r.reason}`).join('\n')
    const prompt = top
      ? `${q}\n\nMy Focus list right now, most pressing first:\n${top}`
      : q
    stagePrompt(prompt)
    setAsk('')
  }

  if (variant === 'band') {
    return (
      <BlockShell
        title="Start here"
        icon="auto_awesome"
        tone="#f59e0b"
        variant={variant}
        trailing={
          <button
            onClick={() => useViewStore.getState().goCalendar()}
            title="Open the calendar and let Plexii lay the day out — preview first, nothing books itself"
            className="fb-t-caption text-[var(--ink-40)] hover:text-[var(--ink-100)] fb-press"
          >
            Plan my day →
          </button>
        }
      >
        <div className="flex items-center gap-2">
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') askPlexii()
            }}
            placeholder="Ask Plexii about your queue — “what should I do before 3pm?”"
            className="fb-field flex-1 min-w-0 bg-[var(--surface-sunken)] px-3 py-2 text-[13px]"
          />
          <button
            onClick={askPlexii}
            disabled={!ask.trim()}
            title="Opens a chat prefilled with your question and your top tasks — nothing is sent until you press send"
            className="inline-flex items-center gap-1.5 h-9 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-100)] disabled:opacity-40 shrink-0"
          >
            <Icon name="auto_awesome" size={14} />
            Ask
          </button>
        </div>
        {recs.length === 0 ? (
          <div className="mt-2 text-[11.5px] text-[var(--ink-30)]">
            Nothing needs you. Capture with ⌘K.
          </div>
        ) : (
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {recs.map((r, idx) => (
              <button
                key={r.item.id}
                onClick={() => start(r.item)}
                title="Start it with Plexii — a chat prefilled from this capture"
                className="rounded-lg bg-[var(--surface-sunken)] px-3 py-2 text-left fb-press min-w-0 flex items-start gap-2"
              >
                <span
                  className="fb-t-caption fb-tabular shrink-0 mt-0.5 h-4 w-4 rounded inline-flex items-center justify-center"
                  style={{ backgroundColor: queueTint('#f59e0b', 0.18), color: '#f59e0b' }}
                >
                  {idx + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] text-[var(--ink-90)] truncate">
                    {r.item.title}
                  </span>
                  <span className="block fb-t-caption text-[var(--ink-40)] truncate">{r.reason}</span>
                </span>
                <Icon name="auto_awesome" size={13} className="shrink-0 mt-0.5 text-[var(--ink-30)]" />
              </button>
            ))}
          </div>
        )}
      </BlockShell>
    )
  }

  return (
    <BlockShell title="Start here" icon="auto_awesome" tone="#f59e0b" variant={variant}>
      {recs.length === 0 ? (
        <div className="text-[11.5px] text-[var(--ink-30)]">Nothing needs you. Capture with ⌘K.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {recs.map((r, idx) => (
            <div key={r.item.id} className="flex items-center gap-2 min-w-0">
              <span className="fb-t-caption fb-tabular text-[var(--ink-30)] w-3 shrink-0">{idx + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-[var(--ink-90)] truncate">{r.item.title}</div>
                <div className="fb-t-caption text-[var(--ink-40)]">{r.reason}</div>
              </div>
              <button
                onClick={() => start(r.item)}
                title="Start it with Plexii — a chat prefilled from this capture"
                className="icon-btn !h-7 !w-7 shrink-0"
              >
                <Icon name="auto_awesome" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </BlockShell>
  )
}
