/**
 * E2E for PlexiDesign's page-layout layer — the Publisher/InDesign half.
 *
 * Verifies the things that separate a layout program from a poster canvas, in
 * the real app: publications open multi-page with a grid already set up, the
 * margin box and column guides are drawn, ruler guides can be pulled out, a
 * master page's furniture appears beneath every page that uses it, and a story
 * really does thread through linked frames (with an honest overset marker when
 * the last one fills up).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

/** Start a real publication from the PlexiDesign hub, not a bare canvas. */
async function openPublication(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState().goDesign?.()
  })
  await expect(window.locator('[data-testid="designs-size-a4-portrait"]')).toBeVisible({ timeout: 10_000 })
  await window.locator('[data-testid="designs-size-a4-portrait"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

async function openLayoutPanel(window: Page): Promise<void> {
  if (!(await window.locator('[data-testid="design-layout-panel"]').isVisible().catch(() => false))) {
    await window.locator('[data-testid="design-layout-btn"]').click()
  }
  await expect(window.locator('[data-testid="design-layout-panel"]')).toBeVisible()
}

test.describe('PlexiDesign page layout', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await openPublication(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('DL-1 a publication opens multi-page with rulers and a margin box', async () => {
    await expect(window.locator('[data-testid="design-rulers"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-ruler-top"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-ruler-left"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-margin-box"]')).toBeVisible()
    // Four pages, as the hub promises. Matched exactly, because the rail also
    // holds a delete button per page and an add button, all sharing the prefix.
    for (const i of [0, 1, 2, 3]) {
      await expect(window.locator(`[data-testid="design-page-${i}"]`)).toBeVisible()
    }
    await expect(window.locator('[data-testid="design-page-4"]')).toHaveCount(0)
  })

  test('DL-2 setting a column grid draws the columns', async () => {
    await openLayoutPanel(window)
    await window.locator('[data-testid="design-columns-count"]').fill('3')
    await window.locator('[data-testid="design-columns-count"]').blur()
    await expect(window.locator('[data-testid^="design-column-"]')).toHaveCount(3)
  })

  test('DL-3 changing a margin moves the margin box', async () => {
    await openLayoutPanel(window)
    const before = await window.locator('[data-testid="design-margin-box"]').boundingBox()
    await window.locator('[data-testid="design-margin-left"]').fill('160')
    await window.locator('[data-testid="design-margin-left"]').blur()
    await expect
      .poll(async () => (await window.locator('[data-testid="design-margin-box"]').boundingBox())?.x ?? 0)
      .toBeGreaterThan((before?.x ?? 0) + 2)
  })

  test('DL-4 dragging off a ruler adds a guide, clicking it removes it', async () => {
    const ruler = window.locator('[data-testid="design-ruler-top"]')
    const box = await ruler.boundingBox()
    if (!box) throw new Error('the ruler was not laid out')
    await window.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2)
    await window.mouse.down()
    await window.mouse.move(box.x + box.width * 0.5, box.y + 140)
    await window.mouse.up()
    await expect(window.locator('[data-testid="design-guide-v"]')).toHaveCount(1)

    await window.locator('[data-testid="design-guide-v"]').click()
    await expect(window.locator('[data-testid="design-guide-v"]')).toHaveCount(0)
  })

  test('DL-5 toggling the layout aids hides the grid without touching the content', async () => {
    await window.locator('[data-testid="design-aids-toggle"]').click()
    await expect(window.locator('[data-testid="design-margin-box"]')).toHaveCount(0)
    await window.locator('[data-testid="design-aids-toggle"]').click()
    await expect(window.locator('[data-testid="design-margin-box"]')).toBeVisible()
  })

  test('DL-6 a master page’s furniture appears under every page that uses it', async () => {
    await openLayoutPanel(window)
    // The blank publication already ships one master; edit it and add a frame.
    const editBtn = window.locator('[data-testid^="design-edit-master-"]').first()
    await editBtn.click()
    await expect(window.locator('[data-testid="design-master-banner"]')).toBeVisible()

    await window.locator('[data-testid="design-add-text"]').click()
    // Leaving master-edit mode returns to the page, where the frame must now
    // render as inert underlay rather than as page content.
    await window.locator('[data-testid="design-master-banner"] button').click()
    await expect(window.locator('[data-testid="design-master-banner"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="slide-underlay"]')).toBeVisible()

    // The same furniture is there on page 2 — that is the whole point of a master.
    await window.locator('[data-testid="design-page-1"]').click()
    await expect(window.locator('[data-testid="slide-underlay"]')).toBeVisible()
    await window.locator('[data-testid="design-page-0"]').click()
  })

  test('DL-7 detaching a page from its master drops the furniture on that page only', async () => {
    await openLayoutPanel(window)
    await window.locator('[data-testid="design-page-master"]').selectOption('none')
    await expect(window.locator('[data-testid="slide-underlay"]')).toHaveCount(0)
    // Page 2 still has it.
    await window.locator('[data-testid="design-page-1"]').click()
    await expect(window.locator('[data-testid="slide-underlay"]')).toBeVisible()
    await window.locator('[data-testid="design-page-0"]').click()
  })

  test('DL-8 two text frames link into one story that flows through both', async () => {
    // Two frames on the page, then link them.
    await window.locator('[data-testid="design-add-text"]').click()
    await window.locator('[data-testid="design-add-text"]').click()
    await window.keyboard.press('Escape')

    // Select both by marquee over the whole canvas.
    const canvas = window.locator('[data-testid="slide-canvas"]')
    const cb = await canvas.boundingBox()
    if (!cb) throw new Error('the canvas was not laid out')
    await window.mouse.move(cb.x + 2, cb.y + 2)
    await window.mouse.down()
    await window.mouse.move(cb.x + cb.width - 2, cb.y + cb.height - 2)
    await window.mouse.up()

    await expect(window.locator('[data-testid="design-link-frames"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="design-link-frames"]').click()

    // Thread ports mark every frame that belongs to a story.
    await expect(window.locator('[data-testid="design-thread-port"]')).toHaveCount(2)
  })

  test('DL-9 a long story fills the first frame and reports overset honestly', async () => {
    // Select one threaded frame so the story editor is available.
    const port = window.locator('[data-testid="design-thread-port"]').first()
    const pb = await port.boundingBox()
    if (!pb) throw new Error('no thread port to click')
    await window.mouse.click(pb.x + 14, pb.y + 24)

    // Threaded copy is written in the story editor now, not in the inspector —
    // a five-page article cannot be typed inside a two-inch column.
    await window.locator('[data-testid="design-open-story"]').click()
    await expect(window.locator('[data-testid="design-story-editor"]')).toBeVisible({ timeout: 5_000 })
    const story = window.locator('[data-testid="design-story-text"]')
    await expect(story).toBeVisible({ timeout: 5_000 })
    // Far more copy than two small frames can hold, so the outcome cannot turn
    // on where the type scale happens to land.
    await story.fill('word '.repeat(4000).trim())

    // Text that cannot fit is reported, never silently dropped.
    await expect(window.locator('[data-testid="design-overset"]')).toHaveCount(1, { timeout: 8_000 })
    await expect(window.locator('[data-testid="design-story-overset"]')).toBeVisible()
  })

  test('DL-10 overset is fixable in one click — a page is added and the story continues', async () => {
    const before = await window.locator('[data-testid="design-page-rail"] [data-testid^="design-page-delete-"]').count()
    await window.locator('[data-testid="design-story-add-page"]').click()
    await expect
      .poll(async () => window.locator('[data-testid="design-page-rail"] [data-testid^="design-page-delete-"]').count(), { timeout: 8_000 })
      .toBeGreaterThan(before)
  })
})
