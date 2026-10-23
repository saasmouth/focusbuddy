// An office editor's File menu acts on the document it SHOWS (4.3.41).
//
// The bug, shipped in public 4.3.33 in all five office apps: the File menus read
// the documents store's `active` document and acted on it. A desk widget
// (OfficeDocWidget) holds its own document in local state, so its menu acted on
// whatever the store had active: Move to trash trashed a different document,
// Make a copy copied a different body, Version history opened a different
// history. The store has a document active while you stand on a desk whenever
// one was created or opened without navigating to it; PlexiiAssist's "create a
// document" action is the common way (createBlank sets `active` and stays put).
// Here B is put into that state the way createBlank leaves it: set as the
// store's `active`, without migrating or writing it (window.__fbDocuments, a
// thin handle to the real store). Edge-pan is off for the run: the widget's
// menus sit near the canvas edge, and a pointer resting there pans the desk.
//
// For each app: document A in a widget on a desk, document B active; from A's
// widget, File › Move to trash / Make a copy / Version history act on A, and B
// is untouched.
//
// All five are converted (Deck and Diagrams: d8; Write and Cells: ec; Design:
// f0). An app marked converted: false would run under test.fail, which INSISTS
// it still fails, so a regression cannot hide behind a skip.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface App {
  name: string
  docType: 'doc' | 'sheet' | 'slides' | 'map' | 'design'
  widgetKind: string
  fileMenu: string // the File menu trigger's testid
  converted: boolean
}
const APPS: App[] = [
  { name: 'Deck', docType: 'slides', widgetKind: 'slides', fileMenu: 'slides-menubar-file', converted: true },
  { name: 'Diagrams', docType: 'map', widgetKind: 'map', fileMenu: 'draw-menubar-file', converted: true },
  { name: 'Write', docType: 'doc', widgetKind: 'doc', fileMenu: 'doc-menu-file', converted: true },
  { name: 'Cells', docType: 'sheet', widgetKind: 'sheet', fileMenu: 'sheet-menubar-file', converted: true },
  { name: 'Design', docType: 'design', widgetKind: 'design', fileMenu: 'design-menubar-file', converted: true }
]

type Seed = { taskId: string; widgetId: string; a: { id: string; title: string }; b: { id: string; title: string }; bUpdatedAt: number }

async function seed(window: Page, app: App): Promise<Seed> {
  return window.evaluate(async (app) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const a = (await api.documents.create({ docType: app.docType, title: `A widget ${app.name}` } as never)) as { id: string; title: string }
    const b = (await api.documents.create({ docType: app.docType, title: `B active ${app.name}` } as never)) as { id: string; title: string }
    // B carries a body only B has, so a copy taken from the wrong document shows.
    // It must be VALID for its type: Design and Diagrams bodies are normalised on
    // read, which strips anything the type does not know (a bare marker key would
    // vanish and make A and B indistinguishable). So: a Design 1234 wide, a
    // Diagram whose page is named B-ONLY, and a marker key elsewhere (Write,
    // Cells and Deck keep it).
    const bDefault = ((await api.documents.get(b.id)) as { body: Record<string, unknown> }).body
    const bBody =
      app.docType === 'design' ? { ...bDefault, width: 1234 } : app.docType === 'map' ? { ...bDefault, pageName: 'B-ONLY' } : { ...bDefault, marker: 'B-ONLY' }
    await api.documents.update(b.id, { body: bBody as never })
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: `File menu ${app.name}` })
    const w = (await api.widgets.create({ taskId: task.id, kind: app.widgetKind, content: a.id, x: 40, y: 40, width: 1100, height: 760 } as never)) as { id: string }
    const bUpdatedAt = ((await api.documents.get(b.id)) as { updatedAt: number }).updatedAt
    return { taskId: task.id, widgetId: w.id, a: { id: a.id, title: a.title }, b: { id: b.id, title: b.title }, bUpdatedAt }
  }, app)
}

async function openDeskWithBActive(window: Page, s: Seed): Promise<void> {
  await suppressFeatureSpotlights(window)
  await window.evaluate(() => {
    const raw = localStorage.getItem('fb.nav.prefs')
    const prefs = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    localStorage.setItem('fb.nav.prefs', JSON.stringify({ ...prefs, edgePanEnabled: false }))
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), s.taskId)
  await window.waitForSelector(`[data-widget-id="${s.widgetId}"]`, { timeout: 15_000 })
  // B becomes the store's active document while the desk stays on screen, as
  // createBlank leaves it (set, not opened in an editor, not rewritten).
  await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const store = (window as unknown as { __fbDocuments: { setState: (s: object) => void } }).__fbDocuments
    store.setState({ active: await api.documents.get(id) })
  }, s.b.id)
  const activeId = await window.evaluate(() => (window as unknown as { __fbDocuments: { getState: () => { active: { id: string } | null } } }).__fbDocuments.getState().active?.id)
  expect(activeId, 'B is the store’s active document').toBe(s.b.id)
}

async function fileItem(window: Page, s: Seed, app: App, label: string): Promise<void> {
  const widget = window.locator(`[data-widget-id="${s.widgetId}"]`)
  // Wait for the widget to stop moving (the desk can still be settling its
  // camera just after opening); a click on a moving menu never lands.
  let last = ''
  await expect
    .poll(async () => {
      const b = await widget.boundingBox()
      const now = b ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}` : ''
      const settled = now !== '' && now === last
      last = now
      return settled
    }, { timeout: 8_000, intervals: [250] })
    .toBe(true)
  await widget.locator(`[data-testid="${app.fileMenu}"]`).click()
  const item = widget.locator(`[data-testid="${app.fileMenu}-list"] button`).filter({ hasText: label }).first()
  await expect(item).toBeVisible()
  // force skips Playwright's hit test, so first prove nothing covers the item: the
  // topmost element at its centre must be the item or inside it. A covered menu
  // therefore fails here instead of "clicking" through something else.
  await expect
    .poll(
      () =>
        item.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return !!hit && (hit === el || el.contains(hit))
        }),
      { timeout: 5_000, message: `the "${label}" menu item is on top at its centre` }
    )
    .toBe(true)
  // force: the item holds still (probed), but under a loaded machine Playwright's
  // frame-to-frame stability check can stay "not stable" for the whole timeout,
  // on whichever app it happens to hit. Force still clicks the item's centre; it
  // only skips that wait. Every assertion below is about the outcome (which
  // document was trashed, copied or opened), not the click.
  await item.click({ force: true })
}

const docs = (window: Page) =>
  window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return { live: (await api.documents.list()).map((d) => d.id), trashed: (await api.documents.listTrashed()).map((d) => d.id) }
  })

for (const app of APPS) {
  test.describe(`${app.name}: a desk widget’s File menu acts on its own document`, () => {
    if (!app.converted) test.fail(true, `${app.name}'s menu still reads the store's active document; remove this marker when it takes DocumentOps`)

    test(`${app.name} — Move to trash trashes the widget’s document, not the active one`, async () => {
      test.setTimeout(90_000)
      launched = await launchApp()
      const { window } = launched
      await waitForReady(window)
      const s = await seed(window, app)
      await openDeskWithBActive(window, s)

      await fileItem(window, s, app, 'Move to Trash')
      const dialog = window.locator('[data-testid="prompt-dialog"]')
      await expect(dialog).toBeVisible({ timeout: 5_000 })
      await dialog.getByRole('button', { name: 'Move to trash' }).click()

      await expect.poll(async () => (await docs(window)).trashed.includes(s.a.id), { timeout: 8_000 }).toBe(true)
      const after = await docs(window)
      expect(after.trashed, 'A went to the Trash').toContain(s.a.id)
      expect(after.live, 'B is untouched').toContain(s.b.id)
      expect(after.trashed, 'B was not trashed').not.toContain(s.b.id)
      await expect(window.locator(`[data-widget-id="${s.widgetId}"] [data-testid="office-doc-trashed"]`), 'the widget says its document is in the Trash').toBeVisible()
    })

    test(`${app.name} — Make a copy copies the widget’s document, not the active one`, async () => {
      test.setTimeout(90_000)
      launched = await launchApp()
      const { window } = launched
      await waitForReady(window)
      const s = await seed(window, app)
      await openDeskWithBActive(window, s)
      const before = await docs(window)

      await fileItem(window, s, app, 'Make a copy')
      await expect.poll(async () => (await docs(window)).live.length, { timeout: 8_000 }).toBe(before.live.length + 1)
      const result = await window.evaluate(
        async ({ before, a, b }) => {
          const api = (window as unknown as { api: typeof window.api }).api
          const list = await api.documents.list()
          const copy = list.find((d) => !before.includes(d.id))!
          const full = await api.documents.get(copy.id)
          const aDoc = await api.documents.get(a)
          const bDoc = await api.documents.get(b)
          return { title: copy.title, body: JSON.stringify(full?.body ?? null), aBody: JSON.stringify(aDoc?.body ?? null), bBody: JSON.stringify(bDoc?.body ?? null), bUpdatedAt: bDoc?.updatedAt }
        },
        { before: before.live, a: s.a.id, b: s.b.id }
      )
      const isB = (json: string): boolean => (app.docType === 'design' ? (JSON.parse(json) as { width?: number }).width === 1234 : json.includes('B-ONLY'))
      expect(isB(result.bBody), 'the fixture tells A and B apart (B’s marker survived)').toBe(true)
      expect(isB(result.aBody), 'A is not B').toBe(false)
      expect(result.title).toBe(`Copy of ${s.a.title}`)
      expect(result.body, 'the copy has A’s body').toBe(result.aBody)
      expect(isB(result.body), 'not B’s').toBe(false)
      expect(result.bUpdatedAt, 'B was not written').toBe(s.bUpdatedAt)
    })

    test(`${app.name} — Version history opens the widget’s document’s history, not the active one’s`, async () => {
      test.setTimeout(90_000)
      launched = await launchApp()
      const { window } = launched
      await waitForReady(window)
      const s = await seed(window, app)
      await openDeskWithBActive(window, s)

      await fileItem(window, s, app, 'Version history')
      const panel = window.locator('[data-testid="doc-history-panel"]')
      await expect(panel).toBeVisible({ timeout: 5_000 })
      await expect(panel).toHaveAttribute('data-doc-id', s.a.id)
    })
  })
}
