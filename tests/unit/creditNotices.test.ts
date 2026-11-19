// Share credit notices (4.3.52): the payload is checked, a dismissal is told
// to the server and never shown again, and a notice earned while the app was
// closed is shown at the next load. Server: focusbuddy-signal shareCredit.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const seen: string[] = []
let seenOk = true
let listed: unknown[] | null = []
vi.mock('../../src/renderer/src/lib/notify', () => ({ notifyExternal: vi.fn() }))
vi.mock('../../src/renderer/src/lib/creditNotices', async (orig) => {
  const real = await orig<typeof import('../../src/renderer/src/lib/creditNotices')>()
  return {
    ...real,
    markCreditNoticeSeen: vi.fn(async (id: string) => {
      seen.push(id)
      return seenOk
    }),
    fetchCreditNotices: vi.fn(async () => (listed === null ? null : listed.map(real.parseCreditNotice).filter(Boolean)))
  }
})

import { formatUsd, parseCreditNotice, safeActionUrl } from '../../src/renderer/src/lib/creditNotices'
import { useCreditNoticesStore } from '../../src/renderer/src/stores/creditNotices'
import { notifyExternal } from '../../src/renderer/src/lib/notify'

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'n1',
  kind: 'creditEarned',
  usd: 5,
  balanceUsd: 10,
  source: 'email_invite',
  deskTitle: 'Launch plan',
  inviteeName: 'Bea Jones',
  text: 'Bea Jones joined Plexii from your invite to “Launch plan”.',
  actionLabel: 'Use my credit',
  actionUrl: 'https://plexiidesk.com/account/referrals',
  shareActionLabel: 'Share another desk',
  createdAt: 1000,
  ...over
})

describe('a notice from the server is checked before it is shown', () => {
  it('a whole notice is kept as sent', () => {
    expect(parseCreditNotice(raw())).toMatchObject({ id: 'n1', usd: 5, balanceUsd: 10, source: 'email_invite', inviteeName: 'Bea Jones', text: raw().text })
  })
  it('one missing an amount, a balance, its words, its link or a known source is dropped', () => {
    for (const bad of [{ usd: undefined }, { usd: 0 }, { usd: 'five' }, { balanceUsd: null }, { text: '' }, { actionUrl: undefined }, { source: 'other' }, { kind: 'somethingElse' }]) {
      expect(parseCreditNotice(raw(bad))).toBeNull()
    }
    expect(parseCreditNotice(null)).toBeNull()
    expect(parseCreditNotice('x')).toBeNull()
  })
  it('blank optional names become null; the button words default', () => {
    expect(parseCreditNotice(raw({ deskTitle: '  ', inviteeName: undefined, actionLabel: undefined }))).toMatchObject({ deskTitle: null, inviteeName: null, actionLabel: 'Use my credit' })
  })
  it('amounts read like money', () => {
    expect([formatUsd(5), formatUsd(144), formatUsd(2.5)]).toEqual(['US$5', 'US$144', 'US$2.50'])
  })
  it('only an https link is opened (http only on this machine)', () => {
    expect(safeActionUrl('https://plexiidesk.com/account/referrals')).toBe('https://plexiidesk.com/account/referrals')
    expect(safeActionUrl('http://localhost:3099/account/referrals')).toBe('http://localhost:3099/account/referrals')
    expect(safeActionUrl('http://example.com/x')).toBeNull()
    expect(safeActionUrl('javascript:alert(1)')).toBeNull()
    expect(safeActionUrl('not a url')).toBeNull()
  })
})

describe('the notices list', () => {
  beforeEach(() => {
    seen.length = 0
    seenOk = true
    listed = []
    useCreditNoticesStore.getState().reset()
    vi.mocked(notifyExternal).mockClear()
  })

  it('newest first, and the same notice twice is one', () => {
    const s = useCreditNoticesStore.getState()
    s.add(parseCreditNotice(raw({ id: 'old', createdAt: 1 }))!)
    s.add(parseCreditNotice(raw({ id: 'new', createdAt: 2 }))!)
    s.add(parseCreditNotice(raw({ id: 'new', createdAt: 2 }))!)
    expect(useCreditNoticesStore.getState().notices.map((n) => n.id)).toEqual(['new', 'old'])
  })

  it('a live one is the one celebrated, and calls out when the app is in the background', () => {
    useCreditNoticesStore.getState().add(parseCreditNotice(raw())!, { live: true })
    expect(useCreditNoticesStore.getState().arrivedId).toBe('n1')
    expect(notifyExternal).toHaveBeenCalledWith('You earned US$5 of Plexii credit', raw().text, { tag: 'credit-n1' })
  })

  it('a credit earned while the app was closed is shown at the next load, without a fanfare', async () => {
    listed = [raw({ id: 'a', createdAt: 5 }), raw({ id: 'b', createdAt: 9 }), { broken: true }]
    await useCreditNoticesStore.getState().load()
    expect(useCreditNoticesStore.getState().notices.map((n) => n.id)).toEqual(['b', 'a'])
    expect(useCreditNoticesStore.getState().arrivedId).toBeNull()
    expect(notifyExternal).not.toHaveBeenCalled()
  })

  it('dismissing marks it seen on the server, and it never comes back, from the socket or a list', async () => {
    const s = useCreditNoticesStore.getState()
    s.add(parseCreditNotice(raw())!, { live: true })
    await s.dismiss('n1')
    expect(seen).toEqual(['n1'])
    expect(useCreditNoticesStore.getState().notices).toEqual([])
    expect(useCreditNoticesStore.getState().arrivedId).toBeNull()
    s.add(parseCreditNotice(raw())!, { live: true })
    listed = [raw()]
    await s.load()
    expect(useCreditNoticesStore.getState().notices).toEqual([])
  })

  it('a dismissal the server did not take is sent again at the next load', async () => {
    const s = useCreditNoticesStore.getState()
    s.add(parseCreditNotice(raw())!)
    seenOk = false
    await s.dismiss('n1')
    expect(useCreditNoticesStore.getState().unsentSeenIds).toEqual(['n1'])
    seenOk = true
    listed = [raw()]
    await s.load()
    expect(seen).toEqual(['n1', 'n1'])
    expect(useCreditNoticesStore.getState().unsentSeenIds).toEqual([])
    expect(useCreditNoticesStore.getState().notices).toEqual([])
  })

  it('a list that could not be fetched leaves what is on screen', async () => {
    useCreditNoticesStore.getState().add(parseCreditNotice(raw())!)
    listed = null
    await useCreditNoticesStore.getState().load()
    expect(useCreditNoticesStore.getState().notices.map((n) => n.id)).toEqual(['n1'])
  })
})
