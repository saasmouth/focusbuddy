// Notifications from desk-browser pages are the person's choice, per site
// (main/webNotifications.ts). Measured 2026-11-05: every page had them
// GRANTED on first visit; real Chrome says "default" and asks.
import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let server: Server | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

const permissionOf = (window: Page, widgetId: string): Promise<string | null> =>
  window.evaluate(async (id: string) => {
    const wv = (document.querySelector(`[data-web-for="${id}"] webview`) ?? document.querySelector(`[data-widget-id="${id}"] webview`)) as (HTMLElement & { executeJavaScript: (c: string) => Promise<unknown> }) | null
    if (!wv) return null
    try {
      return String(await wv.executeJavaScript('Notification.permission'))
    } catch {
      return null
    }
  }, widgetId)

test('NOTIF-1 — a desk page has no notifications until its site is allowed; a connected app keeps them', async () => {
  test.setTimeout(90_000)
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>n</title><body>n</body>')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const base = `http://localhost:${(server.address() as AddressInfo).port}`

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const ids = await window.evaluate(async (b: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'Notifications' })
    const page = (await api.widgets.create({ taskId: t.id, kind: 'webview', title: 'page', content: `${b}/page`, x: 40, y: 40, width: 400, height: 300 } as never)) as { id: string }
    // A webview bound to a connected app runs in that app's partition.
    const app = (await api.widgets.create({ taskId: t.id, kind: 'webview', title: 'app', content: `${b}/app`, x: 480, y: 40, width: 400, height: 300, sourceAppId: 'e2e-notify-app' } as never)) as { id: string }
    return { taskId: t.id, page: page.id, app: app.id }
  }, base)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), ids.taskId)

  await expect.poll(() => permissionOf(window, ids.page), { timeout: 20_000, message: 'a desk page: blocked by default' }).toBe('denied')
  await expect.poll(() => permissionOf(window, ids.app), { timeout: 20_000, message: 'a connected app: allowed' }).toBe('granted')

  // The person allows this site (what the browser menu's switch calls).
  expect(await window.evaluate((u: string) => (window as unknown as { api: typeof window.api }).api.webNotifications.set(u, true), `${base}/page`)).toBe(true)
  await expect.poll(() => permissionOf(window, ids.page), { timeout: 10_000, message: 'allowed: the page sees it at once' }).toBe('granted')
  // And off again.
  expect(await window.evaluate((u: string) => (window as unknown as { api: typeof window.api }).api.webNotifications.set(u, false), `${base}/page`)).toBe(false)
  await expect.poll(() => permissionOf(window, ids.page), { timeout: 10_000 }).toBe('denied')
})
