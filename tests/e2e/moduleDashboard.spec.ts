// E2E verification for the new global ModuleDashboard component.
//
// Covers three modules in depth (Reports, Flows, Meet) to satisfy Task 2:
//   • Zero-items state: dashboard renders, chart panel shows honest
//     "No activity yet" (not a fake empty chart), create button works.
//   • Seeded state: stat tiles show real counts, timeline bars render,
//     breakdown panel renders, recent items appear.
//   • Customize popover toggles sections.
//
// Seeded-state strategy: when items exist, land-on-content auto-selects the
// most recent item (editor opens, dashboard is hidden). We click the Overview
// button (report-overview / flow-overview) to deselect and reveal the
// dashboard with real store data. This is the correct user-visible flow.
//
// Where harness limits apply they are noted explicitly.
// Data seeding is done via IPC (window.api.*) so it is deterministic.

import { test, expect } from '@playwright/test'
import { openProduct, launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── Reports: zero-items state ─────────────────────────────────────────────────

test('Reports/zero — module-dashboard-reports renders; chart shows "No activity yet"; create button fires', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openProduct(window, 'reports')
  await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })

  // Root dashboard renders (zero items → no auto-select, no editor)
  const dash = window.locator('[data-testid="module-dashboard-reports"]')
  await expect(dash).toBeVisible({ timeout: 5_000 })

  // Customize button is present
  await expect(window.locator('[data-testid="module-dashboard-customize-reports"]')).toBeVisible()

  // Timeline section: all bucket values are 0 → BarChartPanel renders the
  // honest "No activity yet" text, NOT a blank/fake chart.
  await expect(dash.locator('text=No activity yet')).toBeVisible({ timeout: 5_000 })

  // Stats section present even at zero ("Reports" label appears in stat tiles;
  // multiple elements carry this text so use .first() to stay out of strict mode).
  await expect(dash.locator('text=Reports').first()).toBeVisible()

  // Create button exists in the empty recent-items pane
  const createBtn = window.locator('[data-testid="module-dashboard-create-reports"]')
  await expect(createBtn).toBeVisible()

  // Click it → a real report is created, count confirmed via IPC
  const before = await window.evaluate(async () =>
    (await window.api.reports.list() as unknown[]).length
  )
  await createBtn.click()
  await window.waitForTimeout(500)
  const after = await window.evaluate(async () =>
    (await window.api.reports.list() as unknown[]).length
  )
  expect(after, 'report count increased by 1 after create button').toBe(before + 1)
})

// ── Reports: seeded state ──────────────────────────────────────────────────────

test('Reports/seeded — stat tiles show real counts; chart renders bars; breakdown and recent items appear', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Seed 2 reports via IPC before opening the view
  await window.evaluate(async () => {
    await window.api.reports.create({ title: 'Sales Report' })
    await window.api.reports.create({ title: 'Ops Report' })
  })

  // Navigate to PlexiReports — land-on-content auto-selects the most recent
  // report so the editor opens and the dashboard is not yet visible.
  await openProduct(window, 'reports')
  await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })

  // Wait for the editor to confirm auto-select happened
  await expect(window.locator('[data-testid="report-title"]')).toBeVisible({ timeout: 6_000 })

  // Click Overview to deselect → dashboard becomes visible with seeded data
  await window.locator('[data-testid="report-overview"]').click()

  const dash = window.locator('[data-testid="module-dashboard-reports"]')
  await expect(dash).toBeVisible({ timeout: 5_000 })

  // Stat tile value "2" reflects the real seeded count
  await expect(dash.locator('text=2').first()).toBeVisible({ timeout: 5_000 })

  // Chart renders bars (total > 0 → BarChartPanel renders .h-28 bar row)
  await expect(dash.locator('.h-28')).toBeVisible({ timeout: 5_000 })
  // Honest empty text must NOT appear when items exist
  await expect(dash.locator('text=No activity yet')).toHaveCount(0)

  // Breakdown panel "By schedule" renders (RailCard title always visible)
  await expect(dash.locator('text=By schedule')).toBeVisible({ timeout: 5_000 })

  // Recent items: each seeded report has a module-dashboard-item-<id> card
  const reports = await window.evaluate(async () =>
    window.api.reports.list() as Promise<Array<{ id: string }>>
  )
  for (const r of reports as Array<{ id: string }>) {
    await expect(window.locator(`[data-testid="module-dashboard-item-${r.id}"]`)).toBeVisible({ timeout: 5_000 })
  }
})

// ── Flows: zero-items state ────────────────────────────────────────────────────

test('Flows/zero — module-dashboard-flows renders; chart honest empty; create button fires', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openProduct(window, 'flow')
  await expect(window.locator('[data-testid="plexiflow-view"]')).toBeVisible({ timeout: 8_000 })

  const dash = window.locator('[data-testid="module-dashboard-flows"]')
  await expect(dash).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="module-dashboard-customize-flows"]')).toBeVisible()

  // Honest empty chart state
  await expect(dash.locator('text=No activity yet')).toBeVisible({ timeout: 5_000 })

  // Create button in empty recent-items pane
  const createBtn = window.locator('[data-testid="module-dashboard-create-flows"]')
  await expect(createBtn).toBeVisible()

  const before = await window.evaluate(async () =>
    (await window.api.flows.list() as unknown[]).length
  )
  await createBtn.click()
  await window.waitForTimeout(500)
  const after = await window.evaluate(async () =>
    (await window.api.flows.list() as unknown[]).length
  )
  expect(after, 'flow count increased by 1 after create button').toBe(before + 1)
})

// ── Flows: seeded state ────────────────────────────────────────────────────────

test('Flows/seeded — stat tiles real counts; bars render; breakdown and recent items appear', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Seed 2 flows via IPC
  await window.evaluate(async () => {
    await window.api.flows.create({ title: 'Nightly sync' })
    await window.api.flows.create({ title: 'On-task trigger' })
  })

  // Navigate — land-on-content auto-selects, editor opens
  await openProduct(window, 'flow')
  await expect(window.locator('[data-testid="plexiflow-view"]')).toBeVisible({ timeout: 8_000 })

  // Wait for editor to confirm auto-select
  await expect(window.locator('[data-testid="flow-title"]')).toBeVisible({ timeout: 6_000 })

  // Click Overview to deselect → dashboard becomes visible with seeded data
  await window.locator('[data-testid="flow-overview"]').click()

  const dash = window.locator('[data-testid="module-dashboard-flows"]')
  await expect(dash).toBeVisible({ timeout: 5_000 })

  // Stat tile value "2"
  await expect(dash.locator('text=2').first()).toBeVisible({ timeout: 5_000 })

  // Bar chart rendered (not empty state)
  await expect(dash.locator('.h-28')).toBeVisible({ timeout: 5_000 })
  await expect(dash.locator('text=No activity yet')).toHaveCount(0)

  // Breakdown "By trigger" panel renders
  await expect(dash.locator('text=By trigger')).toBeVisible({ timeout: 5_000 })

  // Recent item cards exist
  const flows = await window.evaluate(async () =>
    window.api.flows.list() as Promise<Array<{ id: string }>>
  )
  for (const f of flows as Array<{ id: string }>) {
    await expect(window.locator(`[data-testid="module-dashboard-item-${f.id}"]`)).toBeVisible({ timeout: 5_000 })
  }
})

// ── Meet: zero-items state ────────────────────────────────────────────────────

test('Meet/zero — module-dashboard-meet renders; chart honest empty; create button fires', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openProduct(window, 'meet')
  await expect(window.locator('[data-testid="pleximeet-view"]')).toBeVisible({ timeout: 8_000 })

  const dash = window.locator('[data-testid="module-dashboard-meet"]')
  await expect(dash).toBeVisible({ timeout: 5_000 })
  // DEC-119: under Meet's own hero the dashboard is embedded — no Customize door.
  await expect(window.locator('[data-testid="module-dashboard-customize-meet"]')).toHaveCount(0)

  // Honest empty chart state
  await expect(dash.locator('text=No activity yet')).toBeVisible({ timeout: 5_000 })

  // Create button in empty recent-items pane
  const createBtn = window.locator('[data-testid="module-dashboard-create-meet"]')
  await expect(createBtn).toBeVisible()

  // Clicking create in PlexiMeet starts a meeting or surfaces the getUserMedia
  // error path in headless. Either way the app must not crash.
  await createBtn.click()
  await window.waitForTimeout(1_000)
  const viewUp = await window.locator('[data-testid="pleximeet-view"]').isVisible()
  expect(viewUp, 'app still running after clicking create').toBe(true)
})

// ── Customize popover: sections toggle ────────────────────────────────────────

test('Customize — toggling "Overview tiles" checkbox hides/shows the stats grid', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openProduct(window, 'reports')
  await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })

  const dash = window.locator('[data-testid="module-dashboard-reports"]')
  await expect(dash).toBeVisible({ timeout: 5_000 })

  // Stats grid (grid-cols-2 sm:grid-cols-4) is visible before customizing
  const statsGrid = dash.locator('.grid-cols-2').first()
  await expect(statsGrid).toBeVisible({ timeout: 3_000 })

  // Open customize popover
  await window.locator('[data-testid="module-dashboard-customize-reports"]').click()
  // STALE: located by `.w-56.rounded-xl`, and the panel's radius became the
  // design token `rounded-[var(--radius-row)]` at 471a1dec ("Edges 1a: floating
  // chrome earns glass, content gives it back"), so the selector matched
  // nothing. Anchored to the popover's own heading instead — Tailwind classes
  // are styling and will move again; this text is what the panel IS.
  const popover = window.locator('div').filter({ hasText: 'Sections on this dashboard' }).last()
  await expect(popover).toBeVisible({ timeout: 3_000 })
  await expect(popover.getByText('Overview tiles')).toBeVisible()

  // Uncheck "Overview tiles"
  const cb = popover.locator('label').filter({ hasText: 'Overview tiles' }).locator('input[type="checkbox"]')
  await cb.uncheck()

  // Dismiss by clicking the fixed overlay
  await dash.click({ position: { x: 5, y: 5 } })
  await window.waitForTimeout(200)

  // Stats grid is now hidden
  await expect(statsGrid).not.toBeVisible({ timeout: 3_000 })

  // Re-open and restore
  await window.locator('[data-testid="module-dashboard-customize-reports"]').click()
  const popover2 = window.locator('div').filter({ hasText: 'Sections on this dashboard' }).last()
  await expect(popover2).toBeVisible({ timeout: 3_000 })
  const cb2 = popover2.locator('label').filter({ hasText: 'Overview tiles' }).locator('input[type="checkbox"]')
  await cb2.check()
  await dash.click({ position: { x: 5, y: 5 } })
  await window.waitForTimeout(200)

  // Stats grid is visible again
  await expect(statsGrid).toBeVisible({ timeout: 3_000 })
})
