import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Decision Risk (spec §37 / PLX-UX-025) — the previously-dormant red widget
// frame. A human flags a widget as a Decision (context menu "Flag as a
// decision", core/organise/flag-decision in
// src/renderer/src/lib/contextMenu/universal.ts buildOrganise), which creates a
// Decision referencing [widgetId, deskId] via window.api.decisions.create ->
// decisions:create -> src/main/context/engine.ts createDecision. A later
// content-meaningful change to the widget (src/main/ipc/index.ts widgets:update
// emitting WidgetUpdated) makes materialityForWidget report decisionImpact:
// 'high' (via decisionImpactForObject), which escalates the pure state machine
// in src/shared/contextHealth.ts computeTransition to 'decision-risk' once the
// desk is revisited and Canvas re-baselines
// (src/renderer/src/components/Canvas.tsx). WidgetFrame
// (src/renderer/src/components/widgets/WidgetFrame.tsx ~888-905) renders the red
// frame + corner dot from that snapshot, naming the Decision in the aria-label
// (src/renderer/src/lib/healthFrame.ts). Undo cancels the Decision
// (decisions:cancel -> DecisionSuperseded), after which a further change can
// only reach 'changed' (decisionImpact reverts to 'none', so materiality band
// drops below the 'medium' threshold computeTransition requires for
// 'attention-required').
//
// This supersedes the "decision-risk is unreachable from the renderer" note in
// widgetHealthFrame.spec.ts — that surface is now wired end to end.

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

type Health = {
  objectId: string
  state: 'current' | 'changed' | 'attention-required' | 'decision-risk'
  changedEventCount: number
  materiality: { score: number; band: string } | null
  decisionsAtRisk: Array<{ decisionId: string; title: string; invalidatingChange: string }>
}

async function getHealth(window: import('@playwright/test').Page, id: string): Promise<Health> {
  return window.evaluate(
    async (widgetId) => (window as unknown as { api: typeof window.api }).api.context.health(widgetId),
    id
  )
}

test('DECISION-RISK — flag via real context menu activates the red path; non-flagged sibling unaffected; no regressions', async () => {
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
    const a = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Decision Desk A' })) as N
    const b = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Decision Desk B' })) as N
    const target = await api.widgets.create({
      taskId: a.id,
      kind: 'sticky',
      title: 'The call',
      content: 'v1 — pre-decision',
      x: 200,
      y: 200,
      width: 260,
      height: 180
    })
    const plain = await api.widgets.create({
      taskId: a.id,
      kind: 'sticky',
      title: 'Untouched by the decision',
      content: 'plain v1',
      x: 560,
      y: 200,
      width: 260,
      height: 180
    })
    return { a: a.id, b: b.id, target: target.id, plain: plain.id }
  })

  await window.reload()
  await waitForReady(window)

  // Open desk A: baselines both widgets (created + reviewed at creation) -> current.
  await goTaskAndSettle(window, ids.a)
  await window.waitForSelector(`[data-widget-id="${ids.target}"]`, { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${ids.plain}"]`, { timeout: 8_000 })
  await expect(healthDot(window, ids.target)).toHaveCount(0)
  await expect(healthDot(window, ids.plain)).toHaveCount(0)
  expect((await getHealth(window, ids.target)).state).toBe('current')

  // Sanity: no Decision exists yet.
  const beforeFlag = await window.evaluate(
    async (id) => (window as unknown as { api: typeof window.api }).api.decisions.forObject(id),
    ids.target
  )
  expect(beforeFlag).toEqual([])

  // ── Step 1: flag via the REAL right-click menu (Organise > Flag as a decision) ──
  await window.click(`[data-widget-id="${ids.target}"]`, { button: 'right', position: { x: 110, y: 8 } })
  await window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4_000 })
  await window.getByRole('menuitem', { name: 'Organise' }).click()
  await window.getByRole('menuitem', { name: 'Flag as a decision' }).click()

  // Undoable-action toast confirms the flag went through the real UI action.
  const toast = window.locator('[data-testid="undo-toast"]')
  await expect(toast).toBeVisible({ timeout: 4_000 })
  await expect(toast).toContainText('Flagged as a decision')

  // Assert #1: exactly one live Decision now references the widget.
  const afterFlag = await window.evaluate(
    async (id) => (window as unknown as { api: typeof window.api }).api.decisions.forObject(id),
    ids.target
  )
  expect(afterFlag).toHaveLength(1)
  const decisionId = afterFlag[0].id
  const decisionTitle = afterFlag[0].title
  expect(decisionTitle).toBe('The call')

  // Let the toast clear so it doesn't intercept later pointer interactions.
  await expect(toast).toBeHidden({ timeout: 9_000 })

  // ── Step 2: THE RED PATH — a content change to the flagged widget, plus an ──
  // identical content change to the sibling that was never flagged.
  await window.evaluate(
    async ({ target, plain }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(target, { content: 'v2 — changed after the decision' })
      await api.widgets.update(plain, { content: 'plain v2 — also changed' })
    },
    { target: ids.target, plain: ids.plain }
  )

  // Confirm the live context:health surface already sees decision-risk BEFORE
  // the desk is revisited (mirrors widgetHealthFrame.spec.ts's "before Canvas's
  // baseline effect" check).
  const healthRightAfterChange = await getHealth(window, ids.target)
  expect(healthRightAfterChange.state).toBe('decision-risk')
  expect(healthRightAfterChange.decisionsAtRisk.map((d) => d.decisionId)).toContain(decisionId)
  expect(healthRightAfterChange.decisionsAtRisk.map((d) => d.title)).toContain('The call')

  const plainHealthRightAfterChange = await getHealth(window, ids.plain)
  expect(plainHealthRightAfterChange.state).not.toBe('decision-risk')

  // Leave to desk B, then come back — re-triggers Canvas's baseline effect so the
  // DOM frame reflects the pre-review snapshot.
  await goTaskAndSettle(window, ids.b)
  await goTaskAndSettle(window, ids.a)
  await window.waitForSelector(`[data-widget-id="${ids.target}"]`, { timeout: 8_000 })

  const dot = healthDot(window, ids.target)
  await expect(dot).toBeVisible()
  const state = await dot.getAttribute('data-health-state')
  expect(state).toBe('decision-risk')
  const ariaLabel = await dot.getAttribute('aria-label')
  const title = await dot.getAttribute('title')
  expect(ariaLabel).toBeTruthy()
  expect(title).toBe(ariaLabel)
  expect(ariaLabel).toContain('The call')

  console.log('[DECISION-RISK] target dot state:', state, 'aria-label:', ariaLabel)

  // Assert #4a: the never-flagged sibling never turns decision-risk (it may
  // still show a plain "changed"/"attention-required" frame for its own
  // content change, which is fine — decision-risk specifically must not appear).
  const plainDot = healthDot(window, ids.plain)
  const plainDotCount = await plainDot.count()
  if (plainDotCount > 0) {
    const plainState = await plainDot.getAttribute('data-health-state')
    expect(plainState).not.toBe('decision-risk')
  }
  const plainHealthAfterRevisit = await getHealth(window, ids.plain)
  expect(plainHealthAfterRevisit.state).not.toBe('decision-risk')

  // ── Step 4b: no regression — plain create/select/edit/drag still work cleanly ──
  await window.click(`[data-widget-id="${ids.plain}"]`, { position: { x: 100, y: 8 } })
  await window.waitForTimeout(150)
  await window.evaluate(
    async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(id, { content: 'plain v3 — edited again' })
    },
    ids.plain
  )
  const plainAfterEdit = await window.evaluate(
    async ({ id, taskId }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      return widgets.find((w) => w.id === id)?.content
    },
    { id: ids.plain, taskId: ids.a }
  )
  expect(plainAfterEdit).toBe('plain v3 — edited again')

  // Real drag on the flagged (decision-risk) widget's header — confirms the red
  // frame doesn't break normal interaction.
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
    const dx = 80
    const dy = 40
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      fire(document, 'mousemove', startX + (dx * i) / steps, startY + (dy * i) / steps)
      await sleep(10)
    }
    await sleep(20)
    fire(document, 'mouseup', startX + dx, startY + dy)
  }, ids.target)
  await window.waitForTimeout(300)
  await expect(window.locator(`[data-widget-id="${ids.target}"]`)).toBeVisible()

  const unexpectedConsoleErrors = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource: the server responded with a status of 404')
  )
  expect(pageErrors, `pageerror events: ${JSON.stringify(pageErrors)}`).toEqual([])
  expect(unexpectedConsoleErrors, `console.error: ${JSON.stringify(unexpectedConsoleErrors)}`).toEqual([])
})

test('DECISION-RISK — undo cancels the Decision and the widget falls back off decision-risk', async () => {
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
    const a = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Undo Decision Desk A' })) as N
    const b = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Undo Decision Desk B' })) as N
    const target = await api.widgets.create({
      taskId: a.id,
      kind: 'sticky',
      title: 'Reversible call',
      content: 'v1',
      x: 200,
      y: 200,
      width: 260,
      height: 180
    })
    return { a: a.id, b: b.id, target: target.id }
  })

  await window.reload()
  await waitForReady(window)
  await goTaskAndSettle(window, ids.a)
  await window.waitForSelector(`[data-widget-id="${ids.target}"]`, { timeout: 8_000 })

  // Flag via the real menu again (independent proof, not reusing the API path).
  await window.click(`[data-widget-id="${ids.target}"]`, { button: 'right', position: { x: 110, y: 8 } })
  await window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4_000 })
  await window.getByRole('menuitem', { name: 'Organise' }).click()
  await window.getByRole('menuitem', { name: 'Flag as a decision' }).click()

  const toast = window.locator('[data-testid="undo-toast"]')
  await expect(toast).toBeVisible({ timeout: 4_000 })
  await expect(toast).toContainText('Flagged as a decision')

  const afterFlag = await window.evaluate(
    async (id) => (window as unknown as { api: typeof window.api }).api.decisions.forObject(id),
    ids.target
  )
  expect(afterFlag).toHaveLength(1)

  // Click the toast's own Undo button (the real UI affordance, not window.api.decisions.cancel).
  await window.locator('[data-testid="undo-toast-undo"]').click()
  await window.waitForTimeout(300)

  const afterUndo = await window.evaluate(
    async (id) => (window as unknown as { api: typeof window.api }).api.decisions.forObject(id),
    ids.target
  )
  expect(afterUndo).toEqual([])

  // A further content change can no longer reach decision-risk — decisionImpact
  // is back to 'none', so the materiality band drops back below 'medium' and
  // computeTransition can only land on 'changed' (never 'attention-required' or
  // 'decision-risk') for this isolated, unrelated widget.
  await window.evaluate(
    async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(id, { content: 'v3 — changed after undo' })
    },
    ids.target
  )
  const healthRightAfter = await getHealth(window, ids.target)
  expect(healthRightAfter.state).not.toBe('decision-risk')
  expect(healthRightAfter.decisionsAtRisk).toEqual([])

  await goTaskAndSettle(window, ids.b)
  await goTaskAndSettle(window, ids.a)
  await window.waitForSelector(`[data-widget-id="${ids.target}"]`, { timeout: 8_000 })

  const dot = healthDot(window, ids.target)
  const dotCount = await dot.count()
  if (dotCount > 0) {
    const state = await dot.getAttribute('data-health-state')
    expect(state).not.toBe('decision-risk')
    expect(['changed', 'attention-required']).toContain(state)
  }
  const healthAfterRevisit = await getHealth(window, ids.target)
  expect(healthAfterRevisit.state).not.toBe('decision-risk')

  const unexpectedConsoleErrors = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource: the server responded with a status of 404')
  )
  expect(pageErrors, `pageerror events: ${JSON.stringify(pageErrors)}`).toEqual([])
  expect(unexpectedConsoleErrors, `console.error: ${JSON.stringify(unexpectedConsoleErrors)}`).toEqual([])
})
