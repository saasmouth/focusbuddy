/**
 * E2E: WS01 cross-account substrate — SHARED-DESK convergence. Two DIFFERENT
 * accounts, A shares a desk with B by name (per-desk ACL, not org membership), and
 * an edit A makes on that desk reaches B via the `<type>:desk:<rootId>` partition —
 * authorised server-side by the desk's resource ACL (acls.authorize).
 *
 * The share flow (create desk, share by email via the real Live-sharing dialog, B
 * receives it) is the one proven in deskShareTwoWindowLive.spec.ts; this spec adds
 * the CRDT flags and asserts the edit converges over the desk partition. Sharing
 * stamps shared_root_id across BOTH the owner's and the grantee's subtree, so both
 * sides route to the same desk partition (crdtObjectScope → desk:<root>).
 *
 * HARNESS (identical to the other live specs — signal:8792 + tls-proxy:8793 + app
 * built against the proxy). Self-skips unless CRDT_LIVE_PROXY_BASE is set.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
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
  const userDataDir = mkdtempSync(join(tmpdir(), `fb-crdtdesk-${label}-`))
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
    for (const k of ['widgets', 'nodes', 'tables', 'timeblocks', 'files', 'documents']) {
      localStorage.setItem(`fb.sync.crdt.${k}`, '1')
    }
  })
  await window.reload()
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

test('shared desk: A shares with B, an edit on the desk converges via the desk partition', async () => {
  test.setTimeout(220_000)
  const rand = Date.now()
  const emailA = `crdt.desk.a.${rand}@example.com`
  const emailB = `crdt.desk.b.${rand}@example.com`
  const password = 'Test-Account-123!'
  const A = await launch('A')
  const B = await launch('B')
  try {
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    await signUp(A.window, emailA, password)
    await signUp(B.window, emailB, password) // B must exist so the share resolves to a grant

    // A creates a desk (task node). IPC-driven; desk-creation UI is covered elsewhere.
    const deskId = await A.window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const n = await api.nodes.create({ parentId: null, kind: 'task', title: 'Shared Desk' } as never)
      return (n as { id: string }).id
    })
    await A.window.reload()
    await dismissOnboarding(A.window)

    // A shares the desk with B via the real Live-sharing dialog (livedesk-email/add).
    await A.window.getByRole('button', { name: 'All desks' }).click()
    const card = A.window.locator(`[data-testid="index-card-${deskId}"]`)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.locator('button[title="Create a public link — anyone with it can view this desk"]').click()
    await expect(A.window.locator('[data-testid="livedesk-email"]')).toBeVisible({ timeout: 5_000 })
    await A.window.locator('[data-testid="livedesk-email"]').fill(emailB)
    await A.window.locator('[data-testid="livedesk-add"]').click()
    await expect(
      A.window.getByText(new RegExp(`${emailB.replace(/[.+]/g, '\\$&')} now has live access`, 'i'))
    ).toBeVisible({ timeout: 8_000 })

    // B receives the shared desk into its local DB (materialised with shared_root_id).
    await until(
      B.window,
      async () => (await (window as unknown as { api: typeof window.api }).api.nodes.list()) as Array<{ id: string }>,
      (nodes) => nodes.some((n) => n.id === deskId),
      12_000
    )

    // Flags on both; reload so the engine boots and (via the node-store subscription)
    // joins the desk partition for the now-present shared desk.
    await enableAllFlagsReload(A.window)
    await enableAllFlagsReload(B.window)
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    // Open the desk on both so its widgets are loaded (and B is joined to w:desk:).
    for (const w of [A.window, B.window]) {
      await w.evaluate((id) => {
        const view = (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView
        view?.getState()?.goTask?.(id)
      }, deskId)
    }
    await A.window.waitForTimeout(500)

    // A creates a widget on the shared desk → routes to w:desk:<deskId> → B converges.
    const widgetId = await A.window.evaluate(async (taskId) => {
      const store = (window as unknown as { __fbWidgets: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbWidgets
      const wgt = await store.getState().create({ taskId, kind: 'sticky', content: 'desk A', x: 90, y: 90, width: 240, height: 160 })
      return wgt.id
    }, deskId)
    const createMs = await until(
      B.window,
      async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        return (await api.widgets.listByTask((window as unknown as { __deskId: string }).__deskId)) as Array<{ id: string; content: string }>
      },
      (ws) => ws.some((w) => w.id === widgetId),
      15_000
    ).catch(async () => {
      await B.window.evaluate((id) => ((window as unknown as Record<string, string>).__deskId = id), deskId)
      return until(
        B.window,
        async () => {
          const api = (window as unknown as { api: typeof window.api }).api
          return (await api.widgets.listByTask((window as unknown as Record<string, string>).__deskId)) as Array<{ id: string; content: string }>
        },
        (ws) => ws.some((w) => w.id === widgetId),
        15_000
      )
    })

    // A edits the widget's content → the LWW content register converges to B.
    await B.window.evaluate((id) => ((window as unknown as Record<string, string>).__deskId = id), deskId)
    await A.window.evaluate(async (id) => {
      const store = (window as unknown as { __fbWidgets: { getState: () => { update: (i: string, p: unknown) => Promise<void> } } }).__fbWidgets
      await store.getState().update(id, { content: 'desk edited' })
    }, widgetId)
    const editMs = await until(
      B.window,
      async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        return (await api.widgets.listByTask((window as unknown as Record<string, string>).__deskId)) as Array<{ id: string; content: string }>
      },
      (ws) => ws.find((w) => w.id === widgetId)?.content === 'desk edited',
      15_000
    )

    console.log(`[CRDT-DESK] shared-desk convergence: widget create ${createMs}ms, content-edit ${editMs}ms (desk ${deskId})`)
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
