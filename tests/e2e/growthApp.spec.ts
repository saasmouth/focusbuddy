import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Growth changes (GROWTH-IMPLEMENTATION.md), driven in the real app on a
// throwaway profile with no server account:
//   - section 3: an account is required on the first launch (the harness turns
//     its anonymous exception off with PLEXI_E2E_REQUIRE_ACCOUNT=1);
//   - sections 1 and 10: the upgrade modal offers Pro, Pro+ and Team at the
//     spec's prices.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('first launch requires an account: no skip, no close, a browser route', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', PLEXI_E2E_REQUIRE_ACCOUNT: '1' } })
  const { window } = launched
  await waitForReady(window, { dismissModals: false })

  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByText('Create your Plexii account')).toBeVisible()
  await expect(dialog.getByText(/Verify your email to start a 14-day trial with 300 AI credits/)).toBeVisible()
  await expect(dialog.locator('[data-testid="signin-close"]')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: /continue without account/i })).toHaveCount(0)
  await expect(dialog.locator('[data-testid="account-required-note"]')).toHaveText('Continue in your browser')

  // It stays up: Escape and a backdrop click are not ways past it.
  await window.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
})

test('the harness may still run without an account', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  const { window } = launched
  await waitForReady(window)
  await expect(window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')).toHaveCount(0)
})

test('upgrade modal offers Pro, Pro+ and Team at the spec prices', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  const { window } = launched
  await waitForReady(window)

  await window.getByRole('button', { name: 'Upgrade Now' }).first().click()
  const modal = window.locator('[data-testid="upgrade-prompt-modal"]')
  await expect(modal).toBeVisible({ timeout: 5_000 })

  await expect(modal.locator('[data-testid="upgrade-price-pro"]')).toHaveText('US$12/month')
  await expect(modal.locator('[data-testid="upgrade-price-proplus"]')).toHaveText('US$25/month')
  await expect(modal.locator('[data-testid="upgrade-price-team"]')).toHaveText('US$15/month per seat')

  await modal.locator('[data-testid="upgrade-interval-year"]').click()
  await expect(modal.locator('[data-testid="upgrade-price-pro"]')).toHaveText('US$120/year')
  await expect(modal.locator('[data-testid="upgrade-price-proplus"]')).toHaveText('US$250/year')

  await modal.locator('[data-testid="upgrade-plan-proplus"]').click()
  await expect(modal.locator('[data-testid="upgrade-start-checkout"]')).toHaveText('Upgrade to Pro+')
})
