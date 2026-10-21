import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// This file used to cover the WidgetDock chip ("On desk" row): clicking a chip
// called zoomToWidget instead of opening focus mode, and the active chip was
// highlighted. WidgetDock was never mounted on the desk and was deleted in
// 4.3.41, so the three chip tests (two widget chips, one living-doc chip)
// went with it.
//
// What remains is the one check that never touched the dock: a 'living-doc'
// widget renders as a normal canvas item (data-widget-id on the canvas
// surface) without entering focus mode. Focus mode presence is detected via
// its "Close full view" button.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Return true when the WidgetFocusMode overlay is currently mounted.
// We detect it via the "Close full view" button that WidgetFocusMode
// always renders.
async function isFocusModeOpen(window: import('@playwright/test').Page): Promise<boolean> {
  const btn = window.getByRole('button', { name: 'Close full view' })
  return btn.isVisible().catch(() => false)
}

// Collapse the assistant rail — best-effort after the canvas is open.
async function collapseRail(window: import('@playwright/test').Page): Promise<void> {
  const hide = window.getByRole('button', { name: 'Hide assistant panel' })
  if (await hide.isVisible().catch(() => false)) await hide.click().catch(() => {})
  await window.waitForTimeout(150)
}

// ── living-doc renders on canvas, not only in focus mode ──────────────────────
test('living-doc widget renders as a canvas item with data-widget-id on the surface', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Living doc canvas test'
    })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'living-doc',
      title: 'Living Doc',
      content: '',
      x: 300,
      y: 300,
      width: 500,
      height: 400
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await waitForReady(window)

  await window.getByRole('button', { name: 'Living doc canvas test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await collapseRail(window)

  // The widget MUST be on the canvas — renderWidget has case 'living-doc'
  // so it renders inside WidgetFrame on the canvas surface, not only in focus mode.
  await window.waitForSelector(`[data-widget-id="${ids.widgetId}"]`, { timeout: 5_000 })

  // The setup state input must be visible (no brief was set).
  await expect(window.locator('[data-testid="livingdoc-brief-input"]')).toBeVisible({ timeout: 5_000 })

  // Focus mode must NOT have opened automatically.
  expect(await isFocusModeOpen(window)).toBe(false)

  console.log(`Living-doc widget ${ids.widgetId} is present on canvas in setup state.`)
})
