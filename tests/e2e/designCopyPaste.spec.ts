/**
 * Cut, Copy and Paste for canvas elements, and duplicating a whole page or
 * slide — all four reported by the owner against 4.3.40: "I can duplicate
 * content, but ctrl c and v don't work, and I can't duplicate an entire
 * slide."
 *
 * Both editors are covered because both were missing it, and both now go
 * through the same hook (slides/useElementClipboard.ts) over the same payload
 * (src/shared/elementClipboard.ts).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea, chooseCloudAiSource, placeDesign } from './_helpers'

test.describe.configure({ timeout: 90_000 })

const elementCount = (window: Page): Promise<number> => window.locator('[data-testid="slide-element"]').count()

async function openDesign(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

/** Select the first element by clicking its centre (its drag wrapper owns the pointer). */
async function selectFirst(window: Page): Promise<void> {
  const box = await window.locator('[data-testid="slide-element"]').first().boundingBox()
  if (!box) throw new Error('nothing on the canvas')
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/** Open one of the app's own menus and click an item by its label. */
async function menu(window: Page, bar: string, name: string, item: string): Promise<void> {
  await window.locator(`[data-testid="${bar}-${name}"]`).click()
  await window.locator(`[data-testid="${bar}-${name}-list"] button`, { hasText: item }).first().click()
}

test('CP-1 — Design: ⌘C and ⌘V add a copy, offset and on top', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)

    await placeDesign(window, 'rect')
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(1)
    await selectFirst(window)

    await window.keyboard.press('Meta+c')
    await window.keyboard.press('Meta+v')
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(2)

    // The copy is offset, so it is not hidden exactly behind the original.
    const boxes = await window.locator('[data-testid="slide-element"]').evaluateAll((els) =>
      els.map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y) }
      })
    )
    expect(boxes[0]).not.toEqual(boxes[1])

    // Pasting again keeps adding copies rather than replacing the first.
    await window.keyboard.press('Meta+v')
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(3)
  } finally {
    await dispose()
  }
})

test('CP-2 — Design: the Edit menu does the same, and Cut removes the original', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)

    await placeDesign(window, 'rect')
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(1)
    await selectFirst(window)

    await menu(window, 'design-menubar', 'edit', 'Copy')
    await menu(window, 'design-menubar', 'edit', 'Paste')
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(2)

    await selectFirst(window)
    await menu(window, 'design-menubar', 'edit', 'Cut')
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(1)

    // What was cut can be pasted back.
    await menu(window, 'design-menubar', 'edit', 'Paste')
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(2)
  } finally {
    await dispose()
  }
})

test('CP-3 — Design: an element copied on page 1 pastes onto page 2', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)

    await placeDesign(window, 'rect')
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(1)
    await selectFirst(window)
    await menu(window, 'design-menubar', 'edit', 'Copy')

    await window.locator('[data-testid="design-page-add"]').click()
    await expect(window.locator('[data-testid="design-page-1"]')).toBeVisible({ timeout: 6_000 })
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(0)

    await menu(window, 'design-menubar', 'edit', 'Paste')
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(1)

    // Page 1 still has its own.
    await window.locator('[data-testid="design-page-0"]').click()
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(1)
  } finally {
    await dispose()
  }
})

test('CP-4 — Design: a page can be duplicated, with everything on it', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)

    await placeDesign(window, 'rect')
    await placeDesign(window, 'ellipse')
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(2)

    await menu(window, 'design-menubar', 'layout', 'Duplicate this page')
    // The copy becomes the active page and carries both elements.
    await expect(window.locator('[data-testid="design-page-1"]')).toBeVisible({ timeout: 6_000 })
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(2)

    // And the original is untouched.
    await window.locator('[data-testid="design-page-0"]').click()
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(2)
  } finally {
    await dispose()
  }
})

test('CP-5 — Slides: ⌘C/⌘V on a slide, and Duplicate slide', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await switchArea(window, 'office')
    await expect(window.locator('[data-testid="office-app-slides"]')).toBeVisible({ timeout: 8_000 })
    await window.locator('[data-testid="office-app-slides"]').click()
    await expect(window.locator('[data-testid="slides-canvas"]')).toBeVisible({ timeout: 10_000 })

    const before = await elementCount(window)
    expect(before).toBeGreaterThan(0)
    await selectFirst(window)
    await window.keyboard.press('Meta+c')
    await window.keyboard.press('Meta+v')
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(before + 1)

    // Duplicate the whole slide: the rail gains one, and the copy carries the
    // same number of elements as the slide it came from.
    const railBefore = await window.locator('[data-testid^="slides-duplicate-"]').count()
    await menu(window, 'slides-menubar', 'slide', 'Duplicate slide')
    await expect
      .poll(async () => window.locator('[data-testid^="slides-duplicate-"]').count(), { timeout: 8_000 })
      .toBe(railBefore + 1)
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBe(before + 1)
  } finally {
    await dispose()
  }
})
