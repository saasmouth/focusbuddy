// With a memory-only database, this browser's notes about which link desks it
// holds must live and die with the page. Written to localStorage they would
// outlast the database, and the next visit would trust a note about a desk
// that is gone and open an empty one.
import { describe, it, expect, beforeEach, vi } from 'vitest'

type ShareVersion = typeof import('../../src/web/api/shareVersion')
const offer = { rootId: 'desk-day-trading', title: 'Day Trading Workcentre', updatedAt: 1730000000000, expiresAt: null } as never

async function fresh(): Promise<ShareVersion> {
  vi.resetModules()
  return import('../../src/web/api/shareVersion')
}

describe('link notes when the database is memory-only', () => {
  beforeEach(() => localStorage.clear())

  it('control: a durable database keeps its notes in localStorage', async () => {
    const v = await fresh()
    v.recordUnpacked('tok-durable', 1, offer)
    expect(v.recordsArePageOnly()).toBe(false)
    expect(v.linkRecord('tok-durable')?.rootId).toBe('desk-day-trading')
    expect(localStorage.length).toBeGreaterThan(0)
  })

  it('keeps notes for this page only, and never touches localStorage', async () => {
    const v = await fresh()
    v.keepRecordsForThisPageOnly()
    expect(v.recordsArePageOnly()).toBe(true)
    v.recordUnpacked('tok-memory', 1, offer)
    expect(v.linkRecord('tok-memory')?.rootId).toBe('desk-day-trading')
    v.setUntrackedDesksPossible(true)
    expect(v.untrackedDesksPossible()).toBe(true)
    expect(localStorage.length).toBe(0)
    v.forgetAllLinkRecords()
    expect(v.readLinkRecords()).toEqual({})
    expect(v.untrackedDesksPossible()).toBe(false)
  })

  it('ignores notes an earlier visit left in localStorage', async () => {
    const before = await fresh()
    before.recordUnpacked('tok-earlier', 1, offer)
    expect(localStorage.length).toBeGreaterThan(0)
    const v = await fresh()
    v.keepRecordsForThisPageOnly()
    expect(v.linkRecord('tok-earlier')).toBeNull()
    expect(v.othersPresent('tok-new')).toBe(false)
  })
})
