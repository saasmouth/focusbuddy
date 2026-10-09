import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Two asks, 2026-10-09:
//  - hovering the minimap lists every item on the desk as a camera shortcut,
//    newest touched first
//  - the add-widget button should stand out
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

async function openDeskWithWidgets(window: import('@playwright/test').Page): Promise<void> {
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.nodes.create({ parentId: null, kind: 'task', title: 'Jump desk' })
    await api.widgets.create({ taskId: d.id, kind: 'note', title: 'Older note', content: '', x: 40, y: 40, width: 200, height: 160 })
    await api.widgets.create({ taskId: d.id, kind: 'table', title: 'Newer table', content: '', x: 900, y: 700, width: 240, height: 180 })
    return d.id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((i) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(i)
  }, id)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })
}

test('hovering the minimap lists every item, newest touched first, and jumps the camera', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDeskWithWidgets(window)

  const fab = window.locator('[data-minimap-fab]')
  await expect(fab).toBeVisible({ timeout: 8000 })
  // Not shown until hovered — it must not cost permanent screen space.
  await expect(window.locator('[data-testid="desk-jump-list"]')).toHaveCount(0)

  await fab.hover()
  const list = window.locator('[data-testid="desk-jump-list"]')
  await expect(list).toBeVisible({ timeout: 4000 })

  // Both items named, and the one created last is first.
  const rows = list.locator('[role="menuitem"]')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Newer table')
  await expect(list).toContainText('Older note')

  // Clicking moves the camera.
  const before = await window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { panX: number; panY: number } } }
    return w.__fbWidgets?.getState()
  })
  await rows.first().click()
  await window.waitForTimeout(300)
  const after = await window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { panX: number; panY: number } } }
    return w.__fbWidgets?.getState()
  })
  if (before && after) {
    expect(
      Math.abs(after.panX - before.panX) + Math.abs(after.panY - before.panY),
      'the camera moved'
    ).toBeGreaterThan(1)
  }
})

test('the prominent add button is in the header; the rail keeps its labelled one', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDeskWithWidgets(window)

  // The discoverable one is centred in the header and labelled. An icon-only
  // purple plus in the rail's collapsed header was tried first and read as a
  // bare "+" with nothing to say what it did, so the rail went back to what it
  // was and the prominent control moved to the header.
  const header = window.locator('[data-testid="header-add-widget"]')
  await expect(header).toBeVisible({ timeout: 8000 })
  await expect(header).toContainText('Add widget')

  // The rail is untouched: no stray plus in its collapsed header, and the
  // labelled palette button still appears when the rail is hovered.
  await expect(window.locator('[data-testid="palette-rail-button"]')).toHaveCount(0)
  const rail = window.locator('[data-testid="floating-toolbar"]')
  if (await rail.count()) {
    await rail.hover()
    await expect(window.locator('[data-testid="palette-add-button"]')).toBeVisible({ timeout: 4000 })
  }
})
