// Which of my own rooms and desks read as "Shared with others".
//
// Both halves of this were learned the hard way. `outgoing` keeps REVOKED
// links, because a revoke is a soft delete so the share manager can still
// show who you had shared with — so a room went on claiming to be shared
// after revocation until ownerSharedBadge's revoke test said so. Expiry is
// the same shape and had the same bug waiting in it (owner's ruling,
// 2026-10-24: an expired link is not "shared with others").

import { describe, expect, it } from 'vitest'
import { activeSharedOutIds, isLiveShare } from '@renderer/lib/sharedOut'

const NOW = 1_700_000_000_000
const link = (over: Partial<{ entityId: string; revoked: boolean; expiresAt: number | null }> = {}) => ({
  entityId: 'room-1',
  revoked: false,
  expiresAt: null as number | null,
  ...over
})

describe('a link is live until it is revoked or expires', () => {
  it('a plain link with no expiry is live', () => {
    expect(isLiveShare(link(), NOW)).toBe(true)
  })

  it('a revoked link is not', () => {
    expect(isLiveShare(link({ revoked: true }), NOW)).toBe(false)
  })

  it('a link whose expiry has passed is not', () => {
    expect(isLiveShare(link({ expiresAt: NOW - 1 }), NOW)).toBe(false)
  })

  it('a link expiring exactly now has expired', () => {
    // The boundary stated rather than left to chance: "expires at 5pm" means
    // it is gone at 5pm, not still good for one more millisecond.
    expect(isLiveShare(link({ expiresAt: NOW }), NOW)).toBe(false)
  })

  it('a link expiring later is still live', () => {
    expect(isLiveShare(link({ expiresAt: NOW + 1 }), NOW)).toBe(true)
  })

  it('null expiry means never, not now', () => {
    // The one that would hurt most: reading null as 0 would expire every
    // permanent share instantly and quietly unbadge the whole index.
    expect(isLiveShare(link({ expiresAt: null }), NOW)).toBe(true)
  })
})

describe('the ids the badge uses', () => {
  it('collects only the entities with a live link', () => {
    const ids = activeSharedOutIds(
      [
        link({ entityId: 'live' }),
        link({ entityId: 'revoked', revoked: true }),
        link({ entityId: 'expired', expiresAt: NOW - 1000 }),
        link({ entityId: 'future', expiresAt: NOW + 1000 })
      ],
      NOW
    )
    expect([...ids].sort()).toEqual(['future', 'live'])
  })

  it('keeps an entity whose OTHER link is still live', () => {
    // Share the same room twice, revoke one: it is still shared.
    const ids = activeSharedOutIds(
      [link({ entityId: 'room-1', revoked: true }), link({ entityId: 'room-1' })],
      NOW
    )
    expect(ids.has('room-1')).toBe(true)
  })

  it('is empty when nothing is live', () => {
    expect(activeSharedOutIds([link({ revoked: true })], NOW).size).toBe(0)
  })
})
