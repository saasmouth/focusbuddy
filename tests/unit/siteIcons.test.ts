// @vitest-environment node
// Link and connected-app icons come from the linked site itself (4.3.34). Until
// then every icon went through www.google.com/s2/favicons, which told Google the
// hostname of every linked site. These tests hold three lines:
//   1. no renderer code names a third-party favicon service again;
//   2. the fetcher contacts only the linked site (and its own subdomains),
//      follows redirects only within it, and never sends credentials;
//   3. what it returns is really an image, and a site with none gives null.

import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))

import {
  fetchSiteIcon,
  iconOriginFor,
  parseDeclaredIcons,
  sameSite,
  sniffImageMime,
  type Fetcher
} from '../../src/main/siteIcons'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10])

function res(status: number, body: Uint8Array | string = '', headers: Record<string, string> = {}): Response {
  const b = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return new Response(status >= 300 && status < 400 ? null : b, { status, headers })
}

function recordingFetcher(routes: Record<string, () => Response>): { f: Fetcher; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init })
    const r = routes[url]
    return r ? r() : res(404)
  }
  return { f, calls }
}

describe('no third-party favicon service anywhere in the app', () => {
  it('src/ never names Google s2 favicons, gstatic favicons, DuckDuckGo icons or icon.horse', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(tsx?|html|css)$/.test(name)) {
          const src = readFileSync(p, 'utf8')
          // Comments may tell the history; code may not call the service.
          const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
          if (/google\.com\/s2\/favicons|gstatic\.com\/favicon|icons\.duckduckgo\.com|icon\.horse|favicon\.yandex/.test(code))
            offenders.push(p)
        }
      }
    }
    walk(join(__dirname, '..', '..', 'src'))
    expect(offenders).toEqual([])
  })
})

describe('iconOriginFor', () => {
  it('keeps the scheme and host of web URLs and refuses anything else', () => {
    expect(iconOriginFor('https://www.example.com/a/b?c')).toBe('https://www.example.com')
    expect(iconOriginFor('http://intranet.local:8080/x')).toBe('http://intranet.local:8080')
    expect(iconOriginFor('example.org/path')).toBe('https://example.org')
    expect(iconOriginFor('file:///etc/passwd')).toBeNull()
    expect(iconOriginFor('javascript:alert(1)')).toBeNull()
    expect(iconOriginFor('')).toBeNull()
  })
})

describe('sameSite', () => {
  it('accepts the host, www, parents and subdomains; refuses other domains', () => {
    expect(sameSite('example.com', 'example.com')).toBe(true)
    expect(sameSite('www.example.com', 'example.com')).toBe(true)
    expect(sameSite('example.com', 'static.example.com')).toBe(true)
    expect(sameSite('app.example.com', 'example.com')).toBe(true)
    expect(sameSite('example.com', 'cdn.other.com')).toBe(false)
    expect(sameSite('example.com', 'notexample.com')).toBe(false)
    expect(sameSite('example.com', 'example.com.evil.net')).toBe(false)
  })
})

describe('parseDeclaredIcons', () => {
  it('orders apple-touch-icon first, then by size, and resolves relative hrefs', () => {
    const html = `
      <link rel="icon" href="/small.png" sizes="16x16">
      <link rel="icon" type="image/png" href="big.png" sizes="192x192">
      <link href="https://example.com/apple.png" rel="apple-touch-icon">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="stylesheet" href="/x.css">`
    expect(parseDeclaredIcons(html, 'https://example.com/dir/')).toEqual([
      'https://example.com/apple.png',
      'https://example.com/dir/big.png',
      'https://example.com/small.png'
    ])
  })
})

describe('sniffImageMime', () => {
  it('recognises the formats we draw and nothing else', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(ICO)).toBe('image/x-icon')
    expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
    expect(sniffImageMime(new TextEncoder().encode('<!doctype html><html>'))).toBeNull()
  })
})

describe('fetchSiteIcon', () => {
  it('takes /favicon.ico from the site itself, without credentials, and asks nobody else', async () => {
    const { f, calls } = recordingFetcher({ 'https://example.com/favicon.ico': () => res(200, ICO) })
    const got = await fetchSiteIcon('https://example.com', f)
    expect(got?.mime).toBe('image/x-icon')
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/favicon.ico'])
    expect(calls[0].init.credentials).toBe('omit')
    expect(calls[0].init.redirect).toBe('manual')
  })

  it('falls back to the page’s declared icon on the same site', async () => {
    const { f, calls } = recordingFetcher({
      'https://example.com/': () => res(200, '<link rel="icon" href="/static/i.png">'),
      'https://example.com/static/i.png': () => res(200, PNG)
    })
    const got = await fetchSiteIcon('https://example.com', f)
    expect(got?.mime).toBe('image/png')
    expect(calls.every((c) => new URL(c.url).hostname === 'example.com')).toBe(true)
  })

  it('never follows a declared icon or a redirect to another domain', async () => {
    const { f, calls } = recordingFetcher({
      'https://example.com/favicon.ico': () => res(302, '', { location: 'https://tracker.net/fav.ico' }),
      'https://example.com/': () => res(200, '<link rel="icon" href="https://cdn.other.com/i.png">')
    })
    expect(await fetchSiteIcon('https://example.com', f)).toBeNull()
    const hosts = new Set(calls.map((c) => new URL(c.url).hostname))
    expect([...hosts]).toEqual(['example.com'])
  })

  it('follows a redirect that stays on the site', async () => {
    const { f } = recordingFetcher({
      'https://example.com/favicon.ico': () => res(301, '', { location: 'https://www.example.com/favicon.ico' }),
      'https://www.example.com/favicon.ico': () => res(200, PNG)
    })
    expect((await fetchSiteIcon('https://example.com', f))?.mime).toBe('image/png')
  })

  it('refuses a "favicon" that is not an image, and an oversized one', async () => {
    const big = new Uint8Array(300 * 1024)
    big.set(PNG)
    const { f } = recordingFetcher({
      'https://example.com/favicon.ico': () => res(200, '<html>not found page</html>'),
      'https://example.com/': () => res(200, '<link rel="icon" href="/huge.png">'),
      'https://example.com/huge.png': () => res(200, big)
    })
    expect(await fetchSiteIcon('https://example.com', f)).toBeNull()
  })

  it('accepts an inline data: icon without any further request', async () => {
    const b64 = Buffer.from(PNG).toString('base64')
    const { f, calls } = recordingFetcher({
      'https://example.com/': () => res(200, `<link rel="icon" href="data:image/png;base64,${b64}">`)
    })
    expect((await fetchSiteIcon('https://example.com', f))?.mime).toBe('image/png')
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/favicon.ico', 'https://example.com/'])
  })

  it('a network failure is null, not a throw', async () => {
    const f: Fetcher = async () => {
      throw new Error('offline')
    }
    await expect(fetchSiteIcon('https://example.com', f)).resolves.toBeNull()
  })
})
