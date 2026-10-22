/**
 * Armed tools in PlexiiDesign (SPEC §3.2, owner decision D4).
 *
 * The behaviour change this covers: clicking Rect used to drop a rectangle
 * immediately; now it ARMS the tool and the next click or drag on the canvas
 * places it. These tests exist because that difference is invisible to a test
 * that only checks the tool looks pressed — it would pass while placing
 * nothing — so every case here asserts against elements on the page.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea, chooseCloudAiSource } from './_helpers'

test.describe.configure({ timeout: 90_000 })

const count = (window: Page): Promise<number> => window.locator('[data-testid="slide-element"]').count()

async function openDesign(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
  await window.keyboard.press('Escape') // close the first-run Start-from menu
}

/**
 * Press at a point inside the canvas, as a FRACTION of its box.
 *
 * Absolute pixels do not work here: the canvas is a scaled page, and at A4 in
 * this window it is about 400px wide — a press at x=400 lands outside it and
 * places nothing, which looks exactly like the feature being broken.
 */
async function pressCanvas(window: Page, fx: number, fy: number, to?: { fx: number; fy: number }): Promise<void> {
  const box = await window.locator('[data-testid="slide-canvas"]').boundingBox()
  if (!box) throw new Error('the canvas was not laid out')
  await window.mouse.move(box.x + box.width * fx, box.y + box.height * fy)
  await window.mouse.down()
  if (to) await window.mouse.move(box.x + box.width * to.fx, box.y + box.height * to.fy, { steps: 6 })
  await window.mouse.up()
}

test('AT-1 — arming a tool places nothing until the canvas is used', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)
    expect(await count(window)).toBe(0)

    await window.locator('[data-testid="design-tool-rect"]').click()
    // Armed, and nothing placed yet. This is the whole behaviour change.
    await expect(window.locator('[data-testid="design-tool-rect"]')).toHaveAttribute('aria-pressed', 'true')
    expect(await count(window)).toBe(0)

    await pressCanvas(window, 0.3, 0.3)
    await expect.poll(() => count(window), { timeout: 6_000 }).toBe(1)
  } finally {
    await dispose()
  }
})

test('AT-2 — a drag sizes the element, a click gives the default', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)

    await window.locator('[data-testid="design-tool-rect"]').click()
    await pressCanvas(window, 0.1, 0.1, { fx: 0.6, fy: 0.4 })
    await expect.poll(() => count(window), { timeout: 6_000 }).toBe(1)
    const dragged = await window.locator('[data-testid="slide-element"]').first().boundingBox()

    // The shapes share a flyout (SPEC §2.2), so only the last-used one is in
    // the rail. Open it the way a person would — Shift+F10 on the button —
    // and pick the ellipse.
    // The corner triangle opens it (SPEC §2.2 also allows press-and-hold and
    // Shift+F10; the triangle is the deterministic one to drive).
    await window.locator('[data-testid="design-rail-flyout-shapes"]').click()
    await expect(window.locator('[data-testid="design-rail-flyout-menu"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="design-tool-ellipse-flyout"]').click()
    await pressCanvas(window, 0.75, 0.7)
    await expect.poll(() => count(window), { timeout: 6_000 }).toBe(2)
    const clicked = await window.locator('[data-testid="slide-element"]').nth(1).boundingBox()

    if (!dragged || !clicked) throw new Error('no boxes')
    // The dragged one is the size that was drawn, not the default.
    expect(Math.abs(dragged.width - clicked.width)).toBeGreaterThan(10)
  } finally {
    await dispose()
  }
})

test('AT-3 — the tool returns to Select after placing, unless it was locked', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)

    await window.locator('[data-testid="design-tool-rect"]').click()
    await pressCanvas(window, 0.3, 0.3)
    await expect.poll(() => count(window), { timeout: 6_000 }).toBe(1)
    // Back to Select, as PowerPoint and Canva do.
    await expect(window.locator('[data-testid="design-tool-select"]')).toHaveAttribute('aria-pressed', 'true')

    // Double-click locks the tool: it stays armed across placements.
    await window.locator('[data-testid="design-tool-rect"]').dblclick()
    await pressCanvas(window, 0.4, 0.45)
    await pressCanvas(window, 0.7, 0.2)
    await expect.poll(() => count(window), { timeout: 6_000 }).toBe(3)
    await expect(window.locator('[data-testid="design-tool-rect"]')).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await dispose()
  }
})

test('AT-4 — keys arm tools, and Escape returns to Select', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)

    await window.keyboard.press('t')
    await expect(window.locator('[data-testid="design-tool-text"]')).toHaveAttribute('aria-pressed', 'true')
    await window.keyboard.press('Escape')
    await expect(window.locator('[data-testid="design-tool-select"]')).toHaveAttribute('aria-pressed', 'true')

    await window.keyboard.press('m')
    await expect(window.locator('[data-testid="design-tool-rect"]')).toHaveAttribute('aria-pressed', 'true')
    await pressCanvas(window, 0.35, 0.35)
    await expect.poll(() => count(window), { timeout: 6_000 }).toBe(1)
  } finally {
    await dispose()
  }
})
