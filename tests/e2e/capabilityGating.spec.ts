import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, sideMenuWidget, waitForReady } from './_helpers'

// In-app runtime proof that the capability matrix gates the desktop UI.
//
// A signed-out user resolves to the FREE tier (the capability store's
// offline fallback). On Free, widget_table is false, so the Table tile in
// the side menu's Widgets section must render LOCKED and open the upgrade
// prompt instead of creating a table — while an ungated tile (Sticky) stays a
// normal one. This exercises the real wiring: capability store → gating.ts →
// WidgetsSection → UpgradePromptModal. (It was the hover WidgetPalette until
// 4.3.32 removed it.)

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function bootAndOpenCanvas(l: LaunchedApp): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Gating test' })
  })
  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'Gating test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
}

// 4.3.32: the hover widget palette these two drove is gone; widgets are added
// from the side menu's Widgets section. The gate is the same one
// (canCreateWidget over the capability store) on the new surface: a locked
// kind still shows — it says why on click — and is marked data-locked.
test('Free tier: Table widget is locked in the side menu, Sticky is not', async () => {
  launched = await launchApp()
  await bootAndOpenCanvas(launched)
  const { window } = launched

  await waitForReady(window)
  // Ungated widget → a normal tile.
  const sticky = await sideMenuWidget(window, 'sticky')
  await expect(sticky).toBeVisible()
  await expect(sticky).not.toHaveAttribute('data-locked', 'true')

  // Gated widget (widget_table=false on free) → the locked variant.
  const table = await sideMenuWidget(window, 'table')
  await expect(table).toHaveAttribute('data-locked', 'true')
})

test('Clicking a locked widget opens the upgrade prompt', async () => {
  launched = await launchApp()
  await bootAndOpenCanvas(launched)
  const { window } = launched

  await waitForReady(window)
  await (await sideMenuWidget(window, 'table')).click()

  await expect(window.locator('[data-testid="upgrade-prompt-modal"]')).toBeVisible()
  await expect(window.locator('[data-testid="upgrade-reason"]')).toContainText(/Table/i)
})

// ── Desk limit (multiple_desks: free = 3) ──────────────────────────────
test('Free tier: 4th top-level desk is blocked with an upgrade prompt', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  // Seed exactly 3 top-level folders (the free desk limit) via the API.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    for (let i = 1; i <= 3; i++) {
      await api.nodes.create({ parentId: null, kind: 'folder', title: `Desk ${i}` })
    }
  })
  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})

  // Click "New top-level project" — at the limit, the upgrade prompt opens
  // and the create dialog does NOT.
  await window.locator('button[title="New top-level project"]').first().click()
  await expect(window.locator('[data-testid="upgrade-prompt-modal"]')).toBeVisible()
  await expect(window.locator('[data-testid="upgrade-reason"]')).toContainText(/desk limit/i)

  // Hard backstop: the store refused to persist a 4th — still exactly 3.
  const deskCount = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.nodes.list()
    return all.filter((n: { parentId: string | null; kind: string }) => n.parentId === null && n.kind === 'folder').length
  })
  expect(deskCount).toBe(3)
})

// ── CommandCenter spawn gate (second table-creation path) ──────────────
test('Free tier: Table is locked in the CommandCenter quick-actions too', async () => {
  launched = await launchApp()
  await bootAndOpenCanvas(launched)
  const { window } = launched

  await waitForReady(window)
  // With a task on the canvas, the CommandCenter exposes widget quick-action
  // pills (Note, Table, …). The Table pill must open the upgrade prompt
  // instead of creating a table — proving the gate covers this path too.
  const tablePill = window.getByRole('button', { name: 'Table' }).first()
  await expect(tablePill).toBeVisible({ timeout: 5_000 })
  await tablePill.click()
  await expect(window.locator('[data-testid="upgrade-prompt-modal"]')).toBeVisible()
})
