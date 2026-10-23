/**
 * Any content into any destination, end to end in the real app, for
 * PlexiiWrite and PlexiiCells as DESTINATIONS.
 *
 * AW-1 a sheet snippet (with a formula) inserted into Write as a duplicate
 *      lands as a table of what the cells display, and the conversion's line
 *      shows in the notice toast.
 * AW-2 a PlexiiDraw copy pasted into Write with ⌘V lands as a picture (an
 *      image node holding the drawing's SVG), said so in the toast.
 * AC-1 a Write snippet holding a table inserted into Cells lands as its rows
 *      at the active cell.
 * AC-2 a drawing is not offered in Cells' library at all: acceptsFor('sheet')
 *      excludes it, so the library cannot offer a snippet Cells would refuse.
 *
 * Masters are seeded through window.api.snippets.create (the store the save
 * dialog writes) with bodies in each app's capture shape. Results are read
 * back from the stored documents. AW-2 uses the machine's real clipboard:
 * every item and type on it is saved before and put back after.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, switchArea, type LaunchedApp } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, rectObject, seedDrawDoc, stagePoint, v1Body } from './_drawHelpers'
import { restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'

let app: LaunchedApp
let window: Page
let savedPasteboard: SavedPasteboard | null = null

test.beforeAll(async () => {
  if (process.platform === 'darwin') savedPasteboard = savePasteboard()
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await suppressFeatureSpotlights(window)
})

test.afterAll(async () => {
  await app?.dispose()
  if (savedPasteboard) restorePasteboard(savedPasteboard)
})

async function seedSnippet(kind: string, name: string, body: unknown): Promise<string> {
  return window.evaluate(
    async ({ kind, name, body }) => {
      const api = (window as unknown as { api: { snippets: { create: (d: unknown) => Promise<{ ok: boolean; snippet?: { id: string }; error?: string }> } } }).api
      const res = await api.snippets.create({ kind, name, body, scope: 'personal' })
      if (!res.ok || !res.snippet) throw new Error(res.error ?? 'not saved')
      return res.snippet.id
    },
    { kind, name, body }
  )
}

// ── PlexiiWrite ──────────────────────────────────────────────────────────────

async function startBlankDoc(): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Document' }).first().click()
  const surface = window.locator('[data-testid="doc-editor-surface"]')
  await expect(surface).toBeVisible({ timeout: 8_000 })
  await surface.click()
  await surface.type('Above.')
  await window.keyboard.press('Enter')
}

/** The newest Write document's stored body, as JSON text. */
async function newestDocBody(): Promise<string> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = (await api.documents.list()).filter((d) => d.docType === 'doc')
    docs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const doc = docs[0] ? await api.documents.get(docs[0].id) : null
    return JSON.stringify(doc?.body ?? null)
  })
}

test('AW-1 a sheet snippet into Write: a table of the displayed values, the conversion said', async () => {
  test.setTimeout(90_000)
  await seedSnippet('sheet', 'Pen totals', { kind: 'sheet', rows: [['Item', 'Qty', 'Total'], ['Pens', '2', '=B2*3']], origin: { r: 0, c: 0 } })
  await startBlankDoc()
  await window.locator('[data-testid="doc-menu-insert"]').click()
  await window.locator('[data-testid="doc-menu-insert-list"]').getByText('Insert snippet…').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
  const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Pen totals' })
  await expect(row).toBeVisible({ timeout: 5_000 })
  await row.locator('[data-testid="snippet-insert-duplicate"]').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })

  await expect(window.locator('[data-testid="notice-toast"]')).toContainText('Formulas become their values.', { timeout: 5_000 })
  await expect(window.locator('[data-testid="doc-editor-surface"] table')).toContainText('Pens')

  await expect
    .poll(async () => {
      const b = await newestDocBody()
      return b.includes('Pens') && /"text":"6"/.test(b)
    }, { timeout: 10_000 })
    .toBe(true)
  const body = await newestDocBody()
  expect(body).toMatch(/table/)
  expect(body).toContain('Pens')
  expect(body).not.toContain('=B2*3')
})

test('AW-2 a PlexiiDraw copy pasted into Write: a picture of the drawing, said so', async () => {
  test.skip(process.platform !== 'darwin', 'uses the macOS pasteboard save/restore')
  test.setTimeout(90_000)
  await keepNoticesOutOfTheWay(window)
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90)]), 'Paste source')
  await openDocument(window, id)
  const p = await stagePoint(window, 800, { x: 180, y: 165 })
  await window.mouse.click(p.x, p.y)
  await window.keyboard.press('Meta+c')
  const types = await app.app.evaluate(async ({ clipboard }) => {
    for (let i = 0; i < 40; i++) {
      const t = (await clipboard.read())[0]?.types ?? []
      if (t.includes('web application/vnd.plexii.draw+json')) return t
      await new Promise((r) => setTimeout(r, 100))
    }
    return (await clipboard.read())[0]?.types ?? []
  })
  expect(types).toContain('web application/vnd.plexii.draw+json')

  await startBlankDoc()
  await window.keyboard.press('Meta+v')
  const img = window.locator('[data-testid="doc-editor-surface"] img').first()
  await expect(img).toBeVisible({ timeout: 8_000 })
  expect(await img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  await expect(window.locator('[data-testid="notice-toast"]')).toContainText('It becomes a picture: edit it in PlexiiDraw.', { timeout: 5_000 })
  await expect.poll(async () => /"src":"data:image\/svg\+xml/.test(await newestDocBody()), { timeout: 10_000 }).toBe(true)
})

// ── PlexiiCells ──────────────────────────────────────────────────────────────

async function newSheet(): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-sheets"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-sheets"]').click()
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
}

async function sheetMenu(id: string, item: string): Promise<void> {
  await window.locator(`[data-testid="sheet-menubar-${id}"]`).click()
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await window
    .locator(`[data-testid="sheet-menubar-${id}-list"]`)
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click()
}

/** The newest workbook's first sheet rows, as stored. */
async function newestSheetRows(): Promise<string[][]> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = (await api.documents.list()).filter((d) => d.docType === 'sheet')
    docs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const doc = docs[0] ? await api.documents.get(docs[0].id) : null
    return ((doc?.body ?? {}) as { sheets?: Array<{ rows?: string[][] }> }).sheets?.[0]?.rows ?? []
  })
}

const P = (text: string): unknown => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const cell = (type: string, text: string): unknown => ({ type, content: [P(text)] })

test('AC-1 a Write snippet holding a table into Cells: its rows at the active cell', async () => {
  test.setTimeout(90_000)
  await seedSnippet('doc', 'Price table', {
    kind: 'doc',
    content: [
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'Item'), cell('tableHeader', 'Price')] },
          { type: 'tableRow', content: [cell('tableCell', 'Pens'), cell('tableCell', '3')] }
        ]
      }
    ],
    text: 'Item Price\nPens 3'
  })
  await newSheet()
  await window.locator('[data-testid="cell-0-0"]').click()
  await sheetMenu('insert', 'Insert snippet…')
  await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
  const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Price table' })
  await expect(row).toBeVisible({ timeout: 5_000 })
  await row.locator('[data-testid="snippet-insert-duplicate"]').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })

  await expect
    .poll(async () => {
      const rows = await newestSheetRows()
      return [rows[0]?.[0], rows[0]?.[1], rows[1]?.[0], rows[1]?.[1]]
    }, { timeout: 10_000 })
    .toEqual(['Item', 'Price', 'Pens', '3'])
})

test('AC-2 a drawing is not offered in Cells’ library: Cells holds values, not pictures', async () => {
  test.setTimeout(60_000)
  await seedSnippet('draw', 'Logo for cells', {
    kind: 'draw',
    objects: [rectObject('r', 0, 0, 100, 60)],
    assets: {},
    swatches: []
  })
  await seedSnippet('sheet', 'Cells control', { kind: 'sheet', rows: [['1']] })
  await newSheet()
  await sheetMenu('insert', 'Insert snippet…')
  await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
  // The library lists the sheet snippet, so an absent row is the kind filter, not an empty library.
  await expect(window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Cells control' })).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Logo for cells' })).toHaveCount(0)
})
