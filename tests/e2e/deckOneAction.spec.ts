import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, chooseCloudAiSource, type LaunchedApp } from './_helpers'

// PlexiiDeck actions that two surfaces implemented differently, or that a menu
// showed with a key nothing bound (registry-41 inventory). Each now has one
// definition (slides/deckCommands). Seen red on the e1f7ec5f build before the
// fix, except ⌘A, which e1f7ec5f already bound: that one guards against a
// regression.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

const text = (id: string, x: number, words: string, z: number) => ({ id, type: 'text', x, y: 200, w: 300, h: 100, z, paragraphs: [{ runs: [{ text: words }] }] })

async function openDeck(elements: unknown[]): Promise<{ w: Page; id: string }> {
  launched = await launchApp()
  const w = launched.window
  await waitForReady(w)
  await chooseCloudAiSource(w)
  await suppressFeatureSpotlights(w)
  const id = await w.evaluate(
    async (els) =>
      ((await (window as unknown as { api: typeof window.api }).api.documents.create({
        docType: 'slides',
        title: 'One action',
        // Version 2 slides: an older slide is migrated, and migration replaces
        // its elements with a generated title (slidesMigrate).
        body: { schemaVersion: 2, slides: [{ id: 's1', notes: '', elements: els, schemaVersion: 2 }, { id: 's2', notes: '', elements: [], schemaVersion: 2 }] }
      } as never)) as { id: string }).id,
    elements
  )
  await w.reload()
  await waitForReady(w)
  await w.evaluate((i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
  await expect(w.locator('[data-testid="slides-menubar"]')).toBeVisible({ timeout: 15_000 })
  return { w, id }
}

// What a Mac sends for ⇧⌘]: Shift turns the key into "}" (Playwright's own
// press keeps "]", which hid exactly this bug in Diagrams).
const shiftedBracket = (w: Page, right: boolean) =>
  w.evaluate((r) => {
    const t = document.activeElement ?? document.body
    t.dispatchEvent(new KeyboardEvent('keydown', { key: r ? '}' : '{', code: r ? 'BracketRight' : 'BracketLeft', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  }, right)
// Deck migrates element ids on load, so elements are found by their words.
const byText = (els: Array<{ z: number; paragraphs?: Array<{ runs: Array<{ text?: string }> }> }>, words: string) =>
  els.find((e) => e.paragraphs?.[0]?.runs[0]?.text === words)!
const stored = (w: Page, id: string) =>
  w.evaluate(async (i) => ((await (window as unknown as { api: typeof window.api }).api.documents.get(i)) as { body: { slides: Array<{ elements: Array<{ id: string; z: number; paragraphs?: Array<{ runs: Array<{ bold?: boolean; text?: string }> }> }> }> } }).body, id)

// Deck migrates element ids on load: find an element's frame by the words it holds.
const frameFor = async (w: Page, id: string, words: string) => {
  const el = byText((await stored(w, id)).slides[0]!.elements, words) as unknown as { id: string }
  return w.locator(`.react-draggable:has([data-element-id="${el.id}"])`)
}

test('Slide › New slide opens the template gallery, as the ribbon and palette do', async () => {
  test.setTimeout(90_000)
  const { w } = await openDeck([text('a', 100, 'One', 1)])
  await w.locator('[data-testid="slides-menubar-slide"]').click()
  await w.locator('[data-testid="slides-menubar-slide-list"]').getByText('New slide', { exact: true }).click()
  await expect(w.locator('[data-testid="slide-template-gallery"]'), 'the menu opens the gallery, not a blank slide').toBeVisible()
})

test('⌘A selects every element on the slide (the key Edit › Select all shows)', async () => {
  test.setTimeout(90_000)
  const { w, id } = await openDeck([text('a', 60, 'One', 1), text('b', 700, 'Two', 2)])
  await (await frameFor(w, id, 'One')).click()
  await w.keyboard.press('Meta+a')
  // Proven by what it does: Backspace then deletes both.
  await w.keyboard.press('Backspace')
  await expect.poll(async () => (await stored(w, id)).slides[0]!.elements.length, { message: '⌘A selected both', timeout: 5_000 }).toBe(0)
})

test('⌘B bolds the selected text box (the key the ribbon shows)', async () => {
  test.setTimeout(90_000)
  const { w, id } = await openDeck([text('a', 100, 'One', 1)])
  await (await frameFor(w, id, 'One')).click()
  await w.keyboard.press('Meta+b')
  await expect.poll(async () => !!(await stored(w, id)).slides[0]!.elements[0]!.paragraphs?.[0]?.runs[0]?.bold, { message: '⌘B made it bold', timeout: 5_000 }).toBe(true)
})

test('Undo after Bring to front puts the stacking back', async () => {
  test.setTimeout(90_000)
  const { w, id } = await openDeck([text('a', 60, 'Under', 1), text('b', 700, 'Over', 2)])
  await (await frameFor(w, id, 'Under')).click()
  await shiftedBracket(w, true)
  await expect.poll(async () => byText((await stored(w, id)).slides[0]!.elements, 'Under').z, { timeout: 5_000 }).toBeGreaterThan(2)
  await w.keyboard.press('Meta+z')
  await expect.poll(async () => byText((await stored(w, id)).slides[0]!.elements, 'Under').z, { message: 'undo restored z 1', timeout: 5_000 }).toBe(1)
})

test('Bring to front on two elements keeps their own order', async () => {
  test.setTimeout(90_000)
  const { w, id } = await openDeck([text('a', 40, 'Alpha', 1), text('b', 460, 'Bravo', 2), text('c', 880, 'Charlie', 3)])
  // Select B, then A.
  await (await frameFor(w, id, 'Bravo')).click()
  await (await frameFor(w, id, 'Alpha')).click({ modifiers: ['Shift'] })
  await shiftedBracket(w, true)
  await expect
    .poll(async () => {
      const els = (await stored(w, id)).slides[0]!.elements
      const [a, b, c] = ['Alpha', 'Bravo', 'Charlie'].map((t) => byText(els, t).z)
      return a! < b! && a! > c!
    }, { message: 'A stays under B, both above C', timeout: 5_000 })
    .toBe(true)
})
