/**
 * The user's own document settings survive a save and a reopen.
 *
 * normalizeDesignBody runs on EVERY read of a design — parseBody in
 * src/main/db/documents.ts — and it did not carry `swatches`,
 * `paragraphStyles` or `baselineGrid`. Those three were added with their
 * features and nobody thought about the normaliser, so a palette someone
 * named, a style sheet they edited and a grid they set were deleted the next
 * time the document was opened, and the following save wrote the loss to disk.
 * Fills kept their cached colour, so the artwork looked right until something
 * recoloured and every swatchId turned out to be dangling.
 *
 * Found by 2e while reading the model for the Design snippet target; this is
 * the end-to-end half of the proof (designNormalizeKeeps.test.ts is the unit
 * half). It drives the real controls, then reads the document back through the
 * real IPC, which is the path that was losing them.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea, chooseCloudAiSource, selectBarTab } from './_helpers'

test.describe.configure({ timeout: 120_000 })

interface SavedDesign {
  swatches?: Array<{ id: string; name: string; color: string; spot?: { inkName: string } }>
  paragraphStyles?: { paragraph: Array<{ id: string; name: string; props?: { fontSize?: number } }> }
  baselineGrid?: { spacing: number }
}

/** The design document as the app would reopen it: through the DB and parseBody. */
async function reread(window: Page): Promise<SavedDesign> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = (await api.documents.list()) as Array<{ id: string; docType: string; updatedAt?: number }>
    const design = docs.filter((d) => d.docType === 'design').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (!design) throw new Error('no design document was saved')
    const doc = (await api.documents.get(design.id)) as { body: unknown }
    return doc.body as SavedDesign
  })
}

test('DS-1 a named swatch, an edited style and a baseline grid survive a reopen', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await switchArea(window, 'office')
    await window.locator('[data-testid="office-app-design"]').click()
    await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 15_000 })

    // 1. A spot ink the user named.
    await window.locator('[data-testid="design-rail-swatches"]').click()
    await expect(window.locator('[data-testid="design-swatches-panel"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="design-swatch-new-name"]').fill('Pantone 286')
    await window.locator('[data-testid="design-swatch-new-color"]').fill('#0033a0')
    await window.locator('[data-testid="design-swatch-new-ink"]').fill('Pantone 286 C')
    await window.locator('[data-testid="design-swatch-add"]').click()

    // 2. An edited body style.
    await window.locator('[data-testid="design-rail-styles"]').click()
    await expect(window.locator('[data-testid="design-styles-panel"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="design-style-body"]').click()
    await window.locator('[data-testid="design-style-size"]').fill('9')
    await window.locator('[data-testid="design-style-size"]').blur()

    // 3. A baseline grid.
    await selectBarTab(window, 'design-toolbar', 'layout')
    await window.locator('[data-testid="design-rail-layout"]').click()
    await expect(window.locator('[data-testid="design-layout-panel"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="design-baseline-toggle"]').check()
    await expect
      .poll(async () => window.locator('[data-testid="design-baseline-line"]').count(), { timeout: 8_000 })
      .toBeGreaterThan(10)

    // Read the document back the way reopening it does.
    const saved = await expect
      .poll(async () => (await reread(window)).swatches?.length ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0)
      .then(() => reread(window))

    const spot = saved.swatches?.find((s) => s.name === 'Pantone 286')
    expect(spot, 'the named swatch survived').toBeDefined()
    expect(spot?.spot?.inkName, 'and it is still a spot ink').toBe('Pantone 286 C')
    expect(saved.paragraphStyles?.paragraph.find((s) => s.id === 'body')?.props?.fontSize, 'the edited style survived').toBe(9)
    expect(saved.baselineGrid?.spacing, 'the grid survived').toBeGreaterThan(0)

    // And the editor shows them again after a reload, which re-reads the
    // document and normalises it a second time.
    await window.reload()
    await waitForReady(window)
    await chooseCloudAiSource(window)
    const after = await reread(window)
    expect(after.swatches?.some((s) => s.name === 'Pantone 286'), 'still there after a reload').toBe(true)
    expect(after.paragraphStyles?.paragraph.find((s) => s.id === 'body')?.props?.fontSize).toBe(9)
    expect(after.baselineGrid?.spacing).toBeGreaterThan(0)
  } finally {
    await dispose()
  }
})
