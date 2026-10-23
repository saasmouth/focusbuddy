/**
 * E2E: WS01 cross-account substrate — TWO DIFFERENT accounts in the SAME org,
 * proving org-scoped convergence over the real (proxied) socket. This is the gate
 * for the cross-account slice: A creates + edits objects while the org is active,
 * and B (a different account, same org) sees them via the `<type>:org:<orgId>`
 * partition — authorised server-side by orgs.isMember.
 *
 * Self-contained: it signs up both accounts, A creates an org (POST /orgs) and adds
 * B (POST /orgs/:id/members), both switch to the org, then convergence is asserted.
 *
 * HARNESS (identical to the other live specs — signal:8792 + tls-proxy:8793 + app
 * built against the proxy). Self-skips unless CRDT_LIVE_PROXY_BASE is set. Run via:
 *   cd projects/focusbuddy-signal && DB_PATH=<fresh> PORT=8792 npm run build && node dist/server.js
 *   node tests/e2e/support/tls-proxy.js 8793 8792
 *   VITE_USE_REMOTE_SIGNAL=true VITE_SIGNAL_HTTP_URL=https://localhost:8793 \
 *   VITE_SIGNAL_WS_URL=wss://localhost:8793/ws npm run build
 *   CRDT_LIVE_PROXY_BASE=https://localhost:8793 \
 *   npx playwright test tests/e2e/crdtOrgConvergeTwoAccountLive.spec.ts
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchGuarded } from './_netGuard'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROXY_BASE = process.env.CRDT_LIVE_PROXY_BASE

test.beforeAll(async () => {
  test.skip(!PROXY_BASE, 'CRDT_LIVE_PROXY_BASE not set — needs the purpose-built app + local TLS proxy. Skipping.')
})

interface Launched {
  app: ElectronApplication
  window: Page
  dispose: () => Promise<void>
}

async function launch(label: string): Promise<Launched> {
  const userDataDir = mkdtempSync(join(tmpdir(), `fb-crdtorg-${label}-`))
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

async function signUp(window: Page, email: string, password: string): Promise<void> {
  const d = window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(d).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: 'Sign up' }).click()
  await window.getByPlaceholder('you@example.com').fill(email)
  await window.getByPlaceholder('at least 8 characters').fill(password)
  await window.getByRole('button', { name: 'Create account' }).click()
  await expect(d).not.toBeVisible({ timeout: 10_000 })
}

async function sessionToken(window: Page): Promise<string> {
  const t = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const cached = (await api.account.load()) as { sessionToken?: string } | null
    return cached?.sessionToken ?? ''
  })
  if (!t) throw new Error('no session token after signup')
  return t
}

// A renderer-side fetch to the proxied signal (CSP allows https; the self-signed
// proxy cert is accepted via --ignore-certificate-errors).
async function apiPost(window: Page, base: string, path: string, token: string, body: unknown): Promise<unknown> {
  return window.evaluate(
    async ({ url, tok, b }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify(b)
      })
      return res.json()
    },
    { url: `${base}${path}`, tok: token, b: body }
  )
}

// Turn on all CRDT flags and reload so the engine boots with them set. Active org
// is switched AFTER, at runtime, so the engine's org subscription fires the re-route.
async function enableAllFlagsReload(window: Page): Promise<void> {
  await window.evaluate(() => {
    for (const k of ['widgets', 'nodes', 'tables', 'timeblocks', 'files', 'documents']) {
      localStorage.setItem(`fb.sync.crdt.${k}`, '1')
    }
  })
  await window.reload()
}

// Switch into the org through the org store (the same setActive the org-switcher UI
// calls), which updates useOrgStore.activeOrgId and fires the CRDT engine's org
// subscription → re-route to the org partition. load() first so the just-joined org
// is in the store. Asserts adoption so a setup failure fails fast + clearly.
async function switchToOrg(window: Page, orgId: string): Promise<void> {
  const active = await window.evaluate(async (id) => {
    const store = (window as unknown as { __fbOrg?: { getState: () => { load: () => Promise<void>; setActive: (o: string) => Promise<void>; activeOrgId: string } } }).__fbOrg
    if (!store) return '(no __fbOrg handle)'
    await store.getState().load()
    await store.getState().setActive(id)
    return store.getState().activeOrgId
  }, orgId)
  expect(active, 'both windows must actually adopt the org as active before convergence is meaningful').toBe(orgId)
}

async function until<T>(window: Page, fn: () => Promise<T>, pred: (v: T) => boolean, ms = 15_000): Promise<number> {
  const start = Date.now()
  for (;;) {
    const v = await window.evaluate(fn as unknown as () => Promise<T>)
    if (pred(v)) return Date.now() - start
    if (Date.now() - start > ms) throw new Error(`converge timeout ${ms}ms; last=${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

test.describe.configure({ mode: 'serial' })

test('two accounts in one org: A creates/edits, B converges via the org partition', async () => {
  test.setTimeout(200_000)
  const rand = Date.now()
  const emailA = `crdt.org.a.${rand}@example.com`
  const emailB = `crdt.org.b.${rand}@example.com`
  const password = 'Test-Account-123!'
  const A = await launch('A')
  const B = await launch('B')
  try {
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    await signUp(A.window, emailA, password)
    await signUp(B.window, emailB, password) // B's account must exist before A adds it

    // A creates an org and adds B as a member (server auth: A is the owner/admin).
    const tokenA = await sessionToken(A.window)
    const created = (await apiPost(A.window, PROXY_BASE!, '/orgs', tokenA, { name: `Live Org ${rand}` })) as {
      org?: { id: string }
      id?: string
    }
    const orgId = created.org?.id ?? created.id
    if (!orgId) throw new Error(`org create failed: ${JSON.stringify(created)}`)
    const added = (await apiPost(A.window, PROXY_BASE!, `/orgs/${orgId}/members`, tokenA, {
      email: emailB,
      role: 'member'
    })) as { ok?: boolean }
    expect(added.ok, `add member B failed: ${JSON.stringify(added)}`).toBe(true)

    // Flags on + reload so the engine boots, THEN switch into the org at runtime so
    // the engine's org subscription re-routes to the org partition on BOTH windows.
    await enableAllFlagsReload(A.window)
    await enableAllFlagsReload(B.window)
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    await switchToOrg(A.window, orgId)
    await switchToOrg(B.window, orgId) // asserts both actually adopt the org as active

    // A creates a node in the org (via the store, so crdtEmitNodeCreate fires).
    const nodeId = await A.window.evaluate(async () => {
      const store = (window as unknown as { __fbNodes: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbNodes
      const n = await store.getState().create({ parentId: null, kind: 'task', title: 'Org Node A' })
      return n.id
    })
    // B (different account, same org) sees it via `n:org:<orgId>`.
    const createMs = await until(
      B.window,
      async () => (await (window as unknown as { api: typeof window.api }).api.nodes.list()) as Array<{ id: string; title: string }>,
      (list) => list.some((n) => n.id === nodeId),
      15_000
    )
    // A renames; B converges on the title register.
    await A.window.evaluate(async (id) => {
      const store = (window as unknown as { __fbNodes: { getState: () => { update: (id: string, p: unknown) => Promise<void> } } }).__fbNodes
      await store.getState().update(id, { title: 'Org Node Renamed' })
    }, nodeId)
    const renameMs = await until(
      B.window,
      async () => (await (window as unknown as { api: typeof window.api }).api.nodes.list()) as Array<{ id: string; title: string }>,
      (list) => list.find((n) => n.id === nodeId)?.title === 'Org Node Renamed',
      15_000
    )

    console.log(`[CRDT-ORG] cross-account org convergence: create ${createMs}ms, rename ${renameMs}ms (org ${orgId})`)
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
