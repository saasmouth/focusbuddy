import { test, expect, type Page } from '@playwright/test'
import {
  launchApp,
  waitForReady,
  openNewDesk,
  sideMenuWidget,
  addWidgetToDesk,
  gotoView,
  type LaunchedApp
} from './_helpers'

// Widget files (4.3.32) — docs/widget-files.md.
//
// "Add a new section to the side menu for widgets that are not already
// represented in apps … Widgets should be able to be created without a desk,
// same as docs, slides etc, but also dragged onto a desk. They should also get
// the same treatment for naming … These widgets should appear in Files as well
// as their own file type … interrogatable by any AI assistant."

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

type Api = typeof window.api
const api = (w: Window): Api => (w as unknown as { api: Api }).api

async function boot(): Promise<Page> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  await waitForReady(launched.window)
  return launched.window
}

/** Every widget on a desk, straight from the database. */
async function deskWidgets(window: Page, deskId: string): Promise<Array<{ id: string; kind: string; content: string; title: string; syncGroupId: string | null }>> {
  return window.evaluate(async (id) => {
    const ws = await (window as unknown as { api: Api }).api.widgets.listByTask(id)
    return ws.map((w) => ({ id: w.id, kind: w.kind, content: w.content, title: w.title, syncGroupId: w.syncGroupId }))
  }, deskId)
}

/** Simulate the browser's drag: real dragstart on `fromSel`, then drop on the canvas. */
async function dragOntoCanvas(window: Page, fromSel: string): Promise<Record<string, string>> {
  return window.evaluate((sel) => {
    const from = document.querySelector(sel)
    const surface = document.querySelector('[data-canvas-surface="true"]')
    if (!from || !surface) throw new Error(`missing ${!from ? sel : 'canvas'}`)
    const dt = new DataTransfer()
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const r = surface.getBoundingClientRect()
    const clientX = r.left + r.width / 2
    const clientY = r.top + r.height / 2
    for (const type of ['dragenter', 'dragover', 'drop']) {
      surface.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }))
    }
    const out: Record<string, string> = {}
    for (const t of Array.from(dt.types)) out[t] = dt.getData(t)
    return out
  }, fromSel)
}

/** Replay a captured drag payload onto the canvas (a drag that crossed views). */
async function dropPayloadOnCanvas(window: Page, payload: Record<string, string>): Promise<void> {
  await window.evaluate((data) => {
    const surface = document.querySelector('[data-canvas-surface="true"]')
    if (!surface) throw new Error('no canvas')
    const dt = new DataTransfer()
    for (const [k, v] of Object.entries(data)) dt.setData(k, v)
    const r = surface.getBoundingClientRect()
    const clientX = r.left + r.width / 3
    const clientY = r.top + r.height / 3
    for (const type of ['dragenter', 'dragover', 'drop']) {
      surface.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }))
    }
  }, payload)
}

test('WF-1 a widget made from the side menu needs no desk, is named, and is in Files as its own type', async () => {
  const window = await boot()

  // No desk is open: this is Home.
  const tile = await sideMenuWidget(window, 'sticky')
  await tile.click()

  const view = window.locator('[data-testid="widget-file-view"]')
  await expect(view).toBeVisible({ timeout: 8_000 })
  await expect(view).toHaveAttribute('data-kind', 'sticky')
  // Never "Untitled": a dated placeholder until there is content to name it.
  const title = window.locator('[data-testid="widget-file-title"]')
  await expect(title).toContainText('Sticky ·')
  await expect(title).not.toContainText(/untitled/i)
  await expect(window.locator('[data-testid="widget-file-type"]')).toHaveText('Sticky')

  // Fully usable full-pane: the same sticky component, typed into.
  const ta = view.locator('textarea').first()
  await ta.click()
  await ta.fill('# Quarterly offsite plan\nBook the venue by Friday')

  // Named from its content, locally, once it has some.
  await expect(title).toHaveText('Quarterly offsite plan', { timeout: 8_000 })
  const fileId = await view.getAttribute('data-file-id')
  expect(fileId).toBeTruthy()

  // In Files, as a Sticky, under that name.
  await gotoView(window, 'goFiles')
  const row = window.locator(`[data-doc-id="${fileId}"]`).first()
  await expect(row).toBeVisible({ timeout: 8_000 })
  await expect(row).toHaveAttribute('data-widget-kind', 'sticky')
  await expect(row).toContainText('Quarterly offsite plan')
  await expect(row).toContainText('Sticky')

  // Filter by type: Stickies only keeps it; Documents hides it.
  const filter = window.locator('[data-testid="files-type-filter"]')
  await filter.selectOption('widget:sticky')
  await expect(row).toBeVisible()
  await filter.selectOption('documents')
  await expect(row).toHaveCount(0)
  await filter.selectOption('all')

  // Opens from Files back into the full-pane widget.
  await row.dblclick()
  await expect(window.locator('[data-testid="widget-file-view"]')).toBeVisible()
  await expect(window.locator('[data-testid="widget-file-title"]')).toHaveText('Quarterly offsite plan')
})

test('WF-2 dragging a kind from the side menu onto a desk creates a widget file AND places it', async () => {
  const window = await boot()
  const deskId = await openNewDesk(window, 'Drag Desk')
  await sideMenuWidget(window, 'table')

  const payload = await dragOntoCanvas(window, '[data-testid="sidemenu-widget-table"]')
  expect(payload['application/x-plexii-widget-new-file']).toBe('table')

  await expect.poll(async () => (await deskWidgets(window, deskId)).filter((w) => w.kind === 'table').length, { timeout: 8_000 }).toBe(1)
  const [inst] = (await deskWidgets(window, deskId)).filter((w) => w.kind === 'table')
  expect(inst.syncGroupId).toMatch(/^wf:/)
  const fileId = inst.syncGroupId!.slice(3)
  const file = await window.evaluate((id) => (window as unknown as { api: Api }).api.widgetFiles.get(id), fileId)
  expect(file?.kind).toBe('table')
  expect(file?.title).not.toMatch(/untitled/i)
  // And it is visible on the desk.
  await expect(window.locator(`[data-widget-id="${inst.id}"]`)).toBeVisible({ timeout: 8_000 })
})

test('WF-3 an existing widget file dragged onto two desks is one file: edits sync both ways', async () => {
  const window = await boot()
  const file = await window.evaluate(() =>
    (window as unknown as { api: Api }).api.widgetFiles.create({ kind: 'sticky', content: 'Shared shopping list' })
  )
  expect(file.title).toBe('Shared shopping list')

  // Pick the file up in Files: the real dragstart of its row.
  await gotoView(window, 'goFiles')
  const row = window.locator(`[data-doc-id="${file.id}"]`).first()
  await expect(row).toBeVisible({ timeout: 8_000 })
  const payload = await window.evaluate((id) => {
    const el = document.querySelector(`[data-doc-id="${id}"]`)!
    const dt = new DataTransfer()
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const out: Record<string, string> = {}
    for (const t of Array.from(dt.types)) out[t] = dt.getData(t)
    return out
  }, file.id)
  expect(payload['application/x-plexii-widget-file']).toBe(file.id)

  // …and drop it on desk A, then desk B.
  const deskA = await openNewDesk(window, 'Desk A')
  await dropPayloadOnCanvas(window, payload)
  await expect.poll(async () => (await deskWidgets(window, deskA)).length, { timeout: 8_000 }).toBe(1)
  const deskB = await openNewDesk(window, 'Desk B')
  await dropPayloadOnCanvas(window, payload)
  await expect.poll(async () => (await deskWidgets(window, deskB)).length, { timeout: 8_000 }).toBe(1)

  const [a] = await deskWidgets(window, deskA)
  const [b] = await deskWidgets(window, deskB)
  expect(a.syncGroupId).toBe(`wf:${file.id}`)
  expect(b.syncGroupId).toBe(`wf:${file.id}`)
  expect(b.content).toBe('Shared shopping list')

  // Edit on desk B (open) by typing into the instance.
  const inst = window.locator(`[data-widget-id="${b.id}"]`)
  await expect(inst).toBeVisible({ timeout: 8_000 })
  await window.evaluate(
    async ({ id }) => {
      const w = window as unknown as { __fbWidgets: { getState: () => { update: (i: string, p: { content: string }) => Promise<void> } } }
      await w.__fbWidgets.getState().update(id, { content: 'Shared shopping list\n- oat milk' })
    },
    { id: b.id }
  )
  // → desk A's instance and the file both have it.
  await expect.poll(async () => (await deskWidgets(window, deskA))[0].content, { timeout: 8_000 }).toContain('oat milk')
  await expect
    .poll(async () => (await window.evaluate((id) => (window as unknown as { api: Api }).api.widgetFiles.get(id), file.id))?.content, { timeout: 8_000 })
    .toContain('oat milk')

  // Edit the FILE (full pane) → both desk instances follow.
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }
    w.__fbView.getState().goDocument(id)
  }, file.id)
  const pane = window.locator('[data-testid="widget-file-view"]')
  await expect(pane).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('[data-testid="widget-file-instances"]')).toHaveText('On 2 desks')
  // A sticky with content shows its rendered view; a click drops into editing.
  await pane.locator('.fb-sticky-rendered').first().click()
  await pane.locator('textarea').first().fill('Shared shopping list\n- oat milk\n- coffee')
  await expect.poll(async () => (await deskWidgets(window, deskA))[0].content, { timeout: 8_000 }).toContain('coffee')
  await expect.poll(async () => (await deskWidgets(window, deskB))[0].content, { timeout: 8_000 }).toContain('coffee')
})

test('WF-4 moving a kind to Other widgets and back persists across a reload', async () => {
  const window = await boot()
  const main = window.locator('[data-testid="sidemenu-widgets-main"]')
  const other = window.locator('[data-testid="sidemenu-other-widgets"]')
  await expect(main.locator('[data-testid="sidemenu-widget-sticky"]')).toBeVisible({ timeout: 8_000 })

  await main.locator('[data-testid="sidemenu-widget-sticky"]').click({ button: 'right' })
  await window.locator('[data-canvas-ctx-menu]').getByText('Move to Other work widgets').click()
  await expect(main.locator('[data-testid="sidemenu-widget-sticky"]')).toHaveCount(0)
  await expect(other.locator('[data-testid="sidemenu-widget-sticky"]')).toHaveCount(1)

  await window.reload()
  await waitForReady(window)
  await expect(window.locator('[data-testid="sidemenu-widgets-main"] [data-testid="sidemenu-widget-sticky"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="sidemenu-other-widgets"] [data-testid="sidemenu-widget-sticky"]')).toHaveCount(1)

  // And back, by right-click → Move to Widgets.
  const tile = await sideMenuWidget(window, 'sticky')
  await tile.click({ button: 'right' })
  await window.locator('[data-canvas-ctx-menu]').getByText('Move to Work widgets').click()
  await expect(window.locator('[data-testid="sidemenu-widgets-main"] [data-testid="sidemenu-widget-sticky"]')).toHaveCount(1)

  await window.reload()
  await waitForReady(window)
  await expect(window.locator('[data-testid="sidemenu-widgets-main"] [data-testid="sidemenu-widget-sticky"]')).toHaveCount(1)
})

test('WF-5 the assistant and Brain find a widget file by its content', async () => {
  // Retrieval loads the local embedding model on its first call, which can take
  // most of the default 30 s on a cold machine; the assertion is about what is
  // found, not how fast.
  test.setTimeout(90_000)
  const window = await boot()
  // A table file whose only words are in its rows: findable means the
  // serialiser (markdown table) reached the index, not just the title.
  const file = await window.evaluate(async () => {
    const a = (window as unknown as { api: Api }).api
    const t = await a.tables.create({
      taskId: null,
      title: '',
      schema: { columns: [{ id: 'c1', label: 'Supplier', type: 'text' }, { id: 'c2', label: 'Quote', type: 'number' }] } as never
    })
    await a.tables.createRow({ tableId: t.id, cells: { c1: 'Zephyrine Octagon Ltd', c2: 4200 } })
    return a.widgetFiles.create({ kind: 'table', content: t.id })
  })
  // Named from the table: first column header + row count.
  expect(file.title).toBe('Supplier · 1 row')

  // Brain / assistant retrieval (the same retrieveSources the assistant uses).
  const asked = await window.evaluate(() =>
    (window as unknown as { api: Api }).api.workspace.ask('Which supplier is Zephyrine Octagon?')
  )
  expect((asked.sources ?? []).map((s) => s.docId)).toContain(file.id)

  // Global search finds it too, and it opens as the widget.
  const hits = await window.evaluate(() => (window as unknown as { api: Api }).api.search.query('Zephyrine'))
  expect(hits.some((h) => h.id === file.id)).toBe(true)

  // An @-mention of it reads the markdown table.
  const ref = await window.evaluate(async (id) => {
    const d = await (window as unknown as { api: Api }).api.documents.get(id)
    return d?.docType
  }, file.id)
  expect(ref).toBe('widget')
})

test('WF-6 right-click → Add to this desk is the no-drag path, and Save as file promotes a desk widget', async () => {
  const window = await boot()
  const deskId = await openNewDesk(window, 'Keyboard Desk')
  await addWidgetToDesk(window, 'mindmap')
  const ws = await deskWidgets(window, deskId)
  const mm = ws.find((w) => w.kind === 'mindmap')!
  expect(mm.syncGroupId).toMatch(/^wf:/)

  // A plain desk widget (quick-add key path) → Save as file.
  const plain = await window.evaluate(async (id) => {
    const a = (window as unknown as { api: Api }).api
    return a.widgets.create({ taskId: id, kind: 'note', content: 'Meeting notes for Thursday', x: 400, y: 400 })
  }, deskId)
  const promoted = await window.evaluate((id) => (window as unknown as { api: Api }).api.widgetFiles.promote(id), plain.id)
  expect(promoted?.kind).toBe('note')
  const after = await deskWidgets(window, deskId)
  expect(after.find((w) => w.id === plain.id)?.syncGroupId).toBe(`wf:${promoted!.id}`)
})
