/**
 * A DESIGN snippet opened for editing from where it is used, end to end.
 *
 * "Open original" on a live snippet opens the app that owns its kind as a real
 * editor (SnippetEditSessionView), and Save writes the snippet MASTER. Until
 * 4.3.51 the registry had no design entry, so a design snippet opened on
 * "A design cannot be opened for editing yet."
 *
 * DS-1 a design snippet placed live in PlexiiWrite opens in PlexiiDesign from
 *      its "Open original" button: the editor, with the snippet's element on
 *      the page, and no refusal.
 * DS-2 an edit in that session (select all, duplicate) reaches the master only
 *      on Save, and no document is created along the way. (Deleting everything
 *      is refused by the host: "A snippet cannot be emptied.")
 *
 * The master is seeded through window.api.snippets (the store the save dialog
 * writes), in the shape Design's capture produces.
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

type Api = {
  snippets: {
    create: (d: unknown) => Promise<{ ok: boolean; snippet?: { id: string }; error?: string }>
    get: (id: string) => Promise<{ body: { elements: unknown[] } } | null>
  }
  documents: { list: () => Promise<unknown[]> }
}

async function seedDesign(name: string): Promise<string> {
  return window.evaluate(async (name) => {
    const api = (window as unknown as { api: Api }).api
    const res = await api.snippets.create({
      kind: 'design',
      name,
      scope: 'personal',
      body: {
        kind: 'design',
        elements: [{ id: 'badge', type: 'shape', shape: 'rect', x: 0, y: 0, w: 160, h: 90, z: 0, fill: { type: 'solid', color: '#2563eb', swatchId: 'sw-brand' } }],
        swatches: [{ id: 'sw-brand', name: 'Brand blue', color: '#2563eb' }]
      }
    })
    if (!res.ok || !res.snippet) throw new Error(res.error ?? 'not saved')
    return res.snippet.id
  }, name)
}

const masterElements = (id: string): Promise<number> =>
  window.evaluate(async (id) => (await (window as unknown as { api: Api }).api.snippets.get(id))?.body.elements.length ?? -1, id)

const documentCount = (): Promise<number> =>
  window.evaluate(async () => (await (window as unknown as { api: Api }).api.documents.list()).length)

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
  await surface.type('Above the snippet.')
  await window.keyboard.press('Enter')
}

async function insertLive(name: string): Promise<void> {
  await window.locator('[data-testid="doc-menu-insert"]').click()
  await window.locator('[data-testid="doc-menu-insert-list"]').getByText('Insert snippet…').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
  const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 5_000 })
  await row.locator('[data-testid="snippet-insert-live"]').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })
}

/** Hover the live embed so its chrome shows, then press "Open original". */
async function openOriginal(): Promise<void> {
  const embed = window.locator('[data-testid="snippet-embed"]').first()
  await expect(embed).toBeVisible({ timeout: 8_000 })
  await embed.hover()
  const open = window.locator('[data-testid="snippet-embed-open-original"]').first()
  await expect(open).toBeVisible({ timeout: 5_000 })
  await open.click()
  await expect(window.locator('[data-testid="snippet-session-host"]')).toBeVisible({ timeout: 8_000 })
}

async function designMenu(id: string, item: string): Promise<void> {
  const session = window.locator('[data-testid="snippet-session-host"]')
  await session.locator(`[data-testid="design-menubar-${id}"]`).click()
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await session.locator(`[data-testid="design-menubar-${id}-list"]`).getByRole('button', { name: new RegExp(`^${escaped}`) }).click()
}

test('DS-1 Open original on a live design snippet opens PlexiiDesign, not "cannot be opened for editing yet"', async () => {
  test.setTimeout(90_000)
  await seedDesign('Brand badge')
  await startBlankDoc()
  await insertLive('Brand badge')
  await openOriginal()
  const session = window.locator('[data-testid="snippet-session-host"]')
  // Two assertions, because either alone can pass for the wrong reason.
  await expect(session.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 15_000 })
  await expect(session.locator('[data-testid="snippet-session-unsupported"]')).toHaveCount(0)
  // The snippet's own element is on the page being edited.
  await expect(session.locator('[data-element-id="badge"]')).toHaveCount(1, { timeout: 8_000 })
  // Nothing has changed yet, so there is nothing to save.
  await expect(session.locator('[data-testid="snippet-session-save"]')).toBeDisabled()
  await session.locator('[data-testid="snippet-session-close"]').click()
  await expect(session).toBeHidden({ timeout: 5_000 })
})

test('DS-2 an edit in the session writes the snippet master on Save, and creates no document', async () => {
  test.setTimeout(90_000)
  const id = await seedDesign('Badge to double')
  await startBlankDoc()
  await insertLive('Badge to double')
  const docsBefore = await documentCount()
  await openOriginal()
  const session = window.locator('[data-testid="snippet-session-host"]')
  await expect(session.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 15_000 })
  await expect(session.locator('[data-element-id="badge"]')).toHaveCount(1, { timeout: 8_000 })

  await designMenu('edit', 'Select all')
  await designMenu('edit', 'Duplicate')
  await expect(session.locator('[data-element-id]')).toHaveCount(2, { timeout: 5_000 })
  // Editing does not write: the master still has its one element until Save.
  expect(await masterElements(id)).toBe(1)

  const save = session.locator('[data-testid="snippet-session-save"]')
  await expect(save).toBeEnabled({ timeout: 5_000 })
  await save.click()
  await expect.poll(() => masterElements(id), { timeout: 8_000 }).toBe(2)
  expect(await documentCount(), 'the session created no document').toBe(docsBefore)
})
