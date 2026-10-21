// "why is browser still not an app in office"
//
// Because I filed it under Communicate. It rendered through the comms registry
// — the machinery that makes a surface take over the content area — and I let
// that decide where it was LISTED. Browsing the web is not communicating, so
// the one section a person scans for apps did not have it, and neither did the
// home tile grid, which renders the document apps only.
//
// Where something renders from and where a person looks for it are different
// questions. These assert the second one.
//
// Since then the side menu was regrouped into PlexiiApps and Tools, and
// Communicate went away; the Browser is a Tools tile, beside Files.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

test('the Browser is a tile on the Office home grid', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice())

  // The grid people launch things from, alongside PlexiDocs and PlexiSheets.
  const tile = window.locator('[data-testid="office-app-browser"]')
  await expect(tile, 'the Browser should have an app tile').toBeVisible()
  await expect(tile).toContainText('Browser')

  await tile.click()
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()
  // And it is navigation, so it reaches the tray like any other app.
  await expect
    .poll(() => window.evaluate(() => (window as any).__fbView.getState().view), { timeout: 10_000 })
    .toMatchObject({ kind: 'office', app: 'browser' })
})

test('the Browser is listed in the Office side menu, under Tools', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice())

  // The side menu has two tile grids: PlexiiApps (the document apps and
  // PlexiiCall) and Tools (Mail, Inbox, Chat, Calendar, Files, Browser,
  // Vault). Communicate is gone; the Browser is a Tools tile, and it opens the
  // browser inside Office rather than taking over as a comms surface.
  const tool = window.locator('[data-testid="office-comms-app-browser"]')
  await expect(tool).toBeVisible()
  await expect(window.locator('[data-testid="office-sideapp-browser"]')).toHaveCount(0)

  await tool.click()
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()
})

test('Mail and Chat stay with the tools, not among the apps', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice())

  // Moving the Browser must not drag Mail and Chat in among the apps.
  for (const key of ['mail', 'chat']) {
    await expect(
      window.locator(`[data-testid="office-comms-app-${key}"]`),
      `${key} is a Tools tile`
    ).toBeVisible()
    await expect(window.locator(`[data-testid="office-sideapp-${key}"]`)).toHaveCount(0)
  }
})
