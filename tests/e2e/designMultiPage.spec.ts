/**
 * E2E for PlexiDesign multi-page documents: the page rail adds pages, each page
 * holds its own elements, and switching pages retains per-page content.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea } from './_helpers'

async function openDesignStudio(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

function elementCount(window: Page): Promise<number> {
  return window.locator('[data-testid="slide-element"]').count()
}

test('DMP-1 — add pages, per-page content, switching retains each page', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDesignStudio(window)

    // The page rail starts with a single page.
    await expect(window.locator('[data-testid="design-page-rail"]')).toBeVisible({ timeout: 6_000 })
    await expect(window.locator('[data-testid="design-page-0"]')).toBeVisible()

    // Add an element to page 1.
    await window.locator('[data-testid="design-add-rect"]').click()
    await window.waitForTimeout(200)
    const page1Count = await elementCount(window)
    expect(page1Count).toBeGreaterThan(0)

    // Add a second page — it becomes active and starts empty.
    await window.locator('[data-testid="design-page-add"]').click()
    await expect(window.locator('[data-testid="design-page-1"]')).toBeVisible({ timeout: 4_000 })
    await window.waitForTimeout(200)
    expect(await elementCount(window), 'a fresh page is empty').toBe(0)

    // Add an element to page 2.
    await window.locator('[data-testid="design-add-rect"]').click()
    await window.waitForTimeout(200)
    await window.locator('[data-testid="design-add-rect"]').click()
    await window.waitForTimeout(200)
    const page2Count = await elementCount(window)
    expect(page2Count).toBeGreaterThan(0)

    // Back to page 1 — it still shows exactly its own elements.
    await window.locator('[data-testid="design-page-0"]').click()
    await window.waitForTimeout(200)
    expect(await elementCount(window)).toBe(page1Count)

    // Forward to page 2 — its elements were retained.
    await window.locator('[data-testid="design-page-1"]').click()
    await window.waitForTimeout(200)
    expect(await elementCount(window)).toBe(page2Count)
  } finally {
    await dispose()
  }
})
