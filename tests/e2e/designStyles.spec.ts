/**
 * E2E for PlexiDesign's named styles — Layout → "Paragraph styles…".
 *
 * The sheet already drove the page (storyParagraphs resolves every block
 * through it), and a document without one got a generated default. What did
 * not exist was any way to see or change it. So the assertions here are: the
 * panel opens on the styles the document is ALREADY setting by, an edit to a
 * parent style changes the page, and the typesetting switches that had no
 * control anywhere — hyphenation and baseline snapping — are reachable.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea, chooseCloudAiSource, placeDesign, selectBarTab } from './_helpers'

async function openPublication(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

async function openStyles(window: Page): Promise<void> {
  const panel = window.locator('[data-testid="design-styles-panel"]')
  if (await panel.isVisible().catch(() => false)) return
  await window.locator('[data-testid="design-menubar-layout"]').click()
  await window
    .locator('[data-testid="design-menubar-layout-list"] button', { hasText: 'Paragraph styles' })
    .first()
    .click()
  await expect(panel).toBeVisible({ timeout: 5_000 })
}

/** A threaded frame carrying a story, so there is flowed text to re-set. */
async function makeStory(window: Page): Promise<void> {
  await placeDesign(window, 'text')
  await window.keyboard.press('Escape')
  await placeDesign(window, 'text')
  await window.keyboard.press('Escape')
  const canvas = window.locator('[data-testid="slide-canvas"]')
  const cb = await canvas.boundingBox()
  if (!cb) throw new Error('the canvas was not laid out')
  await window.mouse.move(cb.x + 2, cb.y + 2)
  await window.mouse.down()
  await window.mouse.move(cb.x + cb.width - 2, cb.y + cb.height - 2)
  await window.mouse.up()
  await selectBarTab(window, 'design-toolbar', 'text')
  await window.locator('[data-testid="design-link-frames"]').click()
  const port = window.locator('[data-testid="design-thread-port"]').first()
  const pb = await port.boundingBox()
  if (!pb) throw new Error('no thread port')
  await window.mouse.click(pb.x + 14, pb.y + 24)
  await selectBarTab(window, 'design-toolbar', 'text')
  await window.locator('[data-testid="design-open-story"]').click()
  await window
    .locator('[data-testid="design-story-text"]')
    .fill('### A heading\n\nBody copy that is long enough to break over several lines in a column of this width, so a change of size is visible in the number of lines it takes.')
}

/** The font sizes the canvas actually set, body lines only. */
async function bodySizes(window: Page): Promise<number[]> {
  return window.evaluate(() => {
    const out: number[] = []
    document.querySelectorAll('[data-testid="slide-canvas"] [data-flow-line="body"]').forEach((el) => {
      const px = parseFloat(getComputedStyle(el as HTMLElement).fontSize)
      if (Number.isFinite(px)) out.push(Math.round(px * 100) / 100)
    })
    return out
  })
}

test.describe('PlexiDesign named styles', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    // The 30s default (playwright.config.ts) is the TEST budget, and this hook
    // does a cold app launch, the AI-source choice, navigation and content
    // setup inside it. On a machine running several suites at once that is a
    // coin flip: the failure then reads "beforeAll hook timeout" with whatever
    // it happened to be waiting for, which looks like the app being broken.
    // The hook gets its own budget; every TEST still has 30s.
    test.setTimeout(90_000)
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openPublication(window)
    await makeStory(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('ST-1 the panel opens on the styles the document already sets by', async () => {
    await openStyles(window)
    // Not an empty palette: a page-layout tool opens with its styles defined.
    await expect(window.locator('[data-testid="design-style-body"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-style-heading1"]')).toBeVisible()
    // And it says that these are the document's current styles, not new ones.
    await expect(window.locator('[data-testid="design-styles-generated"]')).toBeVisible()
  })

  test('ST-2 editing the Body style re-sets the page', async () => {
    await openStyles(window)
    await window.locator('[data-testid="design-style-body"]').click()
    const before = await bodySizes(window)
    expect(before.length).toBeGreaterThan(0)

    await window.locator('[data-testid="design-style-size"]').fill('7')
    await expect.poll(async () => Math.min(...(await bodySizes(window))), { timeout: 8_000 }).toBeLessThan(Math.min(...before))

    // The sheet is now the document's own, so the panel stops saying these are
    // the generated ones.
    await expect(window.locator('[data-testid="design-styles-generated"]')).toHaveCount(0)
  })

  test('ST-3 a change to a parent carries through the family', async () => {
    await openStyles(window)
    // A fresh style based on Body, which therefore sets nothing of its own.
    // Heading 1 would not do: the default sheet gives it the accent colour
    // explicitly, so it inherits the family and the ink but not the colour —
    // which is the right behaviour and the wrong test.
    await window.locator('[data-testid="design-style-body"]').click()
    await window.locator('[data-testid="design-style-new"]').click()
    const child = window.locator('[data-testid="design-styles-list"] button').last()
    const childName = (await child.locator('span').first().textContent()) ?? ''
    expect(childName).not.toBe('')

    await window.locator('[data-testid="design-style-body"]').click()
    await window.locator('[data-testid="design-style-color"]').fill('#cc0000')

    await window.locator('[data-testid="design-styles-list"] button', { hasText: childName }).first().click()
    await expect(window.locator('[data-testid="design-style-color"]')).toHaveValue('#cc0000')
    await expect(window.locator('[data-testid="design-style-basedon"]')).toHaveValue('body')

    // Tidy up so the later tests see the sheet they expect.
    await window.locator('[data-testid="design-style-delete"]').click()
  })

  test('ST-4 hyphenation is reachable, and is a property of the style', async () => {
    await openStyles(window)
    await window.locator('[data-testid="design-style-body"]').click()
    const box = window.locator('[data-testid="design-style-hyphenate"]')
    await expect(box).not.toBeChecked()
    await box.check()
    await expect(box).toBeChecked()
    // It is stored on the style, so reselecting it shows it on.
    await window.locator('[data-testid="design-style-heading1"]').click()
    await window.locator('[data-testid="design-style-body"]').click()
    await expect(window.locator('[data-testid="design-style-hyphenate"]')).toBeChecked()
  })

  test('ST-5 baseline snapping is reachable, and says when there is no grid to snap to', async () => {
    await openStyles(window)
    await window.locator('[data-testid="design-style-body"]').click()
    const snap = window.locator('[data-testid="design-style-snap"]')
    await expect(snap).toBeVisible()
    // Honest about the dependency rather than silently doing nothing.
    await expect(window.locator('[data-testid="design-styles-panel"]')).toContainText('Set a grid under Layout first')
  })

  test('ST-6 a new style can be made and deleted, and Body cannot be deleted', async () => {
    await openStyles(window)
    await window.locator('[data-testid="design-style-new"]').click()
    await window.locator('[data-testid="design-style-name"]').fill('Pull quote')
    const list = window.locator('[data-testid="design-styles-list"]')
    await expect(list).toContainText('Pull quote')
    // Renaming deliberately does NOT change the id: the block map and every
    // basedOn point at it, so the id a style was created with is stable.

    await window.locator('[data-testid="design-style-delete"]').click()
    await expect(list).not.toContainText('Pull quote')

    await window.locator('[data-testid="design-style-body"]').click()
    await expect(window.locator('[data-testid="design-style-delete"]')).toBeDisabled()
  })

})

test.describe('PlexiDesign baseline grid', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openPublication(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('BG-1 the grid can be turned on, and draws on the page', async () => {
    await selectBarTab(window, 'design-toolbar', 'layout')
    await window.locator('[data-testid="design-layout-btn"]').click()
    await expect(window.locator('[data-testid="design-layout-panel"]')).toBeVisible({ timeout: 5_000 })
    // Nothing drawn until there is a grid.
    await expect(window.locator('[data-testid="design-baseline-line"]')).toHaveCount(0)

    await window.locator('[data-testid="design-baseline-toggle"]').check()
    await expect(window.locator('[data-testid="design-baseline-spacing"]')).toHaveValue('12')
    await expect
      .poll(async () => window.locator('[data-testid="design-baseline-line"]').count(), { timeout: 8_000 })
      .toBeGreaterThan(10)
  })

  test('BG-2 a wider spacing draws fewer lines', async () => {
    const before = await window.locator('[data-testid="design-baseline-line"]').count()
    await window.locator('[data-testid="design-baseline-spacing"]').fill('36')
    await expect
      .poll(async () => window.locator('[data-testid="design-baseline-line"]').count(), { timeout: 8_000 })
      .toBeLessThan(before)
  })

  test('BG-3 it says that text only sits on the grid when a style asks to', async () => {
    // A grid that silently does nothing to the text is the confusing version
    // of this feature.
    await expect(window.locator('[data-testid="design-baseline-note"]')).toContainText('Snap to the baseline grid')
  })

  test('BG-4 turning it off stops drawing it', async () => {
    await window.locator('[data-testid="design-baseline-toggle"]').uncheck()
    await expect(window.locator('[data-testid="design-baseline-line"]')).toHaveCount(0)
  })
})
