/**
 * The Start-from control: one dropdown in the toolbar for templates, page
 * sizes and a custom size.
 *
 * It replaces a grid of template chips that stood permanently on the canvas
 * ("please find a solution to this wasted real estate") and a separate size
 * panel. What these assert is what the owner asked for: the canvas is not
 * paying rent for it, the empty PUBLICATION heading is gone, a template still
 * applies as before, and a custom size reaches the saved document.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea, chooseCloudAiSource, placeDesign } from './_helpers'

test.describe.configure({ timeout: 90_000 })

async function openDesign(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

async function openMenu(window: Page): Promise<void> {
  if (await window.locator('[data-testid="design-start-menu"]').isVisible().catch(() => false)) return
  await window.locator('[data-testid="design-start-btn"]').click()
  await expect(window.locator('[data-testid="design-start-menu"]')).toBeVisible({ timeout: 5_000 })
}

/** The saved page size, from the document store rather than the canvas. */
async function savedSize(window: Page): Promise<{ w: number; h: number }> {
  return window.evaluate(() => {
    const st = (window as unknown as { __fbDocuments?: { getState: () => { active?: { body?: unknown } } } }).__fbDocuments?.getState()
    const raw = st?.active?.body as unknown
    const b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { width?: number; height?: number }
    return { w: b?.width ?? 0, h: b?.height ?? 0 }
  })
}

test('SM-1 — the chip grid is gone and the control opens itself on a new design', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)

    // The old permanent panel and its separate size twin are both gone.
    await expect(window.locator('[data-testid="design-templates-btn"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="design-size-btn"]')).toHaveCount(0)

    // On a brand-new empty design the menu opens by itself: the same first-run
    // help the grid gave by always being there, without the canvas cost.
    await expect(window.locator('[data-testid="design-start-menu"]')).toBeVisible({ timeout: 8_000 })

    // Escape closes it, and the canvas is clear.
    await window.keyboard.press('Escape')
    await expect(window.locator('[data-testid="design-start-menu"]')).toHaveCount(0)
  } finally {
    await dispose()
  }
})

test('SM-2 — every group has entries, and each entry shows the size it produces', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)
    await openMenu(window)

    const menu = window.locator('[data-testid="design-start-menu"]')
    // PUBLICATION used to render as a heading with nothing under it, because
    // there are no publication TEMPLATES. It is offered here by its sizes.
    await expect(menu).toContainText('Publication')
    await expect(window.locator('[data-testid="design-size-a4-portrait"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-size-a4-portrait"]')).toContainText('794 × 1123')

    // A template entry carries the size it will produce.
    await expect(window.locator('[data-testid="design-template-social-quote"]')).toContainText('1080 × 1080')
  } finally {
    await dispose()
  }
})

test('SM-3 — picking a size resizes the page and keeps the artwork', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)
    await window.keyboard.press('Escape')

    await placeDesign(window, 'rect')
    await expect.poll(() => window.locator('[data-testid="slide-element"]').count(), { timeout: 6_000 }).toBe(1)

    await openMenu(window)
    await window.locator('[data-testid="design-size-ig-story"]').click()
    await expect.poll(async () => (await savedSize(window)).h, { timeout: 8_000 }).toBe(1920)
    expect((await savedSize(window)).w).toBe(1080)
    // The rectangle is still there: a size change is not a new document.
    expect(await window.locator('[data-testid="slide-element"]').count()).toBe(1)
  } finally {
    await dispose()
  }
})

test('SM-4 — a custom size in millimetres reaches the saved document', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)
    await openMenu(window)

    await window.locator('[data-testid="design-size-custom"]').click()
    await expect(window.locator('[data-testid="design-custom-size"]')).toBeVisible()

    await window.locator('[data-testid="design-custom-unit"]').selectOption('mm')
    await window.locator('[data-testid="design-custom-w"]').fill('210')
    await window.locator('[data-testid="design-custom-h"]').fill('297')
    await window.locator('[data-testid="design-custom-apply"]').click()

    // 210 × 297 mm at 96 to the inch.
    await expect.poll(async () => (await savedSize(window)).w, { timeout: 8_000 }).toBe(794)
    expect((await savedSize(window)).h).toBe(1123)
    // And the trigger now reads the new size.
    await expect(window.locator('[data-testid="design-start-btn"]')).toContainText('794 × 1123')
  } finally {
    await dispose()
  }
})

test('SM-5 — a custom size that could not be laid out is refused, not silently applied', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)
    await openMenu(window)

    await window.locator('[data-testid="design-size-custom"]').click()
    await window.locator('[data-testid="design-custom-w"]').fill('4')
    await window.locator('[data-testid="design-custom-h"]').fill('400')
    await window.locator('[data-testid="design-custom-apply"]').click()

    await expect(window.locator('[data-testid="design-custom-error"]')).toBeVisible()
    // Nothing applied: the form is still open and the page is unchanged.
    await expect(window.locator('[data-testid="design-custom-size"]')).toBeVisible()
    expect((await savedSize(window)).w).toBeGreaterThan(16)
  } finally {
    await dispose()
  }
})

test('SM-6 — both menus close on an outside click, so neither is left over the canvas', async () => {
  // The owner's screenshot showed the Edit menu's last item ("Delete
  // selection") drawn on top of the template panel. The panel is gone; what
  // is worth asserting is that an open menu does not outlive the next click.
  //
  // Not asserted: clicking the Start-from button WHILE the Edit menu is open.
  // The dropdown overlays the toolbar, so that click lands on a menu item —
  // which is how menus work everywhere, and not a gesture a person makes.
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)
    await window.keyboard.press('Escape')

    // Click well away from the menu bar: a dropdown hangs down over the top of
    // the canvas, so a click up there lands on a menu item rather than outside.
    const box = await window.locator('[data-testid="slide-canvas"]').boundingBox()
    if (!box) throw new Error('the canvas was not laid out')
    const clickAway = async (): Promise<void> => {
      await window.mouse.click(box.x + box.width - 12, box.y + box.height - 12)
    }
    await window.locator('[data-testid="design-menubar-edit"]').click()
    const edit = window.locator('[data-testid="design-menubar-edit-list"]')
    await expect(edit).toBeVisible()
    await expect(edit).toContainText('Delete selection')
    await clickAway()
    await expect(edit).toHaveCount(0)

    await window.locator('[data-testid="design-start-btn"]').click()
    const start = window.locator('[data-testid="design-start-menu"]')
    await expect(start).toBeVisible()
    await clickAway()
    await expect(start).toHaveCount(0)
  } finally {
    await dispose()
  }
})
