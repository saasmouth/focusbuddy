/**
 * A LIVE converted snippet in PlexiiWrite, end to end: the gate for offering
 * Live for kinds a document can only hold converted (docSnippets.ts
 * DOC_LIVE_CONVERTED).
 *
 * WC-1 a SHEET snippet inserted Live renders as a read-only table of what its
 *      cells display (formulas computed), marked "Live · read-only" and not
 *      editable in place; editing the master changes it where it stands;
 *      deleting the master leaves an explicit missing state, not a blank.
 * WC-2 a DRAW snippet inserted Live renders as an <img> of a
 *      data:image/svg+xml picture with a real, non-zero size (the document's
 *      sanitiser strips inline <svg>, so inline markup would be a silent blank).
 *
 * The masters are seeded through window.api.snippets (the store the save
 * dialog writes), with bodies in the shape each app's capture produces.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let app: LaunchedApp
let window: Page

test.beforeAll(async () => {
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await suppressFeatureSpotlights(window)
})
test.afterAll(async () => {
  await app.dispose()
})

async function openDocumentsHub(): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

async function startBlankDoc(): Promise<void> {
  await openDocumentsHub()
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Document' }).first().click()
  const surface = window.locator('[data-testid="doc-editor-surface"]')
  await expect(surface).toBeVisible({ timeout: 8_000 })
  await surface.click()
  await surface.type('Above the snippet.')
}

async function seed(kind: string, name: string, body: unknown): Promise<string> {
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

async function insertLive(name: string): Promise<void> {
  await window.locator('[data-testid="doc-menu-insert"]').click()
  await window.locator('[data-testid="doc-menu-insert-list"]').getByText('Saved snippet').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
  const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 5_000 })
  // Live is offered for this converted kind: that is the gate under test.
  await expect(row.locator('[data-testid="snippet-insert-live"]')).toBeVisible()
  await row.locator('[data-testid="snippet-insert-live"]').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })
}

test('WC-1 a sheet snippet live in Write: a read-only table that follows its master, then an honest missing state', async () => {
  test.setTimeout(90_000)
  const id = await seed('sheet', 'Price block', { kind: 'sheet', rows: [['Item', 'Qty', 'Total'], ['Pens', '2', '=B2*3']], origin: { r: 0, c: 0 } })
  await startBlankDoc()
  await window.keyboard.press('Enter')
  await insertLive('Price block')

  const embed = window.locator('[data-testid="snippet-embed"]')
  await expect(embed).toBeVisible({ timeout: 8_000 })
  const table = embed.locator('table')
  await expect(table).toBeVisible({ timeout: 8_000 })
  await expect(table).toContainText('Pens')
  await expect(table).toContainText('6') // =B2*3, computed by Cells' engine
  await expect(table).not.toContainText('=B2*3')

  // Read-only: the mode says so, and the content is not editable in place.
  await embed.hover()
  await expect(embed.locator('[data-testid="snippet-embed-mode"]')).toHaveText(/Live · read-only/, { timeout: 5_000 })
  const editable = await embed.evaluate((el) => {
    for (let n: HTMLElement | null = el; n; n = n.parentElement) if (n.getAttribute('contenteditable') === 'false') return false
    return true
  })
  expect(editable, 'the converted instance sits in a non-editable node').toBe(false)
  // And nothing of the conversion is written into the document: the stored
  // body holds the reference alone, so the master is never copied or
  // overwritten through a conversion.
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (window as unknown as { api: { documents: { list: () => Promise<Array<{ id: string; docType: string; updatedAt: number }>>; get: (id: string) => Promise<{ body: unknown } | null> } } }).api
          const docs = (await api.documents.list()).filter((d) => d.docType === 'doc').sort((a, b) => b.updatedAt - a.updatedAt)
          const doc = docs[0] ? await api.documents.get(docs[0].id) : null
          return JSON.stringify(doc?.body ?? null)
        }),
      { timeout: 8_000 }
    )
    .toMatch(/"type":"snippetEmbed"/)
  const stored = await window.evaluate(async () => {
    const api = (window as unknown as { api: { documents: { list: () => Promise<Array<{ id: string; docType: string; updatedAt: number }>>; get: (id: string) => Promise<{ body: unknown } | null> } } }).api
    const docs = (await api.documents.list()).filter((d) => d.docType === 'doc').sort((a, b) => b.updatedAt - a.updatedAt)
    return JSON.stringify((await api.documents.get(docs[0].id))?.body ?? null)
  })
  expect(stored).not.toContain('Pens')
  expect(stored).not.toContain('"type":"table"')

  // Edit the master: the instance follows where it stands.
  const ok = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: { snippets: { update: (id: string, p: unknown) => Promise<{ ok: boolean }> } } }).api
    return (await api.snippets.update(id, { body: { kind: 'sheet', rows: [['Item', 'Qty', 'Total'], ['Pens', '7', '=B2*3']], origin: { r: 0, c: 0 } } })).ok
  }, id)
  expect(ok).toBe(true)
  await expect(table).toContainText('21', { timeout: 8_000 })

  // Delete the master: an explicit missing state, never a blank or a stale copy.
  const gone = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: { snippets: { delete: (id: string) => Promise<{ ok: boolean }> } } }).api
    return (await api.snippets.delete(id)).ok
  }, id)
  expect(gone).toBe(true)
  await expect(window.locator('[data-testid="snippet-embed-missing"]')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('[data-testid="snippet-embed"] table')).toHaveCount(0)
})

test('WC-2 a drawing live in Write: an <img> of a data:image/svg+xml picture with a real size', async () => {
  test.setTimeout(90_000)
  await seed('draw', 'Logo art', {
    kind: 'draw',
    objects: [{ id: 'r', type: 'path', shapeKind: 'rect', path: { subpaths: [{ closed: true, nodes: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 60 }, { x: 0, y: 60 }] }] }, fill: { type: 'solid', color: '#6d5dfc' } }],
    assets: {},
    swatches: []
  })
  await startBlankDoc()
  await window.keyboard.press('Enter')
  await insertLive('Logo art')
  const img = window.locator('[data-testid="snippet-embed"] img').first()
  await expect(img).toBeVisible({ timeout: 8_000 })
  expect(await img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 8_000 }).toBeGreaterThan(0)
  const box = await img.boundingBox()
  expect(box && box.width > 0 && box.height > 0).toBe(true)
})
