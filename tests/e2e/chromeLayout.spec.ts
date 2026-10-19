import { test, expect } from '@playwright/test'
import { hoverToolbar, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Chrome layout — verifies three coordinated changes:
//   1. (Superseded 4.3.32) The "Desk objects" palette is now a single "+ Add" button that
//      opens a popover, not a full-width horizontal strip.
//   2. The picker shows the universal File entry but no longer shows
//      the folded-away kinds (image, video, pdf, gdoc, gsheet, gslide,
//      email) — those still render correctly when an existing widget
//      uses them, but they're hidden from the picker.
//   3. The pinned-BR minimap shifts left to clear the AI Assistant rail
//      when the rail is open. When the rail collapses, the minimap
//      glides back toward the corner.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function bootAndOpenTask(launched: LaunchedApp): Promise<string> {
  const { window } = launched
  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Chrome test'
    })
    return task.id
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'Chrome test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  return taskId
}

// 4.3.32 superseded the two palette tests that were here. The "+ Add" palette
// (and the header Add widget button) were removed: widgets are added from the
// side menu's Widgets section. The same two guarantees hold on that surface —
// there is ONE add surface, and the folded-away kinds never reappear in it.
test('Widgets are added from the side menu; the palette and header Add widget button are gone', async () => {
  launched = await launchApp()
  await bootAndOpenTask(launched)
  const { window } = launched

  await waitForReady(window)
  await hoverToolbar(window)
  await expect(window.locator('[data-testid="palette-add-button"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="header-add-widget"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="sidemenu-widgets"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="sidemenu-widget-sticky"]')).toBeVisible()
})

test('The Widgets section hides the folded redundant kinds (image / video / pdf / gdoc / gsheet / gslide / email)', async () => {
  launched = await launchApp()
  await bootAndOpenTask(launched)
  const { window } = launched

  await waitForReady(window)
  // Expand Other widgets so every listed kind is in the DOM and visible.
  await window.locator('[data-testid="sidemenu-other-widgets-toggle"]').click()
  // File or link is a Files thing now: it lives under Apps (the Files tile),
  // not in Widgets.
  await expect(window.locator('[data-testid="office-comms-app-files"]').first()).toBeVisible({ timeout: 3000 })
  const foldedKinds = ['image', 'video', 'pdf', 'gdoc', 'gsheet', 'gslide', 'email', 'file']
  for (const kind of foldedKinds) {
    const count = await window.locator(`[data-testid="sidemenu-widget-${kind}"]`).count()
    expect({ kind, count }).toEqual({ kind, count: 0 })
  }
})

test('a right-pinned widget reaches the right edge — no phantom rail inset', async () => {
  launched = await launchApp()
  const taskId = await bootAndOpenTask(launched)
  const { window } = launched

  await waitForReady(window)
  // This replaces a test that opened and collapsed the AI rail and asserted
  // the BR-pinned minimap glided by >100px. That rail no longer exists —
  // nothing renders it and nothing could set its collapsed flag — yet the
  // pinned layer still reserved 292px of the right edge for it, so everything
  // pinned right sat 292px short of where it belonged. The inset is now zero,
  // and this is the assertion that keeps it honest.
  const widgetId = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const w = await api.widgets.create({
      taskId: tid,
      kind: 'sticky',
      title: 'pinned BR',
      content: '',
      x: 40,
      y: 40,
      width: 240,
      height: 180
    })
    await api.widgets.update(w.id, { pinned: true, pinnedZone: 'br' })
    return w.id
  }, taskId)

  // The widget was created through IPC, so the renderer's store only learns
  // about it on a reload.
  await window.reload()
  await waitForReady(window)
  await window.evaluate((tid: string) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(tid)
  }, taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })
  await window.waitForTimeout(800)

  const geo = await window.evaluate((id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)
    const surf = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
    if (!el || !surf) return null
    return {
      gapRight: Math.round(surf.getBoundingClientRect().right - el.getBoundingClientRect().right)
    }
  }, widgetId)

  expect(geo, 'the pinned widget and the surface are both present').not.toBeNull()
  // PADDING in pinLayout is 16; allow for a scrollbar gutter. Anything near
  // 292 would mean the phantom rail inset is back.
  expect(geo!.gapRight).toBeLessThan(64)
})
