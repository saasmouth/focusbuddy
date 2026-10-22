/**
 * E2E spec: slide template gallery and template-based slide insertion.
 *
 * Verifies:
 *   1. Boot smoke — app loads clean, slides editor is reachable, toolbar is present.
 *   2. Gallery opens via slides-add button and slides-templates-btn toolbar button.
 *   3. Known template buttons are visible inside the gallery.
 *   4. Picking "agenda" inserts a new slide: the rail goes from 1 thumbnail to 2 and
 *      the canvas shows slide-element nodes on the inserted slide.
 *   5. Gallery closes on Escape without inserting.
 *   6. Picking "blank" inserts a slide and the canvas remains functional.
 *
 * NOTE: the native pickImage() dialog used by insertImage is not drivable via
 * Playwright; the lockAspect / naturalW / naturalH inspector path is therefore
 * not exercised here. That is noted as "not drivable" per the dispatch brief.
 *
 * NOTE: the "Slide X of Y" counter that existed in the old legacy slides editor
 * was removed when the editor was rewritten to the element-based model. Slide
 * count is verified by counting the rail slide-number badge spans (the small
 * "1", "2" overlays on each thumbnail).
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, gotoView, selectBarTab } from './_helpers'

// ── Shared setup ──────────────────────────────────────────────────────────────

async function openSlidesDoc(window: import('@playwright/test').Page): Promise<void> {
  await gotoView(window, 'goDocuments')
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Slides' }).first().click()
  // Wait for the slides toolbar — proof the editor mounted
  await expect(window.locator('[data-testid="slides-toolbar"]')).toBeVisible({ timeout: 8_000 })
}

/**
 * Count how many slide thumbnails are in the rail. Each slide gets a small
 * number badge that is an absolute-positioned <span> inside its group div.
 * The rail wrapping div has class "w-40"; the badges are the only spans whose
 * text is a bare integer (1, 2, …) adjacent to the slide group divs.
 *
 * Reliable strategy: count the dashed-add button siblings that are slide group
 * divs. The add button has data-testid="slides-add"; we count the sibling
 * elements before it inside the rail.
 */
async function railSlideCount(window: import('@playwright/test').Page): Promise<number> {
  // Count divs with class "group relative" inside the rail (one per slide).
  // The rail is the nearest ancestor of data-testid="slides-add".
  return window.locator('[data-testid="slides-add"]').locator('..').locator('.group').count()
}

// ── Test 1: boot smoke + slides toolbar ──────────────────────────────────────

test('boot smoke — app loads and slides toolbar is visible without uncaught errors', async () => {
  const { window, dispose } = await launchApp()
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  try {
    await waitForReady(window)
    await openSlidesDoc(window)

    // Insert tab with the Templates button
    await selectBarTab(window, 'slides-toolbar', 'insert')
    await expect(window.locator('[data-testid="slides-templates-btn"]')).toBeVisible()

    // slides-add dashed button in the rail
    await expect(window.locator('[data-testid="slides-add"]')).toBeVisible()

    // Canvas renders the first slide
    await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible()

    // One slide in the rail
    const count = await railSlideCount(window)
    expect(count, 'A new slides doc should start with exactly 1 slide in the rail').toBe(1)

    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('net::ERR_') &&
        !e.includes('Failed to load resource') &&
        !e.includes('WebSocket')
    )
    expect(realErrors, `Unexpected console errors:\n${realErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await dispose()
  }
})

// ── Test 2: gallery opens via slides-add and is populated ────────────────────

test('slides-add button opens the template gallery with expected template buttons', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openSlidesDoc(window)

    // Open gallery via the dashed "+" in the rail
    await window.locator('[data-testid="slides-add"]').click()

    // Gallery modal appears
    const gallery = window.locator('[data-testid="slide-template-gallery"]')
    await expect(gallery).toBeVisible({ timeout: 4_000 })

    // Spot-check several template buttons
    for (const id of ['cover', 'agenda', 'bullets', 'comparison', 'blank']) {
      await expect(
        window.locator(`[data-testid="slide-template-${id}"]`),
        `slide-template-${id} should be visible in the gallery`
      ).toBeVisible()
    }
  } finally {
    await dispose()
  }
})

// ── Test 3: gallery also opens via toolbar Templates button ───────────────────

test('slides-templates-btn opens the gallery', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openSlidesDoc(window)

    await selectBarTab(window, 'slides-toolbar', 'insert')
    await window.locator('[data-testid="slides-templates-btn"]').click()
    await expect(window.locator('[data-testid="slide-template-gallery"]')).toBeVisible({ timeout: 4_000 })
  } finally {
    await dispose()
  }
})

// ── Test 4: gallery closes on Escape without inserting ───────────────────────

test('gallery closes on Escape and rail slide count stays at 1', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openSlidesDoc(window)

    // Confirm one slide before opening gallery
    expect(await railSlideCount(window)).toBe(1)

    // Open gallery
    await window.locator('[data-testid="slides-add"]').click()
    await expect(window.locator('[data-testid="slide-template-gallery"]')).toBeVisible({ timeout: 4_000 })

    // Close with Escape
    await window.keyboard.press('Escape')
    await expect(window.locator('[data-testid="slide-template-gallery"]')).not.toBeVisible({ timeout: 3_000 })

    // Slide count unchanged
    expect(await railSlideCount(window)).toBe(1)
  } finally {
    await dispose()
  }
})

// ── Test 5: picking "agenda" inserts a slide ──────────────────────────────────

test('picking agenda template inserts a new slide and canvas shows slide elements', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openSlidesDoc(window)

    // Confirm starting at 1 slide
    expect(await railSlideCount(window)).toBe(1)

    // Open gallery and pick agenda
    await window.locator('[data-testid="slides-add"]').click()
    await expect(window.locator('[data-testid="slide-template-gallery"]')).toBeVisible({ timeout: 4_000 })
    await window.locator('[data-testid="slide-template-agenda"]').click()

    // Gallery closes
    await expect(window.locator('[data-testid="slide-template-gallery"]')).not.toBeVisible({ timeout: 3_000 })

    // Rail now has 2 slides
    const countAfter = await railSlideCount(window)
    expect(countAfter, 'Rail should have 2 slides after inserting agenda').toBe(2)

    // The canvas (showing the newly-selected agenda slide) has slide elements.
    // SlideCanvas renders each element as data-testid="slide-element".
    const canvas = window.locator('[data-testid="slide-canvas"]')
    await expect(canvas).toBeVisible({ timeout: 3_000 })
    const elementNodes = canvas.locator('[data-testid="slide-element"]')
    await expect(elementNodes.first()).toBeVisible({ timeout: 3_000 })

    // Agenda builds at least 2 elements (title + numbered body)
    const elCount = await elementNodes.count()
    expect(elCount, 'Agenda template should produce multiple elements on canvas').toBeGreaterThanOrEqual(2)
  } finally {
    await dispose()
  }
})

// ── Test 6: picking "blank" inserts an empty slide ───────────────────────────

test('picking blank template inserts a slide and canvas remains functional', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openSlidesDoc(window)

    await window.locator('[data-testid="slides-add"]').click()
    await expect(window.locator('[data-testid="slide-template-gallery"]')).toBeVisible({ timeout: 4_000 })
    await window.locator('[data-testid="slide-template-blank"]').click()

    // Gallery closes
    await expect(window.locator('[data-testid="slide-template-gallery"]')).not.toBeVisible({ timeout: 3_000 })

    // Rail goes to 2 slides
    expect(await railSlideCount(window)).toBe(2)

    // Canvas still renders without crashing (blank template produces 0 elements — canvas is empty but present)
    await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible({ timeout: 3_000 })
  } finally {
    await dispose()
  }
})
