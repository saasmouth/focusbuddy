/**
 * E2E for PlexiDesign footnotes — the marker in the text, the note at the foot
 * of the frame.
 *
 * The engine settled notes against the flow and had unit tests for a whole
 * release while nothing in the app called it, so what this spec is for is the
 * part those cannot see: that a person can put a footnote in a story, that it
 * sets at the foot of the frame rather than as body copy in the middle of the
 * page, and that the marker never reaches the page as the [^1] token.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea, chooseCloudAiSource, placeDesign, selectBarTab } from './_helpers'

async function openPublication(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

/** Two linked frames carrying one story, with the story editor open. */
async function openStory(window: Page): Promise<void> {
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

  // Threading moved to the contextual Text tab (SPEC §6.3); it never

  // auto-switches, so the spec has to ask for it.

  await selectBarTab(window, 'design-toolbar', 'text')

  await expect(window.locator('[data-testid="design-link-frames"]')).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="design-link-frames"]').click()

  const port = window.locator('[data-testid="design-thread-port"]').first()
  const pb = await port.boundingBox()
  if (!pb) throw new Error('no thread port')
  await window.mouse.click(pb.x + 14, pb.y + 24)
  await selectBarTab(window, 'design-toolbar', 'text')
  await window.locator('[data-testid="design-open-story"]').click()
  await expect(window.locator('[data-testid="design-story-editor"]')).toBeVisible({ timeout: 5_000 })
}

/** Every line the canvas actually set, with the footnote ones marked. */
async function setLines(window: Page): Promise<Array<{ text: string; note: boolean }>> {
  return window.evaluate(() => {
    const out: Array<{ text: string; note: boolean }> = []
    document.querySelectorAll('[data-testid="slide-canvas"] [data-flow-line]').forEach((el) => {
      out.push({ text: el.textContent ?? '', note: el.getAttribute('data-flow-line') === 'footnote' })
    })
    return out
  })
}

test.describe('PlexiDesign footnotes', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openPublication(window)
    await openStory(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('FN-1 the story editor can add a footnote, and says how they are written', async () => {
    const editor = window.locator('[data-testid="design-story-editor"]')
    await expect(editor).toContainText('[^1]')

    const story = window.locator('[data-testid="design-story-text"]')
    await story.fill('The press moved to Leipzig that spring.')
    // Caret after "Leipzig", where the marker belongs.
    await story.evaluate((el: HTMLTextAreaElement) => {
      const at = el.value.indexOf('Leipzig') + 'Leipzig'.length
      el.setSelectionRange(at, at)
    })
    await window.locator('[data-testid="design-insert-footnote"]').click()

    await expect(story).toHaveValue(/Leipzig\[\^1\] that spring\./)
    await expect(story).toHaveValue(/\[\^1\]: $/)
    await expect(window.locator('[data-testid="design-footnote-count"]')).toHaveText('1 note')
  })

  test('FN-2 the note sets at the foot of the frame, and the token never reaches the page', async () => {
    const story = window.locator('[data-testid="design-story-text"]')
    await story.fill('The press moved to Leipzig[^1] that spring.\n\n[^1]: Rosenthal, page 212.')

    await expect
      .poll(async () => (await setLines(window)).filter((l) => l.note).length, { timeout: 8_000 })
      .toBeGreaterThan(0)

    const lines = await setLines(window)
    const notes = lines.filter((l) => l.note)
    expect(notes.some((l) => l.text.includes('Rosenthal'))).toBe(true)
    // The marker is on the page as a superscript; the token is not.
    expect(lines.some((l) => l.text.includes('¹'))).toBe(true)
    expect(lines.every((l) => !l.text.includes('[^'))).toBe(true)
    // And the note is not body copy: no body line carries the note's words.
    expect(lines.filter((l) => !l.note).every((l) => !l.text.includes('Rosenthal'))).toBe(true)
  })

  test('FN-3 a note renumbers when another is inserted before it', async () => {
    const story = window.locator('[data-testid="design-story-text"]')
    await story.fill('Alpha[^a] and beta[^b].\n\n[^a]: First written.\n\n[^b]: Second written.')
    await expect
      .poll(async () => (await setLines(window)).filter((l) => l.note).length, { timeout: 8_000 })
      .toBeGreaterThan(1)

    // Reading order decides the numbers, so swapping the markers swaps them.
    await story.fill('Alpha[^b] and beta[^a].\n\n[^a]: First written.\n\n[^b]: Second written.')
    await expect
      .poll(
        async () => {
          const notes = (await setLines(window)).filter((l) => l.note)
          return notes.find((l) => l.text.includes('Second written'))?.text ?? ''
        },
        { timeout: 8_000 }
      )
      .toMatch(/^¹/)
  })
})
