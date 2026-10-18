import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'crypto'
import { launchApp, waitForReady, openNewDesk, gotoView, type LaunchedApp } from './_helpers'

// Every work widget is a file; the × asks "remove from this desk, or delete the
// work widget?" (4.3.32, docs/widget-files.md).
//
// "Treat work widgets independent of a desk as a standard file. The desk is
// simply the place it lives, and may be added to multiple desks, but the file
// is still the file. Same for widgets added to a desk: it's a file in its own
// right, it just gets placed on the active desk, and can be removed from the
// desk, but the × should ask: remove from this desk, or delete this widget
// permanently."
//
// Throwaway profiles only (launchApp mints a temp userData per test).

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

type Api = typeof window.api

async function boot(): Promise<Page> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  await waitForReady(launched.window)
  return launched.window
}

async function storeWidgetIds(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    (
      window as unknown as { __fbWidgets: { getState: () => { widgets: Array<{ id: string }> } } }
    ).__fbWidgets.getState().widgets.map((w) => w.id)
  )
}

/** A file placed on two desks; returns the ids, with desk A open. */
async function fileOnTwoDesks(window: Page): Promise<{ fileId: string; a: string; b: string; deskA: string; deskB: string }> {
  const deskB = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    return (await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk B' })).id
  })
  const deskA = await openNewDesk(window, 'Desk A')
  const ids = await window.evaluate(
    async ({ deskA, deskB }) => {
      const api = (window as unknown as { api: Api }).api
      const file = await api.widgetFiles.create({ kind: 'sticky', content: 'Pricing questions' }, { defaultContent: '' })
      const a = await api.widgetFiles.place(file.id, { taskId: deskA, x: 200, y: 160, width: 260, height: 200 })
      const b = await api.widgetFiles.place(file.id, { taskId: deskB, x: 200, y: 160, width: 260, height: 200 })
      return { fileId: file.id, a: a!.id, b: b!.id }
    },
    { deskA, deskB }
  )
  // Re-open desk A so the instance placed behind the store's back is loaded.
  await window.evaluate(async (id) => {
    const w = window as unknown as { __fbWidgets: { getState: () => { loadForTask: (i: string, o?: unknown) => Promise<void> } } }
    await w.__fbWidgets.getState().loadForTask(id, { refresh: true })
  }, deskA)
  await expect.poll(() => storeWidgetIds(window), { timeout: 8_000 }).toContain(ids.a)
  return { ...ids, deskA, deskB }
}

/** Click a widget's header × — hover first: frame chrome is hover-revealed. */
async function clickX(window: Page, widgetId: string): Promise<void> {
  const frame = window.locator(`[data-widget-id="${widgetId}"]`).first()
  await expect(frame).toBeVisible({ timeout: 8_000 })
  await frame.hover({ position: { x: 40, y: 12 } })
  const x = frame.locator('[data-testid="widget-remove"]').first()
  await expect(x).toBeVisible({ timeout: 5_000 })
  await x.click()
}

test('WRD-1 right-click Add object makes a work widget file with an instance, and it is in Files', async () => {
  const window = await boot()
  const deskId = await openNewDesk(window, 'Add object desk')
  const before = await storeWidgetIds(window)

  const surface = window.locator('[data-canvas-surface="true"]')
  await surface.click({ button: 'right', position: { x: 360, y: 300 } })
  const root = window.locator('[data-canvas-ctx-menu]').first()
  await expect(root).toBeVisible({ timeout: 4_000 })
  await root.getByRole('menuitem', { name: 'Add object' }).hover()
  const addMenu = window.locator('[data-canvas-ctx-menu]').nth(1)
  await expect(addMenu).toBeVisible({ timeout: 3_000 })
  await addMenu.getByRole('menuitem', { name: 'Tools' }).hover()
  const tools = window.locator('[data-canvas-ctx-menu]').nth(2)
  await expect(tools).toBeVisible({ timeout: 3_000 })
  await tools.getByRole('menuitem', { name: 'Tasks', exact: true }).click()

  await expect.poll(async () => (await storeWidgetIds(window)).length, { timeout: 8_000 }).toBe(before.length + 1)
  const res = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Api }).api
    const ws = await api.widgets.listByTask(id)
    const t = ws.find((w) => w.kind === 'task-list')!
    const fileId = t.syncGroupId?.startsWith('wf:') ? t.syncGroupId.slice(3) : null
    const file = fileId ? await api.widgetFiles.get(fileId) : null
    const root = await api.fileManager.list(null)
    return {
      group: t.syncGroupId,
      fileKind: file?.kind ?? null,
      scope: JSON.parse(t.content).scope,
      inFiles: root.some((e: { docId?: string | null }) => e.docId === fileId)
    }
  }, deskId)
  expect(res.group).toMatch(/^wf:/)
  expect(res.fileKind).toBe('task-list')
  // Still a lens over this desk's tasks (what "Tasks" on a desk means), as a file.
  expect(res.scope).toBe('desk')
  expect(res.inFiles).toBe(true)

  // And it shows in Files as a Task list.
  await gotoView(window, 'goFiles')
  const fileId = res.group!.slice(3)
  const row = window.locator(`[data-doc-id="${fileId}"]`).first()
  await expect(row).toBeVisible({ timeout: 8_000 })
  await expect(row).toHaveAttribute('data-widget-kind', 'task-list')
})

test('WRD-2 × → Remove from this desk takes only this desk’s instance; the file stays in Files and on the other desk', async () => {
  const window = await boot()
  const { fileId, a, b, deskB } = await fileOnTwoDesks(window)

  await clickX(window, a)
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog).toContainText('Pricing questions')
  const remove = dialog.locator('[data-testid="prompt-choice-remove"]')
  await expect(remove).toContainText('Remove from this desk')
  await expect(remove).toContainText('It stays in Files and on 1 other desk.')
  await expect(dialog.locator('[data-testid="prompt-choice-delete"]')).toContainText('Delete work widget')
  await remove.click()

  await expect(window.locator(`[data-widget-id="${a}"]`)).toHaveCount(0, { timeout: 8_000 })
  const after = await window.evaluate(
    async ({ fileId, deskB }) => {
      const api = (window as unknown as { api: Api }).api
      return {
        files: (await api.widgetFiles.list()).map((f) => f.id),
        onB: (await api.widgets.listByTask(deskB)).map((w) => w.id),
        instances: (await api.widgetFiles.instances(fileId)).map((w) => w.id)
      }
    },
    { fileId, deskB }
  )
  expect(after.files).toContain(fileId)
  expect(after.onB).toContain(b)
  expect(after.instances).toEqual([b])
})

test('WRD-3 × → Delete work widget trashes the file and every instance; Undo puts them all back', async () => {
  const window = await boot()
  const { fileId, a, b, deskA, deskB } = await fileOnTwoDesks(window)

  await clickX(window, a)
  const del = window.locator('[data-testid="prompt-choice-delete"]')
  await expect(del).toBeVisible({ timeout: 5_000 })
  await expect(del).toContainText('Removes it from every desk and from Files. You can restore it from Trash.')
  await del.click()

  await expect(window.locator(`[data-widget-id="${a}"]`)).toHaveCount(0, { timeout: 8_000 })
  const gone = await window.evaluate(
    async ({ fileId, deskA, deskB }) => {
      const api = (window as unknown as { api: Api }).api
      return {
        listed: (await api.widgetFiles.list()).some((f) => f.id === fileId),
        trashed: (await api.documents.listTrashed()).some((d: { id: string }) => d.id === fileId),
        onA: (await api.widgets.listByTask(deskA)).length,
        onB: (await api.widgets.listByTask(deskB)).length
      }
    },
    { fileId, deskA, deskB }
  )
  expect(gone).toEqual({ listed: false, trashed: true, onA: 0, onB: 0 })

  // The toast says what happened and offers Undo, which restores the file —
  // and restoring the file puts every instance back where it was.
  const toast = window.locator('[data-testid="notice-toast"]')
  await expect(toast).toContainText('moved to Trash and removed from 2 desks')
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => storeWidgetIds(window), { timeout: 8_000 }).toContain(a)
  const back = await window.evaluate(
    async ({ fileId, deskB }) => {
      const api = (window as unknown as { api: Api }).api
      return {
        listed: (await api.widgetFiles.list()).some((f) => f.id === fileId),
        onB: (await api.widgets.listByTask(deskB)).map((w) => w.id)
      }
    },
    { fileId, deskB }
  )
  expect(back.listed).toBe(true)
  expect(back.onB).toEqual([b])
})

test('WRD-4 Cancel changes nothing', async () => {
  const window = await boot()
  const { fileId, a } = await fileOnTwoDesks(window)
  await clickX(window, a)
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(window.locator(`[data-widget-id="${a}"]`)).toBeVisible()
  const n = await window.evaluate(async (id) => (await (window as unknown as { api: Api }).api.widgetFiles.instances(id)).length, fileId)
  expect(n).toBe(2)
})

test('WRD-5 the full-pane Move to Trash warns that its desk instances go too, and takes them', async () => {
  const window = await boot()
  const { fileId, deskA, deskB } = await fileOnTwoDesks(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }
    w.__fbView.getState().goDocument(id)
  }, fileId)
  await expect(window.locator('[data-testid="widget-file-view"]')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('[data-testid="widget-file-instances"]')).toHaveText('On 2 desks')
  await window.locator('[data-testid="widget-file-trash"]').click()
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toContainText('on 2 desks and will be removed from them too')
  await dialog.locator('[data-testid="prompt-dialog-confirm"]').click()
  await expect
    .poll(
      () =>
        window.evaluate(
          async ({ deskA, deskB }) => {
            const api = (window as unknown as { api: Api }).api
            return (await api.widgets.listByTask(deskA)).length + (await api.widgets.listByTask(deskB)).length
          },
          { deskA, deskB }
        ),
      { timeout: 8_000 }
    )
    .toBe(0)
})

/** The file id main derives for a lone desk widget (db/widgetFiles.widgetFileIdForSeed). */
function fileIdForWidget(widgetId: string): string {
  const h = createHash('sha1').update(`plexii.widget-file:widget:${widgetId}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

test('WRD-6 the launch backfill files work widgets that predate the rule, under the derived id, on the real schema', async () => {
  test.setTimeout(60_000)
  const window = await boot()
  // A create that carries its own id is a replay, which createWidget leaves
  // plain — the closest an e2e can get to a row from an older build. Made
  // straight after ready, before the backfill's launch timer (8 s) fires.
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Old desk' })
    const sticky = await api.widgets.create({ id: 'e2e-legacy-sticky', taskId: desk.id, kind: 'sticky', content: 'Renew the lease', x: 60, y: 60 })
    const section = await api.widgets.create({ id: 'e2e-legacy-section', taskId: desk.id, kind: 'section', content: '', x: 400, y: 60 })
    return { desk: desk.id, sticky: sticky.id, section: section.id, stickyGroup: sticky.syncGroupId }
  })
  expect(ids.stickyGroup, 'a replayed create stays plain').toBeNull()
  const expected = fileIdForWidget(ids.sticky)
  await expect
    .poll(
      () => window.evaluate(async (id) => (await (window as unknown as { api: Api }).api.widgets.get(id))?.syncGroupId ?? null, ids.sticky),
      { timeout: 30_000 }
    )
    .toBe(`wf:${expected}`)
  const res = await window.evaluate(
    async ({ expected, section }) => {
      const api = (window as unknown as { api: Api }).api
      const file = await api.widgetFiles.get(expected)
      const root = await api.fileManager.list(null)
      return {
        title: file?.title ?? null,
        kind: file?.kind ?? null,
        filed: root.some((e: { docId?: string | null }) => e.docId === expected),
        sectionGroup: (await api.widgets.get(section))?.syncGroupId ?? null
      }
    },
    { expected, section: ids.section }
  )
  expect(res).toEqual({ title: 'Renew the lease', kind: 'sticky', filed: true, sectionGroup: null })
})
