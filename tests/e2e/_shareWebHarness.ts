// A public share page, opened as a visitor would open it, with nothing leaving
// this machine.
//
// The share page is the web build (out/web, built with VITE_WEB_BASE=/share/
// as the site builds it). It is served here at its real address
// (https://plexiidesk.com/share/...), Signal's answers for one link come from a
// fixture desk, the site's installer record is answered locally, and the
// installer itself is a few bytes. Every other request is refused and recorded,
// so a test can say "nothing reached the real world".
//
// Headless Chromium, its own profile, service workers blocked (a worker-served
// request would bypass these routes and fetch the live files) -- nothing on the
// owner's screen.
import { chromium, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { ACTIVE } from '../../src/shared/productDomains'

export const WEB_OUT = join(__dirname, '..', '..', 'out', 'web')
export const SITE = 'https://plexiidesk.com'
export const TOKEN = 'Vis1torTestLink_abcdefghijklmnop'.slice(0, 32)
export const MAC_INSTALLER = 'https://dl.plexiidesk.com/v4.3.46/PlexiDesk-4.3.46-mac-universal.dmg'
export const DESK_ID = 'd0d0d0d0-0000-4000-8000-000000000001'
export const STICKY_ID = 'd0d0d0d0-0000-4000-8000-000000000002'
export const NOTE_ID = 'd0d0d0d0-0000-4000-8000-000000000003'
/** A live web view link (view.plexiidesk.com/share/dsk_…), opened at /share/l/<token>. */
export const LIVE_TOKEN = 'dsk_80375edef54b39e65855eb11f6d882cb7aacfcad'
export const LIVE_NOTE_ID = 'd0d0d0d0-0000-4000-8000-000000000009'

const NOW = 1_762_400_000_000
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

/** The desk the link shares: a sender's day-trading desk with two notes (and, when `extra`, a third). */
export function fixtureBundle(extra?: string): string {
  const node = {
    id: DESK_ID, parent_id: null, kind: 'task', title: 'Day trading desk', description: '', status: 'open',
    priority: 3, interest: 3, importance: 3, sort_order: 0, created_at: NOW, updated_at: NOW,
    extensions_minutes: 0, org_id: 'personal'
  }
  const widget = (id: string, content: string, x: number) => ({
    id, task_id: DESK_ID, kind: 'sticky', title: '', content, x, y: 80, width: 240, height: 180, z_index: 1,
    created_at: NOW, updated_at: NOW
  })
  return JSON.stringify({
    format: 'plexii.desk',
    formatVersion: 1,
    exportedAt: new Date(NOW).toISOString(),
    desk: { id: DESK_ID, title: 'Day trading desk' },
    counts: { nodes: 1, widgets: 2 },
    tables: {
      nodes: [node],
      widgets: [
        widget(STICKY_ID, 'Watch AAPL at the open', 120),
        widget(NOTE_ID, 'Risk 1% per trade', 420),
        ...(extra ? [widget(LIVE_NOTE_ID, extra, 720)] : [])
      ],
      widget_links: [], fb_tables: [], fb_rows: [], documents: [], fb_files: [], desk_layouts: []
    },
    files: [],
    filesOmitted: []
  })
}

export interface Handoff {
  method: string
  body: { shareToken?: string; kind?: string; title?: string; bundle?: string }
  secret?: string
}

export interface ShareWeb {
  browser: Browser
  context: BrowserContext
  page: Page
  /** Installer downloads the page started. */
  downloads: string[]
  /** Handoffs the page sent Signal (POST and PUT). */
  handoffs: Handoff[]
  /** Requests that would have left this machine, refused. */
  escaped: string[]
  /** Page errors (uncaught exceptions). */
  errors: string[]
  close: () => Promise<void>
  /** Play the sender of the live link changing the desk: a newer version, with this note on it. */
  bumpLive: (note: string) => void
  /** The gates the page opened: what was tried, and through which channel. */
  gates: () => Promise<Array<{ what: string; channel: string | null }>>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.map': 'application/json'
}

/** Fail loudly rather than test yesterday's page (e2e runs the last build). */
export function assertWebBuild(): void {
  const index = join(WEB_OUT, 'index.html')
  if (!existsSync(index)) {
    throw new Error('out/web is missing: build the share page first with  VITE_WEB_BASE=/share/ npm run web:build')
  }
  const built = statSync(index).mtimeMs
  for (const f of ['src/web/boot.tsx', 'src/web/api/readOnly.ts', 'src/web/api/shareGate.ts', 'src/web/api/deskHandoff.ts', 'src/renderer/src/App.tsx']) {
    const p = join(__dirname, '..', '..', f)
    if (existsSync(p) && statSync(p).mtimeMs > built) {
      throw new Error(`out/web is older than ${f}: rebuild with  VITE_WEB_BASE=/share/ npm run web:build`)
    }
  }
}

export async function openShareWeb(opts: {
  deskHandoff?: boolean
  serverHandoff?: boolean
  userAgent?: string
  /** False: the live link's sender has not sent the desk yet (bundleUpdatedAt null). */
  liveBundle?: boolean
} = {}): Promise<ShareWeb> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    serviceWorkers: 'block',
    acceptDownloads: true,
    userAgent: opts.userAgent ?? MAC_UA,
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()
  const out: ShareWeb = {
    browser, context, page, downloads: [], handoffs: [], escaped: [], errors: [],
    close: async () => { await browser.close() },
    bumpLive: (note: string) => {
      live.version += 1000
      live.note = note
    },
    gates: () =>
      page.evaluate(() => {
        const f = (window as unknown as { plexiiShareGates?: () => Array<{ what: string; channel: string | null }> }).plexiiShareGates
        return f ? f().map((g) => ({ what: g.what, channel: g.channel })) : []
      })
  }
  page.on('pageerror', (e) => out.errors.push(String(e?.message ?? e)))

  const api = new URL(ACTIVE.api).origin
  const offer = { title: 'Day trading desk', expiresAt: null, updatedAt: NOW, sizeBytes: 2048, rootId: DESK_ID }
  let handoffCount = 0
  const live = { version: NOW + 1000, note: null as string | null }

  await context.route('**/*', async (route) => {
    const req: Request = route.request()
    const url = new URL(req.url())
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (url.origin === SITE && url.pathname.startsWith('/share/')) {
      const rel = normalize(decodeURIComponent(url.pathname.slice('/share/'.length))).replace(/^(\.\.[/\\])+/, '')
      const file = join(WEB_OUT, rel)
      if (rel && existsSync(file) && statSync(file).isFile()) {
        return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
      }
      return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(WEB_OUT, 'index.html')) })
    }
    if (url.origin === SITE && url.pathname === '/app-release.json') {
      return json(200, { version: '4.3.46', winVersion: '4.3.46', mac: MAC_INSTALLER, windows: 'https://dl.plexiidesk.com/v4.3.46/PlexiDesk-4.3.46-win-x64.exe', deskHandoff: opts.deskHandoff ?? true })
    }
    if (url.hostname === 'dl.plexiidesk.com') {
      out.downloads.push(url.href)
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/x-apple-diskimage', 'content-disposition': 'attachment; filename="PlexiDesk.dmg"' },
        body: 'not really an installer'
      })
    }
    if (url.origin === api) {
      if (url.pathname === `/public/shares/${TOKEN}`) return json(200, { ok: true, share: offer })
      if (url.pathname === `/public/shares/${TOKEN}/bundle`) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: fixtureBundle() })
      }
      if (url.pathname === `/share/${LIVE_TOKEN}`) {
        return json(200, {
          ok: true,
          record: {
            token: LIVE_TOKEN, kind: 'desk', title: 'Day trading desk', revoked: false, scope: 'view',
            fromHandle: 'SaaSMouth', createdAt: NOW, expiresAt: null, viewCount: 0,
            bundleUpdatedAt: opts.liveBundle === false ? null : live.version
          }
        })
      }
      if (url.pathname === `/share/${LIVE_TOKEN}/desk/bundle`) {
        if (opts.liveBundle === false) return json(404, { ok: false, error: 'no_bundle' })
        return route.fulfill({ status: 200, contentType: 'application/json', body: fixtureBundle(live.note ?? undefined) })
      }
      if (url.pathname === '/public/server-features') {
        return json(200, { ok: true, serverFeatures: opts.serverHandoff === false ? [] : ['desk_handoff'] })
      }
      if (url.pathname === '/desk-handoffs' && req.method() === 'POST') {
        handoffCount++
        out.handoffs.push({ method: 'POST', body: JSON.parse(req.postData() ?? '{}') })
        return json(201, { id: `HandoffForTest_${String(handoffCount).padStart(8, '0')}`, secret: 'test-secret', expiresAt: new Date(NOW + 30 * 864e5).toISOString() })
      }
      if (url.pathname.startsWith('/desk-handoffs/') && req.method() === 'PUT') {
        out.handoffs.push({ method: 'PUT', body: JSON.parse(req.postData() ?? '{}'), secret: req.headers()['x-handoff-secret'] })
        return json(200, { ok: true })
      }
      out.escaped.push(`${req.method()} ${url.href}`)
      return json(503, { ok: false, error: 'unavailable' })
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
    out.escaped.push(`${req.method()} ${url.href}`)
    return route.abort('blockedbyclient')
  })
  return out
}

/** Open the link and the desk, the way a visitor does. */
export async function openTheDesk(web: ShareWeb, path: string = `/share/s/${TOKEN}`): Promise<void> {
  const { page } = web
  await page.goto(`${SITE}${path}`)
  await page.getByRole('button', { name: 'Open the desk' }).click({ timeout: 60_000 })
  await page.locator('[data-testid="share-take-desk"]').waitFor({ timeout: 90_000 })
  await page.locator(`[data-widget-id="${STICKY_ID}"]`).first().waitFor({ timeout: 60_000 })
}
