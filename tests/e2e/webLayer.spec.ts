// Live web pages outlive the desk view showing them (lib/webLayer).
//
// Owner, 2026-11-03: "I care about browser windows". Measured on their Day
// Trading desk — eleven real sites — canvas → Workcentre → canvas loaded every
// page three times (33 loads for 11 pages): each view mounted its own
// <webview>, and a webview that leaves the document is destroyed. Every switch
// lost chart state, sign-ins in progress, scroll and drafts.
//
// Local pages here, so every load is counted at the server and every page
// carries a per-document token (a reload gets a new one).
import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let server: Server | null = null
let loads: Record<string, number> = {}
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

/** /p?n=NAME: a full-bleed page in one solid colour, with a fresh token per load. */
async function pageServer(): Promise<string> {
  loads = {}
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    if (u.pathname !== '/p') {
      res.writeHead(404)
      return res.end()
    }
    const n = u.searchParams.get('n') ?? '?'
    loads[n] = (loads[n] ?? 0) + 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>${n}</title><style>html,body{margin:0;height:100%;background:rgb(0,200,0)}</style>
      <body><h1 style="margin:0;padding:8px;font:16px sans-serif">${n}</h1><script>window.__token = Math.random().toString(36).slice(2)</script></body>`)
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `http://localhost:${(server!.address() as AddressInfo).port}`
}

interface Seed {
  taskId: string
  pages: Record<string, string> // name -> widget id
  sticky: string
}

async function seed(window: Page, base: string): Promise<Seed> {
  return window.evaluate(async (b: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Live pages' })
    const pages: Record<string, string> = {}
    const at: Record<string, [number, number]> = { A: [40, 40], B: [700, 40], C: [40, 560] }
    for (const n of ['A', 'B', 'C']) {
      const w = (await api.widgets.create({ taskId: task.id, kind: 'webview', title: n, content: `${b}/p?n=${n}`, x: at[n]![0], y: at[n]![1], width: 620, height: 460, zIndex: 1 } as never)) as { id: string }
      pages[n] = w.id
    }
    // A sticky laid OVER page A's lower right, above it.
    const s = (await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'On top of the page', x: 420, y: 300, width: 220, height: 180, zIndex: 50 } as never)) as { id: string }
    return { taskId: task.id, pages, sticky: s.id }
  }, base)
}

async function open(window: Page, s: Seed): Promise<void> {
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), s.taskId)
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 15_000 })
  await window.evaluate(() => {
    const st = (window as unknown as { __fbWidgets: { getState: () => { setZoom: (z: number) => void; setPan: (x: number, y: number) => void } } }).__fbWidgets.getState()
    st.setZoom(1)
    st.setPan(0, 0)
  })
}

/** The page's in-memory token: unchanged = the same document, never reloaded. */
const token = (window: Page, widgetId: string): Promise<string | null> =>
  window.evaluate(async (id: string) => {
    // The layer's page, or (older builds) the page inside the widget or tile.
    const wv = (document.querySelector(`[data-web-for="${id}"] webview`) ??
      document.querySelector(`[data-widget-id="${id}"] webview`) ??
      document.querySelector(`[data-testid="workcentre-tile-${id}"] webview`)) as (HTMLElement & { executeJavaScript: (c: string) => Promise<unknown> }) | null
    if (!wv) return null
    try {
      return String(await wv.executeJavaScript('window.__token'))
    } catch {
      return null
    }
  }, widgetId)

async function waitTokens(window: Page, s: Seed): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [n, id] of Object.entries(s.pages)) {
    await expect.poll(() => token(window, id), { timeout: 15_000, message: `page ${n} loaded` }).not.toBeNull()
    out[n] = (await token(window, id))!
  }
  return out
}

async function toView(window: Page, mode: 'workcentre' | 'canvas'): Promise<void> {
  await window.locator('[data-testid="view-selector-btn"]').first().click()
  await window.locator(`[data-testid="view-opt-${mode}"]`).click()
  if (mode === 'workcentre') await expect(window.locator('[data-testid="workcentre-grid"]')).toBeVisible({ timeout: 10_000 })
  else await expect(window.locator('[data-testid="workcentre-grid"]')).toHaveCount(0)
}

/** For every slot that is on screen: how far its page sits from it (px). */
const misalignment = (window: Page): Promise<Array<{ id: string; off: number; visible: boolean }>> =>
  window.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-web-slot]')).map((slot) => {
      const id = slot.getAttribute('data-web-slot')!
      const w = document.querySelector<HTMLElement>(`[data-web-for="${id}"]`)!
      const a = slot.getBoundingClientRect()
      const b = w.getBoundingClientRect()
      const onScreen = a.right > 0 && a.bottom > 0 && a.left < innerWidth && a.top < innerHeight
      return {
        id,
        visible: getComputedStyle(w).visibility === 'visible' && onScreen,
        off: Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height))
      }
    })
  )

test('WL-1 — switching canvas → Workcentre → canvas keeps every page alive: one load each, the same document throughout', async () => {
  test.setTimeout(120_000)
  const base = await pageServer()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const s = await seed(window, base)
  await open(window, s)
  const before = await waitTokens(window, s)
  expect(loads).toEqual({ A: 1, B: 1, C: 1 })

  await toView(window, 'workcentre')
  await window.waitForTimeout(1_500)
  // The Workcentre shows the same live pages, in its tiles.
  for (const id of Object.values(s.pages)) await expect(window.locator(`[data-testid="workcentre-tile-${id}"]`)).toHaveCount(1)
  await toView(window, 'canvas')
  await window.waitForTimeout(1_500)
  await toView(window, 'workcentre')
  await toView(window, 'canvas')
  await window.waitForTimeout(1_500)

  const after = await waitTokens(window, s)
  expect(after, 'each page is the same document it was before the switches').toEqual(before)
  expect(loads, 'not one reload').toEqual({ A: 1, B: 1, C: 1 })
  expect(await window.locator('webview').count(), 'one page element per page').toBe(3)
})

test('WL-2 — each page sits exactly over its place in the view: the canvas at any zoom, and the Workcentre', async () => {
  test.setTimeout(120_000)
  const base = await pageServer()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const s = await seed(window, base)
  await open(window, s)
  await waitTokens(window, s)
  for (const zoom of [1, 0.5, 0.8]) {
    await window.evaluate((z: number) => (window as unknown as { __fbWidgets: { getState: () => { setZoom: (z: number) => void } } }).__fbWidgets.getState().setZoom(z), zoom)
    await window.waitForTimeout(400)
    const m = await misalignment(window)
    const shown = m.filter((x) => x.visible)
    expect(shown.length, `pages on screen at zoom ${zoom}`).toBeGreaterThan(0)
    for (const x of shown) expect(x.off, `page ${x.id} at zoom ${zoom}`).toBeLessThan(1.5)
  }
  await toView(window, 'workcentre')
  await window.waitForTimeout(800)
  const m = await misalignment(window)
  const shown = m.filter((x) => x.visible)
  expect(shown.length, 'pages on screen in the Workcentre').toBeGreaterThan(0)
  for (const x of shown) expect(x.off, `Workcentre page ${x.id}`).toBeLessThan(1.5)
})

test('WL-3 — a widget on top of a page stays on top: you see it, and a click lands on it, not the page', async () => {
  test.setTimeout(120_000)
  const base = await pageServer()
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const s = await seed(window, base)
  await open(window, s)
  await waitTokens(window, s)
  await window.waitForTimeout(600)
  const box = await window.locator(`[data-widget-id="${s.sticky}"]`).first().boundingBox()
  expect(box).not.toBeNull()
  const pageBox = await window.locator(`[data-web-slot="${s.pages.A}"]`).boundingBox()
  expect(pageBox).not.toBeNull()
  // A point inside both the sticky and page A.
  const px = Math.round(Math.min(box!.x + box!.width / 2, pageBox!.x + pageBox!.width - 20))
  const py = Math.round(Math.min(box!.y + box!.height / 2, pageBox!.y + pageBox!.height - 20))
  expect(px > pageBox!.x && py > pageBox!.y, 'the sticky overlaps page A').toBe(true)
  // What is actually painted there: the sticky, not the page's green.
  const painted = await app.evaluate(async ({ BrowserWindow }, p: { x: number; y: number }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!
    // Page pixels to window points: the window may be zoomed (capturePage takes points).
    const z = win.webContents.getZoomFactor()
    // stayHidden: background e2e never shows the window, even to capture it.
    const img = await win.webContents.capturePage({ x: Math.round(p.x * z), y: Math.round(p.y * z), width: 1, height: 1 }, { stayHidden: true })
    const b = img.toBitmap() // BGRA
    return [b[2], b[1], b[0]]
  }, { x: px, y: py })
  const isPageGreen = painted[0]! < 40 && painted[1]! > 170 && painted[2]! < 40
  expect(isPageGreen, `pixel under the sticky is rgb(${painted.join(',')}): the page must not paint over it`).toBe(false)
  // And where only the page is, it IS the page.
  const pagePixel = await app.evaluate(async ({ BrowserWindow }, p: { x: number; y: number }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!
    // Page pixels to window points: the window may be zoomed (capturePage takes points).
    const z = win.webContents.getZoomFactor()
    // stayHidden: background e2e never shows the window, even to capture it.
    const img = await win.webContents.capturePage({ x: Math.round(p.x * z), y: Math.round(p.y * z), width: 1, height: 1 }, { stayHidden: true })
    const b = img.toBitmap()
    return [b[2], b[1], b[0]]
    // Right-hand side, clear of the floating side menu (glass: it tints what is under it).
  }, { x: Math.round(pageBox!.x + pageBox!.width - 60), y: Math.round(pageBox!.y + 120) })
  expect(pagePixel[1]! > 170 && pagePixel[0]! < 40, `page A paints its own area (rgb(${pagePixel.join(',')}))`).toBe(true)
  // A click on the sticky reaches the sticky.
  await window.mouse.click(px, py)
  await expect
    .poll(() => window.evaluate(() => (window as unknown as { __fbWidgets: { getState: () => { activeWidgetId: string | null; selectedIds?: string[] } } }).__fbWidgets.getState().activeWidgetId), { timeout: 5_000 })
    .toBe(s.sticky)
})

test('WL-4 — after the focus view, the desk page shows where focus left it', async () => {
  test.setTimeout(120_000)
  const base = await pageServer()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const s = await seed(window, base)
  await open(window, s)
  await waitTokens(window, s)
  // Focus page A, and move it on inside the focus view.
  await window.evaluate((id: string) => (window as unknown as { __fbWidgets: { getState: () => { setFocused: (i: string | null) => void } } }).__fbWidgets.getState().setFocused(id), s.pages.A)
  await expect.poll(() => window.evaluate(() => Array.from(document.querySelectorAll('webview')).filter((w) => !w.closest('[data-web-layer]')).length), { timeout: 10_000 }).toBe(1)
  await window.waitForTimeout(800)
  await window.evaluate(async (u: string) => {
    const wv = Array.from(document.querySelectorAll('webview')).find((w) => !w.closest('[data-web-layer]')) as HTMLElement & { loadURL: (u: string) => Promise<void> }
    await wv.loadURL(u)
  }, `${base}/p?n=A2`)
  await window.waitForTimeout(1_200)
  await window.evaluate(() => (window as unknown as { __fbWidgets: { getState: () => { setFocused: (i: string | null) => void } } }).__fbWidgets.getState().setFocused(null))
  // The desk's page catches up to A2 (not the address it had before focus).
  await expect
    .poll(
      () =>
        window.evaluate((id: string) => {
          const wv = document.querySelector(`[data-web-for="${id}"] webview`) as (HTMLElement & { getURL: () => string }) | null
          try {
            return wv?.getURL() ?? null
          } catch {
            return null
          }
        }, s.pages.A),
      { timeout: 10_000 }
    )
    .toContain('n=A2')
})

test('WL-5 — a page never covers the handles on its edges: a web tile resizes from its corner in the Workcentre, and a web widget from its corner on the canvas', async () => {
  test.setTimeout(150_000)
  const base = await pageServer()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const s = await seed(window, base)
  await open(window, s)
  const before = await waitTokens(window, s)
  const drag = async (x: number, y: number, dx: number, dy: number): Promise<void> => {
    await window.mouse.move(x, y)
    await window.mouse.down()
    for (let i = 1; i <= 8; i++) await window.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8)
    await window.mouse.up()
  }

  // Canvas: page B's frame, dragged from its bottom-right resize handle.
  const widthOf = (id: string): Promise<number> =>
    window.evaluate((i: string) => (window as unknown as { __fbWidgets: { getState: () => { widgets: Array<{ id: string; width: number }> } } }).__fbWidgets.getState().widgets.find((w) => w.id === i)!.width, id)
  const w0 = await widthOf(s.pages.B!)
  // react-rnd's bottom-right handle: the se-resize element at the frame's corner.
  const handle = await window.evaluate((id: string) => {
    const f = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
    const h = Array.from(document.querySelectorAll<HTMLElement>('div')).find((el) => {
      if (getComputedStyle(el).cursor !== 'se-resize') return false
      const r = el.getBoundingClientRect()
      return Math.abs(r.left + r.width / 2 - f.right) < 16 && Math.abs(r.top + r.height / 2 - f.bottom) < 16
    })
    if (!h) return null
    const r = h.getBoundingClientRect()
    // Its outer quarter, outside the page: the page never covers that.
    return { x: r.left + r.width * 0.75, y: r.top + r.height * 0.75 }
  }, s.pages.B!)
  expect(handle, 'the canvas web widget has a corner resize handle').not.toBeNull()
  await drag(handle!.x, handle!.y, -140, 0)
  await expect.poll(() => widthOf(s.pages.B!), { timeout: 5_000, message: 'the canvas web widget resized from its corner' }).toBeLessThan(w0 - 60)

  // Workcentre: page A's tile, from its corner handle.
  await toView(window, 'workcentre')
  await window.waitForTimeout(800)
  const tile = window.locator(`[data-testid="workcentre-tile-${s.pages.A}"]`)
  const wBefore = Number(await tile.getAttribute('data-w'))
  const corner = await window.locator(`[data-testid="workcentre-resize-${s.pages.A}"]`).boundingBox()
  expect(corner).not.toBeNull()
  await drag(corner!.x + corner!.width / 2, corner!.y + corner!.height / 2, -260, 0)
  await expect.poll(async () => Number(await tile.getAttribute('data-w')), { timeout: 5_000, message: 'the web tile resized from its corner' }).toBeLessThan(wBefore)

  expect(await waitTokens(window, s), 'resizing reloads nothing').toEqual(before)
  expect(loads).toEqual({ A: 1, B: 1, C: 1 })
})
