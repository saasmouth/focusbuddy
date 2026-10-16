import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Web pop-ups open ON THE DESK (4.3.31).
//
// A page inside a desk browser object calls window.open with features — the
// shape every OAuth / SSO "Sign in with…" button uses. The pop-up must:
//   - appear as a card on the desk, inside the main window, with NO new
//     BrowserWindow;
//   - keep window.opener: B posts to its opener, A receives it, and A's handle
//     to B still works the other way;
//   - close its card when the page calls window.close() (or blanks itself
//     after a hand-off), when Esc is pressed, or from the close button;
//   - get no preload / window.api.
// And the fallbacks: PLEXI_POPUPS_NATIVE=1 restores a native window, and a
// failed WebContentsView falls back to one rather than dropping the pop-up.
//
// Real Electron, throwaway profile (launchApp mints a temp userData), preview
// app identity so nothing touches a production install.

let launched: LaunchedApp | null = null
let server: Server | null = null
let origin = ''

const PAGE_A = `<!doctype html><title>Opener A</title>
<body>
<a id="plain" href="/plain.html" target="_blank">plain new tab</a>
<script>
  window.__got = []
  window.__popup = null
  window.addEventListener('message', (e) => { window.__got.push(e.data) })
  window.openB = (path) => {
    window.__popup = window.open(path || '/b.html', 'oauth', 'width=480,height=560')
    return !!window.__popup
  }
</script></body>`

const PAGE_B = `<!doctype html><title>Sign in to Example</title>
<body><h1>B</h1>
<script>
  window.__hasOpener = !!window.opener
  window.opener && window.opener.postMessage({ from: 'b', hasOpener: true }, '*')
  window.addEventListener('message', (e) => {
    if (e.data === 'please-close') window.close()
    if (e.data === 'please-blank') location.href = 'about:blank'
  })
</script></body>`

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    const body = path === '/a.html' ? PAGE_A : path === '/b.html' ? PAGE_B : '<!doctype html><title>Plain</title>plain'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function boot(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page }> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ...env } })
  await waitForReady(launched.window)
  return { app: launched.app, window: launched.window }
}

/** Mount a desk-style <webview> (allowpopups, as BrowserSurface does) on page A. */
async function mountOpener(app: ElectronApplication, window: Page): Promise<void> {
  await window.evaluate((src) => {
    const wv = document.createElement('webview')
    wv.setAttribute('allowpopups', 'true')
    wv.setAttribute('src', src)
    wv.id = 'e2e-opener'
    wv.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:200px;z-index:1'
    document.body.appendChild(wv)
  }, `${origin}/a.html`)
  await expect
    .poll(
      () =>
        app.evaluate(({ webContents }, url) => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
          return wc ? !wc.isLoading() : false
        }, `${origin}/a.html`),
      { timeout: 15_000 }
    )
    .toBe(true)
}

/** Run JS in the opener page with a user gesture (pop-up blockers want one). */
async function inOpener<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(
    ({ webContents }, { url, code }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
      if (!wc) throw new Error('opener not found')
      return wc.executeJavaScript(code, true)
    },
    { url: `${origin}/a.html`, code }
  ) as Promise<T>
}

async function popupInfo(app: ElectronApplication): Promise<{ exists: boolean; destroyed: boolean; type: string }> {
  return app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(url))
    return { exists: !!wc, destroyed: wc ? wc.isDestroyed() : true, type: wc ? wc.getType() : '' }
  }, `${origin}/b.html`)
}

const windowCount = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

test('a scripted pop-up opens as a card on the desk, keeps window.opener, and closes itself', async () => {
  const { app, window } = await boot()
  await mountOpener(app, window)
  const winsBefore = await windowCount(app)
  const pwWindowsBefore = app.windows().length

  expect(await inOpener<boolean>(app, 'window.openB()')).toBe(true)

  // The card is on the desk, titled from the page, with the host under it.
  const card = window.locator('[data-testid="desk-popup-card"]')
  await expect(card).toHaveCount(1, { timeout: 10_000 })
  await expect(card.locator('[data-testid="desk-popup-title"]')).toHaveText('Sign in to Example', { timeout: 10_000 })
  await expect(card.locator('[data-testid="desk-popup-host"]')).toHaveText('127.0.0.1')
  await expect(window.locator('[data-testid="desk-popup-layer"]')).toBeVisible()

  // No new OS window. BrowserWindow.getAllWindows() is the OS-window count.
  expect(await windowCount(app)).toBe(winsBefore)
  // Playwright's electronApp.windows() lists every CDP *page* target, which
  // already includes the opener <webview> — so it grows by exactly one: the
  // pop-up page itself, and that page lives inside the main window.
  await expect.poll(() => app.windows().length, { timeout: 5_000 }).toBe(pwWindowsBefore + 1)
  expect(app.windows().filter((p) => p.url().startsWith(`${origin}/b.html`))).toHaveLength(1)
  const hosting = await app.evaluate(({ BrowserWindow, webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(url))!
    const main = BrowserWindow.getAllWindows()[0]
    const inMain = main.contentView.children.some(
      (v) => (v as unknown as { webContents?: { id: number } }).webContents?.id === wc.id
    )
    return { inMain, ownWindow: BrowserWindow.getAllWindows().some((w) => w.webContents.id === wc.id) }
  }, `${origin}/b.html`)
  expect(hosting).toEqual({ inMain: true, ownWindow: false })

  // The opener relationship survived: B -> opener.postMessage reached A.
  await expect
    .poll(() => inOpener<unknown[]>(app, 'window.__got'), { timeout: 10_000 })
    .toEqual([{ from: 'b', hasOpener: true }])

  // The native view sits exactly over the card's slot (CSS px x zoom = DIP).
  const slot = await window.locator('[data-testid="desk-popup-slot"]').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })
  await expect
    .poll(
      async () => {
        const v = await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          const kids = win.contentView.children
          const view = kids[kids.length - 1] as unknown as {
            getBounds: () => { x: number; y: number; width: number; height: number }
            getVisible?: () => boolean
          }
          return { b: view.getBounds(), zoom: win.webContents.getZoomFactor(), kids: kids.length }
        })
        const z = v.zoom
        return (
          Math.abs(v.b.x - Math.round(slot.x * z)) <= 1 &&
          Math.abs(v.b.y - Math.round(slot.y * z)) <= 1 &&
          Math.abs(v.b.width - slot.width * z) <= 2 &&
          Math.abs(v.b.height - slot.height * z) <= 2
        )
      },
      { timeout: 5_000 }
    )
    .toBe(true)

  // The pop-up is a plain web page: no preload, no window.api, no node.
  const popupGlobals = await app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(url))!
    return wc.executeJavaScript('({ api: typeof window.api, req: typeof require, proc: typeof process, opener: window.__hasOpener })')
  }, `${origin}/b.html`)
  expect(popupGlobals).toEqual({ api: 'undefined', req: 'undefined', proc: 'undefined', opener: true })
  expect((await popupInfo(app)).exists).toBe(true)

  // A's handle to B works too: A asks B to close, B calls window.close().
  await inOpener(app, "window.__popup.postMessage('please-close', '*')")
  await expect(card).toHaveCount(0, { timeout: 10_000 })
  await expect(window.locator('[data-testid="desk-popup-layer"]')).toHaveCount(0)
  await expect.poll(async () => (await popupInfo(app)).exists, { timeout: 5_000 }).toBe(false)
  expect(await inOpener<boolean>(app, 'window.__popup.closed')).toBe(true)
  expect(await windowCount(app)).toBe(winsBefore)
})

test('Esc, the close button and an about:blank hand-off each remove the card', async () => {
  const { app, window } = await boot()
  await mountOpener(app, window)
  const card = window.locator('[data-testid="desk-popup-card"]')

  // Close button.
  await inOpener(app, 'window.openB()')
  await expect(card).toHaveCount(1, { timeout: 10_000 })
  await card.locator('[data-testid="desk-popup-close"]').click()
  await expect(card).toHaveCount(0, { timeout: 5_000 })
  await expect.poll(async () => (await popupInfo(app)).exists, { timeout: 5_000 }).toBe(false)

  // Esc on the desk.
  await inOpener(app, 'window.openB()')
  await expect(card).toHaveCount(1, { timeout: 10_000 })
  await expect(card.locator('[data-testid="desk-popup-title"]')).toHaveText('Sign in to Example', { timeout: 10_000 })
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await window.keyboard.press('Escape')
  await expect(card).toHaveCount(0, { timeout: 5_000 })
  await expect.poll(async () => (await popupInfo(app)).exists, { timeout: 5_000 }).toBe(false)

  // The page blanks itself after the hand-off.
  await inOpener(app, 'window.openB()')
  await expect(card).toHaveCount(1, { timeout: 10_000 })
  await expect(card.locator('[data-testid="desk-popup-title"]')).toHaveText('Sign in to Example', { timeout: 10_000 })
  await inOpener(app, "window.__popup.postMessage('please-blank', '*')")
  await expect(card).toHaveCount(0, { timeout: 10_000 })
})

test('stacked pop-ups: each its own card, last on top, only the top page shown', async () => {
  const { app, window } = await boot()
  await mountOpener(app, window)
  await inOpener(app, "void window.open('/b.html?1', 'one', 'width=480,height=560')")
  const card = window.locator('[data-testid="desk-popup-card"]')
  await expect(card).toHaveCount(1, { timeout: 10_000 })
  await inOpener(app, "void window.open('/b.html?2', 'two', 'width=480,height=560')")
  await expect(card).toHaveCount(2, { timeout: 10_000 })
  await expect(card.nth(1)).toHaveAttribute('data-top', 'true')
  await expect(card.nth(0)).toHaveAttribute('data-top', 'false')

  const visibility = await app.evaluate(({ BrowserWindow }) => {
    const kids = BrowserWindow.getAllWindows()[0].contentView.children as unknown as Array<{
      getVisible: () => boolean
      webContents?: { getURL: () => string }
    }>
    return kids
      .filter((k) => k.webContents && k.webContents.getURL().includes('/b.html'))
      .map((k) => ({ url: k.webContents!.getURL(), visible: k.getVisible() }))
  })
  expect(visibility.find((v) => v.url.endsWith('?1'))?.visible).toBe(false)
  expect(visibility.find((v) => v.url.endsWith('?2'))?.visible).toBe(true)

  // Esc closes the top one only; the one beneath becomes top and is shown.
  await window.keyboard.press('Escape')
  await expect(card).toHaveCount(1, { timeout: 5_000 })
  await expect(card.first()).toHaveAttribute('data-top', 'true')
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const kids = BrowserWindow.getAllWindows()[0].contentView.children as unknown as Array<{
          getVisible: () => boolean
          webContents?: { getURL: () => string }
        }>
        const k = kids.find((x) => x.webContents && x.webContents.getURL().includes('/b.html?1'))
        return k ? k.getVisible() : null
      })
    )
    .toBe(true)
})

test('a plain target=_blank link still becomes a desk browser object, not a card', async () => {
  const { app, window } = await boot()
  await mountOpener(app, window)
  await window.evaluate(() => {
    const w = window as unknown as { __links: string[] }
    w.__links = []
    window.api.webview.onLinkClicked(({ url }) => w.__links.push(url))
  })
  await inOpener(app, "document.getElementById('plain').click()")
  await expect
    .poll(() => window.evaluate(() => (window as unknown as { __links: string[] }).__links), { timeout: 10_000 })
    .toEqual([`${origin}/plain.html`])
  await expect(window.locator('[data-testid="desk-popup-card"]')).toHaveCount(0)
})

test('PLEXI_POPUPS_NATIVE=1 restores the native window, opener intact', async () => {
  const { app, window } = await boot({ PLEXI_POPUPS_NATIVE: '1' })
  await mountOpener(app, window)
  const before = await windowCount(app)
  await inOpener(app, 'window.openB()')
  await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(before + 1)
  await expect(window.locator('[data-testid="desk-popup-card"]')).toHaveCount(0)
  await expect
    .poll(() => inOpener<unknown[]>(app, 'window.__got'), { timeout: 10_000 })
    .toEqual([{ from: 'b', hasOpener: true }])
  // Settings reflects the forced mode.
  expect(await window.evaluate(() => window.api.deskPopups.getMode())).toEqual({ native: true, forcedByEnv: true })
})

test('a failed desk view falls back to a native window instead of dropping the pop-up', async () => {
  const { app, window } = await boot({ PLEXI_DESK_POPUP_FAIL: '1' })
  const logs: string[] = []
  app.process().stderr?.on('data', (b) => logs.push(String(b)))
  app.process().stdout?.on('data', (b) => logs.push(String(b)))
  await mountOpener(app, window)
  const before = await windowCount(app)
  await inOpener(app, 'window.openB()')
  await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(before + 1)
  await expect
    .poll(() => inOpener<unknown[]>(app, 'window.__got'), { timeout: 10_000 })
    .toEqual([{ from: 'b', hasOpener: true }])
  await expect.poll(() => logs.join('').includes('opening a native window instead'), { timeout: 5_000 }).toBe(true)
})

test('the Settings toggle switches the next pop-up to a native window', async () => {
  const { app, window } = await boot()
  expect(await window.evaluate(() => window.api.deskPopups.getMode())).toEqual({ native: false, forcedByEnv: false })
  expect(await window.evaluate(() => window.api.deskPopups.setNativeMode(true))).toEqual({
    native: true,
    forcedByEnv: false
  })
  await mountOpener(app, window)
  const before = await windowCount(app)
  await inOpener(app, 'window.openB()')
  await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(before + 1)
  await expect(window.locator('[data-testid="desk-popup-card"]')).toHaveCount(0)
})
