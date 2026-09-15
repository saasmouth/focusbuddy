// Which of the things on a calendar are about THIS work.
//
// A desk calendar that shows everything is the main calendar with a smaller
// font. The point of putting one on a desk is the opposite: the three dates
// that belong to this job, out of the two hundred in the year.
//
// The criteria are made only of what the entries actually carry -- their title,
// their kind, their status, who they are assigned to, which calendar they came
// from. As with the inbox filter, anything cleverer would be a guess dressed as
// a rule.

export type CalendarSourceKind = 'task' | 'block' | 'external'

export interface CalendarFilter {
  /** This desk and its descendants, or the whole workspace. */
  scope?: 'desk' | 'all'
  /** Which kinds of entry to show at all. */
  sources?: Partial<Record<CalendarSourceKind, boolean>>
  /** Title must contain one of these. Empty = no title rule. */
  match?: string[]
  /** Titles containing any of these are hidden, even if they matched above. */
  exclude?: string[]
  /** Tasks only: which statuses count. */
  taskStatus?: 'all' | 'open' | 'done'
  /** Tasks only: any of these assignees (substring, case-insensitive). */
  assignees?: string[]
  /** Subscribed events only: restrict to these calendar ids. Empty = all. */
  calendarIds?: string[]
}

/** One thing on the calendar, reduced to what a filter can see. */
export interface CalendarEntry {
  id: string
  source: CalendarSourceKind
  title: string
  startMs: number
  /** Tasks: their status. */
  status?: string | null
  assignee?: string | null
  /** Subscribed events: which calendar. */
  calendarId?: string | null
  /** Whether this entry belongs to the desk in view (or its subtree). */
  inScope: boolean
}

const terms = (xs: readonly string[] | undefined): string[] =>
  (xs ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean)

export function sourceEnabled(f: CalendarFilter, s: CalendarSourceKind): boolean {
  // Absent means shown: a filter nobody has configured shows everything it can,
  // which is the only behaviour that does not look broken on first drop.
  return f.sources?.[s] !== false
}

export function matchesFilter(e: CalendarEntry, f: CalendarFilter): boolean {
  if (!sourceEnabled(f, e.source)) return false

  // Scope applies to the things a desk can own. A subscribed event comes from
  // a calendar, not from this workspace's tree, so scoping it by desk would
  // silently hide every one of them.
  if ((f.scope ?? 'desk') === 'desk' && e.source !== 'external' && !e.inScope) return false

  const title = (e.title ?? '').toLowerCase()
  const want = terms(f.match)
  if (want.length > 0 && !want.some((t) => title.includes(t))) return false
  const not = terms(f.exclude)
  if (not.length > 0 && not.some((t) => title.includes(t))) return false

  if (e.source === 'task') {
    const want2 = f.taskStatus ?? 'open'
    if (want2 === 'open' && e.status === 'done') return false
    if (want2 === 'done' && e.status !== 'done') return false
    const who = terms(f.assignees)
    if (who.length > 0) {
      const a = (e.assignee ?? '').toLowerCase()
      if (!a || !who.some((t) => a.includes(t))) return false
    }
  }

  if (e.source === 'external' && (f.calendarIds?.length ?? 0) > 0) {
    if (!e.calendarId || !f.calendarIds!.includes(e.calendarId)) return false
  }

  return true
}

export function applyCalendarFilter(
  entries: readonly CalendarEntry[],
  f: CalendarFilter
): CalendarEntry[] {
  return entries.filter((e) => matchesFilter(e, f))
}

/** True when nothing would be excluded — i.e. this is the whole calendar. */
export function filterIsEmpty(f: CalendarFilter): boolean {
  return (
    (f.scope ?? 'desk') === 'all' &&
    terms(f.match).length === 0 &&
    terms(f.exclude).length === 0 &&
    terms(f.assignees).length === 0 &&
    (f.calendarIds?.length ?? 0) === 0 &&
    (f.taskStatus ?? 'open') === 'all' &&
    sourceEnabled(f, 'task') &&
    sourceEnabled(f, 'block') &&
    sourceEnabled(f, 'external')
  )
}

/**
 * A readable sentence for what is being shown.
 *
 * The same reasoning as the inbox: a filtered view that does not state its own
 * rule is one you cannot trust, because an empty day and a mistyped rule look
 * identical.
 */
export function describeCalendarFilter(f: CalendarFilter): string {
  if (filterIsEmpty(f)) return 'Everything'
  const parts: string[] = []
  parts.push((f.scope ?? 'desk') === 'desk' ? 'This desk' : 'Everywhere')

  const on: string[] = []
  if (sourceEnabled(f, 'task')) on.push('due dates')
  if (sourceEnabled(f, 'block')) on.push('time blocks')
  if (sourceEnabled(f, 'external')) on.push('subscribed')
  if (on.length < 3) parts.push(on.length ? on.join(' + ') : 'nothing')

  const want = terms(f.match)
  if (want.length) parts.push(`about ${want.join(' or ')}`)
  const not = terms(f.exclude)
  if (not.length) parts.push(`not ${not.join(' or ')}`)
  const who = terms(f.assignees)
  if (who.length) parts.push(`for ${who.join(' or ')}`)
  const status = f.taskStatus ?? 'open'
  if (status !== 'all') parts.push(status === 'done' ? 'done only' : 'open only')
  return parts.join(' · ')
}
