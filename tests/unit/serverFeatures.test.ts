// The app offers a control that needs a new server route only once the server
// lists it in /account/capabilities `serverFeatures` (4.3.34). An older server
// omits the field: the list is empty and every such control stays hidden.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverSupports, useCapabilityStore } from '@renderer/stores/capabilities'
import { useAccountStore } from '@renderer/stores/account'

function capsResponse(extra: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ ok: true, tier: 'free', capabilities: {}, ...extra }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

beforeEach(() => {
  useAccountStore.setState({ sessionToken: 'tok' })
  useCapabilityStore.setState({ serverFeatures: [] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ sessionToken: null })
})

describe('serverFeatures', () => {
  it('an older server (no field): nothing is supported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => capsResponse({})))
    await useCapabilityStore.getState().refresh()
    expect(useCapabilityStore.getState().serverFeatures).toEqual([])
    expect(serverSupports('account_archive')).toBe(false)
    expect(serverSupports('account_privacy')).toBe(false)
  })

  it('the 4.3.34 server: what it lists is supported, junk entries are dropped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => capsResponse({ serverFeatures: ['account_privacy', 'account_archive', 7, null] }))
    )
    await useCapabilityStore.getState().refresh()
    expect(useCapabilityStore.getState().serverFeatures).toEqual(['account_privacy', 'account_archive'])
    expect(serverSupports('account_archive')).toBe(true)
    expect(serverSupports('consent_enforced')).toBe(false)
  })

  it('signing out forgets them', async () => {
    useCapabilityStore.setState({ serverFeatures: ['account_archive'] })
    useAccountStore.setState({ sessionToken: null })
    await useCapabilityStore.getState().refresh()
    expect(useCapabilityStore.getState().serverFeatures).toEqual([])
  })
})
