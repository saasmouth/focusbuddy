/**
 * Every area's menu carries a compact switcher so you can jump between the four
 * areas in one click. In particular, Docs and Sheets (PlexiOffice) are always one
 * click away, even from the desk. Regression guard for "I can't see docs/sheets".
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea } from './_helpers'

test('SW-1 the switcher jumps to PlexiOffice and its apps (Docs) in one click', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    // The switcher lives on the Desk sidebar too, so it is visible from the start.
    await expect(window.locator('[data-testid="segment-switcher"]')).toBeVisible({ timeout: 8_000 })

    // One click to Office; the office apps (Docs) are now reachable.
    await switchArea(window, 'office')
    await expect(window.locator('[data-testid="office-app-docs"]')).toBeVisible({ timeout: 8_000 })

    // And back to the desk in one click; the switcher stays put.
    await switchArea(window, 'plexidesk')
    await expect(window.locator('[data-testid="segment-switcher"]')).toBeVisible()
  } finally {
    await dispose()
  }
})
