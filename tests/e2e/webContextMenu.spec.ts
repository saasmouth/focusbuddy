// E2E: right-click works on every surface web content renders on, with the
// same native menu (src/main/webContextMenu.ts), desk-only actions on the
// desk only.
//
// Owner's ask: "make sure the right click context menu works on the standalone
// browser as well as the browser when it is on a desk". Before 4.3.39-local.4
// only the desk's browser work widget had a menu outside editable fields; the
// standalone browser, connected apps and pop-ups showed nothing.
//
// A real right-click (sendInputEvent from main) on a local test page — a link,
// an image, selected text, an input and empty space — on each surface. Native
// menus cannot be read from Playwright, so the test hook (NODE_ENV=test +
// PLEXI_WEB_MENU_HOOK=1) records the menu main built instead of popping it up.
// Throwaway profile, preview app identity, localhost only.
import { test, expect, type ElectronApplication } from '@playwright/test'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let server: Server | null = null
let origin = ''

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQElEQVR4nO3OMQ0AAAjAMO5fNBYBAvpA0tQzTXOdnd8EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+GB0/AAG+Vt0WAAAAAElFTkSuQmCC'
const PAGE = `<!doctype html><title>Menu test</title>
<body style="margin:0;font:16px sans-serif">
<a id="link" href="/other.html" style="position:absolute;left:10px;top:10px">a link</a>
<img id="img" src="/img.png" width="64" height="64" style="position:absolute;left:10px;top:40px">
<p id="text" style="position:absolute;left:10px;top:120px;margin:0">Some selectable words here.</p>
<input id="field" value="teh text" style="position:absolute;left:10px;top:160px;width:160px">
<div id="empty" style="position:absolute;left:220px;top:220px;width:40px;height:40px"></div>
<script>window.openPop = () => !!window.open('/m.html?pop=1', 'pop', 'width=420,height=420')</script>
</body>`

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(PNG, 'base64'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(path === '/m.html' ? PAGE : '<!doctype html><title>Other</title>other')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

type Entry = { type?: 'separator'; id?: string; label?: string; enabled?: boolean }
type Recorded = { surface: string; webContentsId: number; entries: Entry[] } | null

/** Find the web content showing `url` (exact, or with ?pop=1 for the pop-up). */
async function waitLoaded(app: ElectronApplication, url: string): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(({ webContents }, u) => {
          const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)
          return wc ? !wc.isLoading() : false
        }, url),
      { timeout: 20_000 }
    )
    .toBe(true)
}

/** Right-click the element `sel` in the page at `url`, as a person would; return the menu main built. */
async function rightClick(app: ElectronApplication, url: string, sel: string, opts: { select?: boolean; focus?: boolean } = {}): Promise<Recorded> {
  return app.evaluate(
    async ({ webContents }, { url, sel, opts }) => {
      const g = globalThis as unknown as { __plexiiLastWebMenu?: unknown }
      g.__plexiiLastWebMenu = null
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === url)
      if (!wc) throw new Error(`no web content at ${url}`)
      // The page has focus, as it does when a person is using it (a selection
      // in an unfocused frame reads as empty).
      wc.focus()
      const r = (await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const b = el.getBoundingClientRect();
          ${opts.select ? `const rg = document.createRange(); rg.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(rg);` : ''}
          ${opts.focus ? `el.focus(); el.select && el.select();` : ''}
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`,
        true
      )) as { x: number; y: number }
      // Input events are in device-independent pixels; the page lays out in
      // CSS pixels under the surface's zoom (the browser panel is at 90%).
      const z = wc.getZoomFactor()
      const at = { x: Math.round(r.x * z), y: Math.round(r.y * z) }
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 })
      for (let i = 0; i < 50 && !g.__plexiiLastWebMenu; i++) await new Promise((res) => setTimeout(res, 100))
      return (g.__plexiiLastWebMenu ?? null) as never
    },
    { url, sel, opts }
  )
}

const labels = (m: Recorded): string[] => (m?.entries ?? []).filter((e) => e.type !== 'separator').map((e) => e.label ?? '')

/** The five targets, checked on one surface. */
async function checkAll(app: ElectronApplication, url: string, surface: string): Promise<void> {
  const link = await rightClick(app, url, '#link')
  expect(link?.surface).toBe(surface)
  expect(labels(link)).toEqual(expect.arrayContaining(['Open link in default browser', 'Copy link address']))
  expect(labels(link)).toContain(surface === 'desk' ? 'Open link as a new browser work widget' : 'Open link')

  const img = await rightClick(app, url, '#img')
  expect(labels(img)).toEqual(expect.arrayContaining(['Save image as…', 'Copy image', 'Copy image address']))

  const text = await rightClick(app, url, '#text', { select: true })
  expect(labels(text)).toContain('Copy')

  const field = await rightClick(app, url, '#field', { focus: true })
  expect(labels(field)).toEqual(expect.arrayContaining(['Cut', 'Copy', 'Paste', 'Select all']))

  const empty = await rightClick(app, url, '#empty')
  expect(labels(empty)).toEqual(expect.arrayContaining(['Back', 'Forward', 'Reload']))

  // Desk actions on the desk only.
  for (const m of [link, img, text, field, empty]) {
    if (surface === 'desk') expect(labels(m)).toContain('More work widget actions…')
    else expect(labels(m).join('|')).not.toMatch(/work widget/)
  }
}

async function boot(env: Record<string, string> = {}): Promise<LaunchedApp> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', PLEXI_WEB_MENU_HOOK: '1', ...env } })
  await waitForReady(launched.window)
  return launched
}

test('WCM-1 — standalone browser (the web panel): the full menu', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await window.evaluate((u) => (window as unknown as { __fbWebPanel: { getState: () => { openWeb: (u: string, o?: unknown) => void } } }).__fbWebPanel.getState().openWeb(u, { expanded: true }), url)
  await waitLoaded(app, url)
  await checkAll(app, url, 'browser')
})

test('WCM-2 — browser work widget on a desk: the same menu plus the desk actions', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await window.evaluate(async (u) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'MenuDesk' })
    await api.widgets.create({ taskId: task.id, kind: 'webview', title: '', content: u, x: 60, y: 60, width: 640, height: 420 })
  }, url)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /MenuDesk/ }).first().click()
  await waitLoaded(app, url)
  // The widget registers itself as a desk surface on dom-ready.
  await expect.poll(async () => (await rightClick(app, url, '#empty'))?.surface, { timeout: 10_000 }).toBe('desk')
  await checkAll(app, url, 'desk')
})

test('WCM-3 — a connected app (its own partition): the full menu, no desk actions', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await window.evaluate((src) => {
    const wv = document.createElement('webview')
    wv.setAttribute('partition', 'persist:connectedapp-e2e')
    wv.setAttribute('src', src)
    wv.style.cssText = 'position:fixed;right:8px;bottom:8px;width:420px;height:300px;z-index:1'
    document.body.appendChild(wv)
  }, url)
  await waitLoaded(app, url)
  await checkAll(app, url, 'connected-app')
})

for (const native of [false, true]) {
  test(`WCM-4${native ? 'b' : 'a'} — a pop-up ${native ? 'as a native window' : 'on the desk'}: the full menu`, async () => {
    const { app, window } = await boot(native ? { PLEXI_POPUPS_NATIVE: '1' } : {})
    const url = `${origin}/m.html`
    await window.evaluate((src) => {
      const wv = document.createElement('webview')
      wv.setAttribute('allowpopups', 'true')
      wv.setAttribute('src', src)
      wv.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:200px;z-index:1'
      document.body.appendChild(wv)
    }, url)
    await waitLoaded(app, url)
    await app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => w.getURL() === u)!.executeJavaScript('window.openPop()', true), url)
    const popUrl = `${url}?pop=1`
    await waitLoaded(app, popUrl)
    await checkAll(app, popUrl, 'popup')
  })
}


