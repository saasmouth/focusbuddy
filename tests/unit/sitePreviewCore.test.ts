// Deciding live / embed / picture / link from one clean visit, and the cache and
// queue around the visits (src/main/sitePreviewCore.ts). The loader is a fake;
// the Electron window it stands in for is exercised by the desktop e2e.
import { describe, it, expect } from 'vitest'
import {
  availableShows,
  checkFromShot,
  createSitePreviewer,
  decideShow,
  viewportFor,
  type PageLoader,
  type PageShot
} from '../../src/main/sitePreviewCore'

const SHARE = 'https://plexiidesk.com'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

function shot(over: Partial<PageShot> = {}): PageShot {
  return { status: 200, headers: {}, finalUrl: 'https://example.com/', title: 'Example', jpeg: JPEG, width: 1440, height: 810, ...over }
}

describe('checkFromShot', () => {
  it('a site that allows framing, with a picture', () => {
    const c = checkFromShot('https://www.eia.gov/petroleum/weekly/', shot({ finalUrl: 'https://www.eia.gov/petroleum/weekly/' }), SHARE, 5)
    expect(c.framing).toBe('allowed')
    expect(c.picture?.bytes).toBe(JPEG)
    expect(c.picture?.capturedAt).toBe(5)
    expect(c.refusal).toBeNull()
    expect(c.host).toBe('eia.gov')
    expect(availableShows(c)).toEqual(['live', 'picture', 'link'])
  })

  it('a site that refuses framing shows as its picture', () => {
    const c = checkFromShot('https://finance.yahoo.com/calendar/earnings', shot({ headers: { 'x-frame-options': ['SAMEORIGIN'] } }), SHARE, 1)
    expect(c.framing).toBe('refused')
    expect(decideShow('auto', c)).toBe('picture')
    expect(decideShow('live', c)).toBe('picture')
  })

  it('a bot wall (401) is no picture, and says why', () => {
    const c = checkFromShot('https://www.reuters.com/x', shot({ status: 401, finalUrl: 'https://www.reuters.com/x' }), SHARE, 1)
    expect(c.picture).toBeNull()
    expect(c.refusal).toMatch(/reuters\.com asked for a human check/)
    expect(c.framing).toBe('unknown')
    expect(decideShow('auto', c)).toBe('link')
    expect(decideShow('picture', c)).toBe('link')
  })

  it('a rate limit that redirected to a captcha page is no picture either', () => {
    const c = checkFromShot(
      'https://news.google.com/search?q=x',
      shot({ status: 429, finalUrl: 'https://www.google.com/sorry/index?continue=x' }),
      SHARE,
      1
    )
    expect(c.picture).toBeNull()
    expect(c.refusal).toMatch(/too many visits/)
  })

  it('a challenge page that answered 200 is caught by its title', () => {
    for (const title of ['Just a moment...', 'Attention Required! | Cloudflare', 'Verifying the device...', 'Are you a robot?']) {
      const c = checkFromShot('https://x.com/', shot({ title }), SHARE, 1)
      expect(c.picture, title).toBeNull()
      expect(c.refusal, title).toMatch(/human check/)
    }
    // An ordinary title that merely contains a word does not trip it.
    expect(checkFromShot('https://x.com/', shot({ title: 'How to verify a business' }), SHARE, 1).picture).not.toBeNull()
  })

  it('no response at all says the page could not be loaded', () => {
    const c = checkFromShot('https://x.invalid/', shot({ status: null, jpeg: null, error: 'ERR_NAME_NOT_RESOLVED' }), SHARE, 1)
    expect(c.refusal).toMatch(/could not be loaded \(ERR_NAME_NOT_RESOLVED\)/)
    expect(availableShows(c)).toEqual(['link'])
  })

  it('an official embed is offered whatever the page itself allows', () => {
    const c = checkFromShot('https://www.tradingview.com/chart/', shot({ headers: { 'content-security-policy': "frame-ancestors 'none'" } }), SHARE, 1)
    expect(c.embed?.provider).toBe('TradingView')
    expect(availableShows(c)).toEqual(['embed', 'picture', 'link'])
    expect(decideShow('auto', c)).toBe('embed')
    expect(decideShow('picture', c)).toBe('picture')
    expect(decideShow('link', c)).toBe('link')
  })
})

describe('the framed look decides live', () => {
  const frame = (over: Partial<import('../../src/main/sitePreviewCore').FramedAnswer> = {}) => ({ status: 200, headers: {}, refused: false, ...over })

  it('a site that answers a frame with X-Frame-Options is refused, though an ordinary visit had none', () => {
    const c = checkFromShot('https://x.com/', shot({ frame: frame({ headers: { 'x-frame-options': 'SAMEORIGIN' } }) }), SHARE, 1)
    expect(c.framing).toBe('refused')
    expect(decideShow('auto', c)).toBe('picture')
  })

  it('the browser reporting the refusal is enough on its own', () => {
    expect(checkFromShot('https://x.com/', shot({ frame: frame({ refused: true }) }), SHARE, 1).framing).toBe('refused')
  })

  it('a frame answered 403 (a bot check, or no frames from strangers) is refused', () => {
    expect(checkFromShot('https://x.com/', shot({ frame: frame({ status: 403 }) }), SHARE, 1).framing).toBe('refused')
    expect(checkFromShot('https://x.com/', shot({ frame: frame({ status: null }) }), SHARE, 1).framing).toBe('refused')
  })

  it('a frame that loads cleanly is live, whatever an ordinary visit said', () => {
    const c = checkFromShot('https://x.com/', shot({ headers: { 'x-frame-options': 'DENY' }, frame: frame() }), SHARE, 1)
    expect(c.framing).toBe('allowed')
    expect(decideShow('auto', c)).toBe('live')
  })

  it('without a framed look (an older loader), the ordinary visit’s headers decide as before', () => {
    expect(checkFromShot('https://x.com/', shot({ headers: { 'x-frame-options': 'DENY' } }), SHARE, 1).framing).toBe('refused')
  })
})

describe('equivalents come after the site itself', () => {
  it('a blocked site with a TradingView equivalent shows the widget before its picture', () => {
    const c = checkFromShot('https://finviz.com/futures', shot({ frame: { status: 200, headers: { 'x-frame-options': 'SAMEORIGIN' }, refused: true } }), SHARE, 1)
    expect(c.equivalent?.label).toBe('TradingView markets board')
    expect(availableShows(c)).toEqual(['embed', 'picture', 'link'])
    expect(decideShow('auto', c)).toBe('embed')
    expect(decideShow('picture', c)).toBe('picture')
  })
  it('a site that frames fine is shown itself, not the widget', () => {
    const c = checkFromShot('https://finviz.com/screener/stocks', shot({ frame: { status: 200, headers: {}, refused: false } }), SHARE, 1)
    expect(availableShows(c)).toEqual(['live', 'picture', 'link'])
  })
})

describe('viewportFor', () => {
  it('is the widget size, held to sizes pages lay out at', () => {
    expect(viewportFor(1418, 797)).toEqual({ width: 1418, height: 797 })
    expect(viewportFor(200, 100)).toEqual({ width: 480, height: 360 })
    expect(viewportFor(5000, 5000)).toEqual({ width: 1600, height: 1200 })
    expect(viewportFor(null, undefined)).toEqual({ width: 1280, height: 800 })
  })
})

describe('createSitePreviewer', () => {
  function countingLoader(delayMs = 0): PageLoader & { calls: string[]; maxParallel: number } {
    let running = 0
    const l = {
      calls: [] as string[],
      maxParallel: 0,
      async shoot(url: string): Promise<PageShot> {
        l.calls.push(url)
        running++
        l.maxParallel = Math.max(l.maxParallel, running)
        await new Promise((r) => setTimeout(r, delayMs))
        running--
        return shot({ finalUrl: url })
      }
    }
    return l
  }
  const vp = { width: 1418, height: 797 }

  it('visits once for the preview and the link that follows', async () => {
    const loader = countingLoader()
    const p = createSitePreviewer(loader)
    const a = await p.check('https://a.com/', vp, SHARE)
    const b = await p.check('https://a.com/', vp, SHARE)
    expect(b).toBe(a)
    expect(loader.calls).toEqual(['https://a.com/'])
    expect(p.peek('https://a.com/', vp, SHARE)).toBe(a)
  })

  it('joins a visit already in flight instead of starting another', async () => {
    const loader = countingLoader(20)
    const p = createSitePreviewer(loader)
    const [a, b] = await Promise.all([p.check('https://a.com/', vp, SHARE), p.check('https://a.com/', vp, SHARE)])
    expect(a).toBe(b)
    expect(loader.calls.length).toBe(1)
  })

  it('visits again when asked to, when the size or origin differs, and once the check is stale', async () => {
    let t = 1_000
    const loader = countingLoader()
    const p = createSitePreviewer(loader, { now: () => t, ttlMs: 100 })
    await p.check('https://a.com/', vp, SHARE)
    await p.check('https://a.com/', vp, SHARE, { force: true })
    await p.check('https://a.com/', { width: 800, height: 600 }, SHARE)
    await p.check('https://a.com/', vp, 'https://other.example')
    expect(loader.calls.length).toBe(4)
    t += 101
    expect(p.peek('https://a.com/', vp, SHARE)).toBeNull()
    await p.check('https://a.com/', vp, SHARE)
    expect(loader.calls.length).toBe(5)
  })

  it('never has more visits running than its concurrency', async () => {
    const loader = countingLoader(10)
    const p = createSitePreviewer(loader, { concurrency: 3 })
    await Promise.all(Array.from({ length: 11 }, (_, i) => p.check(`https://s${i}.com/`, vp, SHARE)))
    expect(loader.calls.length).toBe(11)
    expect(loader.maxParallel).toBe(3)
    expect(p.pending()).toBe(0)
  })

  it('turns a loader that throws into a check that says so, and keeps going', async () => {
    const p = createSitePreviewer({
      async shoot() {
        throw new Error('window gone')
      }
    })
    const c = await p.check('https://a.com/', vp, SHARE)
    expect(c.picture).toBeNull()
    expect(c.refusal).toMatch(/window gone/)
  })

  it('forgets the oldest checks past its size, so pictures do not pile up', async () => {
    const p = createSitePreviewer(countingLoader(), { maxEntries: 2 })
    await p.check('https://1.com/', vp, SHARE)
    await p.check('https://2.com/', vp, SHARE)
    await p.check('https://3.com/', vp, SHARE)
    expect(p.peek('https://1.com/', vp, SHARE)).toBeNull()
    expect(p.peek('https://3.com/', vp, SHARE)).not.toBeNull()
  })
})
