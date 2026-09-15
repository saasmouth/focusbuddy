import { describe, it, expect } from 'vitest'
import {
  TASK_PLANNING_COLUMNS,
  parseAttachments,
  derivedStart,
  durationDays
} from '../../src/shared/taskPlanning'

const DAY = 86_400_000
const MON = new Date(2026, 8, 14).getTime()

describe('TASK_PLANNING_COLUMNS', () => {
  it('gives every column a distinct name and attribute', () => {
    const cols = TASK_PLANNING_COLUMNS.map((c) => c.column)
    const attrs = TASK_PLANNING_COLUMNS.map((c) => c.attr)
    expect(new Set(cols).size).toBe(cols.length)
    expect(new Set(attrs).size).toBe(attrs.length)
  })
  it('uses snake_case columns and camelCase attributes, which the mapper assumes', () => {
    for (const c of TASK_PLANNING_COLUMNS) {
      expect(c.column).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(c.attr).toMatch(/^[a-z][A-Za-z0-9]*$/)
      expect(c.ddl).toBeTruthy()
    }
  })
  it('declares every column nullable, so an existing task means what it meant', () => {
    for (const c of TASK_PLANNING_COLUMNS) {
      expect(c.ddl).not.toMatch(/NOT NULL/i)
      expect(c.ddl).not.toMatch(/DEFAULT/i)
    }
  })
})

describe('parseAttachments', () => {
  it('returns nothing for empty, null and unparseable content', () => {
    expect(parseAttachments(null)).toEqual([])
    expect(parseAttachments('')).toEqual([])
    expect(parseAttachments('{not json')).toEqual([])
    expect(parseAttachments('{"id":"x"}')).toEqual([])
  })
  it('keeps well-formed entries', () => {
    const raw = JSON.stringify([{ id: 'f1', name: 'contract.pdf', mime: 'application/pdf', size: 12 }])
    expect(parseAttachments(raw)).toEqual([
      { id: 'f1', name: 'contract.pdf', mime: 'application/pdf', size: 12 }
    ])
  })
  it('drops entries with no id rather than rendering a broken link', () => {
    const raw = JSON.stringify([{ name: 'orphan.pdf' }, { id: 'ok', name: 'good.pdf' }])
    expect(parseAttachments(raw).map((a) => a.id)).toEqual(['ok'])
  })
})

describe('derivedStart', () => {
  it('prefers an explicit planned start over any dependency', () => {
    expect(derivedStart({ plannedStartAt: MON, dependsOn: 'x', lagDays: 5 }, MON + 30 * DAY)).toBe(MON)
  })
  it('starts when the predecessor ends, plus the lag', () => {
    expect(derivedStart({ dependsOn: 'x', lagDays: 2 }, MON)).toBe(MON + 2 * DAY)
  })
  it('treats a missing lag as no lag', () => {
    expect(derivedStart({ dependsOn: 'x' }, MON)).toBe(MON)
  })
  it('allows negative lag, which overlaps the two tasks', () => {
    expect(derivedStart({ dependsOn: 'x', lagDays: -3 }, MON)).toBe(MON - 3 * DAY)
  })
  it('is null when nothing is known, rather than defaulting to today', () => {
    expect(derivedStart({}, null)).toBeNull()
    expect(derivedStart({ dependsOn: 'x', lagDays: 2 }, null)).toBeNull()
    expect(derivedStart({ plannedStartAt: null }, null)).toBeNull()
  })
})

describe('durationDays', () => {
  it('counts the days between start and end', () => {
    expect(durationDays(MON, MON + 5 * DAY)).toBe(5)
  })
  it('is zero for a same-day task, not one', () => {
    expect(durationDays(MON, MON)).toBe(0)
  })
  it('never reports a negative duration', () => {
    expect(durationDays(MON, MON - 5 * DAY)).toBe(0)
  })
  it('is null when either end is unknown', () => {
    expect(durationDays(null, MON)).toBeNull()
    expect(durationDays(MON, null)).toBeNull()
    expect(durationDays(null, null)).toBeNull()
  })
})
