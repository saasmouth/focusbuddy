// Live-drive verification for the Plexi3.0 batch (commits 24a61f9, 2d00d58,
// f41edbe, 594a3eb, ed257c8): sidebar restructure + Shared index, discoverable
// add-widget (side-menu Widgets section; the FAB + search until 4.3.32), office-doc filed-in chip + folder picker,
// Office-file table column + doc picker, and doc-embed insert from the slash
// menu. One Electron session, driven in priority order.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, sideMenuWidget, addWidgetToDesk } from './_helpers'

test('Plexi3 batch — live verification of all 6 shipped items', async () => {
  test.setTimeout(120_000)
  const { window, dispose }: LaunchedApp = await launchApp()
  try {
    await waitForReady(window)

    // ── Seed: one office doc to reference/embed, one table+task to hold it ──
    const seed = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const refDoc = await api.documents.create({ docType: 'doc', title: 'RefDoc-Plexi3' })
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Plexi3TableDesk' })
      const table = await api.tables.create({
        title: 'Plexi3Table',
        schema: {
          columns: [{ id: 'c-name', type: 'text-short', label: 'Name', config: {} }]
        }
      })
      await api.tables.createRow({ tableId: table.id, cells: { 'c-name': 'Row1' } })
      const widget = await api.widgets.create({
        taskId: task.id,
        kind: 'table',
        title: 'Plexi3Table',
        content: table.id,
        x: 100,
        y: 100,
        width: 560,
        height: 380
      })
      return { refDocId: refDoc.id, taskId: task.id, tableId: table.id, widgetId: widget.id }
    })

    // ═══ PRIORITY 1 — Office-file table column ═══════════════════════════════
    await window.reload()
    await waitForReady(window)
    await window.evaluate((taskId) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState().goTask(taskId)
    }, seed.taskId)
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await window.waitForFunction(
      (wid: string) => !!document.querySelector(`[data-widget-id="${wid}"] [data-testid="table-body"]`),
      seed.widgetId,
      { timeout: 8_000 }
    )

    // Add a column via the "+" column adder, choose "Office file" from the type list.
    const widgetRoot = window.locator(`[data-widget-id="${seed.widgetId}"]`)
    await widgetRoot.locator('button[title="Add column"]').click()
    await expect(widgetRoot.getByText('Office file', { exact: true })).toBeVisible({ timeout: 4_000 })
    await widgetRoot.getByText('Office file', { exact: true }).click()

    // The new column is index 1 (0 = Name). Its row-0 cell should show doc-ref-add.
    const cell = widgetRoot.locator('[data-testid="table-cell-0-1"]')
    const addBtn = cell.locator('[data-testid="doc-ref-add"]')
    await expect(addBtn).toBeVisible({ timeout: 4_000 })
    await addBtn.click()

    const docPicker = window.locator('[data-testid="doc-picker"]')
    await expect(docPicker).toBeVisible({ timeout: 4_000 })
    await docPicker.locator(`[data-testid="doc-pick-${seed.refDocId}"]`).click()
    await expect(docPicker).not.toBeVisible({ timeout: 4_000 })
    await expect(cell.getByText('RefDoc-Plexi3')).toBeVisible({ timeout: 4_000 })
    console.log('ITEM1_CELL_CHIP_RENDERED_OK')

    // Persistence: reload, renavigate, confirm the chip survives.
    await window.reload()
    await waitForReady(window)
    await window.evaluate((taskId) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState().goTask(taskId)
    }, seed.taskId)
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await window.waitForFunction(
      (wid: string) => !!document.querySelector(`[data-widget-id="${wid}"] [data-testid="table-body"]`),
      seed.widgetId,
      { timeout: 8_000 }
    )
    await expect(
      window
        .locator(`[data-widget-id="${seed.widgetId}"] [data-testid="table-cell-0-1"]`)
        .getByText('RefDoc-Plexi3')
    ).toBeVisible({ timeout: 5_000 })
    console.log('ITEM1_PERSISTED_AFTER_RELOAD_OK')

    // ═══ PRIORITY 2 — Insert office file into a doc (docEmbed) ═══════════════
    const embedDocId = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const d = await api.documents.create({ docType: 'doc', title: 'EmbedHost-Plexi3' })
      return d.id
    })
    await window.reload()
    await waitForReady(window)
    await window.evaluate((id) => {
      const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      w.__fbView?.getState().goDocument(id)
    }, embedDocId)
    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await expect(surface).toBeVisible({ timeout: 8_000 })
    await surface.click()

    // Insert via the actual "/" slash menu (SlashMenu.ts) — the primary path.
    // "Insert office file" must be present there (it opens the doc picker via the
    // slashCommand storage callback the DocEditor registers).
    await surface.type('/')
    const slashMenu = window.locator('[data-testid="doc-slash-menu"]')
    await expect(slashMenu).toBeVisible({ timeout: 4_000 })
    await expect(slashMenu.getByText('Insert office file', { exact: true })).toHaveCount(1)
    await slashMenu.getByText('Insert office file', { exact: true }).click()
    const docPicker2 = window.locator('[data-testid="doc-picker"]')
    await expect(docPicker2).toBeVisible({ timeout: 4_000 })
    await docPicker2.locator(`[data-testid="doc-pick-${seed.refDocId}"]`).click()
    await expect(docPicker2).not.toBeVisible({ timeout: 4_000 })
    await expect(surface.getByText('RefDoc-Plexi3')).toBeVisible({ timeout: 4_000 })
    await expect(surface.getByRole('button', { name: 'Open' })).toBeVisible({ timeout: 4_000 })
    console.log('ITEM2_DOCEMBED_CARD_RENDERED_OK (via slash menu)')

    await window.waitForTimeout(600) // let autosave debounce fire
    await window.reload()
    await waitForReady(window)
    await window.evaluate((id) => {
      const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      w.__fbView?.getState().goDocument(id)
    }, embedDocId)
    const surface2 = window.locator('[data-testid="doc-editor-surface"]')
    await expect(surface2).toBeVisible({ timeout: 8_000 })
    await expect(surface2.getByText('RefDoc-Plexi3')).toBeVisible({ timeout: 5_000 })
    await expect(surface2.getByRole('button', { name: 'Open' })).toBeVisible({ timeout: 5_000 })
    console.log('ITEM2_DOCEMBED_ROUNDTRIP_OK')

    // ═══ PRIORITY 3 — Filed-in chip + folder picker ══════════════════════════
    await window.evaluate((id) => {
      const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      w.__fbView?.getState().goDocument(id)
    }, seed.refDocId)
    const chip = window.locator('[data-testid="doc-filed-in-chip"]')
    await expect(chip).toBeVisible({ timeout: 6_000 })
    await expect(chip).toContainText(/not filed/i, { timeout: 4_000 })
    await chip.click()
    const folderPicker = window.locator('[data-testid="folder-picker"]')
    await expect(folderPicker).toBeVisible({ timeout: 4_000 })
    // Create a folder inline, then confirm filing into it.
    await folderPicker.locator('input[placeholder="New folder name"]').fill('Plexi3TestRoom')
    await folderPicker.getByRole('button', { name: 'Create' }).click()
    await expect(folderPicker.locator('[data-testid="folder-pick-current"]')).toContainText(
      'Plexi3TestRoom',
      { timeout: 4_000 }
    )
    await folderPicker.locator('[data-testid="folder-pick-current"]').click()
    await expect(folderPicker).not.toBeVisible({ timeout: 4_000 })
    await expect(chip).toContainText('Plexi3TestRoom', { timeout: 4_000 })
    console.log('ITEM3_FILED_IN_CHIP_SHOWS_PATH_OK')

    // ═══ PRIORITY 4 — Sidebar restructure + Shared index ═════════════════════
    const sidebar = window.locator('[data-testid="desk-sidebar"]')
    await expect(sidebar).toBeVisible({ timeout: 4_000 })
    await expect(sidebar.getByText('Rooms & desks', { exact: true })).toHaveCount(0)
    await expect(sidebar.getByText('Shared with me', { exact: true })).toHaveCount(0)
    await expect(sidebar.getByText('All rooms', { exact: true })).toBeVisible()
    await expect(sidebar.getByText('All desks', { exact: true })).toBeVisible()
    const sharedRow = sidebar.getByText('Shared', { exact: true })
    await expect(sharedRow).toBeVisible()
    await sharedRow.click()
    await expect(window.locator('[data-testid="shared-view"]')).toBeVisible({ timeout: 4_000 })
    console.log('ITEM4_SIDEBAR_AND_SHARED_VIEW_OK')

    // ═══ PRIORITY 5 — Adding a widget on the desk ════════════════════════════
    // Superseded 4.3.32: this drove the add-widget FAB and its search box,
    // both removed. Widgets are added from the side menu's Widgets section;
    // the lesser-used ones live under "Other widgets" instead of behind a
    // search, so the check is that both lists are reachable and add for real.
    await window.evaluate((taskId) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
      w.__fbView?.getState().goTask(taskId)
    }, seed.taskId)
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await expect(window.locator('[data-testid="sidemenu-widgets-main"] [data-testid="sidemenu-widget-sticky"]')).toBeVisible({ timeout: 4_000 })
    await expect(await sideMenuWidget(window, 'calculator')).toBeVisible()
    await addWidgetToDesk(window, 'sticky')
    console.log('ITEM5_SIDE_MENU_ADD_OK')
  } finally {
    await dispose()
  }
})
