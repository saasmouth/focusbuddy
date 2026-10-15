/**
 * E2E for the PlexiDesk / PlexiBrain segments — each a full-bleed area with its
 * own dedicated side menu and a home of app tiles, with the existing views
 * rendered inline so the segment menu stays put. PlexiOffice is the third
 * segment and has its own shell, covered by officeShell.spec.ts.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

async function openSegment(window: Page, navTestid: string): Promise<void> {
  // Each segment is a full-bleed takeover that hides the global sidebar, so first
  // exit any active segment back to the global app, then open the target via its
  // dedicated sidebar entry (testid, since some product labels still repeat).
  const exit = window.locator('[data-testid="segment-exit"]')
  if (await exit.isVisible().catch(() => false)) await exit.click()
  const officeExit = window.locator('[data-testid="office-exit"]')
  if (await officeExit.isVisible().catch(() => false)) await officeExit.click()
  await expect(window.locator(`[data-testid="${navTestid}"]`)).toBeVisible({ timeout: 8_000 })
  await window.locator(`[data-testid="${navTestid}"]`).click()
  await expect(window.locator('[data-testid="segment-sidebar"]')).toBeVisible({ timeout: 8_000 })
}

test.describe('segments', () => {
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

  // The Desk area is the global sidebar (not a takeover segment), so it is covered
  // by the sidebar/home specs. The remaining takeover segments open via the area
  // switcher and show a side menu of app tiles.
  const SEGMENTS: { name: string; nav: string; apps: string[] }[] = [
    { name: 'PlexiBrain', nav: 'switch-plexibrain', apps: ['ask', 'search', 'map', 'flows', 'agents', 'connect', 'api', 'insights'] }
  ]

  for (const seg of SEGMENTS) {
    test(`${seg.name} opens with its side menu, tiles and inline views`, async () => {
      await openSegment(window, seg.nav)
      // The home shows a tile per app, and the sidebar lists each app.
      for (const a of seg.apps) {
        await expect(window.locator(`[data-testid="segment-tile-${a}"]`)).toBeVisible()
        await expect(window.locator(`[data-testid="nav-plexibrain-${a}"]`)).toBeVisible()
      }
      // Open the first app inline; the segment side menu stays present (no crash).
      await window.locator(`[data-testid="nav-plexibrain-${seg.apps[0]}"]`).click()
      await expect(window.locator('[data-testid="segment-sidebar"]')).toBeVisible()
      // Back to the segment home — the area's own header, which navigates to
      // the area root and so shows its tile grid. The "Brain Home" ROW is a
      // different destination: it opens the brain dashboard app.
      await window.locator('[data-testid="switch-plexibrain"]').click()
      await expect(window.locator(`[data-testid="segment-tile-${seg.apps[0]}"]`)).toBeVisible()
    })
  }
})
