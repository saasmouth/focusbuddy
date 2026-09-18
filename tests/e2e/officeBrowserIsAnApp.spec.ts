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

test('the Browser is listed under Apps, not under Communicate', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice())

  // Listed with the apps…
  const sideApp = window.locator('[data-testid="office-sideapp-browser"]')
  await expect(sideApp).toBeVisible()
  // …and NOT among the communicate entries, where it was.
  await expect(window.locator('[data-testid="office-comms-app-browser"]')).toHaveCount(0)

  await sideApp.click()
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()
})

test('the things that ARE communication stay under Communicate', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice())

  // The move must not drag Mail and Chat out of the section they belong in.
  for (const key of ['mail', 'chat']) {
    await expect(
      window.locator(`[data-testid="office-comms-app-${key}"]`),
      `${key} belongs under Communicate`
    ).toBeVisible()
    await expect(window.locator(`[data-testid="office-sideapp-${key}"]`)).toHaveCount(0)
  }
})
