/**
 * Docs and Sheets are always reachable from the desk. Regression guard for
 * "I can't see docs/sheets".
 *
 * The compact four-tile switcher this was written against became the one
 * menu's section headers, which keep its `switch-<kind>` ids. The guarantee got
 * stronger rather than weaker: PlexiDocs is now a tile in the Apps section of
 * the menu that is already on screen, so it is reachable from the desk without
 * switching area at all. Both are asserted.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea } from './_helpers'

test('SW-1 the switcher jumps to PlexiOffice and its apps (Docs) in one click', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    // The one menu is on the Desk sidebar, so it is visible from the start.
    await expect(window.locator('[data-testid="area-accordion"]')).toBeVisible({ timeout: 8_000 })
    // ZERO clicks: PlexiDocs is a tile in the Apps section, from the desk.
    await expect(window.locator('[data-testid="office-sideapp-docs"]')).toBeVisible({
      timeout: 8_000
    })

    // One click to Office; the office apps (Docs) are now reachable.
    await switchArea(window, 'office')
    await expect(window.locator('[data-testid="office-app-docs"]')).toBeVisible({ timeout: 8_000 })

    // And back to the desk in one click; the switcher stays put.
    await switchArea(window, 'plexidesk')
    await expect(window.locator('[data-testid="area-accordion"]')).toBeVisible()
  } finally {
    await dispose()
  }
})
