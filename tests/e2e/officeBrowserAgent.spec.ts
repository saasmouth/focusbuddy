// Plexii driving the Office browser.
//
// The browser agent already existed, but only the desk web panel could reach
// it: the run targets a webContents id, and only that panel published one. A
// browser you can open without a desk was therefore a browser the agent could
// not drive — which is most of the reason to have one.
//
// These do not run a real agent (that needs a key and the open web). They
// assert the wiring a run depends on: the page publishes an id the agent can
// address, and the door to start one is present with its presets.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

test('the Office browser publishes a webContents the agent can drive', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(() => (window as any).__fbView.getState().goOffice('browser'))
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()

  // The id arrives once the guest attaches, which is why the component polls.
  await expect
    .poll(
      () => window.evaluate(() => (window as any).__fbWebPanel?.getState().wcId ?? null),
      { timeout: 20_000, message: 'the agent had no page to address' }
    )
    .not.toBeNull()
})

test('the ask door offers the presets, not just a blank field', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice('browser'))
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()

  await window.locator('[data-testid="office-browser-agent"]').click()
  await expect(window.locator('[data-testid="agent-ask-dock"]')).toBeVisible()
  await expect(window.locator('[data-testid="agent-ask-input"]')).toBeVisible()

  // The handful of things most sessions actually want.
  for (const id of ['summarise', 'links', 'images', 'extract', 'similar', 'research']) {
    await expect(
      window.locator(`[data-testid="agent-quick-${id}"]`),
      `the ${id} preset should be offered`
    ).toBeVisible()
  }
})

test('leaving the Office browser stands its webContents down', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(() => (window as any).__fbView.getState().goOffice('browser'))
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()
  await expect
    .poll(() => window.evaluate(() => (window as any).__fbWebPanel?.getState().wcId ?? null), {
      timeout: 20_000
    })
    .not.toBeNull()

  // Navigating away must not leave the agent pointed at a page that is gone —
  // a run started afterwards would drive a dead webContents.
  await window.evaluate(() => (window as any).__fbView.getState().goOffice())
  await expect
    .poll(() => window.evaluate(() => (window as any).__fbWebPanel?.getState().wcId ?? null), {
      timeout: 10_000,
      message: 'the agent was left pointing at a browser that had closed'
    })
    .toBeNull()
})
