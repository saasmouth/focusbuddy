/**
 * Any content into PlexiiDeck and PlexiiDesign, end to end in the real app.
 *
 * AK-1 a DIAGRAM snippet inserted into a deck lands as a picture (an image
 *      element holding a data:image/svg+xml), and the notice says so.
 * AK-2 a PlexiiDraw COPY pasted into a deck with ⌘V lands as an image element
 *      holding the art's SVG picture (through the same conversion).
 * AD-1 a DOC snippet inserted into a design lands as a text frame reading a
 *      new story holding the words, heading and paragraph.
 * AD-2 two Deck text boxes copied and pasted into a design land as two text
 *      frames, and the notice says how to make them flow.
 *
 * Every result is read back from the stored document. This spec uses the
 * real system clipboard: every item and type on it is saved first and put
 * back afterwards (tests/e2e/_macPasteboard.ts).
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, gotoView, chooseCloudAiSource, suppressFeatureSpotlights, selectBarTab, switchArea } from './_helpers'
import { openDocument, rectObject, seedDrawDoc, stagePoint, v1Body } from './_drawHelpers'
import { restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'

type El = Record<string, unknown> & { id: string; type: string; x: number; y: number; w: number; h: number; src?: string; storyId?: string }
type StoredDesign = { elements: El[]; stories?: Record<string, { blocks: Array<{ text?: string }> }> }

let saved: SavedPasteboard | null = null
test.beforeAll(() => {
  if (process.platform === 'darwin') saved = savePasteboard()
})
test.afterAll(() => {
  if (saved) restorePasteboard(saved)
})

async function boot(): Promise<{ window: Page; dispose: () => Promise<void>; app: Awaited<ReturnType<typeof launchApp>>['app'] }> {
  const launched = await launchApp()
  await waitForReady(launched.window)
  await chooseCloudAiSource(launched.window)
  await suppressFeatureSpotlights(launched.window)
  return launched
}

async function seedSnippet(window: Page, kind: string, name: string, body: unknown): Promise<void> {
  await window.evaluate(
    async ({ kind, name, body }) => {
      const api = (window as unknown as { api: { snippets: { create: (d: unknown) => Promise<{ ok: boolean; error?: string }> } } }).api
      const res = await api.snippets.create({ kind, name, body, scope: 'personal' })
      if (!res.ok) throw new Error(res.error ?? 'not saved')
    },
    { kind, name, body }
  )
}

// ── PlexiiDeck ──────────────────────────────────────────────────────────────

async function startBlankSlides(window: Page): Promise<void> {
  await gotoView(window, 'goDocuments')
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Slides' }).first().click()
  await expect(window.locator('[data-testid="slides-toolbar"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible({ timeout: 8_000 })
  await selectBarTab(window, 'slides-toolbar', 'design')
  await window.locator('[data-testid="slides-prop-layout"]').click()
  await window.locator('[data-testid="slides-layout-blank"]').click()
  await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(0)
}

async function deckMenu(window: Page, id: string, item: string): Promise<void> {
  await window.locator(`[data-testid="slides-menubar-${id}"]`).click()
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await window.locator(`[data-testid="slides-menubar-${id}-list"]`).getByRole('button', { name: new RegExp(`^${escaped}`) }).click()
}

async function readSlide(window: Page): Promise<El[]> {
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

// ── PlexiiDesign ────────────────────────────────────────────────────────────

async function openDesign(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

async function designMenu(window: Page, id: string, item: string): Promise<void> {
  await window.locator(`[data-testid="design-menubar-${id}"]`).click()
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await window.locator(`[data-testid="design-menubar-${id}-list"]`).getByRole('button', { name: new RegExp(`^${escaped}`) }).click()
}

async function readDesign(window: Page): Promise<StoredDesign> {
  await window.waitForTimeout(1_500)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const design = docs.find((d) => d.docType === 'design')
    const doc = design ? await api.documents.get(design.id) : null
    return (doc?.body ?? {}) as StoredDesign
  })
}

/** A click on empty stage at the page's top-right (pinned panels cover the top-left). */
async function clickEmptyCanvas(window: Page): Promise<void> {
  const cb = (await window.locator('[data-testid="slide-canvas"]').boundingBox())!
  await window.mouse.click(cb.x + cb.width - 4, cb.y + 4)
}

async function insertDuplicate(window: Page, name: string): Promise<void> {
  await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
  const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 5_000 })
  await row.locator('[data-testid="snippet-insert-duplicate"]').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })
}

// ── The tests ───────────────────────────────────────────────────────────────

test('AK-1 a diagram snippet inserted into a deck lands as a picture, and says so', async () => {
  test.setTimeout(90_000)
  const { window, dispose } = await boot()
  try {
    await seedSnippet(window, 'diagram', 'Approval flow', {
      kind: 'diagram',
      nodes: [
        { id: 'a', x: 0, y: 0, label: 'Start', shape: 'process', color: '#2563eb', width: 140, height: 60 },
        { id: 'b', x: 240, y: 0, label: 'Approved?', shape: 'decision', color: '#2563eb', width: 140, height: 80 }
      ],
      edges: [{ id: 'e', source: 'a', target: 'b', label: 'submit' }]
    })
    await startBlankSlides(window)
    await deckMenu(window, 'insert', 'Insert snippet…')
    await insertDuplicate(window, 'Approval flow')
    await expect(window.locator('[data-testid="notice-toast"]')).toContainText('It becomes a picture: edit it in PlexiiDiagrams.', { timeout: 5_000 })
    const els = await readSlide(window)
    expect(els).toHaveLength(1)
    expect(els[0].type).toBe('image')
    expect(String(els[0].src)).toMatch(/^data:image\/svg\+xml/)
  } finally {
    await dispose()
  }
})

test('AK-2 a PlexiiDraw copy pasted into a deck lands as the art’s picture', async () => {
  test.setTimeout(90_000)
  const { window, dispose, app } = await boot()
  try {
    const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 120, 160, 90)]), 'Copy source')
    await openDocument(window, id)
    const p = await stagePoint(window, 800, { x: 180, y: 165 })
    await window.mouse.click(p.x, p.y)
    await window.keyboard.press('Meta+c')
    // The copy is written by the main process; wait until it is really there.
    await expect
      .poll(async () => app.evaluate(async ({ clipboard }) => ((await clipboard.read())[0]?.types ?? []).includes('web application/vnd.plexii.draw+json')), { timeout: 8_000 })
      .toBe(true)

    await startBlankSlides(window)
    await clickEmptyCanvas(window)
    await window.keyboard.press('Meta+v')
    await expect.poll(async () => (await readSlide(window)).length, { timeout: 10_000 }).toBe(1)
    const els = await readSlide(window)
    expect(els[0].type).toBe('image')
    expect(String(els[0].src)).toMatch(/^data:image\/svg\+xml/)
    await expect(window.locator('[data-testid="notice-toast"]')).toContainText('edit it in PlexiiDraw', { timeout: 5_000 })
  } finally {
    await dispose()
  }
})

test('AD-1 a doc snippet inserted into a design lands as a text frame reading a new story', async () => {
  test.setTimeout(90_000)
  const { window, dispose } = await boot()
  try {
    await seedSnippet(window, 'doc', 'Payment terms', {
      kind: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Payment terms' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Pay within 30 days.' }] }
      ],
      text: 'Payment terms\nPay within 30 days.'
    })
    await openDesign(window)
    await designMenu(window, 'insert', 'Insert snippet…')
    await insertDuplicate(window, 'Payment terms')
    await expect.poll(async () => (await readDesign(window)).elements?.length ?? 0, { timeout: 10_000 }).toBe(1)
    const d = await readDesign(window)
    const frame = d.elements[0]
    expect(frame.type).toBe('text')
    expect(typeof frame.storyId).toBe('string')
    const words = (d.stories?.[frame.storyId!]?.blocks ?? []).map((b) => b.text ?? '')
    expect(words).toContain('Payment terms')
    expect(words).toContain('Pay within 30 days.')
  } finally {
    await dispose()
  }
})

test('AD-2 Deck text boxes pasted into a design land as frames, with how to make them flow', async () => {
  test.setTimeout(120_000)
  const { window, dispose } = await boot()
  try {
    await startBlankSlides(window)
    await deckMenu(window, 'insert', 'Text box')
    await deckMenu(window, 'insert', 'Text box')
    await expect(window.locator('[data-testid="slide-element"]')).toHaveCount(2)
    await window.keyboard.press('Escape')
    const box = (await window.locator('[data-testid="slide-canvas"]').boundingBox())!
    await window.mouse.move(box.x + 4, box.y + 4)
    await window.mouse.down()
    await window.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 10 })
    await window.mouse.up()
    await selectBarTab(window, 'slides-toolbar', 'arrange')
    await expect(window.locator('[data-testid="slides-el-delete"]')).toBeEnabled({ timeout: 3_000 })
    // The marquee drag also selects DOM text under it, and with a text
    // selection Deck rightly leaves ⌘C to the browser (copy these words).
    // Clear it, so ⌘C copies the selected elements.
    await window.evaluate(() => window.getSelection()?.removeAllRanges())
    await window.keyboard.press('Meta+c')
    await window.waitForTimeout(400)

    await openDesign(window)
    await clickEmptyCanvas(window)
    await window.keyboard.press('Meta+v')
    await expect.poll(async () => (await readDesign(window)).elements?.length ?? 0, { timeout: 10_000 }).toBe(2)
    const d = await readDesign(window)
    expect(d.elements.map((e) => e.type)).toEqual(['text', 'text'])
    await expect(window.locator('[data-testid="notice-toast"]')).toContainText('Link text frames', { timeout: 5_000 })
  } finally {
    await dispose()
  }
})
