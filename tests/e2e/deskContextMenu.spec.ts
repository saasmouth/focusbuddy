import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The desk context menu: where you are, who is here, and what you can do, in
// ONE vertical menu.
//
// This was canvasBreadcrumb.spec.ts, and it tested the same thing through a
// different control — a hover-expanding pill that floated over the canvas
// alongside a separate presence bar. The two were combined into this menu
// (2026-10-09) because they both answered "what am I looking at" and neither
// could be read without pointing at it. The INTENT of the old test is kept
// verbatim: the trail is derived from the node tree, and an ancestor navigates.
// What changed is that the trail is now a vertical list you can read at a
// glance instead of a sideways pill you had to hover.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('the trail is the node tree, read top to bottom, and an ancestor navigates', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const folder = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Projects' })
    const task = await api.nodes.create({ parentId: folder.id, kind: 'task', title: 'Website redesign' })
    return { folderId: folder.id, taskId: task.id }
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Website redesign/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // The trigger names the desk WITHOUT being opened — the pill only showed the
  // trail while the pointer was on it.
  const trigger = window.locator('[data-testid="desk-context-trigger"]')
  await expect(trigger).toBeVisible({ timeout: 6_000 })
  await expect(trigger).toContainText('Website redesign')

  await trigger.click()
  const menu = window.locator('[data-testid="desk-context-menu"]')
  await expect(menu).toBeVisible()

  // The whole trail is readable at once, in order.
  const trail = window.locator('[data-testid="desk-context-trail"]')
  await expect(trail).toContainText('Workspace home')
  await expect(trail).toContainText('Projects')
  await expect(trail).toContainText('Website redesign')
  await expect(window.locator('[data-testid="desk-context-current"]')).toContainText('Website redesign')
  await expect(window.locator(`[data-testid="desk-context-node-${seeded.folderId}"]`)).toBeVisible()

  // And it navigates — the assertion the old spec's header claimed but never made.
  await window.locator(`[data-testid="desk-context-node-${seeded.folderId}"]`).click()
  await expect(menu).toHaveCount(0)
  const view = await window.evaluate(
    () =>
      (window as unknown as { __fbView?: { getState: () => { view: { kind: string; roomId?: string } } } })
        .__fbView?.getState().view
  )
  // A room opens as the desks it contains (4.3.14), scoped to that room.
  expect(view?.kind).toBe('desks')
  expect(view?.roomId).toBe(seeded.folderId)
})

test('the desk actions live in the same menu', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Actions desk' })
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Actions desk/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.locator('[data-testid="desk-context-trigger"]').click()

  // Everything the pill carried is still reachable, now as rows rather than
  // icons crowded into a strip.
  await expect(window.locator('[data-testid="desk-context-rename"]')).toBeVisible()
  await expect(window.locator('[data-testid="desk-context-share"]')).toBeVisible()
  await expect(window.locator('[data-testid="desk-context-move"]')).toBeVisible()

  // Rename happens in place.
  await window.locator('[data-testid="desk-context-rename"]').click()
  const input = window.locator('[data-testid="desk-context-rename-input"]')
  await expect(input).toBeVisible()
  await input.fill('Renamed from the menu')
  await input.press('Enter')
  await expect(window.locator('[data-testid="desk-context-trigger"]')).toContainText(
    'Renamed from the menu',
    { timeout: 6_000 }
  )
})
