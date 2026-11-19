/**
 * Share credit, end to end, against a REAL signal server (4.3.52).
 *
 *   SC-1  Signed in as A, the share sheet says what a share earns. A shares a
 *         desk ("Launch plan") with an address that has no account yet. When
 *         that person joins and verifies, the server credits A and pushes
 *         creditEarned: the card appears live (with its shimmer), naming the
 *         person and the desk (the desk's name reached the server as
 *         rootTitle), the amount and the new balance.
 *   SC-2  The notice stays until dismissed: a fresh launch signed in as A
 *         lists it (GET /account/notices) and shows it, without the shimmer.
 *         Dismissing it marks it seen on the server: its list is then empty.
 *
 * Opt-in (the _ prefix): it needs fe's server demo running, with its stdin fed
 * from a file this spec appends to, behind the repo's TLS proxy, and an out/
 * built against that proxy (memory: live-e2e-against-a-real-signal-server):
 *
 *   cd <ecosystem>/focusbuddy-signal && npm run build
 *   touch $IN && tail -f $IN | PORT=3099 node scripts/share-credit-demo.mjs --invitee $INVITEE &
 *   node tests/e2e/support/tls-proxy.js 3098 3099 &
 *   VITE_USE_REMOTE_SIGNAL=true VITE_SIGNAL_HTTP_URL=https://localhost:3098 \
 *     VITE_SIGNAL_WS_URL=wss://localhost:3098/ws npm run build
 *   SHARE_CREDIT_DEMO_INPUT=$IN SHARE_CREDIT_INVITEE=$INVITEE \
 *     SHARE_CREDIT_HTTP=http://127.0.0.1:3099 npx playwright test _shareCreditLive
 *
 * Rebuild out/ against production afterwards.
 */
import { test, expect, type Page } from '@playwright/test'
import { appendFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ElectronApplication } from '@playwright/test'
import { launchGuarded } from './_netGuard'
import { stagePersonByEmail } from './_liveShareHelpers'

const INPUT = process.env.SHARE_CREDIT_DEMO_INPUT ?? ''
const INVITEE = process.env.SHARE_CREDIT_INVITEE ?? ''
const HTTP = process.env.SHARE_CREDIT_HTTP ?? ''
// fe's demo creates the earner with these (scripts/share-credit-demo.mjs).
const A = { email: 'earner@credit-demo.test', password: 'credit-demo-1234' }
const DESK = 'Launch plan'

test.skip(!INPUT || !INVITEE || !HTTP, 'needs the share-credit demo server: see the header')
test.describe.configure({ mode: 'serial' })

interface Launched {
  app: ElectronApplication
  window: Page
  dispose: () => Promise<void>
}

async function launch(label: string): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), `plexii-sharecredit-${label}-`))
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ANTHROPIC_API_KEY
  delete env.OPENAI_API_KEY
  const { app } = await launchGuarded({
    args: ['--ignore-certificate-errors', '.'],
    cwd: process.cwd(),
    env: { ...env, FB_TEST_USER_DATA: userDataDir, NODE_ENV: 'test' },
    timeout: 20_000
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return {
    app,
    window,
    dispose: async () => {
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5_000))]).catch(() => undefined)
      try {
        app.process().kill()
      } catch {
        /* already gone */
      }
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}

/**
 * The welcome onboarding and "Verify your email" each land a beat later, in
 * either order, one over the other: clear whichever is on top until neither is.
 */
async function clearOverlays(window: Page): Promise<void> {
  const skip = window.getByRole('button', { name: 'Skip for now', exact: true })
  const later = window.getByRole('button', { name: 'Later', exact: true })
  for (let i = 0; i < 8; i++) {
    await window.waitForTimeout(700)
    const open = [(await later.isVisible().catch(() => false)) && later, (await skip.isVisible().catch(() => false)) && skip].filter(Boolean)
    if (!open.length && (await window.locator('.fb-scrim').count()) === 0) break
    for (const b of open) await (b as typeof later).click({ timeout: 2_000 }).catch(() => undefined)
  }
  await expect(window.locator('.fb-scrim')).toHaveCount(0, { timeout: 5_000 })
}

/** Sign in as A through the launch modal, and clear anything stacked after it. */
async function signInAsA(window: Page): Promise<void> {
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, { timeout: 10_000 })
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 15_000 })
  // The harness may run without an account, so the modal is opened on demand,
  // as Settings › Sign in does (stores/signInPrompt.ts).
  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  if (!(await dialog.isVisible().catch(() => false))) {
    await window.evaluate(() => {
      ;(window as unknown as { __fbSignInPrompt: { getState: () => { requestOpen: () => void } } }).__fbSignInPrompt.getState().requestOpen()
    })
  }
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await window.screenshot({ path: test.info().outputPath('signin-opened.png') })
  // The mode switch at the top: Log in, not Sign up.
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click()
  await dialog.getByPlaceholder('you@example.com').fill(A.email)
  await dialog.locator('[data-testid="signin-password"]').fill(A.password)
  await window.screenshot({ path: test.info().outputPath('signin-filled.png') })
  await dialog.locator('[data-testid="signin-password"]').press('Enter')
  await expect(dialog).not.toBeVisible({ timeout: 15_000 })
  await clearOverlays(window)
  await window.screenshot({ path: test.info().outputPath('after-signin.png') })
  await expect(window.locator('.fb-scrim')).toHaveCount(0, { timeout: 5_000 })
}

async function unseenNotices(): Promise<unknown[]> {
  const login = await fetch(`${HTTP}/accounts/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: A.email, password: A.password, deviceId: 'share-credit-live-spec' })
  })
  const { sessionToken: token } = (await login.json()) as { sessionToken?: string }
  expect(token, 'A signs in over HTTP').toBeTruthy()
  const res = await fetch(`${HTTP}/account/notices`, { headers: { Authorization: `Bearer ${token}` } })
  return ((await res.json()) as { notices: unknown[] }).notices
}

test('SC-1 a desk shared with someone new: they join, and the credit is celebrated live', async () => {
  test.setTimeout(180_000)
  const l = await launch('live')
  try {
    const { window } = l
    await signInAsA(window)
    // A desk named "Launch plan", opened.
    const deskId = await window.evaluate(async (title) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return (await api.nodes.create({ parentId: null, kind: 'task', title })).id
    }, DESK)
    await window.reload()
    await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 15_000 })
    await clearOverlays(window)
    await window.locator('[data-testid="desk-sidebar"]').getByRole('button', { name: 'All desks', exact: true }).click()
    const card = window.locator(`[data-testid="index-card-${deskId}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.locator('button[title="Create a public link — anyone with it can view this desk"]').click()
    // The sheet says what a share can earn.
    await expect(window.locator('[data-testid="share-credit-line"]')).toContainText('Share with someone new: you get US$5 credit when they join.')
    await stagePersonByEmail(window, INVITEE)
    await window.locator('[data-testid="share-picker-submit"]').click()
    await expect(window.getByText('Shared with 1 person.')).toBeVisible({ timeout: 10_000 })
    await window.keyboard.press('Escape')
    // The person joins and verifies (fe's demo, released by this line).
    appendFileSync(INPUT, '\n')
    const credit = window.locator('[data-testid="credit-earned-card"]')
    await expect(credit).toBeVisible({ timeout: 30_000 })
    await expect(credit.locator('[data-testid="credit-earned-amount"]')).toHaveText('US$5')
    await expect(credit.locator('[data-testid="credit-earned-text"]')).toHaveText(`Bea Joiner joined Plexii from your invite to “${DESK}”.`)
    await expect(credit.locator('[data-testid="credit-earned-balance"]')).toHaveText('Your Plexii credit is now US$5.')
    await expect(credit).toHaveClass(/fb-credit-shimmer/)
    await credit.screenshot({ path: test.info().outputPath('credit-earned-card-live.png') })
    await window.screenshot({ path: test.info().outputPath('credit-earned-window-live.png') })
  } finally {
    await l.dispose()
  }
})

test('SC-2 the notice waits for the next launch, and dismissing it marks it seen', async () => {
  test.setTimeout(120_000)
  expect(await unseenNotices()).toHaveLength(1)
  const l = await launch('relaunch')
  try {
    const { window } = l
    await signInAsA(window)
    const credit = window.locator('[data-testid="credit-earned-card"]')
    await expect(credit).toBeVisible({ timeout: 20_000 })
    await expect(credit.locator('[data-testid="credit-earned-text"]')).toHaveText(`Bea Joiner joined Plexii from your invite to “${DESK}”.`)
    await expect(credit).not.toHaveClass(/fb-credit-shimmer/)
    await credit.locator('[data-testid="credit-earned-dismiss"]').click()
    await expect(credit).toHaveCount(0)
    await expect.poll(unseenNotices, { timeout: 10_000 }).toEqual([])
  } finally {
    await l.dispose()
  }
})
