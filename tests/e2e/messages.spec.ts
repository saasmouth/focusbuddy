import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, openProduct, suppressFeatureSpotlights } from './_helpers'

// Messaging UI plumbing. The e2e harness runs signed-out (no account), so the
// deterministic check is that PlexiiChat (Messages) and Inbox open from Office's
// comms apps and show the sign-in gate. (They used to be top-level sidebar
// buttons.) Real DM flow needs two signed-in users + the live server; the
// server side is covered by the signal server's messagingFlow integration test.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('MSG-1 — PlexiiChat (Messages) opens from Office and gates on sign-in', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await suppressFeatureSpotlights(window)

  await openProduct(window, 'chat')

  // Signed-out gate renders (the harness continues without an account).
  await expect(
    window.getByRole('heading', { name: 'Messages', exact: true })
  ).toBeVisible({ timeout: 8000 })
  await expect(window.getByText(/Sign in to message other people on PlexiiDesk/)).toBeVisible()
})

test('MSG-2 — PlexiInbox opens from Office and gates on sign-in', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await suppressFeatureSpotlights(window)

  await openProduct(window, 'inbox')
  await expect(window.getByRole('heading', { name: 'PlexiiInbox' })).toBeVisible({ timeout: 6000 })
  // Internal-only: the gate copy talks about PlexiDesk notifications and points email to Mail.
  await expect(window.getByText(/your PlexiiDesk notifications/i)).toBeVisible()
  await expect(window.getByText(/Email is in Mail/i)).toBeVisible()
})
