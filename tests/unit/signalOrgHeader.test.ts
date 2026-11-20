// The fetch wrapper that stamps the active organisation on signal requests
// (renderer/src/lib/signalOrgHeader.ts). It is installed in the desktop AND in
// the web runtime (web/boot.tsx imports the renderer's main), where a custom
// header turns a simple cross-origin GET into one the browser must preflight.
// Signal's /public/* routes are unauthenticated and org-agnostic, so they never
// carry it: no preflight, one round trip, from any origin (signal saw OPTIONS
// /public/server-features 404s from an origin outside its CORS allowlist,
// 2026-11-20).
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/lib/signalConfig', () => ({ signalConfig: { httpUrl: 'https://api.plexiidesk.com', wsUrl: 'wss://api.plexiidesk.com/ws', useRemote: true } }))
vi.mock('../../src/renderer/src/stores/org', () => ({ useOrgStore: { getState: () => ({ activeOrgId: 'org-acme' }) } }))

const calls: Array<{ url: string; headers: Headers }> = []
beforeAll(async () => {
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v))
    calls.push({ url, headers })
    return new Response('{}')
  }) as typeof fetch
  const { installSignalOrgHeader } = await import('../../src/renderer/src/lib/signalOrgHeader')
  installSignalOrgHeader()
})
beforeEach(() => {
  calls.length = 0
})
const last = () => calls[calls.length - 1]!

describe('the organisation header on signal requests', () => {
  it('an org-scoped signal call carries the active org', async () => {
    await fetch('https://api.plexiidesk.com/workspace/sync?since=0', { headers: { authorization: 'Bearer t' } })
    expect(last().headers.get('x-plexi-org')).toBe('org-acme')
    expect(last().headers.get('authorization')).toBe('Bearer t')
  })

  it('an explicit org is kept', async () => {
    await fetch('https://api.plexiidesk.com/orgs/x/members', { headers: { 'x-plexi-org': 'org-other' } })
    expect(last().headers.get('x-plexi-org')).toBe('org-other')
  })

  it('a /public/ route never carries it: it stays a simple request a browser does not preflight', async () => {
    await fetch('https://api.plexiidesk.com/public/server-features')
    expect(last().headers.get('x-plexi-org')).toBeNull()
    await fetch('https://api.plexiidesk.com/public/server-features', { cache: 'no-store' })
    expect(last().headers.get('x-plexi-org')).toBeNull()
    await fetch(new Request('https://api.plexiidesk.com/public/plans'))
    expect(last().headers.get('x-plexi-org')).toBeNull()
    // Exactly the headers it was given: nothing added at all.
    expect([...last().headers.keys()]).toEqual([])
  })

  it('a path that only starts like it is still org-scoped', async () => {
    await fetch('https://api.plexiidesk.com/publications/1')
    expect(last().headers.get('x-plexi-org')).toBe('org-acme')
  })

  it('another host is untouched', async () => {
    await fetch('https://www.plexiidesk.com/app-release.json')
    expect(last().headers.get('x-plexi-org')).toBeNull()
  })
})
