/**
 * The regression e2e for the add-page data loss: a new single-page design,
 * something on it, add a page, reopen the document, page 1 still has the work.
 *
 * It goes through the whole stack on purpose — create, edit, add, persist,
 * reopen — because the unit tests exercise the editor's page arithmetic and
 * cannot see whether the wipe reached disk. On 4.3.33 the same arithmetic was
 * saved by an unrelated accident (the old IPC validator refused the wiped body
 * as cyclic data, so it never persisted); on 4.3.40 it persists. Only a test
 * that reopens the document can tell those two apart.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea, chooseCloudAiSource } from './_helpers'

async function openDesignStudio(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

// Each test launches its own app, and the second launch under load eats most
// of the default 30s budget before the test has done anything.
test.describe.configure({ timeout: 90_000 })

const elementCount = (window: Page): Promise<number> => window.locator('[data-testid="slide-element"]').count()

/** The saved body of the open design, as the document store holds it. */
async function savedBody(window: Page): Promise<{ pages: number; firstPageElements: number; anyElements: number }> {
  return window.evaluate(() => {
    const st = (window as unknown as { __fbDocuments?: { getState: () => { active?: { body?: unknown } } } }).__fbDocuments?.getState()
    const raw = st?.active?.body as unknown
    const b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      pages?: Array<{ elements?: unknown[] }>
      elements?: unknown[]
    }
    const pages = b?.pages ?? []
    return {
      pages: pages.length,
      firstPageElements: (pages[0]?.elements ?? []).length,
      anyElements: pages.reduce((n, p) => n + (p.elements ?? []).length, 0) + (b?.elements ?? []).length
    }
  })
}

/**
 * The path that actually loses the work: a TEMPLATE.
 *
 * A design opened from the document store is normalised on the way in
 * (normalizeDesignBody materialises the implied page), which is why adding a
 * page to a blank design is safe. designFromTemplate builds its body inline
 * and applyTemplate commits it straight to the editor with no pages array at
 * all — and the templates panel opens by itself on a new design, so this is
 * the first thing a person does, not an edge case.
 */
test('DAP-TPL \u2014 a template\u2019s artwork survives adding a page', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesignStudio(window)

    const tpl = window.locator('[data-testid="design-template-social-quote"]')
    if (!(await tpl.isVisible().catch(() => false))) {
      await window.locator('[data-testid="design-templates-btn"]').click()
    }
    await expect(tpl).toBeVisible({ timeout: 6_000 })
    await tpl.click()
    await expect.poll(() => elementCount(window), { timeout: 8_000 }).toBeGreaterThan(1)
    const before = await elementCount(window)
    // Let the template's commit settle before touching the rail.
    await window.waitForTimeout(1200)

    await window.locator('[data-testid="design-page-add"]').click()
    await window.waitForTimeout(800)
    await expect(window.locator('[data-testid="design-page-1"]')).toBeVisible({ timeout: 6_000 })

    const saved = await savedBody(window)
    expect(saved.pages, 'two pages now').toBe(2)
    expect(saved.firstPageElements, "page 1 keeps the template's artwork").toBe(before)

    await window.locator('[data-testid="design-page-0"]').click()
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(before)
  } finally {
    await dispose()
  }
})

test('DAP-PAGE — adding a page keeps the first page’s work, through a save and reopen', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesignStudio(window)

    // Something on page 1.
    await window.locator('[data-testid="design-add-rect"]').click()
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBeGreaterThan(0)

    // Add the second page. The new page is empty; page 1 must not be.
    await window.locator('[data-testid="design-page-add"]').click()
    await expect(window.locator('[data-testid="design-page-1"]')).toBeVisible({ timeout: 6_000 })
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBe(0)

    // What was actually persisted, not what the canvas is showing.
    await expect
      .poll(async () => (await savedBody(window)).pages, { timeout: 8_000 })
      .toBe(2)
    const saved = await savedBody(window)
    expect(saved.firstPageElements, 'page 1 keeps its artwork in the saved body').toBeGreaterThan(0)
    expect(saved.anyElements, 'the artwork exists somewhere in the document').toBeGreaterThan(0)

    // Reopen from the page rail and look at page 1.
    await window.locator('[data-testid="design-page-0"]').click()
    await expect.poll(() => elementCount(window), { timeout: 6_000 }).toBeGreaterThan(0)
  } finally {
    await dispose()
  }
})
