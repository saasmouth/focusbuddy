import { describe, it, expect } from 'vitest'
import {
  unfold,
  parseLine,
  unescapeText,
  tzOffsetMs,
  zonedToUtc,
  parseIcsTime,
  parseDuration,
  parseRRule,
  expandRecurrence,
  parseIcs
} from '../../src/shared/icsParse'

const YEAR = (y: number): [number, number] => [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)]
const iso = (ms: number): string => new Date(ms).toISOString()

describe('unfold', () => {
  it('joins continuation lines with nothing between them', () => {
    // Folding can land mid-word; inserting a space corrupts the value.
    expect(unfold('SUMMARY:Quarterly plan\r\n ning review')).toEqual([
      'SUMMARY:Quarterly planning review'
    ])
  })
  it('accepts tab continuations and bare LF feeds', () => {
    expect(unfold('SUMMARY:one\n\ttwo')).toEqual(['SUMMARY:onetwo'])
  })
  it('drops blank lines without swallowing the next one', () => {
    expect(unfold('A:1\n\nB:2')).toEqual(['A:1', 'B:2'])
  })
})

describe('parseLine', () => {
  it('reads name, params and value', () => {
    const p = parseLine('DTSTART;TZID=Australia/Sydney:20260915T100000')
    expect(p).toEqual({
      name: 'DTSTART',
      params: { TZID: 'Australia/Sydney' },
      value: '20260915T100000'
    })
  })
  it('does not split on a colon inside a quoted parameter', () => {
    const p = parseLine('ATTENDEE;CN="Smith:Jones";ROLE=REQ:mailto:a@b.com')
    expect(p?.name).toBe('ATTENDEE')
    expect(p?.params.CN).toBe('Smith:Jones')
    expect(p?.value).toBe('mailto:a@b.com')
  })
  it('returns null for a line with no colon at all', () => {
    expect(parseLine('GARBAGE')).toBeNull()
  })
})

describe('unescapeText', () => {
  it('handles the four escapes the spec defines', () => {
    expect(unescapeText('a\\nb\\,c\;d\\\\e')).toBe('a\nb,c;d\\e')
  })
  it('treats a trailing backslash literally instead of eating it', () => {
    expect(unescapeText('path\\')).toBe('path\\')
  })
})

describe('timezone handling', () => {
  it('knows Sydney is +10 in winter and +11 in summer', () => {
    // July = AEST (+10), January = AEDT (+11). A library that returns one
    // number for both is the classic "my meetings are an hour out" bug.
    expect(tzOffsetMs(Date.UTC(2026, 6, 1), 'Australia/Sydney')).toBe(10 * 3_600_000)
    expect(tzOffsetMs(Date.UTC(2026, 0, 1), 'Australia/Sydney')).toBe(11 * 3_600_000)
  })
  it('converts a wall clock in a zone to the right instant', () => {
    // 09:00 Sydney on 15 Sep 2026 is 23:00 UTC on the 14th (+10).
    expect(iso(zonedToUtc(2026, 9, 15, 9, 0, 0, 'Australia/Sydney'))).toBe('2026-09-14T23:00:00.000Z')
  })
  it('handles London across its own DST boundary', () => {
    expect(iso(zonedToUtc(2026, 1, 15, 12, 0, 0, 'Europe/London'))).toBe('2026-01-15T12:00:00.000Z')
    expect(iso(zonedToUtc(2026, 7, 15, 12, 0, 0, 'Europe/London'))).toBe('2026-07-15T11:00:00.000Z')
  })
  it('falls back to UTC for an unknown zone rather than throwing the feed away', () => {
    expect(tzOffsetMs(Date.UTC(2026, 6, 1), 'Mars/Olympus')).toBe(0)
  })
})

describe('parseIcsTime', () => {
  const P = (value: string, params: Record<string, string> = {}) =>
    parseIcsTime({ name: 'DTSTART', params, value })

  it('reads a UTC instant', () => {
    expect(iso(P('20260915T100000Z')!.ms)).toBe('2026-09-15T10:00:00.000Z')
  })
  it('reads a zoned instant', () => {
    expect(iso(P('20260915T100000', { TZID: 'Australia/Sydney' })!.ms)).toBe(
      '2026-09-15T00:00:00.000Z'
    )
  })
  it('reads an all-day date and marks it as one', () => {
    const t = P('20260915', { VALUE: 'DATE' })!
    expect(t.date).toBe(true)
    expect(iso(t.ms)).toBe('2026-09-15T00:00:00.000Z')
  })
  it('infers a date from an 8-digit value with no VALUE param', () => {
    expect(P('20260915')!.date).toBe(true)
  })
  it('returns null for something that is not a time', () => {
    expect(P('not-a-date')).toBeNull()
  })
})

describe('parseDuration', () => {
  it('reads hours and minutes', () => expect(parseDuration('PT1H30M')).toBe(5_400_000))
  it('reads days and weeks', () => {
    expect(parseDuration('P2D')).toBe(172_800_000)
    expect(parseDuration('P1W')).toBe(604_800_000)
  })
  it('reads a negative duration', () => expect(parseDuration('-PT15M')).toBe(-900_000))
  it('returns null for nonsense', () => expect(parseDuration('PTBANANA')).toBeNull())
})

describe('expandRecurrence', () => {
  const start = Date.UTC(2026, 8, 15, 9, 0, 0) // Tue 15 Sep 2026, 09:00 UTC

  it('expands a simple daily rule', () => {
    const r = parseRRule('FREQ=DAILY;COUNT=5')!
    const out = expandRecurrence(start, r, start, start + 30 * 86_400_000)
    expect(out.length).toBe(5)
    expect(iso(out[0])).toBe('2026-09-15T09:00:00.000Z')
    expect(iso(out[4])).toBe('2026-09-19T09:00:00.000Z')
  })

  it('honours INTERVAL', () => {
    const r = parseRRule('FREQ=DAILY;INTERVAL=3;COUNT=3')!
    const out = expandRecurrence(start, r, start, start + 30 * 86_400_000)
    expect(out.map(iso)).toEqual([
      '2026-09-15T09:00:00.000Z',
      '2026-09-18T09:00:00.000Z',
      '2026-09-21T09:00:00.000Z'
    ])
  })

  it('expands a weekly rule on named days', () => {
    const r = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6')!
    const out = expandRecurrence(start, r, start, start + 60 * 86_400_000)
    // Starting Tue 15th: Wed 16, Fri 18, Mon 21, Wed 23, Fri 25, Mon 28.
    expect(out.map(iso)).toEqual([
      '2026-09-16T09:00:00.000Z',
      '2026-09-18T09:00:00.000Z',
      '2026-09-21T09:00:00.000Z',
      '2026-09-23T09:00:00.000Z',
      '2026-09-25T09:00:00.000Z',
      '2026-09-28T09:00:00.000Z'
    ])
  })

  it('stops at UNTIL', () => {
    const r = parseRRule('FREQ=DAILY;UNTIL=20260918T090000Z')!
    const out = expandRecurrence(start, r, start, start + 60 * 86_400_000)
    expect(out.length).toBe(4)
    expect(iso(out[out.length - 1])).toBe('2026-09-18T09:00:00.000Z')
  })

  it('skips EXDATEs', () => {
    const r = parseRRule('FREQ=DAILY;COUNT=5')!
    const out = expandRecurrence(start, r, start, start + 30 * 86_400_000, {
      exdates: [Date.UTC(2026, 8, 17, 9, 0, 0)]
    })
    expect(out.length).toBe(4)
    expect(out.map(iso)).not.toContain('2026-09-17T09:00:00.000Z')
  })

  it('counts occurrences before the window against COUNT', () => {
    // COUNT is a property of the rule, not of the view. A window that starts
    // late must not resurrect occurrences the rule already spent.
    const r = parseRRule('FREQ=DAILY;COUNT=3')!
    const late = start + 10 * 86_400_000
    expect(expandRecurrence(start, r, late, late + 30 * 86_400_000)).toEqual([])
  })

  it('keeps the wall clock across a DST change when a zone is given', () => {
    // Sydney springs forward on 4 Oct 2026. A 09:00 daily meeting stays at
    // 09:00 local, which means its UTC time shifts by an hour.
    const s = zonedToUtc(2026, 10, 1, 9, 0, 0, 'Australia/Sydney')
    const r = parseRRule('FREQ=DAILY;COUNT=8')!
    const out = expandRecurrence(s, r, s, s + 20 * 86_400_000, { tz: 'Australia/Sydney' })
    const local = out.map((ms) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Australia/Sydney',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(ms))
    )
    expect(new Set(local)).toEqual(new Set(['09:00']))
  })

  it('expands "second Tuesday of the month"', () => {
    const r = parseRRule('FREQ=MONTHLY;BYDAY=2TU;COUNT=3')!
    const out = expandRecurrence(start, r, start, start + 120 * 86_400_000)
    expect(out.map(iso)).toEqual([
      '2026-10-13T09:00:00.000Z',
      '2026-11-10T09:00:00.000Z',
      '2026-12-08T09:00:00.000Z'
    ])
  })

  it('expands "last Friday of the month"', () => {
    const r = parseRRule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3')!
    const out = expandRecurrence(start, r, start, start + 120 * 86_400_000)
    expect(out.map(iso)).toEqual([
      '2026-09-25T09:00:00.000Z',
      '2026-10-30T09:00:00.000Z',
      '2026-11-27T09:00:00.000Z'
    ])
  })

  it('skips months where BYMONTHDAY does not exist rather than rolling over', () => {
    // "The 31st" simply does not happen in February. Rolling to 1 March is the
    // single most common recurrence bug.
    const jan31 = Date.UTC(2027, 0, 31, 9, 0, 0)
    const r = parseRRule('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4')!
    const out = expandRecurrence(jan31, r, jan31, jan31 + 400 * 86_400_000)
    expect(out.map(iso)).toEqual([
      '2027-01-31T09:00:00.000Z',
      '2027-03-31T09:00:00.000Z',
      '2027-05-31T09:00:00.000Z',
      '2027-07-31T09:00:00.000Z'
    ])
  })

  it('expands a yearly rule', () => {
    const r = parseRRule('FREQ=YEARLY;COUNT=3')!
    const out = expandRecurrence(start, r, start, start + 1200 * 86_400_000)
    expect(out.map(iso)).toEqual([
      '2026-09-15T09:00:00.000Z',
      '2027-09-15T09:00:00.000Z',
      '2028-09-15T09:00:00.000Z'
    ])
  })

  it('never runs away on an unbounded rule', () => {
    const r = parseRRule('FREQ=DAILY')!
    const out = expandRecurrence(start, r, start, start + 365 * 86_400_000)
    expect(out.length).toBe(366)
  })
})

describe('parseIcs', () => {
  const wrap = (body: string): string =>
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nX-WR-CALNAME:Work\r\n${body}\r\nEND:VCALENDAR`

  it('reads a single event with its fields', () => {
    const cal = parseIcs(
      wrap(
        [
          'BEGIN:VEVENT',
          'UID:abc@google.com',
          'DTSTART:20260915T090000Z',
          'DTEND:20260915T100000Z',
          'SUMMARY:Vendor call\\, week 3',
          'LOCATION:Zoom',
          'DESCRIPTION:Bring the numbers',
          'ORGANIZER:mailto:sarah@example.com',
          'STATUS:CONFIRMED',
          'END:VEVENT'
        ].join('\r\n')
      ),
      ...YEAR(2026)
    )
    expect(cal.name).toBe('Work')
    expect(cal.events).toHaveLength(1)
    const e = cal.events[0]
    expect(e.summary).toBe('Vendor call, week 3')
    expect(e.location).toBe('Zoom')
    expect(e.organizer).toBe('sarah@example.com')
    expect(iso(e.start)).toBe('2026-09-15T09:00:00.000Z')
    expect(iso(e.end)).toBe('2026-09-15T10:00:00.000Z')
    expect(e.allDay).toBe(false)
  })

  it('reads an all-day event', () => {
    const cal = parseIcs(
      wrap(
        ['BEGIN:VEVENT', 'UID:h1', 'DTSTART;VALUE=DATE:20261225', 'DTEND;VALUE=DATE:20261226',
         'SUMMARY:Christmas', 'END:VEVENT'].join('\r\n')
      ),
      ...YEAR(2026)
    )
    expect(cal.events[0].allDay).toBe(true)
    expect(cal.events[0].end - cal.events[0].start).toBe(86_400_000)
  })

  it('uses DURATION when there is no DTEND', () => {
    const cal = parseIcs(
      wrap(['BEGIN:VEVENT', 'UID:d1', 'DTSTART:20260915T090000Z', 'DURATION:PT45M',
            'SUMMARY:Standup', 'END:VEVENT'].join('\r\n')),
      ...YEAR(2026)
    )
    expect(cal.events[0].end - cal.events[0].start).toBe(45 * 60_000)
  })

  it('expands a repeating event and applies its EXDATE', () => {
    const cal = parseIcs(
      wrap(
        ['BEGIN:VEVENT', 'UID:r1', 'DTSTART;TZID=Australia/Sydney:20260915T090000',
         'DTEND;TZID=Australia/Sydney:20260915T093000',
         'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4',
         'EXDATE;TZID=Australia/Sydney:20260929T090000',
         'SUMMARY:Standup', 'END:VEVENT'].join('\r\n')
      ),
      ...YEAR(2026)
    )
    expect(cal.events).toHaveLength(3)
    expect(cal.events.every((e) => e.summary === 'Standup')).toBe(true)
    expect(cal.events.every((e) => e.end - e.start === 30 * 60_000)).toBe(true)
  })

  it('lets a RECURRENCE-ID override replace one occurrence', () => {
    const cal = parseIcs(
      wrap(
        [
          'BEGIN:VEVENT', 'UID:r2', 'DTSTART:20260915T090000Z', 'DTEND:20260915T093000Z',
          'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3', 'SUMMARY:Standup', 'END:VEVENT',
          'BEGIN:VEVENT', 'UID:r2', 'RECURRENCE-ID:20260922T090000Z',
          'DTSTART:20260922T140000Z', 'DTEND:20260922T150000Z',
          'SUMMARY:Standup (moved)', 'END:VEVENT'
        ].join('\r\n')
      ),
      ...YEAR(2026)
    )
    expect(cal.events).toHaveLength(3)
    const moved = cal.events.find((e) => e.summary === 'Standup (moved)')
    expect(moved).toBeTruthy()
    expect(iso(moved!.start)).toBe('2026-09-22T14:00:00.000Z')
    // ...and the original slot is gone, not shown twice.
    expect(cal.events.filter((e) => iso(e.start) === '2026-09-22T09:00:00.000Z')).toHaveLength(0)
  })

  it('drops an occurrence cancelled by an override', () => {
    const cal = parseIcs(
      wrap(
        [
          'BEGIN:VEVENT', 'UID:r3', 'DTSTART:20260915T090000Z', 'DTEND:20260915T093000Z',
          'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3', 'SUMMARY:Standup', 'END:VEVENT',
          'BEGIN:VEVENT', 'UID:r3', 'RECURRENCE-ID:20260922T090000Z',
          'DTSTART:20260922T090000Z', 'STATUS:CANCELLED', 'SUMMARY:Standup', 'END:VEVENT'
        ].join('\r\n')
      ),
      ...YEAR(2026)
    )
    expect(cal.events).toHaveLength(2)
  })

  it('keeps an event that started before the window but is still running', () => {
    const cal = parseIcs(
      wrap(['BEGIN:VEVENT', 'UID:long', 'DTSTART:20260910T000000Z', 'DTEND:20260920T000000Z',
            'SUMMARY:Conference', 'END:VEVENT'].join('\r\n')),
      Date.UTC(2026, 8, 15),
      Date.UTC(2026, 8, 16)
    )
    expect(cal.events).toHaveLength(1)
  })

  it('excludes events outside the window', () => {
    const cal = parseIcs(
      wrap(['BEGIN:VEVENT', 'UID:old', 'DTSTART:20200101T090000Z', 'DTEND:20200101T100000Z',
            'SUMMARY:Ancient', 'END:VEVENT'].join('\r\n')),
      ...YEAR(2026)
    )
    expect(cal.events).toHaveLength(0)
  })

  it('reports a rule it cannot expand instead of dropping it silently', () => {
    const cal = parseIcs(
      wrap(['BEGIN:VEVENT', 'UID:s1', 'DTSTART:20260915T090000Z', 'RRULE:FREQ=SECONDLY;COUNT=10',
            'SUMMARY:Tick', 'END:VEVENT'].join('\r\n')),
      ...YEAR(2026)
    )
    expect(cal.events).toHaveLength(0)
    expect(cal.unsupported.join(' ')).toMatch(/SECONDLY/)
  })

  it('survives a feed with no events, and one that is pure garbage', () => {
    expect(parseIcs(wrap(''), ...YEAR(2026)).events).toEqual([])
    expect(parseIcs('not a calendar at all', ...YEAR(2026)).events).toEqual([])
  })

  it('ignores VTODO and VALARM components', () => {
    const cal = parseIcs(
      wrap(
        [
          'BEGIN:VEVENT', 'UID:e1', 'DTSTART:20260915T090000Z', 'DTEND:20260915T100000Z',
          'SUMMARY:Real event',
          'BEGIN:VALARM', 'TRIGGER:-PT15M', 'SUMMARY:Reminder noise', 'END:VALARM',
          'END:VEVENT',
          'BEGIN:VTODO', 'UID:t1', 'SUMMARY:A task', 'END:VTODO'
        ].join('\r\n')
      ),
      ...YEAR(2026)
    )
    expect(cal.events).toHaveLength(1)
    expect(cal.events[0].summary).toBe('Real event')
  })
})
