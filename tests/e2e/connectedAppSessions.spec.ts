import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Connected apps stay signed in between launches (4.3.31).
//
// A page inside a connected app's partition sets session cookies — one from
// script, one HttpOnly from the server — plus an ordinary cookie with its own
// Max-Age. The app is quit and relaunched on the SAME throwaway profile dir:
//   - setting on (default): the session cookies are still there, and the
//     expiring cookie's lifetime was never touched;
//   - setting off: the session cookies are gone (plain browser behaviour) while
//     the expiring cookie survives, which proves the jar itself persisted.
// Then the side menu: an app seen signed in that lands on a sign-in page shows
// "Signed out — sign in", logs one query-free diagnostic line, and clears when
// it is back on a normal page.
//
// Real Electron, throwaway profile dirs (deleted at the end), PLEXI_APP=preview3.

let server: Server | null = null
let origin = ''
let launched: LaunchedApp | null = null

const SET_PAGE = `<!doctype html><title>Inbox</title><body>signed in
<script>document.cookie = 'sid=s1; path=/'</script></body>`
const APP_PAGE = `<!doctype html><title>Inbox</title><body><h1>Inbox</h1></body>`
const LOGIN_PAGE = `<!doctype html><title>Log in</title><body><form><input type="password" name="p"></form></body>`

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path === '/set.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': ['hsid=h1; Path=/; HttpOnly', 'keep=k1; Path=/; Max-Age=86400']
      })
      res.end(SET_PAGE)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(path === '/login' ? LOGIN_PAGE : APP_PAGE)
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

async function boot(userDataDir: string): Promise<{ app: ElectronApplication; window: Page }> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' }, userDataDir })
  await waitForReady(launched.window)
  return { app: launched.app, window: launched.window }
}

async function quit(): Promise<void> {
  // Graceful quit, so before-quit's flush runs (dispose falls back to a kill
  // only if close hangs).
  if (launched) await launched.dispose()
  launched = null
}

interface CookieView {
  name: string
  session: boolean
  expirationDate: number | null
}

async function cookiesIn(app: ElectronApplication, partition: string): Promise<CookieView[]> {
  return app.evaluate(async ({ session }, p) => {
    const all = await session.fromPartition(p).cookies.get({})
    return all.map((c) => ({ name: c.name, session: !!c.session, expirationDate: c.expirationDate ?? null }))
  }, partition)
}

async function mountAppWebview(window: Page, partition: string, src: string): Promise<void> {
  await window.evaluate(
    ({ partition, src }) => {
      const wv = document.createElement('webview')
      wv.setAttribute('partition', partition)
      wv.setAttribute('src', src)
      wv.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:200px;z-index:1'
      document.body.appendChild(wv)
    },
    { partition, src }
  )
}

async function setUpCookies(keep: boolean): Promise<{ dir: string; partition: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-e2e-sessions-'))
  const { app, window } = await boot(dir)
  if (!keep) {
    expect(await window.evaluate(() => window.api.sessions.setKeepSignedIn(false))).toEqual({ keep: false })
  } else {
    expect(await window.evaluate(() => window.api.sessions.getKeepSignedIn())).toEqual({ keep: true })
  }
  const created = await window.evaluate(
    (url) => window.api.connectedApps.create({ title: 'Cookie Test', url }),
    `${origin}/set.html`
  )
  const partition = `persist:connectedapp-${created.id}`
  await mountAppWebview(window, partition, `${origin}/set.html`)
  await expect
    .poll(async () => (await cookiesIn(app, partition)).map((c) => c.name).sort(), { timeout: 15_000 })
    .toEqual(['hsid', 'keep', 'sid'])
  return { dir, partition }
}

test('setting on: session cookies in a connected app survive a relaunch; expiring cookies are untouched', async () => {
  const { dir, partition } = await setUpCookies(true)
  try {
    const app1 = launched!.app
    const now = Date.now() / 1000
    // Kept: the two session cookies now carry a ~30-day expiry.
    await expect
      .poll(async () => (await cookiesIn(app1, partition)).filter((c) => c.name !== 'keep').every((c) => !c.session), {
        timeout: 10_000
      })
      .toBe(true)
    const before = await cookiesIn(app1, partition)
    for (const c of before.filter((c) => c.name !== 'keep')) {
      expect(c.expirationDate! - now).toBeGreaterThan(29 * 86400)
      expect(c.expirationDate! - now).toBeLessThan(31 * 86400)
    }
    // Never altered: the site's own one-day cookie keeps its one day.
    const keepCookie = before.find((c) => c.name === 'keep')!
    expect(keepCookie.session).toBe(false)
    expect(Math.abs(keepCookie.expirationDate! - (now + 86400))).toBeLessThan(120)

    await quit()

    const { app: app2 } = await boot(dir)
    const after = await cookiesIn(app2, partition)
    expect(after.map((c) => c.name).sort()).toEqual(['hsid', 'keep', 'sid'])
  } finally {
    await quit()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setting off: session cookies end at quit, like a plain browser', async () => {
  const { dir, partition } = await setUpCookies(false)
  try {
    const app1 = launched!.app
    // Give the (disabled) listener every chance to act, then confirm it did not.
    await new Promise((r) => setTimeout(r, 1_000))
    const before = await cookiesIn(app1, partition)
    expect(before.filter((c) => c.name !== 'keep').every((c) => c.session)).toBe(true)

    await quit()

    const { app: app2, window } = await boot(dir)
    // The choice itself persisted.
    expect(await window.evaluate(() => window.api.sessions.getKeepSignedIn())).toEqual({ keep: false })
    const after = await cookiesIn(app2, partition)
    expect(after.map((c) => c.name).sort()).toEqual(['keep'])
  } finally {
    await quit()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('turning the setting off returns kept cookies to session cookies straight away', async () => {
  const { dir, partition } = await setUpCookies(true)
  try {
    const { app, window } = launched!
    await expect
      .poll(async () => (await cookiesIn(app, partition)).find((c) => c.name === 'sid')?.session, { timeout: 10_000 })
      .toBe(false)
    await window.evaluate(() => window.api.sessions.setKeepSignedIn(false))
    await expect
      .poll(async () => (await cookiesIn(app, partition)).filter((c) => c.name !== 'keep').every((c) => c.session), {
        timeout: 10_000
      })
      .toBe(true)
    // The site's own expiring cookie was never ours to change.
    expect((await cookiesIn(app, partition)).find((c) => c.name === 'keep')?.session).toBe(false)
  } finally {
    await quit()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the side menu says when a connected app has been signed out, and clears when it is back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-e2e-sessions-'))
  try {
    const { app, window } = await boot(dir)
    const logs: string[] = []
    app.process().stdout?.on('data', (b) => logs.push(String(b)))

    const created = await window.evaluate(async (url) => {
      const a = await window.api.connectedApps.create({ title: 'Signout Test', url })
      await window.api.nodes.create({ parentId: null, kind: 'task', title: 'Sessions desk' })
      return a
    }, `${origin}/app.html`)
    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: 'Sessions desk' }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

    const tile = window.getByTestId(`nav-connected-app-${created.id}`)
    await expect(tile).toBeVisible()
    await expect(tile.getByTestId('nav-signed-out')).toHaveCount(0)
    await tile.click()

    // Seen signed in: a settled, normal page in its own partition.
    await expect
      .poll(
        () =>
          window.evaluate(
            (id) => JSON.parse(localStorage.getItem('fb.appNotifications.signIn') ?? '{}')[id]?.everSignedIn ?? false,
            created.id
          ),
        { timeout: 15_000 }
      )
      .toBe(true)

    const navigateGuest = (to: string): Promise<void> =>
      app.evaluate(
        async ({ webContents }, { from, to }) => {
          const wc = webContents
            .getAllWebContents()
            .find((w) => w.getType() === 'webview' && !w.isDestroyed() && w.getURL().startsWith(from))
          if (!wc) throw new Error('connected app guest not found')
          await wc.loadURL(to)
        },
        { from: origin, to }
      )

    // Signed out: the app lands on its sign-in page.
    await navigateGuest(`${origin}/login?token=SECRET-TOKEN&email=a%40b.c`)
    await expect(tile.getByTestId('nav-signed-out')).toBeVisible({ timeout: 10_000 })
    await expect(tile.getByTestId('nav-signed-out')).toHaveText('Signed out — sign in')
    await expect(tile).toHaveAttribute('data-signed-out', 'true')

    // One diagnostic line: origin + path, the signal, cookie counts — no query.
    await expect.poll(() => logs.join(''), { timeout: 5_000 }).toContain(`connected app ${created.id} looks signed out`)
    const line = logs.join('').split('\n').find((l) => l.includes('looks signed out'))!
    expect(line).toContain(`${origin}/login`)
    expect(line).toContain('signal: password-field')
    expect(line).toMatch(/cookies now \d+/)
    expect(line).not.toContain('SECRET')
    expect(line).not.toContain('?')

    // Back on a normal page: cleared.
    await navigateGuest(`${origin}/app.html`)
    await expect(tile.getByTestId('nav-signed-out')).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await quit()
    rmSync(dir, { recursive: true, force: true })
  }
})
