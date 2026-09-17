import { describe, it, expect } from 'vitest'
import { CALENDAR_COLORS } from '../../src/shared/types'
import { colorOfBlock, colorOfCalendar, tint } from '../../src/renderer/src/stores/calendars'
import { capabilityOf } from '../../src/main/db/externalCalendars'
import type { ExternalCalendar } from '../../src/shared/types'

function cal(over: Partial<ExternalCalendar> & Pick<ExternalCalendar, 'id' | 'provider'>): ExternalCalendar {
  return {
    name: 'Cal',
    color: null,
    sourceRef: '',
    accountId: null,
    enabled: true,
    lastSyncAt: null,
    lastSyncError: null,
    syncMode: 'read',
    pushTargetId: null,
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
    ...over
  } as ExternalCalendar
}

describe('calendar colours', () => {
  const list = [
    cal({ id: 'plexii', provider: 'internal', color: '#2563eb', isDefault: true }),
    cal({ id: 'side', provider: 'internal', color: '#059669' }),
    cal({ id: 'work', provider: 'google', color: '#dc2626' }),
    cal({ id: 'feed', provider: 'ics', color: null })
  ]

  it('the palette is distinct and hex', () => {
    expect(new Set(CALENDAR_COLORS).size).toBe(CALENDAR_COLORS.length)
    for (const c of CALENDAR_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('an event takes its own calendar’s colour', () => {
    expect(colorOfCalendar(list, 'work')).toBe('#dc2626')
  })

  it('a calendar with no colour, or one that has gone, falls back rather than throwing', () => {
    expect(colorOfCalendar(list, 'feed')).toBe('var(--accent)')
    expect(colorOfCalendar(list, 'deleted')).toBe('var(--accent)')
    expect(colorOfCalendar(list, null)).toBe('var(--accent)')
  })

  it('a block on a named calendar takes that colour', () => {
    expect(colorOfBlock(list, 'side')).toBe('#059669')
  })

  it('a block with no calendar takes the DEFAULT internal calendar’s colour', () => {
    expect(colorOfBlock(list, null)).toBe('#2563eb')
    expect(colorOfBlock(list, undefined)).toBe('#2563eb')
  })

  it('a block pointing at a deleted calendar still gets the default, not nothing', () => {
    expect(colorOfBlock(list, 'gone')).toBe('#2563eb')
  })

  it('with no calendars at all nothing throws', () => {
    expect(colorOfBlock([], null)).toBe('var(--accent)')
    expect(colorOfCalendar([], 'x')).toBe('var(--accent)')
  })

  it('tint produces a real CSS colour from any input', () => {
    expect(tint('#dc2626', 0.15)).toContain('#dc2626')
    expect(tint('var(--accent)')).toContain('var(--accent)')
  })
})

describe('sync direction is decided by the provider, not by a setting', () => {
  it('an ICS feed can never claim to be two-way', () => {
    expect(capabilityOf('ics')).toBe('read')
  })

  it('an OAuth account can go both ways', () => {
    expect(capabilityOf('google')).toBe('both')
    expect(capabilityOf('microsoft')).toBe('both')
  })

  it('a Plexii calendar is a source, so it can be written out', () => {
    expect(capabilityOf('internal')).toBe('both')
  })
})
