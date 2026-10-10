import type { FbNode } from '@shared/types'
import { TERMINAL_WORK_ITEM_STATES, DEFAULT_INTENT_CLASS, canonicalIntentClass } from '@shared/workItems'

// Attention queue semantics (S6, SPEC-017/§2.3-F013). Pure and testable:
// grouping, ordering, and the per-class primary action. Everything derives
// from work_item_state / intent_class — NEVER from the legacy status
// projection (F013: 'open' is a compatibility value, not a "needs me" signal).
//
// Taxonomy alignment: the eight primaries in the synthesis's order. Schema
// values keep the full to_* form; the labels here are THE user-facing names.
// Item classes canonicalize at this boundary (canonicalIntentClass), so a
// legacy value a not-yet-updated peer pushed still groups and closes right.

export const QUEUE_ORDER = [
  'to_do',
  'to_review',
  'to_decide',
  'to_respond',
  'to_meet',
  'to_discuss',
  'to_remember',
  'to_know'
] as const

export const QUEUE_LABEL: Record<string, string> = {
  to_do: 'To Do',
  to_review: 'Review',
  to_decide: 'Decide',
  to_respond: 'Respond',
  to_meet: 'Meet',
  to_discuss: 'Discuss',
  to_remember: 'Remember',
  to_know: 'Know'
}

export const QUEUE_ICON: Record<string, string> = {
  to_do: 'check_circle',
  to_review: 'rate_review',
  to_decide: 'alt_route',
  to_respond: 'reply',
  to_meet: 'event',
  to_discuss: 'forum',
  to_remember: 'lightbulb',
  to_know: 'info'
}

/** DEC-043 — each class's hue, drawn from the PlexiSuite brand family
 *  (styles/tokens.css: the same seven vivid accents the product groups use,
 *  so the queues read as part of the SAME system). Applied SUBTLY by design:
 *  icon tints, a 10%-alpha wash on the active tab, a soft underline — never
 *  a colored panel. Remember takes the lightbulb's yellow; Know stays a
 *  neutral slate (information carries no temperature). */
export const QUEUE_COLOR: Record<string, string> = {
  to_do: '#0ea5e9', //     sky    (PlexiData)
  to_review: '#8b5cf6', // violet (PlexiAI)
  to_decide: '#f59e0b', // amber  (PlexiOffice)
  to_respond: '#14b8a6', // teal  (PlexiOps)
  to_meet: '#10b981', //   green  (PlexiBuild)
  to_discuss: '#6366f1', // indigo (PlexiConnect)
  to_remember: '#eab308', // yellow (the lightbulb)
  to_know: '#64748b' //    slate  (neutral)
}

/** hex + alpha → rgba() for the subtle washes. */
/** DEC-095 — the same hex as a SPACE-SEPARATED RGB triplet ("14 165 233"),
 *  for CSS custom properties that get alpha modifiers downstream
 *  (`rgb(var(--kpi-tone) / 0.2)`). GAP-018/019: a comma triplet or a
 *  complete color in that position is invalid CSS and paints nothing. */
export function toneTriplet(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

export function queueTint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** The confirm card / reclassify / manual-form choice set — ONE copy (the
 *  pre-alignment build had drifting duplicates in the card and the view). */
export const CLASS_CHOICES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'to_do', label: 'To Do', hint: 'Something to be done' },
  { value: 'to_review', label: 'Review', hint: 'Needs judgment or sign-off' },
  { value: 'to_decide', label: 'Decide', hint: 'A choice between options' },
  { value: 'to_respond', label: 'Respond', hint: 'Someone awaits words back' },
  { value: 'to_meet', label: 'Meet', hint: 'Time and calendar' },
  { value: 'to_discuss', label: 'Discuss', hint: 'Talk it through live' },
  { value: 'to_remember', label: 'Remember', hint: 'Keep it around, may fade' },
  { value: 'to_know', label: 'Know', hint: 'Worth knowing, nothing owed' }
]

export const CLASS_LABEL: Record<string, string> = Object.fromEntries(
  CLASS_CHOICES.map((c) => [c.value, c.label])
)

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_WORK_ITEM_STATES)

export function isTerminalState(state: string | null | undefined): boolean {
  return state != null && TERMINAL.has(state)
}

/** An item's class in canonical form (legacy values map forward; missing or
 *  unknown falls to the default queue). The one lookup key for every map here. */
export function queueOf(i: Pick<FbNode, 'intentClass'>): string {
  return canonicalIntentClass(i.intentClass) ?? i.intentClass ?? DEFAULT_INTENT_CLASS
}

/** The class-appropriate closing verb: what "done" means per queue. */
export const PRIMARY_ACTION: Record<string, { state: string; label: string }> = {
  to_do: { state: 'completed', label: 'Done' },
  to_review: { state: 'reviewed', label: 'Reviewed' },
  to_decide: { state: 'decided', label: 'Decided' },
  to_respond: { state: 'answered', label: 'Responded' },
  to_meet: { state: 'scheduled', label: 'Scheduled' },
  to_discuss: { state: 'discussed', label: 'Discussed' },
  to_remember: { state: 'dismissed', label: 'Let it go' },
  to_know: { state: 'acknowledged', label: 'Got it' }
}

/** Items needing the person, snooze-respecting, grouped by queue in the fixed
 *  order. Within a queue: overdue/soonest due first (nulls last), then newest. */
export function groupIntoQueues(
  items: FbNode[],
  nowMs: number
): Array<{ queue: string; label: string; items: FbNode[] }> {
  const active = items.filter(
    (i) =>
      !isTerminalState(i.workItemState) &&
      !(i.snoozeUntil != null && i.snoozeUntil > nowMs) &&
      i.detachedFromId == null
  )
  const byQueue = new Map<string, FbNode[]>()
  for (const i of active) {
    const q = queueOf(i)
    const list = byQueue.get(q) ?? []
    list.push(i)
    byQueue.set(q, list)
  }
  const out: Array<{ queue: string; label: string; items: FbNode[] }> = []
  const orderedKeys = [
    ...QUEUE_ORDER.filter((q) => byQueue.has(q)),
    ...[...byQueue.keys()].filter((q) => !(QUEUE_ORDER as readonly string[]).includes(q))
  ]
  for (const q of orderedKeys) {
    const list = byQueue.get(q)!
    list.sort((a, b) => rankScore(b, nowMs) - rankScore(a, nowMs) || b.createdAt - a.createdAt)
    out.push({ queue: q, label: QUEUE_LABEL[q] ?? q, items: list })
  }
  return out
}

/** The ranker v1 (SPEC-019, F006): item-level signals ONLY — deadline
 *  proximity dominates, item-inactivity staleness second (an untouched item
 *  needs the eye more than a fresh one), explicit-human-ask a light thumb.
 *  Scored against attentionPrecision() over time (workItems:precision). */
export function rankScore(i: FbNode, nowMs: number): number {
  let score = 0
  if (i.dueAt) {
    const ms = Date.parse(i.dueAt) - nowMs
    const days = ms / (24 * 60 * 60 * 1000)
    if (ms < 0) score += 100
    else if (days <= 1) score += 80
    else if (days <= 3) score += 60
    else if (days <= 7) score += 40
    else score += 10
  }
  const quietDays = (nowMs - i.updatedAt) / (24 * 60 * 60 * 1000)
  score += Math.min(20, Math.max(0, quietDays * 2))
  if (i.wiOrigin === 'human' && isActionableIntent(i.intentClass)) score += 5
  return score
}

// Mirrors intentRules' ACTIONABLE set (deadline-bearing commitment classes).
function isActionableIntent(c: string | null | undefined): boolean {
  const q = canonicalIntentClass(c)
  return q === 'to_do' || q === 'to_review' || q === 'to_meet' || q === 'to_decide' || q === 'to_respond'
}

/** DEC-047 (D-1) — desk clusters in the Queue lens, DERIVED from parentId
 *  (analysis/23: never stored — a stored mirror of parentId is the drift
 *  trap). Rows keep their given order; a desk becomes a cluster only when it
 *  holds ≥2 rows in this section (a single item's chips already name its
 *  desk — a header over one row is noise). Cluster order = first appearance,
 *  so the ranker still decides what leads. */
export interface DeskCluster<R> {
  deskId: string | null
  rows: R[]
}

export function clusterByDesk<R extends { item: Pick<FbNode, 'parentId'> }>(
  rows: R[]
): DeskCluster<R>[] {
  const byDesk = new Map<string, R[]>()
  for (const r of rows) {
    const d = r.item.parentId ?? ''
    byDesk.set(d, [...(byDesk.get(d) ?? []), r])
  }
  const out: DeskCluster<R>[] = []
  const emitted = new Set<string>()
  for (const r of rows) {
    const d = r.item.parentId ?? ''
    if (emitted.has(d)) continue
    const group = byDesk.get(d)!
    if (d && group.length >= 2) {
      emitted.add(d)
      out.push({ deskId: d, rows: group })
    } else if (!d) {
      // Standalone items collect into ONE trailing pseudo-cluster in order.
      if (!emitted.has('')) {
        emitted.add('')
        out.push({ deskId: null, rows: byDesk.get('')! })
      }
    } else {
      emitted.add(d)
      out.push({ deskId: null, rows: group }) // single-item desk: render flat
    }
  }
  // Merge the flat clusters (null deskId) preserving order of appearance.
  const merged: DeskCluster<R>[] = []
  for (const c of out) {
    const last = merged[merged.length - 1]
    if (c.deskId === null && last && last.deskId === null) last.rows.push(...c.rows)
    else merged.push({ ...c })
  }
  return merged
}

/** DEC-045 — the desk-widget scope. Items whose home is THIS desk; when the
 *  desk holds no ACTIVE item the widget falls back to everything (the
 *  operator's ruling: "if there are none, it can default to all") and says
 *  so, rather than sitting empty next to a full queue. */
export function scopeItemsForDesk(
  items: FbNode[],
  deskId: string
): { scoped: FbNode[]; fellBack: boolean } {
  const mine = items.filter((i) => i.parentId === deskId)
  const active = mine.filter((i) => !isTerminalState(i.workItemState) && i.detachedFromId == null)
  if (active.length === 0) return { scoped: items, fellBack: true }
  return { scoped: mine, fellBack: false }
}

/** The Detached shelf (F-M6/F-M7″): park-local items whose desk was purged or
 *  org-moved. Primary recovery is MOVE; they never mix into the queues. */
export function detachedItems(items: FbNode[]): FbNode[] {
  return items.filter((i) => i.detachedFromId != null && !isTerminalState(i.workItemState))
}

/** Alternate lenses over the same active set (SPEC-017 saved lenses, v1):
 *  by due day or by origin. Same visibility rules as the queue grouping. */
export function groupByDue(
  items: FbNode[],
  nowMs: number
): Array<{ queue: string; label: string; items: FbNode[] }> {
  const active = items.filter(
    (i) =>
      !isTerminalState(i.workItemState) &&
      !(i.snoozeUntil != null && i.snoozeUntil > nowMs) &&
      i.detachedFromId == null
  )
  const DAY = 24 * 60 * 60 * 1000
  const bucketOf = (i: FbNode): string => {
    if (!i.dueAt) return 'none'
    const days = (Date.parse(i.dueAt) - nowMs) / DAY
    if (days < 0) return 'overdue'
    if (days <= 1) return 'today'
    if (days <= 2) return 'tomorrow'
    if (days <= 7) return 'week'
    return 'later'
  }
  const LABELS: Record<string, string> = {
    overdue: 'Past due',
    today: 'Today',
    tomorrow: 'Tomorrow',
    week: 'This week',
    later: 'Later',
    none: 'No date'
  }
  const order = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none']
  const byBucket = new Map<string, FbNode[]>()
  for (const i of active) {
    const b = bucketOf(i)
    byBucket.set(b, [...(byBucket.get(b) ?? []), i])
  }
  return order
    .filter((b) => byBucket.has(b))
    .map((b) => ({
      queue: b,
      label: LABELS[b],
      items: byBucket.get(b)!.sort((a, x) => rankScore(x, nowMs) - rankScore(a, nowMs))
    }))
}

export function groupByOrigin(
  items: FbNode[],
  nowMs: number
): Array<{ queue: string; label: string; items: FbNode[] }> {
  const active = items.filter(
    (i) =>
      !isTerminalState(i.workItemState) &&
      !(i.snoozeUntil != null && i.snoozeUntil > nowMs) &&
      i.detachedFromId == null
  )
  const LABELS: Record<string, string> = { human: 'You', ai: 'Plexii', system: 'System' }
  const order = ['human', 'ai', 'system']
  const byOrigin = new Map<string, FbNode[]>()
  for (const i of active) {
    const o = i.wiOrigin ?? 'human'
    byOrigin.set(o, [...(byOrigin.get(o) ?? []), i])
  }
  return order
    .filter((o) => byOrigin.has(o))
    .map((o) => ({
      queue: o,
      label: LABELS[o] ?? o,
      items: byOrigin.get(o)!.sort((a, x) => rankScore(x, nowMs) - rankScore(a, nowMs))
    }))
}

/** The closed shelf: loops finished in the window (dismissed/reclassified are
 *  not celebrations and stay out; the queues' own history covers them —
 *  archived is a shelf of its own, not a closure). */
export function recentlyClosed(items: FbNode[], nowMs: number, windowDays = 7): FbNode[] {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000
  return items
    .filter(
      (i) =>
        isTerminalState(i.workItemState) &&
        i.workItemState !== 'dismissed' &&
        i.workItemState !== 'reclassified' &&
        i.workItemState !== 'archived' &&
        i.updatedAt > cutoff
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** DEC-024 — the Archived shelf: kept, out of the way, no clock. Unarchive
 *  (state → open) is the recovery; nothing here ever nudges or decays. */
export function archivedItems(items: FbNode[]): FbNode[] {
  return items
    .filter((i) => i.workItemState === 'archived')
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The item's full, unedited text for reading or copying: the title, then the
 *  notes verbatim. A queue row truncates for scannability, so this is the ONE
 *  place the whole capture is reconstituted — expand and copy both use it. */
export function itemFullText(i: Pick<FbNode, 'title' | 'description'>): string {
  return [i.title?.trim(), (i.description ?? '').trim()].filter(Boolean).join('\n\n')
}

/** One plain-language reason per item (SPEC-018 v1): due proximity beats
 *  origin; reason_code (e.g. 'decayed') is honored when present. */
export function itemReason(i: FbNode, nowMs: number): string | null {
  if (i.reasonCode === 'decayed') return 'Faded out quietly'
  if (i.dueAt) {
    const ms = Date.parse(i.dueAt) - nowMs
    const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
    if (ms < 0) return 'Past due'
    if (days <= 1) return 'Due today'
    if (days === 2) return 'Due tomorrow'
    if (days <= 7) return `Due in ${days} days`
    return null
  }
  if (i.wiOrigin === 'ai') return 'Suggested by Plexii'
  return null
}

// ── Attention's state/due filters ────────────────────────────────────────────
//
// A different axis from the queues above. QUEUE_ORDER classifies an item by
// what it WANTS from you (To Do, Review, Decide…); these six classify it by
// where it HAS GOT TO. Both are useful and neither replaces the other, so they
// are kept apart rather than merged into one list.
//
// Defined once here because three places need the same answer: the sidebar's
// submenu renders the labels, the view store carries the chosen id, and
// AttentionView filters by it. A predicate in one place also means the rules
// are unit-tested rather than re-derived per surface.

export type AttentionFilter =
  | 'open'
  | 'due-today'
  | 'overdue'
  | 'in-progress'
  | 'waiting'
  | 'closed-7d'

export const ATTENTION_FILTERS: ReadonlyArray<{
  id: AttentionFilter
  label: string
  icon: string
}> = [
  { id: 'open', label: 'Open', icon: 'radio_button_unchecked' },
  { id: 'due-today', label: 'Due today', icon: 'today' },
  { id: 'overdue', label: 'Overdue', icon: 'alarm' },
  { id: 'in-progress', label: 'In progress', icon: 'pending' },
  { id: 'waiting', label: 'Waiting', icon: 'hourglass_empty' },
  { id: 'closed-7d', label: 'Closed 7d', icon: 'check_circle' }
]

/**
 * States that mean "not mine to move right now" — the ball is with someone or
 * something else. Drawn from ACTIVE_WORK_ITEM_STATES: needs_review and
 * needs_approval belong here too, since both are waiting on another person,
 * not on you.
 */
const WAITING_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'blocked',
  'delegated',
  'needs_review',
  'needs_approval'
])

/**
 * Does this item belong under `filter`?
 *
 * "Open" means live work, so it excludes terminal states AND items snoozed
 * into the future — a snoozed item is deliberately not asking for attention
 * yet, and showing it under Open would undo the snooze's whole point.
 *
 * Due today is the calendar day in the VIEWER's timezone, not "within 24
 * hours": something due at 9am tomorrow is not due today, and an item due
 * earlier today that is now overdue answers to both — overdue is the sharper
 * statement, so it is also true for Due today by design.
 */
export function matchesAttentionFilter(
  i: Pick<FbNode, 'workItemState' | 'dueAt' | 'snoozeUntil' | 'detachedFromId' | 'updatedAt'>,
  filter: AttentionFilter,
  nowMs: number
): boolean {
  const terminal = isTerminalState(i.workItemState)
  const snoozed = i.snoozeUntil != null && i.snoozeUntil > nowMs
  const live = !terminal && !snoozed && i.detachedFromId == null

  if (filter === 'closed-7d') {
    if (!terminal) return false
    // The same exclusions recentlyClosed applies: dismissed, reclassified and
    // archived items were not "closed", they were taken out of the flow.
    const st = i.workItemState
    if (st === 'dismissed' || st === 'reclassified' || st === 'archived') return false
    const when = i.updatedAt ?? 0
    return when > nowMs - 7 * 24 * 60 * 60 * 1000
  }

  if (!live) return false

  switch (filter) {
    case 'open':
      return true
    case 'in-progress':
      return i.workItemState === 'in_progress'
    case 'waiting':
      return i.workItemState != null && WAITING_STATES.has(i.workItemState)
    case 'overdue':
      return i.dueAt != null && Date.parse(i.dueAt) < nowMs
    case 'due-today': {
      if (!i.dueAt) return false
      const due = new Date(Date.parse(i.dueAt))
      const now = new Date(nowMs)
      return (
        due.getFullYear() === now.getFullYear() &&
        due.getMonth() === now.getMonth() &&
        due.getDate() === now.getDate()
      ) || Date.parse(i.dueAt) < nowMs
    }
    default:
      return true
  }
}
