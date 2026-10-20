// Icons for links and connected apps, fetched from the linked site itself.
//
// Until 4.3.34 every link and custom connected app drew its icon from Google's
// favicon service (www.google.com/s2/favicons), which told Google the hostname of
// every site the person had linked, each time an icon rendered. Now the icon
// comes from the site the person chose to link, which the link already implies:
//
//   1. GET <origin>/favicon.ico
//   2. if that is missing, GET <origin>/ and read the page's declared icon
//      (<link rel="icon" | "shortcut icon" | "apple-touch-icon">), following it
//      only when it lives on the same site (the host, a parent of it, or one of
//      its subdomains) or is inline data
//   3. otherwise nothing: the caller shows a neutral glyph.
//
// No cookies or credentials go with these requests (Node's fetch has no cookie
// jar), redirects are followed only within the same site, and responses are
// size-capped and checked to really be images. Results are cached in
// userData/site-icons, so each site is asked at most once a month, and a failure
// is remembered for a week so a dead site is not retried on every render.
//
// Callers that render icons for sites the person did NOT choose (web search
// results in a chat answer) pass network=false: they get a cached icon if the
// person linked that site before, and the neutral glyph otherwise.
//
// Built-in connected apps never reach this module: their logos are bundled
// (renderer/src/lib/appLogos.ts).

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OK_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000
const TIMEOUT_MS = 6000
const MAX_ICON_BYTES = 256 * 1024
const MAX_HTML_BYTES = 256 * 1024
const MAX_REDIRECTS = 3

type CacheEntry = { file: string; mime: string; at: number } | { failed: true; at: number }

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** The origin an icon is looked up for, or null when the URL is not a web page. */
export function iconOriginFor(raw: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (!u.hostname) return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * True when `iconHost` belongs to the same site as `siteHost`: identical, or one
 * is a dot-suffix of the other (www.example.com ↔ example.com ↔ cdn.example.com
 * via the shared parent). A CDN on another domain is refused, because contacting
 * it would tell a third party which site was linked.
 */
export function sameSite(siteHost: string, iconHost: string): boolean {
  const a = siteHost.toLowerCase().replace(/^www\./, '')
  const b = iconHost.toLowerCase().replace(/^www\./, '')
  if (!a || !b) return false
  if (a === b) return true
  return b.endsWith(`.${a}`) || a.endsWith(`.${b}`)
}

/**
 * The icon URLs a page declares, best first (apple-touch-icon is usually the
 * largest, then sized icons by size, then anything else). Relative hrefs resolve
 * against `baseUrl`; data: URIs are kept as they are.
 */
export function parseDeclaredIcons(html: string, baseUrl: string): string[] {
  const found: Array<{ href: string; score: number }> = []
  const linkRe = /<link\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html))) {
    const tag = m[0]
    const rel = attr(tag, 'rel')?.toLowerCase() ?? ''
    if (!/(^|\s)(icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue
    if (/mask-icon/.test(rel)) continue
    const href = attr(tag, 'href')
    if (!href) continue
    let resolved: string
    if (/^data:image\//i.test(href)) resolved = href
    else {
      try {
        resolved = new URL(decodeEntities(href), baseUrl).href
      } catch {
        continue
      }
    }
    const sizes = attr(tag, 'sizes') ?? ''
    const px = Number(/(\d+)x\d+/i.exec(sizes)?.[1] ?? 0)
    const score = rel.includes('apple-touch-icon') ? 1000 + px : px || 16
    found.push({ href: resolved, score })
  }
  return found.sort((x, y) => y.score - x.score).map((f) => f.href)
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = re.exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : null
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/')
}

/** The image type of `buf` by its magic bytes, or null when it is not an image we draw. */
export function sniffImageMime(buf: Uint8Array): string | null {
  const b = buf
  if (b.length < 4) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00)
    return 'image/x-icon'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return 'image/webp'
  const head = Buffer.from(b.subarray(0, Math.min(b.length, 512))).toString('utf8').trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

// ── Network ─────────────────────────────────────────────────────────────────

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > cap) return null
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, cap)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      void reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** GET `url`, following redirects only while they stay on `siteHost`'s site. */
async function getSameSite(
  fetcher: Fetcher,
  url: string,
  siteHost: string,
  accept: string,
  cap: number
): Promise<{ body: Uint8Array; finalUrl: string } | null> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target: URL
    try {
      target = new URL(current)
    } catch {
      return null
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return null
    if (!sameSite(siteHost, target.hostname)) return null
    const res = await fetcher(target.href, {
      redirect: 'manual',
      credentials: 'omit',
      headers: { Accept: accept },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return null
      current = new URL(loc, target.href).href
      continue
    }
    if (!res.ok) return null
    const body = await readCapped(res, cap)
    return body ? { body, finalUrl: target.href } : null
  }
  return null
}

function dataUrlToImage(href: string): { body: Uint8Array; mime: string } | null {
  const m = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(href)
  if (!m) return null
  const body = m[2]
    ? new Uint8Array(Buffer.from(m[3], 'base64'))
    : new Uint8Array(Buffer.from(decodeURIComponent(m[3]), 'utf8'))
  if (body.byteLength > MAX_ICON_BYTES) return null
  const mime = sniffImageMime(body)
  return mime ? { body, mime } : null
}

/**
 * Find an icon for `origin` on the site itself. Contacts only that site (and its
 * own subdomains); returns null when it has none we can draw.
 */
export async function fetchSiteIcon(
  origin: string,
  fetcher: Fetcher = (u, i) => fetch(u, i)
): Promise<{ body: Uint8Array; mime: string } | null> {
  const siteHost = new URL(origin).hostname
  const accept = 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8'
  try {
    const ico = await getSameSite(fetcher, `${origin}/favicon.ico`, siteHost, accept, MAX_ICON_BYTES)
    const icoMime = ico ? sniffImageMime(ico.body) : null
    if (ico && icoMime) return { body: ico.body, mime: icoMime }
  } catch {
    /* fall through to the page's declared icon */
  }
  try {
    const page = await getSameSite(fetcher, `${origin}/`, siteHost, 'text/html', MAX_HTML_BYTES)
    if (!page) return null
    const html = Buffer.from(page.body).toString('utf8')
    for (const href of parseDeclaredIcons(html, page.finalUrl).slice(0, 4)) {
      if (href.startsWith('data:')) {
        const inline = dataUrlToImage(href)
        if (inline) return inline
        continue
      }
      try {
        const got = await getSameSite(fetcher, href, siteHost, accept, MAX_ICON_BYTES)
        const mime = got ? sniffImageMime(got.body) : null
        if (got && mime) return { body: got.body, mime }
      } catch {
        /* try the next declared icon */
      }
    }
  } catch {
    /* no icon */
  }
  return null
}

// ── Cache ───────────────────────────────────────────────────────────────────

let dirCache: string | null = null
let index: Record<string, CacheEntry> | null = null
const inFlight = new Map<string, Promise<string | null>>()

function dir(): string {
  if (!dirCache) {
    dirCache = join(app.getPath('userData'), 'site-icons')
    if (!existsSync(dirCache)) mkdirSync(dirCache, { recursive: true })
  }
  return dirCache
}

function loadIndex(): Record<string, CacheEntry> {
  if (index) return index
  try {
    const raw = readFileSync(join(dir(), 'index.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    index = parsed && typeof parsed === 'object' ? (parsed as Record<string, CacheEntry>) : {}
  } catch {
    index = {}
  }
  return index
}

function saveIndex(): void {
  try {
    writeFileSync(join(dir(), 'index.json'), JSON.stringify(index ?? {}), 'utf8')
  } catch {
    /* the cache is an optimisation; a failed write only means a refetch */
  }
}

function cachedDataUrl(entry: CacheEntry | undefined): string | null {
  if (!entry || 'failed' in entry) return null
  try {
    const body = readFileSync(join(dir(), entry.file))
    return `data:${entry.mime};base64,${body.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * The icon for a linked URL as a data: URL, or null (draw the neutral glyph).
 * With `network` false only the local cache is consulted.
 */
export async function getSiteIcon(rawUrl: string, network: boolean): Promise<string | null> {
  const origin = iconOriginFor(rawUrl)
  if (!origin) return null
  const idx = loadIndex()
  const entry = idx[origin]
  const now = Date.now()
  const cached = cachedDataUrl(entry)
  const fresh = entry && now - entry.at < ('failed' in entry ? FAIL_TTL_MS : OK_TTL_MS)
  if (!network || fresh) return cached
  const pending = inFlight.get(origin)
  if (pending) return pending
  const job = (async (): Promise<string | null> => {
    const got = await fetchSiteIcon(origin)
    if (!got) {
      // Keep a stale icon rather than replacing a working one with a failure.
      if (cached) return cached
      idx[origin] = { failed: true, at: Date.now() }
      saveIndex()
      return null
    }
    const file = `${createHash('sha256').update(origin).digest('hex').slice(0, 32)}.img`
    try {
      writeFileSync(join(dir(), file), got.body)
      idx[origin] = { file, mime: got.mime, at: Date.now() }
      saveIndex()
    } catch {
      /* serve it this once even if it could not be cached */
    }
    return `data:${got.mime};base64,${Buffer.from(got.body).toString('base64')}`
  })().finally(() => inFlight.delete(origin))
  inFlight.set(origin, job)
  return job
}
