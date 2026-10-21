// The desk runs full-bleed beneath the floating menu and the title bar. Found
// by two Focus specs that had been failing since 4.3.40 and were taken for
// stale setup:
//   - Columns, List, Table, Gallery and Compact mounted at inset-0, so their
//     toolbar and first column sat UNDER the menu; the first control could not
//     be clicked (deskColumnsFocusReveal).
//   - Full view mounted at inset-0 under the 40px title bar, so the desk's name
//     and its objective tooltip were hidden behind it (test_plx_ux_011).
// Visibility checks pass on covered elements; these hit-test what is on top.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, openNewDesk, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

/** The element actually on top at the centre of `selector`'s box is it (or inside it). */
async function onTop(window: Page, selector: string): Promise<boolean> {
  return window.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + Math.min(12, r.width / 2), r.top + r.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  }, selector)
}

test('every desk layout starts at the menu edge, and Full view below the title bar', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const taskId = await openNewDesk(window, 'Layout inset desk')
  const widgetId = await window.evaluate(async (t) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.update(t, { description: 'Ship the layout fix' } as never)
    await (window as unknown as { __fbNodes: { getState: () => { refresh: () => Promise<void> } } }).__fbNodes.getState().refresh()
    const w = await api.widgets.create({ taskId: t, kind: 'sticky' as never, title: '', content: 'S', x: 60, y: 60, width: 260, height: 200 })
    const s = (window as unknown as { __fbWidgets: { getState: () => { loadForTask: (id: string, o?: { refresh?: boolean }) => Promise<void> } } }).__fbWidgets
    await s.getState().loadForTask(t, { refresh: true })
    return w.id
  }, taskId)
  const dockRight = async (): Promise<number> => {
    const b = await window.locator('[data-testid="sidebar-dock"]').boundingBox()
    return b ? b.x + b.width : 0
  }

  for (const mode of ['columns', 'list', 'table', 'gallery', 'compact']) {
    await window.locator('[data-testid="view-selector-btn"]').click()
    await window.locator(`[data-testid="view-opt-${mode}"]`).click()
    const root = mode === 'columns' ? '[data-testid="columns-host"]' : `[data-testid="data-view-${mode}"]`
    await expect(window.locator(root)).toBeVisible()
    const box = (await window.locator(root).boundingBox())!
    expect(box.x, `${mode} starts at the menu's right edge`).toBeGreaterThanOrEqual((await dockRight()) - 1)
  }
  // Columns' first control is clickable, not under the menu.
  await window.locator('[data-testid="view-selector-btn"]').click()
  await window.locator('[data-testid="view-opt-columns"]').click()
  expect(await onTop(window, '[data-testid="columns-groupby-status"]')).toBe(true)
  await window.locator('[data-testid="columns-groupby-status"]').click({ timeout: 5_000 })

  // Back to the canvas, then Full view: the desk's name is not under the title bar.
  await window.locator('[data-testid="view-selector-btn"]').click()
  await window.locator('[data-testid="view-opt-canvas"]').click()
  await window.evaluate((id) => {
    ;(window as unknown as { __fbWidgets: { getState: () => { setFocused: (x: string) => void } } }).__fbWidgets.getState().setFocused(id)
  }, widgetId)
  const identity = window.locator('[data-testid="widget-focus-mode"] [data-testid="focus-desk-identity"]')
  await expect(identity).toBeVisible()
  expect(await onTop(window, '[data-testid="widget-focus-mode"] [data-testid="focus-desk-identity"]')).toBe(true)
  await identity.hover({ timeout: 5_000 })
  await expect(identity).toHaveAttribute('title', 'Objective: Ship the layout fix')
})
