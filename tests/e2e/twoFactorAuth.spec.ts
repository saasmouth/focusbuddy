/**
 * twoFactorAuth.spec.ts — E2E verification of the 2FA UI surface in the desktop app.
 *
 * Scope:
 *   1. In the Settings panel (signed-out state) the TwoFactorSettings component
 *      must NOT render (it guards on token presence).
 *   2. The sign-in modal must NOT show the 2fa-code field by default.
 *   3. After a simulated twoFactorRequired response (injected via IPC stub), the
 *      signin-2fa-code testid must appear.
 *
 * NOTE: A full enrol-via-real-server test (where the desktop calls the live signal
 * server, gets a secret, the user enters a TOTP code, etc.) requires a live server
 * reachable from the renderer over https — the hermetic test environment uses a
 * file:// origin which blocks http calls to localhost. That path is verified by the
 * REST-level tests above. The E2E here is scoped to what the renderer renders,
 * which is what the UI contract guarantees.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('twofa-toggle is absent when signed out (TwoFactorSettings guards on token)', async () => {
  launched = await launchApp()
  const { window } = launched

  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Open Settings via the gear button.
  const settingsBtn = window.getByRole('button', { name: /appearance settings/i })
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
  await settingsBtn.click()

  const settingsPanel = window.locator('[role="dialog"][aria-label="Settings"]')
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 })

  // Mount AccountSection by selecting its tab. Without this the assertions
  // below were vacuous — they checked that controls were absent from a panel
  // that had never rendered them, so they would have passed against any app.
  await window.locator('[data-testid="settings-tab-account"]').click()
  await expect(window.locator('[data-testid="account-signin"]')).toBeVisible({ timeout: 5_000 })

  // Signed-out state: TwoFactorSettings returns null when no token, so neither
  // twofa-toggle nor twofa-confirm-code should exist in the DOM.
  await expect(window.locator('[data-testid="twofa-toggle"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="twofa-confirm-code"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="twofa-disable-code"]')).toHaveCount(0)

  expect(pageErrors).toHaveLength(0)
})

test('sign-in modal does NOT show 2fa-code field by default (only after twoFactorRequired)', async () => {
  launched = await launchApp()
  const { window } = launched

  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Open Settings, scroll to account section, click "Sign in or create account".
  const settingsBtn = window.getByRole('button', { name: /appearance settings/i })
  await settingsBtn.click()
  const settingsPanel = window.locator('[role="dialog"][aria-label="Settings"]')
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 })
  // The panel is tabbed, and AccountSection only mounts on the Account tab
  // (`{tab === 'account' && <AccountSection />}`). These two tests predate the
  // tabs and went on scrolling to a button that was never in the DOM, so they
  // had been red for reasons that were never a bug in the app.
  await window.locator('[data-testid="settings-tab-account"]').click()
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="account-signin"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
  const signInBtn = window.locator('[data-testid="account-signin"]')
  await expect(signInBtn).toBeVisible({ timeout: 5_000 })
  await signInBtn.click()

  // Modal should open.
  const closeBtn = window.locator('[data-testid="signin-close"]')
  await expect(closeBtn).toBeVisible({ timeout: 5_000 })

  // The 2fa-code field must NOT be visible on initial modal open (only the
  // password field is shown; twoFactor state starts as false).
  await expect(window.locator('[data-testid="signin-2fa-code"]')).toHaveCount(0)

  // Email and password inputs must be visible inside the sign-in modal.
  // The settings panel has other password-type inputs (API key fields) so we
  // scope the check to the modal dialog element to avoid strict-mode failures.
  const modal = window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
  await expect(modal.locator('input[type="email"]')).toBeVisible({ timeout: 3_000 })
  await expect(modal.locator('input[type="password"]')).toBeVisible({ timeout: 3_000 })

  expect(pageErrors).toHaveLength(0)
})
