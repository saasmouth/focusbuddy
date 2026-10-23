/**
 * ONE-OFF live verification of "a real name is required" (4.3.41), through the
 * REAL app against a REAL signal server carrying the requirement.
 *
 * Same harness constraint as _commentAnchorsLive.spec.ts: the app's CSP refuses
 * plain http, so the local server sits behind the repo's TLS proxy and the app
 * is BUILT pointing at it. Self-skips without ACCOUNT_NAMES_LIVE_BASE, and is
 * `_`-prefixed so `npm run test:e2e` excludes it.
 *
 *   cd ../signal-fix/focusbuddy-signal && git checkout signal-require-names
 *   npm run build && PORT=8799 DB_PATH=./data-test/names-e2e.db node dist/server.js &
 *   node tests/e2e/support/tls-proxy.js 8798 8799 &
 *   VITE_USE_REMOTE_SIGNAL=true VITE_SIGNAL_HTTP_URL=https://localhost:8798 \
 *     VITE_SIGNAL_WS_URL=wss://localhost:8798/ws npm run build
 *   ACCOUNT_NAMES_LIVE_BASE=https://localhost:8798 \
 *     ACCOUNT_NAMES_LIVE_API=http://localhost:8799 \
 *     ACCOUNT_NAMES_LIVE_DB=../signal-fix/focusbuddy-signal/data-test/names-e2e.db \
 *     npx playwright test tests/e2e/_accountNamesLive.spec.ts
 *
 *
 * ONE AT A TIME. Signup is rate-limited per IP (five a minute), and the live
 * specs share that budget — running this back-to-back with the other one
 * exhausts it and fails in a way that looks like a product fault: the sign-up
 * response never arrives and the modal is simply gone from the page snapshot.
 * Leave a minute between them.
 * NEVER against production: it creates accounts and writes to the database.
 */
import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { launchApp, type LaunchedApp } from './_helpers'

const BASE = process.env.ACCOUNT_NAMES_LIVE_BASE
// This PROCESS talks to the server directly: the proxy exists only for the
// renderer's CSP, and going direct avoids teaching a file that holds account
// tokens to skip certificate checks.
const API = process.env.ACCOUNT_NAMES_LIVE_API ?? 'http://localhost:8799'
const DB = process.env.ACCOUNT_NAMES_LIVE_DB
const SHOTS = 'tests/e2e/__screenshots__/account-names-live'

let A: LaunchedApp | null = null

test.afterEach(async () => {
  if (A) await A.dispose()
  A = null
})

/** Past first-run onboarding WITHOUT dismissing the sign-in modal. */
async function dismissOnboardingOnly(window: Page): Promise<void> {
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 15_000
  })
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 15_000 })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
}

const dismissVerifyEmail = async (w: Page): Promise<void> => {
  const verify = w.locator('[role="dialog"]').filter({ hasText: 'Verify your email' })
  if (await verify.isVisible().catch(() => false)) {
    await verify.getByRole('button', { name: 'Later' }).click()
    await expect(verify).toBeHidden({ timeout: 10_000 })
  }
}

/**
 * Wait until the only thing on screen is the dialog under test.
 *
 * "Verify your email" arrives a beat AFTER sign-in, so dismissing it once
 * immediately after submitting is a race: it had not appeared yet, the
 * assertions ran against an uncovered step, and then it mounted on top in
 * time for the screenshot. The suite was green and the evidence showed the
 * wrong dialog — `toBeVisible` does not check occlusion, so nothing failed.
 */
async function settleTo(w: Page, testid: string): Promise<void> {
  const target = w.locator(`[data-testid="${testid}"]`)
  const verify = w.locator('[role="dialog"]').filter({ hasText: 'Verify your email' })
  await expect(target).toBeVisible({ timeout: 20_000 })
  for (let i = 0; i < 10; i++) {
    if (!(await verify.isVisible().catch(() => false))) break
    await verify.getByRole('button', { name: 'Later' }).click().catch(() => {})
    await w.waitForTimeout(500)
  }
  await expect(verify, 'nothing is covering it').toBeHidden()
  await expect(target).toBeVisible()
  // One scrim: the dialog under test, with nothing stacked over it.
  await expect(w.locator('.fb-scrim')).toHaveCount(1)
}

test.describe(BASE ? 'a real name is required, live' : 'a real name is required (skipped)', () => {
  test.skip(!BASE, 'set ACCOUNT_NAMES_LIVE_BASE to a local signal proxy to run this')
  test.setTimeout(240_000)

  test('sign-up will not proceed without a first and last name', async () => {
    const stamp = Date.now().toString(36)
    A = await launchApp({ extraArgs: ['--ignore-certificate-errors'] })
    await dismissOnboardingOnly(A.window)
    const w = A.window

    const dialog = w.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await w.getByRole('button', { name: 'Sign up' }).click()
    await w.getByPlaceholder('you@example.com').fill(`named_${stamp}@example.com`)
    await w.getByPlaceholder('at least 8 characters').fill('password12345')

    // Everything filled EXCEPT the names: the button must not be offered as
    // usable. This is the screenshot of the state the requirement creates.
    const submit = w.locator('[data-testid="signin-submit"]')
    await expect(submit, 'email and password alone do not enable it').toBeDisabled()
    await expect(w.locator('[data-testid="signup-name-why"]'), 'and the reason is on screen').toContainText(
      /shown to people you share/i
    )
    await w.screenshot({ path: `${SHOTS}/01-signup-blocked-without-name.png` })

    // A first name alone is still not a name.
    await w.locator('[data-testid="signup-first-name"]').fill('Ada')
    await expect(submit, 'one name is not enough').toBeDisabled()

    await w.locator('[data-testid="signup-last-name"]').fill('Lovelace')
    await expect(submit, 'both given: now it submits').toBeEnabled()
    await w.screenshot({ path: `${SHOTS}/02-signup-enabled-with-name.png` })

    const res = w.waitForResponse((r) => r.url().includes('/accounts/signup'))
    await submit.click()
    const json = (await (await res).json()) as { ok?: boolean; account?: { firstName?: string; lastName?: string } }
    expect(json.ok, `the sign-up succeeded: ${JSON.stringify(json)}`).toBe(true)
    expect(json.account?.firstName, 'the name reached the server').toBe('Ada')
    expect(json.account?.lastName).toBe('Lovelace')
    await expect(dialog).toBeHidden({ timeout: 15_000 })
    await dismissVerifyEmail(w)
    await w.screenshot({ path: `${SHOTS}/03-signed-in-with-name.png` })
  })

  test('an OLD app, which cannot send names, gets a readable refusal', async () => {
    // The client most likely to trip the requirement has no fields to fill in.
    // It sends email and password, gets a 400, and shows this string to a
    // person — so the message has to name what is missing and the way out.
    const res = await fetch(`${API}/accounts/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `old_${Date.now().toString(36)}@example.com`, password: 'password12345' })
    })
    expect(res.status, 'refused').toBe(400)
    const json = (await res.json()) as { ok?: boolean; error?: string }
    expect(json.ok).toBe(false)
    expect(json.error, 'names what is missing').toMatch(/first name and last name/i)
    expect(json.error, 'and tells an older app what to do').toMatch(/update PlexiiDesk/i)
    expect((json.error ?? '').length, 'short enough to show in a dialog').toBeLessThan(240)
  })

  test('an existing account with no name is asked for one, and cannot skip', async () => {
    test.skip(!DB, 'set ACCOUNT_NAMES_LIVE_DB to the server database to make a legacy account')
    const stamp = Date.now().toString(36)
    const email = `legacy_${stamp}@example.com`

    // Make a LEGACY account: sign up normally (the server now requires names),
    // then clear them in the database. That is exactly what a row written
    // before this change looks like, and it is the only honest way to produce
    // one now that the API refuses to.
    // Signup is rate-limited to five a minute per IP and this file's other
    // tests spend some of that, so wait the window out rather than weakening
    // a real production limit for a test.
    const create = async (): Promise<{ status: number; json: { ok?: boolean } }> => {
      const r = await fetch(`${API}/accounts/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password12345', firstName: 'Temp', lastName: 'Name' })
      })
      return { status: r.status, json: (await r.json()) as { ok?: boolean } }
    }
    let signup = await create()
    if (signup.status === 429) {
      await new Promise((r) => setTimeout(r, 65_000))
      signup = await create()
    }
    expect(signup.json.ok, `the account was created: ${JSON.stringify(signup.json)}`).toBe(true)
    execFileSync('sqlite3', [DB!, `UPDATE accounts SET first_name = NULL, last_name = NULL WHERE email = '${email}'`])

    A = await launchApp({ extraArgs: ['--ignore-certificate-errors'] })
    await dismissOnboardingOnly(A.window)
    const w = A.window
    const dialog = w.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await w.getByRole('button', { name: 'Log in' }).click()
    await w.getByPlaceholder('you@example.com').fill(email)
    // The password placeholder is mode-dependent — 'at least 8 characters'
    // when signing up, 'your password' when logging in. Using the sign-up one
    // here waited thirty seconds for a field that was on screen the whole time
    // under a different name.
    await w.getByPlaceholder('your password').fill('password12345')
    await w.locator('[data-testid="signin-submit"]').click()

    // The step, with nothing stacked over it.
    const step = w.locator('[data-testid="add-your-name"]')
    await settleTo(w, 'add-your-name')
    await expect(w.locator('[data-testid="add-your-name-why"]')).toContainText(/know who commented/i)
    const save = w.locator('[data-testid="add-name-save"]')
    await expect(save, 'and cannot be satisfied empty').toBeDisabled()
    // A disabled button that LOOKS enabled is a trap: the person clicks and
    // nothing happens, with no reason given. So the dimming is asserted, not
    // just the attribute.
    const dimmed = await save.evaluate((el) => Number(getComputedStyle(el).opacity))
    expect(dimmed, `the disabled Save is visibly dimmed (opacity ${dimmed})`).toBeLessThan(0.8)
    // Required means required: the only button in it is the one that saves.
    expect(await step.getByRole('button').allTextContents()).toEqual(['Save and continue'])
    await w.screenshot({ path: `${SHOTS}/04-add-your-name-required.png` })

    // Escape must not dismiss it either.
    await w.keyboard.press('Escape')
    await expect(step, 'Escape does not get past it').toBeVisible()

    await w.locator('[data-testid="add-name-first"]').fill('Grace')
    await expect(w.locator('[data-testid="add-name-save"]'), 'one name is not enough').toBeDisabled()
    await w.locator('[data-testid="add-name-last"]').fill('Hopper')
    await w.locator('[data-testid="add-name-save"]').click()

    await expect(step, 'saved: the step lets go').toBeHidden({ timeout: 20_000 })
    await w.screenshot({ path: `${SHOTS}/05-after-adding-name.png` })

    // And it really reached the account, rather than only the screen.
    const login = await fetch(`${API}/accounts/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password12345' })
    })
    const acct = (await login.json()) as { account?: { firstName?: string; lastName?: string } }
    expect(acct.account?.firstName).toBe('Grace')
    expect(acct.account?.lastName).toBe('Hopper')
  })
})
