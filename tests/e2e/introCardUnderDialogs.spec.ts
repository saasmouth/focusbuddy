// ICD: the local-AI intro card is a notice; a dialog opened over it wins.
//
// The card (bottom centre) used to sit above every full-screen dialog below
// z-198, so on a first launch it covered their bottom-centre buttons: the
// dashboard wizard's Skip with the bundled model (dashboardWizard L145, the
// "built in" variant) and the book-time Create with no model (timeBlocks TB-3,
// the "available as a download" variant). The source-level guard is
// tests/unit/introCardBelowDialogs.test.ts; this proves it in the running app,
// by asking the page what a click at the card's centre would hit once a dialog
// is open over it.

import { test, expect, type Page } from '@playwright/test'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const STAGED = join(process.cwd(), 'resources', 'models')
const staged = existsSync(STAGED) && readdirSync(STAGED).length > 0

let launched: LaunchedApp | undefined
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = undefined
})

async function openWizard(window: Page): Promise<void> {
  await window.evaluate(() => {
    ;(window as unknown as { __fbView: { getState: () => { goPlexiDesk: (a?: string) => void } } }).__fbView.getState().goPlexiDesk('home')
  })
  await window.locator('[data-testid="home-wizard-open"]').click()
  await expect(window.locator('[data-testid="dashboard-wizard"]')).toBeVisible({ timeout: 8_000 })
}

/** What a click at the card's centre lands on, with the wizard open over it. */
async function hitAtCardCentre(window: Page): Promise<{ onCard: boolean; inWizard: boolean }> {
  return window.evaluate(() => {
    const card = document.querySelector('[data-testid="local-ai-intro"]') as HTMLElement
    const r = card.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { onCard: !!hit && card.contains(hit), inWizard: !!hit?.closest('[data-testid="dashboard-wizard"]') }
  })
}

test('ICD-1 the "built in" card (bundled model) sits under the dashboard wizard', async () => {
  test.skip(!staged, 'this tree has no resources/models staged')
  test.setTimeout(180_000)
  launched = await launchApp({ bundledModels: true })
  const { window } = launched
  await waitForReady(window)
  const card = window.locator('[data-testid="local-ai-intro"]')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await expect(card).toContainText('Local AI is now built in')
  await openWizard(window)
  expect(await hitAtCardCentre(window)).toEqual({ onCard: false, inWizard: true })
})

test('ICD-2 the "available as a download" card (no model) sits under the dashboard wizard', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const card = window.locator('[data-testid="local-ai-intro"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveAttribute('data-variant', 'offer')
  await openWizard(window)
  expect(await hitAtCardCentre(window)).toEqual({ onCard: false, inWizard: true })
})
