import { test, expect, type Page } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, type LaunchedApp, waitForReady, sideMenuWidget } from './_helpers'

// "Lever 3 Phase 0: outbound webhooks" (plexi-4.0):
//   - A new widget kind 'webhook' ("Send to a URL" in the catalog / the
//     right-click create-and-connect menu). It renders a URL field, a
//     "Send test" button that POSTs a one-off test JSON body via
//     window.api.webhooks.send (main process, no CORS), and an honest
//     result line (green on ok, red on failure).
//   - In the wire engine (wireEngine.ts), ANY wire whose TARGET is a
//     webhook widget is reactive: on the source's content change, the
//     source's content is POSTed to the webhook's URL, and the wire's run
//     status (freshness / error) reports the send.
//
// Every scenario here POSTs only to a Node http server bound to
// 127.0.0.1 that this spec starts and tears down itself. Nothing ever
// leaves the machine.

let launched: LaunchedApp | null = null
let activeServer: http.Server | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()))
    activeServer = null
  }
})

interface CapturedRequest {
  method: string
  body: string
  contentType?: string
}

// Starts a plain Node HTTP server on 127.0.0.1 (random free port) that
// captures every request it receives and always answers 200 OK. Registered
// on `activeServer` so afterEach always tears it down even if a test fails
// mid-way.
function startLocalServer(): Promise<{ url: string; requests: CapturedRequest[] }> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = []
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        requests.push({
          method: req.method ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: req.headers['content-type']
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ received: true }))
      })
    })
    activeServer = srv
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${addr.port}`, requests })
    })
  })
}

// A guaranteed-closed local port: start a server, grab its URL, then close
// it immediately. Nothing will ever answer there, so a POST to this URL
// fails fast with ECONNREFUSED — deterministic and fully local (no DNS,
// no internet), unlike a made-up hostname.
async function unreachableLocalUrl(): Promise<string> {
  const { url } = await startLocalServer()
  await new Promise<void>((resolve) => activeServer!.close(() => resolve()))
  activeServer = null
  return url
}

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

async function editContentViaStore(window: Page, widgetId: string, content: string): Promise<void> {
  await window.evaluate(
    async ({ id, content: c }: { id: string; content: string }) => {
      const w = window as unknown as {
        __fbWidgets?: { getState: () => { update: (id: string, patch: { content: string }) => Promise<unknown> } }
      }
      await w.__fbWidgets?.getState().update(id, { content: c })
    },
    { id: widgetId, content }
  )
}

async function widgetContent(window: Page, taskId: string, widgetId: string): Promise<string | undefined> {
  return window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(tid)
      return ws.find((w) => w.id === wid)?.content
    },
    { tid: taskId, wid: widgetId }
  )
}

async function linkOf(
  window: Page,
  taskId: string,
  linkId: string
): Promise<{ lastRunAt: number | null; lastError: string | null; type: string } | undefined> {
  return window.evaluate(
    async ({ tid, lid }: { tid: string; lid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const links = await api.widgetLinks.listByTask(tid)
      const l = links.find((x) => x.id === lid)
      return l ? { lastRunAt: l.lastRunAt ?? null, lastError: l.lastError ?? null, type: l.type } : undefined
    },
    { tid: taskId, lid: linkId }
  )
}

async function dismissFeatureSpotlight(window: Page): Promise<void> {
  const dismiss = window.locator('[data-testid="feature-spotlight-dismiss"]')
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click().catch(() => {})
  }
}

async function openAutomationsPanel(window: Page): Promise<void> {
  const fab = window.locator('[data-testid="automations-fab"]')
  await expect(fab).toBeVisible({ timeout: 5_000 })
  await window.waitForTimeout(1_000)
  await dismissFeatureSpotlight(window)
  await fab.click({ timeout: 10_000 })
  await expect(window.locator('[data-testid="automations-panel"]')).toBeVisible({ timeout: 3_000 })
}

// ── (a) the webhook widget renders its URL field + Send test button ────────

test('(a) a webhook widget created via window.api.widgets.create renders webhook-url + webhook-test', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, widgetId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook widget render' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'webhook',
      title: 'Send to a URL',
      content: '',
      x: 200,
      y: 200,
      width: 320,
      height: 180
    })
    return { taskId: task.id, widgetId: w.id }
  })
  await openTask(window, /Webhook widget render/)

  // Scoped by [data-widget-id] — the webhook widget is now wrapped in the
  // shared WidgetFrame (fixed; see (a3)), same as every other widget kind.
  const frame = window.locator(`[data-widget-id="${widgetId}"]`)
  await expect(frame).toBeVisible({ timeout: 4_000 })
  await expect(frame.locator('[data-testid="webhook-url"]')).toBeVisible()
  await expect(frame.locator('[data-testid="webhook-test"]')).toBeVisible()
  // No result line before any send has been attempted.
  await expect(frame.locator('[data-testid="webhook-result"]')).toHaveCount(0)
  void taskId
})

// FIXED (was a defect, now verified): the webhook widget wraps its content in
// the shared <WidgetFrame> component, exactly like every other widget kind
// (sticky, note, agent, ...) — which is what stamps `data-widget-id` on the
// DOM, applies the widget's x/y as absolute canvas positioning, and gives it
// drag/resize/rename/pin/delete chrome. This test checks all three: the
// anchor exists, it renders at its created canvas position, and a real
// pointer-driven drag actually moves it (persisted x/y changes).
test('(a3) the webhook widget has data-widget-id, renders at its created position, and is draggable', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ORIGIN = { x: 777, y: 555 }
  const { taskId, widgetId, anchorId } = await window.evaluate(async (origin) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook frame fix' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'webhook',
      title: 'Send to a URL',
      content: '',
      x: origin.x,
      y: origin.y,
      width: 320,
      height: 180
    })
    // A second, known-good WidgetFrame-wrapped widget at a fixed offset from
    // the webhook, so position can be checked as a RELATIVE pixel delta
    // (robust to whatever the canvas's own screen origin/pan/zoom happens to
    // be) rather than assuming an absolute screen coordinate.
    const anchor = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Anchor',
      content: 'anchor',
      x: origin.x - 300,
      y: origin.y,
      width: 200,
      height: 150
    })
    return { taskId: task.id, widgetId: w.id, anchorId: anchor.id }
  }, ORIGIN)
  await openTask(window, /Webhook frame fix/)

  const frame = window.locator(`[data-widget-id="${widgetId}"]`)
  const anchor = window.locator(`[data-widget-id="${anchorId}"]`)
  await expect(frame).toBeVisible({ timeout: 4_000 })
  await expect(anchor).toBeVisible({ timeout: 4_000 })

  // Position: the webhook widget's box must sit exactly 300px right of (and
  // level with) the anchor's box, matching the 300px x-offset both were
  // created with — proof it's rendered at its actual canvas x/y, not stacked
  // in document flow.
  const frameBox = await frame.boundingBox()
  const anchorBox = await anchor.boundingBox()
  if (!frameBox || !anchorBox) throw new Error('missing bounding box for frame or anchor')
  expect(frameBox.x - anchorBox.x, 'webhook widget sits 300px (scaled) right of the anchor').toBeCloseTo(
    300 * (frameBox.width / 320),
    0
  )
  expect(Math.abs(frameBox.y - anchorBox.y), 'webhook widget is vertically level with the anchor').toBeLessThan(4)

  // Draggable: real pointer-driven drag via the widget's own .widget-handle,
  // dispatched as native MouseEvents (the reliable pattern already
  // established in dragPriority.spec.ts for react-rnd under headless
  // Electron — CDP-level mouse.move/down/up doesn't reach DraggableCore's
  // document-level listeners reliably here). Confirms the persisted x/y
  // actually change, not just a visual reflow.
  const dx = 120
  const dy = 40
  await window.evaluate(
    async ({ widgetId, dx, dy }) => {
      const handle = document.querySelector(`[data-widget-id="${widgetId}"] .widget-handle`) as HTMLElement | null
      if (!handle) throw new Error('no .widget-handle found on the webhook widget')
      const box = handle.getBoundingClientRect()
      const startX = box.left + box.width / 2
      const startY = box.top + Math.min(20, box.height / 2)
      const fire = (target: EventTarget, type: string, x: number, y: number): void => {
        target.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y })
        )
      }
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      fire(handle, 'mousedown', startX, startY)
      await sleep(20)
      const steps = 20
      for (let i = 1; i <= steps; i++) {
        fire(document, 'mousemove', startX + (dx * i) / steps, startY + (dy * i) / steps)
        await sleep(10)
      }
      await sleep(20)
      fire(document, 'mouseup', startX + dx, startY + dy)
    },
    { widgetId, dx, dy }
  )
  await window.waitForTimeout(400)

  const after = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(tid)
      const w = ws.find((x) => x.id === wid)
      return w ? { x: w.x, y: w.y } : undefined
    },
    { tid: taskId, wid: widgetId }
  )
  expect(after, 'the dragged webhook widget is still on the desk').toBeTruthy()
  expect(after!.x, 'x moved by the drag delta').not.toBe(ORIGIN.x)
  expect(after!.y, 'y moved by the drag delta').not.toBe(ORIGIN.y)
})

// Separate lightweight check: "Send to a URL" is offered from BOTH the
// side menu's Widgets section (catalog; the widget palette until 4.3.32) and the real right-click create-and-connect
// menu — UI-driven, no store shortcuts.
test('(a2) "Send to a URL" is offered from the side menu and the right-click create-and-connect menu', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook catalog check' })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Source',
      content: 'hello',
      x: 160,
      y: 160,
      width: 240,
      height: 160
    })
  })
  await openTask(window, /Webhook catalog check/)

  // Catalogue entry. Since 4.3.32 that is the side menu's Widgets section (the
  // hover palette this used was removed). "Send to a URL" is a lesser-used
  // kind, so it starts under Other widgets — sideMenuWidget expands it.
  const webhookTile = await sideMenuWidget(window, 'webhook')
  await expect(webhookTile).toBeVisible({ timeout: 3_000 })
  await expect(webhookTile).toContainText('Send to a URL')

  // Right-click create-and-connect menu, driven as a real UI gesture on the
  // sticky's body off its text: a toolbar button, not the textarea (text gets
  // the text menu, SPEC §9.3, E-5; the body's edge is the frame's resize band).
  await window.locator('[data-fb-sticky-body] [data-testid="sticky-checklist"]').first().click({ button: 'right' })
  // The unified right-click menu nests the create-and-connect list under
  // More actions › Create & link (opens on hover), rather than a flat list.
  await window.locator('[data-canvas-ctx-menu]').first().getByRole('menuitem', { name: 'More actions' }).hover()
  await window.getByRole('menuitem', { name: 'Create & link' }).hover()
  // In the menu: the side menu's own "Send to a URL" tile is on screen too.
  await expect(window.locator('[data-canvas-ctx-menu]').getByText('Send to a URL', { exact: true })).toBeVisible({ timeout: 3_000 })
})

// ── (b) Send test POSTs the test body to the local server; honest result ──

test('(b) Send test POSTs a test JSON body to the configured URL and shows a green result', async () => {
  const { url, requests } = await startLocalServer()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook send test' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'webhook',
      title: 'Send to a URL',
      content: '',
      x: 200,
      y: 200,
      width: 320,
      height: 180
    })
    return { widgetId: w.id }
  })
  await openTask(window, /Webhook send test/)

  const frame = window.locator(`[data-widget-id="${widgetId}"]`)
  await frame.locator('[data-testid="webhook-url"]').fill(url)
  await frame.locator('[data-testid="webhook-test"]').click()

  await expect
    .poll(() => requests.length, { timeout: 5_000, intervals: [100, 200, 300] })
    .toBeGreaterThanOrEqual(1)

  const req = requests[0]
  expect(req.method).toBe('POST')
  const parsed = JSON.parse(req.body) as { test: boolean; from: string; at: string }
  expect(parsed.test).toBe(true)
  expect(parsed.from).toBe('PlexiiDesk')
  expect(typeof parsed.at).toBe('string')

  const result = frame.locator('[data-testid="webhook-result"]')
  await expect(result).toBeVisible({ timeout: 3_000 })
  await expect(result).toContainText(/Sent OK/)
  const cls = await result.getAttribute('class')
  expect(cls, 'result line is styled green (emerald) on success').toMatch(/emerald/)
})

// ── (c) a wired source's content POSTs to the webhook on change ───────────

test('(c) editing a source wired into the webhook POSTs the source content after the debounce', async () => {
  const { url, requests } = await startLocalServer()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, aId, webhookId, linkId } = await window.evaluate(async (webhookUrl: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook wired send' })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'A',
      content: 'v0',
      x: 120,
      y: 160,
      width: 240,
      height: 180
    })
    const webhook = await api.widgets.create({
      taskId: task.id,
      kind: 'webhook',
      title: 'Send to a URL',
      content: JSON.stringify({ url: webhookUrl }),
      x: 520,
      y: 160,
      width: 320,
      height: 180
    })
    // Plain widgetLinks.create — default 'context' wire type, exactly as the
    // "Send to a URL" create-and-connect menu spawns it. The wire engine's
    // contract is that ANY wire into a webhook target is reactive regardless
    // of its type.
    const link = await api.widgetLinks.create(a.id, webhook.id, task.id)
    return { taskId: task.id, aId: a.id, webhookId: webhook.id, linkId: link!.id }
  }, url)
  await openTask(window, /Webhook wired send/)

  await editContentViaStore(window, aId, 'wired payload v1')

  await expect
    .poll(() => requests.length, { timeout: 6_000, intervals: [200, 300, 500] })
    .toBeGreaterThanOrEqual(1)
  expect(requests[0].body).toBe('wired payload v1')

  // The wire's own run status reports the send: a durable lastRunAt with no
  // error.
  const link = await linkOf(window, taskId, linkId)
  expect(link?.lastError, 'no error recorded for a successful send').toBeFalsy()
  expect(link?.lastRunAt, 'lastRunAt stamped after a successful send').not.toBeNull()

  void webhookId
})

// ── (d) an empty / unreachable URL surfaces an honest error, never a fake OK ─

test('(d1) "Send test" with no URL reports an honest error, not a fake success', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook empty url' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'webhook',
      title: 'Send to a URL',
      content: '',
      x: 200,
      y: 200,
      width: 320,
      height: 180
    })
    return { widgetId: w.id }
  })
  await openTask(window, /Webhook empty url/)

  const frame = window.locator(`[data-widget-id="${widgetId}"]`)
  await frame.locator('[data-testid="webhook-test"]').click()

  const result = frame.locator('[data-testid="webhook-result"]')
  await expect(result).toBeVisible({ timeout: 3_000 })
  await expect(result).not.toContainText(/Sent OK/)
  const cls = await result.getAttribute('class')
  expect(cls, 'result line is styled red on failure').toMatch(/red/)
})

test('(d2) "Send test" against an unreachable local port reports an honest red error', async () => {
  const deadUrl = await unreachableLocalUrl()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook unreachable url' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'webhook',
      title: 'Send to a URL',
      content: '',
      x: 200,
      y: 200,
      width: 320,
      height: 180
    })
    return { widgetId: w.id }
  })
  await openTask(window, /Webhook unreachable url/)

  const frame = window.locator(`[data-widget-id="${widgetId}"]`)
  await frame.locator('[data-testid="webhook-url"]').fill(deadUrl)
  await frame.locator('[data-testid="webhook-test"]').click()

  const result = frame.locator('[data-testid="webhook-result"]')
  await expect(result).toBeVisible({ timeout: 5_000 })
  await expect(result).not.toContainText(/Sent OK/)
  const cls = await result.getAttribute('class')
  expect(cls, 'result line is styled red on failure').toMatch(/red/)
})

test('(d3) a wired send to an unreachable URL records an honest wire error, never a fake success', async () => {
  const deadUrl = await unreachableLocalUrl()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, aId, linkId } = await window.evaluate(async (webhookUrl: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook wired failure' })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'A',
      content: 'v0',
      x: 120,
      y: 160,
      width: 240,
      height: 180
    })
    const webhook = await api.widgets.create({
      taskId: task.id,
      kind: 'webhook',
      title: 'Send to a URL',
      content: JSON.stringify({ url: webhookUrl }),
      x: 520,
      y: 160,
      width: 320,
      height: 180
    })
    const link = await api.widgetLinks.create(a.id, webhook.id, task.id)
    return { taskId: task.id, aId: a.id, linkId: link!.id }
  }, deadUrl)
  await openTask(window, /Webhook wired failure/)

  await editContentViaStore(window, aId, 'this send should fail')

  await expect
    .poll(async () => (await linkOf(window, taskId, linkId))?.lastError, {
      timeout: 6_000,
      intervals: [200, 300, 500]
    })
    .toBeTruthy()

  const link = await linkOf(window, taskId, linkId)
  expect(link?.lastError, 'a real, non-empty error is recorded').toBeTruthy()
})

// ── (e) the webhook wire shows up in the Automations panel ─────────────────

test('(e) the webhook wire (A -> webhook) appears in the Automations panel with a send status', async () => {
  const { url, requests } = await startLocalServer()
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { aId, linkId } = await window.evaluate(async (webhookUrl: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Webhook automations row' })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'A',
      content: 'v0',
      x: 120,
      y: 160,
      width: 240,
      height: 180
    })
    const webhook = await api.widgets.create({
      taskId: task.id,
      kind: 'webhook',
      title: 'Ping Zapier',
      content: JSON.stringify({ url: webhookUrl }),
      x: 520,
      y: 160,
      width: 320,
      height: 180
    })
    const link = await api.widgetLinks.create(a.id, webhook.id, task.id)
    return { taskId: task.id, aId: a.id, webhookId: webhook.id, linkId: link!.id }
  }, url)
  await openTask(window, /Webhook automations row/)

  // Fire a real send first so the row (if it renders) has a genuine status
  // to report rather than "hasn't run yet".
  await editContentViaStore(window, aId, 'v1')
  await expect
    .poll(() => requests.length, { timeout: 6_000, intervals: [200, 300, 500] })
    .toBeGreaterThanOrEqual(1)

  await openAutomationsPanel(window)
  const row = window.locator(`[data-testid="automation-row-${linkId}"]`)
  await expect(row, 'the webhook wire is listed as an automation on the desk').toBeVisible({ timeout: 3_000 })
  // The row uses "Sent" (not "Ran") for a webhook target's honest send status.
  await expect(row).toContainText(/Sent (just now|\d+[mhd] ago)/)
  await expect(row).toContainText('Webhook · POSTs to a URL on change')
})

// ── (f) regression: the pre-existing wire/automation suites still pass ────
// Run separately via `npx playwright test tests/e2e/linkIntentOverhaul.spec.ts
// tests/e2e/wireTrustLayer.spec.ts tests/e2e/automationsPanel.spec.ts` — kept
// out of this file so a webhook-only run stays fast and their pass counts
// are independently verifiable.
