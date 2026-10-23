import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

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

  await waitForReady(window)
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

  // The cell opens the unified menu: the cell's real row actions plus Create
  // seeded from the cell text.
  //
  // WHERE the row actions sit changed deliberately in 163b8914 ("Focus is
  // always on", DEC-144): the always-on "Add to Focus…" row is first on every
  // object menu and takes one of the Context band's two slots, so the band's
  // budget is ONE slot. A table cell has three context rows (Add row from the
  // table provider, Duplicate row + Delete row from the cell provider), so all
  // three fold under a single "More actions" parent — nothing is inlined
  // (resolve.ts contextSlots with max=1; pinned by the unit test "folds context
  // rows into the band budget"). This spec used to expect "Add row" inlined at
  // the top level, which held only while the Attention row was flag-gated off.
  const menu = window.locator('[data-canvas-ctx-menu]').first()
  const topLevel = menu.locator(':scope > div > button[role="menuitem"]')
  await expect(topLevel.first()).toBeVisible({ timeout: 4_000 })
  // The label span, not the button's innerText: icons are ligature text.
  const topLabels = await menu.locator(':scope > div > button[role="menuitem"] > span.flex-1').allInnerTexts()
  expect(topLabels[0], `top-level menu: ${JSON.stringify(topLabels)}`).toBe('Add to Focus…')
  expect(topLabels[1], `top-level menu: ${JSON.stringify(topLabels)}`).toBe('More actions')
  expect(topLabels, 'row actions are folded, never top-level').not.toContain('Add row')
  expect(topLabels.includes('Create & link'), `top-level menu: ${JSON.stringify(topLabels)}`).toBe(true)

  // Every row action is real and reachable under More actions, in priority
  // order: Add row (0), Duplicate row (1), Delete row (2).
  await menu.getByRole('menuitem', { name: /More actions/ }).hover()
  const sub = window.locator('[data-canvas-ctx-menu]').nth(1)
  await expect(sub).toBeVisible({ timeout: 3_000 })
  await expect(sub.locator(':scope > div > button[role="menuitem"] > span.flex-1')).toHaveText([
    'Add row',
    'Duplicate row',
    'Delete row'
  ])

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
