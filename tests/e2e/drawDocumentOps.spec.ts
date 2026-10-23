// PlexiiDraw on a desk: the widget's File and Document menus act on the
// drawing the WIDGET shows (4.3.41).
//
// The bug, shipped in public 4.3.33 through 4.3.40: Draw's document commands
// read the documents store's `active` document. A desk widget (OfficeDocWidget)
// holds its drawing in local state and never puts it in the store, so a Draw
// widget's File › Move to trash binned whatever Documents last had open, Make a
// copy copied it, Rename renamed it, Version history showed its history, and
// Document › Meeting invited people to it. The store has a document active
// while you stand on a desk whenever one was opened or created without
// navigating to it (PlexiiAssist's "create a document" is the common way).
// Here B is made active through the store's own open() (window.__fbDocuments,
// a thin handle to the real store).
//
// Each test: drawing A in a Draw widget on a desk, drawing B active; act from
// A's widget; A is what changed, B is untouched.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'
import { rectObject, v1Body } from './_drawHelpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Seed = { taskId: string; widgetId: string; a: { id: string; title: string }; b: { id: string; title: string } }

async function seed(window: Page): Promise<Seed> {
  // Each drawing holds a shape only it has (its id is the marker), so anything
  // taken from the wrong drawing shows -- and a shape survives the studio
  // normalising the body, where an arbitrary extra key would not.
  const bodies = { a: v1Body([rectObject('A-ONLY', 40, 40, 120, 80)]), b: v1Body([rectObject('B-ONLY', 60, 60, 90, 90)]) }
  return window.evaluate(async (bodies) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const a = (await api.documents.create({ docType: 'draw', title: 'A on the desk', body: bodies.a } as never)) as { id: string; title: string }
    const b = (await api.documents.create({ docType: 'draw', title: 'B open in Documents', body: bodies.b } as never)) as { id: string; title: string }
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Draw File menu' })
    const w = (await api.widgets.create({ taskId: task.id, kind: 'draw', content: a.id, x: 240, y: 160, width: 900, height: 640 } as never)) as { id: string }
    return { taskId: task.id, widgetId: w.id, a: { id: a.id, title: a.title }, b: { id: b.id, title: b.title } }
  }, bodies)
}

async function openDeskWithBActive(window: Page, s: Seed): Promise<void> {
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), s.taskId)
  await window.waitForSelector(`[data-widget-id="${s.widgetId}"] [data-testid="draw-studio"]`, { timeout: 20_000 })
  // B becomes the store's active document while the desk stays on screen.
  await window.evaluate(async (id) => {
    const store = (window as unknown as { __fbDocuments: { getState: () => { open: (i: string) => Promise<void> } } }).__fbDocuments
    await store.getState().open(id)
  }, s.b.id)
  const activeId = await window.evaluate(() => (window as unknown as { __fbDocuments: { getState: () => { active: { id: string } | null } } }).__fbDocuments.getState().active?.id)
  expect(activeId, 'B is the store’s active document').toBe(s.b.id)
  await expect(window.locator(`[data-widget-id="${s.widgetId}"] [data-testid="draw-studio"]`), 'the desk is still on screen').toBeVisible()
}

async function menuItem(window: Page, s: Seed, menu: 'file' | 'document', label: string): Promise<void> {
  const widget = window.locator(`[data-widget-id="${s.widgetId}"]`)
  const trigger = widget.locator(`[data-testid="draw-studio-menubar-${menu}"]`)
  const list = window.locator(`[data-testid="draw-studio-menubar-${menu}-list"]`)
  const item = list.locator('button').filter({ hasText: label }).first()
  // The menu bar scrolls sideways in a widget (Document sits past the fold),
  // and a menu closes when it scrolls. Bring the trigger in and let it settle
  // first; then open and click, again from the top if the list closed under us.
  await trigger.scrollIntoViewIfNeeded()
  await window.waitForTimeout(300)
  await expect(async () => {
    if (!(await list.isVisible())) await trigger.click()
    await expect(item).toBeEnabled({ timeout: 1_000 })
    await item.click({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}

const docs = (window: Page) =>
  window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return { live: (await api.documents.list()).map((d) => d.id), trashed: (await api.documents.listTrashed()).map((d) => d.id) }
  })

const titleOf = (window: Page, id: string) =>
  window.evaluate(async (id) => (await (window as unknown as { api: typeof window.api }).api.documents.get(id))?.title ?? null, id)

async function start(): Promise<{ window: Page; s: Seed }> {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openDeskWithBActive(window, s)
  return { window, s }
}

test('DDO-1 File › Move to trash in a Draw desk widget trashes the widget’s drawing, not the active one', async () => {
  test.setTimeout(90_000)
  const { window, s } = await start()

  await menuItem(window, s, 'file', 'Move to trash')
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  // The confirm names the widget's drawing.
  await expect(dialog).toContainText(`Move "${s.a.title}" to trash?`)
  await dialog.getByRole('button', { name: 'Move to trash' }).click()

  await expect.poll(async () => (await docs(window)).trashed.includes(s.a.id), { timeout: 8_000 }).toBe(true)
  const after = await docs(window)
  expect(after.trashed, 'A went to the Trash').toContain(s.a.id)
  expect(after.trashed, 'B was not trashed').not.toContain(s.b.id)
  expect(after.live, 'B is still a live document').toContain(s.b.id)
  await expect(window.locator(`[data-widget-id="${s.widgetId}"] [data-testid="office-doc-trashed"]`), 'the widget says its drawing is in the Trash').toBeVisible()
})

test('DDO-2 File › Rename renames the widget’s drawing, by id; B keeps its name', async () => {
  test.setTimeout(90_000)
  const { window, s } = await start()

  await menuItem(window, s, 'file', 'Rename')
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  const input = dialog.locator('input').first()
  await expect(input, 'the prompt starts from the widget’s title').toHaveValue(s.a.title)
  await input.fill('A renamed on the desk')
  await dialog.getByRole('button', { name: 'Rename' }).click()

  await expect.poll(() => titleOf(window, s.a.id), { timeout: 8_000 }).toBe('A renamed on the desk')
  expect(await titleOf(window, s.b.id)).toBe(s.b.title)
  await expect(window.locator(`[data-widget-id="${s.widgetId}"]`), 'the widget header follows').toContainText('A renamed on the desk')
})

test('DDO-3 File › Make a copy copies the widget’s drawing, not the active one', async () => {
  test.setTimeout(90_000)
  const { window, s } = await start()
  const before = await docs(window)

  await menuItem(window, s, 'file', 'Make a copy')
  await expect.poll(async () => (await docs(window)).live.length, { timeout: 8_000 }).toBe(before.live.length + 1)
  const result = await window.evaluate(
    async ({ before, b }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.documents.list()
      const copy = list.find((d) => !before.includes(d.id))!
      const full = await api.documents.get(copy.id)
      const bDoc = await api.documents.get(b)
      return { title: copy.title, docType: copy.docType, body: JSON.stringify(full?.body ?? null), bBody: JSON.stringify(bDoc?.body ?? null) }
    },
    { before: before.live, b: s.b.id }
  )
  expect(result.title).toBe(`Copy of ${s.a.title}`)
  expect(result.docType).toBe('draw')
  expect(result.body, 'the copy is A').toContain('A-ONLY')
  expect(result.body, 'not B').not.toContain('B-ONLY')
  expect(result.bBody, 'B is untouched').toContain('B-ONLY')
  expect((await docs(window)).trashed).toEqual([])
})

test('DDO-4 File › Version history opens the widget’s drawing’s history', async () => {
  test.setTimeout(90_000)
  const { window, s } = await start()

  await menuItem(window, s, 'file', 'Version history')
  const panel = window.locator('[data-testid="doc-history-panel"]')
  await expect(panel).toBeVisible({ timeout: 5_000 })
  await expect(panel).toHaveAttribute('data-doc-id', s.a.id)
})

test('DDO-5 Document › Meeting is about the widget’s drawing', async () => {
  test.setTimeout(90_000)
  const { window, s } = await start()

  await menuItem(window, s, 'document', 'Meeting')
  const dialog = window.locator('[data-testid="meeting-launch-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog).toContainText(s.a.title)
  await expect(dialog).not.toContainText(s.b.title)
})
