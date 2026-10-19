// E2E: real-name identity change (Plexi3.0 branch).
//
// Test 1 drives the real signup form fields with no network involved.
//
// Test 2 drives the real client code path (LaunchSignInModal -> accountStore
// -> accountClient.signup/updateProfile -> real fetch calls) but STUBS the
// network responses at the Playwright route layer.
//
// Why stubbed, not live: the packaged build's renderer loads from file:// and
// its CSP (`connect-src 'self' ws: wss: https:` in src/renderer/index.html)
// refuses any http:// origin outright. Confirmed empirically -- pointing a
// build at a real, isolated, disposable local focusbuddy-signal instance
// (http://localhost:8791) and driving a real signup through the UI produced
// a browser-level CSP violation ("Refused to connect to
// 'http://localhost:8791/accounts/signup' ... connect-src") before the
// request ever left the renderer: no request reached the signal server's
// access log, and no Playwright `route`/`requestfailed` event fired either,
// because Chromium aborts the fetch before it becomes a network request.
// This is the project's documented, intentional CSP hardening, not a
// regression from the identity change, and it cannot be routed around from
// script running inside the page. Independently, the real signal server's
// /accounts/signup contract WAS verified live via curl against that same
// isolated instance:
//   curl -X POST http://localhost:8791/accounts/signup -d
//     '{"email":"tester1@example.com","password":"testpass123","firstName":"Ada","lastName":"Lovelace"}'
//   -> {"ok":true,"sessionToken":"...","account":{"id":"acc_...",
//       "email":"tester1@example.com","handle":null,"firstName":"Ada",
//       "lastName":"Lovelace",...}}
// So for this spec the app is built with an https:// signal URL (satisfies
// the CSP `https:` allowance) and Playwright intercepts those specific
// https calls, fulfilling them with fixture data shaped exactly like the
// curl-verified real response. This exercises the real renderer code (real
// component state machine, real accountStore, real personDisplayName
// rendering, real Settings save wiring, real fetch call site and payload)
// end to end; only the actual network hop is stubbed.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openSignInModal(window: Page): Promise<void> {
  const settingsBtn = window.getByRole('button', { name: /appearance settings/i })
  await settingsBtn.click()
  const settingsPanel = window.locator('.fixed.z-\\[200\\].overflow-y-auto').first()
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 })
  await window.evaluate(() => {
    document.querySelector('[data-testid="account-signin"]')?.scrollIntoView({ block: 'nearest' })
  })
  await window.locator('[data-testid="account-signin"]').click()
  await expect(window.locator('[data-testid="signin-close"]')).toBeVisible({ timeout: 5_000 })
}

test('signup form shows first/last name fields, not a handle field (real UI, no network)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openSignInModal(window)
  await window.getByRole('button', { name: 'Sign up', exact: true }).click()

  await expect(window.locator('[data-testid="signup-first-name"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="signup-last-name"]')).toBeVisible({ timeout: 5_000 })
  // The old handle input must be gone.
  await expect(window.locator('input[name="handle"]')).toHaveCount(0)
  await expect(window.getByPlaceholder(/handle/i)).toHaveCount(0)
})

test('signup persists first/last name; Settings identity + name editor round-trip (real client code, stubbed network)', async () => {
  const email = `plexitester-${Date.now()}@example.com`
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  let currentFirst = ''
  let currentLast = ''
  const accountId = 'acc_test_identity'
  let profileCallCount = 0

  await window.route('**/accounts/signup', async (route) => {
    const body = route.request().postDataJSON() as { firstName?: string; lastName?: string }
    currentFirst = body.firstName ?? ''
    currentLast = body.lastName ?? ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        sessionToken: 'stub-session-token',
        account: {
          id: accountId,
          email,
          handle: null,
          firstName: currentFirst,
          lastName: currentLast,
          createdAt: Date.now(),
          lastLoginAt: null
        }
      })
    })
  })

  await window.route('**/accounts/profile', async (route) => {
    profileCallCount++
    const body = route.request().postDataJSON() as { firstName?: string | null; lastName?: string | null }
    currentFirst = body.firstName ?? ''
    currentLast = body.lastName ?? ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        account: {
          id: accountId,
          email,
          handle: null,
          firstName: currentFirst,
          lastName: currentLast,
          createdAt: Date.now(),
          lastLoginAt: Date.now()
        }
      })
    })
  })

  await waitForReady(window)

  // --- Real UI-driven signup: real accountStore.signup() / accountClient
  // .signup() code path fires, network response stubbed above. ---
  await openSignInModal(window)
  await window.getByRole('button', { name: 'Sign up', exact: true }).click()
  await window.locator('input[type="email"]').fill(email)
  await window.locator('[data-testid="signup-first-name"]').fill('Ada')
  await window.locator('[data-testid="signup-last-name"]').fill('Lovelace')
  await window.locator('input[type="password"]').fill('testpass123')
  await window.getByRole('button', { name: 'Create account' }).click()

  // Signup resolves -> the modal unmounts because account is now populated.
  await expect(window.locator('[data-testid="signin-close"]')).toHaveCount(0, { timeout: 10_000 })

  // The Settings popover behind the modal closes itself on any outside
  // click (including clicks landing inside the sign-in modal's own
  // document.body portal, which sits outside the popover's DOM subtree) --
  // pre-existing SettingsPanel behavior, unrelated to the identity change.
  // Reopen Settings fresh now that the modal is gone.
  await window.getByRole('button', { name: /appearance settings/i }).click()
  await expect(window.locator('.fixed.z-\\[200\\].overflow-y-auto').first()).toBeVisible({ timeout: 5_000 })

  // --- Settings -> Account shows the full name as identity (personDisplayName) ---
  await window.evaluate(() => {
    document.querySelector('[data-testid="account-identity"]')?.scrollIntoView({ block: 'nearest' })
  })
  const identity = window.locator('[data-testid="account-identity"]')
  await expect(identity).toBeVisible({ timeout: 5_000 })
  await expect(identity).toHaveText('Ada Lovelace')

  // --- Edit the name via the real Settings editor and Save -> real
  // updateName() -> real POST /accounts/profile (stubbed response above). ---
  const firstInput = window.locator('[data-testid="account-first-name"]')
  const lastInput = window.locator('[data-testid="account-last-name"]')
  await expect(firstInput).toHaveValue('Ada')
  await expect(lastInput).toHaveValue('Lovelace')

  await firstInput.fill('Grace')
  await lastInput.fill('Hopper')
  const saveBtn = window.locator('[data-testid="account-save-name"]')
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()

  await expect(identity).toHaveText('Grace Hopper', { timeout: 5_000 })
  expect(profileCallCount, 'Save must call POST /accounts/profile exactly once').toBe(1)

  // The editor inputs reflect the name coming back from the store update
  // (real setState from the resolved updateName() call), not just what was
  // typed -- proves the round trip through the (stubbed) server response.
  await expect(firstInput).toHaveValue('Grace')
  await expect(lastInput).toHaveValue('Hopper')

  expect(pageErrors, `Uncaught renderer errors: ${pageErrors.join('\n')}`).toHaveLength(0)
})
