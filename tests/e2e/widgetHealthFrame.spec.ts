import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Per-widget Context Health frame (plexi-4.0, UX-022 at the Object level).
// Verifies the real pipeline: widgets:update emits a WidgetUpdated Event only for
// content-meaningful changes (src/main/ipc/index.ts widgets:update handler),
// context:health derives per-widget health via materialityForWidget, Canvas
// baselines each top-level widget's "since last visit" snapshot into the
// contextHealth store on desk open (src/renderer/src/components/Canvas.tsx ~463),
// and WidgetFrame renders the frame + corner dot from that snapshot
// (src/renderer/src/components/widgets/WidgetFrame.tsx ~888-905).
//
// Desk navigation follows the same __fbView pattern as contextHealthStrip.spec.ts.
// Decision-risk is NOT covered here on purpose (kept isolated so this file stays a
// pure "changed"/"attention-required" regression check) — see decisionRisk.spec.ts
// for the flag-as-a-decision -> decision-risk red path, now wired end to end via
// window.api.decisions.* (decisions:* ipcMain handlers, src/main/ipc/index.ts) and
// the "Flag as a decision" context-menu action (core/organise/flag-decision,
// src/renderer/src/lib/contextMenu/universal.ts).

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function goTaskAndSettle(window: import('@playwright/test').Page, id: string): Promise<void> {
  await window.evaluate((taskId) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
    w.__fbView?.getState().goTask(taskId)
  }, id)
  await window.waitForTimeout(400)
}

function healthDot(window: import('@playwright/test').Page, widgetId: string) {
  return window.locator(`[data-widget-id="${widgetId}"] [data-testid="widget-health-dot"]`)
}

test('WIDGET-HEALTH — content change since last visit lights a frame + accessible dot', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    type N = { id: string }
    const a = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Health Desk A' })) as N
    const b = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Health Desk B' })) as N
    const sticky = await api.widgets.create({
      taskId: a.id,
      kind: 'sticky',
      title: '',
      content: 'v1',
      x: 200,
      y: 200,
      width: 260,
      height: 180
    })
    return { a: a.id, b: b.id, widgetId: sticky.id }
  })

  await window.reload()
  await waitForReady(window)

  // Open desk A: baselines the sticky (created + reviewed at creation, no events
  // since) -> current, no frame.
  await goTaskAndSettle(window, ids.a)
  await window.waitForSelector(`[data-widget-id="${ids.widgetId}"]`, { timeout: 8_000 })
  await expect(healthDot(window, ids.widgetId)).toHaveCount(0)

  const healthBefore = await window.evaluate(
    async (id) => (window as unknown as { api: typeof window.api }).api.context!.health(id),
    ids.widgetId
  )
  expect(healthBefore.state).toBe('current')

  // Content-meaningful change via the exposed IPC surface — emits WidgetUpdated.
  await window.evaluate(
    async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(id, { content: 'v2 — changed while away' })
    },
    ids.widgetId
  )

  // Confirm the live context:health surface sees the change BEFORE the desk is
  // revisited (and therefore before Canvas's baseline effect marks it reviewed
  // again) — this is the "non-current state" the operator asked to confirm.
  const healthRightAfterChange = await window.evaluate(
    async (id) => (window as unknown as { api: typeof window.api }).api.context!.health(id),
    ids.widgetId
  )
  expect(healthRightAfterChange.state).not.toBe('current')

  // Leave to desk B, then come back — re-triggers Canvas's baseline effect, which
  // captures the PRE-review "since last visit" snapshot into lastVisit before
  // marking it reviewed again.
  await goTaskAndSettle(window, ids.b)
  await goTaskAndSettle(window, ids.a)
  await window.waitForSelector(`[data-widget-id="${ids.widgetId}"]`, { timeout: 8_000 })

  const dot = healthDot(window, ids.widgetId)
  await expect(dot).toBeVisible()
  const state = await dot.getAttribute('data-health-state')
  expect(['changed', 'attention-required']).toContain(state)

  // Accessible label — state is not colour-alone (PLX-A11Y-004).
  const ariaLabel = await dot.getAttribute('aria-label')
  const title = await dot.getAttribute('title')
  expect(ariaLabel).toBeTruthy()
  expect(title).toBe(ariaLabel)
  expect(ariaLabel!.length).toBeGreaterThan(5)

  console.log('[WIDGET-HEALTH] observed data-health-state:', state, 'aria-label:', ariaLabel)
  console.log('[WIDGET-HEALTH] context.health right after change:', JSON.stringify(healthRightAfterChange))

  const unexpectedConsoleErrors = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource: the server responded with a status of 404')
  )
  expect(pageErrors, `pageerror events: ${JSON.stringify(pageErrors)}`).toEqual([])
  expect(unexpectedConsoleErrors, `console.error: ${JSON.stringify(unexpectedConsoleErrors)}`).toEqual([])
})

test('WIDGET-HEALTH — pure geometry move does not flicker a frame', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    type N = { id: string }
    const a = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Geometry Desk' })) as N
    const sticky = await api.widgets.create({
      taskId: a.id,
      kind: 'sticky',
      title: '',
      content: 'stay calm',
      x: 150,
      y: 150,
      width: 260,
      height: 180
    })
    return { a: a.id, widgetId: sticky.id }
  })

  await window.reload()
  await waitForReady(window)
  await goTaskAndSettle(window, ids.a)
  await window.waitForSelector(`[data-widget-id="${ids.widgetId}"]`, { timeout: 8_000 })

  // Unchanged widget: no frame, no dot (check #3).
  await expect(healthDot(window, ids.widgetId)).toHaveCount(0)
  const healthBaseline = await window.evaluate(
    async (id) => (window as unknown as { api: typeof window.api }).api.context!.health(id),
    ids.widgetId
  )
  expect(healthBaseline.state).toBe('current')
  expect(healthBaseline.changedEventCount).toBe(0)

  // Real mouse drag on the header handle. Playwright's CDP mouse API doesn't
  // reliably reach react-draggable's document-level listeners in headless
  // Electron (see dragPriority.spec.ts) — dispatch real bubbling MouseEvents
  // instead, the proven-reliable technique already used elsewhere in this suite.
  await window.evaluate(async (widgetId) => {
    const handle = document.querySelector(`[data-widget-id="${widgetId}"] .widget-handle`) as HTMLElement | null
    if (!handle) throw new Error('no widget-handle found')
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
    const dx = 220
    const dy = 90
    const steps = 20
    for (let i = 1; i <= steps; i++) {
      fire(document, 'mousemove', startX + (dx * i) / steps, startY + (dy * i) / steps)
      await sleep(10)
    }
    await sleep(20)
    fire(document, 'mouseup', startX + dx, startY + dy)
  }, ids.widgetId)
  await window.waitForTimeout(400)

  // Confirm the drag actually moved the widget (real gesture, not a no-op).
  const moved = await window.evaluate(
    async ({ id, taskId }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const w = widgets.find((x) => x.id === id)
      return w ? { x: w.x, y: w.y } : null
    },
    { id: ids.widgetId, taskId: ids.a }
  )
  expect(moved).not.toBeNull()
  expect(moved!.x !== 150 || moved!.y !== 150).toBe(true)

  // No frame appeared from the move alone, and health is still current (no
  // WidgetUpdated event was emitted — geometry-only patches don't emit one).
  await expect(healthDot(window, ids.widgetId)).toHaveCount(0)
  const healthAfterDrag = await window.evaluate(
    async (id) => (window as unknown as { api: typeof window.api }).api.context!.health(id),
    ids.widgetId
  )
  expect(healthAfterDrag.state).toBe('current')
  expect(healthAfterDrag.changedEventCount).toBe(0)

  const unexpectedConsoleErrors = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource: the server responded with a status of 404')
  )
  expect(pageErrors, `pageerror events: ${JSON.stringify(pageErrors)}`).toEqual([])
  expect(unexpectedConsoleErrors, `console.error: ${JSON.stringify(unexpectedConsoleErrors)}`).toEqual([])
})

test('WIDGET-HEALTH — no regression: create, edit, select still work cleanly', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Create the desk AND the widget through the real IPC surface (same calls the
  // UI's create-desk / widget-spawn menu make) before the desk is ever opened —
  // seeding while already on the desk would create the widget behind the
  // renderer's local store's back (it only learns about it via loadForTask on
  // desk-open), which is a test-harness ordering issue, not a product one.
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    type N = { id: string }
    const a = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Regression Desk' })) as N
    const w = await api.widgets.create({
      taskId: a.id,
      kind: 'sticky',
      title: '',
      content: 'regression check',
      x: 300,
      y: 300,
      width: 240,
      height: 160
    })
    return { a: a.id, widgetId: w.id }
  })
  await window.reload()
  await waitForReady(window)
  await goTaskAndSettle(window, ids.a)
  const widgetId = ids.widgetId
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8_000 })

  // Select it — a plain click activates the widget.
  await window.click(`[data-widget-id="${widgetId}"]`, { position: { x: 100, y: 8 } })
  await window.waitForTimeout(150)

  // Edit its content via the real IPC surface and confirm the store reflects it.
  await window.evaluate(
    async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(id, { content: 'regression check — edited' })
    },
    widgetId
  )
  const after = await window.evaluate(
    async ({ id, taskId }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      return widgets.find((w) => w.id === id)?.content
    },
    { id: widgetId, taskId: ids.a }
  )
  expect(after).toBe('regression check — edited')

  await expect(window.locator(`[data-widget-id="${widgetId}"]`)).toBeVisible()

  const unexpectedConsoleErrors = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource: the server responded with a status of 404')
  )
  expect(pageErrors, `pageerror events: ${JSON.stringify(pageErrors)}`).toEqual([])
  expect(unexpectedConsoleErrors, `console.error: ${JSON.stringify(unexpectedConsoleErrors)}`).toEqual([])
})
