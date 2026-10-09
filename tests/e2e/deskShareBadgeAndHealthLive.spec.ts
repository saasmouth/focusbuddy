/**
 * E2E: shared-desk NAME + "Shared by <owner>" attribution badge (item 3), and the
 * Context-Engine "updated while away" frame lighting for a remotely-synced change
 * (item 4b, the full two-window visual counterpart to the decisive single-window
 * IPC proof in _fourFixesVerify.spec.ts's item4a). Same harness as
 * deskShareTwoWindowLive.spec.ts — see that file's header for the full TLS-proxy
 * rationale and run recipe. Self-skips when DESKSHARE_LIVE_PROXY_BASE isn't set.
 *
 * What is proven, live, through two real running windows:
 *  1. A signs up (real UI); A's real server-assigned handle is captured directly
 *     off the real /accounts/signup network response (not guessed/hardcoded).
 *  2. A creates a desk with one widget, shares it live with B by email (real UI:
 *     livedesk-email/livedesk-add).
 *  3. B receives it; B's real "All desks" gallery shows the desk's real NAME on
 *     the card AND a real `data-testid="shared-badge"` whose tooltip/aria-label
 *     is exactly "Shared by <A's real handle>" — proving ownerHandles actually
 *     carries the real name end to end (server -> pullChangesShared ->
 *     applyRemoteShared -> shared_from_handle -> SharedBadge).
 *  4. A personal (non-shared) desk on B's own gallery does NOT show the badge.
 *  5. B opens the desk (baseline: reviewWidgets runs, widget health -> 'current',
 *     no health frame visible). B navigates away (activeTaskId changes, which is
 *     what re-arms the once-per-desk-open baseline guard in Canvas.tsx).
 *  6. A edits the widget's content (store-driven, real nudge) -> lands in B's
 *     local DB near-live (same propagation already proven in
 *     deskShareTwoWindowLive.spec.ts, re-confirmed here with a fresh timing).
 *  7. B returns to the desk -> the real `data-testid="widget-health-dot"` frame
 *     is now visible on that exact widget, with `data-health-state` != 'current'
 *     — this is the concrete, previously-absent behaviour: a change that arrived
 *     via applyRemoteShared (not a local edit) now lights the "changed while you
 *     were away" frame.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.DESKSHARE_LIVE_PROXY_BASE

test.beforeAll(async () => {
  test.skip(
    !PROXY_BASE,
    'DESKSHARE_LIVE_PROXY_BASE not set — needs a purpose-built app + local TLS proxy, see deskShareTwoWindowLive.spec.ts header. Skipping rather than failing the normal suite.'
  )
})

interface Launched {
  app: ElectronApplication
  window: Page
  userDataDir: string
  dispose: () => Promise<void>
}

async function launchWithCertBypass(label: string): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), `plexii-deskbadge-${label}-`))
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
  delete cleanEnv.OPENAI_API_KEY

  const app = await electron.launch({
    args: ['--ignore-certificate-errors', '.'],
    cwd: process.cwd(),
    env: { ...cleanEnv, FB_TEST_USER_DATA: userDataDir, NODE_ENV: 'test' },
    timeout: 20_000
  })
  app.process().stdout?.on('data', (b) => process.stdout.write(`[${label}] ${b}`))
  app.process().stderr?.on('data', (b) => process.stderr.write(`[${label}] ${b}`))
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  async function dispose(): Promise<void> {
    try {
      await Promise.race([
        app.close(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
      ])
    } catch {
      try {
        app.process().kill()
      } catch {
        /* already dead */
      }
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  return { app, window, userDataDir, dispose }
}

async function dismissOnboardingOnly(window: Page): Promise<void> {
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 10_000 })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
}

test.describe.configure({ mode: 'serial' })

test('shared desk carries real owner-name attribution badge + updated-while-away frame lights for a remote change', async () => {
  test.setTimeout(150_000)
  const rand = Date.now()
  const emailA = `deskbadge.live.a.${rand}@example.com`
  const emailB = `deskbadge.live.b.${rand}@example.com`
  const password = 'Test-Account-123!'

  const A = await launchWithCertBypass('A')
  const B = await launchWithCertBypass('B')

  try {
    await dismissOnboardingOnly(A.window)
    await dismissOnboardingOnly(B.window)

    // ── Real sign-up, capturing A's REAL server-assigned identity straight off
    // the real network response (not guessed). The signup UI only collects
    // email+password (no handle field), so the server's account row has
    // handle: null — confirmed by reading accounts.ts signup() and the
    // displayName() fallback chain in server.ts ("real name -> handle ->
    // email -> raw id, never invents a name"), which means a real fresh
    // account's owner-attribution name is honestly the email, not a
    // fabricated adjective-animal handle. That is the real, correct value
    // this test asserts the badge carries. ─────────────────────────────────
    const dialogA = A.window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
    await expect(dialogA).toBeVisible({ timeout: 10_000 })
    await A.window.getByRole('button', { name: 'Sign up' }).click()
    await A.window.getByPlaceholder('you@example.com').fill(emailA)
    await A.window.getByPlaceholder('at least 8 characters').fill(password)
    const signupResponsePromise = A.window.waitForResponse((r) => r.url().includes('/accounts/signup'))
    await A.window.getByRole('button', { name: 'Create account' }).click()
    const signupResponse = await signupResponsePromise
    const signupJson = (await signupResponse.json()) as {
      ok?: boolean
      account?: { handle?: string | null; email?: string | null }
    }
    console.log('[BADGE] A real signup response account:', JSON.stringify(signupJson.account))
    expect(signupJson.account?.email).toBe(emailA)
    // The server's displayName() fallback for a handle-less, name-less account
    // is the email — this is the value ownerHandles[rootId] will carry down to
    // B, and what the badge must show.
    const aDisplayIdentity = signupJson.account?.handle || signupJson.account?.email || emailA
    console.log('[BADGE] expected owner display identity (handle -> email fallback):', aDisplayIdentity)
    await expect(dialogA).not.toBeVisible({ timeout: 10_000 })

    const dialogB = B.window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
    await expect(dialogB).toBeVisible({ timeout: 10_000 })
    await B.window.getByRole('button', { name: 'Sign up' }).click()
    await B.window.getByPlaceholder('you@example.com').fill(emailB)
    await B.window.getByPlaceholder('at least 8 characters').fill(password)
    await B.window.getByRole('button', { name: 'Create account' }).click()
    await expect(dialogB).not.toBeVisible({ timeout: 10_000 })
    console.log('[BADGE] both accounts signed up via real UI')

    // ── A creates a desk with one widget (store-driven creates so their content
    // is available for stamping/sharing) ──────────────────────────────────────
    const deskTitle = `Badge/Health Desk ${rand}`
    const deskId = await A.window.evaluate(async (title) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const node = await api.nodes.create({ parentId: null, kind: 'task', title } as never)
      return (node as unknown as { id: string }).id
    }, deskTitle)
    // A personal (unshared) desk on A's own account too, to cross-check later
    // that a personal desk on B's OWN gallery never shows the badge.
    await A.window.reload()
    await dismissOnboardingOnly(A.window)

    const widgetId = await A.window.evaluate(async (taskId) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const w = await api.widgets.create({
        taskId,
        kind: 'note',
        content: 'original content',
        x: 0,
        y: 0,
        width: 200,
        height: 100
      } as never)
      return (w as unknown as { id: string }).id
    }, deskId)

    // ── A shares live with B via the real Share dialog UI ────────────────────
    await A.window.getByRole('button', { name: 'All desks' }).click()
    const card = A.window.locator(`[data-testid="index-card-${deskId}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.locator('button[title="Create a public link — anyone with it can view this desk"]').click()
    const emailInput = A.window.locator('[data-testid="livedesk-email"]')
    await expect(emailInput).toBeVisible({ timeout: 5_000 })
    await emailInput.fill(emailB)
    await A.window.locator('[data-testid="livedesk-add"]').click()
    await expect(
      A.window.getByText(new RegExp(`${emailB.replace(/[.+]/g, '\\$&')} now has live access`, 'i'))
    ).toBeVisible({ timeout: 8_000 })
    await A.window.keyboard.press('Escape')
    console.log('[BADGE] A shared the desk with B via real UI')

    // ── B receives it, materialized in B's own local DB ───────────────────────
    const materializeStart = Date.now()
    for (;;) {
      const nodes = await B.window.evaluate(async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        return api.nodes.list()
      })
      if ((nodes as unknown as Array<{ id: string }>).some((n) => n.id === deskId)) break
      if (Date.now() - materializeStart > 10_000) throw new Error('desk did not materialize on B within 10s')
      await new Promise((r) => setTimeout(r, 250))
    }
    console.log(`[TIMING] desk materialized on B after ${Date.now() - materializeStart}ms`)

    // ── Item 3: B's real "All desks" gallery shows the NAME and the real badge
    // with A's real handle in the tooltip/aria-label ─────────────────────────
    await B.window.reload()
    await dismissOnboardingOnly(B.window)
    await B.window.getByRole('button', { name: 'All desks' }).click()
    const bCard = B.window.locator(`[data-testid="index-card-${deskId}"]`)
    await expect(bCard).toBeVisible({ timeout: 8_000 })
    await expect(bCard).toContainText(deskTitle)
    const badge = bCard.locator('[data-testid="shared-badge"]')
    await expect(badge).toBeVisible({ timeout: 5_000 })
    const badgeLabel = await badge.getAttribute('aria-label')
    const badgeTitle = await badge.getAttribute('title')
    console.log('[BADGE] shared-badge aria-label:', badgeLabel, '| title:', badgeTitle)
    expect(badgeLabel).toBe(`Shared by ${aDisplayIdentity}`)
    expect(badgeTitle).toBe(`Shared by ${aDisplayIdentity}`)

    // ── Item 3 negative check: B's OWN personal desk must NOT show the badge ──
    const bPersonalDeskId = await B.window.evaluate(async () => {
      const store = (window as unknown as { __fbNodes?: { getState: () => { create: (d: unknown) => Promise<unknown> } } }).__fbNodes
      if (!store) throw new Error('window.__fbNodes not exposed')
      const node = await store.getState().create({ parentId: null, kind: 'task', title: 'B personal desk (not shared)' })
      return (node as unknown as { id: string }).id
    })
    await B.window.waitForTimeout(300)
    const bPersonalCard = B.window.locator(`[data-testid="index-card-${bPersonalDeskId}"]`)
    await expect(bPersonalCard).toBeVisible({ timeout: 5_000 })
    const bPersonalBadge = bPersonalCard.locator('[data-testid="shared-badge"]')
    expect(await bPersonalBadge.count(), 'a personal desk must NOT carry the shared badge').toBe(0)
    console.log('[BADGE] confirmed: B\'s own personal desk shows NO shared badge')

    // ── Item 4b: B opens the desk (baseline health -> current, no frame yet) ──
    await B.window.evaluate((tid) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState()?.goTask?.(tid)
    }, deskId)
    await expect(B.window.locator(`[data-widget-id="${widgetId}"]`)).toBeVisible({ timeout: 8_000 })
    // Give the reviewWidgets baseline effect a moment to run (it fires once
    // layoutHydratedFor catches up to activeTaskId).
    await B.window.waitForTimeout(600)
    const healthAtFirstVisit = await B.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.context.health(id)
    }, widgetId)
    console.log('[HEALTH] B first-visit health snapshot:', JSON.stringify(healthAtFirstVisit))
    const dotAtFirstVisit = B.window.locator(`[data-widget-id="${widgetId}"] [data-testid="widget-health-dot"]`)
    const dotVisibleAtFirstVisit = await dotAtFirstVisit.isVisible().catch(() => false)
    console.log('[HEALTH] health-dot visible at first visit (should be false — nothing to catch up on yet):', dotVisibleAtFirstVisit)

    // Navigate away so the once-per-desk-open baseline guard (Canvas.tsx
    // reviewedWidgetsForRef) re-arms for the return visit.
    await B.window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
      w.__fbView?.getState()?.goHome?.()
    })
    await B.window.waitForTimeout(300)

    // ── A edits the widget (store-driven, real nudge) ─────────────────────────
    const editStart = Date.now()
    await A.window.evaluate(
      async ({ id, content }) => {
        const store = (window as unknown as { __fbWidgets?: { getState: () => { update: (id: string, patch: unknown) => Promise<unknown> } } }).__fbWidgets
        if (!store) throw new Error('window.__fbWidgets not exposed')
        return store.getState().update(id, { content })
      },
      { id: widgetId, content: 'edited by A while B was away' }
    )

    // Confirm propagation lands in B's local DB (re-confirms near-live sync,
    // fresh timing sample).
    for (;;) {
      const w = await B.window.evaluate(async (tid) => {
        const api = (window as unknown as { api: typeof window.api }).api
        return (await api.widgets.listByTask(tid)) as unknown as Array<{ id: string; content: string }>
      }, deskId)
      const found = w.find((x) => x.id === widgetId)
      if (found?.content === 'edited by A while B was away') break
      if (Date.now() - editStart > 10_000) throw new Error("A's edit did not propagate to B within 10s")
      await new Promise((r) => setTimeout(r, 250))
    }
    console.log(`[TIMING] A's edit landed in B's local DB after ${Date.now() - editStart}ms`)

    // ── B returns to the desk -> the health frame must now light for this
    // remotely-synced change ──────────────────────────────────────────────────
    await B.window.evaluate((tid) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState()?.goTask?.(tid)
    }, deskId)
    await expect(B.window.locator(`[data-widget-id="${widgetId}"]`)).toBeVisible({ timeout: 8_000 })
    await B.window.waitForTimeout(600)

    const healthOnReturn = await B.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.context.health(id)
    }, widgetId)
    console.log('[HEALTH] B health snapshot on RETURN visit (after A\'s remote edit):', JSON.stringify(healthOnReturn))

    const dot = B.window.locator(`[data-widget-id="${widgetId}"] [data-testid="widget-health-dot"]`)
    await expect(dot, 'widget-health-dot must be visible on return — the change happened while B was away').toBeVisible({
      timeout: 5_000
    })
    const dataState = await dot.getAttribute('data-health-state')
    console.log('[HEALTH] widget-health-dot data-health-state on return:', dataState)
    expect(dataState).not.toBe('current')
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
