/**
 * E2E for PlexiDesign swatches and spot inks — Layout → "Swatches & spot inks…".
 *
 * The engine could tint a colour, carry an edit into every fill that used it,
 * and list the spot inks a job needs; nothing in the app called any of it, so
 * no document could have a swatch and the preflight spot-ink report could
 * never fire. These assertions are about the chain being joined: apply a
 * swatch to real artwork, change the swatch, see the artwork change, mark it
 * as a spot ink, and see preflight report the plate.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea, chooseCloudAiSource, placeDesign } from './_helpers'

async function openDesign(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

async function openSwatches(window: Page): Promise<void> {
  const panel = window.locator('[data-testid="design-swatches-panel"]')
  if (await panel.isVisible().catch(() => false)) return
  await window.locator('[data-testid="design-menubar-layout"]').click()
  await window
    .locator('[data-testid="design-menubar-layout-list"] button', { hasText: 'Swatches & spot inks' })
    .first()
    .click()
  await expect(panel).toBeVisible({ timeout: 5_000 })
}

/**
 * Select the rectangle by clicking its centre with the mouse.
 *
 * Not locator.click(): each element sits inside a react-draggable wrapper that
 * owns pointer events, so Playwright's click on the element itself is
 * intercepted by its own drag handle and retries until it times out.
 */
async function selectRect(window: Page): Promise<void> {
  const box = await window.locator('[data-testid="slide-element"]').first().boundingBox()
  if (!box) throw new Error('no element on the page')
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

/** The background colour the first rectangle on the page is actually drawn in. */
async function rectColor(window: Page): Promise<string> {
  return window.evaluate(() => {
    const el = document.querySelector('[data-testid="slide-canvas"] [data-testid="slide-element"] div')
    return el ? getComputedStyle(el as HTMLElement).backgroundColor : ''
  })
}

test.describe('PlexiDesign swatches', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDesign(window)
    // Something to colour.
    await placeDesign(window, 'rect')
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('SW-1 the palette opens with the document colours, brand ones marked', async () => {
    await openSwatches(window)
    await expect(window.locator('[data-testid="design-swatch-list"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-swatch-brand-primary"]')).toContainText('brand')
    await expect(window.locator('[data-testid="design-swatch-ink"]')).toBeVisible()
  })

  test('SW-2 a brand colour cannot be renamed or deleted here', async () => {
    await openSwatches(window)
    await window.locator('[data-testid="design-swatch-brand-primary"]').click()
    await expect(window.locator('[data-testid="design-swatch-name"]')).toBeDisabled()
    await expect(window.locator('[data-testid="design-swatch-delete"]')).toBeDisabled()
  })

  test('SW-3 applying a swatch colours the selection, and editing the swatch re-colours it', async () => {
    await openSwatches(window)
    // Select the rectangle on the page.
    await selectRect(window)
    await window.locator('[data-testid="design-swatch-ink"]').click()
    await window.locator('[data-testid="design-swatch-apply"]').click()

    await expect.poll(async () => rectColor(window), { timeout: 8_000 }).toBe('rgb(28, 25, 23)')
    await expect(window.locator('[data-testid="design-swatch-list"]')).toContainText('used 1×')

    // Change the swatch; the artwork follows, which is the point of a name.
    await window.locator('[data-testid="design-swatch-color"]').fill('#ff0000')
    await expect.poll(async () => rectColor(window), { timeout: 8_000 }).toBe('rgb(255, 0, 0)')
  })

  test('SW-4 a tint mixes toward white rather than toward transparent', async () => {
    await openSwatches(window)
    await selectRect(window)
    await window.locator('[data-testid="design-swatch-tint"]').fill('20')
    await window.locator('[data-testid="design-swatch-apply"]').click()
    // 20% of #ff0000 on white is a pale red, not a dark one and not transparent.
    await expect.poll(async () => rectColor(window), { timeout: 8_000 }).toBe('rgb(255, 204, 204)')
  })

  test('SW-5 a new spot ink is reported to preflight only once it is used', async () => {
    await openSwatches(window)
    await window.locator('[data-testid="design-swatch-new-name"]').fill('Pantone 286')
    await window.locator('[data-testid="design-swatch-new-color"]').fill('#0033a0')
    await window.locator('[data-testid="design-swatch-new-ink"]').fill('Pantone 286 C')
    await window.locator('[data-testid="design-swatch-add"]').click()
    await expect(window.locator('[data-testid="design-swatch-list"]')).toContainText('Pantone 286')
    // Defined but unused: not a plate, and not reported.
    await expect(window.locator('[data-testid="design-spot-summary"]')).toHaveCount(0)

    await selectRect(window)
    await window.locator('[data-testid="design-swatch-tint"]').fill('100')
    await window.locator('[data-testid="design-swatch-apply"]').click()
    await expect(window.locator('[data-testid="design-spot-summary"]')).toContainText('Pantone 286 C')

    // And preflight now has something real to say about the plates.
    await window.locator('[data-testid="design-menubar-tools"]').click()
    await window
      .locator('[data-testid="design-menubar-tools-list"] button', { hasText: 'Preflight for print' })
      .first()
      .click()
    await expect(window.locator('[data-testid="preflight-spot-inks"]')).toContainText('Pantone 286 C')
  })

  test('SW-6 deleting a swatch leaves the artwork exactly as it looked', async () => {
    const before = await rectColor(window)
    await openSwatches(window)
    await window.locator('[data-testid="design-swatch-pantone-286"]').click()
    await window.locator('[data-testid="design-swatch-delete"]').click()
    await expect(window.locator('[data-testid="design-swatch-list"]')).not.toContainText('Pantone 286')
    // The whole promise of deleting a name: the artwork keeps its colour.
    expect(await rectColor(window)).toBe(before)
  })
})
