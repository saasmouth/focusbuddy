// MEASUREMENT, not a gate: the owner's real Day Trading desk — its eleven live
// web pages, real sites, real sizes — through canvas → Workcentre → re-layout →
// canvas. Prints per page: element mounts, full loads, in-page navigations,
// failed loads, crashed page processes, plus widget-store writes per second.
//
// Driven through the MAIN process (webContents.executeJavaScript), not
// Playwright's page channel: with real sites attached as webviews, Playwright's
// CDP channel to the window stops answering while the app itself keeps
// running (measured: page.evaluate silent for 20 s+, executeJavaScript
// answering in ms, menu open).
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

const PAGES: Array<[string, string, number, number]> = [
  ['TradingView charts', 'https://www.tradingview.com/chart/', 1418, 797],
  ['Finviz stock', 'https://finviz.com/stock?t=AACP&b=1&ty=c&p=d', 1418, 797],
  ['Finviz copper', 'https://finviz.com/futures?p=d&t=HG', 1418, 797],
  ['CoinGecko WBT', 'https://www.coingecko.com/en/coins/whitebit', 1418, 797],
  ['Investing calendar', 'https://www.investing.com/economic-calendar', 1418, 797],
  ['Finviz news', 'https://finviz.com/news.php', 1418, 797],
  ['Yahoo earnings', 'https://finance.yahoo.com/calendar/earnings?guccounter=1', 1418, 797],
  ['EIA petroleum', 'https://www.eia.gov/petroleum/weekly/', 1418, 797],
  ['ChatGPT', 'https://chatgpt.com/', 1418, 797],
  ['Google News', 'https://news.google.com/search?q=stock%20market&hl=en-AU&gl=AU&ceid=AU%3Aen', 1418, 797],
  ['Reuters', 'https://www.reuters.com/', 560, 400]
]
const SOAK_SECS = Number(process.env.SOAK_SECS ?? 40)

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

test("SOAK — the owner's eleven live pages through canvas, Workcentre, re-layout and back", async () => {
  test.setTimeout(600_000)
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const ids = await window.evaluate(async (pages) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Day Trading soak' })
    const out: Record<string, string> = {}
    let i = 0
    for (const [title, url, w, h] of pages) {
      const r = (await api.widgets.create({ taskId: task.id, kind: 'webview', title, content: url, x: 40 + (i % 3) * 1460, y: 40 + Math.floor(i / 3) * 840, width: w, height: h } as never)) as { id: string }
      out[r.id] = title
      i++
    }
    await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Hard rules', x: 40, y: 3500, width: 240, height: 200 } as never)
    return { taskId: task.id, names: out }
  }, PAGES)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)

  /** Run a script in the window through the main process. */
  const js = async <T,>(code: string): Promise<T> =>
    app.evaluate(async ({ webContents }, c) => {
      const host = webContents.getAllWebContents().find((w) => w.getType() === 'window')!
      return host.executeJavaScript(c)
    }, code) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  // Instrument BEFORE the desk opens, so first loads are counted too.
  await js(`(() => {
    const nm = ${JSON.stringify(ids.names)}
    const w = window
    w.__wv = {}; w.__writes = []; w.__errs = []
    window.addEventListener('error', (e) => w.__errs.push(String(e.message).slice(0, 160)))
    window.addEventListener('unhandledrejection', (e) => w.__errs.push('rejection: ' + String(e.reason && e.reason.message || e.reason).slice(0, 160)))
    const st = (id) => (w.__wv[id] ??= { mounts: 0, loads: 0, inPage: 0, fails: [], gone: 0 })
    const hook = (e) => {
      if (e.__h) return
      e.__h = true
      const wid = e.closest('[data-web-for]')?.getAttribute('data-web-for') ?? e.closest('[data-widget-id]')?.getAttribute('data-widget-id') ?? e.closest('[data-testid^="workcentre-tile-"]')?.getAttribute('data-testid')?.replace('workcentre-tile-', '') ?? '?'
      const id = nm[wid] ?? wid
      st(id).mounts++
      e.addEventListener('did-start-navigation', (x) => { if (!x.isMainFrame) return; if (x.isInPlace) st(id).inPage++; else st(id).loads++ })
      e.addEventListener('did-fail-load', (x) => { if (x.isMainFrame && x.errorCode !== -3) st(id).fails.push(x.errorCode + ' ' + x.errorDescription) })
      e.addEventListener('render-process-gone', () => st(id).gone++)
    }
    document.querySelectorAll('webview').forEach(hook)
    new MutationObserver(() => document.querySelectorAll('webview').forEach(hook)).observe(document.body, { childList: true, subtree: true })
    window.__fbWidgets.subscribe(() => w.__writes.push(Date.now()))
    window.__fbView.getState().goTask(${JSON.stringify(ids.taskId)})
    return true
  })()`)
  const click = async (sel: string): Promise<void> => {
    for (let i = 0; i < 50; i++) {
      if (await js<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el })()`)) return
      await sleep(200)
    }
    throw new Error('not found: ' + sel)
  }
  const report = async (label: string, since: number): Promise<{ loads: number; mounts: number; writesPerSec: number }> => {
    const r = await js<{ wv: Record<string, { mounts: number; loads: number; inPage: number; fails: string[]; gone: number }>; writes: number; secs: number; n: number; errs: string[] }>(
      `({ wv: window.__wv, writes: window.__writes.filter((t) => t >= ${since}).length, secs: (Date.now() - ${since}) / 1000, n: document.querySelectorAll('webview').length, errs: window.__errs })`
    )
    let loads = 0
    let mounts = 0
    console.log(`\n=== ${label}: ${r.n} <webview>s on screen, store writes ${r.writes} in ${r.secs.toFixed(0)} s (${(r.writes / r.secs).toFixed(1)}/s)`)
    for (const [k, v] of Object.entries(r.wv)) {
      loads += v.loads
      mounts += v.mounts
      console.log(`  ${k.padEnd(20)} mounts ${v.mounts}  loads ${v.loads}  in-page ${v.inPage}  fails ${v.fails.length ? v.fails.join(' | ') : 0}  crashed ${v.gone}`)
    }
    if (r.errs.length) console.log('  page errors:', [...new Set(r.errs)].slice(0, 10).join(' || '))
    return { loads, mounts, writesPerSec: r.writes / r.secs }
  }
  // Each page must sit exactly over its slot in the view showing it.
  const align = async (label: string): Promise<void> => {
    const r = await js<Array<[string, string]>>(`Array.from(document.querySelectorAll('[data-web-slot]')).map((slot) => {
      const id = slot.getAttribute('data-web-slot'); const w = document.querySelector('[data-web-for="' + id + '"]')
      if (!w) return [id, 'NO PAGE']
      const a = slot.getBoundingClientRect(), b = w.getBoundingClientRect()
      const d = Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height))
      return [id, getComputedStyle(w).visibility + ' off ' + d.toFixed(1) + 'px']
    })`)
    const bad = r.filter(([, v]) => !/^visible off 0\.\dpx$/.test(v))
    console.log(`=== alignment (${label}): ${r.length} slots, ${bad.length} off: ${bad.map(([k, v]) => (ids.names[k] ?? k) + ' ' + v).join('; ')}`)
  }
  const procs = async (label: string): Promise<void> => {
    const m = await app.evaluate(({ app: a, webContents }) => {
      const hostPid = webContents.getAllWebContents().find((w) => w.getType() === 'window')?.getOSProcessId()
      return a.getAppMetrics().map((p) => ({ t: p.pid === hostPid ? 'APP WINDOW' : p.type, mb: p.memory.workingSetSize / 1024, cpu: p.cpu.percentCPUUsage }))
    })
    const by: Record<string, { n: number; mb: number; cpu: number }> = {}
    for (const p of m) { const b = (by[p.t] ??= { n: 0, mb: 0, cpu: 0 }); b.n++; b.mb += p.mb; b.cpu += p.cpu }
    console.log(`=== processes (${label}): ` + Object.entries(by).map(([k, v]) => `${k} ×${v.n} ${Math.round(v.mb)} MB ${Math.round(v.cpu)}%`).join(', '))
  }

  const t0 = await js<number>('Date.now()')
  await sleep(SOAK_SECS * 1000)
  const a = await report(`CANVAS, first ${SOAK_SECS} s`, t0)
  await align('canvas')
  await procs('canvas')

  const t1 = await js<number>('Date.now()')
  await click('[data-testid="view-selector-btn"]')
  await click('[data-testid="view-opt-workcentre"]')
  await sleep(SOAK_SECS * 1000)
  const b = await report(`WORKCENTRE (switched), ${SOAK_SECS} s — cumulative`, t1)
  await align('workcentre')
  await procs('workcentre')

  const t2 = await js<number>('Date.now()')
  const firstId = Object.keys(ids.names)[0]!
  console.log('fit clicked:', await js<boolean>(`(() => { const el = document.querySelector('[data-testid="workcentre-fit-${firstId}"]'); if (el) el.click(); return !!el })()`))
  await js(`(() => { const g = document.querySelector('[data-testid="workcentre-grid"]'); const s = g && (g.closest('[class*="overflow"]') || g.parentElement); if (s) s.scrollTop += 1500; return true })()`)
  await sleep(3000)
  await js(`(() => { const g = document.querySelector('[data-testid="workcentre-grid"]'); const s = g && (g.closest('[class*="overflow"]') || g.parentElement); if (s) s.scrollTop -= 1500; return true })()`)
  await sleep(12_000)
  const c = await report('WORKCENTRE after Fit + scroll, 15 s — cumulative', t2)

  const t3 = await js<number>('Date.now()')
  await click('[data-testid="view-selector-btn"]')
  await click('[data-testid="view-opt-canvas"]')
  await sleep(20_000)
  const d = await report('back to CANVAS, 20 s — cumulative', t3)
  await align('back on canvas')
  await procs('end')

  const crashed = await js<boolean>(`document.body.innerText.includes('Something broke in the UI')`)
  console.log(`\n=== SUMMARY: error screen ${crashed}; total loads ${d.loads} (canvas ${a.loads}, +workcentre ${b.loads - a.loads}, +fit/scroll ${c.loads - b.loads}, +back ${d.loads - c.loads}); element mounts ${d.mounts} for 11 pages; store writes/s canvas ${a.writesPerSec.toFixed(1)}, workcentre ${b.writesPerSec.toFixed(1)}`)
  expect(crashed).toBe(false)
})
