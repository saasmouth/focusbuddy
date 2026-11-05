// The desk browser presents as desktop Chrome on EVERY page (owner,
// 2026-11-05: sites treat it as a bot, and Google refuses sign-in as "not a
// supported browser").
//
// Measured on the packaged 4.3.46-wc.3: the FIRST page of each browser session
// sent Electron's own User-Agent ("plexii/4.3.46-wc.3 … Electron/44.7.2"),
// because the clean UA was only set on the session, and session.setUserAgent
// does not reach a WebContents that already exists. Every connected app has
// its own session, so its first page (often a Google sign-in) announced an
// embedded browser. The version also went out as the full build
// ("Chrome/152.0.7977.149"), which no shipping Chrome sends.
//
// Local pages only; tests/e2e/_browserIdentity.spec.ts is the real-site sweep
// (Google's OAuth page, bot.sannysoft.com, side by side with real Chrome).
import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let server: Server | null = null
let seen: Array<{ path: string; ua: string }> = []
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

const EMBEDDED = /Electron\/|plexii\/|focusbuddy\/|Haptyx\/|PlexiDesk\//i

test('UA-1 — every page, including the first of its session, sends the reduced desktop-Chrome UA in its headers and to its scripts', async () => {
  test.setTimeout(90_000)
  seen = []
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', ua: String(req.headers['user-agent'] ?? '') })
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>ua</title><body>ua</body>')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const base = `http://localhost:${(server.address() as AddressInfo).port}`

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const ids = await window.evaluate(async (b: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'UA' })
    const out: string[] = []
    for (let i = 0; i < 3; i++) {
      const w = (await api.widgets.create({ taskId: t.id, kind: 'webview', title: `p${i}`, content: `${b}/p${i}`, x: 40 + i * 420, y: 40, width: 400, height: 300 } as never)) as { id: string }
      out.push(w.id)
    }
    return { taskId: t.id, out }
  }, base)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), ids.taskId)
  await expect.poll(() => new Set(seen.map((s) => s.path)).size, { timeout: 20_000, message: 'all three pages requested' }).toBeGreaterThanOrEqual(3)

  // What the server got: every request, the first included.
  for (const s of seen) {
    expect(s.ua, `request ${s.path}`).not.toMatch(EMBEDDED)
    expect(s.ua, `request ${s.path}`).toMatch(/ Chrome\/\d+\.0\.0\.0 /)
  }
  // What the pages' own scripts read.
  const uas = await window.evaluate(async (list: string[]) => {
    const out: string[] = []
    for (const id of list) {
      const wv = (document.querySelector(`[data-web-for="${id}"] webview`) ?? document.querySelector(`[data-widget-id="${id}"] webview`)) as (HTMLElement & { executeJavaScript: (c: string) => Promise<unknown> }) | null
      out.push(wv ? String(await wv.executeJavaScript('navigator.userAgent')) : 'no page')
    }
    return out
  }, ids.out)
  for (const ua of uas) {
    expect(ua).not.toMatch(EMBEDDED)
    expect(ua).toMatch(/ Chrome\/\d+\.0\.0\.0 /)
  }
})
