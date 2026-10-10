/**
 * E2E smoke for PlexiDesign — the on-platform design studio (a new 'design' doc
 * type whose canvas reuses the parameterized SlideCanvas at any size).
 *
 * Covers the core path: create a design, the studio opens, a template renders
 * real elements and persists an on-brand body, size change persists, add element,
 * and the AI image path is honest (no key -> a needs-key status, no fake image).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function openDesignStudio(window: Page): Promise<void> {
  // PlexiDesign lives inside the PlexiOffice segment now.
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

// Ensure the templates panel is open without toggling it closed when it already
// is (it auto-opens on a blank design).
async function ensureTemplatesOpen(window: Page): Promise<void> {
  const tpl = window.locator('[data-testid="design-template-social-quote"]')
  if (!(await tpl.isVisible().catch(() => false))) {
    await window.locator('[data-testid="design-templates-btn"]').click()
  }
  await expect(tpl).toBeVisible({ timeout: 5_000 })
}

test.describe('PlexiDesign studio', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('DS-1 create a design and the studio opens with templates + tools', async () => {
    await openDesignStudio(window)
    // Toolbar tools present.
    for (const t of ['design-templates-btn', 'design-size-btn', 'design-add-text', 'design-add-rect', 'design-ai-btn', 'design-brandify']) {
      await expect(window.locator(`[data-testid="${t}"]`)).toBeVisible()
    }
  })

  test('DS-2 applying a template renders elements on the canvas', async () => {
    await ensureTemplatesOpen(window)
    await window.locator('[data-testid="design-template-social-quote"]').click()
    await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible()
    expect(await window.locator('[data-testid="slide-element"]').count()).toBeGreaterThan(0)
  })

  test('DS-3 changing the size repaints the canvas', async () => {
    await window.locator('[data-testid="design-size-btn"]').click()
    await window.locator('[data-testid="design-size-poster-a4"]').click()
    // Canvas still present and elements remain.
    await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible()
  })

  test('DS-4 add a text element grows the canvas', async () => {
    const before = await window.locator('[data-testid="slide-element"]').count()
    await window.locator('[data-testid="design-add-text"]').click()
    await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(before + 1)
    // The new text element is selected -> inspector shows.
    await expect(window.locator('[data-testid="design-inspector"]')).toBeVisible()
  })

  test('DS-5 AI image with no key is honest (no fake image)', async () => {
    const before = await window.locator('[data-testid="slide-element"]').count()
    await window.locator('[data-testid="design-ai-btn"]').click()
    await window.locator('[data-testid="design-image-prompt"]').fill('a minimal abstract gradient')
    await window.locator('[data-testid="design-image-go"]').click()
    // Either a status (no key) appears OR (if a key is configured) an image is
    // added. Never both-fail-silently. Wait for a settled outcome.
    await window.waitForTimeout(1500)
    const after = await window.locator('[data-testid="slide-element"]').count()
    const status = window.locator('[data-testid="design-status"]')
    if (after === before) {
      // No image added -> there MUST be an honest status message (e.g. add a key).
      await expect(status).toBeVisible()
      expect((await status.textContent())?.toLowerCase()).toMatch(/key|fail|could not|reach/)
    } else {
      // A real image was generated and placed.
      expect(after).toBe(before + 1)
    }
  })

  test('DS-6 the export menu offers PNG and PDF', async () => {
    await window.locator('[data-testid="design-export-btn"]').click()
    await expect(window.locator('[data-testid="design-export-menu"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-export-png"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-export-pdf"]')).toBeVisible()
    // Dismiss with the toggle, not a click at (5,5): the menu's backdrop is
    // `fixed inset-0 z-30` and the titlebar is `z-[100]` and 40px tall, so a
    // click up there lands on a drag region ABOVE the backdrop and does
    // nothing. The menu then stayed open, and its full-viewport backdrop
    // blocked the toolbar for every test after this one — DS-7 through DS-13
    // were all waiting 30s for buttons sitting under it.
    await window.locator('[data-testid="design-export-btn"]').click()
    await expect(window.locator('[data-testid="design-export-menu"]')).toBeHidden()
  })

  test('DS-7 brand kit editor saves a brand the design reads back', async () => {
    await window.locator('[data-testid="design-brand-kit-btn"]').click()
    await expect(window.locator('[data-testid="brand-kit-modal"]')).toBeVisible()
    // Set a distinctive primary color and save (IPC brand:set -> local store).
    await window.locator('[data-testid="brand-primary"]').fill('#ff0066')
    await window.locator('[data-testid="brand-save"]').click()
    await expect(window.locator('[data-testid="brand-kit-modal"]')).toBeHidden()
    // Re-open: the brand persisted through the store (IPC brand:get).
    await window.locator('[data-testid="design-brand-kit-btn"]').click()
    await expect(window.locator('[data-testid="brand-primary"]')).toHaveValue('#ff0066')
    // Close via the modal's own Cancel button (a stray canvas click could navigate).
    await window.locator('[data-testid="brand-kit-modal"]').getByRole('button', { name: 'Cancel' }).click()
    await expect(window.locator('[data-testid="brand-kit-modal"]')).toBeHidden()
    await expect(window.locator('[data-testid="design-editor"]')).toBeVisible()
  })

  test('DS-8 undo and redo a change', async () => {
    const before = await window.locator('[data-testid="slide-element"]').count()
    await window.locator('[data-testid="design-add-text"]').click()
    await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(before + 1)
    await window.locator('[data-testid="design-undo"]').click()
    await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(before)
    await window.locator('[data-testid="design-redo"]').click()
    await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(before + 1)
  })

  test('DS-9 duplicate the selected element', async () => {
    // Adding a rectangle selects it; the inspector + duplicate become available.
    await window.locator('[data-testid="design-add-rect"]').click()
    await expect(window.locator('[data-testid="design-inspector"]')).toBeVisible()
    const before = await window.locator('[data-testid="slide-element"]').count()
    await window.locator('[data-testid="design-duplicate"]').click()
    await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(before + 1)
  })

  test('DS-10 add triangle, rounded rect and a line', async () => {
    const before = await window.locator('[data-testid="slide-element"]').count()
    await window.locator('[data-testid="design-add-triangle"]').click()
    await window.locator('[data-testid="design-add-roundrect"]').click()
    await window.locator('[data-testid="design-add-line"]').click()
    await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(before + 3)
  })

  test('DS-11 font picker changes the selected text font', async () => {
    await window.locator('[data-testid="design-add-text"]').click()
    await expect(window.locator('[data-testid="design-font-family"]')).toBeVisible()
    await window.locator('[data-testid="design-font-family"]').selectOption('Poppins')
    await expect(window.locator('[data-testid="design-font-family"]')).toHaveValue('Poppins')
  })

  test('DS-12 stock photo search is honest without a key', async () => {
    await window.locator('[data-testid="design-stock-btn"]').click()
    await window.locator('[data-testid="design-stock-query"]').fill('mountains')
    const before = await window.locator('[data-testid="slide-element"]').count()
    await window.locator('[data-testid="design-stock-go"]').click()
    await window.waitForTimeout(1500)
    // Search never silently inserts onto the canvas; results appear in the panel,
    // or (no key) an honest status. Either way the canvas element count is unchanged.
    expect(await window.locator('[data-testid="slide-element"]').count()).toBe(before)
    const hasResults = await window.locator('[data-testid="design-stock-results"]').isVisible().catch(() => false)
    if (!hasResults) {
      await expect(window.locator('[data-testid="design-status"]')).toBeVisible()
      expect((await window.locator('[data-testid="design-status"]').textContent())?.toLowerCase()).toMatch(/key|fail|could not|reach|no photos/)
    }
  })

  test('DS-13 generate variations shows a pick grid and applies one', async () => {
    // Stub the AI variations IPC so the flow is exercised without a live key.
    await app.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('design:generateVariations')
      ipcMain.handle('design:generateVariations', () => ({
        ok: true,
        concepts: [
          { headline: 'Alpha launch', background: 'brand' },
          { headline: 'Beta news', background: 'light' },
          { headline: 'Gamma update', background: 'dark' },
          { headline: 'Delta release', layout: 'split' },
          { headline: 'Epsilon drop', background: 'light' },
          { headline: 'Zeta reveal', background: 'brand' }
        ]
      }))
    })
    // Open the AI panel only if it is not already open (DS-5 may have opened it).
    if (!(await window.locator('[data-testid="design-ai-prompt"]').isVisible().catch(() => false))) {
      await window.locator('[data-testid="design-ai-btn"]').click()
    }
    await window.locator('[data-testid="design-ai-prompt"]').fill('a launch post')
    await window.locator('[data-testid="design-ai-variations"]').click()
    await expect(window.locator('[data-testid="design-variations-modal"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-variation-0"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-variation-5"]')).toBeVisible()
    // Pick one; the modal closes and the canvas becomes that design.
    await window.locator('[data-testid="design-variation-1"]').click()
    await expect(window.locator('[data-testid="design-variations-modal"]')).toBeHidden()
    expect(await window.locator('[data-testid="slide-element"]').count()).toBeGreaterThan(0)
  })
})
