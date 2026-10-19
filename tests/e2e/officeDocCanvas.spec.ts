/**
 * E2E tests for canvas-integrated Office Document widgets (doc / sheet / slides).
 *
 * ODC-1  Add dialog appears: right-click canvas → Add object → Notes → Document.
 *        office-add-dialog appears with Create new, Import a file, and the
 *        existing-docs list. Choosing "Create new" creates a canvas widget, and
 *        the widget's content field is set to the backing document id.
 *
 * ODC-2  Sheet from canvas: Add object → Tools → Spreadsheet → Create new;
 *        the widget appears and embeds the sheet editor (sheet-grid is visible
 *        inside the widget).
 *
 * ODC-3  Edit persists through the backing document: seed a doc widget via the
 *        API (content = existing document id), navigate to the canvas, confirm
 *        the editor renders inside the widget frame, type text, wait for the
 *        debounced save, read the backing document body directly from SQLite,
 *        and confirm the typed text is present.
 *
 * ODC-4  Import path (stubbed): Add object → Tools → Spreadsheet → Import a
 *        file. The stub returns a SheetBodyV2. The resulting canvas widget is
 *        created and the sheet grid loads the imported data.
 *
 * For ODC-1/ODC-2/ODC-4 we drive the real UI path (right-click → submenu →
 * dialog). For ODC-3 we seed the widget via API to avoid the multi-level menu
 * overhead (covered by ODC-1/ODC-2).
 *
 * IPC stubs follow the same ipcMain pattern as other e2e specs.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Seed a task and open its canvas; returns the task id. */
async function seedTaskAndOpen(
  l: LaunchedApp,
  taskTitle: string
): Promise<string> {
  const { window } = l

  await waitForReady(window)
  const taskId = await window.evaluate(async (title: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title })
    return t.id
  }, taskTitle)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(taskTitle) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(300)
  return taskId
}

/** Open the canvas context menu and navigate to a category + item. */
async function openCtxMenuItem(
  window: Page,
  category: string,
  item: string
): Promise<void> {
  const surface = window.locator('[data-canvas-surface="true"]')
  await surface.click({ button: 'right', position: { x: 320, y: 280 } })
  await expect(window.locator('[data-canvas-ctx-menu]').first()).toBeVisible({ timeout: 4_000 })

  // Scope to context-menu items (role=menuitem) so labels like "Files" don't
  // collide with the Files sidebar entry of the same name.
  // Hover "Add object" to open its submenu.
  await window.getByRole('menuitem', { name: 'Add object', exact: true }).hover()
  await window.waitForTimeout(250)

  // Hover the category (e.g. "Files") to open its sub-submenu.
  await window.getByRole('menuitem', { name: category, exact: true }).hover()
  await window.waitForTimeout(250)

  // Click the item (e.g. "Document", "Spreadsheet").
  await window.getByRole('menuitem', { name: item, exact: true }).click()
}

// ── ODC-1: Add Dialog from canvas right-click (Document) ─────────────────────

test('ODC-1 — right-click Add object > Files > Document shows office-add-dialog; Create new places widget', async () => {
  const { app: _app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const taskId = await seedTaskAndOpen({ app: _app, window, userDataDir: '', dispose }, 'ODC-1 Task')

    await openCtxMenuItem(window, 'Files', 'Document')

    // The add dialog must be visible.
    await expect(window.locator('[data-testid="office-add-dialog"]')).toBeVisible({ timeout: 5_000 })

    // Dialog should have Create new and Import a file options.
    await expect(window.locator('[data-testid="office-add-new"]')).toBeVisible()
    await expect(window.locator('[data-testid="office-add-import"]')).toBeVisible()

    // Click "Create new".
    await window.locator('[data-testid="office-add-new"]').click()
    await window.waitForTimeout(600)

    // The dialog should close.
    await expect(window.locator('[data-testid="office-add-dialog"]')).not.toBeVisible({ timeout: 4_000 })

    // A new doc widget should appear on the canvas. The widget embeds DocEditor
    // which renders data-testid="doc-editor-surface". Wait for it.
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })

    // Read the widgets for this task and confirm one has kind='doc' with a content field.
    const widgets = await window.evaluate(async (tid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.widgets.listByTask(tid)
    }, taskId)

    const docWidget = (widgets as Array<{ kind: string; content?: string }>).find((w) => w.kind === 'doc')
    expect(docWidget, 'a doc widget must exist on the canvas').toBeTruthy()
    expect(docWidget?.content, 'widget.content must be a non-empty document id').toBeTruthy()

    // The backing document must exist.
    if (docWidget?.content) {
      const doc = await window.evaluate(async (id: string) => {
        const api = (window as unknown as { api: typeof window.api }).api
        return api.documents.get(id)
      }, docWidget.content)
      expect(doc, 'backing document must exist in SQLite').toBeTruthy()
    }
  } finally {
    await dispose()
  }
})

// ── ODC-2: Add Spreadsheet from canvas → sheet-grid renders ──────────────────

test('ODC-2 — Add object > Files > Spreadsheet > Create new embeds sheet editor', async () => {
  const { app: _app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const taskId = await seedTaskAndOpen({ app: _app, window, userDataDir: '', dispose }, 'ODC-2 Task')

    await openCtxMenuItem(window, 'Files', 'Spreadsheet')

    await expect(window.locator('[data-testid="office-add-dialog"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="office-add-new"]').click()
    await window.waitForTimeout(600)

    // The dialog should close.
    await expect(window.locator('[data-testid="office-add-dialog"]')).not.toBeVisible({ timeout: 4_000 })

    // A sheet-grid must appear inside the widget.
    await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 8_000 })

    // Confirm a sheet widget with content was persisted.
    const widgets = await window.evaluate(async (tid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.widgets.listByTask(tid)
    }, taskId)

    const sheetWidget = (widgets as Array<{ kind: string; content?: string }>).find(
      (w) => w.kind === 'sheet'
    )
    expect(sheetWidget, 'a sheet widget must exist').toBeTruthy()
    expect(sheetWidget?.content, 'widget.content must be a document id').toBeTruthy()
  } finally {
    await dispose()
  }
})

// ── ODC-3: Embedded editor edits persist to the backing document ──────────────

test('ODC-3 — doc widget embedded editor: type text; backing document body updates in SQLite', async () => {
  const { app: _app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed a backing document and a doc widget pointing at it.
    const { taskId, widgetId, docId } = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'ODC-3 Task' })
      const doc = await api.documents.create({ docType: 'doc', title: 'Embedded Doc' })
      const widget = await api.widgets.create({
        taskId: task.id,
        kind: 'doc' as never,
        title: 'Embedded Doc',
        content: doc.id,
        x: 80,
        y: 80,
        width: 640,
        height: 480
      })
      return { taskId: task.id, widgetId: widget.id, docId: doc.id }
    })

    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: /ODC-3 Task/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await window.waitForTimeout(300)

    // The doc editor surface should render inside the widget frame.
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })

    // Type text into the embedded editor.
    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await surface.type('Canvas embedded text content')

    // Wait for the debounced save (500 ms in OfficeDocWidget.saveBody).
    await window.waitForTimeout(1_500)

    // Read the backing document body from SQLite.
    const stored = await window.evaluate(async (id: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const doc = await api.documents.get(id)
      return doc?.body
    }, docId)

    // The body is persisted as { doc, headingStyles } (wrapped). Check the doc JSON.
    const bodyStr = JSON.stringify(stored)
    expect(
      bodyStr,
      'backing document body must contain the typed text'
    ).toContain('Canvas embedded text content')

    // Also confirm the widget still points at the same doc id.
    const ws = await window.evaluate(async (tid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.widgets.listByTask(tid)
    }, taskId)
    const w = (ws as Array<{ id: string; content?: string }>).find((x) => x.id === widgetId)
    expect(w?.content, 'widget.content must still be the backing doc id').toBe(docId)
  } finally {
    await dispose()
  }
})

// ── ODC-4: Import via add-dialog (stubbed) ────────────────────────────────────

test('ODC-4 — Add Spreadsheet > Import a file: stub sheet:import; widget embeds imported data', async () => {
  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const taskId = await seedTaskAndOpen({ app, window, userDataDir: '', dispose }, 'ODC-4 Task')

    // Stub sheet:import BEFORE clicking "Import a file" so the dialog's importFile()
    // path gets our canned SheetBodyV2 instead of opening an OS file dialog.
    await app.evaluate(
      ({ ipcMain }, body: object) => {
        ipcMain.removeHandler('sheet:import')
        ipcMain.handle('sheet:import', async () => ({
          ok: true,
          body,
          name: 'imported.xlsx'
        }))
      },
      {
        version: 2,
        sheets: [
          {
            id: 'st-import-test',
            name: 'Imported',
            columns: ['Product', 'Units'],
            rows: [['Gadget', '500'], ['Widget', '300']]
          }
        ],
        activeSheet: 0
      }
    )

    // Open the add dialog via the canvas context menu.
    await openCtxMenuItem(window, 'Files', 'Spreadsheet')
    await expect(window.locator('[data-testid="office-add-dialog"]')).toBeVisible({ timeout: 5_000 })

    // Click "Import a file".
    await window.locator('[data-testid="office-add-import"]').click()
    await window.waitForTimeout(800)

    // The dialog should close once import completes and the widget is created.
    await expect(window.locator('[data-testid="office-add-dialog"]')).not.toBeVisible({ timeout: 6_000 })

    // The sheet-grid must appear (the OfficeDocWidget embeds SheetEditor).
    await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 8_000 })

    // The imported cell data should be visible — cell (0,0) = "Gadget".
    const cell00 = window.locator('[data-testid="cell-0-0"] div').first()
    await expect(cell00).toHaveText('Gadget', { timeout: 5_000 })

    // Confirm a sheet widget with content was persisted.
    const widgets = await window.evaluate(async (tid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.widgets.listByTask(tid)
    }, taskId)

    const sheetWidget = (widgets as Array<{ kind: string; content?: string }>).find(
      (w) => w.kind === 'sheet'
    )
    expect(sheetWidget, 'sheet widget persisted after import').toBeTruthy()
    expect(sheetWidget?.content, 'widget.content holds the backing doc id').toBeTruthy()
  } finally {
    await dispose()
  }
})
