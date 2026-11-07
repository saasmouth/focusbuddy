// @vitest-environment node
// The desk itself behind a live link (main/livePublisher.publishLiveBundle):
// the full web app opens live links from it (owner, 2026-11-07: every share
// link opens the full web version of the app).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let record: { token: string; paused: boolean } | null = { token: 'dsk_aaaaaaaaaaaaaaaaaaaaaaaa', paused: false }
let session: string | null = 'session-token'
vi.mock('../../src/main/ai/creditMode', () => ({ SIGNAL_BASE: 'https://api.example.test' }))
vi.mock('../../src/main/db/account', () => ({ loadAccountState: () => ({ sessionToken: session }) }))
vi.mock('../../src/main/db/liveDesks', () => ({
  getLiveDesk: () => record,
  getLiveDeskByToken: () => null,
  listLiveDesks: () => [],
  upsertLiveDesk: () => record,
  recordPublish: () => {},
  recordPublishError: () => {},
  setLiveDeskPaused: () => {},
  removeLiveDesk: () => {},
  recordCheck: () => {}
}))

import { publishLiveBundle } from '../../src/main/livePublisher'

const calls: Array<{ url: string; init: RequestInit }> = []
beforeEach(() => {
  record = { token: 'dsk_aaaaaaaaaaaaaaaaaaaaaaaa', paused: false }
  session = 'session-token'
  calls.length = 0
})
afterEach(() => vi.unstubAllGlobals())

const answer = (status: number, body: unknown): void => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }))
}

describe('sending the desk behind a live link', () => {
  it('PUTs the bundle to the link, with the session', async () => {
    answer(200, { ok: true, bundleUpdatedAt: 1794020461596 })
    expect(await publishLiveBundle('desk-1', '{"format":"plexii.desk"}')).toEqual({ ok: true, bundleUpdatedAt: 1794020461596 })
    expect(calls[0].url).toBe('https://api.example.test/shares/desks/dsk_aaaaaaaaaaaaaaaaaaaaaaaa/bundle')
    expect(calls[0].init.method).toBe('PUT')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer session-token')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ bundle: '{"format":"plexii.desk"}' })
  })

  it('sends nothing for a desk that is not published, is paused, or with nobody signed in', async () => {
    answer(200, {})
    record = null
    expect((await publishLiveBundle('d', '{}')).ok).toBe(false)
    record = { token: 'dsk_x', paused: true }
    expect((await publishLiveBundle('d', '{}')).error).toMatch(/paused/)
    record = { token: 'dsk_x', paused: false }
    session = null
    expect((await publishLiveBundle('d', '{}')).error).toMatch(/Sign in/)
    expect(calls).toHaveLength(0)
  })

  it('a server without the route yet is "not supported", not a failure', async () => {
    answer(404, { message: 'Route PUT:/shares/desks/dsk_x/bundle not found', error: 'Not Found', statusCode: 404 })
    expect(await publishLiveBundle('d', '{}')).toMatchObject({ ok: false, unsupported: true })
  })

  it('says why the server refused', async () => {
    answer(409, { ok: false, error: 'bundle_limit', message: 'This account keeps too many live desks.' })
    expect(await publishLiveBundle('d', '{}')).toEqual({ ok: false, error: 'This account keeps too many live desks.' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await publishLiveBundle('d', '{}')).toEqual({ ok: false, error: 'offline' })
  })
})
