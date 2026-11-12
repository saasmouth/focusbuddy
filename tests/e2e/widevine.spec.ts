// Protected video (Widevine) in a desk web page, on the built app.
//
// Owner, 2026-11-13: Netflix in a desk page showed error M7701-1003, because
// stock Electron has no Widevine CDM. The app now runs on castLabs' Electron for
// Content Security, which installs the CDM through Chromium's component updater
// (src/main/widevine.ts), and every web page carries a probe that waits for it
// and notices when protected video is refused (src/shared/drm*.ts).
//
//   WV-1  a desk page gets Widevine: requestMediaKeySystemAccess resolves, and a
//         public Widevine-encrypted stream (Shaka Player's demo asset, licensed
//         by Widevine's test proxy) really plays: currentTime advances and
//         frames are decoded. Starts from a FRESH profile, so the CDM is
//         downloaded during the run, which is a first launch.
//   WV-2  Widevine refused (the component updater is switched off, so the CDM
//         never arrives): the page's request is rejected, and the calm notice
//         appears above the page saying why, with "Open in your browser",
//         which hands the page's address to the system browser.
//   WV-3  Netflix's own error screen (M7121-1331, served LOCALLY for
//         www.netflix.com in the desk browser's session; nothing reaches
//         Netflix): the notice names the VMP refusal.
//
// NETWORK: WV-1 and WV-3 reach Google's component updater (the CDM download)
// and WV-1 the public Shaka demo assets (storage.googleapis.com, the Shaka
// Player script on ajax.googleapis.com, the license proxy on
// cwip-shaka-proxy.appspot.com). None is a production host, so the net guard
// lets them through unchanged; it still refuses every production host.
//
// MUTATION PROOF (run by hand, see docs/drm.md): WV-1 must FAIL with
//   ELECTRON_OVERRIDE_DIST_PATH=<a stock Electron dist>   (no components API, no CDM)
//   E2E_WIDEVINE_MUTANT=no-cdm                            (component updater left off)
//
// UNDER PLAYWRIGHT the component updater is OFF unless a spec turns it back on:
// Playwright's loader appends --disable-component-update to every launch
// (_componentUpdates.cjs). WV-1 and WV-3 turn it back on, as a real launch has it.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

test.describe.configure({ mode: 'serial' })

const SHAKA = 'https://ajax.googleapis.com/ajax/libs/shaka-player/4.12.6/shaka-player.compiled.js'
const MANIFEST = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd'
const LICENSE = 'https://cwip-shaka-proxy.appspot.com/no_auth'

let launched: LaunchedApp | null = null
let server: Server | null = null
let logs: string[] = []
// WV-1 downloads the CDM into this profile; WV-3 reuses it rather than
// downloading it again.
const profile = mkdtempSync(join(tmpdir(), 'plexii-e2e-widevine-'))

test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})
test.afterAll(() => rmSync(profile, { recursive: true, force: true }))

/** The test pages, on localhost (a secure context, which EME requires). */
async function pageServer(): Promise<string> {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    res.writeHead(u.pathname === '/play' ? 200 : 404, { 'content-type': 'text/html' })
    if (u.pathname !== '/play') return res.end()
    res.end(`<!doctype html><meta charset="utf-8"><title>Widevine test</title>
<style>html,body{margin:0;height:100%;background:#111;color:#ddd;font:13px sans-serif}video{width:100%;height:85%;background:#000}</style>
<video id="v" muted playsinline></video><div id="s">starting</div>
<script>
window.__wv = { mksa: 'pending', play: 'idle' }
const configs = [{
  initDataTypes: ['cenc'],
  audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
  videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
}]
navigator.requestMediaKeySystemAccess('com.widevine.alpha', configs).then(
  (a) => { __wv.mksa = 'resolved'; __wv.keySystem = a.keySystem },
  (e) => { __wv.mksa = 'rejected: ' + e.name + ': ' + e.message }
)
window.__play = async () => {
  try {
    __wv.play = 'loading-shaka'
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = ${JSON.stringify(SHAKA)}; s.onload = ok; s.onerror = () => no(new Error('shaka script failed')); document.head.appendChild(s) })
    shaka.polyfill.installAll()
    const v = document.getElementById('v')
    const player = new shaka.Player()
    await player.attach(v)
    window.__player = player
    player.configure({
      drm: { servers: { 'com.widevine.alpha': ${JSON.stringify(LICENSE)} } },
      abr: { enabled: false },
      restrictions: { maxHeight: 480 },
      streaming: { bufferingGoal: 15 }
    })
    player.addEventListener('error', (e) => { __wv.error = 'shaka ' + e.detail.code + ' ' + (e.detail.message || '') })
    __wv.play = 'loading-manifest'
    await player.load(${JSON.stringify(MANIFEST)})
    __wv.drmKeySystem = player.keySystem()
    __wv.play = 'playing'
    await v.play()
  } catch (e) {
    __wv.play = 'failed'
    __wv.error = String(e && (e.code ? 'shaka ' + e.code : e.message) || e)
  }
}
</script>`)
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `http://localhost:${(server!.address() as AddressInfo).port}`
}

/**
 * componentUpdates: undo Playwright's --disable-component-update for this
 * launch (_componentUpdates.cjs), as a real launch of the app has it. Without
 * it the CDM never arrives, which is exactly what WV-2 wants.
 */
async function launch(opts: { userDataDir?: string; extraArgs?: string[]; componentUpdates: boolean }): Promise<{ app: ElectronApplication; window: Page }> {
  launched = await launchApp({
    userDataDir: opts.userDataDir,
    extraArgs: opts.extraArgs,
    preArgs: opts.componentUpdates ? ['-r', join(__dirname, '_componentUpdates.cjs')] : []
  })
  logs = []
  const keep = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (/\[(widevine|drm)\]/.test(line)) logs.push(line.trim())
  }
  launched.app.process().stdout?.on('data', keep)
  launched.app.process().stderr?.on('data', keep)
  const { app, window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  // "Open in your browser": record the address instead of opening anything
  // (background e2e already makes openExternal a no-op).
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      g.__opened.push(url)
    }
  })
  return { app, window }
}

/** A desk holding one browser work widget at `url`; returns the page's webContents id. */
async function deskPage(window: Page, url: string): Promise<{ widgetId: string; wcId: number }> {
  const { taskId, widgetId } = await window.evaluate(async (u: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Protected video' })
    const w = (await api.widgets.create({ taskId: task.id, kind: 'webview', title: 'Video', content: u, x: 40, y: 40, width: 900, height: 620, zIndex: 1 } as never)) as { id: string }
    return { taskId: task.id, widgetId: w.id }
  }, url)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), taskId)
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 15_000 })
  await window.evaluate(() => {
    const st = (window as unknown as { __fbWidgets: { getState: () => { setZoom: (z: number) => void; setPan: (x: number, y: number) => void } } }).__fbWidgets.getState()
    st.setZoom(1)
    st.setPan(0, 0)
  })
  const wv = window.locator(`[data-web-for="${widgetId}"] webview`)
  await expect(wv).toHaveCount(1, { timeout: 15_000 })
  let wcId = -1
  await expect
    .poll(async () => {
      wcId = await wv.evaluate((el) => {
        try {
          return (el as unknown as { getWebContentsId(): number }).getWebContentsId()
        } catch {
          return -1
        }
      })
      return wcId
    }, { timeout: 15_000, message: 'the page is attached' })
    .toBeGreaterThan(0)
  return { widgetId, wcId }
}

/** Run script in the page, through main (the page channel can stall on real sites). */
function inPage<T>(app: ElectronApplication, wcId: number, js: string): Promise<T> {
  return app.evaluate(({ webContents }, a: { id: number; js: string }) => {
    const wc = webContents.fromId(a.id)
    if (!wc) throw new Error(`no web contents ${a.id}`)
    wc.setAudioMuted(true)
    return wc.executeJavaScript(a.js) as Promise<T>
  }, { id: wcId, js }) as Promise<T>
}

const cdm = (app: ElectronApplication): Promise<{ api: boolean; status: string | null; version: string | null }> =>
  app.evaluate((electron) => {
    const c = (electron as unknown as { components?: { WIDEVINE_CDM_ID: string; status(): Record<string, { status: string; version: string | null }> } }).components
    if (!c) return { api: false, status: null, version: null }
    const s = c.status()[c.WIDEVINE_CDM_ID]
    return { api: true, status: s?.status ?? null, version: s?.version ?? null }
  })

test('WV-1 — a desk page gets Widevine: requestMediaKeySystemAccess resolves and an encrypted stream plays', async () => {
  test.setTimeout(240_000)
  const base = await pageServer()
  const mutant = process.env.E2E_WIDEVINE_MUTANT
  const { app, window } = await launch({ userDataDir: profile, componentUpdates: mutant !== 'no-cdm' })
  const { wcId } = await deskPage(window, `${base}/play`)

  // 1. The key system: this request was made at page load, possibly before
  //    the CDM had finished downloading; the probe holds it until it has.
  await expect
    .poll(() => inPage<string>(app, wcId, 'window.__wv && window.__wv.mksa'), { timeout: 60_000, intervals: [500], message: 'requestMediaKeySystemAccess settles' })
    .not.toBe('pending')
  const mksa = await inPage<{ mksa: string; keySystem?: string }>(app, wcId, 'JSON.parse(JSON.stringify(window.__wv))')
  console.log(`[WV-1] requestMediaKeySystemAccess('com.widevine.alpha') → ${mksa.mksa} ${mksa.keySystem ?? ''}`)
  console.log(`[WV-1] CDM ${JSON.stringify(await cdm(app))}`)
  expect(mksa.mksa).toBe('resolved')
  expect(mksa.keySystem).toBe('com.widevine.alpha')

  // 2. Real playback of a Widevine-encrypted stream.
  await inPage(app, wcId, 'window.__play(), true')
  await expect
    .poll(() => inPage<string>(app, wcId, 'window.__wv.play + (window.__wv.error ? " / " + window.__wv.error : "")'), { timeout: 90_000, intervals: [1000], message: 'the player starts' })
    .toMatch(/^(playing|failed)/)
  const sample = (): Promise<{ t: number; frames: number; decoded: number; paused: boolean; ready: number; err: string | null; ks: string | null }> =>
    inPage(app, wcId, `(() => {
      const v = document.getElementById('v')
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : { totalVideoFrames: 0 }
      return { t: v.currentTime, frames: q.totalVideoFrames, decoded: v.webkitDecodedFrameCount || 0, paused: v.paused, ready: v.readyState,
               err: window.__wv.error || null, ks: window.__wv.drmKeySystem || null }
    })()`)
  const first = await sample()
  expect(first.err, 'the player reported an error').toBeNull()
  expect(first.ks).toBe('com.widevine.alpha')
  await expect.poll(async () => (await sample()).t, { timeout: 45_000, intervals: [1000], message: 'playback advances' }).toBeGreaterThan(first.t + 2)
  const later = await sample()
  console.log(`[WV-1] playback: currentTime ${first.t.toFixed(2)} → ${later.t.toFixed(2)} s, decoded frames ${later.decoded}, total frames ${later.frames}, readyState ${later.ready}, paused ${later.paused}`)
  expect(later.decoded).toBeGreaterThan(0)
  expect(later.frames).toBeGreaterThan(0)

  // No notice for a page whose protected video plays.
  await expect(window.locator('[data-testid="browser-drm-notice"]')).toHaveCount(0)
  console.log(`[WV-1] main log:\n  ${logs.join('\n  ')}`)
})

test('WV-2 — Widevine refused: the request is rejected and the notice says why, with "Open in your browser"', async () => {
  test.setTimeout(150_000)
  const base = await pageServer()
  // A fresh profile with the component updater off: the CDM never arrives.
  const { app, window } = await launch({ extraArgs: ['--disable-component-update'], componentUpdates: false })
  const { widgetId, wcId } = await deskPage(window, `${base}/play`)

  await expect
    .poll(() => inPage<string>(app, wcId, 'window.__wv && window.__wv.mksa'), { timeout: 60_000, intervals: [500], message: 'requestMediaKeySystemAccess settles' })
    .toMatch(/^rejected/)
  console.log(`[WV-2] requestMediaKeySystemAccess → ${await inPage<string>(app, wcId, 'window.__wv.mksa')}`)

  const widget = window.locator(`[data-widget-id="${widgetId}"]`)
  const notice = widget.locator('[data-testid="browser-drm-notice"]')
  await expect(notice).toBeVisible({ timeout: 15_000 })
  await expect(notice).toHaveAttribute('data-reason', 'widevine-missing')
  await expect(notice).toHaveAttribute('role', 'status')
  const text = (await notice.locator('[data-testid="browser-drm-notice-text"]').textContent()) ?? ''
  console.log(`[WV-2] notice (${await notice.getAttribute('data-reason')}): ${text}`)
  expect(text).toMatch(/Widevine/)
  expect(text).toMatch(/in your own browser/)

  // The page is not blocked: still loaded and scriptable under the notice.
  expect(await inPage<string>(app, wcId, 'document.title')).toBe('Widevine test')

  await notice.locator('[data-testid="browser-drm-open"]').click()
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([`${base}/play`])

  await notice.locator('[data-testid="browser-drm-dismiss"]').click()
  await expect(notice).toHaveCount(0)
  console.log(`[WV-2] main log:\n  ${logs.join('\n  ')}`)
})

test("WV-3 — Netflix's error screen (M7121-1331) names the VMP refusal", async () => {
  test.setTimeout(150_000)
  const { app, window } = await launch({ userDataDir: profile, componentUpdates: true })
  await expect.poll(async () => (await cdm(app)).version, { timeout: 60_000, message: 'the CDM is ready' }).not.toBeNull()

  // www.netflix.com, answered locally in the desk browser's session: an error
  // screen like Netflix's, drawn after load. Every other https request goes on.
  await app.evaluate(({ session, net }) => {
    const ses = session.fromPartition('persist:webview-default')
    ses.protocol.handle('https', (req) => {
      if (new URL(req.url).hostname === 'www.netflix.com') {
        return new Response(
          '<!doctype html><title>Netflix</title><body><div id="app">Loading…</div><script>' +
            'setTimeout(function(){document.getElementById("app").innerHTML=' +
            '"<div class=\\"nfp-error\\"><h1>Oops, something went wrong…</h1><p>Unexpected Error</p><p>Error Code: <span>M7121-1331</span></p></div>"},400)' +
            '</script></body>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } }
        )
      }
      return net.fetch(req, { bypassCustomProtocolHandlers: true })
    })
  })
  const { widgetId } = await deskPage(window, 'https://www.netflix.com/watch/80000000')
  const notice = window.locator(`[data-widget-id="${widgetId}"] [data-testid="browser-drm-notice"]`)
  await expect(notice).toBeVisible({ timeout: 20_000 })
  await expect(notice).toHaveAttribute('data-reason', 'vmp-refused')
  const text = (await notice.locator('[data-testid="browser-drm-notice-text"]').textContent()) ?? ''
  console.log(`[WV-3] notice (vmp-refused): ${text}`)
  expect(text).toContain('Netflix error M7121-1331')
  expect(text).toContain('(VMP)')
  console.log(`[WV-3] main log:\n  ${logs.join('\n  ')}`)
})
