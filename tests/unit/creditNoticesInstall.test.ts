// The credit notices follow the session (share credit, 4.3.52): listed when a
// signed-in session's server says it has them, again on a window focus at most
// every few minutes, and cleared when the account signs out or switches.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ fetches: 0, list: [] as unknown[] }))
vi.mock('../../src/renderer/src/lib/notify', () => ({ notifyExternal: vi.fn() }))
vi.mock('../../src/renderer/src/lib/creditNotices', async (orig) => {
  const real = await orig<typeof import('../../src/renderer/src/lib/creditNotices')>()
  return {
    ...real,
    fetchCreditNotices: vi.fn(async () => {
      h.fetches++
      return h.list.map(real.parseCreditNotice).filter(Boolean)
    }),
    markCreditNoticeSeen: vi.fn(async () => true)
  }
})

import { installCreditNotices, RELOAD_ON_FOCUS_MS, useCreditNoticesStore } from '../../src/renderer/src/stores/creditNotices'
import { useAccountStore } from '../../src/renderer/src/stores/account'
import { useCapabilityStore } from '../../src/renderer/src/stores/capabilities'

const raw = (id: string): Record<string, unknown> => ({
  id,
  usd: 5,
  balanceUsd: 5,
  source: 'share_link',
  text: 'Someone you shared “Q4 plan” with just joined Plexii.',
  actionUrl: 'https://www.plexiidesk.com/account/referrals',
  createdAt: 1
})
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const ids = (): string[] => useCreditNoticesStore.getState().notices.map((n) => n.id)

let stop: () => void = () => undefined
beforeEach(() => {
  vi.useRealTimers()
  h.fetches = 0
  h.list = [raw('a')]
  useCreditNoticesStore.getState().reset()
  useAccountStore.setState({ sessionToken: null } as never)
  useCapabilityStore.setState({ serverFeatures: [] } as never)
})
afterEach(() => stop())

describe('the notices follow the session', () => {
  it('signed out, or a server without share credit: nothing is fetched', async () => {
    stop = installCreditNotices()
    // Signed out: the feature alone fetches nothing.
    useCapabilityStore.setState({ serverFeatures: ['creditEarned'] } as never)
    await flush()
    expect(h.fetches).toBe(0)
    // Signed in to a server without share credit: nothing either.
    useCapabilityStore.setState({ serverFeatures: ['account_export'] } as never)
    useAccountStore.setState({ sessionToken: 'tok' } as never)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(h.fetches).toBe(0)
    expect(ids()).toEqual([])
  })

  it('a signed-in session whose server lists creditEarned: fetched once, shown', async () => {
    useAccountStore.setState({ sessionToken: 'tok' } as never)
    stop = installCreditNotices()
    expect(h.fetches).toBe(0)
    useCapabilityStore.setState({ serverFeatures: ['creditEarned'] } as never)
    await flush()
    expect(h.fetches).toBe(1)
    expect(ids()).toEqual(['a'])
    // Every capability refresh (one per window focus) does not refetch.
    useCapabilityStore.setState({ serverFeatures: ['creditEarned', 'account_export'] } as never)
    await flush()
    expect(h.fetches).toBe(1)
  })

  it('a window focus refetches, at most once every few minutes', async () => {
    const t0 = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    useAccountStore.setState({ sessionToken: 'tok' } as never)
    useCapabilityStore.setState({ serverFeatures: ['creditEarned'] } as never)
    stop = installCreditNotices()
    await flush()
    expect(h.fetches).toBe(1)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(h.fetches).toBe(1)
    now.mockReturnValue(t0 + RELOAD_ON_FOCUS_MS)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(h.fetches).toBe(2)
    now.mockRestore()
  })

  it('signing out clears the card; another account starts from its own list', async () => {
    useAccountStore.setState({ sessionToken: 'tok-a' } as never)
    useCapabilityStore.setState({ serverFeatures: ['creditEarned'] } as never)
    stop = installCreditNotices()
    await flush()
    expect(ids()).toEqual(['a'])
    useAccountStore.setState({ sessionToken: null } as never)
    expect(ids()).toEqual([])
    h.list = [raw('b')]
    useAccountStore.setState({ sessionToken: 'tok-b' } as never)
    await flush()
    expect(ids()).toEqual(['b'])
  })
})
