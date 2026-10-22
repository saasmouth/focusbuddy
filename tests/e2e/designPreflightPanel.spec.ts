/**
 * E2E for PlexiDesign's print check — Tools → "Preflight for print…".
 *
 * The engine (src/shared/designPreflight.ts) has unit tests; what this spec is
 * for is the half those cannot see: that the check is REACHABLE, that it reports
 * the open document rather than a stale copy, and that clicking a finding takes
 * you to the thing it is about. The feature shipped as engine code with no way
 * in for a whole release, so "reachable" is the assertion that matters.
 *
 * Coverage:
 *  1. The menu item opens the panel, and an untouched design reports clear —
 *     an honest empty state, not a blank list.
 *  2. Dragging an element against the page edge produces the trim-safety
 *     warning, measured from the real geometry, and the summary counts it.
 *  3. Clicking the finding selects the element it names.
 *  4. What the check cannot see is stated in the panel, not implied.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea, chooseCloudAiSource, placeDesign } from './_helpers'

async function openDesignStudio(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

/** Tools → Preflight for print… */
async function openPreflight(window: Page): Promise<void> {
  const panel = window.locator('[data-testid="design-preflight-panel"]')
  if (await panel.isVisible().catch(() => false)) return
  await window.locator('[data-testid="design-menubar-tools"]').click()
  // Not an exact match: the item carries the standing verdict as a hint in the
  // same button, so its text is "Preflight for print…" plus that verdict.
  await window
    .locator('[data-testid="design-menubar-tools-list"] button', { hasText: 'Preflight for print' })
    .first()
    .click()
  await expect(panel).toBeVisible({ timeout: 5_000 })
}

test.describe('PlexiDesign preflight', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    // Clears the two fixed local-AI cards, both of which intercept clicks.
    await chooseCloudAiSource(window)
    await openDesignStudio(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('PF-1 the menu opens the check, and a clean page says so plainly', async () => {
    await openPreflight(window)
    await expect(window.locator('[data-testid="design-preflight-summary"]')).toHaveText(/Ready to print/)
    await expect(window.locator('[data-testid="design-preflight-clear"]')).toBeVisible()
  })

  test('PF-2 it names what it does not check, rather than implying a full press check', async () => {
    await openPreflight(window)
    const panel = window.locator('[data-testid="design-preflight-panel"]')
    await expect(panel).toContainText('colour separations')
    await expect(panel).toContainText('font embedding')
  })

  test('PF-3 an element against the trim is reported, measured from the real geometry', async () => {
    await openPreflight(window)
    // Placed in the MIDDLE on purpose: a text frame is 80% of the page wide,
    // so a click near an edge is clamped flush against it — which is itself a
    // trim-safety finding, and would make the assertion below pass for the
    // wrong reason.
    await placeDesign(window, 'text', { fx: 0.5, fy: 0.5 })
    // Adding a text element selects it and opens its editor; Escape leaves the
    // editor so the next drag moves the element instead of placing a caret.
    await window.keyboard.press('Escape')

    // A text element lands in from the edges, so there is nothing to report
    // yet. Asserting this makes the finding below provably the drag's doing
    // rather than something the add happened to trigger.
    await expect(window.locator('[data-testid="preflight-trim-safety"]')).toHaveCount(0)

    const el = window.locator('[data-testid="slide-element"]').last()
    const box = await el.boundingBox()
    const canvas = await window.locator('[data-testid="slide-canvas"]').boundingBox()
    if (!box || !canvas) throw new Error('the canvas was not laid out')

    // Drag it hard into the top-left corner of the page. The exact landing spot
    // does not matter: anything within an eighth of an inch of the edge is the
    // finding, which is the point of a measured check.
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await window.mouse.down()
    await window.mouse.move(canvas.x + 4, canvas.y + 4, { steps: 8 })
    await window.mouse.up()

    await expect(window.locator('[data-testid="preflight-trim-safety"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="design-preflight-summary"]')).toHaveText(/warning/)
    // The clear state is gone: the panel is reporting the live document.
    await expect(window.locator('[data-testid="design-preflight-clear"]')).toHaveCount(0)
  })

  test('PF-4 the Tools menu carries the standing verdict, so it is not a check you must remember', async () => {
    await window.locator('[data-testid="design-menubar-tools"]').click()
    const list = window.locator('[data-testid="design-menubar-tools-list"]')
    // The drag in PF-3 left one warning, and the menu says so without opening
    // the panel.
    await expect(list).toContainText(/1 warning/)
    await window.keyboard.press('Escape')
  })

  test('PF-5 clicking a finding selects the element it is about', async () => {
    // Deselect first, so the selection that appears can only have come from
    // the click on the finding.
    await window.locator('[data-testid="slide-canvas"]').click({ position: { x: 300, y: 500 } })
    await expect(window.locator('[data-testid="design-canvas-inspector"]')).toBeVisible({ timeout: 5_000 })

    await window.locator('[data-testid="preflight-trim-safety"]').click()
    // The text inspector only renders for a selected text element.
    await expect(window.locator('[data-testid="design-font-size"]')).toBeVisible({ timeout: 5_000 })
  })
})
