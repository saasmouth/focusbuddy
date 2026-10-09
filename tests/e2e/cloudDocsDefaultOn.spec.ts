// Verifies the 2026-07-08 default-on cloud-docs sync change end to end through
// the REAL built app. Self-skips unless a local signal server is reachable at
// E2E_SIGNAL_BASE (default http://localhost:8796), so the ordinary suite run is
// unaffected; start the server (plus the TLS proxy a CSP-compatible build
// points at) to exercise it. Flow:
// fresh userData (no stored flag) -> sign up through the real sign-in UI ->
// create a personal document through the real Documents UI -> the doc appears
// in the signal server's /documents store without touching the Settings
// toggle. Then unticks the toggle and proves the next document does NOT push.
//
// This build was compiled with VITE_SIGNAL_HTTP_URL pointing at a local
// TLS-terminating proxy (scratchpad/tls/proxy.js -> the real signal server)
// specifically so the app's CSP (connect-src ... https:) permits the
// renderer's real fetch() calls — the app's CSP has no bare `http:` in
// connect-src, so a plain http signal URL is blocked by design. The proxy's
// cert is self-signed, so Electron is launched with
// --ignore-certificate-errors for this spec only.

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SIGNAL_BASE = process.env.E2E_SIGNAL_BASE ?? 'http://localhost:8796'

test.beforeAll(async () => {
  const res = await fetch(`${SIGNAL_BASE}/healthz`).catch(() => null)
  test.skip(!res || !res.ok, `Local signal server not reachable at ${SIGNAL_BASE} — start it before running this spec.`)
})

let app: ElectronApplication | null = null
let window: Page | null = null
let userDataDir: string | null = null

test.afterEach(async () => {
  if (app) {
    try {
      await Promise.race([app.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))])
    } catch {
      try {
        app.process().kill()
      } catch {
        /* already dead */
      }
    }
    app = null
  }
  if (userDataDir) {
    rmSync(userDataDir, { recursive: true, force: true })
    userDataDir = null
  }
})

test('fresh profile: cloud-docs sync default-on pushes a personal doc; opt-out toggle stops it', async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'plexii-clouddocs-e2e-'))
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
  delete cleanEnv.OPENAI_API_KEY

  app = await electron.launch({
    args: ['.', '--ignore-certificate-errors'],
    cwd: process.cwd(),
    env: { ...cleanEnv, FB_TEST_USER_DATA: userDataDir, NODE_ENV: 'test' },
    timeout: 20_000
  })
  app.process().stdout?.on('data', (b) => process.stdout.write(`[main] ${b}`))
  app.process().stderr?.on('data', (b) => process.stderr.write(`[main] ${b}`))
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )

  // Dismiss first-run onboarding (fresh test DB triggers it).
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }

  // ── Confirm the default-on flag BEFORE any sign-in: no stored key yet. ──
  const storedFlagBeforeSignIn = await window.evaluate(() => localStorage.getItem('fb.clouddocs.enabled'))
  expect(storedFlagBeforeSignIn, 'fresh profile has no stored clouddocs flag').toBeNull()

  // ── Sign up through the real Sign-in modal UI. ──
  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 8_000 })
  await dialog.getByRole('button', { name: 'Sign up' }).click()

  const rand = Date.now()
  const email = `clouddocs.default.${rand}@example.com`
  const password = 'Test-Account-123!'
  await dialog.locator('input[type="email"]').fill(email)
  await dialog.locator('input[type="password"]').fill(password)
  await dialog.getByRole('button', { name: 'Create account' }).click()

  // Modal unmounts on success (account becomes populated).
  await expect(dialog).toHaveCount(0, { timeout: 10_000 })

  // ── Create a personal document via the real PlexiOffice home UI. ──
  // Signing in lands on the PlexiSuite hub; the top segment switcher's "Office"
  // button switches into the embedded PlexiOffice pane, whose "Quick actions"
  // rail has a real "New document" button wired to the same
  // useDocumentsStore().createBlank() the standalone PlexiOffice app uses.
  await window.getByRole('button', { name: 'Office', exact: true }).click()
  await expect(window.getByRole('heading', { name: 'PlexiOffice Home' })).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-qa-doc"]').click()

  // The doc editor opens; wait for the debounced save + cloud push cycle
  // (saveBody debounces 600ms then pushes; give it real margin).
  await window.waitForTimeout(1500)

  // ── Poll the REAL signal server for the pushed document. ──
  async function pollDocuments(token: string, timeoutMs: number): Promise<Array<{ id: string; title: string }>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const res = await fetch(`${SIGNAL_BASE}/documents`, { headers: { Authorization: `Bearer ${token}` } })
      const json = (await res.json()) as { ok: boolean; documents?: Array<{ id: string; title: string }> }
      if (json.ok && json.documents && json.documents.length > 0) return json.documents
      if (Date.now() > deadline) return json.documents ?? []
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  // Get the session token the app itself is using (persisted via IPC) so we
  // hit the server as the exact same account.
  const token = await window.evaluate(async () => {
    const w = window as unknown as { api: { account: { load: () => Promise<{ sessionToken: string | null }> } } }
    const cached = await w.api.account.load()
    return cached.sessionToken
  })
  expect(token, 'a session token was persisted after signup').toBeTruthy()

  const docsAfterDefault = await pollDocuments(token as string, 8_000)
  expect(docsAfterDefault.some((d) => d.title === 'Untitled document'), `default-on: doc pushed to /documents (saw: ${JSON.stringify(docsAfterDefault)})`).toBe(true)

  // ── Back to PlexiOffice Home, then go to Settings and untick the sync toggle. ──
  await window.getByRole('button', { name: 'Back to PlexiOffice' }).click()
  await expect(window.getByRole('heading', { name: 'PlexiOffice Home' })).toBeVisible({ timeout: 8_000 })
  const settingsBtn = window.getByRole('button', { name: /appearance settings/i })
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
  await settingsBtn.click()
  // The Documents-sync section lives inside the collapsed "Advanced" group.
  const advanced = window.locator('[data-testid="settings-advanced-toggle"]')
  await expect(advanced).toBeVisible({ timeout: 5_000 })
  await advanced.click()
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-clouddocs-toggle"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
  const toggle = window.locator('[data-testid="settings-clouddocs-toggle"]')
  await expect(toggle).toBeVisible({ timeout: 5_000 })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await window.keyboard.press('Escape')

  const storedFlagAfterOptOut = await window.evaluate(() => localStorage.getItem('fb.clouddocs.enabled'))
  expect(storedFlagAfterOptOut, 'opting out stores an explicit 0').toBe('0')

  // ── Create a second document; it must NOT reach the server. ──
  await expect(window.getByRole('heading', { name: 'PlexiOffice Home' })).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-qa-sheet"]').click()
  await window.waitForTimeout(1500)

  const docsAfterOptOut = await pollDocuments(token as string, 3_000)
  const sheetPushed = docsAfterOptOut.some((d) => d.title === 'Untitled spreadsheet')
  expect(sheetPushed, `opt-out: no new doc should reach /documents (saw: ${JSON.stringify(docsAfterOptOut)})`).toBe(false)

  expect(pageErrors, `no uncaught page errors: ${pageErrors.join(' | ')}`).toHaveLength(0)
})
