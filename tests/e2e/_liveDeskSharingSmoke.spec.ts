/**
 * ONE-OFF verification spec for plexidesk-tester: per-desk live sharing (ACL-scoped).
 * Covers checks 1-3 from the dispatch brief against the BUILT app (default prod-signal
 * build — no server round trip needed since these checks are boot/UI/preload-only):
 *   1. App boots with the shared_root_id migration applied, no crash.
 *   2. Share dialog on a task desk renders "Live sharing (real-time)" with
 *      data-testid="livedesk-email" / "livedesk-add", no console errors.
 *   3. window.api.workspaceSync.{pendingShared,applyRemoteShared,getCursorShared,
 *      localSharedRoots,adoptSharedDesk,stampSharedDesk,pruneSharedDesk} are all
 *      callable without throwing (preload wiring proof).
 *
 * Driven via: IPC to create the desk (deterministic), then a REAL UI click through
 * DesksView's "Create a public link" button (title attr) to open ShareDialog
 * kind="task", which is the same universal dialog LiveDeskSharing mounts inside for
 * both 'folder' and 'task' kinds (see ShareDialog.tsx line ~280).
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('desk share dialog renders live sharing UI + preload surface is wired, no crash', async () => {
  launched = await launchApp()
  const { window, app } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  // ── Check 1: boot survives the shared_root_id migration ──────────────────
  await waitForReady(window)
  const mainAlive = !app.process().killed
  expect(mainAlive, 'main process must still be alive after boot').toBe(true)

  // Confirm the migration actually landed (column exists on all 4 tables) by
  // creating rows and reading them back through the real IPC surface — if the
  // migration had failed, nodes.create would already have thrown above.
  const deskTitle = `LiveShare Smoke ${Date.now()}`
  const deskId = await window.evaluate(async (title) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const node = await api.nodes.create({ parentId: null, kind: 'task', title } as never)
    return (node as unknown as { id: string }).id
  }, deskTitle)
  expect(deskId).toBeTruthy()

  // ── Check 3: every new preload method is callable without throwing ───────
  const preloadProbe = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const out: Record<string, { ok: boolean; error?: string }> = {}
    const probe = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn()
        out[name] = { ok: true }
      } catch (e) {
        out[name] = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    const ws = api.workspaceSync as unknown as {
      pendingShared: () => Promise<unknown>
      applyRemoteShared: (items: unknown[]) => Promise<unknown>
      getCursorShared: () => Promise<unknown>
      localSharedRoots: () => Promise<unknown>
      adoptSharedDesk: (rootId: string) => Promise<unknown>
      stampSharedDesk: (rootId: string) => Promise<unknown>
      pruneSharedDesk: (rootId: string) => Promise<unknown>
    }
    await probe('pendingShared', () => ws.pendingShared())
    await probe('applyRemoteShared', () => ws.applyRemoteShared([]))
    await probe('getCursorShared', () => ws.getCursorShared())
    await probe('localSharedRoots', () => ws.localSharedRoots())
    await probe('adoptSharedDesk', () => ws.adoptSharedDesk('nonexistent-root-id'))
    await probe('stampSharedDesk', () => ws.stampSharedDesk('nonexistent-root-id'))
    await probe('pruneSharedDesk', () => ws.pruneSharedDesk('nonexistent-root-id'))
    return out
  })
  for (const [name, result] of Object.entries(preloadProbe)) {
    expect(result.ok, `${name} must be callable without throwing: ${result.error ?? ''}`).toBe(true)
  }

  // stampSharedDesk on our real desk should actually stamp it (real DB round trip,
  // not just "didn't throw"), and localSharedRoots should then report it.
  const stampedIds = await window.evaluate(async (rootId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.workspaceSync.stampSharedDesk(rootId)
  }, deskId)
  expect(stampedIds).toContain(deskId)
  const localRoots = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.workspaceSync.localSharedRoots()
  })
  expect(localRoots).toContain(deskId)
  // Un-stamp so it doesn't pollute check 2's fresh share-dialog read below.
  await window.evaluate(async (rootId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.workspaceSync.pruneSharedDesk(rootId)
  }, deskId)

  // ── Check 2: open the real Share dialog via a real UI click and assert the
  // Live sharing section renders ──────────────────────────────────────────
  const deskTitle2 = `LiveShare UI Desk ${Date.now()}`
  const deskId2 = await window.evaluate(async (title) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const node = await api.nodes.create({ parentId: null, kind: 'task', title } as never)
    return (node as unknown as { id: string }).id
  }, deskTitle2)

  // The renderer's node store is populated by its own store actions, not by a bare
  // IPC call made from the test — reload so DesksView's useNodeStore selector picks
  // up the freshly-created row from the DB (same technique acceptShare.spec.ts and
  // shareInvite.spec.ts use after IPC-seeding data).
  await window.reload()
  await waitForReady(window)

  // Navigate via the real sidebar "All desks" row (goDesks view) — the gallery
  // that renders task-kind desks as cards with the share/link actions.
  await window.getByRole('button', { name: 'All desks' }).click()
  const card = window.locator(`[data-testid="index-card-${deskId2}"]`)
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('button[title="Create a public link — anyone with it can view this desk"]').click()

  const dialog = window.locator('[role="dialog"]').filter({ hasText: 'Share' }).first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  const liveSection = window.getByText('Live sharing (real-time)')
  await expect(liveSection).toBeVisible({ timeout: 5_000 })
  const emailInput = window.locator('[data-testid="livedesk-email"]')
  const addButton = window.locator('[data-testid="livedesk-add"]')
  await expect(emailInput).toBeVisible()
  await expect(addButton).toBeVisible()

  // Type an email to prove the input is wired (state updates enable the button).
  await emailInput.fill('teammate@example.com')
  await expect(addButton).toBeEnabled()

  // No page errors and no console.error entries during the whole flow.
  expect(pageErrors, `page errors: ${JSON.stringify(pageErrors)}`).toHaveLength(0)
  const seriousConsoleErrors = consoleErrors.filter(
    (m) => !/Download the React DevTools|WebSocket connection|net::ERR_/.test(m)
  )
  expect(seriousConsoleErrors, `console errors: ${JSON.stringify(seriousConsoleErrors)}`).toHaveLength(0)
})
