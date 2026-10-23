/**
 * E2E: WS01 lock-retire Stage C — a legacy live canvas converts to a real desk when
 * opened. The live-canvas mechanism (mirror + check-out lock) is retired; existing
 * docType:'canvas' live-docs are converted on open from Collaborations into a real
 * desk (their board materialised via applyCanvasBodyToTask), which then rides the
 * substrate like any other desk. This proves the migration path end to end.
 *
 * Single account (no convergence needed): A creates a 'canvas' live-doc with two
 * widgets + a wire via the signal REST (the shape promoteToLiveCanvas used to mint),
 * opens Collaborations, clicks the canvas row, and lands on a REAL desk (view kind
 * 'task') carrying both widgets.
 *
 * HARNESS (signal :8792 + tls-proxy :8793 + app built against the proxy). Self-skips
 * unless CRDT_LIVE_PROXY_BASE is set.
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
  const userDataDir = mkdtempSync(join(tmpdir(), `fb-crdtcv-${label}-`))
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.ANTHROPIC_API_KEY
  delete cleanEnv.OPENAI_API_KEY
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

test.describe.configure({ mode: 'serial' })

test('a legacy live canvas converts to a real desk on open', async () => {
  test.setTimeout(180_000)
  const rand = Date.now()
  const email = `crdt.cv.${rand}@example.com`
  const A = await launch('A')
  try {
    await dismissOnboarding(A.window)
    await signUp(A.window, email, 'Test-Account-123!')

    // Create a legacy 'canvas' live-doc (the shape promoteToLiveCanvas used to mint):
    // a CanvasBody with two widgets and a wire between them.
    const base = PROXY_BASE as string
    const canvasId = await A.window.evaluate(async (apiBase) => {
      const tok = (window as unknown as { __fbAccount: { getState: () => { sessionToken: string } } }).__fbAccount
        .getState().sessionToken
      const body = JSON.stringify({
        version: 1,
        title: 'Legacy Canvas',
        widgets: [
          { id: 'lw1', kind: 'sticky', title: 'One', content: 'first', x: 60, y: 60, width: 200, height: 140 },
          { id: 'lw2', kind: 'sticky', title: 'Two', content: 'second', x: 360, y: 60, width: 200, height: 140 }
        ],
        links: [{ sourceWidgetId: 'lw1', targetWidgetId: 'lw2', type: 'context', verb: '', enabled: true }]
      })
      const created = await fetch(`${apiBase}/livedocs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ docType: 'canvas', title: 'Legacy Canvas', body })
      }).then((r) => r.json())
      return created.doc.id as string
    }, base)

    // Open Collaborations and click the canvas row. It must convert to a real desk.
    await A.window.evaluate(() => {
      const view = (window as unknown as { __fbView?: { getState: () => { goCollaborations: () => void } } }).__fbView
      view?.getState()?.goCollaborations?.()
    })
    const row = A.window.locator('[data-testid="collaboration-item"]').filter({ hasText: 'Legacy Canvas' })
    await expect(row).toBeVisible({ timeout: 12_000 })
    await row.click()

    // Landed on a real desk (view kind 'task'), NOT a livecanvas view (which no
    // longer exists), and the converted desk carries both widgets from the body.
    const result = await (async () => {
      const start = Date.now()
      for (;;) {
        const v = await A.window.evaluate(async () => {
          const view = (window as unknown as { __fbView: { getState: () => { view: { kind: string; taskId?: string } } } }).__fbView.getState().view
          if (view.kind !== 'task' || !view.taskId) return { ready: false as const }
          const api = (window as unknown as { api: typeof window.api }).api
          const widgets = (await api.widgets.listByTask(view.taskId)) as Array<{ content: string }>
          return { ready: true as const, kind: view.kind, count: widgets.length, contents: widgets.map((w) => w.content).sort() }
        })
        if (v.ready && v.count >= 2) return { ...v, ms: Date.now() - start }
        if (Date.now() - start > 15_000) throw new Error(`convert timeout; last=${JSON.stringify(v)}`)
        await new Promise((r) => setTimeout(r, 300))
      }
    })()

    expect(result.kind).toBe('task')
    expect(result.contents).toContain('first')
    expect(result.contents).toContain('second')
    console.log(`[CRDT-CONVERT] legacy canvas ${canvasId} converted to a real desk with ${result.count} widgets in ${result.ms}ms`)
  } finally {
    await A.dispose()
  }
})
