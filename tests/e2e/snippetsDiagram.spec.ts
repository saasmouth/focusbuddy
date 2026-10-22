/**
 * Saved snippets on PlexiiDiagrams, end to end in the real app.
 *
 * SND-1 select two connected shapes, save them via Edit › Save selection as
 *       snippet…, clear the selection, insert the snippet back as a DUPLICATE
 *       via Insert › Insert snippet…, and prove the page now holds twice the
 *       shapes and connectors: new ids, and a new connector joining the NEW
 *       shapes (not the originals). The library offers Duplicate only, because
 *       a diagram declares supports: ['duplicate']; one undo removes the whole
 *       insert.
 *
 * Setup seeds the two shapes through window.api (the diagram specs' pattern);
 * every assertion that matters reads the saved document back from
 * window.api.documents.get, so it proves what was persisted, not just drawn.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights } from './_helpers'

interface SavedNode {
  id: string
  label: string
}
interface SavedEdge {
  id: string
  source: string
  target: string
}
interface SavedBody {
  nodes?: SavedNode[]
  edges?: SavedEdge[]
}

const SEED = {
  version: 1,
  nodes: [
    { id: 'seed-a', x: 80, y: 120, label: 'Order placed', shape: 'process', color: '#2563eb' },
    { id: 'seed-b', x: 360, y: 120, label: 'Order shipped', shape: 'process', color: '#2563eb' }
  ],
  edges: [{ id: 'seed-ab', source: 'seed-a', target: 'seed-b', routing: 'orthogonal', endArrow: 'arrow' }],
  viewport: { x: 0, y: 0, zoom: 1 }
}

async function createSeededMap(window: Page, title: string): Promise<string> {
  return window.evaluate(
    async ({ t, body }) => {
      const w = window as unknown as {
        api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }
        __fbView?: { getState: () => { goDocument: (id: string) => void } }
      }
      const d = await w.api.documents.create({ docType: 'map', title: t, body })
      w.__fbView?.getState().goDocument(d.id)
      return d.id
    },
    { t: title, body: SEED }
  )
}

async function readBody(window: Page, id: string): Promise<SavedBody> {
  return window.evaluate(async (docId: string) => {
    const api = (window as unknown as { api: { documents: { get: (id: string) => Promise<{ body: unknown } | null> } } }).api
    const doc = await api.documents.get(docId)
    return (doc?.body ?? {}) as SavedBody
  }, id)
}

async function waitForSaved(window: Page, id: string, pred: (b: SavedBody) => boolean): Promise<SavedBody> {
  let body: SavedBody = {}
  await expect
    .poll(
      async () => {
        body = await readBody(window, id)
        return pred(body)
      },
      { timeout: 10_000 }
    )
    .toBe(true)
  return body
}

/** A point that really is bare canvas (not a node, the minimap or a control). */
async function bareCanvasPoint(window: Page): Promise<{ x: number; y: number }> {
  const spot = await window.evaluate(() => {
    const r = document.querySelector('.react-flow__pane')!.getBoundingClientRect()
    for (const fy of [0.85, 0.15, 0.5]) {
      for (const fx of [0.1, 0.3, 0.7, 0.9]) {
        const x = r.left + r.width * fx
        const y = r.top + r.height * fy
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y }
      }
    }
    return null
  })
  expect(spot, 'a bare spot on the canvas').not.toBeNull()
  return spot!
}

async function menuItem(window: Page, menu: 'edit' | 'insert', label: string): Promise<void> {
  await window.locator(`[data-testid="draw-menubar-${menu}"]`).click()
  await window.locator(`[data-testid="draw-menubar-${menu}-list"]`).getByText(label, { exact: true }).click()
}

test('SND-1 — save two connected shapes as a snippet, then insert a duplicate with fresh ids', async () => {
  const { window, dispose } = await launchApp()
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await suppressFeatureSpotlights(window)

    const id = await createSeededMap(window, 'Snippet source')
    await expect(window.locator('[data-testid="diagram-editor"]')).toBeVisible({ timeout: 12_000 })
    await expect(window.locator('.react-flow__node')).toHaveCount(2, { timeout: 8_000 })
    await expect(window.locator('.react-flow__edge')).toHaveCount(1)

    // Select both shapes (select-all from the canvas: just the two shapes and their connector).
    const spot = await bareCanvasPoint(window)
    await window.mouse.click(spot.x, spot.y)
    await window.keyboard.press('Meta+a')
    const summary = window.locator('[data-testid="diagram-selection-summary"]')
    await expect(summary).toContainText('2 shapes')

    // Edit › Save selection as snippet…
    await menuItem(window, 'edit', 'Save selection as snippet…')
    const dialog = window.locator('[data-testid="save-snippet-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="save-snippet-empty"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="save-snippet-preview"]')).toContainText('2 shape(s), 1 connector(s)')
    // The suggested name comes from the fragment's first labelled shape.
    await expect(window.locator('[data-testid="save-snippet-name"]')).toHaveValue('Order placed and 1 more')
    await window.locator('[data-testid="save-snippet-name"]').fill('Order flow')
    await window.locator('[data-testid="save-snippet-confirm"]').click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    // Clear the selection first (the guide's trap: insertion acts on the
    // selection like a paste). A diagram paste adds rather than replaces, and
    // the inserted shapes become the selection, so starting from nothing makes
    // the "2 shapes selected" below prove it is the copies that are selected.
    const spot2 = await bareCanvasPoint(window)
    await window.mouse.click(spot2.x, spot2.y)
    await expect(summary).not.toContainText('selected')

    // Insert › Insert snippet… opens the library scoped to diagram fragments.
    await menuItem(window, 'insert', 'Insert snippet…')
    const library = window.locator('[data-testid="snippet-library"]')
    await expect(library).toBeVisible({ timeout: 5_000 })
    const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Order flow' })
    await expect(row).toBeVisible()
    await expect(row).toContainText('Diagram fragment')
    // Honest labels: a diagram cannot honour Live, so it is not offered.
    await expect(row.locator('[data-testid="snippet-insert-live"]')).toHaveCount(0)
    await row.locator('[data-testid="snippet-insert-duplicate"]').click()
    await expect(library).toBeHidden({ timeout: 5_000 })

    // On screen: twice the shapes and connectors, and the copies are selected.
    await expect(window.locator('.react-flow__node')).toHaveCount(4, { timeout: 5_000 })
    await expect(window.locator('.react-flow__edge')).toHaveCount(2)
    await expect(summary).toContainText('2 shapes')

    // Persisted: four distinct shapes, two connectors, the new one joining the new shapes.
    const saved = await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) === 4 && (b.edges?.length ?? 0) === 2)
    const nodes = saved.nodes!
    const edges = saved.edges!
    expect(new Set(nodes.map((n) => n.id)).size, 'every shape has its own id').toBe(4)
    expect(new Set(edges.map((e) => e.id)).size, 'every connector has its own id').toBe(2)
    const fresh = nodes.filter((n) => n.id !== 'seed-a' && n.id !== 'seed-b')
    expect(fresh.map((n) => n.label).sort()).toEqual(['Order placed', 'Order shipped'])
    const freshIds = new Set(fresh.map((n) => n.id))
    const newEdge = edges.find((e) => e.id !== 'seed-ab')!
    expect(freshIds.has(newEdge.source), 'the new connector starts at a new shape').toBe(true)
    expect(freshIds.has(newEdge.target), 'the new connector ends at a new shape').toBe(true)
    expect(nodes.find((n) => n.id === newEdge.source)!.label).toBe('Order placed')
    expect(nodes.find((n) => n.id === newEdge.target)!.label).toBe('Order shipped')
    // The original pair is untouched.
    expect(edges.find((e) => e.id === 'seed-ab')).toMatchObject({ source: 'seed-a', target: 'seed-b' })

    // One undo step removes the whole insert, as after a paste.
    await window.keyboard.press('Meta+z')
    await expect(window.locator('.react-flow__node')).toHaveCount(2, { timeout: 5_000 })
    await expect(window.locator('.react-flow__edge')).toHaveCount(1)
    await waitForSaved(window, id, (b) => (b.nodes?.length ?? 0) === 2 && (b.edges?.length ?? 0) === 1)

    expect(errors).toEqual([])
  } finally {
    await dispose()
  }
})
