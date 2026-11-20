/**
 * A haptyx://auth?token= link signs Plexii in silently ONLY when this app
 * started that sign-in (security, 2026-11-20; 1a's finding, d0's brief).
 *
 * The website and SSO hand a full session token back in that URL, and any page
 * can open such a link. Adopted with no question, a link from someone else
 * signs the victim's Plexii into the sender's account (session fixation). So:
 *
 *   ALG-1  A cold launch from a link the app did not start: nothing is adopted.
 *          Plexii asks, naming the account the SERVER says the token belongs to
 *          (never the email the link claims), and Cancel is the default: Enter
 *          signs nobody in.
 *   ALG-2  The same for a link that arrives while Plexii is open, through
 *          main's real open-url handler. "Sign in" then signs in.
 *   ALG-3  A sign-in this app started (SSO here) carries a one-time state in
 *          the URL it opens; the link that comes back with that state signs in
 *          without a question.
 *   ALG-4  That state works once: the same link again, or a made-up state, is
 *          asked about.
 *
 * /accounts/me is answered by the spec from before the first window, and
 * shell.openExternal is recorded in main, so no browser opens and nothing
 * reaches the real server.
 */
import { test, expect, type Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { ACTIVE } from '../../src/shared/productDomains'

const API = new URL(ACTIVE.api)

const SENDER = {
  id: 'acct-sender', email: 'sender@evil.test', handle: null, firstName: 'Sam', lastName: 'Sender',
  createdAt: 0, lastLoginAt: null, emailVerified: true
}
const CLAIMED = 'victim@example.test'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

/**
 * The server knows every token as SENDER's; returns the tokens it was asked
 * about. Everything else a signed-in app asks is answered inconclusively (404,
 * which never signs anyone out) and its socket stays quiet, so nothing reaches
 * the real server. Registered first, so /accounts/me below wins.
 */
async function serverKnowsSender(app: ElectronApplication): Promise<string[]> {
  const asked: string[] = []
  const ctx = app.context()
  await ctx.route((u) => u.origin === API.origin, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Not here in this test.' }) })
  )
  await ctx.routeWebSocket((u) => u.host === API.host, () => undefined)
  await ctx.route((u) => u.origin === API.origin && u.pathname === '/accounts/me', async (route) => {
    asked.push((route.request().headers()['authorization'] ?? '').replace(/^Bearer /, ''))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, account: SENDER }) })
  })
  return asked
}

const sessionToken = (window: Page): Promise<string | null> =>
  window.evaluate(() => (window as unknown as { __fbAccount: { getState: () => { sessionToken: string | null } } }).__fbAccount.getState().sessionToken)

/** Deliver a link the way macOS does to a running app: main's own open-url handler. */
async function openLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: a }, u) => {
    a.emit('open-url', { preventDefault: () => undefined }, u)
  }, url)
}

const prompt = (window: Page) => window.locator('[data-testid="prompt-dialog"]')

test('ALG-1 a cold launch from a link Plexii did not start asks, names the real account, and Cancel is the default', async () => {
  launched = await launchApp({
    extraArgs: [`haptyx://auth?token=cold-session-token&email=${encodeURIComponent(CLAIMED)}`],
    beforeFirstWindow: async (app) => void (await serverKnowsSender(app))
  })
  const { window } = launched
  await expect(prompt(window)).toBeVisible({ timeout: 15_000 })
  await expect(prompt(window)).toContainText(`Sign in to Plexii as ${SENDER.email}?`)
  await expect(prompt(window)).not.toContainText(CLAIMED)
  expect(await sessionToken(window), 'nothing adopted before an answer').toBeNull()
  // Cancel is the default: Enter answers no.
  await expect(prompt(window).getByRole('button', { name: 'Cancel' })).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(prompt(window)).toBeHidden({ timeout: 3_000 })
  await window.waitForTimeout(500)
  expect(await sessionToken(window), 'Enter signed nobody in').toBeNull()
})

test('ALG-2 a link arriving while Plexii is open asks the same way, and "Sign in" signs in', async () => {
  let asked: string[] = []
  launched = await launchApp({ beforeFirstWindow: async (app) => void (asked = await serverKnowsSender(app)) })
  const { app, window } = launched
  await waitForReady(window)
  await openLink(app, `haptyx://auth?token=live-session-token&email=${encodeURIComponent(CLAIMED)}`)
  await expect(prompt(window)).toBeVisible({ timeout: 10_000 })
  await expect(prompt(window)).toContainText(`Sign in to Plexii as ${SENDER.email}?`)
  await expect(prompt(window)).not.toContainText(CLAIMED)
  expect(await sessionToken(window)).toBeNull()
  await prompt(window).getByRole('button', { name: 'Sign in' }).click()
  await expect.poll(() => sessionToken(window), { timeout: 10_000 }).toBe('live-session-token')
  expect(asked).toContain('live-session-token')
})

test('ALG-3 a sign-in Plexii started comes back with its one-time state and signs in without a question', async () => {
  launched = await launchApp({ beforeFirstWindow: async (app) => void (await serverKnowsSender(app)) })
  const { app, window } = launched
  await waitForReady(window)
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = async (u: string) => void g.__opened.push(u)
  })
  // Settings › Sign in, then "Sign in with SSO" for a work address.
  await window.evaluate(() => (window as unknown as { __fbSignInPrompt: { getState: () => { requestOpen: () => void } } }).__fbSignInPrompt.getState().requestOpen())
  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click()
  await dialog.getByPlaceholder('you@example.com').fill('pat@corp.test')
  await dialog.locator('[data-testid="signin-sso"]').click()
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.length), { timeout: 5_000 }).toBe(1)
  const opened = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened[0])
  const state = new URL(opened).searchParams.get('state')
  expect(state, `the SSO start URL carries a one-time state: ${opened}`).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  await openLink(app, `haptyx://auth?token=sso-session-token&state=${state}`)
  await expect.poll(() => sessionToken(window), { timeout: 10_000 }).toBe('sso-session-token')
  await expect(prompt(window)).toHaveCount(0)
})

test('ALG-4 the state works once: the same link again, or a made-up state, is asked about', async () => {
  launched = await launchApp({ beforeFirstWindow: async (app) => void (await serverKnowsSender(app)) })
  const { app, window } = launched
  await waitForReady(window)
  const { state } = await window.evaluate(() => (window as unknown as { api: { auth: { beginSignIn: () => Promise<{ state: string }> } } }).api.auth.beginSignIn())
  await openLink(app, `haptyx://auth?token=first-session-token&state=${state}`)
  await expect.poll(() => sessionToken(window), { timeout: 10_000 }).toBe('first-session-token')
  for (const [token, st] of [['replayed-session-token', state], ['madeup-session-token', 'not-a-state-this-app-made-0000']]) {
    await openLink(app, `haptyx://auth?token=${token}&state=${st}`)
    await expect(prompt(window)).toBeVisible({ timeout: 10_000 })
    await expect(prompt(window)).toContainText(`Sign in to Plexii as ${SENDER.email}?`)
    await prompt(window).getByRole('button', { name: 'Cancel' }).click()
    await expect(prompt(window)).toBeHidden({ timeout: 3_000 })
    expect(await sessionToken(window), `${token} was not adopted`).toBe('first-session-token')
  }
})
