/**
 * E2E: WS01 lock-retire Stage B — a wire that already exists on a desk BEFORE it is
 * shared must reach the grantee. The poll's shared cycle stamps + carries
 * widgets/nodes/tables/rows but NOT widget_links, so pre-existing wires would be
 * invisible to a grantee unless they are seeded onto the substrate at share time.
 * shareDeskLive() now calls seedDeskLinks(rootId), which emits a create for every
 * existing wire on the desk explicitly to `l:desk:<rootId>`.
 *
 * This is the baseline case the earlier wire spec did not cover (that one draws the
 * wire AFTER sharing, so it rides the normal live emit). Here A builds the whole
 * board first, THEN shares, and B must still see the connector. This is exactly the
 * fidelity the old live-canvas whole-body serialize gave, preserved as the canvas
 * consolidates onto shared desks.
 *
 * HARNESS (identical to the other live specs). Self-skips unless CRDT_LIVE_PROXY_BASE.
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
  const userDataDir = mkdtempSync(join(tmpdir(), `fb-crdtwb-${label}-`))
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

async function linksOf(deskId: string): Promise<Array<{ id: string; sourceWidgetId: string; targetWidgetId: string }>> {
  const api = (window as unknown as { api: typeof window.api }).api
  return (await api.widgetLinks.listByTask(deskId)) as Array<{ id: string; sourceWidgetId: string; targetWidgetId: string }>
}

test.describe.configure({ mode: 'serial' })

test('a wire drawn BEFORE sharing is seeded to the grantee when the desk is shared', async () => {
  test.setTimeout(220_000)
  const rand = Date.now()
  const emailA = `crdt.wb.a.${rand}@example.com`
  const emailB = `crdt.wb.b.${rand}@example.com`
  const password = 'Test-Account-123!'
  const A = await launch('A')
  const B = await launch('B')
  try {
    await dismissOnboarding(A.window)
    await dismissOnboarding(B.window)
    await signUp(A.window, emailA, password)
    await signUp(B.window, emailB, password)

    // A builds the whole board FIRST: a desk, two widgets, and a wire between them —
    // all BEFORE any sharing, so the wire is a pre-existing baseline wire.
    const built = await A.window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const n = await api.nodes.create({ parentId: null, kind: 'task', title: 'Prewired Desk' } as never)
      const deskId = (n as { id: string }).id
      const wstore = (window as unknown as { __fbWidgets: { getState: () => { create: (d: unknown) => Promise<{ id: string }> } } }).__fbWidgets
      const a = await wstore.getState().create({ taskId: deskId, kind: 'sticky', content: 'A', x: 60, y: 60, width: 200, height: 140 })
      const b = await wstore.getState().create({ taskId: deskId, kind: 'sticky', content: 'B', x: 380, y: 60, width: 200, height: 140 })
      const lstore = (window as unknown as { __fbLinks: { getState: () => { create: (s: string, t: string, task: string) => Promise<{ id: string } | null> } } }).__fbLinks
      const l = await lstore.getState().create(a.id, b.id, deskId)
      return { deskId, w1: a.id, w2: b.id, linkId: l?.id ?? '' }
    })
    expect(built.linkId).not.toBe('')

    // A shares the desk with B through the real Live-sharing dialog. shareDeskLive
    // fires seedDeskLinks, which must carry the pre-existing wire to B.
    await A.window.reload()
    await dismissOnboarding(A.window)
    await openDeskShareSheet(A.window, built.deskId)
    await shareLiveWithAccount(A.window, emailB)

    // B receives the shared desk, then converges the PRE-EXISTING wire via the
    // seedDeskLinks baseline on l:desk:<rootId>.
    await until(
      B.window,
      built.deskId,
      async (id) => (await (window as unknown as { api: typeof window.api }).api.nodes.list()) as Array<{ id: string }>,
      (nodes) => nodes.some((n) => (n as { id: string }).id === built.deskId),
      12_000
    )
    const seedMs = await until(
      B.window,
      built.deskId,
      linksOf,
      (ls) => ls.some((l) => l.id === built.linkId && l.sourceWidgetId === built.w1 && l.targetWidgetId === built.w2),
      15_000
    )

    console.log(`[CRDT-WIRE-BASELINE] pre-existing wire seeded to grantee in ${seedMs}ms (desk ${built.deskId})`)
  } finally {
    await A.dispose()
    await B.dispose()
  }
})
