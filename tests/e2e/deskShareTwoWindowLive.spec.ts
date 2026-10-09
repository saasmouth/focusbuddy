/**
 * E2E: per-desk LIVE SHARING (ACL-scoped, named individuals — not org membership)
 * driven through TWO REAL Electron windows, both genuinely signed in and syncing
 * over the network. Template: tests/e2e/orgSyncTwoWindowLive.spec.ts.
 *
 * HARNESS CONSTRAINT (same as the org-sync live spec, restated here): the built
 * app's CSP (`connect-src 'self' ws: wss: https:`) refuses a plain-http fetch()
 * from the renderer, so a local plain-http signal server must sit behind a
 * TLS-terminating proxy (tests/e2e/support/tls-proxy.js) and the app must be
 * BUILT with VITE_SIGNAL_HTTP_URL / VITE_SIGNAL_WS_URL pointed at that proxy.
 * Electron is launched with --ignore-certificate-errors to accept the proxy's
 * self-signed cert. This spec will NOT pass against a bundle produced by a plain
 * `npm run build` (which points at production). Run it via:
 *
 *   cd projects/focusbuddy-signal && DB_PATH=<fresh> PORT=8792 npm run build && node dist/server.js
 *   node tests/e2e/support/tls-proxy.js 8793 8792
 *   VITE_USE_REMOTE_SIGNAL=true \
 *   VITE_SIGNAL_HTTP_URL=https://localhost:8793 \
 *   VITE_SIGNAL_WS_URL=wss://localhost:8793/ws \
 *   npm run build
 *   DESKSHARE_LIVE_PROXY_BASE=https://localhost:8793 \
 *   npx playwright test tests/e2e/deskShareTwoWindowLive.spec.ts
 *
 * Self-skips (rather than fails) when DESKSHARE_LIVE_PROXY_BASE isn't set, so it
 * never runs by accident inside the ordinary `npm run test:e2e` pipeline (which
 * rebuilds against production and would make every real-network step fail).
 *
 * What is proven, live, through two real running windows:
 *  1. Two real accounts sign up through the real UI, against the real local
 *     signal server, over the real (proxied) network.
 *  2. A creates a desk (task node) — via IPC, deliberately: this spec's job is to
 *     prove the SHARE contract, not desk-creation UI, which is already covered
 *     by other specs. Labelled IPC-driven below.
 *  3. A opens the desk's real Share dialog via a real UI click (the "Create a
 *     public link" icon on its DesksView gallery card — the only UI entry point
 *     for a task-kind desk's ShareDialog, confirmed by reading DesksView.tsx),
 *     types B's email into the real `data-testid="livedesk-email"` input, and
 *     clicks the real `data-testid="livedesk-add"` button. Fully UI-driven.
 *  4. B (already signed in, own window) receives the desk into their own local
 *     SQLite within a few seconds of A's share click — verified via B's real
 *     window.api.nodes.list() (the desk's id is preserved byte-for-byte, and its
 *     parent is B's local "Shared with me" folder, exactly as
 *     applyRemoteShared's Rule 2 promises) AND via B's real UI: the same desk
 *     card (`index-card-<id>`, same id as A's) renders in B's own "All desks"
 *     gallery.
 *  5. Bidirectional edit propagation: A drops a widget on the desk -> lands in
 *     B's local DB and B's real canvas within a few seconds; B drops a widget
 *     back -> lands in A's local DB and A's real canvas within a few seconds.
 *     Widget creation is IPC-driven (a drag-drop gesture is a harness reliability
 *     concern per the tester agent's own guidance, not a product contract); the
 *     landing is asserted on both the local DB AND the real rendered canvas.
 *  6. Revoke: A opens the same Share dialog again and clicks the real "Remove
 *     access" button next to B's grant row -> B's local copy of the desk is
 *     pruned (gone from window.api.nodes.list()) on the next sync cycle.
 *
 * Every propagation step is timed and asserted well under the 20s poll interval
 * (lib/workspaceSync.ts SYNC_INTERVAL_MS) to demonstrate the near-live
 * `sharedWorkspaceChanged` socket push fired, not just the backstop poll.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.DESKSHARE_LIVE_PROXY_BASE // e.g. https://localhost:8793

test.beforeAll(async () => {
  test.skip(
    !PROXY_BASE,
    'DESKSHARE_LIVE_PROXY_BASE not set — this spec needs a purpose-built app + local TLS proxy, see file header. Skipping rather than failing the normal suite.'
  )
})

interface Launched {
  app: ElectronApplication
  window: Page
  userDataDir: string
  dispose: () => Promise<void>
}

async function launchWithCertBypass(label: string): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), `plexii-deskshare-${label}-`))
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
      // app.close() sends a graceful shutdown; if it hangs, fall back to a
      // plain process kill (SIGTERM), never SIGKILL, per the tester agent's
      // invariant for local Electron teardown.
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

async function signUpViaUi(window: Page, email: string, password: string): Promise<void> {
  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: 'Sign up' }).click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder('at least 8 characters').fill(password)
  await window.getByRole('button', { name: 'Create account' }).click()
  await expect(dialog).not.toBeVisible({ timeout: 10_000 })
}

async function pollUntil<T>(
  window: Page,
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 10_000
): Promise<{ value: T; elapsedMs: number }> {
  const start = Date.now()
  for (;;) {
    const value = await window.evaluate(fn as unknown as () => Promise<T>)
    if (predicate(value)) return { value, elapsedMs: Date.now() - start }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms, last value: ${JSON.stringify(value)}`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

test.describe.configure({ mode: 'serial' })

test('per-desk live sharing: two real accounts, ACL grant by email, bidirectional near-live propagation + revoke prune', async () => {
  test.setTimeout(150_000)
  const rand = Date.now()
  const emailA = `deskshare.live.a.${rand}@example.com`
  const emailB = `deskshare.live.b.${rand}@example.com`
  const password = 'Test-Account-123!'
  const timings: Record<string, number> = {}

  const A = await launchWithCertBypass('A')
  const B = await launchWithCertBypass('B')

  try {
    await dismissOnboardingOnly(A.window)
    await dismissOnboardingOnly(B.window)

    // ── Real sign-up, real network (through the TLS proxy), both windows ────
    await signUpViaUi(A.window, emailA, password)
    await signUpViaUi(B.window, emailB, password)
    console.log('[DESKSHARE] both accounts signed up via real UI:', emailA, emailB)

    // ── Step: A creates a desk (task node). IPC-driven — deterministic id
    // capture; desk-creation UI is covered elsewhere (_liveDeskSharingSmoke). ──
    const deskTitle = `Live Share Desk ${rand}`
    const deskId = await A.window.evaluate(async (title) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const node = await api.nodes.create({ parentId: null, kind: 'task', title } as never)
      return (node as unknown as { id: string }).id
    }, deskTitle)
    console.log('[DESKSHARE] A created desk', deskId)

    // Reload so A's renderer node store (populated by store actions, not by this
    // bare IPC call) picks up the freshly-created row — same technique
    // acceptShare.spec.ts / shareInvite.spec.ts / _liveDeskSharingSmoke use.
    await A.window.reload()
    await dismissOnboardingOnly(A.window)

    // ── Step: A opens the REAL Share dialog via a REAL UI click ─────────────
    await A.window.getByRole('button', { name: 'All desks' }).click()
    const card = A.window.locator(`[data-testid="index-card-${deskId}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.locator('button[title="Create a public link — anyone with it can view this desk"]').click()

    const shareDialog = A.window.locator('[role="dialog"]').filter({ hasText: 'Live sharing (real-time)' })
    await expect(shareDialog).toBeVisible({ timeout: 5_000 })

    const emailInput = A.window.locator('[data-testid="livedesk-email"]')
    const addButton = A.window.locator('[data-testid="livedesk-add"]')
    await expect(emailInput).toBeVisible()
    await emailInput.fill(emailB)
    // Default permission select is already 'edit' (LiveDeskSharing's initial
    // state) — needed for B's edits to propagate back in the bidirectional
    // check below, so leave it untouched rather than force it via evaluate.
    const t0 = Date.now()
    await addButton.click()

    // B already has an account, so the grant is immediate (server: "granted",
    // not "invited") — confirm the real success copy the user would see.
    await expect(A.window.getByText(new RegExp(`${emailB.replace(/[.+]/g, '\\$&')} now has live access`, 'i'))).toBeVisible({
      timeout: 8_000
    })
    console.log('[DESKSHARE] A shared the desk with B via real UI (livedesk-email/livedesk-add)')

    // ── Step: B receives the desk into their own local DB near-live ─────────
    const materialize = await pollUntil(
      B.window,
      async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        return api.nodes.list()
      },
      (nodes) => (nodes as unknown as Array<{ id: string }>).some((n) => n.id === deskId),
      10_000
    )
    timings.shareMaterializePropagationMs = materialize.elapsedMs
    console.log(
      `[TIMING] Shared desk landed on B's local DB after ${materialize.elapsedMs}ms (shared at t0=${t0})`
    )

    const bNode = (materialize.value as unknown as Array<{ id: string; title: string; parentId: string | null }>).find(
      (n) => n.id === deskId
    )
    expect(bNode?.title).toBe(deskTitle)
    // Rule 2 (applyRemoteShared): the desk root anchors under B's local "Shared
    // with me" container on first materialization.
    const bContainerId = (
      await B.window.evaluate(async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        const nodes = (await api.nodes.list()) as unknown as Array<{ id: string; title: string; parentId: string | null }>
        return nodes.find((n) => n.title === 'Shared with me' && n.parentId === null)?.id ?? null
      })
    )
    expect(bContainerId, 'B must have a local "Shared with me" container').not.toBeNull()
    expect(bNode?.parentId).toBe(bContainerId)

    // Real-UI proof on B: reload so B's own node store picks up the pulled row,
    // then the SAME desk card (same id, preserved byte-for-byte) renders in B's
    // own "All desks" gallery.
    await B.window.reload()
    await dismissOnboardingOnly(B.window)
    await B.window.getByRole('button', { name: 'All desks' }).click()
    await expect(B.window.locator(`[data-testid="index-card-${deskId}"]`)).toBeVisible({ timeout: 8_000 })
    console.log('[DESKSHARE] shared desk renders on B\'s real "All desks" gallery, same id:', deskId)

    // ── Bidirectional edit propagation: A -> B ───────────────────────────────
    // Widget creation is driven through the real renderer store action
    // (window.__fbWidgets, the same zustand hook a real drag-drop-from-palette
    // gesture calls — see stores/widgets.ts `create`), NOT a raw IPC call: the
    // store's create() is what fires nudgeSync() after a local mutation, which
    // is what makes propagation near-live instead of waiting for the 20s
    // backstop poll. A raw window.api.widgets.create() bypasses that nudge
    // entirely (confirmed empirically — it only reappeared on the next natural
    // interval tick), so it would understate what a real user's edit does. A
    // canvas drag-drop gesture itself is a harness reliability concern (not the
    // contract under test), so we call the store directly rather than simulate
    // the drag; landing is checked on BOTH the local DB and the real rendered
    // canvas on the receiving side.
    const t1 = Date.now()
    const widgetA = await A.window.evaluate(async (taskId) => {
      const store = (window as unknown as { __fbWidgets?: { getState: () => { create: (d: unknown) => Promise<unknown> } } }).__fbWidgets
      if (!store) throw new Error('window.__fbWidgets not exposed')
      return store.getState().create({
        taskId,
        kind: 'note',
        content: 'hello from A (live desk share)',
        x: 40,
        y: 40,
        width: 240,
        height: 160
      })
    }, deskId)
    const widgetAId = (widgetA as unknown as { id: string }).id

    const widgetAResult = await (async () => {
      const start = Date.now()
      for (;;) {
        const ws = await B.window.evaluate(async (tid) => {
          const api = (window as unknown as { api: typeof window.api }).api
          return api.widgets.listByTask(tid)
        }, deskId)
        if ((ws as unknown as Array<{ id: string }>).some((w) => w.id === widgetAId)) {
          return { value: ws, elapsedMs: Date.now() - start }
        }
        if (Date.now() - start > 10_000) throw new Error("A's widget did not propagate to B within 10s")
        await new Promise((r) => setTimeout(r, 250))
      }
    })()
    timings.widgetAToBPropagationMs = widgetAResult.elapsedMs
    console.log(`[TIMING] A's widget landed on B after ${widgetAResult.elapsedMs}ms (created at t1=${t1})`)

    // Real-UI proof: open the desk on B and see A's widget rendered on canvas.
    await B.window.evaluate((tid) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState()?.goTask?.(tid)
    }, deskId)
    await expect(B.window.locator(`[data-widget-id="${widgetAId}"]`)).toBeVisible({ timeout: 5_000 })
    console.log('[DESKSHARE] A\'s widget renders on B\'s real canvas')

    // ── Bidirectional edit propagation: B -> A ───────────────────────────────
    // Same store-driven creation as A's widget above, on B's own window — this
    // is B's real create path (nudgeSync fires on B's side too).
    const t2 = Date.now()
    const widgetB = await B.window.evaluate(async (taskId) => {
      const store = (window as unknown as { __fbWidgets?: { getState: () => { create: (d: unknown) => Promise<unknown> } } }).__fbWidgets
      if (!store) throw new Error('window.__fbWidgets not exposed')
      return store.getState().create({
        taskId,
        kind: 'note',
        content: 'hello from B (live desk share)',
        x: 320,
        y: 40,
        width: 240,
        height: 160
      })
    }, deskId)
    const widgetBId = (widgetB as unknown as { id: string }).id

    const widgetBResult = await (async () => {
      const start = Date.now()
      for (;;) {
        const ws = await A.window.evaluate(async (tid) => {
          const api = (window as unknown as { api: typeof window.api }).api
          return api.widgets.listByTask(tid)
        }, deskId)
        if ((ws as unknown as Array<{ id: string }>).some((w) => w.id === widgetBId)) {
          return { value: ws, elapsedMs: Date.now() - start }
        }
        if (Date.now() - start > 10_000) throw new Error('B\'s widget did not propagate to A within 10s')
        await new Promise((r) => setTimeout(r, 250))
      }
    })()
    timings.widgetBToAPropagationMs = widgetBResult.elapsedMs
    console.log(`[TIMING] B's widget landed on A after ${widgetBResult.elapsedMs}ms (created at t2=${t2})`)

    // Real-UI proof: A's canvas for the desk (still on the desk view from
    // earlier navigation history — jump there explicitly to be sure) shows B's
    // widget.
    await A.window.evaluate((tid) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState()?.goTask?.(tid)
    }, deskId)
    await expect(A.window.locator(`[data-widget-id="${widgetBId}"]`)).toBeVisible({ timeout: 5_000 })
    console.log('[DESKSHARE] B\'s widget renders on A\'s real canvas — bidirectional propagation proven both ways')

    // ── New CHILD NODE created after the share (not just a widget) also
    // propagates — reconcileSharedDescendants walks nodes by parent_id, not
    // just widgets, so a subtask B adds under the shared desk must reach A too.
    // Store-driven (window.__fbNodes), same rationale as the widget creates.
    const t2b = Date.now()
    const childNodeId = await B.window.evaluate(async (parentId) => {
      const store = (window as unknown as { __fbNodes?: { getState: () => { create: (d: unknown) => Promise<unknown> } } }).__fbNodes
      if (!store) throw new Error('window.__fbNodes not exposed')
      const node = await store.getState().create({ parentId, kind: 'task', title: 'B added subtask after share' })
      return (node as unknown as { id: string }).id
    }, deskId)

    const childNodeResult = await (async () => {
      const start = Date.now()
      for (;;) {
        const nodes = await A.window.evaluate(async () => {
          const api = (window as unknown as { api: typeof window.api }).api
          return api.nodes.list()
        })
        const found = (nodes as unknown as Array<{ id: string; parentId: string | null }>).find(
          (n) => n.id === childNodeId
        )
        if (found) return { value: found, elapsedMs: Date.now() - start }
        if (Date.now() - start > 10_000) throw new Error("B's new child node did not propagate to A within 10s")
        await new Promise((r) => setTimeout(r, 250))
      }
    })()
    timings.childNodeBToAPropagationMs = childNodeResult.elapsedMs
    expect(childNodeResult.value.parentId).toBe(deskId)
    console.log(
      `[TIMING] B's new child node landed on A after ${childNodeResult.elapsedMs}ms (created at t2b=${t2b}), parentId correct`
    )

    // ── Bonus: revoke B's access via the real "Remove access" button, confirm
    // B's local copy is pruned on the next cycle ─────────────────────────────
    await A.window.getByRole('button', { name: 'All desks' }).click()
    await A.window.locator(`[data-testid="index-card-${deskId}"]`)
      .locator('button[title="Create a public link — anyone with it can view this desk"]')
      .click()
    await expect(A.window.locator('[data-testid="livedesk-email"]')).toBeVisible({ timeout: 5_000 })
    const t3 = Date.now()
    await A.window.locator('button[title="Remove access"]').first().click()
    await expect(A.window.locator('button[title="Remove access"]')).toHaveCount(0, { timeout: 5_000 })
    console.log('[DESKSHARE] A revoked B\'s access via the real "Remove access" button')

    const pruneResult = await (async () => {
      const start = Date.now()
      for (;;) {
        const nodes = await B.window.evaluate(async () => {
          const api = (window as unknown as { api: typeof window.api }).api
          return api.nodes.list()
        })
        const stillThere = (nodes as unknown as Array<{ id: string }>).some((n) => n.id === deskId)
        if (!stillThere) return { elapsedMs: Date.now() - start }
        if (Date.now() - start > 25_000) throw new Error('B\'s local copy was not pruned within 25s of revoke')
        await new Promise((r) => setTimeout(r, 500))
      }
    })()
    timings.revokePrunePropagationMs = pruneResult.elapsedMs
    console.log(`[TIMING] B's local copy pruned after ${pruneResult.elapsedMs}ms (revoked at t3=${t3})`)

    // Every propagation above must land well under the 20s poll backstop
    // (lib/workspaceSync.ts SYNC_INTERVAL_MS) to demonstrate the near-live
    // sharedWorkspaceChanged push fired, not just the interval poll. The revoke
    // prune only happens on B's OWN next pull cycle (no push targets a revoked
    // account), so it is allowed the full interval-plus-margin instead.
    for (const [k, v] of Object.entries(timings)) {
      const budget = k === 'revokePrunePropagationMs' ? 24_000 : 15_000
      expect(v, `${k} should land well within its propagation budget`).toBeLessThan(budget)
    }

    console.log('[TIMINGS SUMMARY]', JSON.stringify(timings, null, 2))
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
