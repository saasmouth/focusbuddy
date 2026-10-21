import type { FbNode } from '@shared/types'
import {
  QUEUE_ORDER,
  QUEUE_LABEL,
  isTerminalState,
  queueOf,
  rankScore,
  itemReason
} from './attentionQueues'

// DEC-048 — the command-center's numbers, computed from the attention layer
// itself (work_item_state + timestamps), never from the legacy desk-task
// data the old home widgets read. Pure functions over the item list so every
// figure is unit-tested and every surface (page, home, desk widget) shows
// the SAME math.
//
// Honesty rule for trends: we hold current rows, not an event history — so
// every claim here is derivable from createdAt/updatedAt/state alone, and
// anything that would need a real event log (e.g. "cleared your overdue 5
// days running") is NOT claimed.

const DAY = 24 * 60 * 60 * 1000

const active = (i: FbNode): boolean =>
  !isTerminalState(i.workItemState) && i.detachedFromId == null

const closedMeaningfully = (i: FbNode): boolean =>
  isTerminalState(i.workItemState) &&
  i.workItemState !== 'dismissed' &&
  i.workItemState !== 'reclassified' &&
  i.workItemState !== 'archived'

const dayKey = (ms: number): string => new Date(ms).toDateString()

// ── Pulse ───────────────────────────────────────────────────────────────────

export interface PulseCounts {
  open: number
  dueToday: number
  overdue: number
  closed7d: number
  /** Closed-per-day for the last `days` days, oldest → newest (sparkline). */
  closedByDay: number[]
}

export function pulseCounts(items: FbNode[], nowMs: number, days = 14): PulseCounts {
  const act = items.filter(active)
  const endOfToday = new Date(nowMs)
  endOfToday.setHours(23, 59, 59, 999)
  const closed = items.filter(closedMeaningfully)
  const byDay = new Array(days).fill(0) as number[]
  for (const i of closed) {
    const age = Math.floor((nowMs - i.updatedAt) / DAY)
    if (age >= 0 && age < days) byDay[days - 1 - age]++
  }
  return {
    open: act.length,
    dueToday: act.filter((i) => i.dueAt && Date.parse(i.dueAt) <= endOfToday.getTime() && Date.parse(i.dueAt) >= nowMs).length,
    overdue: act.filter((i) => i.dueAt && Date.parse(i.dueAt) < nowMs).length,
    closed7d: closed.filter((i) => nowMs - i.updatedAt < 7 * DAY).length,
    closedByDay: byDay
  }
}

// ── KPI band (DEC-049) ──────────────────────────────────────────────────────
//
// The headline numbers, CRM-dashboard style, across the top of the command
// center. Each tile's count comes from the SAME predicate the tile's click
// filters by — so the number you press and the rows you get can never
// disagree. That equality is unit-pinned.

export type KpiKey = 'open' | 'due_today' | 'overdue' | 'in_progress' | 'waiting' | 'closed_7d'

const IN_PROGRESS_STATES = ['in_progress', 'delegated', 'needs_review', 'needs_approval']
const WAITING_STATES = ['waiting', 'blocked']

export const KPI_FILTERS: Record<KpiKey, (i: FbNode, nowMs: number) => boolean> = {
  open: (i) => active(i),
  due_today: (i, now) => {
    if (!active(i) || !i.dueAt) return false
    const end = new Date(now)
    end.setHours(23, 59, 59, 999)
    const t = Date.parse(i.dueAt)
    return t >= now && t <= end.getTime()
  },
  overdue: (i, now) => active(i) && !!i.dueAt && Date.parse(i.dueAt) < now,
  in_progress: (i) => active(i) && IN_PROGRESS_STATES.includes(i.workItemState ?? ''),
  waiting: (i) => active(i) && WAITING_STATES.includes(i.workItemState ?? ''),
  closed_7d: (i, now) => closedMeaningfully(i) && now - i.updatedAt < 7 * DAY
}

export interface KpiMetric {
  key: KpiKey
  label: string
  value: number
  tone: string
  /** A short, honest sub-line — omitted when the data cannot support one. */
  hint?: string
}

export function kpiMetrics(items: FbNode[], nowMs: number): KpiMetric[] {
  const n = (k: KpiKey): number => items.filter((i) => KPI_FILTERS[k](i, nowMs)).length
  const closedPrev = items.filter(
    (i) =>
      closedMeaningfully(i) &&
      nowMs - i.updatedAt >= 7 * DAY &&
      nowMs - i.updatedAt < 14 * DAY
  ).length
  const closed = n('closed_7d')
  const arrivedWeek = items.filter((i) => nowMs - i.createdAt < 7 * DAY).length
  const out: KpiMetric[] = [
    {
      key: 'open',
      label: 'Open',
      value: n('open'),
      tone: '#0ea5e9',
      hint: arrivedWeek > 0 ? `${arrivedWeek} new this week` : undefined
    },
    { key: 'due_today', label: 'Due today', value: n('due_today'), tone: '#f59e0b' },
    { key: 'overdue', label: 'Overdue', value: n('overdue'), tone: '#ef4444' },
    { key: 'in_progress', label: 'In progress', value: n('in_progress'), tone: '#8b5cf6' },
    { key: 'waiting', label: 'Waiting', value: n('waiting'), tone: '#eab308' },
    {
      key: 'closed_7d',
      label: 'Closed · 7d',
      value: closed,
      tone: '#10b981',
      hint:
        closedPrev > 0
          ? `${closed >= closedPrev ? '+' : ''}${closed - closedPrev} vs prior week`
          : undefined
    }
  ]
  return out
}

// ── Today's calendar + dated work, merged (DEC-049) ─────────────────────────

export interface CalendarBlockLike {
  id: string
  title: string
  startMs: number
  durationMin: number
  taskId?: string | null
  meeting?: unknown
}

export type TimelineEntry =
  | { kind: 'event'; id: string; title: string; atMs: number; endMs: number; isMeeting: boolean }
  | { kind: 'item'; id: string; item: FbNode; atMs: number | null }

/**
 * Today's shape in one ordered list: real calendar blocks that start today
 * merged with dated work due today (and undated Meet items behind them).
 * Times order the list; undated work sorts last, in ranked order as given.
 */
export function dayTimeline(
  items: FbNode[],
  blocks: CalendarBlockLike[],
  nowMs: number
): TimelineEntry[] {
  const start = new Date(nowMs)
  start.setHours(0, 0, 0, 0)
  const end = new Date(nowMs)
  end.setHours(23, 59, 59, 999)
  const events: TimelineEntry[] = blocks
    .filter((b) => b.startMs >= start.getTime() && b.startMs <= end.getTime())
    .map((b) => ({
      kind: 'event' as const,
      id: b.id,
      title: b.title,
      atMs: b.startMs,
      endMs: b.startMs + b.durationMin * 60000,
      isMeeting: !!b.meeting
    }))
  // DEC-129 — work due BEFORE today is not part of today's timed shape: it
  // rides behind the day, as undated work does, in ranked order (oldest due
  // first, then the Meet items). Sorting it by its past date put a backlog
  // of overdue dates ahead of the blocks actually on today's calendar, and a
  // four-line tile never reached them. The Overdue radar is the place for
  // the backlog; here it follows the day.
  const dayStart = start.getTime()
  const work: TimelineEntry[] = agendaItems(items, nowMs).map((i) => {
    const due = i.dueAt ? Date.parse(i.dueAt) : null
    return {
      kind: 'item' as const,
      id: i.id,
      item: i,
      atMs: due != null && due >= dayStart ? due : null
    }
  })
  return [...events, ...work].sort((a, b) => {
    if (a.atMs == null && b.atMs == null) return 0
    if (a.atMs == null) return 1
    if (b.atMs == null) return -1
    return a.atMs - b.atMs
  })
}

// ── Overdue radar ───────────────────────────────────────────────────────────

export function overdueRadar(
  items: FbNode[],
  nowMs: number
): { overdue: FbNode[]; dueSoon: FbNode[] } {
  const act = items.filter(active)
  const overdue = act
    .filter((i) => i.dueAt && Date.parse(i.dueAt) < nowMs)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))
  const dueSoon = act
    .filter((i) => {
      if (!i.dueAt) return false
      const t = Date.parse(i.dueAt)
      return t >= nowMs && t < nowMs + 2 * DAY
    })
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))
  return { overdue, dueSoon }
}

// ── Today's agenda ──────────────────────────────────────────────────────────

/** Dated work due through tomorrow, plus active Meet items — the day's shape. */
export function agendaItems(items: FbNode[], nowMs: number): FbNode[] {
  const endTomorrow = new Date(nowMs)
  endTomorrow.setHours(23, 59, 59, 999)
  const horizon = endTomorrow.getTime() + DAY
  return items
    .filter(active)
    .filter((i) => (i.dueAt && Date.parse(i.dueAt) <= horizon) || queueOf(i) === 'to_meet')
    .sort((a, b) => {
      const ta = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY
      const tb = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY
      return ta - tb
    })
}

// ── Recent activity ─────────────────────────────────────────────────────────

export interface ActivityEntry {
  item: FbNode
  kind: 'closed' | 'created'
  atMs: number
}

export function activityFeed(items: FbNode[], nowMs: number, limit = 12): ActivityEntry[] {
  const out: ActivityEntry[] = []
  for (const i of items) {
    if (closedMeaningfully(i) && nowMs - i.updatedAt < 7 * DAY)
      out.push({ item: i, kind: 'closed', atMs: i.updatedAt })
    if (nowMs - i.createdAt < 7 * DAY) out.push({ item: i, kind: 'created', atMs: i.createdAt })
  }
  return out.sort((a, b) => b.atMs - a.atMs).slice(0, limit)
}

// ── Status breakdown (the analytics widget, part 1) ─────────────────────────

export interface ClassBreakdown {
  queue: string
  label: string
  notStarted: number
  inProgress: number
  waiting: number
  done7d: number
  total: number
}

export function statusBreakdown(items: FbNode[], nowMs: number): ClassBreakdown[] {
  const rows: ClassBreakdown[] = []
  for (const q of QUEUE_ORDER) {
    const mine = items.filter((i) => queueOf(i) === q && i.detachedFromId == null)
    const act = mine.filter((i) => !isTerminalState(i.workItemState))
    const b: ClassBreakdown = {
      queue: q,
      label: QUEUE_LABEL[q],
      notStarted: act.filter((i) => !['in_progress', 'waiting', 'blocked', 'delegated', 'needs_review', 'needs_approval'].includes(i.workItemState ?? '')).length,
      inProgress: act.filter((i) => ['in_progress', 'delegated', 'needs_review', 'needs_approval'].includes(i.workItemState ?? '')).length,
      waiting: act.filter((i) => ['waiting', 'blocked'].includes(i.workItemState ?? '')).length,
      done7d: mine.filter((i) => closedMeaningfully(i) && nowMs - i.updatedAt < 7 * DAY).length,
      total: mine.length
    }
    if (b.total > 0) rows.push(b)
  }
  return rows.sort((a, b) => b.notStarted + b.inProgress + b.waiting - (a.notStarted + a.inProgress + a.waiting))
}

// ── Trends & streaks (part 2) — plain language, honestly derivable ──────────

export function trendLines(items: FbNode[], nowMs: number): string[] {
  const lines: string[] = []

  // Closing streak: consecutive days (ending today or yesterday) with ≥1
  // meaningful closure.
  const closedDays = new Set(items.filter(closedMeaningfully).map((i) => dayKey(i.updatedAt)))
  let streak = 0
  for (let d = 0; d < 60; d++) {
    if (closedDays.has(dayKey(nowMs - d * DAY))) streak++
    else if (d === 0) continue // today can still be in progress
    else break
  }
  if (streak >= 2) lines.push(`You've closed something ${streak} days in a row.`)

  // Week-over-week arrivals, overall and the biggest class mover.
  const wk = (i: { createdAt: number }): 0 | 1 | -1 =>
    nowMs - i.createdAt < 7 * DAY ? 0 : nowMs - i.createdAt < 14 * DAY ? 1 : -1
  const thisWk = items.filter((i) => wk(i) === 0)
  const lastWk = items.filter((i) => wk(i) === 1)
  if (lastWk.length >= 3 && thisWk.length >= 1) {
    const delta = Math.round(((thisWk.length - lastWk.length) / lastWk.length) * 100)
    if (Math.abs(delta) >= 25)
      lines.push(`New tasks are ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)}% this week.`)
    let best: { label: string; delta: number } | null = null
    for (const q of QUEUE_ORDER) {
      const a = thisWk.filter((i) => queueOf(i) === q).length
      const b = lastWk.filter((i) => queueOf(i) === q).length
      if (b >= 2 && a + b >= 4) {
        const d = Math.round(((a - b) / b) * 100)
        if (Math.abs(d) >= 30 && (!best || Math.abs(d) > Math.abs(best.delta)))
          best = { label: QUEUE_LABEL[q], delta: d }
      }
    }
    if (best)
      lines.push(
        `${best.label} tasks are ${best.delta > 0 ? 'up' : 'down'} ${Math.abs(best.delta)}% this week.`
      )
  }

  // Closure balance this week.
  const closedThisWk = items.filter((i) => closedMeaningfully(i) && nowMs - i.updatedAt < 7 * DAY).length
  if (closedThisWk > 0 && thisWk.length > 0) {
    if (closedThisWk > thisWk.length)
      lines.push(`Closing faster than new work arrives — ${closedThisWk} closed vs ${thisWk.length} new this week.`)
    else if (thisWk.length > closedThisWk * 2 && thisWk.length >= 4)
      lines.push(`Arrivals are outpacing closures ${thisWk.length} to ${closedThisWk} this week.`)
  }

  // The oldest untouched active item, when it is genuinely old.
  const act = items.filter(active)
  const oldest = [...act].sort((a, b) => a.updatedAt - b.updatedAt)[0]
  if (oldest && nowMs - oldest.updatedAt > 7 * DAY) {
    const days = Math.floor((nowMs - oldest.updatedAt) / DAY)
    lines.push(`“${(oldest.title || '').slice(0, 40)}” has waited ${days} days for a touch.`)
  }

  return lines.slice(0, 4)
}

// ── Where to start (the recommendation strip) ───────────────────────────────

export interface StartRecommendation {
  item: FbNode
  reason: string
}

export function startRecommendations(
  items: FbNode[],
  nowMs: number,
  n = 3
): StartRecommendation[] {
  return items
    .filter(active)
    .filter((i) => i.workItemState !== 'suggested')
    .map((i) => ({ i, score: rankScore(i, nowMs) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(({ i }, k) => ({
      item: i,
      reason: itemReason(i, nowMs) ?? startFallbackReason(i, nowMs, k)
    }))
}

/** DEC-072 — the strip's fallback, honest per card. The old strings claimed
 *  'Waiting the longest' on up to three cards at once (a superlative only one
 *  of them can hold) and 'Top of the queue' on cards #2–3. Day counts are
 *  always true; the rank phrasing only ever names #1 as the top. */
function startFallbackReason(i: FbNode, nowMs: number, index: number): string {
  const quietDays = Math.floor((nowMs - i.updatedAt) / DAY)
  if (quietDays >= 3) return `Waiting ${quietDays} days`
  return index === 0 ? 'Top of your queue' : 'Next in your queue'
}
