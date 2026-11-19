import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// A sign-in link whose token the server no longer knows (expired, revoked or
// made up) signs nobody in: Plexii says the link has expired and asks nothing.
//
// Until 2026-11-20 this spec proved the older guard: a live link was confirmed
// naming the email the LINK claimed, before any server call. That was replaced
// (authLinkGuard.spec.ts): every link Plexii did not start is checked with the
// server first, and the question names the account the server says the token
// is. We drive the real renderer path: the 'auth:incoming-token' IPC event main
// sends on a live link, with no startedHere (main sets it only for a sign-in
// this app started).

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('a sign-in link the server does not know is refused with a notice, and nothing is adopted', async () => {
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  let meCalls = 0
  await window.route('**/accounts/me', async (route) => {
    meCalls++
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' })
  })

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('auth:incoming-token', {
      sessionToken: 'e2e-unknown-session-token',
      email: 'attacker-controlled@example.com',
      handle: null,
      origin: 'open-url',
      startedHere: false
    })
  })

  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog).toContainText('This sign-in link has expired')
  await expect(dialog).not.toContainText('attacker-controlled@example.com')
  await expect(dialog.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
  expect(meCalls).toBe(1)
  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(dialog).toBeHidden({ timeout: 3_000 })
  const token = await window.evaluate(
    () => (window as unknown as { __fbAccount: { getState: () => { sessionToken: string | null } } }).__fbAccount.getState().sessionToken
  )
  expect(token).toBeNull()
})
