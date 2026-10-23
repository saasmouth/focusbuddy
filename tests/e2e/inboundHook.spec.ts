import { test, expect, type Page } from '@playwright/test'
import { clickWidgetTool, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// "Lever 3 Phase 1: inbound webhooks" (plexi-4.0):
//   - A new widget kind 'inbound-hook' ("Receive from a URL" in the catalog,
//     icon call_received). On mount it tries to register a hook with the
//     signal server bound to this widget id (createWebhookHook). If that
//     succeeds it shows the URL to POST to (data-testid "inbound-hook-url") +
//     a copy button. If registration fails or returns null (server not
//     deployed yet, or the account isn't signed in), it shows an honest
//     "not available yet" state (data-testid "inbound-hook-unavailable") —
//     never a fabricated URL.
//   - Its content holds { hookId, url, lastPayload } as JSON. The wire
//     engine's effectiveContent() returns the widget's lastPayload for this
//     kind, so a wire drawn OUT of it carries the last received payload, not
//     the raw config blob.
//   - messagingSocket's 'webhookReceived' handler merges an incoming relayed
//     payload into the target widget's lastPayload (preserving hookId/url),
//     which is exactly what fires any wire drawn out of it.
//
// This E2E harness runs with no signed-in account (see _helpers.ts / the
// sign-in modal dismiss), so live hook registration honestly cannot succeed —
// (a) asserts that honest state, never a fabricated URL. (b), the core
// deterministic contract, needs no server at all: it seeds the widget with an
// already-registered hook config (as if registration had already succeeded,
// or the widget survived a reload with a real hook) and then mutates its
// content via the same store path messagingSocket's handler uses on a
// relayed payload, and checks the wire actually carries the payload.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

// Edits a widget's content through the store's `update` (the same path a real
// UI edit — and the messagingSocket 'webhookReceived' handler — goes through),
// so notifyWireSource actually fires the wire engine.
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

async function bodyPoint(window: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await window.locator(`[data-widget-id="${id}"]`).boundingBox()
  if (!box) throw new Error(`no bounding box for widget ${id}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Arms the link from `sourceId` via its hub button, then completes the drop by
// clicking the given screen point — a real UI gesture (widget-link-owner's
// pattern from linkIntentOverhaul.spec.ts).
async function armAndDrop(window: Page, sourceId: string, drop: { x: number; y: number }): Promise<void> {
  // At narrow widths the hub folds into the header's "…" menu
  // (lib/widgetHeaderActions); clickWidgetTool presses it wherever it is.
  await clickWidgetTool(window, sourceId, 'Link to another work widget')
  await window.mouse.click(drop.x, drop.y)
  await window.waitForTimeout(150)
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

// ── (a) render: real position, honest state, never a fake URL ──────────────

test('(a) an inbound-hook widget renders at its created position and shows an honest state, never a fabricated URL', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ORIGIN = { x: 650, y: 300 }
  const { widgetId, anchorId } = await window.evaluate(async (origin) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Inbound hook render' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'inbound-hook',
      title: 'Receive from a URL',
      content: '',
      x: origin.x,
      y: origin.y,
      width: 340,
      height: 200
    })
    const anchor = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Anchor',
      content: 'anchor',
      x: origin.x - 400,
      y: origin.y,
      width: 200,
      height: 150
    })
    return { widgetId: w.id, anchorId: anchor.id }
  }, ORIGIN)
  await openTask(window, /Inbound hook render/)

  // Position: rendered inside WidgetFrame at its real canvas x/y, like every
  // other widget kind — checked as a relative offset from a known-good anchor
  // (robust to whatever the canvas's pan/zoom happens to be).
  const frame = window.locator(`[data-widget-id="${widgetId}"]`)
  const anchor = window.locator(`[data-widget-id="${anchorId}"]`)
  await expect(frame).toBeVisible({ timeout: 4_000 })
  await expect(anchor).toBeVisible({ timeout: 4_000 })
  const frameBox = await frame.boundingBox()
  const anchorBox = await anchor.boundingBox()
  if (!frameBox || !anchorBox) throw new Error('missing bounding box for frame or anchor')
  expect(frameBox.x - anchorBox.x, 'inbound-hook widget sits 400px (scaled) right of the anchor').toBeCloseTo(
    400 * (frameBox.width / 340),
    0
  )
  expect(Math.abs(frameBox.y - anchorBox.y), 'inbound-hook widget is vertically level with the anchor').toBeLessThan(4)

  // Exactly one of the two honest states renders. This harness has no
  // signed-in account, so registration cannot succeed and "not available
  // yet" is the expected branch here — asserted, not assumed.
  const unavailable = frame.locator('[data-testid="inbound-hook-unavailable"]')
  const urlField = frame.locator('[data-testid="inbound-hook-url"]')
  await expect(unavailable.or(urlField)).toBeVisible({ timeout: 5_000 })

  const isUnavailable = await unavailable.isVisible()
  if (isUnavailable) {
    // The honest empty state: no fabricated URL rendered alongside it.
    await expect(urlField).toHaveCount(0)
  } else {
    const url = await urlField.inputValue()
    expect(url, 'a real hook URL was issued (not a placeholder)').toMatch(/^https?:\/\/.+\/hooks\/.+/)
  }
  // Explicit, so a failure here reads unambiguously in CI output.
  expect(isUnavailable, 'expected the honest "not available yet" state in this no-account harness').toBe(true)
})

// ── (b) the core, deterministic contract: payload -> wire ──────────────────

test('(b) a relayed payload update to an inbound-hook widget carries its lastPayload (not the config blob) across a mirror wire', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, hId, nId, linkId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Inbound hook payload wire' })
    const h = await api.widgets.create({
      taskId: task.id,
      kind: 'inbound-hook',
      title: 'H',
      content: JSON.stringify({ hookId: 'h1', url: 'https://x/hooks/t', lastPayload: 'first' }),
      x: 120,
      y: 160,
      width: 340,
      height: 200
    })
    const n = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'N',
      content: '',
      x: 620,
      y: 160,
      width: 240,
      height: 180
    })
    const link = await api.widgetLinks.create(h.id, n.id, task.id)
    await api.widgetLinks.update(link!.id, { type: 'mirror' })
    return { taskId: task.id, hId: h.id, nId: n.id, linkId: link!.id }
  })
  await openTask(window, /Inbound hook payload wire/)

  // Sanity: the mirror wire already ran once on mount notification is NOT
  // guaranteed (no content change happened yet since creation), so N may
  // still be empty here. What matters is the transition below.

  // Exactly what messagingSocket's 'webhookReceived' handler does on a
  // relayed payload: preserve hookId/url, replace lastPayload.
  await editContentViaStore(
    window,
    hId,
    JSON.stringify({ hookId: 'h1', url: 'https://x/hooks/t', lastPayload: 'SECOND' })
  )

  await expect
    .poll(async () => widgetContent(window, taskId, nId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toBe('SECOND')

  // The wire carried effectiveContent() = lastPayload, never the raw JSON
  // config blob.
  const finalContent = await widgetContent(window, taskId, nId)
  expect(finalContent).not.toContain('hookId')
  expect(finalContent).not.toContain('lastPayload')

  void linkId
})

// ── (c) inbound-hook is a valid wire SOURCE + shows in Automations ─────────

test('(c) an inbound-hook widget is a valid link source via its hub button and the resulting wire appears in the Automations panel', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, hId, nId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Inbound hook link source' })
    const h = await api.widgets.create({
      taskId: task.id,
      kind: 'inbound-hook',
      title: 'H',
      content: JSON.stringify({ hookId: 'h1', url: 'https://x/hooks/t', lastPayload: 'v0' }),
      x: 120,
      y: 160,
      width: 340,
      height: 200
    })
    const n = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'N2',
      content: '',
      x: 700,
      y: 160,
      width: 240,
      height: 180
    })
    return { taskId: task.id, hId: h.id, nId: n.id }
  })
  await openTask(window, /Inbound hook link source/)

  // Real UI gesture: click the inbound-hook's hub button (the same
  // "Link to another work widget" control every widget kind gets from the shared
  // WidgetFrame), then drop on N2 — proving it's a valid link endpoint/source,
  // not just something the wire engine happens to tolerate.
  const drop = await bodyPoint(window, nId)
  await armAndDrop(window, hId, drop)

  const picker = window.locator('[data-testid="link-intent-picker"]')
  await expect(picker, 'the intent picker opens for a link drawn from an inbound-hook source').toBeVisible({
    timeout: 3_000
  })
  await picker.locator('[data-testid="link-intent-mirror"]').click()
  await window.waitForTimeout(150)
  await expect(picker).toBeHidden()

  const link = await window.evaluate(
    async ({ tid, hid, nid }: { tid: string; hid: string; nid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const links = await api.widgetLinks.listByTask(tid)
      return links.find((l) => l.sourceWidgetId === hid && l.targetWidgetId === nid)
    },
    { tid: taskId, hid: hId, nid: nId }
  )
  expect(link, 'a wire was created from the inbound-hook widget').toBeTruthy()
  expect(link!.type).toBe('mirror')

  await openAutomationsPanel(window)
  const row = window.locator(`[data-testid="automation-row-${link!.id}"]`)
  await expect(row, 'the inbound-hook -> N2 mirror wire is listed as an automation').toBeVisible({ timeout: 3_000 })
  await expect(row).toContainText('H → N2')
  await expect(row).toContainText('Mirror')
})

// ── (d) regression: pre-existing wire/webhook/automation suites still pass ──
// Run separately via `npx playwright test tests/e2e/webhookOutbound.spec.ts
// tests/e2e/linkIntentOverhaul.spec.ts tests/e2e/wireTrustLayer.spec.ts
// tests/e2e/automationsPanel.spec.ts` — kept out of this file so an
// inbound-hook-only run stays fast and their pass counts are independently
// verifiable.
