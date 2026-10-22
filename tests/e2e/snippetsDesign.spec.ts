/**
 * PlexiiDesign as a saved-snippet surface, end to end in the real app.
 *
 * SG-1 Two text frames linked into one story with its own words, and a
 *      rectangle. Select all three; Edit › Save selection as snippet…; clear
 *      the selection; Insert › Insert snippet… › Duplicate. The page then holds
 *      every element twice with distinct ids, the copied frames read a NEW
 *      story (fresh id, same words, threaded in the same order), everything
 *      lands inside the page, the copy is the selection, one undo takes the
 *      whole insertion back, and the result is what the saved document holds.
 *      The library offers Duplicate alone, because a design declares
 *      supports: ['duplicate'].
 *
 * Traps this spec steps around (docs/saved-snippets.md, "Two traps"):
 *  - Insertion lands like a paste, so the selection is cleared before
 *    inserting and the assertions count the copy against untouched originals.
 *  - The first-run corner cards swallow bottom-band clicks while Playwright
 *    reports the target actionable, so both are dismissed up front.
 *  - Pinned ShellPanels float over the canvas's top-left corner, so every
 *    marquee and deselect click starts at the page's top-right (designLayout
 *    DL-8 found that one).
 *  - Menu items are matched from the start of their accessible name: an item
 *    with a hint renders the hint inside the same label.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea, chooseCloudAiSource, suppressFeatureSpotlights, placeDesign, selectBarTab } from './_helpers'

type El = Record<string, unknown> & { id: string; type: string; x: number; y: number; w: number; h: number; z: number; storyId?: string; storyOrder?: number }
type Stored = { width: number; height: number; elements: El[]; pages: Array<{ elements: El[] }>; activePage: number; stories: Record<string, { blocks: Array<{ text?: string }> }> }

const PROOF = 'Snippet proof: harbour lights at dusk.'

async function openDesign(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

async function menu(window: Page, id: string, item: string): Promise<void> {
  await window.locator(`[data-testid="design-menubar-${id}"]`).click()
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await window
    .locator(`[data-testid="design-menubar-${id}-list"]`)
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click()
}

/** Rubber-band the whole page, starting on empty stage at its top-right corner. */
async function selectAll(window: Page): Promise<void> {
  const cb = (await window.locator('[data-testid="slide-canvas"]').boundingBox())!
  await window.mouse.move(cb.x + cb.width - 3, cb.y + 3)
  await window.mouse.down()
  await window.mouse.move(cb.x + 3, cb.y + cb.height - 3, { steps: 10 })
  await window.mouse.up()
}

/** A click on empty stage, which is how a design drops its selection. */
async function clearSelection(window: Page): Promise<void> {
  const cb = (await window.locator('[data-testid="slide-canvas"]').boundingBox())!
  await window.mouse.click(cb.x + cb.width - 3, cb.y + 3)
}

async function readDesign(window: Page): Promise<Stored> {
  // Autosave is debounced; give it time to land before reading the stored body.
  await window.waitForTimeout(1_500)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const design = docs.find((d) => d.docType === 'design')
    const doc = design ? await api.documents.get(design.id) : null
    return (doc?.body ?? {}) as Stored
  })
}

const storyWords = (s: Stored['stories'][string] | undefined): string => (s?.blocks ?? []).map((b) => b.text ?? '').join('\n')

test('SG-1: save a shape and threaded text as a design snippet, insert a duplicate with a new story, and it persists', async () => {
  test.setTimeout(120_000)
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await suppressFeatureSpotlights(window)
    await openDesign(window)
    const onPage = window.locator('[data-testid="slide-element"]')
    await expect(onPage).toHaveCount(0)

    // Two frames, apart, linked into one story.
    await placeDesign(window, 'text', { fx: 0.3, fy: 0.15 })
    await placeDesign(window, 'text', { fx: 0.3, fy: 0.4 })
    await window.keyboard.press('Escape')
    await expect(onPage).toHaveCount(2)
    await selectAll(window)
    await selectBarTab(window, 'design-toolbar', 'text')
    await expect(window.locator('[data-testid="design-link-frames"]')).toBeEnabled({ timeout: 5_000 })
    await window.locator('[data-testid="design-link-frames"]').click()

    // The story's own words, typed in the story editor.
    await window.locator('[data-testid="design-open-story"]').click()
    await expect(window.locator('[data-testid="design-story-editor"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="design-story-text"]').fill(PROOF)
    await expect(window.locator('[data-testid="slide-canvas"]')).toContainText('harbour lights', { timeout: 5_000 })

    // And a rectangle below them.
    await placeDesign(window, 'rect', { fx: 0.5, fy: 0.75 })
    await window.keyboard.press('Escape')
    await expect(onPage).toHaveCount(3)

    const before = await readDesign(window)
    expect(before.elements).toHaveLength(3)
    const originals = before.elements
    const originalStoryIds = Object.keys(before.stories ?? {})
    expect(originalStoryIds, 'linking made one story').toHaveLength(1)
    expect(storyWords(before.stories[originalStoryIds[0]!])).toContain('harbour lights')

    // Select all three; Edit › Save selection as snippet…
    await selectAll(window)
    await selectBarTab(window, 'design-toolbar', 'arrange')
    await expect(window.locator('[data-testid="design-distribute-h"]')).toBeEnabled({ timeout: 3_000 }) // three selected
    await menu(window, 'edit', 'Save selection as snippet…')
    const dialog = window.locator('[data-testid="save-snippet-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="save-snippet-empty"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="save-snippet-preview"]')).toHaveText('3 element(s)')
    await window.locator('[data-testid="save-snippet-name"]').fill('Harbour block')
    await window.locator('[data-testid="save-snippet-confirm"]').click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    // Stored as a design snippet: relative positions, and the story it reads.
    const saved = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.snippets.list({ kinds: ['design'] })
      return list.find((s) => s.name === 'Harbour block') ?? null
    })
    expect(saved, 'the snippet was saved').toBeTruthy()
    expect(saved!.kind).toBe('design')
    const savedBody = saved!.body as { elements: El[]; stories?: Record<string, { blocks: Array<{ text?: string }> }> }
    expect(savedBody.elements.map((e) => e.type).sort()).toEqual(['shape', 'text', 'text'])
    expect(Math.min(...savedBody.elements.map((e) => e.x))).toBe(0)
    expect(Math.min(...savedBody.elements.map((e) => e.y))).toBe(0)
    expect(Object.values(savedBody.stories ?? {}).map(storyWords).join(' ')).toContain('harbour lights')

    // Clear the selection, so the insertion is counted against untouched originals.
    await clearSelection(window)
    await expect(window.locator('[data-testid="design-order-back"]')).toBeDisabled({ timeout: 3_000 })

    // Insert › Insert snippet… opens the library scoped to design snippets.
    await menu(window, 'insert', 'Insert snippet…')
    await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
    const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Harbour block' })
    await expect(row).toBeVisible()
    await expect(row.locator('[data-testid="snippet-insert-live"]')).toHaveCount(0)
    await row.locator('[data-testid="snippet-insert-duplicate"]').click()
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })

    // Doubled on the page, and the copy is the selection.
    await expect(onPage).toHaveCount(6)
    await expect(window.locator('[data-testid="design-distribute-h"]')).toBeEnabled()

    // Persisted: six distinct elements, a second story, all inside the page.
    const after = await readDesign(window)
    expect(after.elements).toHaveLength(6)
    expect(new Set(after.elements.map((e) => e.id)).size).toBe(6)
    expect(after.pages[after.activePage]!.elements.map((e) => e.id)).toEqual(after.elements.map((e) => e.id))
    const origIds = new Set(originals.map((e) => e.id))
    const copies = after.elements.filter((e) => !origIds.has(e.id))
    expect(copies).toHaveLength(3)
    expect(copies.map((e) => e.type).sort()).toEqual(['shape', 'text', 'text'])
    const storyIds = Object.keys(after.stories)
    expect(storyIds).toHaveLength(2)
    const newStory = storyIds.find((id) => !originalStoryIds.includes(id))!
    expect(newStory, 'a NEW story').toBeTruthy()
    expect(storyWords(after.stories[newStory])).toBe(storyWords(after.stories[originalStoryIds[0]!]))
    const copiedFrames = copies.filter((e) => e.type === 'text')
    expect(copiedFrames.map((f) => f.storyId)).toEqual([newStory, newStory])
    expect(copiedFrames.map((f) => f.storyOrder).sort()).toEqual([1, 2])
    // The originals still read their own story.
    expect(originals.filter((e) => e.type === 'text').map((e) => after.elements.find((x) => x.id === e.id)!.storyId)).toEqual([
      originalStoryIds[0],
      originalStoryIds[0]
    ])
    for (const c of copies) {
      expect(c.x, `${c.type} left edge`).toBeGreaterThanOrEqual(0)
      expect(c.y, `${c.type} top edge`).toBeGreaterThanOrEqual(0)
      expect(c.x + c.w, `${c.type} right edge`).toBeLessThanOrEqual(after.width)
      expect(c.y + c.h, `${c.type} bottom edge`).toBeLessThanOrEqual(after.height)
    }
    expect(Math.min(...copies.map((e) => e.z))).toBeGreaterThan(Math.max(...originals.map((e) => e.z)))
    // The copied words are on the page twice: the new story flowed into the new frames.
    await expect
      .poll(async () => (await window.locator('[data-testid="slide-canvas"]').innerText()).split('harbour lights').length - 1, { timeout: 5_000 })
      .toBe(2)

    // One undo step takes the whole insertion back; redo restores it.
    await window.locator('[data-testid="design-undo"]').click()
    await expect(onPage).toHaveCount(3)
    const undone = await readDesign(window)
    expect(undone.elements.map((e) => e.id).sort()).toEqual(originals.map((e) => e.id).sort())
    await window.locator('[data-testid="design-redo"]').click()
    await expect(onPage).toHaveCount(6)

    // The use was counted, because the design really took it.
    const used = await window.evaluate(async (id: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.snippets.list({ kinds: ['design'] })
      return list.find((s) => s.id === id)?.usageCount ?? -1
    }, saved!.id)
    expect(used).toBe(1)
  } finally {
    await dispose()
  }
})
