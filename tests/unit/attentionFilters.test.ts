import { describe, expect, it } from 'vitest'
import {
  ATTENTION_FILTERS,
  matchesAttentionFilter,
  type AttentionFilter
} from '../../src/renderer/src/lib/attentionQueues'

// Local noon, so "today" is unambiguous wherever this runs — the filter
// means the viewer's calendar day, so the test must not be tz-dependent.
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

type Item = Parameters<typeof matchesAttentionFilter>[0]
const item = (over: Partial<Item> = {}): Item => ({
  workItemState: 'open',
  dueAt: null,
  snoozeUntil: null,
  detachedFromId: null,
  updatedAt: NOW,
  ...over
})

const hits = (i: Item): AttentionFilter[] =>
  ATTENTION_FILTERS.map((f) => f.id).filter((f) => matchesAttentionFilter(i, f, NOW))

describe('attention filters', () => {
  it('offers the six, in the order asked for', () => {
    expect(ATTENTION_FILTERS.map((f) => f.label)).toEqual([
      'Open',
      'Due today',
      'Overdue',
      'In progress',
      'Waiting',
      'Closed 7d'
    ])
  })

  it('counts live work as Open', () => {
    expect(hits(item())).toContain('open')
  })

  it('leaves a snoozed item out of Open — a snooze means "not yet"', () => {
    const snoozed = item({ snoozeUntil: NOW + DAY })
    expect(hits(snoozed)).not.toContain('open')
  })

  it('leaves a terminal item out of Open', () => {
    expect(hits(item({ workItemState: 'completed' }))).not.toContain('open')
  })

  it('separates in progress from waiting', () => {
    expect(hits(item({ workItemState: 'in_progress' }))).toContain('in-progress')
    expect(hits(item({ workItemState: 'in_progress' }))).not.toContain('waiting')
    for (const st of ['waiting', 'blocked', 'delegated', 'needs_review', 'needs_approval']) {
      expect(hits(item({ workItemState: st })), st).toContain('waiting')
    }
  })

  it('treats due today as the calendar day, not the next 24 hours', () => {
    const laterToday = item({ dueAt: iso(NOW + 3 * HOUR) })
    expect(hits(laterToday)).toContain('due-today')
    expect(hits(laterToday)).not.toContain('overdue')

    // 9am tomorrow is within 24 hours but is NOT today.
    const tomorrow = item({ dueAt: iso(new Date(2026, 9, 11, 9, 0, 0).getTime()) })
    expect(hits(tomorrow)).not.toContain('due-today')
  })

  it('reports an item that was due earlier today as both overdue and due today', () => {
    const missed = item({ dueAt: iso(NOW - 2 * HOUR) })
    expect(hits(missed)).toContain('overdue')
    expect(hits(missed)).toContain('due-today')
  })

  it('shows a closed item for seven days, then stops', () => {
    expect(hits(item({ workItemState: 'completed', updatedAt: NOW - 2 * DAY }))).toContain('closed-7d')
    expect(hits(item({ workItemState: 'completed', updatedAt: NOW - 8 * DAY }))).not.toContain('closed-7d')
  })

  it('does not call dismissed, reclassified or archived items "closed"', () => {
    // They were taken out of the flow, not completed — the same exclusions
    // recentlyClosed applies.
    for (const st of ['dismissed', 'reclassified', 'archived']) {
      expect(hits(item({ workItemState: st, updatedAt: NOW })), st).not.toContain('closed-7d')
    }
  })

  it('never shows a detached item as live work', () => {
    expect(hits(item({ detachedFromId: 'parent-1' }))).toEqual([])
  })
})
