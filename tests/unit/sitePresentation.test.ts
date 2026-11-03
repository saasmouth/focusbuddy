// The pure rules behind how a shared desk presents its websites and its view
// (src/shared/sitePresentation.ts). The header values below are the real ones
// the sites on a live standing link sent on 2026-11-03.
import { describe, it, expect } from 'vitest'
import {
  frameVerdict,
  officialEmbedFor,
  pictureRefusal,
  readPresentation,
  siteEntryFor,
  sitePictureId,
  isWebsiteWidget,
  VISITOR_LAYOUT_USER
} from '../../src/shared/sitePresentation'

const SHARE = 'https://plexiidesk.com'

describe('frameVerdict', () => {
  it('allows a page that says nothing about framing (eia.gov)', () => {
    expect(frameVerdict({ 'content-type': 'text/html' }, SHARE)).toBe('allowed')
  })

  it('refuses X-Frame-Options SAMEORIGIN and DENY, in any case and as a list', () => {
    expect(frameVerdict({ 'x-frame-options': 'SAMEORIGIN' }, SHARE)).toBe('refused')
    expect(frameVerdict({ 'X-Frame-Options': ['deny'] }, SHARE)).toBe('refused')
    expect(frameVerdict({ 'x-frame-options': 'SAMEORIGIN, SAMEORIGIN' }, SHARE)).toBe('refused')
  })

  it('ignores ALLOW-FROM, which browsers do not support', () => {
    expect(frameVerdict({ 'x-frame-options': 'ALLOW-FROM https://plexiidesk.com' }, SHARE)).toBe('allowed')
  })

  it("refuses frame-ancestors 'none' (tradingview.com/chart) and 'self' (reuters.com)", () => {
    expect(frameVerdict({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }, SHARE)).toBe('refused')
    expect(frameVerdict({ 'content-security-policy': "frame-ancestors 'self'" }, SHARE)).toBe('refused')
  })

  it("refuses a list that names other hosts only (finance.yahoo.com's)", () => {
    const csp = "frame-ancestors 'self' https://*.yahoo.com https://*.aol.com https://*.techcrunch.com"
    expect(frameVerdict({ 'content-security-policy': csp, 'x-frame-options': 'SAMEORIGIN' }, SHARE)).toBe('refused')
  })

  it('allows *, an https: scheme source, and a host source naming the share origin', () => {
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors *' }, SHARE)).toBe('allowed')
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors https:' }, SHARE)).toBe('allowed')
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors https://plexiidesk.com' }, SHARE)).toBe('allowed')
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors plexiidesk.com' }, SHARE)).toBe('allowed')
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors https://plexiidesk.com:443' }, SHARE)).toBe('allowed')
  })

  it('matches a wildcard host only on a subdomain, and checks scheme and port', () => {
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors https://*.plexiidesk.com' }, SHARE)).toBe('refused')
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors https://*.plexiidesk.com' }, 'https://www.plexiidesk.com')).toBe('allowed')
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors http://plexiidesk.com' }, SHARE)).toBe('refused')
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors https://plexiidesk.com:8443' }, SHARE)).toBe('refused')
  })

  it('lets frame-ancestors decide over X-Frame-Options, as browsers do', () => {
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }, SHARE)).toBe('allowed')
  })

  it('needs every policy that has frame-ancestors to allow', () => {
    expect(frameVerdict({ 'content-security-policy': ['frame-ancestors *', "frame-ancestors 'self'"] }, SHARE)).toBe('refused')
    expect(frameVerdict({ 'content-security-policy': "frame-ancestors *, frame-ancestors 'none'" }, SHARE)).toBe('refused')
  })

  it('does not enforce a Report-Only policy', () => {
    expect(frameVerdict({ 'content-security-policy-report-only': "frame-ancestors 'none'" }, SHARE)).toBe('allowed')
  })

  it('treats an empty source list as none', () => {
    expect(frameVerdict({ 'content-security-policy': 'frame-ancestors' }, SHARE)).toBe('refused')
  })
})

describe('officialEmbedFor', () => {
  it('turns YouTube watch, short, live, youtu.be and playlist addresses into the no-cookie player', () => {
    expect(officialEmbedFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
    expect(officialEmbedFor('https://youtu.be/dQw4w9WgXcQ?t=90')?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90')
    expect(officialEmbedFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90')
    expect(officialEmbedFor('https://m.youtube.com/shorts/dQw4w9WgXcQ')?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
    expect(officialEmbedFor('https://www.youtube.com/playlist?list=PL1234567890ab')?.embedUrl).toBe(
      'https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890ab'
    )
    expect(officialEmbedFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.provider).toBe('YouTube')
  })

  it('refuses a YouTube address whose id is not an id', () => {
    expect(officialEmbedFor('https://www.youtube.com/watch?v=<script>')).toBeNull()
    expect(officialEmbedFor('https://www.youtube.com/channel/UC123')).toBeNull()
  })

  it('handles Vimeo (with an unlisted hash), Loom and Spotify', () => {
    expect(officialEmbedFor('https://vimeo.com/76979871')?.embedUrl).toBe('https://player.vimeo.com/video/76979871')
    expect(officialEmbedFor('https://vimeo.com/76979871/abc123def0')?.embedUrl).toBe('https://player.vimeo.com/video/76979871?h=abc123def0')
    expect(officialEmbedFor('https://www.loom.com/share/e5b8c04bca094dd8a5507925ab887002')?.embedUrl).toBe(
      'https://www.loom.com/embed/e5b8c04bca094dd8a5507925ab887002'
    )
    expect(officialEmbedFor('https://open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M')?.embedUrl).toBe(
      'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M'
    )
  })

  it("gives TradingView's chart widget, with the address's symbol when it names one", () => {
    const bare = officialEmbedFor('https://www.tradingview.com/chart/')
    expect(bare?.provider).toBe('TradingView')
    expect(bare?.embedUrl.startsWith('https://s.tradingview.com/widgetembed/?')).toBe(true)
    expect(new URL(bare!.embedUrl).searchParams.get('symbol')).toBeNull()
    const sym = officialEmbedFor('https://www.tradingview.com/chart/AbCd1234/?symbol=NASDAQ%3AAAPL')
    expect(new URL(sym!.embedUrl).searchParams.get('symbol')).toBe('NASDAQ:AAPL')
    const page = officialEmbedFor('https://www.tradingview.com/symbols/BINANCE-BTCUSDT/')
    expect(new URL(page!.embedUrl).searchParams.get('symbol')).toBe('BINANCE:BTCUSDT')
    // A symbol that is not one is left out rather than passed on.
    const odd = officialEmbedFor('https://www.tradingview.com/chart/?symbol=%22%3E%3Cscript%3E')
    expect(new URL(odd!.embedUrl).searchParams.get('symbol')).toBeNull()
    expect(officialEmbedFor('https://www.tradingview.com/ideas/')).toBeNull()
  })

  it('offers nothing for other sites, plain http, or addresses that are already embeds', () => {
    expect(officialEmbedFor('https://finviz.com/futures')).toBeNull()
    expect(officialEmbedFor('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(officialEmbedFor('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBeNull()
    expect(officialEmbedFor('javascript:alert(1)')).toBeNull()
    expect(officialEmbedFor('')).toBeNull()
  })
})

describe('pictureRefusal', () => {
  it('passes an ordinary answer and names each kind of refusal', () => {
    expect(pictureRefusal(200, 'eia.gov')).toBeNull()
    expect(pictureRefusal(304, 'eia.gov')).toBeNull()
    expect(pictureRefusal(null, 'eia.gov')).toBeNull()
    expect(pictureRefusal(401, 'reuters.com')).toMatch(/human check/)
    expect(pictureRefusal(403, 'coingecko.com')).toMatch(/human check/)
    expect(pictureRefusal(429, 'finviz.com')).toMatch(/too many visits/)
    expect(pictureRefusal(404, 'x.com')).toMatch(/does not exist/)
    expect(pictureRefusal(503, 'x.com')).toMatch(/problem/)
    expect(pictureRefusal(418, 'x.com')).toMatch(/418/)
  })
})

describe('website widgets and picture ids', () => {
  it('counts website kinds with a web address, and nothing else', () => {
    expect(isWebsiteWidget({ kind: 'webview', content: 'https://finviz.com' })).toBe(true)
    expect(isWebsiteWidget({ kind: 'gdoc', content: 'https://docs.google.com/document/d/x' })).toBe(true)
    expect(isWebsiteWidget({ kind: 'webview', content: '' })).toBe(false)
    expect(isWebsiteWidget({ kind: 'pdf', content: 'https://example.com/a.pdf' })).toBe(false)
    expect(isWebsiteWidget({ kind: 'sticky', content: 'https://example.com' })).toBe(false)
  })

  it('derives a picture id from the widget, refusing ids the file store would not take', () => {
    expect(sitePictureId('0a705cec-48ec-4390-b628-1fae4abcbbd1')).toBe('sitepic-0a705cec-48ec-4390-b628-1fae4abcbbd1')
    expect(sitePictureId('../etc')).toBeNull()
    expect(sitePictureId('a.html')).toBeNull()
  })

  it("is 'local' for visitors, matching the renderer's fallback", () => {
    expect(VISITOR_LAYOUT_USER).toBe('local')
  })
})

describe('readPresentation (a stranger made the link)', () => {
  const W = 'w-1'
  const good = {
    view: 'workcentre',
    lockView: true,
    columns: { groupBy: 'kind', columns: [], assign: {}, order: {} },
    sites: {
      [W]: { url: 'https://finviz.com/futures', show: 'picture', picture: { id: `sitepic-${W}`, width: 1440, height: 810, capturedAt: 1_700_000_000_000 } },
      'w-2': { url: 'https://www.eia.gov/petroleum/weekly/', show: 'live' }
    }
  }

  it('keeps a well-formed presentation', () => {
    const p = readPresentation(good, new Set([W, 'w-2']))
    expect(p?.view).toBe('workcentre')
    expect(p?.lockView).toBe(true)
    expect(p?.columns).toEqual(good.columns)
    expect(p?.sites?.[W]?.show).toBe('picture')
    expect(p?.sites?.[W]?.picture?.id).toBe(`sitepic-${W}`)
    expect(p?.sites?.['w-2']?.show).toBe('live')
  })

  it("drops entries for widgets the bundle does not bring", () => {
    const p = readPresentation(good, new Set([W]))
    expect(p?.sites?.['w-2']).toBeUndefined()
  })

  it("turns a picture pointed at another widget's id (or a Drive file) into a link card", () => {
    const p = readPresentation(
      { sites: { [W]: { url: 'https://finviz.com', show: 'picture', picture: { id: 'sitepic-other', width: 1, height: 1, capturedAt: 1 } } } },
      new Set([W])
    )
    expect(p?.sites?.[W]).toEqual({ url: 'https://finviz.com/', show: 'link' })
  })

  it('drops non-web addresses, unknown shows, bad views and a lock without a view', () => {
    const p = readPresentation(
      {
        view: 'kanban',
        lockView: true,
        sites: {
          a: { url: 'javascript:alert(1)', show: 'live' },
          b: { url: 'https://x.com', show: 'teleport' }
        }
      },
      null
    )
    expect(p).toBeNull()
  })

  it('drops an oversized columns setup and a non-object one', () => {
    const big = { groupBy: 'freeform', columns: Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, title: 'x'.repeat(20) })) }
    expect(readPresentation({ view: 'columns', columns: big }, null)?.columns).toBeUndefined()
    expect(readPresentation({ view: 'columns', columns: [1, 2] }, null)?.columns).toBeUndefined()
  })

  it('reads nothing from things that are not presentations', () => {
    expect(readPresentation(null, null)).toBeNull()
    expect(readPresentation('workcentre', null)).toBeNull()
    expect(readPresentation([], null)).toBeNull()
  })
})

describe('siteEntryFor', () => {
  const p = readPresentation({ sites: { w: { url: 'https://finviz.com/futures', show: 'link' } } }, null)
  it('covers the widget only while it still points where the entry was made for', () => {
    expect(siteEntryFor(p, { id: 'w', content: 'https://finviz.com/futures' })?.show).toBe('link')
    expect(siteEntryFor(p, { id: 'w', content: 'https://finviz.com/news.php' })).toBeNull()
    expect(siteEntryFor(p, { id: 'other', content: 'https://finviz.com/futures' })).toBeNull()
    expect(siteEntryFor(null, { id: 'w', content: 'https://finviz.com/futures' })).toBeNull()
  })
})
