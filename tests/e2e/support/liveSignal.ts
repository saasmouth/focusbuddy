// Helpers for the LIVE specs that drive two app instances against a local signal
// server (see the header of crdtReplayNoDataLossLive.spec.ts for the harness).
// Copied from that spec, which keeps its own copy unchanged; new live specs
// import these.
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchGuarded } from '../_netGuard'

export const PROXY_BASE = process.env.CRDT_LIVE_PROXY_BASE
export const API_BASE = process.env.CRDT_LIVE_API_BASE

export interface Launched {
  app: ElectronApplication
  window: Page
  log: string[]
  close: () => Promise<void>
}

export async function launch(label: string, userDataDir: string): Promise<Launched> {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
  const { app } = await launchGuarded({
    args: ['--ignore-certificate-errors', '.'],
    cwd: process.cwd(),
    env: { ...cleanEnv, FB_TEST_USER_DATA: userDataDir, NODE_ENV: 'test' },
    timeout: 20_000
  })
  const log: string[] = []
  const keep = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) log.push(line)
  }
  app.process().stdout?.on('data', keep)
  app.process().stderr?.on('data', keep)
  const window = await app.firstWindow()
  // The pull's own warnings ("holding the cursor", "moving past them") are renderer
  // console lines, not main-process output.
  window.on('console', (m) => log.push(`[renderer] ${m.text()}`))
  await window.waitForLoadState('domcontentloaded')
  async function close(): Promise<void> {
    try {
      await Promise.race([app.close(), new Promise<void>((_, r) => setTimeout(() => r(new Error('t')), 8_000))])
    } catch {
      try {
        app.process().kill()
      } catch {
        /* already gone */
      }
    }
  }
  return { app, window, log, close }
}

export async function dismissOnboarding(window: Page): Promise<void> {
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

export async function clearVerifyEmail(window: Page): Promise<void> {
  // A fresh account is offered "Verify your email" a beat after sign-up, and its
  // scrim swallows clicks. "Later" dismisses it.
  const later = window.locator('[data-testid="verify-email-later"]')
  if (await later.isVisible({ timeout: 3_000 }).catch(() => false)) await later.click().catch(() => {})
}

// Close whatever modal has arrived over the app (a fresh account collects a few a
// beat after sign-up), logging each by name so a new one is easy to recognise.
export async function clearScrims(window: Page, label: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if ((await window.locator('.fb-scrim').count()) === 0) return
    const names = await window
      .locator('[role="dialog"], [role="alertdialog"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || (e.textContent ?? '').trim().slice(0, 60)))
    console.log(`[REPLAY] ${label}: closing modal ${JSON.stringify(names)}`)
    const later = window.locator('[data-testid="verify-email-later"]')
    if (await later.isVisible().catch(() => false)) await later.click().catch(() => {})
    else await window.keyboard.press('Escape')
    await window.waitForTimeout(400)
  }
  await expect(window.locator('.fb-scrim'), `${label}: a modal would not close`).toHaveCount(0)
}

export const signInDialog = (w: Page) => w.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')

export async function signUp(window: Page, email: string, password: string): Promise<void> {
  const d = signInDialog(window)
  await expect(d).toBeVisible({ timeout: 15_000 })
  await window.getByRole('button', { name: 'Sign up' }).click()
  await window.getByPlaceholder('you@example.com').fill(email)
  // Names are required at sign-up since 4.3.41.
  await window.locator('[data-testid="signup-first-name"]').fill('Replay')
  await window.locator('[data-testid="signup-last-name"]').fill('Tester')
  await window.getByPlaceholder('at least 8 characters').fill(password)
  await window.getByRole('button', { name: 'Create account' }).click()
  await expect(d).not.toBeVisible({ timeout: 15_000 })
  await clearVerifyEmail(window)
}

export async function signIn(window: Page, email: string, password: string): Promise<void> {
  const d = signInDialog(window)
  await expect(d).toBeVisible({ timeout: 15_000 })
  await d.getByRole('button', { name: 'Log in', exact: true }).first().click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder(/password|at least 8/i).first().fill(password)
  await d.locator('button[type="submit"]').click()
  await expect(d).not.toBeVisible({ timeout: 15_000 })
  await clearVerifyEmail(window)
}

export interface ServerItem {
  id: string
  itemType: string
  rev: number
  deleted: boolean
  body: Record<string, unknown> | null
}

// The server's view, read by the test process over plain http with paging, so it
// is complete whatever the page limit.
export async function serverSnapshot(token: string): Promise<Map<string, ServerItem>> {
  const out = new Map<string, ServerItem>()
  let cursor: string | null = null
  for (let guard = 0; guard < 500; guard++) {
    const qs = new URLSearchParams({ since: '0', limit: '200' })
    if (cursor) qs.set('cursor', cursor)
    const res = await fetch(`${API_BASE}/workspace/sync?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(res.ok, `GET /workspace/sync ${res.status}`).toBe(true)
    const json = (await res.json()) as { items: ServerItem[]; more?: boolean; nextCursor?: string | null }
    for (const it of json.items) out.set(it.id, it)
    if (!json.more || !json.nextCursor) return out
    cursor = json.nextCursor
  }
  throw new Error('server snapshot did not finish paging')
}

// Every server row whose rev or deleted flag moved between two snapshots.
// `labels` names the seeded items, so a failure reads "desk R" rather than a uuid.
export function serverChanges(
  before: Map<string, ServerItem>,
  after: Map<string, ServerItem>,
  labels: Map<string, string> = new Map()
): string[] {
  const out: string[] = []
  for (const [id, a] of after) {
    const b = before.get(id)
    const name = `${a.itemType} ${labels.get(id) ?? id}`
    const title = (x: ServerItem | undefined) => (x?.body as { title?: string } | null)?.title
    const retitled = b && title(b) !== title(a) ? ` title "${title(b)}"->"${title(a)}"` : ''
    if (!b) out.push(`NEW ${name} rev ${a.rev}${a.deleted ? ' (deleted)' : ''}`)
    else if (a.rev !== b.rev || a.deleted !== b.deleted)
      out.push(`${name} rev ${b.rev}->${a.rev}${b.deleted !== a.deleted ? ` deleted ${b.deleted}->${a.deleted}` : ''}${retitled}`)
  }
  return out
}

export type Api = { api: typeof window.api }

export async function pendingCount(window: Page): Promise<number> {
  return window.evaluate(async () => {
    const p = await (window as unknown as Api).api.workspaceSync.pending()
    return p.upserts.length + p.deletes.length
  })
}

export async function waitQuiet(window: Page, ms: number): Promise<void> {
  // Wait for the device's own poll pushes to land. Its CRDT events go out live
  // over the open socket as they are emitted; the local outbox only marks them
  // synced at the next (re)connect flush, so its count is not a delivery signal.
  const start = Date.now()
  for (;;) {
    const pending = await pendingCount(window)
    if (pending === 0) break
    if (Date.now() - start > ms) throw new Error(`device never went quiet: ${pending} rows still pending push`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
  await new Promise((r) => setTimeout(r, 3_000))
}

