// What a visitor's browser asks of the network on a desk share link (d0,
// 2026-11-20).
//
// The share page asked http://localhost:11434/api/tags, Plexii's Ollama check,
// from the visitor's own browser. A visitor who dragged a calculator onto the
// desk they were sent made a work widget file; saving a file embeds it for
// search, and with no key and Background AI tasks off the embedder asks for a
// model on the visitor's computer. A public page probing a visitor's local
// network is wrong: it is not disclosed, and newer Chrome asks the visitor for
// permission to reach their local network. The browser runtime now has no
// local-model client at all (vite.web.config.ts MODULE_SWAPS,
// src/web/worker/main/localModel.ts).
//
// These open a link on the built app with every request watched, the Worker's
// included. The link's own calls to Signal (its preview, the visit count and
// the bundle) are answered here from fixtures, made by Plexii's own
// buildDeskBundle and served by a real Signal for this desk; everything else
// off the page is recorded and refused, so these tests reach no server.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'

const ORIGIN = 'http://127.0.0.1:5193'
const OUT = join(__dirname, '../../out/web')
// A token in the shape Signal mints (32 base64url characters).
const TOKEN = 'SharePageNetworkProbeToken000001'
const PREVIEW = JSON.stringify(JSON.parse(readFileSync(join(__dirname, 'fixtures/share-preview.json'), 'utf8')))
const BUNDLE = JSON.stringify(JSON.parse(readFileSync(join(__dirname, 'fixtures/share-desk.json'), 'utf8')))

interface Seen {
  /** Requests to the app's own server. */
  local: URL[]
  /** The link's calls to Signal, answered here: preview, track, bundle. */
  signal: string[]
  /** Everything else: refused. */
  off: Array<{ method: string; url: URL }>
  last: () => number
}

/** Every request in the context, the Worker's included. */
async function watch(context: BrowserContext): Promise<Seen> {
  const seen: Seen = { local: [], signal: [], off: [], last: () => at }
  let at = Date.now()
  await context.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    at = Date.now()
    if (u.origin === ORIGIN) {
      seen.local.push(u)
      return route.continue()
    }
    const json = (body: string): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body })
    if (req.method() === 'GET' && u.pathname === `/public/shares/${TOKEN}`) {
      seen.signal.push('preview')
      return json(PREVIEW)
    }
    if (req.method() === 'GET' && u.pathname === `/public/shares/${TOKEN}/bundle`) {
      seen.signal.push('bundle')
      return json(BUNDLE)
    }
    if (req.method() === 'POST' && u.pathname === `/share/${TOKEN}/track`) {
      seen.signal.push('track')
      return json('{"ok":true}')
    }
    seen.off.push({ method: req.method(), url: u })
    return route.abort('blockedbyclient')
  })
  return seen
}

async function settle(seen: Seen): Promise<void> {
  // At least 2.5 s, and 1.5 s with no new request. Before the fix the Ollama
  // check came within a quarter of a second of the drop.
  const from = Date.now()
  await expect.poll(() => Date.now() - from >= 2500 && Date.now() - seen.last() >= 1500, { timeout: 20_000, intervals: [250] }).toBe(true)
}

async function openDesk(page: Page): Promise<void> {
  await page.goto(`/s/${TOKEN}`)
  await page.getByRole('button', { name: 'Open the desk' }).click()
  await expect(page.getByText('your copy, in this browser only')).toBeVisible()
  await expect(page.getByText('Buy milk', { exact: true })).toBeVisible()
}

const offPage = (seen: Seen): string[] => seen.off.filter((r) => !['data:', 'blob:'].includes(r.url.protocol)).map((r) => `${r.method} ${r.url.origin}${r.url.pathname}`)

test('opening a desk link: the link\'s own calls, and nothing else off the page', async ({ page, context }) => {
  const seen = await watch(context)
  await openDesk(page)
  await settle(seen)
  // The watch sees the Worker: it fetches SQLite's WebAssembly.
  expect(seen.local.some((u) => u.pathname.endsWith('.wasm'))).toBe(true)
  expect([...new Set(seen.signal)].sort()).toEqual(['bundle', 'preview', 'track'])
  expect(offPage(seen)).toEqual([])
})

test('a visitor drags a calculator onto the desk: no request to a local AI server', async ({ page, context }) => {
  const seen = await watch(context)
  await openDesk(page)
  const keys = page.getByRole('button', { name: '7', exact: true })
  const before = await keys.count()
  await page.getByRole('button', { name: /^Other work widgets/ }).first().click()
  const calc = page.locator('button[draggable=true]', { hasText: /^Calc$/ }).first()
  await calc.scrollIntoViewIfNeeded()
  // The free space right of the desk's widgets.
  await calc.dragTo(page.locator('body'), { targetPosition: { x: 1350, y: 420 } })
  // A new calculator, saved as a work widget file in this browser.
  await expect.poll(() => keys.count()).toBe(before + 1)
  await settle(seen)

  expect(seen.off.filter((r) => r.url.port === '11434').map((r) => r.url.href), 'a request to an Ollama server').toEqual([])
  expect(offPage(seen), 'a request off the page').toEqual([])
})

test('the built share app carries no local AI client', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(js|mjs|html|json)$/.test(name)) files.push(p)
    }
  }
  walk(OUT)
  expect(files.length).toBeGreaterThan(5)
  // The address the client asked, and its model list. (Settings › AI still
  // names "localhost:11434" in its text, for the desktop app; that is copy, not
  // a request.)
  const hits = files.filter((p) => /http:\/\/localhost:11434|\/api\/tags/.test(readFileSync(p, 'utf8'))).map((p) => p.slice(OUT.length + 1))
  expect(hits).toEqual([])
})
