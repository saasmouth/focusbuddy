import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, addWidgetToDesk } from './_helpers'

// Drive widget — a canvas widget bound to a Files folder. Verifies:
//   1. Adding "Drive (folder)" from the Files app tile (4.3.32; it was the widget palette) lands unbound
//      (drive-choose-folder visible).
//   2. Choosing a folder via FolderPickerModal binds the widget (header shows
//      folder name, drive-body renders).
//   3. Adding a file INTO the drive saves it into the bound folder — driven
//      via window.api.files.ingestBuffer (the OS native file-picker dialog
//      cannot be automated through Playwright/Electron; this exercises the
//      exact same ingest path the "Add files" button triggers) — and confirms
//      via window.api.fileManager.list AND the rendered drive-entry-* row.
//   4. drive-open navigates to the Files view opened at that folder.
//   5. The bound folder id persists on widget.content across a reload.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

/** Create a task and navigate to its canvas surface. */
async function seedAndOpenCanvas(l: LaunchedApp, title: string): Promise<string> {
  const { window } = l
  const taskId = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: t })
    return task.id
  }, title)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(title) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(300)
  return taskId
}

test('Drive widget: add to desk -> unbound -> bind to folder -> ingest file -> open in Files -> persists', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  await waitForReady(launched.window)
  const { window } = launched
  await seedAndOpenCanvas(launched, 'Drive Widget Test')

  // ── 1. Add "Drive (folder)" to the desk ─────────────────────────────────
  // The palette tile this used was removed in 4.3.32. A Drive widget is what
  // the Files app IS on a desk, so it is added from the Files tile under Apps:
  // right-click → "Add Drive (folder) to this desk".
  await addWidgetToDesk(window, 'drive')
  await window.waitForTimeout(400)

  const chooseFolderBtn = window.locator('[data-testid="drive-choose-folder"]')
  await expect(chooseFolderBtn, 'newly added Drive widget must render unbound state').toBeVisible({
    timeout: 5_000
  })

  // ── 2. Bind: click Choose folder, create+pick a folder in the picker ────
  await chooseFolderBtn.click()
  const picker = window.locator('[data-testid="folder-picker"]')
  await expect(picker).toBeVisible({ timeout: 4_000 })

  const folderName = 'DriveWidgetE2E'
  await picker.locator('input[placeholder="New folder name"]').fill(folderName)
  await picker.getByRole('button', { name: 'Create' }).click()
  await window.waitForTimeout(400)

  // After creating, the picker navigates INTO the new folder. Confirm filing here.
  await picker.locator('[data-testid="folder-pick-current"]').click()
  await window.waitForTimeout(500)

  await expect(picker, 'picker should close after picking').not.toBeVisible()
  const driveBody = window.locator('[data-testid="drive-body"]')
  await expect(driveBody, 'Drive widget must render bound body after picking a folder').toBeVisible({
    timeout: 5_000
  })
  await expect(window.locator('[data-canvas-surface="true"]')).toContainText(folderName, { timeout: 4_000 })

  // Read back widget.content (the bound folder id) + folder id from the DB directly.
  const bound = await window.evaluate(async (title: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    const task = nodes.find((n: { title: string }) => n.title === title)
    const widgets = await api.widgets.listByTask(task.id)
    const drive = widgets.find((w: { kind: string }) => w.kind === 'drive')
    return { taskId: task.id, widgetId: drive.id, folderId: drive.content }
  }, 'Drive Widget Test')

  expect(bound.folderId, 'bound folder id must be a real fb_files folder id, not the ROOT sentinel').not.toBe(
    '__drive_root__'
  )
  expect(bound.folderId).toBeTruthy()

  const folderMeta = await window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.fileManager.get(id)
  }, bound.folderId)
  expect(folderMeta?.name).toBe(folderName)

  // ── 3. Ingest a file into the bound folder via window.api.files.ingestBuffer
  //    (same path the widget's own "Add files" input drives; the native OS
  //    file dialog itself is outside Playwright/Electron's automation surface) ──
  const ingested = await window.evaluate(
    async (input: { folderId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const text = new TextEncoder().encode('hello from the drive widget e2e test')
      const file = await api.files.ingestBuffer({
        buffer: text.buffer,
        originalName: 'drive-e2e-note.txt',
        mimeType: 'text/plain',
        parentId: input.folderId
      })
      return file
    },
    { folderId: bound.folderId }
  )
  expect(ingested?.id).toBeTruthy()

  // Confirm via fileManager.list that the ingested file actually landed in
  // THAT folder (parentId), not at top level or some other folder.
  const listed = await window.evaluate(async (folderId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.fileManager.list(folderId)
  }, bound.folderId)
  const match = listed.find((e: { id: string }) => e.id === ingested.id)
  expect(match, 'ingested file must appear in fileManager.list(boundFolderId)').toBeTruthy()
  expect(match.name).toBe('drive-e2e-note.txt')

  // The widget refreshes its own list on an interval/effect; force a refresh
  // by re-opening the canvas (navigate away and back) since the widget only
  // reloads on mount/parentId change, not on an external DB write.
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState().goHome?.()
  })
  await window.waitForTimeout(200)
  await window.getByRole('button', { name: /Drive Widget Test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(400)

  const entryRow = window.locator(`[data-testid="drive-entry-${ingested.id}"]`)
  await expect(entryRow, 'the ingested file must render as a drive-entry row after refresh').toBeVisible({
    timeout: 5_000
  })
  await expect(entryRow).toContainText('drive-e2e-note.txt')

  // ── 4. drive-open navigates to the Files view opened at that folder ─────
  await window.locator('[data-testid="drive-open"]').click()
  await window.waitForTimeout(500)
  const filesView = window.locator('[data-testid="files-view"]')
  await expect(filesView, 'drive-open must navigate to the Files view').toBeVisible({ timeout: 5_000 })
  // The bound folder's name must appear in the Files breadcrumb (confirming
  // openFolder(parentId) actually landed on the same folder, not top level).
  await expect(filesView).toContainText(folderName, { timeout: 4_000 })
  const filesList = window.locator('[data-testid="files-list"], [data-testid="files-grid"]')
  await expect(filesList).toContainText('drive-e2e-note.txt', { timeout: 4_000 })

  // ── 5. Bound folder id persists on the widget across a full app reload ──
  // View state is persisted to localStorage, so a reload restores the Files
  // view we navigated to in step 4 — go Home first to reach the task tile.
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState().goHome?.()
  })
  await window.waitForTimeout(200)
  await window.getByRole('button', { name: /Drive Widget Test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(400)

  const persisted = await window.evaluate(
    async (input: { taskId: string; widgetId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(input.taskId)
      const w = widgets.find((x: { id: string }) => x.id === input.widgetId)
      return w?.content
    },
    { taskId: bound.taskId, widgetId: bound.widgetId }
  )
  expect(persisted, 'widget.content (bound folder id) must survive a reload').toBe(bound.folderId)

  await expect(window.locator('[data-testid="drive-body"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator(`[data-testid="drive-entry-${ingested.id}"]`)).toBeVisible({ timeout: 5_000 })
})
