// Owner, 2026-10-27: "a user should always have to sign up for at least a free
// account to be able to use the app, and it should always require them to sign
// in on each new opening of the app."
//
// The harness normally runs without an account (main: anonymousLaunchAllowed);
// PLEXI_E2E_REQUIRE_ACCOUNT=1 gives it the rule every packaged build has.
// AE-2 and AE-3 take the account server down themselves: every request to it
// is answered as a dropped connection, as an outage or no network would be.
import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const REQUIRE = { PLEXI_E2E_REQUIRE_ACCOUNT: '1' }
let launched: LaunchedApp | null = null
let dir: string | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

const wall = (window: Page) => window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')

async function serverDown(window: Page): Promise<void> {
  await window.route(
    (u) => u.hostname === 'api.plexiidesk.com' || u.hostname === 'focusbuddy-signal.fly.dev',
    (route) => route.abort('internetdisconnected')
  )
}

async function attempt(window: Page, email: string, password = 'a-long-enough-password'): Promise<void> {
  const d = wall(window)
  await d.locator('input[type="email"]').fill(email)
  const first = d.locator('input[placeholder="Jane"]')
  if (await first.count()) {
    await first.fill('Sam')
    await d.locator('input[placeholder="Smith"]').fill('Rivera')
  }
  await d.locator('[data-testid="signin-password"]').fill(password)
  await d.locator('[data-testid="signin-submit"]').click()
}

test('AE-1 a session from the last launch is gone: every opening asks for the password again', async () => {
  dir = mkdtempSync(join(tmpdir(), 'plexii-every-launch-'))
  launched = await launchApp({ userDataDir: dir, env: REQUIRE })
  await waitForReady(launched.window, { dismissModals: false })
  await launched.window.evaluate(() =>
    (window as unknown as { api: { account: { saveSession: (i: { token: string; email: string }) => Promise<void> } } }).api.account.saveSession({
      token: 'SESSION-FROM-LAUNCH-ONE',
      email: 'sam@example.com'
    })
  )
  const saved = await launched.window.evaluate(() => (window as unknown as { api: { account: { load: () => Promise<{ sessionToken: string | null }> } } }).api.account.load())
  expect(saved.sessionToken, 'the session did not save in the first launch').toBe('SESSION-FROM-LAUNCH-ONE')
  await launched.app.close()
  launched = null

  launched = await launchApp({ userDataDir: dir, env: REQUIRE })
  const { window } = launched
  await waitForReady(window, { dismissModals: false })
  const state = await window.evaluate(() => (window as unknown as { api: { account: { load: () => Promise<{ sessionToken: string | null; cachedEmail: string | null }> } } }).api.account.load())
  expect(state.sessionToken, 'the second opening still had the first one’s session').toBeNull()
  expect(state.cachedEmail).toBe('sam@example.com')
  await expect(wall(window)).toBeVisible({ timeout: 10_000 })
  // Back to log in, address filled in: only the password to type.
  await expect(wall(window).locator('input[type="email"]')).toHaveValue('sam@example.com')
  await expect(wall(window).locator('[data-testid="signin-close"]')).toHaveCount(0)
})

test('AE-2 someone who has never signed in cannot get past the wall by being offline', async () => {
  launched = await launchApp({ env: REQUIRE })
  const { window } = launched
  await waitForReady(window, { dismissModals: false })
  await expect(wall(window)).toBeVisible({ timeout: 10_000 })
  await serverDown(window)
  await attempt(window, 'new-person@example.com')
  await expect(wall(window)).toContainText(/connection/i, { timeout: 15_000 })
  await expect(wall(window).locator('[data-testid="signin-offline"]'), 'a new user was offered a way in offline').toHaveCount(0)
  await expect(wall(window).locator('[data-testid="signin-close"]')).toHaveCount(0)
  await window.keyboard.press('Escape')
  await expect(wall(window)).toBeVisible()
})

test('AE-3 during an outage, the account last signed in here signs in OFFLINE, with its password', async () => {
  // Owner, 2026-11-07: "Do not allow anyone to open plexii without signing in
  // first as a rule." This was "Continue offline": a button, and no password.
  dir = mkdtempSync(join(tmpdir(), 'plexii-offline-known-'))
  launched = await launchApp({ userDataDir: dir, env: REQUIRE })
  await waitForReady(launched.window, { dismissModals: false })
  // What a successful online sign-in leaves behind on this computer.
  const kept = await launched.window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.account.saveSession({ token: 'EARLIER-SESSION', email: 'sam@example.com' })
    return api.account.rememberOfflineSignIn('sam@example.com', 'a-long-enough-password')
  })
  expect(kept, 'the offline check was not kept (no OS encryption in the harness?)').toBe(true)
  await launched.app.close()
  launched = null

  launched = await launchApp({ userDataDir: dir, env: REQUIRE })
  const { window } = launched
  await waitForReady(window, { dismissModals: false })
  await expect(wall(window)).toBeVisible({ timeout: 10_000 })
  await serverDown(window)
  await attempt(window, 'sam@example.com')
  const offline = wall(window).locator('[data-testid="signin-offline"]')
  await expect(offline).toBeVisible({ timeout: 15_000 })
  await expect(wall(window).locator('[data-testid="signin-close"]'), 'an outage reopened the close button').toHaveCount(0)

  // The wrong password does not get in.
  await wall(window).locator('[data-testid="signin-password"]').fill('not-the-password')
  await offline.click()
  await expect(wall(window)).toContainText('not the password last used to sign in on this computer', { timeout: 10_000 })
  await expect(window.locator('[data-testid="signed-out-screen"]')).toBeVisible()
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toHaveCount(0)

  // The right one does.
  await wall(window).locator('[data-testid="signin-password"]').fill('a-long-enough-password')
  await offline.click()
  await expect(wall(window), 'the right password did not let them in offline').toHaveCount(0, { timeout: 10_000 })
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 10_000 })
})

test('AE-4 nothing of the workspace is drawn, or reachable, before someone signs in', async () => {
  // The sign-in used to sit over the workspace on a see-through scrim: every
  // desk name was there to read, and the app's shortcuts still reached it.
  dir = mkdtempSync(join(tmpdir(), 'plexii-locked-'))
  launched = await launchApp({ userDataDir: dir, env: REQUIRE })
  const { window } = launched
  await waitForReady(window, { dismissModals: false })
  // A desk with a name nobody signed out should be able to read.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Confidential pipeline desk' })
  })
  await window.reload()
  await waitForReady(window, { dismissModals: false })
  await expect(wall(window)).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="signed-out-screen"]')).toBeVisible()
  await expect(window.getByText('Confidential pipeline desk')).toHaveCount(0)
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toHaveCount(0)
  await expect(window.locator('[data-widget-id]')).toHaveCount(0)
  // The command centre's shortcut reaches nothing.
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await window.waitForTimeout(500)
  await expect(window.getByText('Confidential pipeline desk')).toHaveCount(0)
  await expect(wall(window)).toBeVisible()
})
