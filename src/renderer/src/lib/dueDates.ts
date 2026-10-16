// Due dates in CALENDAR days, local time — the one place this is worked out.
//
// Help audit (4.3.26 screenshot pass): "a task due tomorrow shows Due today, one
// due in two days shows Due tomorrow, and same-day tasks show Past due". Every
// label was computed as (due − now) / 24h, which answers "how many 24-hour
// periods away" rather than "which day". At 6 pm, a task due tomorrow at 5 pm is
// 23 hours away — under one period, so "today". A desk due today, stored as
// local midnight, is already behind "now" by breakfast, so "past due". And a
// 24-hour divisor is wrong twice a year anyway, because a DST day is 23 or 25
// hours long.
//
// The fix is to compare the local calendar day of the due date with the local
// calendar day of now, and to treat a due date that carries no real time of day
// as lasting the whole day.
//
// "No real time of day" is not stored explicitly, so it is recognised by the
// conventions the app's own date pickers write:
//   - local 00:00          TaskDetail / PlexiProjects / CalendarEntryModal
//   - local 17:00          AttentionItemEditor and the Calendar month drop
//                          (a date with no time is given "end of working day")
//   - local 23:59          NewNodeDialog ("so the date doesn't pass at midnight")
//   - "YYYY-MM-DD"         a bare date string
//   - "…T00:00:00(.000)Z"  a bare date turned into ISO via new Date('YYYY-MM-DD')
// A due date at any other time is a real deadline: it is past due the moment it
// passes, but it is still labelled by its calendar day.

const DAY_MS = 86_400_000

/** Local midnight at the start of the calendar day containing `ms`. */
export function localDayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Whole calendar days from `fromMs` to `toMs` in local time: 0 = same day,
 * 1 = the next day, −1 = the day before. Math.round absorbs the 23- or 25-hour
 * day either side of a DST change.
 */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  return Math.round((localDayStart(toMs) - localDayStart(fromMs)) / DAY_MS)
}

export interface DueInstant {
  ms: number
  /** True when the date carries no real time of day (see the header). */
  allDay: boolean
}

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const UTC_MIDNIGHT = /^(\d{4})-(\d{2})-(\d{2})T00:00(?::00(?:\.0+)?)?Z$/

function isAllDayClock(ms: number): boolean {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes()
  const s = d.getSeconds()
  if (h === 0 && m === 0 && s === 0) return true
  if (h === 17 && m === 0 && s === 0) return true
  if (h === 23 && m === 59) return true
  return false
}

/** Read a stored due value (ms number or ISO / bare-date string). */
export function parseDue(due: string | number | null | undefined): DueInstant | null {
  if (due === null || due === undefined || due === '') return null
  if (typeof due === 'number') {
    if (!Number.isFinite(due)) return null
    return { ms: due, allDay: isAllDayClock(due) }
  }
  const bare = BARE_DATE.exec(due) ?? UTC_MIDNIGHT.exec(due)
  if (bare) {
    // The DATE the person picked, as that date here — not UTC midnight, which
    // lands on the previous day anywhere west of Greenwich.
    const ms = new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])).getTime()
    return Number.isNaN(ms) ? null : { ms, allDay: true }
  }
  const ms = Date.parse(due)
  if (Number.isNaN(ms)) return null
  return { ms, allDay: isAllDayClock(ms) }
}

export interface DueStanding {
  /** Calendar days from today to the due day (negative = an earlier day). */
  days: number
  /** Past due: an all-day date once its day has ended; a timed one once passed. */
  overdue: boolean
  ms: number
  allDay: boolean
}

export function dueStanding(due: string | number | null | undefined, nowMs: number): DueStanding | null {
  const d = parseDue(due)
  if (!d) return null
  const days = calendarDaysBetween(nowMs, d.ms)
  const overdue = d.allDay ? days < 0 : d.ms < nowMs
  return { days, overdue, ms: d.ms, allDay: d.allDay }
}

/** "Past due" / "Due today" / "Due tomorrow" / "Due in N days". */
export function dueLabel(s: DueStanding): string {
  if (s.overdue) return 'Past due'
  if (s.days <= 0) return 'Due today'
  if (s.days === 1) return 'Due tomorrow'
  return `Due in ${s.days} days`
}
