/**
 * E2E: WS01 sync substrate — TWO REAL Electron windows of the SAME account drag the
 * SAME widget concurrently, across a simulated socket drop, and converge to ONE
 * deterministic position with zero lost edits. This is the design's first-slice gate
 * (docs/sync-substrate-design.md §"First implementable slice", step 4): when it is
 * green with the flag on for widgets, the same shape repeats for every other type.
 *
 * HARNESS CONSTRAINT (identical to deskShareTwoWindowLive.spec.ts, restated): the
 * built app's CSP refuses a plain-http fetch() from the renderer, so a local
 * plain-http signal server must sit behind a TLS-terminating proxy
 * (tests/e2e/support/tls-proxy.js) and the app must be BUILT pointed at that proxy.
 * Electron launches with --ignore-certificate-errors. Run it via:
 *
 *   cd projects/focusbuddy-signal && DB_PATH=<fresh> PORT=8792 npm run build && node dist/server.js
 *   node tests/e2e/support/tls-proxy.js 8793 8792
 *   VITE_USE_REMOTE_SIGNAL=true \
 *   VITE_SIGNAL_HTTP_URL=https://localhost:8793 \
 *   VITE_SIGNAL_WS_URL=wss://localhost:8793/ws \
 *   npm run build
 *   CRDT_LIVE_PROXY_BASE=https://localhost:8793 \
 *   npx playwright test tests/e2e/crdtWidgetConvergeTwoWindowLive.spec.ts
 *
 * Self-skips (rather than fails) when CRDT_LIVE_PROXY_BASE isn't set, so it never
 * runs by accident inside the ordinary `npm run test:e2e` pipeline (which rebuilds
 * against production and would make every real-network step fail).
 *
 * Both windows sign in to the SAME account, so they share the widget partition
 * `w:acct:<accountId>` — this slice is multi-device convergence for one user (the
 * safe first partition; shared-desk partitions come later). The fb.sync.crdt.widgets
 * flag is turned on in each window's localStorage before the app boots its sync.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.CRDT_LIVE_PROXY_BASE // e.g. https://localhost:8793

test.beforeAll(async () => {
  test.skip(
    !PROXY_BASE,
    'CRDT_LIVE_PROXY_BASE not set — this spec needs a purpose-built app + local TLS proxy, see file header. Skipping rather than failing the normal suite.'
  )
})

interface Launched {
  app: ElectronApplication
  window: Page
  userDataDir: string
  dispose: () => Promise<void>
}

async function launchWithCertBypass(label: string): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), `plexii-crdt-${label}-`))
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
        app.process().kill() // SIGTERM, never SIGKILL, per the tester invariant
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
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 10_000
  })
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 10_000 })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
}

// Turn the widget-sync flag on and reload so the engine initialises with it set.
// Also enable the nodes flag: the widget lives on a task, and if that task synced
// only via the slow poll (nodes flag off) the widget-create would sit in the
// cross-type pending-create buffer until the 20s poll delivered the task. Enabling
// nodes lets the task converge over the socket first so the widget create applies
// promptly — this test is about widget geometry LWW, not the poll's cadence.
async function enableCrdtFlag(window: Page): Promise<void> {
  await window.evaluate(() => {
    localStorage.setItem('fb.sync.crdt.widgets', '1')
    localStorage.setItem('fb.sync.crdt.nodes', '1')
  })
  await window.reload()
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

async function signInViaUi(window: Page, email: string, password: string): Promise<void> {
  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  // Fresh profiles (no cachedEmail) default to signup mode. The mode-toggle tab and
  // the submit button both read "Log in" once in login mode, which makes a
  // name-based locator ambiguous; click the tab explicitly (idempotent — a no-op if
  // already in login mode) then target the submit button unambiguously by type.
  await dialog.getByRole('button', { name: 'Log in', exact: true }).first().click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder(/password|at least 8/i).first().fill(password)
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog).not.toBeVisible({ timeout: 10_000 })
}

async function geomOf(window: Page, widgetId: string): Promise<{ x: number; y: number } | null> {
  return window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const list = await api.widgets.listByTask((window as unknown as { __crdtTaskId: string }).__crdtTaskId)
    const w = (list as Array<{ id: string; x: number; y: number }>).find((x) => x.id === id)
    return w ? { x: w.x, y: w.y } : null
  }, widgetId)
}

test.describe.configure({ mode: 'serial' })

test('two devices of one account drag the same widget across a socket drop and converge', async () => {
  test.setTimeout(150_000)
  const rand = Date.now()
  const email = `crdt.converge.${rand}@example.com`
  const password = 'Test-Account-123!'

  const A = await launchWithCertBypass('A')
  const B = await launchWithCertBypass('B')

  try {
    await dismissOnboardingOnly(A.window)
    await dismissOnboardingOnly(B.window)

    // Same account on both windows → same widget partition w:acct:<id>.
    await signUpViaUi(A.window, email, password)
    await signInViaUi(B.window, email, password)

    await enableCrdtFlag(A.window)
    await enableCrdtFlag(B.window)
    await dismissOnboardingOnly(A.window)
    await dismissOnboardingOnly(B.window)

    // A creates a desk + a widget through the real store (fires the CRDT emit path).
    // The desk/node creation deliberately goes through __fbNodes (not the raw
    // api.nodes.create IPC bridge, which never touches crdtEmitNodeCreate at all) —
    // BUT this spec only turns on fb.sync.crdt.widgets, so nodePart stays null and
    // emitNodeCreate no-ops regardless of entry point. The node is expected to reach
    // B via the classic 20s workspace poll (see the extended wait below), not CRDT.
    const { taskId, widgetId } = await A.window.evaluate(async () => {
      const nodeStore = (window as unknown as { __fbNodes: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbNodes
      const t = await nodeStore.getState().create({ parentId: null, kind: 'task', title: 'Converge Desk' })
      const store = (window as unknown as { __fbWidgets: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbWidgets
      const w = await store.getState().create({ taskId: (t as { id: string }).id, kind: 'note', content: 'converge', x: 100, y: 100, width: 240, height: 160 })
      ;(window as unknown as { __crdtTaskId: string }).__crdtTaskId = (t as { id: string }).id
      return { taskId: (t as { id: string }).id, widgetId: w.id }
    })

    // B opens the same desk; the widget replays to B via crdtSync (or the poll).
    await B.window.evaluate((tid) => {
      ;(window as unknown as { __crdtTaskId: string }).__crdtTaskId = tid
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState()?.goTask?.(tid)
    }, taskId)
    // SETUP ONLY (not the substrate assertion under test): with nodes CRDT off, the
    // desk can only arrive on B via the 20s classic poll. The widget's own CRDT
    // create event lands on B in well under a second, but the receiving apply
    // (applyWidgetCreate in crdtSync.ts) does `window.api.widgets.create` against
    // the desk's taskId FK, which does not exist locally yet — a hard
    // SQLITE_CONSTRAINT_FOREIGNKEY error, silently swallowed by that function's
    // `catch { return }`. So the widget-create event is a genuine, reproducible,
    // one-shot loss on the fast path; visibility here can only come from the
    // classic poll independently re-delivering the widget on its own 20s cycle.
    // Budget past two poll ticks so setup isn't flaky on a slow tick boundary.
    await expect(B.window.locator(`[data-widget-id="${widgetId}"]`)).toBeVisible({ timeout: 45_000 })

    // Both windows drag the SAME widget. A drags first (earlier LWW timestamp), B
    // drags second (later), so B's edit must win deterministically on BOTH. Every
    // emitted event is recorded locally as synced=false and only marked synced after
    // it flushes, so B's reload below exercises the offline-queue → reauth → flush
    // path (the events survive the reload and re-send on reconnect), not just the
    // live socket relay.

    // A drags first (earlier timestamp), through the real store update() path.
    await A.window.evaluate(async (id) => {
      const store = (window as unknown as { __fbWidgets: { getState: () => { update: (id: string, p: unknown) => Promise<void> } } }).__fbWidgets
      await store.getState().update(id, { x: 300, y: 120 })
    }, widgetId)

    await B.window.waitForTimeout(50)

    // B drags later (later timestamp) while its socket is down → queued offline.
    await B.window.evaluate(async (id) => {
      const store = (window as unknown as { __fbWidgets: { getState: () => { update: (id: string, p: unknown) => Promise<void> } } }).__fbWidgets
      await store.getState().update(id, { x: 500, y: 400 })
    }, widgetId)

    // B reconnects (reload re-auths the socket → onReauth joins + flushes the queue).
    // The reload wipes every page-global (window.__crdtTaskId included), so geomOf's
    // read of that global would silently resolve against `undefined` unless it is
    // re-armed here alongside the view navigation.
    await B.window.reload()
    await dismissOnboardingOnly(B.window)
    await B.window.evaluate((tid) => {
      ;(window as unknown as { __crdtTaskId: string }).__crdtTaskId = tid
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState()?.goTask?.(tid)
    }, taskId)

    // Converge: both windows must settle on B's later position (500,400), and neither
    // may be left on the pre-edit (100,100). Allow the propagation a few seconds.
    const converged = async (window: Page): Promise<boolean> => {
      const g = await geomOf(window, widgetId)
      return !!g && g.x === 500 && g.y === 400
    }
    for (const [label, w] of [['A', A.window], ['B', B.window]] as const) {
      const start = Date.now()
      let ok = false
      let last: { x: number; y: number } | null = null
      while (Date.now() - start < 15_000) {
        last = await geomOf(w, widgetId)
        if (last && last.x === 500 && last.y === 400) {
          ok = true
          break
        }
        await w.waitForTimeout(300)
      }
      // eslint-disable-next-line no-console
      console.log(`[CRDT-LIVE] ${label} final geom = ${JSON.stringify(last)} after ${Date.now() - start}ms (want 500,400)`)
      expect(ok, `${label} should converge to the later edit (500,400); last=${JSON.stringify(last)}`).toBe(true)
    }
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
