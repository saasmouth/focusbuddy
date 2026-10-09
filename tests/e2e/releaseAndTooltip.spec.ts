import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Two pieces of the 2.5.26 onboarding work, exercised in the real app:
//  1. The first-run "What's new in vX.Y.Z" modal shows once after an update for
//     a returning user, dismisses, and does not reappear.
//  2. Hovering a header control shows the new portalled tooltip.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('RM-1 — release modal shows once after an update, then not again', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Simulate a returning user who just updated: the last-run version is an older
  // one, and this version has not been acknowledged yet.
  await window.evaluate(() => {
    localStorage.setItem('fb.app.lastRunVersion', '2.5.25')
    localStorage.removeItem('fb.app.releaseModalVersion')
  })
  await window.reload()
  await waitForReady(window)

  const modal = window.locator('[role="dialog"][aria-label*="What"]')
  await expect(modal).toBeVisible({ timeout: 8000 })
  // The modal shows the CHANGELOG entry for the version actually running, so
  // pinning 2.5.26 (the release this test was written for) fails on every later
  // build. What matters is that it names a version and offers the learn-more
  // link — and, below, that it shows once and not again.
  await expect(modal).toContainText(/v\d+\.\d+\.\d+/)
  // "Learn more" links are OPTIONAL per changelog entry (ChangelogEntry.links),
  // so requiring them makes this test fail on any release that ships without
  // one. The dismiss control is what every entry has, and what the
  // shows-once-then-not-again behaviour below depends on.
  await expect(modal.getByRole('button', { name: /got it|close/i }).first()).toBeVisible()

  // The release version is recorded the moment the modal mounts. Read the
  // version the modal is actually showing rather than the literal this test
  // was written against, so it keeps working on every later release.
  const label = (await modal.getAttribute('aria-label')) ?? ''
  const shownVersion = (label.match(/v(\d+\.\d+\.\d+)/) ?? [])[1]
  expect(shownVersion, 'the modal names a version').toBeTruthy()
  const seenWhileOpen = await window.evaluate(() => localStorage.getItem('fb.app.releaseModalVersion'))
  expect(seenWhileOpen).toBe(shownVersion)

  await window.getByRole('button', { name: 'Got it' }).click()
  await expect(modal).toHaveCount(0)

  // Reload → it must not reappear for a version already seen.
  await window.reload()
  await waitForReady(window)
  await window.waitForTimeout(600)
  await expect(window.locator('[role="dialog"][aria-label*="What"]')).toHaveCount(0)
})

test('RM-2 — does NOT show on a fresh launch with no prior state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  // Fresh app data dir → no prior fb.* state → modal must stay hidden.
  await window.waitForTimeout(600)
  await expect(window.locator('[role="dialog"][aria-label*="What"]')).toHaveCount(0)
})

test('TT-1 — hovering the Ask AI button shows a tooltip', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // No prior state, so no release modal is in the way.
  const askAi = window.getByRole('button', { name: /search and commands/i })
  await expect(askAi).toBeVisible()
  await askAi.hover()

  const tip = window.locator('[role="tooltip"]')
  await expect(tip).toBeVisible({ timeout: 4000 })
  // The one-shot "Ask AI" command bar retired in the Plexii consolidation;
  // the surviving header control is Search and commands. What this test is for
  // is that the portalled tooltip appears and names its control.
  await expect(tip).toContainText(/search|command/i)

  // Moving away hides it.
  await window.mouse.move(5, 5)
  await expect(tip).toHaveCount(0, { timeout: 4000 })
})
