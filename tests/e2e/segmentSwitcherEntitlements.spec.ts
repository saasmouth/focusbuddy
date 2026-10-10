// E2E: area-switcher per-user product entitlements.
//
// src/renderer/src/components/WorkspaceSwitcher.tsx filters its four areas
// (Desk/Office/People/Brain) by the resolved capability map
// (product_desk/product_office/product_people/product_brain), keeping Desk
// as an always-present floor even if product_desk itself were off.
//
// Test 1 proves the default state: with no capability overrides (the local
// free-tier snapshot has all four product_* capabilities true), all four
// switch buttons render.
//
// Test 2 proves the entitlement-off path end to end through the REAL client
// code: real accountStore.adoptHandoff() -> real getMe() (GET /accounts/me)
// -> real capabilities store subscribe-on-sessionToken-change -> real
// refresh() (GET /account/capabilities) -> real WorkspaceSwitcher filter. Only
// the two network hops are stubbed at the Playwright route layer (same
// pattern as identityRealName.spec.ts and authDeepLinkConfirm.spec.ts): the
// packaged test build's renderer loads from file:// and its CSP only allows
// https: connections, and the prod default signal host
// (https://focusbuddy-signal.fly.dev) is what a build with no
// VITE_SIGNAL_HTTP_URL override resolves to, so route patterns match before
// any real request leaves the process.
//
// This drives the "incoming session" path (the same real IPC event
// authDeepLinkConfirm.spec.ts uses) rather than the full sign-up form,
// because it is the shortest real path to a populated sessionToken without
// touching a live server.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, openAreaSwitcher, waitForReady, type LaunchedApp } from './_helpers'
import { CAPABILITY_DEFAULTS, type CapabilityValue } from '../../src/renderer/src/lib/capabilityDefaults'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

function freeMapWith(overrides: Record<string, CapabilityValue>): Record<string, CapabilityValue> {
  const out: Record<string, CapabilityValue> = {}
  for (const [key, perTier] of Object.entries(CAPABILITY_DEFAULTS)) {
    out[key] = perTier.free
  }
  return { ...out, ...overrides }
}

async function confirmIncomingSession(
  app: LaunchedApp['app'],
  window: Page,
  token: string,
  email: string
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.webContents.send('auth:incoming-token', {
      sessionToken: payload.token,
      email: payload.email,
      handle: null,
      origin: 'open-url'
    })
  }, { token, email })

  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole('button', { name: 'Sign in' }).click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })
}

// ── Test 1: default state — all four areas entitled by default ──────────────

test('1 — default capabilities: all four segment-switcher areas render', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openAreaSwitcher(window)
  const switcher = window.locator('[data-testid="workspace-switcher-menu"]')
  await expect(switcher).toBeVisible()
  await expect(switcher.locator('[data-testid="switch-plexidesk"]')).toBeVisible()
  await expect(switcher.locator('[data-testid="switch-office"]')).toBeVisible()
  await expect(switcher.locator('[data-testid="switch-plexipeople"]')).toBeVisible()
  await expect(switcher.locator('[data-testid="switch-plexibrain"]')).toBeVisible()
})

// ── Test 2: entitlement off — product_office / product_brain greyed ────────

test('2 — product_office (licensing) and product_brain (admin) off: greyed with reason-aware tooltips; Desk stays', async () => {
  const email = `entitlement-test-${Date.now()}@example.com`
  const accountId = 'acc_test_entitlements'
  const token = 'stub-entitlement-session-token'

  launched = await launchApp()
  const { app, window } = launched

  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  let capabilitiesCallCount = 0

  await window.route('**/accounts/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        account: {
          id: accountId,
          email,
          handle: null,
          firstName: 'Ada',
          lastName: 'Lovelace',
          createdAt: Date.now(),
          lastLoginAt: Date.now()
        }
      })
    })
  })

  const capsMap = freeMapWith({ product_office: false, product_brain: false })
  await window.route('**/account/capabilities**', async (route) => {
    capabilitiesCallCount++
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        tier: 'free',
        storedTier: 'free',
        effectiveTier: 'free',
        trial: { active: false, daysLeft: 0, startedAt: null, expiresAt: null },
        capabilities: capsMap,
        // Office off due to licensing (offer upgrade); Brain off due to an
        // explicit admin restriction (no upsell).
        sources: { product_office: 'org', product_brain: 'user' },
        orgRole: null
      })
    })
  })

  await waitForReady(window)

  // Sanity: all four present before the entitlement change lands.
  await openAreaSwitcher(window)
  const switcher = window.locator('[data-testid="workspace-switcher-menu"]')
  await expect(switcher.locator('[data-testid="switch-office"]')).toBeVisible()
  await expect(switcher.locator('[data-testid="switch-plexibrain"]')).toBeVisible()

  await confirmIncomingSession(app, window, token, email)

  // The capabilities store refreshes off the sessionToken-change subscription;
  // wait for the stubbed endpoint to actually have been hit before asserting.
  await expect.poll(() => capabilitiesCallCount, { timeout: 5_000 }).toBeGreaterThan(0)

  // Signing in clicked through a dialog, and a mousedown outside the switcher
  // closes it — reopen to read the areas after the entitlement change.
  await openAreaSwitcher(window)

  // Office and Brain are no longer entitled -> still shown, but greyed/locked.
  const office = switcher.locator('[data-testid="switch-office"]')
  const brain = switcher.locator('[data-testid="switch-plexibrain"]')
  await expect.poll(async () => await office.getAttribute('data-locked'), { timeout: 5_000 }).toBe('true')
  await expect(brain).toHaveAttribute('data-locked', 'true')

  // Reason-aware tooltips: Office is a licensing gap (upgrade), Brain is an
  // admin restriction (no upsell).
  expect(await office.getAttribute('title')).toContain('Upgrade')
  expect(await brain.getAttribute('title')).toContain('administrator')

  // Desk (the floor) and People (still entitled) remain enabled (not locked).
  await expect(switcher.locator('[data-testid="switch-plexidesk"]')).toBeVisible()
  await expect(switcher.locator('[data-testid="switch-plexidesk"]')).not.toHaveAttribute('data-locked', 'true')
  await expect(switcher.locator('[data-testid="switch-plexipeople"]')).not.toHaveAttribute('data-locked', 'true')

  expect(pageErrors, `Uncaught renderer errors: ${pageErrors.join('\n')}`).toHaveLength(0)
})
