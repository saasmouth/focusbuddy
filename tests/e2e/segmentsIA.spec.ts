/**
 * E2E for the three-segment top-level IA: PlexiDesk, PlexiOffice and PlexiBrain.
 * Opens each segment from the global sidebar, asserts a representative app
 * renders inline, and confirms the Projects → Plans rename shows in the planning
 * view header and nav (no "Project(s)" copy where the user reads "Plan(s)").
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function exitSegment(window: Page): Promise<void> {
  // SegmentShell uses segment-exit; the PlexiOffice shell uses office-exit.
  // Both return to the global app sidebar.
  const segExit = window.locator('[data-testid="segment-exit"]')
  if (await segExit.isVisible().catch(() => false)) await segExit.click()
  const officeExit = window.locator('[data-testid="office-exit"]')
  if (await officeExit.isVisible().catch(() => false)) await officeExit.click()
}

test.describe('three-segment IA', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
  })
  test.afterAll(async () => {
    await app.dispose()
  })

  test('the Desk area Tasks view renders from the view store', async () => {
    await exitSegment(window)
    // Tasks is a Desk-area view now, reached from the Desk sidebar / view store.
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goAllTasks?.()
    })
    await expect(window.getByRole('heading', { name: 'All Tasks' })).toBeVisible({ timeout: 8_000 })
  })

  test('PlexiOffice opens and its Docs app is present', async () => {
    await exitSegment(window)
    await switchArea(window, 'office')
    // The office shell has its own sidebar with the document apps.
    await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="office-app-docs"]')).toBeVisible()
    // A communication app lives in the same shell.
    await expect(window.locator('[data-testid="office-comms-app-chat"]')).toBeVisible()
  })

  test('PlexiBrain opens and its Search app renders the search view', async () => {
    await exitSegment(window)
    await switchArea(window, 'plexibrain')
    await expect(window.locator('[data-testid="segment-sidebar"]')).toBeVisible()
    await window.locator('[data-testid="segment-app-search"]').click()
    await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 8_000 })
  })

  test('PlexiBrain Brain Map app renders a real graph or honest empty state', async () => {
    await exitSegment(window)
    await switchArea(window, 'plexibrain')
    await window.locator('[data-testid="segment-app-map"]').click()
    await expect(window.locator('[data-testid="brain-map-view"]')).toBeVisible({ timeout: 8_000 })
    // A fresh test workspace has no knowledge entries, so the honest empty state
    // must show — never an invented graph.
    await expect(window.locator('[data-testid="brain-map-empty"]')).toBeVisible()
  })

  test('Plans rename: the planning view reads Plans, not Projects', async () => {
    await exitSegment(window)
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goProjects?.()
    })
    const view = window.locator('[data-testid="plexiprojects-view"]')
    await expect(view).toBeVisible({ timeout: 8_000 })
    // Header reads "Plans" and the create button reads "New plan".
    await expect(window.getByRole('heading', { name: 'Plans' })).toBeVisible()
    await expect(window.locator('[data-testid="projects-new"]')).toContainText('New plan')
    // No user-facing "New project" / "Projects" header copy remains here.
    await expect(window.locator('[data-testid="projects-new"]')).not.toContainText('New project')
  })
})
