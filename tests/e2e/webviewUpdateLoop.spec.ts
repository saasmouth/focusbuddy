// "Something broke in the UI — Minified React error #185" (owner, 2026-11-03),
// twice in one afternoon, from the "Day Trading Workcentre" desk: 21 work
// widgets, 11 of them live web pages, open in the Workcentre. #185 is "Maximum
// update depth exceeded"; the crash log's stack ends in BrowserSurface's
// <webview> ref callback calling WebViewWidget's setter.
//
// Reproduced with what trading sites do all day: retitle the page and push a
// new URL several times a second, and open stories in new windows. Eleven such
// pages on one desk must keep the app up — and none may be reloaded with an
// address it pushed itself. That reload loop is what this desk was really in:
// the widget saved each in-page URL, the store's echo of an older one arrived
// after newer saves, was taken for an outside request, and was loaded — the
// page restarted, pushed the same URLs again, and round it went
// (GUEST_VIEW_MANAGER_CALL ERR_ABORTED in the crash log, before both crashes).
import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let server: Server | null = null
/** Requests for addresses only the PAGE ITSELF ever creates (history.pushState): loading one is a reload loop. */
let staleLoads: string[] = []
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

/** A page that behaves like a live quote board: a new title and a new URL every 120ms. */
async function tickerServer(): Promise<string> {
  staleLoads = []
  server = createServer((req, res) => {
    if (/[?&]t=/.test(req.url ?? '')) staleLoads.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/html' })
    // /q: a quote board — it retitles itself and pushes a new URL every 120ms,
    // and (as a news list does when a story is clicked) opens one story in a new
    // window shortly after it loads. /story: a plain article.
    if ((req.url ?? '').startsWith('/story')) return res.end('<!doctype html><title>Story</title><p>Article</p>')
    res.end(`<!doctype html><html><head><title>Quotes</title></head><body><h1>Live</h1>
      <a id="s" href="/story?from=${encodeURIComponent(req.url ?? '')}" target="_blank">Story</a><script>
      let i = 0
      const w = new URLSearchParams(location.search).get('w')
      setInterval(() => {
        i++
        document.title = 'AAPL ' + (189 + Math.random()).toFixed(2) + ' · ' + i
        history.pushState({ i }, '', '/q?w=' + w + '&t=' + i)
      }, 120)
      if (!/[?&]t=/.test(location.search)) setTimeout(() => document.getElementById('s').click(), 1500)
    </script></body></html>`)
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `http://localhost:${(server!.address() as AddressInfo).port}`
}

async function seed(window: Page, base: string): Promise<string> {
  return window.evaluate(async (b: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Ticker desk' })
    const mk = (kind: string, content: string, i: number): Promise<unknown> =>
      // The desk's own sizes: its web pages were 1418 × 797.
      api.widgets.create({ taskId: task.id, kind, content, x: 40 + (i % 5) * 380, y: 40 + Math.floor(i / 5) * 320, width: kind === 'webview' ? 1418 : 240, height: kind === 'webview' ? 797 : 200 } as never)
    for (let i = 0; i < 11; i++) await mk('webview', `${b}/q?w=${i}`, i)
    for (let i = 0; i < 10; i++) await mk('sticky', `Note ${i}`, 11 + i)
    return task.id
  }, base)
}

for (const view of ['workcentre', 'canvas'] as const) {
  test(`WV-LOOP — eleven live, constantly retitling web pages on one desk (${view}) keep the app up`, async () => {
    test.setTimeout(120_000)
    const base = await tickerServer()
    launched = await launchApp()
    const { window } = launched
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))
    await waitForReady(window)
    await chooseCloudAiSource(window)
    const taskId = await seed(window, base)
    await suppressFeatureSpotlights(window)
    await window.reload()
    await waitForReady(window)
    await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), taskId)
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
    if (view === 'workcentre') {
      await window.locator('[data-testid="view-selector-btn"]').first().click()
      await window.locator('[data-testid="view-opt-workcentre"]').click()
      await expect(window.locator('[data-testid="workcentre-grid"]')).toBeVisible({ timeout: 10_000 })
    }
    // The pages tick; give it time, and move the pointer around as a person does.
    for (let s = 0; s < 10; s++) {
      await window.mouse.move(300 + s * 60, 300 + (s % 3) * 80)
      await window.waitForTimeout(800)
    }
    await expect(window.getByText('Something broke in the UI'), 'the error screen').toHaveCount(0)
    expect(errors.filter((e) => /#185|Maximum update depth/.test(e))).toEqual([])
    const crashes = await window.evaluate(async () => {
      const api = (window as unknown as { api: { crash?: { list?: (n: number) => Promise<Array<{ message: string }>> } } }).api
      return ((await api.crash?.list?.(20)) ?? []).map((c) => c.message).filter((m) => /#185|Maximum update depth/.test(m))
    })
    expect(crashes, 'crash log').toEqual([])
    // A page's own in-page navigations are never loaded back into it in a loop:
    // the old widget mistook its own late-arriving saves for outside requests
    // and reloaded each page with the same addresses over and over (t=13 was
    // loaded 156 times in 8s on the canvas — the ERR_ABORTED storm in the
    // crash log). Allowed: ONE load per widget when the Workcentre mounts a
    // fresh widget and restores the page to where it was, as reopening a tab
    // does. Never: the same address twice.
    const dupes = staleLoads.filter((u, i) => staleLoads.indexOf(u) !== i)
    expect(dupes, `addresses loaded more than once (a reload loop): ${dupes.slice(0, 5).join(', ')}`).toEqual([])
    expect(staleLoads.length, 'at most one restore per web page').toBeLessThanOrEqual(view === 'workcentre' ? 11 : 0)
  })
}
