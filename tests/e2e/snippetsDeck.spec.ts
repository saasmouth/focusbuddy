/**
 * PlexiiDeck as a saved-snippet surface, end to end in the real app.
 *
 * SD-1 select a text box, a table and a chart; Edit › Save selection as
 *      snippet…; clear the selection; Insert › Insert snippet… › Duplicate.
 *      The slide then holds every element twice, with distinct ids and the
 *      same content and geometry, the copy selected, one undo taking it all
 *      back, and the result persisted in the saved deck. The library offers
 *      Duplicate alone, because a deck declares supports: ['duplicate'].
 *
 * Traps this spec steps around (docs/saved-snippets.md, "Two traps"):
 *  - Insertion lands like a paste. The selection is cleared before inserting
 *    so the assertions count the copy against untouched originals.
 *  - The first-run corner cards swallow bottom-band clicks while Playwright
 *    reports the target actionable, so both are dismissed up front.
 *  - Insert menu items are clicked inside the menu's own list: bare text
 *    locators hit the side menu's tiles that share the names.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, gotoView, chooseCloudAiSource, suppressFeatureSpotlights, selectBarTab } from './_helpers'

type El = Record<string, unknown> & { id: string; type: string; x: number; y: number; w: number; h: number; z: number }

async function openDocumentsHub(window: Page): Promise<void> {
  await gotoView(window, 'goDocuments')
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

async function startBlankSlides(window: Page): Promise<void> {
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Slides' }).first().click()
  await expect(window.locator('[data-testid="slides-toolbar"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible({ timeout: 8_000 })
}

/**
 * Menu bar › <menu> › <item>, clicked inside that menu's own list. Matched by
 * the item's accessible name from its start: an item with a hint renders the
 * hint inside the same label, so an exact text match would never find it.
 */
async function menu(window: Page, id: string, item: string): Promise<void> {
  await window.locator(`[data-testid="slides-menubar-${id}"]`).click()
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await window
    .locator(`[data-testid="slides-menubar-${id}-list"]`)
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click()
}

async function readElements(window: Page): Promise<El[]> {
  // Autosave is debounced; give it time to land before reading the stored body.
  await window.waitForTimeout(1_500)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const deck = docs.find((d) => d.docType === 'slides')
    const doc = deck ? await api.documents.get(deck.id) : null
    const body = (doc?.body ?? {}) as { slides?: Array<{ elements?: unknown[] }> }
    return (body.slides?.[0]?.elements ?? []) as El[]
  })
}

/** What an element IS, without where it is or what it is called. */
function content(e: El): string {
  const { id: _id, x: _x, y: _y, z: _z, x2: _x2, y2: _y2, groupId: _g, ...rest } = e
  return JSON.stringify(rest, Object.keys(rest).sort())
}

test('SD-1: save selected slide elements as a snippet, insert a duplicate, and it persists', async () => {
  // A launch, a dozen menu round trips and two autosave waits: more than the
  // 30 s default on a loaded machine, while every step keeps its own timeout.
  test.setTimeout(90_000)
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await suppressFeatureSpotlights(window)
    await openDocumentsHub(window)
    await startBlankSlides(window)

    // A clean slide, then three different element types from the Insert menu.
    await selectBarTab(window, 'slides-toolbar', 'design')
    await window.locator('[data-testid="slides-prop-layout"]').click()
    await window.locator('[data-testid="slides-layout-blank"]').click()
    await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(0)
    await menu(window, 'insert', 'Text box')
    await menu(window, 'insert', 'Table')
    await menu(window, 'insert', 'Chart')
    const onSlide = window.locator('[data-testid="slide-element"]')
    await expect(onSlide).toHaveCount(3)

    // Marquee across the whole slide selects all three.
    const box = (await window.locator('[data-testid="slide-canvas"]').boundingBox())!
    await window.mouse.move(box.x + 4, box.y + 4)
    await window.mouse.down()
    await window.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 10 })
    await window.mouse.up()
    await selectBarTab(window, 'slides-toolbar', 'arrange')
    await expect(window.locator('[data-testid="slides-distribute-h"]')).toBeEnabled({ timeout: 3_000 }) // three selected

    // Edit › Save selection as snippet…
    await menu(window, 'edit', 'Save selection as snippet…')
    const dialog = window.locator('[data-testid="save-snippet-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="save-snippet-empty"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="save-snippet-preview"]')).toHaveText('3 element(s)')
    await window.locator('[data-testid="save-snippet-name"]').fill('Revenue block')
    await window.locator('[data-testid="save-snippet-confirm"]').click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    // Stored as a slide snippet, positions relative to the selection's top-left.
    const saved = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.snippets.list({ kinds: ['slide'] })
      return list.find((s) => s.name === 'Revenue block') ?? null
    })
    expect(saved, 'the snippet was saved').toBeTruthy()
    expect(saved!.kind).toBe('slide')
    const savedEls = (saved!.body as { elements: El[] }).elements
    expect(savedEls.map((e) => e.type).sort()).toEqual(['chart', 'table', 'text'])
    expect(Math.min(...savedEls.map((e) => e.x))).toBe(0)
    expect(Math.min(...savedEls.map((e) => e.y))).toBe(0)

    const originals = await readElements(window)
    expect(originals).toHaveLength(3)

    // Clear the selection before inserting (Escape, from the editor's key handler).
    await window.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await expect(window.locator('[data-testid="slides-el-delete"]')).toBeDisabled()

    // Insert › Insert snippet… opens the library scoped to slide snippets.
    await menu(window, 'insert', 'Insert snippet…')
    await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
    const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Revenue block' })
    await expect(row).toBeVisible()
    // Honest modes: a deck cannot resolve a reference at render time, so no Live.
    await expect(row.locator('[data-testid="snippet-insert-live"]')).toHaveCount(0)
    await row.locator('[data-testid="snippet-insert-duplicate"]').click()
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })

    // Doubled on the slide, and the copy is the selection.
    await expect(onSlide).toHaveCount(6)
    await selectBarTab(window, 'slides-toolbar', 'arrange')
    await expect(window.locator('[data-testid="slides-distribute-h"]')).toBeEnabled()

    // One undo step takes the whole insertion back; redo restores it.
    await window.locator('[data-testid="slides-undo"]').click()
    await expect(onSlide).toHaveCount(3)
    await window.locator('[data-testid="slides-redo"]').click()
    await expect(onSlide).toHaveCount(6)

    // Persisted: six elements, six distinct ids, each original matched by a copy
    // with identical content and size, and the block's shape preserved.
    const all = await readElements(window)
    expect(all).toHaveLength(6)
    expect(new Set(all.map((e) => e.id)).size).toBe(6)
    const origIds = new Set(originals.map((e) => e.id))
    const copies = all.filter((e) => !origIds.has(e.id))
    expect(copies).toHaveLength(3)
    const pairs = originals.map((o) => {
      const c = copies.find((x) => x.type === o.type)!
      expect(c, `a copy of the ${o.type}`).toBeTruthy()
      expect(content(c), `${o.type} content`).toBe(content(o))
      expect([c.w, c.h], `${o.type} size`).toEqual([o.w, o.h])
      return [o, c] as const
    })
    const oMin = { x: Math.min(...originals.map((e) => e.x)), y: Math.min(...originals.map((e) => e.y)) }
    const cMin = { x: Math.min(...copies.map((e) => e.x)), y: Math.min(...copies.map((e) => e.y)) }
    for (const [o, c] of pairs) {
      expect([c.x - cMin.x, c.y - cMin.y], `${o.type} relative position`).toEqual([o.x - oMin.x, o.y - oMin.y])
    }
    // Stacked above everything that was already on the slide.
    expect(Math.min(...copies.map((e) => e.z))).toBeGreaterThan(Math.max(...originals.map((e) => e.z)))

    // The use was counted, because the deck really took it.
    const used = await window.evaluate(async (id: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.snippets.list({ kinds: ['slide'] })
      return list.find((s) => s.id === id)?.usageCount ?? -1
    }, saved!.id)
    expect(used).toBe(1)
  } finally {
    await dispose()
  }
})
