import { describe, it, expect } from 'vitest'
import {
  calendarDaysBetween,
  parseDue,
  dueStanding,
  dueLabel
} from '../../src/renderer/src/lib/dueDates'
import { itemReason, groupByDue } from '../../src/renderer/src/lib/attentionQueues'
import { deskDueSignals } from '../../src/renderer/src/lib/attentionFeeders'
import type { FbNode } from '../../src/shared/types'

// Help audit (4.3.26): "a task due tomorrow shows Due today, one due in two days
// shows Due tomorrow, and same-day tasks show Past due". Every label divided
// (due - now) by 24 hours. These pin calendar-day behaviour, in local time,
// built from local Date parts so they hold in any time zone the suite runs in.

const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime()

describe('calendarDaysBetween', () => {
  it('counts dates, not 24-hour periods', () => {
    // 6 pm today to 5 pm tomorrow is 23 hours — and one calendar day.
    expect(calendarDaysBetween(at(2026, 10, 16, 18), at(2026, 10, 17, 17))).toBe(1)
    // 9 am today to 11 pm today is 14 hours and the same day.
    expect(calendarDaysBetween(at(2026, 10, 16, 9), at(2026, 10, 16, 23))).toBe(0)
    expect(calendarDaysBetween(at(2026, 10, 16, 1), at(2026, 10, 15, 23))).toBe(-1)
  })

  it('is not thrown by a DST change (23- and 25-hour days)', () => {
    // Australia starts DST on 4 Oct 2026; the US/EU change in March and Nov.
    // Whatever zone runs this, a span of whole local days stays whole.
    for (const [a, b] of [
      [at(2026, 10, 3, 12), at(2026, 10, 5, 12)],
      [at(2026, 3, 7, 12), at(2026, 3, 9, 12)],
      [at(2026, 3, 28, 12), at(2026, 3, 30, 12)],
      [at(2026, 10, 31, 12), at(2026, 11, 2, 12)]
    ]) {
      expect(calendarDaysBetween(a, b)).toBe(2)
    }
  })
})

describe('parseDue', () => {
  it('reads a bare date as that local date, all day', () => {
    expect(parseDue('2026-10-17')).toEqual({ ms: at(2026, 10, 17), allDay: true })
  })
  it('reads a UTC-midnight ISO (new Date("YYYY-MM-DD").toISOString()) as that date', () => {
    expect(parseDue('2026-10-17T00:00:00.000Z')).toEqual({ ms: at(2026, 10, 17), allDay: true })
  })
  it('recognises the app pickers\' date-only clock times', () => {
    expect(parseDue(at(2026, 10, 17))?.allDay).toBe(true) // TaskDetail
    expect(parseDue(at(2026, 10, 17, 17))?.allDay).toBe(true) // AttentionItemEditor, Calendar drop
    expect(parseDue(new Date(2026, 9, 17, 23, 59, 59).getTime())?.allDay).toBe(true) // NewNodeDialog
    expect(parseDue(at(2026, 10, 17, 14, 30))?.allDay).toBe(false)
  })
  it('returns null for nothing or nonsense', () => {
    expect(parseDue(null)).toBeNull()
    expect(parseDue('')).toBeNull()
    expect(parseDue('not a date')).toBeNull()
  })
})

describe('dueStanding / dueLabel — the three reported cases', () => {
  const evening = at(2026, 10, 16, 18)
  it('a task due tomorrow says "Due tomorrow", even under 24 hours away', () => {
    expect(dueLabel(dueStanding(at(2026, 10, 17, 17), evening)!)).toBe('Due tomorrow')
  })
  it('a task due in two days says "Due in 2 days"', () => {
    expect(dueLabel(dueStanding(at(2026, 10, 18, 9, 15), evening)!)).toBe('Due in 2 days')
  })
  it('a date-only task due today is "Due today" all day, not "Past due"', () => {
    for (const stored of [at(2026, 10, 16), at(2026, 10, 16, 17), '2026-10-16']) {
      expect(dueLabel(dueStanding(stored, evening)!)).toBe('Due today')
    }
  })
  it('a timed deadline earlier today is past due', () => {
    expect(dueLabel(dueStanding(at(2026, 10, 16, 14, 30), evening)!)).toBe('Past due')
  })
  it('a date-only task becomes past due once its day is over', () => {
    expect(dueLabel(dueStanding(at(2026, 10, 15), at(2026, 10, 16, 0, 5))!)).toBe('Past due')
  })
})

function item(over: Partial<FbNode>): FbNode {
  return {
    id: 'i1',
    kind: 'task-item',
    parentId: 'd1',
    title: 'x',
    updatedAt: at(2026, 10, 16, 8),
    workItemState: 'open',
    snoozeUntil: null,
    detachedFromId: null,
    ...over
  } as unknown as FbNode
}

describe('Attention and feeder labels use calendar days', () => {
  const evening = at(2026, 10, 16, 18)
  it('itemReason', () => {
    expect(itemReason(item({ dueAt: new Date(at(2026, 10, 17, 17)).toISOString() }), evening)).toBe('Due tomorrow')
    expect(itemReason(item({ dueAt: new Date(at(2026, 10, 16, 17)).toISOString() }), evening)).toBe('Due today')
  })
  it('groupByDue puts tomorrow\'s item under Tomorrow', () => {
    const groups = groupByDue([item({ dueAt: new Date(at(2026, 10, 17, 17)).toISOString() })], evening)
    expect(groups.map((g) => g.queue)).toEqual(['tomorrow'])
  })
  it('a desk due today (stored as local midnight) is not "Past due"', () => {
    const desk = { id: 'd1', kind: 'task', title: 'Desk', parentId: null, dueDate: at(2026, 10, 16), status: 'active', archived: false } as unknown as FbNode
    expect(deskDueSignals([desk], evening)[0]?.line).toBe('Due today')
  })
})
