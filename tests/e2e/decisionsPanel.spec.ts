import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, switchArea } from './_helpers'

// PlexiBrain > Decisions panel (spec §37 management view). Lists every live
// Decision with a live at-risk status computed from decisions:withRisk ->
// src/main/ipc/index.ts, which maps each Decision's relatedObjectIds through the
// shared objectHealth() helper (the same live signal that drives the red widget
// frame tested end-to-end in decisionRisk.spec.ts). This spec exercises the panel
// itself: the segment entry point, the empty state, a Current row, the row
// flipping to At risk on a real content change, Retire, and Open desk.
//
// Decision creation is driven via window.api.decisions.create rather than the
// context-menu "Flag as a decision" gesture (already proven end-to-end in
// decisionRisk.spec.ts) so this spec stays focused on the panel's own rendering
// and refresh contract. Content-change and at-risk computation are real (no
// mocking); only the "flag" step is API-driven. That is called out inline.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function exitSegment(window: Page): Promise<void> {
  const segExit = window.locator('[data-testid="segment-exit"]')
  if (await segExit.isVisible().catch(() => false)) await segExit.click()
}

async function openDecisionsPanel(window: Page): Promise<void> {
  await exitSegment(window)
  await switchArea(window, 'plexibrain')
  await expect(window.locator('[data-testid="segment-sidebar"]')).toBeVisible()
  await window.locator('[data-testid="segment-app-decisions"]').click()
  await expect(window.locator('[data-testid="decisions-view"]')).toBeVisible({ timeout: 8_000 })
}

test('DECISIONS PANEL — empty state, a flagged decision appears Current, flips to At risk on a real change, Retire removes it, Open desk navigates', async () => {
  launched = await launchApp()
  const { window } = launched
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // ── Step 1: navigate to the panel via the real segment UI, assert honest empty state ──
  await openDecisionsPanel(window)
  await expect(window.locator('[data-testid="decisions-empty"]')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('[data-testid="decision-row"]')).toHaveCount(0)

  // ── Set up a desk + widget, then flag it as a Decision (API-driven: the ──
  // context-menu gesture itself is already covered by decisionRisk.spec.ts).
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    type N = { id: string }
    const desk = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Decisions Panel Desk' })) as N
    const widget = await api.widgets.create({
      taskId: desk.id,
      kind: 'sticky',
      title: 'Ship on Thursday',
      content: 'v1 — pre-decision',
      x: 200,
      y: 200,
      width: 260,
      height: 180
    })
    const decision = await api.decisions.create({
      title: 'Ship on Thursday',
      decisionStatement: 'We ship the release on Thursday.',
      relatedObjectIds: [widget.id],
      affectedDeskIds: [desk.id]
    })
    return { desk: desk.id, widget: widget.id, decision: decision.id }
  })

  // Reload so the renderer's node/widget stores pick up the data just created
  // over IPC (same pattern as decisionRisk.spec.ts), then visit the desk once so
  // the widget is baselined (created + reviewed at creation), keeping its
  // starting health 'current' before we deliberately change it in step 3.
  await window.reload()
  await waitForReady(window)
  await window.evaluate((taskId) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
    w.__fbView?.getState().goTask(taskId)
  }, ids.desk)
  await window.waitForTimeout(400)
  await window.waitForSelector(`[data-widget-id="${ids.widget}"]`, { timeout: 8_000 })

  // ── Step 2: reopen the panel — exactly one row, title correct, Current (not at risk) ──
  await openDecisionsPanel(window)
  const rows = window.locator('[data-testid="decision-row"]')
  await expect(rows).toHaveCount(1, { timeout: 8_000 })
  await expect(rows.first()).toContainText('Ship on Thursday')
  await expect(rows.first()).toHaveAttribute('data-at-risk', 'false')
  await expect(rows.first()).toContainText('Current')
  await expect(rows.first()).not.toContainText('At risk')

  // ── Step 3: a real content change to the flagged widget raises decision risk ──
  await window.evaluate(
    async (widgetId) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(widgetId, { content: 'v2 — changed after the decision' })
    },
    ids.widget
  )

  // Confirm the underlying IPC contract directly: decisions:withRisk reports
  // atRisk true with the widget named in riskyObjectIds.
  const withRisk = await window.evaluate(
    async () => (window as unknown as { api: typeof window.api }).api.decisions.withRisk(),
    undefined
  )
  const entry = withRisk.find((r) => r.decision.id === ids.decision)
  expect(entry, 'decision missing from decisions:withRisk').toBeTruthy()
  expect(entry?.atRisk).toBe(true)
  expect(entry?.riskyObjectIds).toContain(ids.widget)

  // Re-open the panel (forces a remount -> fresh fetch, since the view has no
  // live subscription) and assert the row now shows At risk.
  await openDecisionsPanel(window)
  const rowAfterChange = window.locator('[data-testid="decision-row"]')
  await expect(rowAfterChange).toHaveCount(1, { timeout: 8_000 })
  await expect(rowAfterChange.first()).toHaveAttribute('data-at-risk', 'true')
  await expect(rowAfterChange.first()).toContainText('At risk')
  await expect(window.locator('[data-testid="decisions-at-risk-summary"]')).toBeVisible()

  // ── Step 5 (checked before Retire, while the row still exists): Open desk navigates ──
  await window.locator('[data-testid="decision-open-desk"]').click()
  await expect(window.locator('[data-testid="view-selector-btn"]')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator(`[data-widget-id="${ids.widget}"]`)).toBeVisible({ timeout: 8_000 })

  // ── Step 4: Retire removes the decision from the panel and from the IPC surface ──
  await openDecisionsPanel(window)
  await expect(window.locator('[data-testid="decision-row"]')).toHaveCount(1, { timeout: 8_000 })
  await window.locator('[data-testid="decision-cancel"]').click()
  await expect(window.locator('[data-testid="decisions-empty"]')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('[data-testid="decision-row"]')).toHaveCount(0)

  const withRiskAfterCancel = await window.evaluate(
    async () => (window as unknown as { api: typeof window.api }).api.decisions.withRisk(),
    undefined
  )
  expect(withRiskAfterCancel.find((r) => r.decision.id === ids.decision)).toBeUndefined()

  const forObjectAfterCancel = await window.evaluate(
    async (widgetId) => (window as unknown as { api: typeof window.api }).api.decisions.forObject(widgetId),
    ids.widget
  )
  expect(forObjectAfterCancel).toEqual([])

  // ── No regression: zero console/page errors across the whole flow ──
  const unexpectedConsoleErrors = consoleErrors.filter(
    (e) => !e.includes('Failed to load resource: the server responded with a status of 404')
  )
  expect(pageErrors, `pageerror events: ${JSON.stringify(pageErrors)}`).toEqual([])
  expect(unexpectedConsoleErrors, `console.error: ${JSON.stringify(unexpectedConsoleErrors)}`).toEqual([])
})
