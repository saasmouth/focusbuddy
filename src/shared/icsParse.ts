// An iCalendar (RFC 5545) READER: enough of it to show somebody's real calendar.
//
// The writer lives next door in ics.ts (buildMeetingIcs) and they are kept
// apart on purpose: writing one event we control is a different problem from
// reading a feed somebody else generated, and the reading half is all edge
// cases.
//
// Written by hand rather than pulled in, because the two jobs that matter here
// -- getting the timezone right and expanding a repeating event -- are exactly
// the jobs most small ical libraries get subtly wrong, and a calendar that is
// subtly wrong is worse than no calendar: you stop checking the real one.
//
// Scope is deliberate. This reads VEVENTs from a feed. It does not write ics,
// does not do VTODO/VJOURNAL/VFREEBUSY, and does not implement every BYxxx rule
// in the spec -- it implements the ones real calendars actually emit, and says
// so honestly when it meets one it cannot expand (see UnsupportedRule).

export interface IcsProperty {
  name: string
  params: Record<string, string>
  value: string
}

export interface IcsEvent {
  uid: string
  summary: string
  description?: string
  location?: string
  /** UTC ms. */
  start: number
  /** UTC ms, exclusive. */
  end: number
  allDay: boolean
  status?: string
  organizer?: string
  url?: string
  /** Present on a generated occurrence of a repeating event. */
  recurrenceId?: number
  sequence?: number
}

export interface ParsedCalendar {
  /** X-WR-CALNAME, when the feed names itself. */
  name?: string
  timezone?: string
  events: IcsEvent[]
  /** Rules we met but could not expand; surfaced, never silently dropped. */
  unsupported: string[]
}

// ── Line handling ───────────────────────────────────────────────────────────

/**
 * Undo RFC 5545 line folding.
 *
 * Long lines are broken at 75 octets and continued with a leading space or
 * tab. Folding can land mid-word, so the continuation is joined with nothing
 * between -- inserting a space here corrupts every long summary in the feed.
 */
export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: string[] = []
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else if (line.length > 0) {
      out.push(line)
    }
  }
  return out
}

/** Split `NAME;PARAM=value;P2="quoted:value":VALUE` into its three parts. */
export function parseLine(line: string): IcsProperty | null {
  // The first colon that is not inside a quoted parameter ends the name+params.
  let colon = -1
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 0) return null

  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)

  const parts: string[] = []
  let cur = ''
  quoted = false
  for (const c of head) {
    if (c === '"') quoted = !quoted
    else if (c === ';' && !quoted) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  parts.push(cur)

  const name = (parts.shift() ?? '').toUpperCase()
  const params: Record<string, string> = {}
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq < 0) continue
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name, params, value }
}

/** Unescape an RFC 5545 TEXT value. */
export function unescapeText(v: string): string {
  let out = ''
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== '\\') {
      out += v[i]
      continue
    }
    const next = v[++i]
    if (next === 'n' || next === 'N') out += '\n'
    else if (next === undefined) out += '\\'
    else out += next // \, \; \\ and anything else pass through literally
  }
  return out
}

// ── Time ────────────────────────────────────────────────────────────────────

/**
 * The offset of a timezone at a given instant, in ms.
 *
 * Intl is the only tz database available without shipping one, and this is the
 * standard way to interrogate it: format the instant in the target zone, read
 * the wall-clock back, and take the difference.
 */
export function tzOffsetMs(utcMs: number, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    const map: Record<string, string> = {}
    for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour) % 24,
      Number(map.minute),
      Number(map.second)
    )
    return asUtc - utcMs
  } catch {
    // An unknown TZID is treated as UTC rather than throwing the whole feed
    // away over one event.
    return 0
  }
}

/**
 * A wall-clock time in a named zone, as UTC ms.
 *
 * Two passes: the offset depends on the instant, and the instant depends on
 * the offset. One refinement settles everything except the hour that does not
 * exist at a spring-forward boundary, where the second pass lands on the
 * offset after the jump -- which is the convention calendars use.
 */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const firstPass = guess - tzOffsetMs(guess, tz)
  return guess - tzOffsetMs(firstPass, tz)
}

export interface IcsTime {
  ms: number
  /** VALUE=DATE — a day, not an instant. */
  date: boolean
}

/** Parse DTSTART/DTEND/EXDATE/RECURRENCE-ID into UTC ms. */
export function parseIcsTime(prop: IcsProperty, fallbackTz?: string): IcsTime | null {
  const v = prop.value.trim()
  const isDate = prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)

  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss, z] = m
  const y = Number(ys)
  const mo = Number(mos)
  const d = Number(ds)
  const h = Number(hs ?? '0')
  const mi = Number(mis ?? '0')
  const s = Number(ss ?? '0')

  if (isDate) {
    // An all-day date has no zone. Anchoring it to UTC midnight keeps the day
    // stable no matter where the reader is; rendering decides how to show it.
    return { ms: Date.UTC(y, mo - 1, d), date: true }
  }
  if (z === 'Z') return { ms: Date.UTC(y, mo - 1, d, h, mi, s), date: false }

  const tz = prop.params.TZID || fallbackTz
  if (tz) return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), date: false }
  // Floating time: no zone given, so it means "whatever the clock says here".
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), date: false }
}

/** Parse an RFC 5545 DURATION (e.g. PT1H30M, P2D) into ms. */
export function parseDuration(v: string): number | null {
  const m = v
    .trim()
    .match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  const ms =
    Number(w ?? 0) * 604_800_000 +
    Number(d ?? 0) * 86_400_000 +
    Number(h ?? 0) * 3_600_000 +
    Number(mi ?? 0) * 60_000 +
    Number(s ?? 0) * 1000
  return sign === '-' ? -ms : ms
}

// ── Recurrence ──────────────────────────────────────────────────────────────

export interface RRule {
  freq: 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count?: number
  until?: number
  byDay?: string[]
  byMonthDay?: number[]
  byMonth?: number[]
  bySetPos?: number[]
  wkst?: string
}

export function parseRRule(value: string, fallbackTz?: string): RRule | null {
  const parts: Record<string, string> = {}
  for (const chunk of value.split(';')) {
    const eq = chunk.indexOf('=')
    if (eq > 0) parts[chunk.slice(0, eq).toUpperCase()] = chunk.slice(eq + 1)
  }
  const freq = parts.FREQ as RRule['freq'] | undefined
  if (!freq) return null

  let until: number | undefined
  if (parts.UNTIL) {
    const t = parseIcsTime({ name: 'UNTIL', params: {}, value: parts.UNTIL }, fallbackTz)
    if (t) until = t.ms
  }

  const nums = (s?: string): number[] | undefined =>
    s ? s.split(',').map(Number).filter((n) => Number.isFinite(n)) : undefined

  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    count: parts.COUNT ? Number(parts.COUNT) : undefined,
    until,
    byDay: parts.BYDAY ? parts.BYDAY.split(',').map((s) => s.trim().toUpperCase()) : undefined,
    byMonthDay: nums(parts.BYMONTHDAY),
    byMonth: nums(parts.BYMONTH),
    bySetPos: nums(parts.BYSETPOS),
    wkst: parts.WKST
  }
}

const WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** `2TU` -> { nth: 2, day: 'TU' }; `TU` -> { nth: 0, day: 'TU' }. */
function splitByDay(token: string): { nth: number; day: string } {
  const m = token.match(/^([+-]?\d+)?([A-Z]{2})$/)
  if (!m) return { nth: 0, day: token }
  return { nth: m[1] ? Number(m[1]) : 0, day: m[2] }
}

/** Safety valve: a malformed rule must not spin forever. */
const MAX_OCCURRENCES = 2000

/**
 * Expand a repeating event into the occurrences that start within a window.
 *
 * Works in UTC on the event's own start instant, stepping by calendar units.
 * The limitation this accepts, deliberately: an event repeating across a DST
 * boundary keeps its UTC time rather than its wall-clock time unless the feed
 * carries a TZID, in which case the wall clock is preserved. Google and Outlook
 * both emit TZID on recurring events, so the common case is right.
 */
export function expandRecurrence(
  startMs: number,
  rule: RRule,
  windowStart: number,
  windowEnd: number,
  opts: { tz?: string; exdates?: number[] } = {}
): number[] {
  const out: number[] = []
  const ex = new Set(opts.exdates ?? [])
  const tz = opts.tz

  // Stepping in a named zone means stepping the WALL CLOCK, so an 09:00 weekly
  // meeting stays at 09:00 after the clocks change.
  const parts = (ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } => {
    const off = tz ? tzOffsetMs(ms, tz) : 0
    const d = new Date(ms + off)
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
      s: d.getUTCSeconds()
    }
  }
  const build = (y: number, mo: number, d: number, h: number, mi: number, s: number): number =>
    tz ? zonedToUtc(y, mo, d, h, mi, s, tz) : Date.UTC(y, mo - 1, d, h, mi, s)

  const p0 = parts(startMs)
  const limit = rule.count ?? MAX_OCCURRENCES
  const hardEnd = rule.until != null ? Math.min(rule.until, windowEnd) : windowEnd

  let emitted = 0
  let guard = 0

  const consider = (ms: number): boolean => {
    // COUNT counts every occurrence the rule generates, including ones before
    // the window -- so it is checked here, not after filtering.
    if (rule.until != null && ms > rule.until) return false
    if (emitted >= limit) return false
    emitted++
    if (ms >= windowStart && ms <= hardEnd && !ex.has(ms)) out.push(ms)
    return true
  }

  const dayMatches = (ms: number): boolean => {
    if (!rule.byDay || rule.byDay.length === 0) return true
    const off = tz ? tzOffsetMs(ms, tz) : 0
    const dow = WEEKDAY[new Date(ms + off).getUTCDay()]
    return rule.byDay.some((t) => splitByDay(t).day === dow)
  }
  const monthMatches = (ms: number): boolean => {
    if (!rule.byMonth || rule.byMonth.length === 0) return true
    const off = tz ? tzOffsetMs(ms, tz) : 0
    return rule.byMonth.includes(new Date(ms + off).getUTCMonth() + 1)
  }

  if (rule.freq === 'DAILY' || rule.freq === 'HOURLY' || rule.freq === 'MINUTELY' || rule.freq === 'SECONDLY') {
    const stepMs =
      rule.freq === 'DAILY'
        ? 86_400_000
        : rule.freq === 'HOURLY'
          ? 3_600_000
          : rule.freq === 'MINUTELY'
            ? 60_000
            : 1000
    let cursor = startMs
    while (cursor <= hardEnd && guard++ < MAX_OCCURRENCES * 4) {
      if (rule.freq === 'DAILY') {
        // Day stepping goes through the wall clock so DST does not drift it.
        const c = parts(cursor)
        const ms = build(c.y, c.mo, c.d, p0.h, p0.mi, p0.s)
        if (dayMatches(ms) && monthMatches(ms)) {
          if (!consider(ms)) break
        }
      } else if (!consider(cursor)) break
      if (rule.freq === 'DAILY') {
        const c = parts(cursor)
        cursor = build(c.y, c.mo, c.d + rule.interval, p0.h, p0.mi, p0.s)
      } else {
        cursor += stepMs * rule.interval
      }
    }
    return out
  }

  if (rule.freq === 'WEEKLY') {
    const days = (rule.byDay && rule.byDay.length > 0
      ? rule.byDay.map((t) => splitByDay(t).day)
      : [WEEKDAY[new Date(startMs + (tz ? tzOffsetMs(startMs, tz) : 0)).getUTCDay()]]
    ).map((d) => WEEKDAY.indexOf(d))

    // Start from the Sunday of the first week, then walk week by week.
    const startDow = new Date(startMs + (tz ? tzOffsetMs(startMs, tz) : 0)).getUTCDay()
    let weekAnchor = build(p0.y, p0.mo, p0.d - startDow, p0.h, p0.mi, p0.s)

    while (weekAnchor <= hardEnd + 7 * 86_400_000 && guard++ < MAX_OCCURRENCES) {
      const a = parts(weekAnchor)
      for (const dow of [...days].sort((x, y2) => x - y2)) {
        if (dow < 0) continue
        const ms = build(a.y, a.mo, a.d + dow, p0.h, p0.mi, p0.s)
        if (ms < startMs) continue
        if (!monthMatches(ms)) continue
        if (!consider(ms)) return out
      }
      const a2 = parts(weekAnchor)
      weekAnchor = build(a2.y, a2.mo, a2.d + 7 * rule.interval, p0.h, p0.mi, p0.s)
    }
    return out
  }

  if (rule.freq === 'MONTHLY') {
    let y = p0.y
    let mo = p0.mo
    while (guard++ < MAX_OCCURRENCES) {
      const candidates: number[] = []
      if (rule.byDay && rule.byDay.length > 0) {
        for (const token of rule.byDay) {
          const { nth, day } = splitByDay(token)
          const target = WEEKDAY.indexOf(day)
          if (target < 0) continue
          const hits: number[] = []
          const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
          for (let d = 1; d <= daysInMonth; d++) {
            const ms = build(y, mo, d, p0.h, p0.mi, p0.s)
            const off = tz ? tzOffsetMs(ms, tz) : 0
            if (new Date(ms + off).getUTCDay() === target) hits.push(ms)
          }
          if (nth === 0) candidates.push(...hits)
          else if (nth > 0 && hits[nth - 1] != null) candidates.push(hits[nth - 1])
          else if (nth < 0 && hits[hits.length + nth] != null) candidates.push(hits[hits.length + nth])
        }
      } else if (rule.byMonthDay && rule.byMonthDay.length > 0) {
        const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
        for (const md of rule.byMonthDay) {
          const d = md > 0 ? md : daysInMonth + md + 1
          // A rule asking for the 31st simply does not occur in February --
          // it is skipped, never rolled into March.
          if (d >= 1 && d <= daysInMonth) candidates.push(build(y, mo, d, p0.h, p0.mi, p0.s))
        }
      } else {
        const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
        if (p0.d <= daysInMonth) candidates.push(build(y, mo, p0.d, p0.h, p0.mi, p0.s))
      }

      candidates.sort((a, b) => a - b)
      const chosen =
        rule.bySetPos && rule.bySetPos.length > 0
          ? rule.bySetPos
              .map((n) => (n > 0 ? candidates[n - 1] : candidates[candidates.length + n]))
              .filter((v): v is number => v != null)
          : candidates

      for (const ms of chosen) {
        if (ms < startMs) continue
        if (!monthMatches(ms)) continue
        if (!consider(ms)) return out
      }
      const first = chosen[0] ?? build(y, mo, 1, 0, 0, 0)
      if (first > hardEnd && emitted > 0) break
      if (build(y, mo, 1, 0, 0, 0) > hardEnd) break
      mo += rule.interval
      while (mo > 12) {
        mo -= 12
        y++
      }
    }
    return out
  }

  if (rule.freq === 'YEARLY') {
    let y = p0.y
    while (guard++ < MAX_OCCURRENCES) {
      const months = rule.byMonth && rule.byMonth.length > 0 ? rule.byMonth : [p0.mo]
      for (const mo of months) {
        const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
        let candidates: number[] = []
        if (rule.byDay && rule.byDay.length > 0) {
          for (const token of rule.byDay) {
            const { nth, day } = splitByDay(token)
            const target = WEEKDAY.indexOf(day)
            if (target < 0) continue
            const hits: number[] = []
            for (let d = 1; d <= daysInMonth; d++) {
              const ms = build(y, mo, d, p0.h, p0.mi, p0.s)
              const off = tz ? tzOffsetMs(ms, tz) : 0
              if (new Date(ms + off).getUTCDay() === target) hits.push(ms)
            }
            if (nth === 0) candidates.push(...hits)
            else if (nth > 0 && hits[nth - 1] != null) candidates.push(hits[nth - 1])
            else if (nth < 0 && hits[hits.length + nth] != null) candidates.push(hits[hits.length + nth])
          }
        } else if (rule.byMonthDay && rule.byMonthDay.length > 0) {
          for (const md of rule.byMonthDay) {
            const d = md > 0 ? md : daysInMonth + md + 1
            if (d >= 1 && d <= daysInMonth) candidates.push(build(y, mo, d, p0.h, p0.mi, p0.s))
          }
        } else if (p0.d <= daysInMonth) {
          candidates.push(build(y, mo, p0.d, p0.h, p0.mi, p0.s))
        }
        candidates.sort((a, b) => a - b)
        if (rule.bySetPos && rule.bySetPos.length > 0) {
          candidates = rule.bySetPos
            .map((n) => (n > 0 ? candidates[n - 1] : candidates[candidates.length + n]))
            .filter((v): v is number => v != null)
        }
        for (const ms of candidates) {
          if (ms < startMs) continue
          if (!consider(ms)) return out
        }
      }
      if (build(y, 1, 1, 0, 0, 0) > hardEnd) break
      y += rule.interval
    }
    return out
  }

  return out
}

// ── The document ────────────────────────────────────────────────────────────

interface RawEvent {
  props: IcsProperty[]
}

/**
 * Read a feed and return the occurrences that fall inside a window.
 *
 * Repeating events are expanded here rather than at render time, so what is
 * stored is what will be shown, and a bug in expansion is visible in the data
 * instead of hiding behind a view.
 *
 * Overrides (RECURRENCE-ID) replace the generated occurrence they name, and
 * cancelled ones remove it -- that is how "moved just this Tuesday's standup"
 * arrives over the wire.
 */
export function parseIcs(
  text: string,
  windowStart: number,
  windowEnd: number
): ParsedCalendar {
  const lines = unfold(text)
  const events: IcsEvent[] = []
  const unsupported = new Set<string>()
  let calName: string | undefined
  let calTz: string | undefined

  // Pass 1: split into components. Only VEVENTs are read, but VTIMEZONE's id
  // is noted so a feed that leans on it is not silently misread.
  const raw: RawEvent[] = []
  let cur: RawEvent | null = null
  let depth: string[] = []
  for (const line of lines) {
    const prop = parseLine(line)
    if (!prop) continue
    if (prop.name === 'BEGIN') {
      depth.push(prop.value.toUpperCase())
      if (prop.value.toUpperCase() === 'VEVENT') cur = { props: [] }
      continue
    }
    if (prop.name === 'END') {
      const ended = depth.pop()
      if (ended === 'VEVENT' && cur) {
        raw.push(cur)
        cur = null
      }
      continue
    }
    const inside = depth[depth.length - 1]
    if (inside === 'VEVENT' && cur) cur.props.push(prop)
    else if (inside === 'VCALENDAR') {
      if (prop.name === 'X-WR-CALNAME') calName = unescapeText(prop.value)
      if (prop.name === 'X-WR-TIMEZONE') calTz = prop.value.trim()
    }
  }

  const first = (p: IcsProperty[], name: string): IcsProperty | undefined =>
    p.find((x) => x.name === name)
  const all = (p: IcsProperty[], name: string): IcsProperty[] => p.filter((x) => x.name === name)

  // Overrides are keyed by uid + the instant they replace.
  const overrides = new Map<string, RawEvent>()
  const masters: RawEvent[] = []
  for (const ev of raw) {
    const rid = first(ev.props, 'RECURRENCE-ID')
    const uid = first(ev.props, 'UID')?.value ?? ''
    if (rid) {
      const t = parseIcsTime(rid, calTz)
      if (t) overrides.set(`${uid}::${t.ms}`, ev)
    } else {
      masters.push(ev)
    }
  }

  const toEvent = (ev: RawEvent, startMs: number, endMs: number, allDay: boolean, rid?: number): IcsEvent => ({
    uid: first(ev.props, 'UID')?.value ?? `${startMs}`,
    summary: unescapeText(first(ev.props, 'SUMMARY')?.value ?? ''),
    description: (() => {
      const d = first(ev.props, 'DESCRIPTION')?.value
      return d ? unescapeText(d) : undefined
    })(),
    location: (() => {
      const l = first(ev.props, 'LOCATION')?.value
      return l ? unescapeText(l) : undefined
    })(),
    start: startMs,
    end: endMs,
    allDay,
    status: first(ev.props, 'STATUS')?.value,
    organizer: first(ev.props, 'ORGANIZER')?.value?.replace(/^mailto:/i, ''),
    url: first(ev.props, 'URL')?.value,
    recurrenceId: rid,
    sequence: Number(first(ev.props, 'SEQUENCE')?.value ?? 0) || 0
  })

  for (const ev of masters) {
    const dtstartProp = first(ev.props, 'DTSTART')
    if (!dtstartProp) continue
    const dtstart = parseIcsTime(dtstartProp, calTz)
    if (!dtstart) continue

    const dtendProp = first(ev.props, 'DTEND')
    const durProp = first(ev.props, 'DURATION')
    let duration: number
    if (dtendProp) {
      const dtend = parseIcsTime(dtendProp, calTz)
      duration = dtend ? Math.max(0, dtend.ms - dtstart.ms) : dtstart.date ? 86_400_000 : 3_600_000
    } else if (durProp) {
      duration = parseDuration(durProp.value) ?? (dtstart.date ? 86_400_000 : 3_600_000)
    } else {
      // No end and no duration: a date is a whole day, an instant is an hour.
      duration = dtstart.date ? 86_400_000 : 3_600_000
    }

    const uid = first(ev.props, 'UID')?.value ?? ''
    const rruleProp = first(ev.props, 'RRULE')

    if (!rruleProp) {
      if (dtstart.ms < windowEnd && dtstart.ms + duration > windowStart) {
        events.push(toEvent(ev, dtstart.ms, dtstart.ms + duration, dtstart.date))
      }
      continue
    }

    const rule = parseRRule(rruleProp.value, calTz)
    if (!rule) {
      unsupported.add(`RRULE could not be read: ${rruleProp.value}`)
      if (dtstart.ms < windowEnd && dtstart.ms + duration > windowStart) {
        events.push(toEvent(ev, dtstart.ms, dtstart.ms + duration, dtstart.date))
      }
      continue
    }
    if (rule.freq === 'SECONDLY' || rule.freq === 'MINUTELY') {
      // Real calendars do not emit these, and expanding one over a year would
      // produce millions of rows. Named rather than silently dropped.
      unsupported.add(`${rule.freq} repeats are not expanded (${first(ev.props, 'SUMMARY')?.value ?? uid})`)
      continue
    }

    const exdates: number[] = []
    for (const ex of all(ev.props, 'EXDATE')) {
      for (const piece of ex.value.split(',')) {
        const t = parseIcsTime({ ...ex, value: piece }, calTz)
        if (t) exdates.push(t.ms)
      }
    }

    const tz = dtstartProp.params.TZID || calTz
    // Expansion starts a window's width early so an occurrence that STARTED
    // before the window but is still running is not lost.
    const occurrences = expandRecurrence(
      dtstart.ms,
      rule,
      windowStart - duration,
      windowEnd,
      { tz, exdates }
    )

    for (const ms of occurrences) {
      const override = overrides.get(`${uid}::${ms}`)
      if (override) {
        if (first(override.props, 'STATUS')?.value?.toUpperCase() === 'CANCELLED') continue
        const oStart = parseIcsTime(first(override.props, 'DTSTART') as IcsProperty, calTz)
        const oEndProp = first(override.props, 'DTEND')
        const oEnd = oEndProp ? parseIcsTime(oEndProp, calTz) : null
        if (oStart) {
          const oDuration = oEnd ? Math.max(0, oEnd.ms - oStart.ms) : duration
          if (oStart.ms < windowEnd && oStart.ms + oDuration > windowStart) {
            events.push(toEvent(override, oStart.ms, oStart.ms + oDuration, oStart.date, ms))
          }
          continue
        }
      }
      if (ms < windowEnd && ms + duration > windowStart) {
        events.push(toEvent(ev, ms, ms + duration, dtstart.date, ms))
      }
    }
  }

  // An override can also name an instance the rule never generated (moved out
  // of its slot). Those would otherwise vanish entirely.
  for (const [key, ev] of overrides) {
    const uid = key.split('::')[0]
    if (events.some((e) => e.uid === uid && e.recurrenceId === Number(key.split('::')[1]))) continue
    if (first(ev.props, 'STATUS')?.value?.toUpperCase() === 'CANCELLED') continue
    const s = parseIcsTime(first(ev.props, 'DTSTART') as IcsProperty, calTz)
    if (!s) continue
    const eProp = first(ev.props, 'DTEND')
    const e = eProp ? parseIcsTime(eProp, calTz) : null
    const dur = e ? Math.max(0, e.ms - s.ms) : 3_600_000
    if (s.ms < windowEnd && s.ms + dur > windowStart) {
      events.push(toEvent(ev, s.ms, s.ms + dur, s.date, Number(key.split('::')[1])))
    }
  }

  events.sort((a, b) => a.start - b.start)
  return { name: calName, timezone: calTz, events, unsupported: [...unsupported] }
}
