/**
 * E2E: cross-member org sync driven through TWO REAL Electron windows, both
 * genuinely signed in and syncing over the network — not the HTTP-only
 * contract test in orgSyncCrossMember.spec.ts, and not the single-instance +
 * this-test's-own-fetch fallback in calendarSync.spec.ts.
 *
 * HARNESS CONSTRAINT AND HOW THIS SPEC GETS AROUND IT (stated plainly):
 * the built app's CSP is `connect-src 'self' ws: wss: https:` — it allows an
 * insecure WebSocket (ws:) but refuses a plain-http fetch() outright. That
 * blocks the renderer's own account login / workspace-sync fetch calls
 * against a local plain-http signal server (confirmed empirically: Chromium
 * logs "Refused to connect ... violates Content Security Policy" for
 * http://localhost). HTTPS is allowed by the CSP, so this spec puts a tiny
 * local TLS-terminating reverse proxy (self-signed cert) in front of the
 * plain-http signal server, and the app is built with
 * VITE_SIGNAL_HTTP_URL=https://localhost:<proxyPort> /
 * VITE_SIGNAL_WS_URL=wss://localhost:<proxyPort>/ws so the CSP accepts it.
 * The self-signed cert is accepted by launching Electron with the Chromium
 * `--ignore-certificate-errors` switch (no app source touched).
 *
 * BECAUSE the signal URL is baked in at build time, this spec requires a
 * purpose-built app bundle — it will NOT pass against the bundle produced by
 * a plain `npm run build` (which points at production). Run it via:
 *
 *   cd projects/focusbuddy-signal && PORT=8790 DB_PATH=<fresh> npm run dev
 *   node tests/e2e/support/tls-proxy.js 8791 8790     # see helper below
 *   VITE_USE_REMOTE_SIGNAL=true \
 *   VITE_SIGNAL_HTTP_URL=https://localhost:8791 \
 *   VITE_SIGNAL_WS_URL=wss://localhost:8791/ws \
 *   npm run build
 *   npx playwright test tests/e2e/orgSyncTwoWindowLive.spec.ts
 *
 * The spec self-skips (rather than fail) when ORGSYNC_LIVE_PROXY_BASE isn't
 * set, so it never runs by accident inside the ordinary `npm run test:e2e`
 * pipeline (which rebuilds against production).
 *
 * What is proven, live, through two real running windows:
 *  1. A creates a Room + nested Desk -> both land in B's local DB (verified
 *     via window.api.nodes on B, plus the Room's card rendering in B's
 *     real DeskGallery UI) with the Desk's parentId correctly the Room.
 *  2. A drops a widget on the Desk -> appears in B's local DB, and visibly
 *     renders (`[data-widget-id]`) on B's real Canvas once the Desk is open.
 *  3. A creates a table + row, then edits the row -> B sees the edit.
 *  4. Every propagation above is timed. It must land well inside the 20s
 *     poll interval (lib/workspaceSync.ts SYNC_INTERVAL_MS) to demonstrate
 *     the near-live orgWorkspaceChanged push fired, not just the backstop
 *     poll.
 *  5. A deletes the widget -> the tombstone reaches B (widget disappears
 *     from B's listByTask).
 *
 * Node/widget/table creation is driven through window.api (the real
 * main-process IPC + local SQLite + the real renderer push/pull sync loop
 * in lib/workspaceSync.ts) rather than clicking through canvas drag
 * gestures, per the tester agent's guidance on deterministic contract
 * drives — labelled here plainly as IPC-driven. Sign-up, org creation,
 * invite and org-switching ARE driven through the real UI (real clicks,
 * real fetches through the proxy, real server).
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.ORGSYNC_LIVE_PROXY_BASE // e.g. https://localhost:8791
const SIGNAL_BASE = process.env.ORGSYNC_LIVE_SIGNAL_BASE ?? 'http://localhost:8790' // plain-http backend, for direct DB-less assertions if ever needed

test.beforeAll(async () => {
  test.skip(
    !PROXY_BASE,
    'ORGSYNC_LIVE_PROXY_BASE not set — this spec needs a purpose-built app + local TLS proxy, see file header. Skipping rather than failing the normal suite.'
  )
});

interface Launched {
  app: ElectronApplication
  window: Page
  userDataDir: string
  dispose: () => Promise<void>
}

async function launchWithCertBypass(label: string): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), `plexii-orgsync-${label}-`))
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
  delete cleanEnv.OPENAI_API_KEY

  const app = await electron.launch({
    // Chromium switch, not an app source change — accepts the local
    // self-signed TLS proxy cert so the CSP's https: allowance is usable.
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

async function signUpViaUi(window: Page, email: string, password: string): Promise<void> {
  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: 'Sign up' }).click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder('at least 8 characters').fill(password)
  await window.getByRole('button', { name: 'Create account' }).click()
  // Modal unmounts once `account` is populated in the store.
  await expect(dialog).not.toBeVisible({ timeout: 10_000 })
}

async function openOrgAdmin(window: Page): Promise<void> {
  await window.locator('[data-testid="org-switcher-button"]').click()
  await window.locator('[data-testid="org-switcher-manage"]').click()
  await expect(window.locator('[data-testid="org-admin"]')).toBeVisible({ timeout: 8_000 })
}

async function switchActiveOrg(window: Page, orgNameSubstring: string): Promise<void> {
  await window.locator('[data-testid="org-switcher-button"]').click()
  const menu = window.locator('[data-testid="org-switcher-menu"]')
  await expect(menu).toBeVisible({ timeout: 5_000 })
  await menu.locator(`button:has-text("${orgNameSubstring}")`).first().click()
  await expect(window.locator('[data-testid="org-switcher-button"]')).toContainText(orgNameSubstring, {
    timeout: 8_000
  })
}

test.describe.configure({ mode: 'serial' })

test('two real Electron windows, two real accounts, one real org: nodes/widgets/tables propagate near-live and tombstone', async () => {
  test.setTimeout(120_000)
  const rand = Date.now()
  const emailA = `orgsync.live.a.${rand}@example.com`
  const emailB = `orgsync.live.b.${rand}@example.com`
  const password = 'Test-Account-123!'
  const orgName = `Live Sync Org ${rand}`

  const A = await launchWithCertBypass('A')
  const B = await launchWithCertBypass('B')
  const timings: Record<string, number> = {}

  try {
    await dismissOnboardingOnly(A.window)
    await dismissOnboardingOnly(B.window)

    // ── Real sign-up, real network, real server, both windows ──────────────
    await signUpViaUi(A.window, emailA, password)
    await signUpViaUi(B.window, emailB, password)

    // ── A creates the org and invites B (both real UI actions) ─────────────
    await openOrgAdmin(A.window)
    await A.window.locator('[data-testid="org-new-name"]').fill(orgName)
    await A.window.locator('[data-testid="org-create"]').click()
    // The new org becomes selectable; wait for its pick button to render.
    await expect(A.window.locator(`button:has-text("${orgName}")`).first()).toBeVisible({ timeout: 8_000 })

    await A.window.locator('[data-testid="org-invite-email"]').fill(emailB)
    await A.window.locator('[data-testid="org-invite-send"]').click()
    // B already has an account, so the invite adds them directly.
    await expect(A.window.locator('text=Added to the organization.')).toBeVisible({ timeout: 8_000 })

    // ── A switches active org to the new org via the real switcher UI ──────
    await switchActiveOrg(A.window, orgName)

    // ── B needs its org list refreshed to see the new membership. The org
    // store only reloads on mount / token change (stores/org.ts), so a
    // real user would see it after relaunching; a reload does the same
    // real boot path (OrgSwitcher mounts, calls load(), server confirms
    // membership). This is a real re-fetch against the real server, not a
    // fabricated state injection. ──────────────────────────────────────────
    await B.window.reload()
    await dismissOnboardingOnly(B.window)
    await switchActiveOrg(B.window, orgName)

    // ── Step 1: A creates a Room (folder) + a nested Desk (task) via IPC ────
    const t1 = Date.now()
    const room = await A.window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.nodes.create({ parentId: null, kind: 'folder', title: 'Marketing (live sync)' } as never)
    })
    const roomId = (room as unknown as { id: string }).id
    const desk = await A.window.evaluate(async (pid) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.nodes.create({ parentId: pid, kind: 'task', title: 'Campaign desk (live sync)' } as never)
    }, roomId)
    const deskId = (desk as unknown as { id: string }).id

    // Poll B's local IPC (real local SQLite, populated by the real sync
    // pipeline) until both land, timing how long it actually took.
    async function pollUntil<T>(
      window: Page,
      fn: () => Promise<T>,
      predicate: (v: T) => boolean,
      timeoutMs = 8_000
    ): Promise<{ value: T; elapsedMs: number }> {
      const start = Date.now()
      for (;;) {
        const value = await window.evaluate(fn as unknown as () => Promise<T>)
        if (predicate(value)) return { value, elapsedMs: Date.now() - start }
        if (Date.now() - start > timeoutMs) {
          throw new Error(`pollUntil timed out after ${timeoutMs}ms, last value: ${JSON.stringify(value)}`)
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    const nodesResult = await pollUntil(
      B.window,
      async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        return api.nodes.list()
      },
      (nodes) => {
        const list = nodes as unknown as Array<{ id: string }>
        return list.some((n) => n.id === roomId) && list.some((n) => n.id === deskId)
      }
    )
    timings.nodesPropagationMs = nodesResult.elapsedMs
    console.log(`[TIMING] Room+Desk landed on B after ${nodesResult.elapsedMs}ms (created at t1=${t1})`)

    const bDesk = (nodesResult.value as unknown as Array<{ id: string; parentId: string | null }>).find(
      (n) => n.id === deskId
    )
    expect(bDesk?.parentId, 'Desk nested under Room on B').toBe(roomId)

    // Real-UI proof: the Room's card renders in B's real DeskGallery.
    await B.window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
      w.__fbView?.getState()?.goHome?.()
    })
    await expect(B.window.locator(`[data-testid="desk-card-${roomId}"]`)).toBeVisible({ timeout: 5_000 })

    // ── Step 2: A drops a widget on the Desk ────────────────────────────────
    const t2 = Date.now()
    const widget = await A.window.evaluate(async (taskId) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.widgets.create({
        taskId,
        kind: 'note',
        content: 'hello from A (live sync)',
        x: 40,
        y: 40,
        width: 240,
        height: 160
      } as never)
    }, deskId)
    const widgetId = (widget as unknown as { id: string }).id

    const widgetsResult2 = await (async () => {
      const start = Date.now()
      for (;;) {
        const ws = await B.window.evaluate(async (tid) => {
          const api = (window as unknown as { api: typeof window.api }).api
          return api.widgets.listByTask(tid)
        }, deskId)
        if ((ws as unknown as Array<{ id: string }>).some((w) => w.id === widgetId)) {
          return { value: ws, elapsedMs: Date.now() - start }
        }
        if (Date.now() - start > 8_000) throw new Error('widget did not propagate to B within 8s')
        await new Promise((r) => setTimeout(r, 200))
      }
    })()
    timings.widgetPropagationMs = widgetsResult2.elapsedMs
    console.log(`[TIMING] Widget landed on B after ${widgetsResult2.elapsedMs}ms (created at t2=${t2})`)

    // Real-UI proof: open the Desk on B and see the widget rendered on canvas.
    await B.window.evaluate((tid) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState()?.goTask?.(tid)
    }, deskId)
    await expect(B.window.locator(`[data-widget-id="${widgetId}"]`)).toBeVisible({ timeout: 5_000 })

    // ── Step 3: A creates a table + row, then edits the row ─────────────────
    const t3 = Date.now()
    const table = await A.window.evaluate(async (taskId) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.tables.create({ taskId, title: 'Episodes (live sync)' } as never)
    }, deskId)
    const tableId = (table as unknown as { id: string }).id
    const row = await A.window.evaluate(async (tid) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.tables.createRow({ tableId: tid, cells: { Title: 'Pilot' } } as never)
    }, tableId)
    const rowId = (row as unknown as { id: string }).id

    const rowCreateResult = await (async () => {
      const start = Date.now()
      for (;;) {
        const rows = await B.window.evaluate(async (tid) => {
          const api = (window as unknown as { api: typeof window.api }).api
          return api.tables.listRows(tid)
        }, tableId)
        const found = (rows as unknown as Array<{ id: string; cells: Record<string, unknown> }>).find(
          (r) => r.id === rowId
        )
        if (found) return { value: found, elapsedMs: Date.now() - start }
        if (Date.now() - start > 8_000) throw new Error('row did not propagate to B within 8s')
        await new Promise((r) => setTimeout(r, 200))
      }
    })()
    timings.tableRowCreatePropagationMs = rowCreateResult.elapsedMs
    console.log(`[TIMING] Table row landed on B after ${rowCreateResult.elapsedMs}ms (created at t3=${t3})`)
    expect((rowCreateResult.value as unknown as { cells: Record<string, unknown> }).cells.Title).toBe('Pilot')

    // A edits the row.
    const t4 = Date.now()
    await A.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.tables.updateRow(id, { cells: { Title: 'Recorded' } } as never)
    }, rowId)

    const rowEditResult = await (async () => {
      const start = Date.now()
      for (;;) {
        const rows = await B.window.evaluate(async (tid) => {
          const api = (window as unknown as { api: typeof window.api }).api
          return api.tables.listRows(tid)
        }, tableId)
        const found = (rows as unknown as Array<{ id: string; cells: Record<string, unknown> }>).find(
          (r) => r.id === rowId
        )
        if (found && found.cells.Title === 'Recorded') return { value: found, elapsedMs: Date.now() - start }
        if (Date.now() - start > 8_000) throw new Error('row edit did not propagate to B within 8s')
        await new Promise((r) => setTimeout(r, 200))
      }
    })()
    timings.tableRowEditPropagationMs = rowEditResult.elapsedMs
    console.log(`[TIMING] Table row edit landed on B after ${rowEditResult.elapsedMs}ms (created at t4=${t4})`)

    // ── Step 5: A deletes the widget -> tombstone reaches B ─────────────────
    const t5 = Date.now()
    await A.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.widgets.delete(id)
    }, widgetId)

    const deleteResult = await (async () => {
      const start = Date.now()
      for (;;) {
        const ws = await B.window.evaluate(async (tid) => {
          const api = (window as unknown as { api: typeof window.api }).api
          return api.widgets.listByTask(tid)
        }, deskId)
        const stillThere = (ws as unknown as Array<{ id: string }>).some((w) => w.id === widgetId)
        if (!stillThere) return { elapsedMs: Date.now() - start }
        if (Date.now() - start > 8_000) throw new Error('widget tombstone did not propagate to B within 8s')
        await new Promise((r) => setTimeout(r, 200))
      }
    })()
    timings.widgetTombstonePropagationMs = deleteResult.elapsedMs
    console.log(`[TIMING] Widget tombstone landed on B after ${deleteResult.elapsedMs}ms (deleted at t5=${t5})`)

    // The 20s poll is the backstop; every propagation above must be well
    // under it to demonstrate the near-live orgWorkspaceChanged push fired.
    for (const [k, v] of Object.entries(timings)) {
      expect(v, `${k} should land well under the 20s poll backstop`).toBeLessThan(15_000)
    }

    console.log('[TIMINGS SUMMARY]', JSON.stringify(timings, null, 2))
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
