/**
 * accountDataPanel.spec.ts — Settings > Account "Your data" and "Close and archive
 * my account", the privacy section's account sentences, and Restore at sign-in,
 * in the built app.
 *
 * Never production. The app is built against api.plexiidesk.com, so every
 * request the renderer makes there is answered by a LOCAL signal server started
 * here on a throwaway database (the request never leaves this machine), and the
 * renderer's WebSocket to that host is cancelled in the main process. Throwaway
 * profile: PLEXI_APP=preview3 and a temporary userData directory. Accounts are
 * created on the local server only.
 *
 * Two server states:
 *   - TODAY'S LIVE SERVER: the local server's serverFeatures are stripped of the
 *     new entries, as the deployed server answers. No export / close button may
 *     show; the panel says it comes with the next server update.
 *   - THE 4.3.40 SERVER: export saves a real ZIP, closing archives, signing in
 *     again offers Restore, and the restore signs in with the same account.
 *
 * Needs SIGNAL_SERVER_DIR pointing at a built focusbuddy-signal (with the
 * archive routes); skipped otherwise, with that reason.
 */

import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const SERVER_DIR = process.env.SIGNAL_SERVER_DIR ?? ''
const NEW_FEATURES = ['account_export', 'account_archive', 'account_archive_email', 'account_restore']
const PASSWORD = 'e2e-Close-Restore-7'

let server: ChildProcess | null = null
let base = ''
let dataDir = ''
let launched: LaunchedApp | null = null

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

test.skip(!SERVER_DIR || !existsSync(join(SERVER_DIR, 'dist/server.js')), 'SIGNAL_SERVER_DIR (a built focusbuddy-signal) is not set')

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'plexii-e2e-signal-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DB_PATH: join(dataDir, 'signal.db'),
    PORT: String(port),
    HOST: '127.0.0.1',
    ALLOWED_ORIGIN: '*',
    ADMIN_SEED_PASSWORD: `e2e-${Date.now()}-admin`,
    RESEND_API_KEY: '',
    STRIPE_SECRET_KEY: '',
    LOG_LEVEL: 'warn'
  }
  server = spawn(process.execPath, ['dist/server.js'], { cwd: SERVER_DIR, env, stdio: 'ignore' })
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('local signal server did not start')
})

test.afterAll(async () => {
  server?.kill()
  rmSync(dataDir, { recursive: true, force: true })
})

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function signupLocal(tag: string): Promise<string> {
  const email = `${tag}-${Date.now()}@example.test`
  const r = await fetch(`${base}/accounts/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD })
  })
  expect(r.status).toBe(200)
  // Verified, so the app opens on the workspace rather than "Verify your email"
  // (the local server sends no mail). Straight into the throwaway database.
  execFileSync('sqlite3', [join(dataDir, 'signal.db'), `UPDATE accounts SET email_verified_at = ${Date.now()} WHERE email = '${email}'`])
  return email
}

/** Answer every renderer request to the production API from the local server. */
async function routeToLocal(window: Page, opts: { stripNewFeatures: boolean }): Promise<string[]> {
  const seen: string[] = []
  await window.route(/^https:\/\/api\.plexiidesk\.com\//, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    seen.push(`${req.method()} ${url.pathname}`)
    const headers = { ...req.headers() }
    delete headers.host
    const res = await fetch(`${base}${url.pathname}${url.search}`, {
      method: req.method(),
      headers,
      body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() ?? undefined
    })
    let body = Buffer.from(await res.arrayBuffer())
    if (opts.stripNewFeatures && url.pathname === '/account/capabilities' && res.ok) {
      const json = JSON.parse(body.toString('utf8')) as { serverFeatures?: string[] }
      // The deployed server today: no export, archive or restore.
      json.serverFeatures = (json.serverFeatures ?? []).filter((f) => !NEW_FEATURES.includes(f))
      body = Buffer.from(JSON.stringify(json))
    }
    const out: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(k)) out[k] = v
    })
    out['access-control-allow-origin'] = '*'
    await route.fulfill({ status: res.status, headers: out, body })
  })
  return seen
}

async function boot(opts: { stripNewFeatures: boolean }): Promise<{ window: Page; seen: string[] }> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  const { app, window } = launched
  // Nothing from the renderer may reach the real server over a socket either.
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['wss://*/*', 'ws://*/*'] }, (details, cb) => {
      cb({ cancel: /plexiidesk\.com/.test(details.url) })
    })
  })
  const seen = await routeToLocal(window, opts)
  await waitForReady(window)
  return { window, seen }
}

async function openAccount(window: Page): Promise<void> {
  const panel = window.locator('[role="dialog"][aria-label="Settings"]').first()
  if (!(await panel.isVisible())) {
    await window.getByRole('button', { name: /appearance settings/i }).click()
    await expect(panel).toBeVisible()
  }
  await window.locator('[data-testid="settings-tab-account"]').click()
}

async function signInFromSettings(window: Page, email: string): Promise<void> {
  await openAccount(window)
  await window.locator('[data-testid="account-signin"]').click()
  const login = window.getByRole('button', { name: 'Log in', exact: true }).first()
  await login.click()
  await window.locator('input[type="email"]').fill(email)
  await window.locator('[data-testid="signin-password"]').fill(PASSWORD)
  await window.locator('[data-testid="signin-submit"]').click()
  // Signing in closes Settings (and may raise an offer card); come back to Account.
  await expect(window.locator('[data-testid="signin-submit"]')).toHaveCount(0, { timeout: 10_000 })
  await openAccount(window)
}

test('against today\'s live server: no export or close button, and it says what to do instead', async () => {
  const { window, seen } = await boot({ stripNewFeatures: true })
  const email = await signupLocal('today')
  await signInFromSettings(window, email)
  await expect(window.locator('[data-testid="account-identity"]')).toBeVisible({ timeout: 10_000 })
  await openAccount(window)
  await expect(window.locator('[data-testid="account-close-unavailable"]')).toContainText('next server update')
  await expect(window.locator('[data-testid="account-close-unavailable"]')).toContainText('connect@plexiidesk.com')
  await expect(window.locator('[data-testid="account-close-open"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="account-export-server"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="account-export-local"]')).toBeVisible()
  // Nothing new was requested of a server that does not have it.
  expect(seen.filter((s) => /\/accounts\/me\/(export|close)|\/accounts\/restore/.test(s))).toEqual([])
  // The privacy section says to email, not to press a button that is not there.
  await window.locator('[data-testid="settings-tab-data"]').click().catch(() => {})
  const yours = window.locator('[data-testid="privacy-your-data"]')
  if (await yours.count()) {
    await expect(yours).toContainText('email connect@plexiidesk.com')
    await expect(yours).not.toContainText('Account > Your data')
  }
})

test('against the 4.3.40 server: download, close and archive, then restore at sign-in', async () => {
  test.setTimeout(120_000)
  const { window, seen } = await boot({ stripNewFeatures: false })
  const email = await signupLocal('archive')
  await signInFromSettings(window, email)
  await expect(window.locator('[data-testid="account-identity"]')).toBeVisible({ timeout: 10_000 })
  await openAccount(window)

  // Download what the server holds: the save dialog is answered with a temp path.
  const zipPath = join(dataDir, 'export.zip')
  await launched!.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, zipPath)
  await window.locator('[data-testid="account-export-server"]').click()
  await expect(window.locator('[data-testid="account-export-note"]')).toContainText('Saved export.zip', { timeout: 15_000 })
  const zip = readFileSync(zipPath)
  expect(zip.subarray(0, 2).toString('latin1')).toBe('PK')
  expect(zip.includes(Buffer.from('server-data.json'))).toBe(true)

  // Close and archive.
  await window.locator('[data-testid="account-close-open"]').click()
  await expect(window.locator('[data-testid="account-close-submit"]')).toBeDisabled()
  await window.locator('[data-testid="account-close-confirm"]').fill('CLOSE')
  await window.locator('[data-testid="account-close-password"]').fill(PASSWORD)
  await window.locator('[data-testid="account-close-submit"]').click()
  await expect(window.locator('[data-testid="account-closed"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="account-closed-restore"]')).toContainText('restore it until')
  await expect(window.locator('[data-testid="account-closed-not-restorable"]')).toContainText('signed out')
  const login = await fetch(`${base}/accounts/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD })
  })
  expect(login.status).toBe(403)

  // Sign in again: the modal offers Restore, and restoring signs in.
  // Signed out by the closing, the sign-in window comes up by itself here.
  if (!(await window.locator('[data-testid="signin-submit"]').isVisible())) {
    await window.locator('[data-testid="account-signin"]').click()
  }
  await window.getByRole('button', { name: 'Log in', exact: true }).first().click()
  // Signed out with a 4.3.40 server, the public list lights the code path too.
  await expect(window.locator('[data-testid="signin-restore-start"]')).toBeVisible()
  await window.locator('input[type="email"]').fill(email)
  await window.locator('[data-testid="signin-password"]').fill(PASSWORD)
  await window.locator('[data-testid="signin-submit"]').click()
  await expect(window.locator('[data-testid="signin-archived"]')).toContainText('You can restore it until', { timeout: 10_000 })
  await expect(window.locator('[data-testid="signin-submit"]')).toHaveText('Restore my account')
  await window.locator('[data-testid="signin-submit"]').click()
  await expect(window.locator('[data-testid="signin-restored"]')).toContainText('Everything that was archived came back', { timeout: 10_000 })
  await window.locator('[data-testid="signin-restored-continue"]').click()
  await openAccount(window)
  await expect(window.locator('[data-testid="account-identity"]')).toBeVisible()
  expect(seen.some((s) => s === 'POST /accounts/restore')).toBe(true)
  const again = await fetch(`${base}/accounts/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD })
  })
  expect(again.status).toBe(200)
})
