import { describe, it, expect } from 'vitest'
import {
  matchesFilter,
  applyCalendarFilter,
  filterIsEmpty,
  describeCalendarFilter,
  sourceEnabled,
  type CalendarEntry,
  type CalendarFilter
} from '../../src/shared/calendarFilter'

const entry = (over: Partial<CalendarEntry> & { id: string }): CalendarEntry => ({
  source: 'task',
  title: 'Photos',
  startMs: 0,
  status: 'open',
  assignee: null,
  calendarId: null,
  inScope: true,
  ...over
})

describe('sourceEnabled', () => {
  it('shows a source nobody has configured', () => {
    // A fresh widget must not look broken.
    expect(sourceEnabled({}, 'task')).toBe(true)
    expect(sourceEnabled({ sources: {} }, 'block')).toBe(true)
  })
  it('hides one explicitly turned off', () => {
    expect(sourceEnabled({ sources: { block: false } }, 'block')).toBe(false)
  })
})

describe('matchesFilter', () => {
  it('keeps an in-scope open task by default', () => {
    expect(matchesFilter(entry({ id: '1' }), {})).toBe(true)
  })

  it('hides a task from another desk when scoped to this one', () => {
    expect(matchesFilter(entry({ id: '1', inScope: false }), { scope: 'desk' })).toBe(false)
    expect(matchesFilter(entry({ id: '1', inScope: false }), { scope: 'all' })).toBe(true)
  })

  it('never scopes a subscribed event out by desk', () => {
    // A Google event belongs to a calendar, not to this workspace's tree.
    // Scoping it by desk would hide every one of them.
    const e = entry({ id: 'x', source: 'external', inScope: false })
    expect(matchesFilter(e, { scope: 'desk' })).toBe(true)
  })

  it('applies the title rule, OR within it', () => {
    const e = entry({ id: '1', title: 'Ridge St photos' })
    expect(matchesFilter(e, { match: ['ridge'] })).toBe(true)
    expect(matchesFilter(e, { match: ['auction', 'ridge'] })).toBe(true)
    expect(matchesFilter(e, { match: ['auction'] })).toBe(false)
  })

  it('excludes after matching, so exclude wins', () => {
    const e = entry({ id: '1', title: 'Ridge St draft' })
    expect(matchesFilter(e, { match: ['ridge'], exclude: ['draft'] })).toBe(false)
  })

  it('ignores blank terms rather than matching nothing', () => {
    expect(matchesFilter(entry({ id: '1' }), { match: ['', '  '] })).toBe(true)
  })

  it('filters tasks by status', () => {
    const done = entry({ id: '1', status: 'done' })
    expect(matchesFilter(done, {})).toBe(false)
    expect(matchesFilter(done, { taskStatus: 'done' })).toBe(true)
    expect(matchesFilter(done, { taskStatus: 'all' })).toBe(true)
  })

  it('does not apply task rules to blocks or subscribed events', () => {
    // A time block has no status of that kind; an "open only" rule must not
    // silently delete every booking.
    expect(matchesFilter(entry({ id: '1', source: 'block', status: null }), {})).toBe(true)
    expect(
      matchesFilter(entry({ id: '1', source: 'external', status: null }), { taskStatus: 'open' })
    ).toBe(true)
  })

  it('filters by assignee, and excludes unassigned when one is asked for', () => {
    expect(matchesFilter(entry({ id: '1', assignee: 'Michael' }), { assignees: ['mich'] })).toBe(true)
    expect(matchesFilter(entry({ id: '1', assignee: 'Sarah' }), { assignees: ['mich'] })).toBe(false)
    expect(matchesFilter(entry({ id: '1', assignee: null }), { assignees: ['mich'] })).toBe(false)
  })

  it('restricts subscribed events to chosen calendars', () => {
    const e = entry({ id: '1', source: 'external', calendarId: 'cal1' })
    expect(matchesFilter(e, { calendarIds: ['cal1'] })).toBe(true)
    expect(matchesFilter(e, { calendarIds: ['cal2'] })).toBe(false)
    expect(matchesFilter(e, { calendarIds: [] })).toBe(true)
  })

  it('honours a source being switched off', () => {
    expect(matchesFilter(entry({ id: '1', source: 'block' }), { sources: { block: false } })).toBe(
      false
    )
  })
})

describe('applyCalendarFilter', () => {
  it('returns nothing rather than falling back to everything', () => {
    expect(applyCalendarFilter([entry({ id: '1' })], { match: ['nope'] })).toEqual([])
  })
})

describe('filterIsEmpty', () => {
  it('is false for the default, which already narrows to this desk and open tasks', () => {
    expect(filterIsEmpty({})).toBe(false)
  })
  it('is true only when nothing at all is excluded', () => {
    expect(filterIsEmpty({ scope: 'all', taskStatus: 'all' })).toBe(true)
  })
})

describe('describeCalendarFilter', () => {
  it('states the rule as a sentence', () => {
    const f: CalendarFilter = { scope: 'desk', match: ['ridge'], taskStatus: 'open' }
    expect(describeCalendarFilter(f)).toBe('This desk · about ridge · open only')
  })
  it('names the sources when some are off', () => {
    expect(describeCalendarFilter({ sources: { external: false }, taskStatus: 'all' })).toContain(
      'due dates + time blocks'
    )
  })
  it('says so when nothing is filtered', () => {
    expect(describeCalendarFilter({ scope: 'all', taskStatus: 'all' })).toBe('Everything')
  })
})
