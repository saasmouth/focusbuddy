// The desk share tracker's page end (src/web/api/shareTracking.ts): what it
// sends, once or every time, and that nothing it does can throw or wait.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  resetShareTrackingForTests, sendShareEvent, shareSignupUrl, trackDownloadClick, trackShareView, trackUrl, visitorId, type Sender
} from '../../src/web/api/shareTracking'

class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v))
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  clear(): void {
    this.m.clear()
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null
  }
  get length(): number {
    return this.m.size
  }
}

const TOKEN = 'Vis1torTestLink_abcdefghijklmnop'

function recorder(beaconOk = true): { sender: Sender; beacons: Array<{ url: string; body: string }>; fetches: Array<{ url: string; init: RequestInit }> } {
  const beacons: Array<{ url: string; body: string }> = []
  const fetches: Array<{ url: string; init: RequestInit }> = []
  return {
    beacons,
    fetches,
    sender: {
      beacon: (url, body) => {
        beacons.push({ url, body })
        return beaconOk
      },
      fetch: ((url: string, init: RequestInit) => {
        fetches.push({ url, init })
        return Promise.resolve(new Response(null, { status: 204 }))
      }) as unknown as typeof fetch
    }
  }
}

beforeEach(() => {
  resetShareTrackingForTests()
  window.sessionStorage.clear()
})

describe('share tracking', () => {
  it('sends exactly event, visitorId and platform to /share/<token>/track', () => {
    const r = recorder()
    expect(sendShareEvent(TOKEN, 'download_click', 'windows', r.sender)).toBe(true)
    expect(r.beacons).toHaveLength(1)
    expect(r.beacons[0].url).toBe(trackUrl(TOKEN))
    expect(r.beacons[0].url).toMatch(new RegExp(`/share/${TOKEN}/track$`))
    const body = JSON.parse(r.beacons[0].body)
    expect(Object.keys(body).sort()).toEqual(['event', 'platform', 'visitorId'])
    expect(body).toMatchObject({ event: 'download_click', platform: 'windows' })
    expect(body.visitorId).toMatch(/^[0-9a-f]{32}$/)
    expect(r.fetches).toHaveLength(0)
  })

  it('keeps one visitor id per tab session', () => {
    const store = new MemoryStorage() as unknown as Storage
    const a = visitorId(store)
    expect(visitorId(store)).toBe(a)
    expect(visitorId(new MemoryStorage() as unknown as Storage)).not.toBe(a)
  })

  it('a view is sent once per tab session per link; other links count on their own', () => {
    const r = recorder()
    const store = new MemoryStorage() as unknown as Storage
    expect(trackShareView(TOKEN, 'mac', r.sender, store)).toBe(true)
    expect(trackShareView(TOKEN, 'mac', r.sender, store)).toBe(false)
    resetShareTrackingForTests() // a reload: page memory gone, the tab's storage kept
    expect(trackShareView(TOKEN, 'mac', r.sender, store)).toBe(false)
    expect(trackShareView('AnotherLinkAnotherLink0000000000', 'mac', r.sender, store)).toBe(true)
    expect(r.beacons.map((b) => JSON.parse(b.body).event)).toEqual(['view', 'view'])
  })

  it('without storage, the page load is the visit', () => {
    const r = recorder()
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } } as unknown as Storage
    expect(trackShareView(TOKEN, 'phone', r.sender, broken)).toBe(true)
    expect(trackShareView(TOKEN, 'phone', r.sender, broken)).toBe(false)
    expect(r.beacons).toHaveLength(1)
  })

  it('every download click is sent', () => {
    const r = recorder()
    trackDownloadClick(TOKEN, 'mac', r.sender)
    trackDownloadClick(TOKEN, 'mac', r.sender)
    expect(r.beacons).toHaveLength(2)
  })

  it('a beacon the browser will not queue falls back to a keepalive, no-cors, text/plain fetch', () => {
    const r = recorder(false)
    expect(sendShareEvent(TOKEN, 'view', 'mac', r.sender)).toBe(true)
    expect(r.fetches).toHaveLength(1)
    expect(r.fetches[0].init).toMatchObject({ method: 'POST', mode: 'no-cors', credentials: 'omit', keepalive: true, headers: { 'content-type': 'text/plain' } })
    expect(JSON.parse(String(r.fetches[0].init.body)).event).toBe('view')
  })

  it('never throws: a beacon that throws, a fetch that rejects, no way to send at all', async () => {
    const throwing: Sender = {
      beacon: () => { throw new Error('beacon blew up') },
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    }
    expect(() => trackDownloadClick(TOKEN, 'mac', throwing)).not.toThrow()
    expect(sendShareEvent(TOKEN, 'view', 'mac', { beacon: null, fetch: null })).toBe(false)
    const fetchThrows: Sender = { beacon: () => false, fetch: (() => { throw new Error('sync throw') }) as unknown as typeof fetch }
    expect(() => sendShareEvent(TOKEN, 'view', 'mac', fetchThrows)).not.toThrow()
    await new Promise((r) => setTimeout(r, 0)) // a rejected fetch is not an unhandled rejection
  })

  it('the sign-up link carries the link it starts from, and only that', () => {
    expect(shareSignupUrl(TOKEN, 'https://plexiidesk.com')).toBe(`https://plexiidesk.com/account/signup?share=${TOKEN}`)
    expect(shareSignupUrl('a/b?c', 'https://plexiidesk.com/')).toBe('https://plexiidesk.com/account/signup?share=a%2Fb%3Fc')
  })
})
