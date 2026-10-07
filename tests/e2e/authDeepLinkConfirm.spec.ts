import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// End-to-end proof of the MEDIUM fix in App.tsx: a LIVE incoming
// plexii://auth?token=... deep link (which any website can trigger while the
// app is open — a session-fixation / forced-login vector) must no longer be
// adopted silently. It must show an explicit confirm dialog naming the
// account, and only proceed to adoptHandoff() (which calls the signal
// server) if the user confirms.
//
// We drive the REAL renderer code path: send the actual 'auth:incoming-token'
// IPC event from the main process (exactly what main's protocol handler does
// on a real deep link), which the real preload listener + App.tsx handler
// receive. We intercept the network call adoptHandoff would make
// (GET /accounts/me) to prove, by presence/absence of that request, whether
// sign-in was attempted — without needing a real account or signal server.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('incoming auth deep link requires explicit confirm; cancel never calls the server', async () => {
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  let meCalls = 0
  await window.route('**/accounts/me', async (route) => {
    meCalls++
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' })
  })

  // Fire the real IPC event main sends on a live plexii://auth deep link.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.webContents.send('auth:incoming-token', {
      sessionToken: 'e2e-fake-session-token',
      email: 'attacker-controlled@example.com',
      handle: null,
      origin: 'open-url'
    })
  })

  // The confirm dialog must appear, naming the account from the handoff.
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog).toContainText('Sign in to PlexiDesk?')
  await expect(dialog).toContainText('attacker-controlled@example.com')

  // Cancel — must NOT call adoptHandoff, so /accounts/me is never hit.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden({ timeout: 3_000 })
  // Give any (incorrect) fire-and-forget network call a moment to land before
  // asserting its absence.
  await window.waitForTimeout(500)
  expect(meCalls).toBe(0)

  // Fire a second incoming token and this time confirm — adoptHandoff SHOULD
  // now run and hit /accounts/me (which we've stubbed to 401, so sign-in
  // fails harmlessly, but the call proves the confirm path is live).
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.webContents.send('auth:incoming-token', {
      sessionToken: 'e2e-fake-session-token-2',
      email: 'attacker-controlled@example.com',
      handle: null,
      origin: 'open-url'
    })
  })
  const dialog2 = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog2).toBeVisible({ timeout: 5_000 })
  await dialog2.getByRole('button', { name: 'Sign in' }).click()
  await expect(dialog2).toBeHidden({ timeout: 3_000 })

  await expect
    .poll(() => meCalls, { timeout: 5_000 })
    .toBeGreaterThan(0)
})
