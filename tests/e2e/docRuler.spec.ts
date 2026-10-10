/**
 * The Word-style margin ruler: horizontal (left/right) and vertical (top/bottom)
 * rulers in page view, with draggable markers that set the page margins live.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

test.describe('doc margin ruler', () => {
  let app: LaunchedApp
  let window: Page
  test.beforeAll(async () => { app = await launchApp(); window = app.window; await waitForReady(window) })
  test.afterAll(async () => { await app.dispose() })

  const padLeft = (): Promise<number> =>
    window.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="doc-page-content"]')!).paddingLeft))

  test('rulers render and dragging the left marker widens the left margin', async () => {
    await switchArea(window, 'office')
    await window.locator('[data-testid="office-app-docs"]').click()
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
    await window.locator('[data-testid="doc-pageview-btn"]').click()
    await expect(window.locator('[data-testid="doc-page-canvas"]')).toBeVisible({ timeout: 6_000 })

    // Both rulers + all four markers present.
    await expect(window.locator('[data-testid="doc-ruler-h"]')).toBeVisible()
    await expect(window.locator('[data-testid="doc-ruler-v"]')).toBeVisible()
    for (const h of ['left', 'right', 'top', 'bottom']) {
      await expect(window.locator(`[data-testid="ruler-handle-${h}"]`)).toBeVisible()
    }

    const before = await padLeft()
    expect(before).toBeGreaterThan(90) // default 1" = 96px

    // Drag the left marker ~96px to the right (about +1 inch).
    const box = await window.locator('[data-testid="ruler-handle-left"]').boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await window.mouse.down()
      await window.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2, { steps: 12 })
      await window.mouse.up()
    }
    await window.waitForTimeout(400)
    const after = await padLeft()
    expect(after, `left margin should grow after dragging (before ${before}, after ${after})`).toBeGreaterThan(before + 60)

    // Toggle the ruler off.
    await window.locator('[data-testid="doc-ruler-btn"]').click()
    await expect(window.locator('[data-testid="doc-ruler-h"]')).toHaveCount(0)
  })
})
