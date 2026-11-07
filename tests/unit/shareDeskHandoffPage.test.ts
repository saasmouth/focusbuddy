// "Download this desk on Plexii" on the share page (src/web/api/deskHandoff.ts)
// and the app's claim (renderer/lib/deskHandoffClient.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const dbCall = vi.fn()
vi.mock('../../src/web/api/dbClient', () => ({ dbCall: (...a: unknown[]) => dbCall(...a) }))

import {
  installerFor, parseInstallers, resetDeskHandoffForTests, sendCopy, serverKeepsHandoffs, visitorPlatform, startDownload,
  loadInstallers
} from '../../src/web/api/deskHandoff'
import { claimOutcome } from '../../src/renderer/src/lib/deskHandoffClient'

const MAC = 'https://dl.plexiidesk.com/v4.3.46/PlexiDesk-4.3.46-mac-universal.dmg'
const WIN = 'https://dl.plexiidesk.com/v4.3.46/PlexiDesk-4.3.46-win-x64.exe'

describe('which installer', () => {
  it('reads the site\'s record, and refuses what is not one', () => {
    expect(parseInstallers({ version: '4.3.46', winVersion: '4.3.45', mac: MAC, windows: WIN, deskHandoff: true }))
      .toEqual({ version: '4.3.46', winVersion: '4.3.45', mac: MAC, windows: WIN, deskHandoff: true })
    expect(parseInstallers({ version: '4.3.46', mac: 'javascript:alert(1)', windows: 'http://x' }))
      .toEqual({ version: '4.3.46', winVersion: '4.3.46', mac: null, windows: null, deskHandoff: false })
    expect(parseInstallers(null)).toBeNull()
    expect(parseInstallers({ mac: MAC })).toBeNull()
  })

  it('knows a Mac, a PC and a phone -- an iPad asking for the desktop site included', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
    expect(visitorPlatform({ userAgent: mac, maxTouchPoints: 0 })).toBe('mac')
    expect(visitorPlatform({ userAgent: mac, maxTouchPoints: 5 })).toBe('phone')
    expect(visitorPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0' })).toBe('windows')
    expect(visitorPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' })).toBe('phone')
    expect(visitorPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile' })).toBe('phone')
    expect(visitorPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' })).toBe('other')
  })

  it('starts nothing where there is nothing to install', () => {
    const inst = { version: '4.3.46', winVersion: '4.3.46', mac: MAC, windows: WIN, deskHandoff: true }
    expect(installerFor('mac', inst)).toBe(MAC)
    expect(installerFor('windows', inst)).toBe(WIN)
    expect(installerFor('phone', inst)).toBeNull()
    expect(installerFor('other', inst)).toBeNull()
    expect(installerFor('mac', null)).toBeNull()
  })

  it('downloads by following a link, so the desk stays on screen', () => {
    const clicked: string[] = []
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.href)
    })
    startDownload(MAC)
    expect(clicked).toEqual([MAC])
    expect(document.querySelectorAll('a').length).toBe(0)
    spy.mockRestore()
  })
})

describe('both ends must be able to carry the desk', () => {
  beforeEach(() => resetDeskHandoffForTests())
  afterEach(() => vi.unstubAllGlobals())

  it('asks the server whether it keeps handoffs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, serverFeatures: ['account_restore', 'desk_handoff'] }))))
    expect(await serverKeepsHandoffs()).toBe(true)
    resetDeskHandoffForTests()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, serverFeatures: ['account_restore'] }))))
    expect(await serverKeepsHandoffs()).toBe(false)
    resetDeskHandoffForTests()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await serverKeepsHandoffs()).toBe(false)
  })

  it('reads the installers from the page\'s own site', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: '4.3.46', mac: MAC, windows: WIN, deskHandoff: false })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await loadInstallers('https://plexiidesk.com')).toMatchObject({ mac: MAC, deskHandoff: false })
    expect(fetchMock.mock.calls[0][0]).toBe('https://plexiidesk.com/app-release.json')
  })
})

describe('sending the visitor\'s copy', () => {
  const src = { token: 'T'.repeat(32), kind: 'use' as const, rootId: 'desk-1', title: 'Day trading' }
  beforeEach(() => {
    resetDeskHandoffForTests()
    localStorage.clear()
    dbCall.mockReset()
    dbCall.mockResolvedValue('{"format":"plexii.desk"}')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('makes a handoff the first time, then updates the same one', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      if (init.method === 'POST') return new Response(JSON.stringify({ id: 'Hx3_kq-9ZpL0aBcD4eFgH1', secret: 's3cr3t', expiresAt: 'x' }), { status: 201 })
      return new Response('{}', { status: 200 })
    }))
    const first = await sendCopy(src)
    expect(first).toEqual({ ok: true, id: 'Hx3_kq-9ZpL0aBcD4eFgH1', link: 'plexii://desk?handoff=Hx3_kq-9ZpL0aBcD4eFgH1' })
    expect(dbCall).toHaveBeenCalledWith('shareCopy:exportDesk', ['desk-1'])
    expect(calls[0]).toMatchObject({ method: 'POST', body: { shareToken: src.token, kind: 'use', title: 'Day trading', bundle: '{"format":"plexii.desk"}' } })
    expect(calls[0].url).toMatch(/\/desk-handoffs$/)

    resetDeskHandoffForTests() // a reload: the record is in localStorage
    const second = await sendCopy(src)
    expect(second).toMatchObject({ ok: true, id: 'Hx3_kq-9ZpL0aBcD4eFgH1' })
    expect(calls[1].method).toBe('PUT')
    expect(calls[1].url).toMatch(/\/desk-handoffs\/Hx3_kq-9ZpL0aBcD4eFgH1$/)
    expect(calls[1].headers['x-handoff-secret']).toBe('s3cr3t')
  })

  it('makes a fresh one when the old one was claimed or is gone', async () => {
    localStorage.setItem(`fb.share.handoff.${src.token}`, JSON.stringify({ id: 'old-handoff-id-0001', secret: 's', sentAt: 1 }))
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      methods.push(String(init.method))
      if (init.method === 'PUT') return new Response('{"error":"already_claimed"}', { status: 409 })
      return new Response(JSON.stringify({ id: 'new-handoff-id-0002', secret: 't' }), { status: 201 })
    }))
    expect(await sendCopy(src)).toMatchObject({ ok: true, id: 'new-handoff-id-0002' })
    expect(methods).toEqual(['PUT', 'POST'])
  })

  it('says why it could not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 413 })))
    expect(await sendCopy(src)).toEqual({ ok: false, why: 'too-large' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 410 })))
    expect(await sendCopy(src)).toEqual({ ok: false, why: 'gone' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })))
    expect(await sendCopy(src)).toEqual({ ok: false, why: 'busy' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await sendCopy(src)).toEqual({ ok: false, why: 'offline' })
    dbCall.mockRejectedValueOnce(new Error('no desk'))
    expect(await sendCopy(src)).toEqual({ ok: false, why: 'failed' })
  })
})

describe('the app claiming it', () => {
  it('imports on 200', () => {
    expect(claimOutcome(200, { title: 'Day trading', bundle: '{}' })).toEqual({ ok: true, title: 'Day trading', bundle: '{}' })
  })

  it('forgets the id only when the handoff itself is over', () => {
    expect(claimOutcome(404, { error: 'unknown_handoff' })).toEqual({ ok: false, kind: 'gone' })
    expect(claimOutcome(410, {})).toEqual({ ok: false, kind: 'gone' })
    expect(claimOutcome(409, { error: 'claimed_elsewhere' })).toEqual({ ok: false, kind: 'elsewhere' })
  })

  it('keeps it when the answer is about the server, not the desk', () => {
    // An older server with no such route answers Fastify's own 404.
    expect(claimOutcome(404, { statusCode: 404, error: 'Not Found', message: 'Route POST:/desk-handoffs/x/claim not found' }))
      .toEqual({ ok: false, kind: 'unavailable' })
    expect(claimOutcome(401, {})).toEqual({ ok: false, kind: 'unauthorized' })
    expect(claimOutcome(503, {})).toEqual({ ok: false, kind: 'unavailable' })
    expect(claimOutcome(200, { title: 'no bundle' })).toEqual({ ok: false, kind: 'unavailable' })
  })
})
