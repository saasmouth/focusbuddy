import { dueStanding } from './dueDates'
import type { FbNode, TimeBlock } from '@shared/types'
import { rankScore, isTerminalState } from './attentionQueues'
import { parseTags } from './itemTags'
import { parseMentions, mentionKey } from './itemMentions'

// DEC-052 (Track B) — the planner. Pure functions over (items, blocks,
// settings, now): every placement decision is unit-tested, and the UI stays a
// thin previewer. Nothing in this module writes — the CALLER creates blocks,
// and only after the person confirms the preview (DEC-052 #5: both AI modes
// are preview-first; the human is always in the loop).
//
// The conventions this encodes, from Analysis 24 §5c/§5d:
// - waiting/blocked items are NEVER scheduled (a plan containing work you
//   cannot do is a fiction — the over-optimism retention killer).
// - a daily planned-minutes ceiling, on by default (Sunsama's ~5.5h is the
//   only shipped calibration in the category).
// - slack between blocks and a max session length, on by default.
// - replan NEVER moves anything: a missed block stays as the honest record
//   (status 'missed'), and the ITEM gets a fresh proposal. Locked, manual,
//   done and meeting blocks are untouchable by construction.
// - a one-hour grace period before a passed block counts as missed
//   (finishing at 5:04 is not a failure).

export interface PlannerSettings {
  /** Working window, minutes from midnight. */
  dayStartMin: number
  dayEndMin: number
  /** Default proposal length. */
  defaultBlockMin: number
  /** Never propose a single sitting longer than this. */
  maxSessionMin: number
  /** Breathing room enforced after each proposed block. */
  gapMin: number
  /** DEC-092 — minutes kept clear on BOTH sides of an actual meeting (a
   *  block with a meeting payload — invitees, a join link, a room). The
   *  operator's rule: never schedule right against a call. 0 disables;
   *  adjustable in the planner settings popover. */
  meetingBufferMin: number
  /** Ceiling on TOTAL planned minutes in a day (existing blocks count). */
  maxDailyPlannedMin: number
  /** Step 9 — drag-select creates the block instantly with inline naming,
   *  instead of opening the dialog. Operator ruling (2026-08-30, after using
   *  it): a drag-highlight should open the FULL dialog to specify details —
   *  so this defaults OFF, and the switch opts into inline. */
  inlineCreate: boolean
}

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  dayStartMin: 9 * 60,
  dayEndMin: 17 * 60,
  defaultBlockMin: 30,
  maxSessionMin: 90,
  gapMin: 10,
  meetingBufferMin: 15,
  maxDailyPlannedMin: 330,
  inlineCreate: false
}

const SETTINGS_KEY = 'planner.settings'

export function loadPlannerSettings(): PlannerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_PLANNER_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<PlannerSettings>
    return { ...DEFAULT_PLANNER_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_PLANNER_SETTINGS }
  }
}

export function savePlannerSettings(s: PlannerSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}

const MIN = 60_000
const DAY = 24 * 60 * MIN
/** Grace before a passed planned block counts as missed. */
export const MISSED_GRACE_MS = 60 * MIN
/** Don't bother proposing into a sliver shorter than this. */
const MIN_USEFUL_MIN = 15

export interface PlannedProposal {
  itemId: string
  title: string
  startMs: number
  durationMin: number
  reason: string
  /** DEC-089 — client-side row identity for the review sheet. itemId alone
   *  is not unique (a long item can split into several sessions), and
   *  startMs stops being stable once rows are editable. Assigned by the
   *  view when a plan enters review; the planner itself never sets it. */
  uid?: string
}

export interface FreeSlot {
  startMs: number
  endMs: number
  /** DEC-092 — the item linked to the existing block bordering this slot
   *  (before its start / after its end), when there is one. Placement uses
   *  these to score NEIGHBOR AFFINITY: related work prefers to land beside
   *  the block it belongs with. Set only when a border block links an item. */
  beforeItemId?: string
  afterItemId?: string
}

/** Blocks that OCCUPY time for planning purposes: anything real on the day
 *  that has not been written off. Missed/skipped slots are history, not
 *  commitments — their time is reusable. */
const occupies = (b: TimeBlock): boolean => b.status === 'planned' || b.status === 'done'

/**
 * The open stretches of a working day, after existing commitments and the
 * clock. `nowMs` floors the first slot — the planner never proposes into the
 * past.
 */
export function freeSlots(
  blocks: TimeBlock[],
  dayMs: number,
  settings: PlannerSettings,
  nowMs: number
): FreeSlot[] {
  const windowStart = Math.max(dayMs + settings.dayStartMin * MIN, nowMs)
  const windowEnd = dayMs + settings.dayEndMin * MIN
  if (windowStart >= windowEnd) return []
  const busy = blocks
    .filter(occupies)
    .map((b) => {
      // DEC-092 — existing commitments get breathing room on BOTH sides: the
      // house gap around ordinary planned blocks, the (larger, adjustable)
      // meeting buffer around actual meetings. Done blocks are history — no
      // padding around what already happened. Before this, a slot began the
      // INSTANT a block ended, and replans crammed work against meetings.
      const pad =
        b.status === 'planned'
          ? (b.meeting ? Math.max(settings.meetingBufferMin, settings.gapMin) : settings.gapMin) *
            MIN
          : 0
      return {
        start: b.startMs - pad,
        end: b.startMs + b.durationMin * MIN + pad,
        taskId: b.taskId ?? null
      }
    })
    .filter((b) => b.start < windowEnd && b.end > windowStart)
    .sort((a, b) => a.start - b.start)
  const slots: FreeSlot[] = []
  let cursor = windowStart
  let lastTask: string | null = null
  for (const b of busy) {
    if (b.start > cursor)
      slots.push({
        startMs: cursor,
        endMs: Math.min(b.start, windowEnd),
        ...(lastTask ? { beforeItemId: lastTask } : {}),
        ...(b.taskId ? { afterItemId: b.taskId } : {})
      })
    if (b.end > cursor) {
      cursor = b.end
      lastTask = b.taskId
    }
    if (cursor >= windowEnd) break
  }
  if (cursor < windowEnd)
    slots.push({ startMs: cursor, endMs: windowEnd, ...(lastTask ? { beforeItemId: lastTask } : {}) })
  return slots.filter((s) => s.endMs - s.startMs >= MIN_USEFUL_MIN * MIN)
}

/** Items the planner may honestly place: active, present, and DOABLE.
 *  waiting/blocked/suggested are excluded by principle, not preference. */
export function schedulableItems(items: FbNode[], nowMs: number): FbNode[] {
  return items.filter(
    (i) =>
      !isTerminalState(i.workItemState) &&
      i.detachedFromId == null &&
      !(i.snoozeUntil != null && i.snoozeUntil > nowMs) &&
      !['waiting', 'blocked', 'suggested'].includes(i.workItemState ?? '')
  )
}

/** DEC-052 momentum: closures per DESK over the trailing 3 days — "riding a
 *  streak beats context-switching to something equally urgent" (operator).
 *  Derived from updatedAt on terminal items; no event log pretended. */
export function momentumByDesk(items: FbNode[], nowMs: number): Map<string, number> {
  const m = new Map<string, number>()
  for (const i of items) {
    if (!i.parentId || !isTerminalState(i.workItemState)) continue
    if (i.workItemState === 'dismissed' || i.workItemState === 'archived') continue
    if (nowMs - i.updatedAt > 3 * DAY) continue
    m.set(i.parentId, (m.get(i.parentId) ?? 0) + 1)
  }
  return m
}

export interface PlanDayOptions {
  /** Restrict + prioritise: when set (the intent-driven mode), only these
   *  items are considered, in this order, ahead of the ranker. */
  onlyItemIds?: string[]
  /** Item ids that already have a future block — skipped (drag placed them). */
  placedIds?: Set<string>
  /** Desk titles for human-readable momentum reasons. */
  deskTitles?: Map<string, string>
  /** Why this run exists — colours the reason FALLBACK only (an item's own
   *  facts still outrank it): 'intent' = the person described the day and
   *  planSelect picked the pool; 'replan' = missed blocks being re-proposed.
   *  Both callers pass onlyItemIds, so the mode cannot be inferred from it. */
  source?: 'intent' | 'replan'
}

/**
 * Propose blocks for one day. Deterministic, ordered by the SAME ranker the
 * queues use (one ranker — Analysis 24 §4) plus the momentum boost, packed
 * into the day's free slots with gaps, capped by the daily ceiling.
 */
/** Clip to a word boundary with an ellipsis, so a truncated title never ends
 *  mid-word inside quotation marks. */
function clipTitle(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

/** DEC-092 — how strongly two items belong NEAR each other on a calendar.
 *  Same desk is the strongest signal; shared tags and shared mentions next;
 *  same intent class weakest. Pure and cheap — scored per candidate slot. */
export function relatedness(a: FbNode | null | undefined, b: FbNode | null | undefined): number {
  if (!a || !b || a.id === b.id) return 0
  let n = 0
  if (a.parentId && a.parentId === b.parentId) n += 3
  const at = new Set(parseTags(a.tags))
  if (at.size && parseTags(b.tags).some((tag) => at.has(tag))) n += 2
  const am = new Set(parseMentions(a.mentions).map(mentionKey))
  if (am.size && parseMentions(b.mentions).some((m) => am.has(mentionKey(m)))) n += 2
  if (a.intentClass && a.intentClass === b.intentClass) n += 1
  return n
}

/** DEC-092 — cluster the DISCRETIONARY tail of a ranked pool so related work
 *  runs together instead of interleaving. After each head, ONE strongly
 *  related follower (desk-level, relatedness ≥ 3) may be pulled to the
 *  front — but never across an item that is DUE by day's end: deadline-first
 *  is a promise; the rest is preference. Deterministic and order-stable. */
export function chainRelated(pool: FbNode[], dueIds: Set<string>): FbNode[] {
  const rest = [...pool]
  const out: FbNode[] = []
  while (rest.length) {
    const head = rest.shift()!
    out.push(head)
    let barrier = rest.findIndex((r) => dueIds.has(r.id))
    if (barrier === -1) barrier = rest.length
    for (let k = 1; k < barrier; k++) {
      if (relatedness(head, rest[k]) >= 3) {
        const [pulled] = rest.splice(k, 1)
        rest.unshift(pulled)
        break
      }
    }
  }
  return out
}

export function planDay(
  items: FbNode[],
  blocks: TimeBlock[],
  settings: PlannerSettings,
  dayMs: number,
  nowMs: number,
  opts: PlanDayOptions = {}
): PlannedProposal[] {
  const placed = opts.placedIds ?? new Set()
  let pool = schedulableItems(items, nowMs).filter((i) => !placed.has(i.id))
  if (opts.onlyItemIds) {
    const order = new Map(opts.onlyItemIds.map((id, k) => [id, k]))
    pool = pool.filter((i) => order.has(i.id))
    pool.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  } else {
    const momentum = momentumByDesk(items, nowMs)
    pool = [...pool].sort(
      (a, b) =>
        rankScore(b, nowMs) +
        (momentum.get(b.parentId ?? '') ?? 0) * 1.5 -
        (rankScore(a, nowMs) + (momentum.get(a.parentId ?? '') ?? 0) * 1.5)
    )
    // DEC-092 — related discretionary items run together (due items are
    // immovable barriers). "Randomly thrown on the calendar" was the
    // operator's verdict on interleaved placement.
    const dueTodayIds = new Set(
      pool.filter((i) => i.dueAt != null && Date.parse(i.dueAt) < dayMs + DAY).map((i) => i.id)
    )
    pool = chainRelated(pool, dueTodayIds)
  }

  // The ceiling counts what the day ALREADY holds.
  const dayEnd = dayMs + DAY
  const existingMin = blocks
    .filter(occupies)
    .filter((b) => b.startMs < dayEnd && b.startMs + b.durationMin * MIN > dayMs)
    .reduce((n, b) => n + b.durationMin, 0)
  let budgetMin = Math.max(0, settings.maxDailyPlannedMin - existingMin)

  const momentum = momentumByDesk(items, nowMs)
  // DEC-092 — placement stopped being first-fit. Each item scores every open
  // interval: an earliness prior keeps days front-loaded, and NEIGHBOR
  // AFFINITY (the existing block bordering the slot, or the proposal just
  // placed in it) pulls related work together. Deterministic on purpose —
  // the observed failure was mechanical cramming, not a knowledge gap, and
  // a scoring rule is testable where a model call is not.
  const itemById = new Map(items.map((i) => [i.id, i] as const))
  const open: Array<FreeSlot & { beforeProposedId?: string }> = freeSlots(
    blocks,
    dayMs,
    settings,
    nowMs
  ).map((s) => ({ ...s }))
  const HOUR = 60 * MIN
  const firstOpenMs = open.length ? open[0].startMs : 0
  const out: PlannedProposal[] = []

  // Reason context (DEC-072): who else has a claim on this day. Computed over
  // ALL schedulable items (not just the pool) so drag-placed due items still
  // count as "handled" rather than vanishing from the sentence.
  const dueByDayEnd = new Set(
    schedulableItems(items, nowMs)
      .filter((i) => i.dueAt != null && Date.parse(i.dueAt) < dayMs + DAY)
      .map((i) => i.id)
  )
  const dayWord = wordForDay(dayMs, nowMs)
  const proposedIds = new Set<string>()

  for (const item of pool) {
    if (budgetMin < MIN_USEFUL_MIN) break
    const wantMin = Math.min(settings.defaultBlockMin, settings.maxSessionMin, budgetMin)
    let best = -1
    let bestScore = -Infinity
    let bestNeighbor: FbNode | null = null
    for (let k = 0; k < open.length; k++) {
      const s = open[k]
      const roomMin = Math.floor((s.endMs - s.startMs) / MIN)
      if (roomMin < MIN_USEFUL_MIN) continue
      const beforeItem = itemById.get(s.beforeProposedId ?? s.beforeItemId ?? '') ?? null
      const afterItem = itemById.get(s.afterItemId ?? '') ?? null
      const affBefore = relatedness(beforeItem, item)
      // The before-border is genuinely adjacent (we place at slot start);
      // the after-border only counts by PROXIMITY — landing at the start of
      // a three-hour slot is not "beside" the block at its far end.
      const closeness = Math.max(
        0,
        1 - (s.endMs - (s.startMs + Math.min(wantMin, roomMin) * MIN)) / HOUR
      )
      const affAfter = relatedness(afterItem, item) * closeness
      const score = -((s.startMs - firstOpenMs) / HOUR) * 0.8 + affBefore * 2.5 + affAfter * 1.5
      if (score > bestScore + 1e-9) {
        bestScore = score
        best = k
        bestNeighbor =
          affBefore >= affAfter
            ? affBefore >= 3
              ? beforeItem
              : null
            : affAfter >= 3
              ? afterItem
              : null
      }
    }
    if (best < 0) break
    const s = open[best]
    const durMin = Math.min(wantMin, Math.floor((s.endMs - s.startMs) / MIN))
    const othersDue = [...dueByDayEnd].filter((id) => id !== item.id)
    const baseReason = reasonFor(item, nowMs, momentum, opts.deskTitles, {
      source: opts.source,
      dayWord,
      anyOthersDue: othersDue.length > 0,
      othersDueHandled: othersDue.every((id) => placed.has(id) || proposedIds.has(id))
    })
    // The intelligence, said out loud (the placement WHY, beside the item
    // WHY): only for desk-level affinity, so the note stays signal.
    // DEC-094 — separated and cleanly clipped. Concatenated bare, this ran
    // into the lateness clause ("Due Saturday Grouped beside …") and cut off
    // mid-quote once the review sheet gave reasons room to be read.
    const neighborNote = bestNeighbor
      ? ` · Grouped beside “${clipTitle(bestNeighbor.title || 'related work', 32)}”`
      : ''
    out.push({
      itemId: item.id,
      title: item.title,
      startMs: s.startMs,
      durationMin: durMin,
      reason: `${baseReason}${neighborNote}`
    })
    proposedIds.add(item.id)
    budgetMin -= durMin
    s.startMs += (durMin + settings.gapMin) * MIN
    s.beforeProposedId = item.id
  }
  return out
}

/** 'today' / 'tomorrow' / the weekday name, for reasons about the planned day. */
function wordForDay(dayMs: number, nowMs: number): string {
  const d = new Date(dayMs)
  if (d.toDateString() === new Date(nowMs).toDateString()) return 'today'
  if (d.toDateString() === new Date(nowMs + DAY).toDateString()) return 'tomorrow'
  return d.toLocaleDateString(undefined, { weekday: 'long' })
}

interface ReasonContext {
  source?: 'intent' | 'replan'
  dayWord: string
  /** Another schedulable item is due by the end of the planned day. */
  anyOthersDue: boolean
  /** …and every one of them already has a block (dragged or proposed). */
  othersDueHandled: boolean
}

// DEC-072 — the reason a block exists, stated as the item's strongest
// CHECKABLE fact, strongest first: deadline → the person's own urgency call →
// desk momentum → already-started → time waited → why-this-plan-exists. Every
// string is derivable from the inputs; nothing here speculates. The generic
// tail is reachable only when an item has none of those facts AND the day's
// due landscape is mixed — by construction, rare.
function reasonFor(
  i: FbNode,
  nowMs: number,
  momentum: Map<string, number>,
  deskTitles: Map<string, string> | undefined,
  ctx: ReasonContext
): string {
  // 1 — deadlines. The ranker's biggest weight, so also the likeliest truth.
  // Counted in local calendar days (lib/dueDates), so "Due tomorrow" names the
  // next date and a date-only deadline is not late until its day is over.
  const due = dueStanding(i.dueAt, nowMs)
  if (due) {
    if (due.overdue) {
      const daysLate = -due.days
      if (daysLate < 1) return 'Was due earlier today'
      return daysLate === 1 ? 'Overdue by a day' : `Overdue by ${daysLate} days`
    }
    if (due.days <= 0) return 'Due today'
    if (due.days === 1) return 'Due tomorrow'
    if (due.days < 7) return `Due ${new Date(due.ms).toLocaleDateString(undefined, { weekday: 'long' })}`
    // A far-off due date is not why it is on TODAY's plan — fall through.
  }
  // 2 — the person's own urgency call (DEC-037: chosen, so it outranks derived).
  if (i.wiUrgency === 'urgent') return 'You marked it urgent'
  if (i.wiUrgency === 'high') return 'You marked it high priority'
  // 3 — momentum (strings pinned since DEC-052; deliberately unchanged).
  const closures = momentum.get(i.parentId ?? '') ?? 0
  if (closures >= 2) {
    const desk = deskTitles?.get(i.parentId ?? '')
    return desk
      ? `Riding your momentum on ${desk} (${closures} closed lately)`
      : `Riding your momentum (${closures} closed on this desk lately)`
  }
  // 4 — already started: an open loop beats a fresh start.
  if (i.workItemState === 'in_progress') return 'Already started — finish it'
  // 5 — time waited (mirrors the queue's 3-day threshold).
  const quietDays = Math.floor((nowMs - i.updatedAt) / DAY)
  if (quietDays >= 3) return `Waiting ${quietDays} days`
  // 6 — no item-level fact: say why the PLAN chose it.
  if (ctx.source === 'replan') return 'Slipped earlier — proposing a fresh slot'
  if (ctx.source === 'intent') return 'Matches your intent'
  if (!ctx.anyOthersDue) return `Nothing else needs ${ctx.dayWord}`
  if (ctx.othersDueHandled) return 'Everything due already has a slot'
  return 'Next by rank'
}

/**
 * Replan-undone, step 1: which planned blocks are honestly MISSED — fully
 * past (plus the grace period) and never marked done. The caller marks them
 * 'missed' (the record stays; nothing moves) and re-proposes their ITEMS via
 * planDay with onlyItemIds. Locked/manual/meeting/done blocks are untouchable
 * here by construction: only status flips, only on passed 'planned' rows.
 */
export function sweepMissed(blocks: TimeBlock[], nowMs: number): TimeBlock[] {
  return blocks.filter(
    (b) => b.status === 'planned' && b.startMs + b.durationMin * MIN + MISSED_GRACE_MS < nowMs
  )
}

// ── Phase-1 demo fixes (DEC-087) ────────────────────────────────────────────

/** "…before noon tomorrow", "…on friday" — the DAY the intent names, as a
 *  local-midnight ms, or null when it names none. planSelect picks ITEMS;
 *  this picks the DAY — without it, every intent planned the viewed day
 *  (the demo asked for tomorrow and was told today was full). */
export function parsePlanDay(intent: string, nowMs: number): number | null {
  const q = intent.toLowerCase()
  const day = (offset: number): number => {
    const d = new Date(nowMs)
    d.setDate(d.getDate() + offset)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  if (/\btomorrow\b/.test(q)) return day(1)
  if (/\btoday\b|\btonight\b/.test(q)) return day(0)
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b${names[i]}\\b`).test(q)) {
      const dow = new Date(nowMs).getDay()
      const add = (i - dow + 7) % 7 || 7 // "monday" on a Monday = NEXT Monday
      return day(add)
    }
  }
  return null
}

/** After the working window closes, "plan my day" has zero slots left — the
 *  demo's "nothing to place, the day is full" moment, honest but useless.
 *  When the target day is TODAY and its window yields no usable slot, plan
 *  tomorrow instead and SAY SO. Returns the day to plan and the note. */
export function effectivePlanDay(
  requestedDayMs: number,
  blocks: TimeBlock[],
  settings: PlannerSettings,
  nowMs: number
): { dayMs: number; rolledToTomorrow: boolean } {
  const today = new Date(nowMs)
  today.setHours(0, 0, 0, 0)
  if (requestedDayMs !== today.getTime()) return { dayMs: requestedDayMs, rolledToTomorrow: false }
  if (freeSlots(blocks, requestedDayMs, settings, nowMs).length > 0)
    return { dayMs: requestedDayMs, rolledToTomorrow: false }
  return { dayMs: requestedDayMs + 24 * 60 * 60 * 1000, rolledToTomorrow: true }
}

/** DEC-089 — reorder a review row over the plan's slot ladder. The times
 *  (the slots the planner found, plus any hand edits) HOLD their positions;
 *  the items reassign over them in the new order, each keeping its own
 *  duration. A longer item in a tighter slot is the operator's call — the
 *  sheet warns about overlaps instead of silently reflowing the day. */
export function reorderOverSlots(
  ps: PlannedProposal[],
  fromUid: string,
  toUid: string,
  pos: 'before' | 'after'
): PlannedProposal[] {
  if (fromUid === toUid) return ps
  const sorted = [...ps].sort((a, b) => a.startMs - b.startMs)
  const from = sorted.findIndex((s) => s.uid === fromUid)
  const to = sorted.findIndex((s) => s.uid === toUid)
  if (from < 0 || to < 0) return ps
  const slots = sorted.map((s) => s.startMs)
  const items = sorted.map(({ startMs: _drop, ...rest }) => rest)
  let insertAt = to + (pos === 'after' ? 1 : 0)
  if (from < insertAt) insertAt--
  const [moved] = items.splice(from, 1)
  items.splice(insertAt, 0, moved)
  return items.map((it, i) => ({ ...it, startMs: slots[i] }))
}

// ── DEC-090 — the intent's TIME language, parsed deterministically ──────────

export interface PlanWindow {
  startMin: number
  endMin: number
  /** Folded into the plan note — "Planning tomorrow, the afternoon." */
  label: string
}

const MIN12 = 12 * 60

/** Clock phrase → minutes-from-midnight. "2pm"→840, "9"→540 (am below 8 is
 *  assumed pm — nobody plans for 3am), "14:30"→870. */
function clockToMin(h: number, m: number, mer: string | undefined): number | null {
  if (h > 23 || m > 59) return null
  if (mer === 'pm' && h < 12) h += 12
  else if (mer === 'am' && h === 12) h = 0
  else if (!mer && h >= 1 && h < 8) h += 12 // bare "by 3" means 3pm
  return h * 60 + m
}

/** "later in the day", "first half", "before noon", "after 2pm", "between
 *  2 and 4" — the WINDOW an intent asks for, or null when it names none.
 *  Without this, "later" packed the morning: freeSlots always started at
 *  the first opening, and the intent's time words went nowhere. */
export function parsePlanWindow(intent: string, s: PlannerSettings): PlanWindow | null {
  const q = intent.toLowerCase()
  const W = (startMin: number, endMin: number, label: string): PlanWindow | null =>
    endMin - startMin >= 30 ? { startMin, endMin, label } : null

  // Explicit ranges beat named periods.
  const between = /\bbetween\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+and\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(q)
  if (between) {
    const a = clockToMin(+between[1], +(between[2] ?? 0), between[3] ?? between[6])
    const b = clockToMin(+between[4], +(between[5] ?? 0), between[6] ?? between[3])
    if (a != null && b != null && b > a) return W(a, b, `between ${fmtMin(a)} and ${fmtMin(b)}`)
  }
  const after = /\b(?:after|from|starting(?:\s+at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(q)
  if (after) {
    const a = clockToMin(+after[1], +(after[2] ?? 0), after[3])
    if (a != null) return W(a, Math.max(s.dayEndMin, Math.min(a + 4 * 60, 21 * 60)), `after ${fmtMin(a)}`)
  }
  const before = /\b(?:before|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(q)
  if (before) {
    const b = clockToMin(+before[1], +(before[2] ?? 0), before[3])
    if (b != null) return W(s.dayStartMin, b, `before ${fmtMin(b)}`)
  }

  if (/\bfirst half\b/.test(q)) return W(s.dayStartMin, MIN12 + 30, 'the first half of the day')
  if (/\bsecond half\b/.test(q)) return W(MIN12 + 30, s.dayEndMin, 'the second half of the day')
  if (/\bbefore noon\b|\bby noon\b/.test(q)) return W(s.dayStartMin, MIN12, 'before noon')
  if (/\b(?:around noon|midday|over lunch)\b/.test(q)) return W(11 * 60, 14 * 60, 'around midday')
  if (/\bmorning\b/.test(q)) return W(s.dayStartMin, MIN12, 'the morning')
  if (/\b(?:late afternoon|end of (?:the )?day)\b/.test(q))
    return W(Math.max(s.dayStartMin, 15 * 60), s.dayEndMin, 'the end of the day')
  if (/\blater (?:in|on) the day\b|\blater today\b|\blater tomorrow\b/.test(q))
    return W(Math.max(s.dayStartMin, 14 * 60), s.dayEndMin, 'later in the day')
  if (/\bafternoon\b/.test(q)) return W(MIN12, s.dayEndMin, 'the afternoon')
  if (/\b(?:evening|tonight)\b/.test(q)) return W(17 * 60, 21 * 60, 'the evening')
  if (/\bearly (?:in the day|today|tomorrow|start)\b|\bstart of (?:the )?day\b/.test(q))
    return W(s.dayStartMin, 11 * 60, 'the early part of the day')
  return null
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
}

/** "spread it across the week", "throughout the week", "over the next few
 *  days" — plan over several workdays instead of packing one. */
export function parsePlanSpread(intent: string): boolean {
  return /\bspread\b|\b(?:across|throughout|through|over) the (?:rest of the )?(?:week|next few days)\b|\bover the next (?:few |couple (?:of )?)?days\b/i.test(
    intent
  )
}

/** DEC-090 — plan across up to five WORKDAYS starting at dayMs: each day is
 *  planned with what remains, weekends are skipped ("during work hours"),
 *  and the loop stops when the queue is exhausted. */
export function planSpread(
  items: FbNode[],
  blocks: TimeBlock[],
  settings: PlannerSettings,
  startDayMs: number,
  nowMs: number,
  opts: PlanDayOptions = {}
): PlannedProposal[] {
  const out: PlannedProposal[] = []
  let remaining = new Set(opts.onlyItemIds ?? schedulableItems(items, nowMs).map((i) => i.id))
  let dayMs = startDayMs
  let workdays = 0
  while (remaining.size > 0 && workdays < 5) {
    const dow = new Date(dayMs).getDay()
    if (dow !== 0 && dow !== 6) {
      workdays++
      const day = planDay(items, blocks, settings, dayMs, nowMs, {
        ...opts,
        onlyItemIds: [...remaining]
      })
      out.push(...day)
      remaining = new Set([...remaining].filter((id) => !day.some((p) => p.itemId === id)))
      if (day.length === 0 && workdays > 1) break // days are open but nothing fits — stop honestly
    }
    dayMs += 24 * 60 * 60 * 1000
  }
  return out
}

// ── DEC-092 — "reschedule my day": moving plans is not picking topics ───────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** EVERY day the intent names, in text order, deduped — parsePlanDay's
 *  plural sibling ("split between tomorrow and wednesday" names two). */
export function parsePlanDays(intent: string, nowMs: number): number[] {
  const q = intent.toLowerCase()
  const day = (offset: number): number => {
    const d = new Date(nowMs)
    d.setDate(d.getDate() + offset)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const hits: Array<{ at: number; ms: number }> = []
  const scan = (re: RegExp, ms: number): void => {
    const m = re.exec(q)
    if (m) hits.push({ at: m.index, ms })
  }
  scan(/\btomorrow\b/, day(1))
  scan(/\btoday\b|\btonight\b/, day(0))
  const dow = new Date(nowMs).getDay()
  DAY_NAMES.forEach((name, i) => {
    const m = new RegExp(`\\b${name}\\b`).exec(q)
    if (m) hits.push({ at: m.index, ms: day((i - dow + 7) % 7 || 7) })
  })
  const seen = new Set<number>()
  return hits
    .sort((a, b) => a.at - b.at)
    .filter((h) => (seen.has(h.ms) ? false : (seen.add(h.ms), true)))
    .map((h) => h.ms)
}

export interface RescheduleAsk {
  /** Local-midnight targets, today excluded; [tomorrow] when none named. */
  targetDays: number[]
}

/** "Taking the day off — reschedule the rest of my day for a split between
 *  tomorrow and wednesday." A MOVE command, not a topic search: it acts on
 *  today's remaining scheduled blocks, so it must never reach the selection
 *  model (which would honestly find no "day off" items and answer nothing). */
export function parseReschedule(intent: string, nowMs: number): RescheduleAsk | null {
  const q = intent.toLowerCase()
  if (!/\b(reschedul\w*|move|push|shift|bump)\b/.test(q)) return null
  if (!/\b(today|tonight|my day|the day|rest of (?:my |the )?day)\b/.test(q)) return null
  const today = new Date(nowMs)
  today.setHours(0, 0, 0, 0)
  const targets = parsePlanDays(intent, nowMs).filter((d) => d !== today.getTime())
  return { targetDays: targets.length ? targets : [today.getTime() + DAY] }
}

/** What a reschedule may honestly move: today's REMAINING planned blocks
 *  that link an item. Meetings and locked blocks are untouchable by
 *  construction (other people / an explicit pin); plain unlinked blocks
 *  have no item to re-propose. */
export function movableToday(blocks: TimeBlock[], nowMs: number): TimeBlock[] {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  const dayStart = d.getTime()
  return blocks.filter(
    (b) =>
      b.status === 'planned' &&
      b.startMs > nowMs &&
      b.startMs >= dayStart &&
      b.startMs < dayStart + DAY &&
      !b.locked &&
      !b.meeting &&
      !!b.taskId
  )
}

/** DEC-092 — split a set of items across SEVERAL named days: dealt
 *  round-robin (each target gets a share), then placed per-day by planDay
 *  with all of its buffers and affinity. Items that fit nowhere are simply
 *  absent from the result — the caller counts and says so. */
export function planSplit(
  items: FbNode[],
  blocks: TimeBlock[],
  settings: PlannerSettings,
  targetDays: number[],
  nowMs: number,
  itemIds: string[],
  opts: PlanDayOptions = {}
): PlannedProposal[] {
  if (!targetDays.length || !itemIds.length) return []
  const shares: string[][] = targetDays.map(() => [])
  itemIds.forEach((id, i) => shares[i % targetDays.length].push(id))
  const out: PlannedProposal[] = []
  targetDays.forEach((dayMs, d) => {
    out.push(
      ...planDay(items, blocks, settings, dayMs, nowMs, {
        ...opts,
        onlyItemIds: shares[d],
        source: 'replan'
      })
    )
  })
  return out
}
