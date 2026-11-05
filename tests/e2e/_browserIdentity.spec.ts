// SWEEP, not a gate (real third-party sites): what a site sees from the desk
// browser widget, next to real Google Chrome on the same machine.
//
// Owner, 2026-11-05: "our browser widget [is] not supported by a lot of
// websites. It's often treated as a bot, and even Google won't let us change
// the account we are trying to log into because it's not a supported browser."
//
// Prints, for both: request headers (User-Agent, client hints), the page-side
// fingerprint bot checks read, Google's embedded-browser verdict on a public
// OAuth link (no account involved), and bot.sannysoft.com's failed rows.
import { test, chromium, type Page as PwPage } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

// Google's own OAuth Playground client: a public client id, no account used.
const GOOGLE_OAUTH =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=407408718192.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fdevelopers.google.com%2Foauthplayground&response_type=code&scope=email&prompt=select_account'

let launched: LaunchedApp | null = null
let server: Server | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

async function echoServer(): Promise<string> {
  server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/h')) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      return res.end(JSON.stringify(req.headers))
    }
    // Ask for every high-entropy hint, as Google and bot vendors do.
    res.writeHead(200, {
      'content-type': 'text/html',
      'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors',
      'critical-ch': 'Sec-CH-UA-Full-Version-List'
    })
    res.end('<!doctype html><title>probe</title><body>probe</body>')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `http://localhost:${(server!.address() as AddressInfo).port}`
}

/** Run in the page: what fingerprinting scripts read. */
const FINGERPRINT = `(async () => {
  const n = navigator
  const uad = n.userAgentData
  let high = null
  try { high = uad ? await uad.getHighEntropyValues(['fullVersionList','platformVersion','architecture','bitness','model','uaFullVersion']) : null } catch (e) { high = 'error ' + e }
  let perm = null
  try { perm = (await n.permissions.query({ name: 'notifications' })).state } catch (e) { perm = 'error' }
  let gl = null
  try { const c = document.createElement('canvas').getContext('webgl'); const d = c.getExtension('WEBGL_debug_renderer_info'); gl = d ? [c.getParameter(d.UNMASKED_VENDOR_WEBGL), c.getParameter(d.UNMASKED_RENDERER_WEBGL)] : 'no debug info' } catch (e) { gl = 'error' }
  const headers = await (await fetch('/h')).json()
  return {
    userAgent: n.userAgent,
    brands: uad ? uad.brands.map((b) => b.brand + ' ' + b.version) : null,
    high,
    webdriver: n.webdriver,
    plugins: n.plugins.length,
    pdfViewerEnabled: n.pdfViewerEnabled,
    mimeTypes: n.mimeTypes.length,
    languages: n.languages,
    chromeKeys: typeof window.chrome === 'object' ? Object.keys(window.chrome) : String(typeof window.chrome),
    notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : 'none',
    permissionsNotifications: perm,
    outer: [window.outerWidth, window.outerHeight],
    inner: [window.innerWidth, window.innerHeight],
    webgl: gl,
    headers: Object.fromEntries(Object.entries(headers).filter(([k]) => /user-agent|sec-ch|accept-language/.test(k)))
  }
})()`

/** Google's verdict on the OAuth link, read from the page. */
const GOOGLE_VERDICT = `(() => {
  const t = document.body ? document.body.innerText : ''
  const hit = [/disallowed_useragent/i, /may not be secure/i, /Access blocked/i, /browser.*(not supported|no longer supported)/i, /Couldn.t sign you in/i].find((r) => r.test(t))
  const email = !!document.querySelector('input[type="email"]')
  return { verdict: hit ? 'BLOCKED: ' + (t.match(hit) || [''])[0] : email ? 'OK: email field shown' : 'UNCLEAR', snippet: t.replace(/\\s+/g, ' ').slice(0, 220) }
})()`

const SANNY = `(() => Array.from(document.querySelectorAll('tr')).map((tr) => Array.from(tr.cells).map((c) => c.innerText.trim())).filter((r) => r.length >= 2 && /failed|warn/i.test(tr_cls(r))).slice(0, 30))()`

test('IDENTITY — what sites see from the desk browser widget vs real Chrome', async () => {
  test.setTimeout(300_000)
  const base = await echoServer()

  // ── The desk browser widget (through the main process: see _browserWindowsSoak) ──
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const ids = await window.evaluate(async (urls: string[]) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Identity' })
    const out: string[] = []
    let i = 0
    for (const u of urls) {
      const w = (await api.widgets.create({ taskId: task.id, kind: 'webview', title: String(i), content: u, x: 40 + i * 900, y: 40, width: 880, height: 700 } as never)) as { id: string }
      out.push(w.id)
      i++
    }
    return { taskId: task.id, out }
  }, [`${base}/probe`, GOOGLE_OAUTH, 'https://bot.sannysoft.com/'])
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  const js = async <T,>(code: string): Promise<T> =>
    app.evaluate(async ({ webContents }, c) => webContents.getAllWebContents().find((w) => w.getType() === 'window')!.executeJavaScript(c), code) as Promise<T>
  const versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }))
  await js(`window.__fbView.getState().goTask(${JSON.stringify(ids.taskId)}); true`)
  await new Promise((r) => setTimeout(r, 15_000))
  const inGuest = async <T,>(widgetId: string, code: string): Promise<T> =>
    app.evaluate(async ({ webContents }, a) => {
      const g = webContents.getAllWebContents().filter((w) => w.getType() === 'webview')
      // The guest whose host element belongs to this widget.
      const host = webContents.getAllWebContents().find((w) => w.getType() === 'window')!
      const guestId = await host.executeJavaScript(`(() => { const wv = document.querySelector('[data-web-for="${a.id}"] webview') || document.querySelector('[data-widget-id="${a.id}"] webview'); return wv ? wv.getWebContentsId() : -1 })()`)
      const guest = g.find((w) => w.id === guestId)
      if (!guest) return 'no guest' as unknown as T
      return guest.executeJavaScript(a.code) as Promise<T>
    }, { id: widgetId, code }) as Promise<T>

  const widget = {
    versions,
    fingerprint: await inGuest(ids.out[0]!, FINGERPRINT),
    google: await inGuest(ids.out[1]!, GOOGLE_VERDICT),
    sanny: await inGuest(ids.out[2]!, `Array.from(document.querySelectorAll('tr')).filter((tr) => /failed|warn/.test(tr.className + ' ' + Array.from(tr.cells).map((c) => c.className).join(' '))).map((tr) => Array.from(tr.cells).map((c) => c.innerText.trim().slice(0, 80)).join(' | ')).slice(0, 30)`)
  }
  await launched.dispose()
  launched = null

  // ── Real Google Chrome, as close to a person's as Playwright allows ──
  const chrome = await chromium.launch({ channel: 'chrome', headless: false, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] })
  const ctx = await chrome.newContext({ viewport: null })
  const run = async (url: string, code: string): Promise<unknown> => {
    const p: PwPage = await ctx.newPage()
    await p.goto(url, { waitUntil: 'load', timeout: 45_000 }).catch(() => undefined)
    await p.waitForTimeout(6_000)
    const r = await p.evaluate(code).catch((e) => 'error ' + e)
    await p.close()
    return r
  }
  const real = {
    fingerprint: await run(`${base}/probe`, FINGERPRINT),
    google: await run(GOOGLE_OAUTH, GOOGLE_VERDICT),
    sanny: await run('https://bot.sannysoft.com/', `Array.from(document.querySelectorAll('tr')).filter((tr) => /failed|warn/.test(tr.className + ' ' + Array.from(tr.cells).map((c) => c.className).join(' '))).map((tr) => Array.from(tr.cells).map((c) => c.innerText.trim().slice(0, 80)).join(' | ')).slice(0, 30)`)
  }
  await chrome.close()

  console.log('\n===== DESK BROWSER WIDGET =====\n' + JSON.stringify(widget, null, 1))
  console.log('\n===== REAL GOOGLE CHROME =====\n' + JSON.stringify(real, null, 1))
  void SANNY
})
