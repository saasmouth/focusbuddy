/**
 * E2E for the PlexiiDraw forward-compatibility guard.
 *
 * A drawing made by a newer PlexiiDraw (a newer schema, or object kinds this
 * build does not know) must open READ-ONLY with an honest banner, and nothing
 * the user does may write over it -- the stored body and its timestamp are
 * read back from the main process and compared byte for byte. The main
 * process also refuses an older-format body over it from any caller.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { dragOnStage, keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, v1Body, waitForSave } from './_drawHelpers'

let app: LaunchedApp
let window: Page

test.beforeAll(async () => {
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
})

test.afterAll(async () => {
  await app.dispose()
})

// This build reads and writes schema 2, so a drawing from a NEWER PlexiiDraw
// is schema 3, holding an object kind no build knows yet.
function newerDoc(): Record<string, unknown> {
  return {
    ...v1Body([rectObject('r1', 40, 40, 200, 120), { id: 'g1', type: 'hologram', depth: 3, children: [rectObject('r2', 300, 300, 50, 50)] }]),
    schemaVersion: 3,
    minWriterVersion: 3
  }
}

test('FC-1 a newer drawing opens read-only with a banner, and nothing is saved over it', async () => {
  const id = await seedDrawDoc(window, newerDoc(), 'From a newer PlexiiDraw')
  const before = await readStored(window, id)
  await openDocument(window, id)

  const banner = window.locator('[data-testid="draw-readonly-banner"]')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Made in a newer PlexiiDraw — update to edit')
  await expect(window.locator('[data-testid="draw-tool-pen"]')).toBeDisabled()

  // Try to change it every way a person could.
  await window.keyboard.press('Meta+a')
  await window.keyboard.press('ArrowRight')
  await window.keyboard.press('Delete')
  await dragOnStage(window, { x: 60, y: 60 }, { x: 160, y: 160 })
  await window.keyboard.press('Meta+z')
  await waitForSave(window)

  const after = await readStored(window, id)
  expect(after.body).toBe(before.body)
  expect(after.updatedAt).toBe(before.updatedAt)
  // And the newer object is still in the stored body, verbatim.
  expect(after.body).toContain('"type":"hologram"')
})

test('FC-2 an unknown object kind in a v1 drawing is kept, shown read-only, and the store refuses a downgrade', async () => {
  const raw = v1Body([rectObject('r1', 40, 40, 100, 100), { id: 's1', type: 'symbol', symbolId: 'star', x: 10, y: 10 }])
  const id = await seedDrawDoc(window, raw, 'Holds a symbol')
  await openDocument(window, id)
  await expect(window.locator('[data-testid="draw-readonly-banner"]')).toContainText('symbol')

  // Any caller that tries to write an older-format body over it is refused.
  const before = await readStored(window, id)
  await window.evaluate(async (docId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.documents.update(docId, { body: { schemaVersion: 1, width: 10, height: 10, layers: [] } as never })
  }, id)
  const after = await readStored(window, id)
  expect(after.body).toBe(before.body)
  expect(after.body).toContain('"type":"symbol"')
})

test('FC-3 an ordinary drawing is untouched by the guard: no banner, and edits save', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r1', 40, 40, 100, 100)]), 'Ordinary')
  const before = await readStored(window, id)
  await openDocument(window, id)
  await expect(window.locator('[data-testid="draw-readonly-banner"]')).toHaveCount(0)
  await window.keyboard.press('Meta+a')
  await window.keyboard.press('ArrowRight')
  await waitForSave(window)
  const after = await readStored(window, id)
  expect(after.body).not.toBe(before.body)
})
