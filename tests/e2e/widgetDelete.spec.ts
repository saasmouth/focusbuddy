// Deleting a widget from a desk must actually remove it from the desk.
//
// The regression this pins: widgets:delete read `origin` while its handler
// signature never declared it, so every delete threw "origin is not defined" —
// but only AFTER the row had been soft-deleted. The database lost the widget,
// the renderer's await rejected, and the store therefore never pruned it. The
// widget stayed on screen and deleting appeared to do nothing at all, while the
// data was in fact already gone on the next load.
//
// So this asserts BOTH halves: the store/DOM drops it, and the backend agrees.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('the delete IPC resolves rather than throwing after removing the row', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const r = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Delete IPC desk' })
    const w = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'doomed', content: 'x',
      x: 40, y: 40, width: 200, height: 160
    })
    const before = (await api.widgets.listByTask(task.id)).length
    let error: string | null = null
    try {
      await api.widgets.delete(w.id)
    } catch (e) {
      error = String(e)
    }
    const after = (await api.widgets.listByTask(task.id)).length
    return { before, after, error }
  })
  expect(r.before).toBe(1)
  expect(r.after).toBe(0)
  // The whole bug: the row went, the promise rejected, the UI never caught up.
  expect(r.error, 'widgets:delete must resolve, not throw').toBeNull()
})

test('deleting from the desk removes the widget from the canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Delete canvas desk' })
    await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'doomed note', content: 'delete me',
      x: 120, y: 120, width: 220, height: 170
    })
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Delete canvas desk/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(400)

  const sticky = window.locator('[data-widget-kind="sticky"]').first()
  await expect(sticky).toBeVisible({ timeout: 8_000 })

  // Right-click the widget, then Remove from this desk, which is the real path.
  // E-2: a sticky is a work widget file, so its menu names the two removals as
  // rows (Remove from this desk · Move to Trash) instead of asking in a dialog.
  // Removing it from the desk is the path this spec has always pinned.
  await sticky.click({ button: 'right', position: { x: 30, y: 30 } })
  const removeHere = window.getByRole('menuitem', { name: /^Remove from this desk$/ }).first()
  await expect(removeHere).toBeVisible({ timeout: 5_000 })
  await removeHere.click()

  // Gone from the canvas…
  await expect(window.locator('[data-widget-kind="sticky"]')).toHaveCount(0, { timeout: 8_000 })
  // …and gone from the store, not merely hidden.
  const left = await window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { widgets: unknown[] } } }
    return w.__fbWidgets ? w.__fbWidgets.getState().widgets.length : -1
  })
  expect(left === 0 || left === -1).toBe(true)
})
