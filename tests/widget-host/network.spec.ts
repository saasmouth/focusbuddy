// What the widget host asks of the network (d0 and 1a, 2026-11-20).
//
// 1a found every host page asking http://localhost:11434/api/tags, Plexii's
// Ollama check. It came through the search index: opening a file saves it into
// the page's database, a save embeds the document for search, and with no key
// and Background AI tasks off the embedder asks for a model on this computer.
// The request never left the machine, but it is AI machinery running inside
// PlexiiLite, which shows no AI. The host build now has no local-model client
// at all (MODULE_SWAPS in vite.web.config.ts, src/web/worker/main/localModel.ts).
//
// Each kind's example file is opened, saved and left to settle while every
// request is watched, the Worker's included. None is let out: requests to the
// test server go through, anything else is recorded and refused, so these
// tests reach no other server. What is allowed off the page is what a widget
// itself does, and only the place map does that: OpenStreetMap's tiles, and
// its search (Nominatim) when a place is looked up.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type BrowserContext } from '@playwright/test'
import { FIXTURES, drawn, fixture, flush, load, loaded, openHost } from './harness'

const ORIGIN = 'http://127.0.0.1:5191'
const OUT = join(__dirname, '../../out/widget-host')
const FILES = readdirSync(FIXTURES).filter((f) => f.includes('.plexii-')).sort()
const kindOf = (f: string): string => f.slice(0, f.indexOf('.'))

/** The kinds that reach a server of their own, and the hosts they may reach. */
const OWN_NETWORK: Record<string, RegExp> = {
  'location-map': /^(tile|nominatim)\.openstreetmap\.org$/
}

/** Every request made in the context, the Worker's included. Only the test server's are let through. */
async function watch(context: BrowserContext): Promise<{ all: URL[]; last: () => number }> {
  const all: URL[] = []
  let at = Date.now()
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url())
    all.push(u)
    at = Date.now()
    if (u.origin === ORIGIN) await route.continue()
    else await route.abort('blockedbyclient')
  })
  return { all, last: () => at }
}

test('every kind in the manifest has an example file here', () => {
  const m = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { kinds: string[]; documents: Record<string, unknown> }
  const have = new Set(FILES.map(kindOf))
  expect([...m.kinds, ...Object.keys(m.documents)].filter((k) => !have.has(k))).toEqual([])
  expect(FILES).toHaveLength(25)
})

test.describe("each kind's example file", () => {
  for (const file of FILES) {
    const kind = kindOf(file)
    test(`${kind}: no request to a local AI server, and nothing off the page ${OWN_NETWORK[kind] ? 'but its map' : 'at all'}`, async ({ page, context }) => {
      const seen = await watch(context)
      await openHost(page)
      await load(page, fixture(file))
      await loaded(page)
      await drawn(page)
      await flush(page)
      // Settle: at least 2.5 s after the save, and 1.5 s with no new request.
      // Before the fix the Ollama check came about 250 ms after opening, and the
      // kinds that did not make it made none in 20 s either.
      const from = Date.now()
      await expect.poll(() => Date.now() - from >= 2500 && Date.now() - seen.last() >= 1500, { timeout: 20_000, intervals: [250] }).toBe(true)

      // The watch sees the Worker's own requests: it fetches SQLite's WebAssembly.
      expect(seen.all.some((u) => u.origin === ORIGIN && u.pathname.endsWith('.wasm'))).toBe(true)

      const localAi = seen.all.filter((u) => u.port === '11434').map(String)
      expect(localAi, 'a request to an Ollama server').toEqual([])

      const off = seen.all.filter((u) => u.origin !== ORIGIN && !['data:', 'blob:'].includes(u.protocol))
      const allowed = OWN_NETWORK[kind]
      expect(off.filter((u) => !allowed?.test(u.hostname)).map((u) => `${u.origin}${u.pathname}`), 'a request off the page').toEqual([])
    })
  }
})

// The example file has no place yet, so it draws no tiles. These open the same
// file with a place, and search for one, so the map's allowance is exercised
// rather than merely permitted.
const placed = (content: Record<string, unknown>): string => {
  const f = JSON.parse(fixture('location-map.plexii-place')) as Record<string, unknown>
  return JSON.stringify({ ...f, content: JSON.stringify(content) }, null, 2)
}
const offPage = (all: URL[]): URL[] => all.filter((u) => u.origin !== ORIGIN && !['data:', 'blob:'].includes(u.protocol))

test('the place map with a place: OpenStreetMap tiles, and nothing else off the page', async ({ page, context }) => {
  const seen = await watch(context)
  await openHost(page)
  await load(page, placed({ query: 'Trafalgar Square', lat: 51.508, lon: -0.128, label: 'Trafalgar Square, London', zoom: 16 }))
  await loaded(page)
  await drawn(page)
  await expect.poll(() => offPage(seen.all).length).toBeGreaterThan(0)
  const from = Date.now()
  await expect.poll(() => Date.now() - from >= 2500 && Date.now() - seen.last() >= 1500, { timeout: 20_000, intervals: [250] }).toBe(true)
  expect([...new Set(offPage(seen.all).map((u) => u.hostname))]).toEqual(['tile.openstreetmap.org'])
  expect(seen.all.filter((u) => u.port === '11434')).toEqual([])
})

test('the place map: a search asks Nominatim, and nothing else', async ({ page, context }) => {
  const seen = await watch(context)
  await openHost(page)
  await load(page, fixture('location-map.plexii-place'))
  await loaded(page)
  await drawn(page)
  // No place yet: nothing off the page until the search.
  await page.waitForTimeout(1000)
  expect(offPage(seen.all)).toEqual([])
  await page.getByPlaceholder('Search an address or place').fill('Trafalgar Square')
  await page.getByTitle('Find').click()
  await expect.poll(() => offPage(seen.all).length).toBeGreaterThan(0)
  const from = Date.now()
  await expect.poll(() => Date.now() - from >= 2500 && Date.now() - seen.last() >= 1500, { timeout: 20_000, intervals: [250] }).toBe(true)
  // Refused here, so no tiles follow: the search is the only request it makes.
  expect(offPage(seen.all).map((u) => `${u.hostname}${u.pathname}`)).toEqual(['nominatim.openstreetmap.org/search'])
})

test('the built host carries no local AI client', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(js|mjs|html|json|css)$/.test(name)) files.push(p)
    }
  }
  walk(OUT)
  expect(files.length).toBeGreaterThan(5)
  const hits = files.filter((p) => /localhost:11434|\/api\/tags|FB_OLLAMA_URL/.test(readFileSync(p, 'utf8'))).map((p) => p.slice(OUT.length + 1))
  expect(hits).toEqual([])
})
