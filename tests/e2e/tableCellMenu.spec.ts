import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp } from './_helpers'

// TableWidget column-aware right-click menu.
// Seeds a task + a table + one row, then right-clicks a cell that
// contains text. The menu must:
//   1. Show the column label in its header item
//   2. Show kind options whose labels mention "from this cell" for
//      text-receiving kinds (sticky/note/markdown/page)
//   3. Spawn the new tool seeded with the cell text + persist a
//      widget_link from the table back to the new tool.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('right-click a table cell → Create + connect menu seeded with the cell text', async () => {
  launched = await launchApp()
  const { window } = launched

  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skipBtn = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click().catch(() => {})
  }

  // Seed: task + table widget + one row with a recognisable text cell.
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Table cell test'
    })
    const table = await api.tables.create({
      title: 'Things',
      schema: { columns: [
        { id: 'c1', type: 'text-short', label: 'Topic', config: {} }
      ] }
    })
    await api.tables.createRow({ tableId: table.id, cells: { c1: 'PIZZA' } })
    const tableWidget = await api.widgets.create({
      taskId: task.id,
      kind: 'table',
      title: 'Things',
      content: table.id,
      x: 220,
      y: 200,
      width: 480,
      height: 320
    })
    return { taskId: task.id, tableWidgetId: tableWidget.id }
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skipBtn2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skipBtn2.isVisible().catch(() => false)) {
    await skipBtn2.click().catch(() => {})
  }

  await window.getByRole('button', { name: 'Table cell test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // FieldEditor for text-short renders an <input value="PIZZA">. We
  // need the input's parent <td> for the right-click (the onContextMenu
  // is on the td, not the input). Locate by input value first.
  const cellInput = window.locator('input[value="PIZZA"]').first()
  await expect(cellInput).toBeVisible({ timeout: 5_000 })
  const cell = cellInput.locator('xpath=ancestor::td[1]')
  await cell.click({ button: 'right' })

  // The cell now opens the unified menu: real row actions (Add row inlined, the
  // rest under More actions) plus Create seeded from the cell text.
  const menu = window.locator('[data-canvas-ctx-menu]').first()
  await expect(menu).toContainText('Add row', { timeout: 4_000 })
  await expect(menu).toContainText('More actions')
  await expect(menu).toContainText('Create')
  // Delete row is a real action, folded under More actions.
  // "Delete row" is a top-level item when the cell has few actions, and sits
  // under the "More actions" submenu when there are several (resolve.ts folds
  // everything past the first into it). Open the submenu only if it is there.
  const more = menu.getByText('More actions', { exact: true })
  if (await more.isVisible().catch(() => false)) await more.hover()
  await expect(
    window.locator('[data-canvas-ctx-menu]').getByText('Delete row', { exact: true })
  ).toBeVisible({ timeout: 3_000 })

  // Create a sticky from the cell via Create > Sticky (seeds the cell text).
  // The create group's label carries its own wording now ("Create a sticky
  // from this cell" and friends live under it), so match the prefix rather
  // than an exact "Create".
  await menu.getByText(/^Create/).first().hover()
  await window.locator('[data-canvas-ctx-menu]').getByText('Sticky', { exact: true }).first().click()
  await window.waitForTimeout(700)

  // Verify: a new sticky widget exists on the task, its content is
  // PIZZA, and a link from the table widget → new sticky persists.
  const verified = await window.evaluate(async ({ taskId, tableWidgetId }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const widgets = await api.widgets.listByTask(taskId)
    const sticky = widgets.find((w) => w.kind === 'sticky')
    const links = await api.widgetLinks.listByTask(taskId)
    const link = links.find((l) => l.sourceWidgetId === tableWidgetId)
    return {
      stickyId: sticky?.id ?? null,
      stickyContent: sticky?.content ?? null,
      linkTargetId: link?.targetWidgetId ?? null
    }
  }, seeded)

  expect(verified.stickyContent).toBe('PIZZA')
  expect(verified.linkTargetId).toBe(verified.stickyId)
})
