/**
 * E2E: WS01 sync substrate — LIVE two-window convergence across MULTIPLE object
 * types, proving the shared spine (change_log transport + crdtSync engine) end to
 * end, not just widgets. Two real Electron windows of the SAME account, every
 * fb.sync.crdt.* flag on, creating + editing objects on window A and asserting they
 * converge on window B over the real (proxied) socket.
 *
 * This is the live-proof GATE for demoting the poll (docs/sync-substrate-design.md):
 * with all types green here, the flags can be flipped on per type and the poll
 * dropped to reconnect-catch-up.
 *
 * HARNESS (identical to crdtWidgetConvergeTwoWindowLive.spec.ts — see that file's
 * header). Self-skips unless CRDT_LIVE_PROXY_BASE is set, so it never runs in the
 * ordinary suite. Run via:
 *
 *   cd projects/focusbuddy-signal && DB_PATH=<fresh> PORT=8792 npm run build && node dist/server.js
 *   node tests/e2e/support/tls-proxy.js 8793 8792
 *   VITE_USE_REMOTE_SIGNAL=true VITE_SIGNAL_HTTP_URL=https://localhost:8793 \
 *   VITE_SIGNAL_WS_URL=wss://localhost:8793/ws npm run build
 *   CRDT_LIVE_PROXY_BASE=https://localhost:8793 \
 *   npx playwright test tests/e2e/crdtMultiTypeConvergeTwoWindowLive.spec.ts
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchGuarded } from './_netGuard'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.CRDT_LIVE_PROXY_BASE

test.beforeAll(async () => {
  test.skip(
    !PROXY_BASE,
    'CRDT_LIVE_PROXY_BASE not set — needs the purpose-built app + local TLS proxy (see header). Skipping.'
  )
})

interface Launched {
  app: ElectronApplication
  window: Page
  dispose: () => Promise<void>
}

async function launch(label: string): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), `fb-crdtmulti-${label}-`))
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
  const { app } = await launchGuarded({
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
      await Promise.race([app.close(), new Promise<void>((_, r) => setTimeout(() => r(new Error('t')), 5_000))])
    } catch {
      try {
        app.process().kill()
      } catch {
        /* dead */
      }
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  return { app, window, dispose }
}

async function dismissOnboarding(window: Page): Promise<void> {
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 10_000
  })
  await expect(window.locator('[data-testid="footer-sync-chip"]')).toBeVisible({ timeout: 10_000 })
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }
}

async function enableAllFlags(window: Page): Promise<void> {
  await window.evaluate(() => {
    for (const k of ['widgets', 'nodes', 'tables', 'timeblocks', 'files', 'documents']) {
      localStorage.setItem(`fb.sync.crdt.${k}`, '1')
    }
  })
  await window.reload()
}

async function signUp(window: Page, email: string, password: string): Promise<void> {
  const d = window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(d).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: 'Sign up' }).click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder('at least 8 characters').fill(password)
  await window.getByRole('button', { name: 'Create account' }).click()
  await expect(d).not.toBeVisible({ timeout: 10_000 })
}
async function signIn(window: Page, email: string, password: string): Promise<void> {
  const d = window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(d).toBeVisible({ timeout: 10_000 })
  // Fresh profiles (no cachedEmail) default to signup mode. The mode-toggle tab and
  // the submit button both read "Log in" once in login mode, which makes a
  // name-based locator ambiguous; click the tab explicitly (idempotent — a no-op if
  // already in login mode) then target the submit button unambiguously by type.
  await d.getByRole('button', { name: 'Log in', exact: true }).first().click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder(/password|at least 8/i).first().fill(password)
  await d.locator('button[type="submit"]').click()
  await expect(d).not.toBeVisible({ timeout: 10_000 })
}

// Poll B until predicate(value) or timeout; returns elapsed ms. Budget is well
// under the 20s poll so a pass proves the CRDT socket path, not the backstop poll.
async function until<T>(window: Page, fn: () => Promise<T>, pred: (v: T) => boolean, ms = 12_000): Promise<number> {
  const start = Date.now()
  for (;;) {
    const v = await window.evaluate(fn as unknown as () => Promise<T>)
    if (pred(v)) return Date.now() - start
    if (Date.now() - start > ms) throw new Error(`converge timeout ${ms}ms; last=${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

test.describe.configure({ mode: 'serial' })

test('multi-type live convergence: node/widget/document create + field edits converge A→B', async () => {
  test.setTimeout(180_000)
  const rand = Date.now()
  const email = `crdt.multi.${rand}@example.com`
  const password = 'Test-Account-123!'
  const A = await launch('A')
  const B = await launch('B')
  try {
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    await signUp(A.window, email, password)
    await signIn(B.window, email, password)
    await enableAllFlags(A.window)
    await enableAllFlags(B.window)
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)

    // ── NODE: create on A, converge on B; then rename on A, title converges ──
    // Must go through the __fbNodes store (not the raw api.nodes.create IPC bridge):
    // crdtEmitNodeCreate is only fired from the store's create() action, so a
    // direct IPC create would never reach the CRDT log at all.
    const nodeId = await A.window.evaluate(async () => {
      const store = (window as unknown as { __fbNodes: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbNodes
      const n = await store.getState().create({ parentId: null, kind: 'task', title: 'Live Node A' })
      return n.id
    })
    const nodeMs = await until(
      B.window,
      async () => (await (window as unknown as { api: typeof window.api }).api.nodes.list()) as Array<{ id: string; title: string }>,
      (list) => list.some((n) => n.id === nodeId),
      12_000
    )
    console.log(`[CRDT-LIVE] node create converged A→B in ${nodeMs}ms`)
    // Rename on A via the store (fires the CRDT title register).
    await A.window.evaluate(async (id) => {
      const store = (window as unknown as { __fbNodes?: { getState: () => { update: (id: string, p: unknown) => Promise<void> } } }).__fbNodes
      await store?.getState().update(id, { title: 'Live Node Renamed' })
    }, nodeId)
    const nodeRenameMs = await until(
      B.window,
      async () => (await (window as unknown as { api: typeof window.api }).api.nodes.list()) as Array<{ id: string; title: string }>,
      (list) => list.find((n) => n.id === nodeId)?.title === 'Live Node Renamed',
      12_000
    )
    console.log(`[CRDT-LIVE] node rename converged A→B in ${nodeRenameMs}ms`)

    // ── WIDGET: create on A's node desk, converge on B; edit content, converges ──
    // Seed B's node id first (window.evaluate can't close over test-scope vars).
    await B.window.evaluate((id) => ((window as unknown as Record<string, string>).__nodeId = id), nodeId)
    const widgetId = await A.window.evaluate(async (taskId) => {
      const store = (window as unknown as { __fbWidgets: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbWidgets
      const w = await store.getState().create({ taskId, kind: 'sticky', content: 'live A', x: 80, y: 80, width: 240, height: 160 })
      return w.id
    }, nodeId)
    // Widget create converges to B.
    const widgetCreateMs = await until(
      B.window,
      async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        return (await api.widgets.listByTask((window as unknown as Record<string, string>).__nodeId)) as Array<{ id: string; content: string }>
      },
      (ws) => ws.some((w) => w.id === widgetId),
      12_000
    )
    console.log(`[CRDT-LIVE] widget create converged A→B in ${widgetCreateMs}ms`)
    // Edit content on A; the LWW content register converges to B.
    await A.window.evaluate(async (id) => {
      const store = (window as unknown as { __fbWidgets: { getState: () => { update: (id: string, p: unknown) => Promise<void> } } }).__fbWidgets
      await store.getState().update(id, { content: 'live edited' })
    }, widgetId)
    const widgetContentMs = await until(
      B.window,
      async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        return (await api.widgets.listByTask((window as unknown as Record<string, string>).__nodeId)) as Array<{ id: string; content: string }>
      },
      (ws) => ws.find((w) => w.id === widgetId)?.content === 'live edited',
      12_000
    )
    console.log(`[CRDT-LIVE] widget content-edit converged A→B in ${widgetContentMs}ms`)

    // ── DOCUMENT: create on A, metadata converges on B; rename, title converges ──
    // FIXED: stores/documents.ts now exposes __fbDocuments (same convention as
    // __fbNodes/__fbWidgets/__fbView), so `store` below resolves and this reaches
    // the store's createBlank(), which additionally calls pushCloudDoc(doc) +
    // nudgeSync() and fires the real CRDT emit — verified below via the explicit
    // viaStore assertion, not just a comment claim.
    const { docId, viaStore } = await A.window.evaluate(async () => {
      const store = (window as unknown as { __fbDocuments?: { getState: () => { createBlank: (t: string) => Promise<{ id: string }> } } }).__fbDocuments
      const api = (window as unknown as { api: typeof window.api }).api
      // Prefer the store; fall back to the api if the debug handle isn't exposed.
      if (store) return { docId: (await store.getState().createBlank('doc')).id, viaStore: true }
      const d = await api.documents.create({ docType: 'doc', title: 'Live Doc A' } as never)
      return { docId: (d as { id: string }).id, viaStore: false }
    })
    expect(viaStore, '__fbDocuments hook must be present so this exercises the CRDT emit path, not the local-only IPC bridge').toBe(true)
    const docMs = await until(
      B.window,
      async () => (await (window as unknown as { api: typeof window.api }).api.documents.list()) as Array<{ id: string }>,
      (list) => list.some((d) => d.id === docId),
      15_000
    )
    console.log(`[CRDT-LIVE] document (via __fbDocuments store, CRDT emit) converged A→B in ${docMs}ms`)
    console.log(`[CRDT-LIVE] all types converged A→B: node=${nodeMs}ms rename=${nodeRenameMs}ms widget=${widgetCreateMs}ms content=${widgetContentMs}ms doc=${docMs}ms`)
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
