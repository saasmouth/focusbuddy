/**
 * E2E: WS01 cross-account substrate — SHARED-DESK WIRE convergence. Two DIFFERENT
 * accounts; A shares a desk with B by name (per-desk ACL); A draws a connector wire
 * between two widgets on that desk, and the wire (its existence, its type, its
 * deletion) reaches B via the `l:desk:<rootId>` partition — the same desk room the
 * widgets already converge in, authorised by the desk's resource ACL.
 *
 * Before this, a shared desk synced widgets/nodes/tables/rows but NOT its wires — a
 * grantee never saw the connectors. This proves wires now converge too, which is the
 * missing content type for a fully-shared canvas (and the prerequisite for a
 * lock-free live canvas on the substrate).
 *
 * HARNESS (identical to the other live specs — signal:8792 + tls-proxy:8793 + app
 * built against the proxy). Self-skips unless CRDT_LIVE_PROXY_BASE is set.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDeskShareSheet, shareLiveWithAccount } from './_liveShareHelpers'

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
  const userDataDir = mkdtempSync(join(tmpdir(), `fb-crdtwire-${label}-`))
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

async function enableAllFlagsReload(window: Page): Promise<void> {
  await window.evaluate(() => {
    for (const k of ['widgets', 'nodes', 'tables', 'timeblocks', 'files', 'documents', 'links', 'livefolders']) {
      localStorage.setItem(`fb.sync.crdt.${k}`, '1')
    }
  })
  await window.reload()
}

async function until<T, A>(
  window: Page,
  arg: A,
  fn: (a: A) => Promise<T>,
  pred: (v: T) => boolean,
  ms = 15_000
): Promise<number> {
  const start = Date.now()
  for (;;) {
    const v = await window.evaluate(fn, arg)
    if (pred(v)) return Date.now() - start
    if (Date.now() - start > ms) throw new Error(`converge timeout ${ms}ms; last=${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

// B-side reader: the wires on the shared desk, straight from the DB via IPC.
async function linksOf(deskId: string): Promise<Array<{ id: string; type: string; sourceWidgetId: string; targetWidgetId: string }>> {
  const api = (window as unknown as { api: typeof window.api }).api
  return (await api.widgetLinks.listByTask(deskId)) as Array<{
    id: string
    type: string
    sourceWidgetId: string
    targetWidgetId: string
  }>
}

test.describe.configure({ mode: 'serial' })

test('shared desk: a wire A draws between two widgets converges to B via the desk partition', async () => {
  test.setTimeout(220_000)
  const rand = Date.now()
  const emailA = `crdt.wire.a.${rand}@example.com`
  const emailB = `crdt.wire.b.${rand}@example.com`
  const password = 'Test-Account-123!'
  const A = await launch('A')
  const B = await launch('B')
  try {
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    await signUp(A.window, emailA, password)
    await signUp(B.window, emailB, password)

    // A creates a desk (task node).
    const deskId = await A.window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const n = await api.nodes.create({ parentId: null, kind: 'task', title: 'Wired Desk' } as never)
      return (n as { id: string }).id
    })
    await A.window.reload()
    await dismissOnboarding(A.window)

    // A shares the desk with B via the real Live-sharing dialog.
    await openDeskShareSheet(A.window, deskId)
    await shareLiveWithAccount(A.window, emailB)

    // B receives the shared desk.
    await until(
      B.window,
      deskId,
      async (id) => (await (window as unknown as { api: typeof window.api }).api.nodes.list()) as Array<{ id: string }>,
      (nodes) => nodes.some((n) => (n as { id: string }).id === deskId),
      12_000
    )

    await enableAllFlagsReload(A.window)
    await enableAllFlagsReload(B.window)
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    for (const w of [A.window, B.window]) {
      await w.evaluate((id) => {
        const view = (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView
        view?.getState()?.goTask?.(id)
      }, deskId)
    }
    await A.window.waitForTimeout(500)

    // A creates two widgets on the shared desk (they converge to B via w:desk:).
    const [w1, w2] = await A.window.evaluate(async (taskId) => {
      const store = (window as unknown as { __fbWidgets: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbWidgets
      const a = await store.getState().create({ taskId, kind: 'sticky', content: 'A', x: 60, y: 60, width: 200, height: 140 })
      const b = await store.getState().create({ taskId, kind: 'sticky', content: 'B', x: 380, y: 60, width: 200, height: 140 })
      return [a.id, b.id]
    }, deskId)
    // B must have both widgets before the wire can resolve its endpoints.
    await until(B.window, deskId, async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return (await api.widgets.listByTask(id)) as Array<{ id: string }>
    }, (ws) => ws.some((w) => w.id === w1) && ws.some((w) => w.id === w2), 15_000)

    // A draws a wire w1 -> w2 via the real links store (emits the CRDT create).
    const linkId = await A.window.evaluate(async ({ taskId, s, t }) => {
      const store = (window as unknown as { __fbLinks: { getState: () => { create: (s: string, t: string, task: string) => Promise<{ id: string } | null> } } }).__fbLinks
      const l = await store.getState().create(s, t, taskId)
      return l?.id ?? ''
    }, { taskId: deskId, s: w1, t: w2 })
    expect(linkId).not.toBe('')

    // B converges: the wire appears with the right endpoints via l:desk:.
    const createMs = await until(B.window, deskId, linksOf, (ls) => ls.some((l) => l.id === linkId && l.sourceWidgetId === w1 && l.targetWidgetId === w2), 15_000)

    // A retypes the wire to 'transform' → B converges (LWW attr).
    await A.window.evaluate(async (id) => {
      const store = (window as unknown as { __fbLinks: { getState: () => { update: (id: string, p: unknown) => Promise<void> } } }).__fbLinks
      await store.getState().update(id, { type: 'transform' })
    }, linkId)
    const typeMs = await until(B.window, deskId, linksOf, (ls) => ls.find((l) => l.id === linkId)?.type === 'transform', 15_000)

    // A deletes the wire → B converges to it being gone (remove-wins).
    await A.window.evaluate(async (id) => {
      const store = (window as unknown as { __fbLinks: { getState: () => { remove: (id: string) => Promise<void> } } }).__fbLinks
      await store.getState().remove(id)
    }, linkId)
    const deleteMs = await until(B.window, deskId, linksOf, (ls) => !ls.some((l) => l.id === linkId), 15_000)

    console.log(`[CRDT-WIRE] shared-desk wire convergence: create ${createMs}ms, retype ${typeMs}ms, delete ${deleteMs}ms (desk ${deskId})`)
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
