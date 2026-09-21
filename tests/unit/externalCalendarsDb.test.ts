// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { memSqlDb } from './_memdb'
import type { SqlDb } from '../../src/main/db/eventStore'

// The external-calendar store, against real SQLite.
//
// replaceEventsInWindow is the write every sync ends in: it DELETES whatever
// the calendar had in the window and inserts what the provider just returned.
// That makes its scoping the only thing between a routine re-sync and silently
// wiping someone's calendar — a different calendar's events, or events outside
// the window, must survive it untouched. None of this was tested; the parsing
// and push layers were, and the review mistook that for coverage of the whole.

let db: SqlDb
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))

import {
  ensureExternalCalendarSchema,
  createCalendar,
  replaceEventsInWindow,
  listEvents,
  updateCalendar,
  deleteCalendar
} from '../../src/main/db/externalCalendars'

const H = 3_600_000
const T0 = Date.UTC(2026, 8, 1, 9) // 1 Sep 2026, 09:00 UTC

function ev(uid: string, startH: number, endH: number, title = uid) {
  return { uid, title, startMs: T0 + startH * H, endMs: T0 + endH * H, allDay: false }
}

beforeEach(() => {
  db = memSqlDb()
  ensureExternalCalendarSchema(db)
  createCalendar({ id: 'work', provider: 'ics', name: 'Work', sourceRef: 'https://a.test/w.ics' })
  createCalendar({ id: 'home', provider: 'ics', name: 'Home', sourceRef: 'https://a.test/h.ics' })
})

const titles = (from = T0 - 100 * H, to = T0 + 100 * H): string[] => listEvents(from, to).map((e) => e.title)

describe('replaceEventsInWindow — what a sync is allowed to delete', () => {
  it('never touches another calendar\'s events', () => {
    replaceEventsInWindow('home', T0 - 10 * H, T0 + 10 * H, [ev('dentist', 1, 2)])
    // A work sync over the SAME window must leave home alone.
    replaceEventsInWindow('work', T0 - 10 * H, T0 + 10 * H, [ev('standup', 0, 1)])
    expect(titles().sort()).toEqual(['dentist', 'standup'])
  })

  it('keeps events that lie entirely outside the window', () => {
    replaceEventsInWindow('work', T0 - 100 * H, T0 + 100 * H, [ev('old', -50, -49), ev('soon', 1, 2), ev('later', 50, 51)])
    // Re-sync only the next ten hours, with nothing in it.
    replaceEventsInWindow('work', T0, T0 + 10 * H, [])
    expect(titles().sort()).toEqual(['later', 'old'])
  })

  it('does not delete an event that ends exactly as the window begins', () => {
    // Overlap is strict: touching the edge is not being inside it.
    replaceEventsInWindow('work', T0 - 100 * H, T0 + 100 * H, [ev('before', -2, 0)])
    replaceEventsInWindow('work', T0, T0 + 10 * H, [])
    expect(titles()).toEqual(['before'])
  })

  it('does delete an event that straddles the window edge', () => {
    // It overlaps, so it is the provider's to restate — and it must, or it goes.
    replaceEventsInWindow('work', T0 - 100 * H, T0 + 100 * H, [ev('straddle', -1, 1)])
    replaceEventsInWindow('work', T0, T0 + 10 * H, [])
    expect(titles()).toEqual([])
  })

  it('overwrites on re-sync instead of duplicating', () => {
    // The id is stable per occurrence, so syncing twice cannot double an event.
    replaceEventsInWindow('work', T0 - 10 * H, T0 + 10 * H, [ev('standup', 0, 1, 'Standup')])
    replaceEventsInWindow('work', T0 - 10 * H, T0 + 10 * H, [ev('standup', 0, 1, 'Standup (moved room)')])
    expect(titles()).toEqual(['Standup (moved room)'])
  })

  it('keeps each occurrence of a recurring event separate', () => {
    // Same UID, different start: two meetings, not one overwritten by the other.
    replaceEventsInWindow('work', T0 - 10 * H, T0 + 100 * H, [ev('weekly', 0, 1), ev('weekly', 24, 25)])
    expect(listEvents(T0 - 10 * H, T0 + 100 * H)).toHaveLength(2)
  })

  it('reports how many events it wrote', () => {
    expect(replaceEventsInWindow('work', T0, T0 + 10 * H, [ev('a', 1, 2), ev('b', 3, 4)])).toBe(2)
  })

  it('is all-or-nothing: a failed insert leaves the previous events in place', () => {
    replaceEventsInWindow('work', T0 - 10 * H, T0 + 10 * H, [ev('keep', 1, 2)])
    // start_ms is NOT NULL with no default, so OR REPLACE cannot paper over a
    // missing one and the insert genuinely fails mid-transaction. The DELETE
    // that ran first must roll back with it, or one bad row in a feed empties
    // the whole window.
    const bad = { uid: 'x', title: 'Bad', startMs: null as unknown as number, endMs: T0 + H, allDay: false }
    expect(() => replaceEventsInWindow('work', T0 - 10 * H, T0 + 10 * H, [ev('ok', 3, 4), bad])).toThrow()
    expect(titles()).toEqual(['keep'])
  })

  it('stores an untitled event as blank rather than rejecting the sync', () => {
    // title is NOT NULL DEFAULT '', and under INSERT OR REPLACE SQLite resolves
    // a NOT NULL violation by substituting the default. Feeds do send events
    // with no summary; dropping the whole sync over one would be worse.
    replaceEventsInWindow('work', T0, T0 + 10 * H, [
      { uid: 'u', title: null as unknown as string, startMs: T0 + H, endMs: T0 + 2 * H, allDay: false }
    ])
    expect(listEvents(T0, T0 + 10 * H).map((e) => e.title)).toEqual([''])
  })
})

describe('listEvents', () => {
  it('hides events from a disabled calendar without deleting them', () => {
    replaceEventsInWindow('work', T0 - 10 * H, T0 + 10 * H, [ev('standup', 0, 1)])
    updateCalendar('work', { enabled: false })
    expect(titles()).toEqual([])
    updateCalendar('work', { enabled: true })
    expect(titles()).toEqual(['standup'])
  })

  it('returns events in start order', () => {
    replaceEventsInWindow('work', T0 - 10 * H, T0 + 10 * H, [ev('third', 5, 6), ev('first', 1, 2), ev('second', 3, 4)])
    expect(titles()).toEqual(['first', 'second', 'third'])
  })
})

describe('deleteCalendar', () => {
  it('takes its events with it, and only its own', () => {
    replaceEventsInWindow('work', T0 - 10 * H, T0 + 10 * H, [ev('standup', 0, 1)])
    replaceEventsInWindow('home', T0 - 10 * H, T0 + 10 * H, [ev('dentist', 1, 2)])
    deleteCalendar('work')
    expect(titles()).toEqual(['dentist'])
  })
})
