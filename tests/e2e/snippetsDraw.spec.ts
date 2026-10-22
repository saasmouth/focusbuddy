/**
 * Saved snippets in PlexiiDraw, end to end in the real app.
 *
 * SD-1 save a selection from Edit › Save selection as snippet…, clear the
 *      selection, insert it back from Edit › Insert snippet… as a DUPLICATE,
 *      and read two copies with distinct ids and identical geometry back from
 *      the stored drawing. The library offers Duplicate only: a drawing cannot
 *      honour a live instance (docs/saved-snippets.md, "Why a drawing offers
 *      Duplicate only"), so a Live button would be a lie.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, runMenu, seedDrawDoc, v1Body } from './_drawHelpers'

type Node = { id: string; type: string; fill?: unknown; path?: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }
type Body = { layers: Array<{ kind: string; objects?: Node[] }> }

function objectsOf(raw: unknown): Node[] {
  return (raw as Body).layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}

function box(o: Node): { x: number; y: number; w: number; h: number } {
  const ns = o.path!.subpaths.flatMap((s) => s.nodes)
  const xs = ns.map((n) => n.x)
  const ys = ns.map((n) => n.y)
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/** Two objects' geometry with the pair's top-left as origin: what "identical geometry" means for a block. */
function relative(pair: Node[]): Array<{ x: number; y: number; w: number; h: number; fill: unknown }> {
  const boxes = pair.map(box)
  const ox = Math.min(...boxes.map((b) => b.x))
  const oy = Math.min(...boxes.map((b) => b.y))
  return pair.map((n, i) => ({ x: boxes[i].x - ox, y: boxes[i].y - oy, w: boxes[i].w, h: boxes[i].h, fill: n.fill }))
}

async function storedObjects(window: Page, id: string, n: number): Promise<Node[]> {
  await expect.poll(async () => objectsOf((await readStored(window, id)).raw).length, { timeout: 10_000 }).toBe(n)
  return objectsOf((await readStored(window, id)).raw)
}

test('SD-1 save a Draw selection as a snippet and insert it back as a duplicate', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await suppressFeatureSpotlights(window)
    await keepNoticesOutOfTheWay(window)

    const id = await seedDrawDoc(
      window,
      v1Body([rectObject('a', 100, 120, 160, 90), rectObject('b', 300, 140, 60, 40, { fill: { type: 'solid', color: '#ff6600' } })]),
      'Snippet source'
    )
    await openDocument(window, id)

    // Select both objects and save them as a snippet from the Edit menu.
    await runMenu(window, 'edit', 'Select all')
    await runMenu(window, 'edit', 'Save selection as snippet')
    const dialog = window.locator('[data-testid="save-snippet-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    // There is something to save: an empty selection would be refused here.
    await expect(window.locator('[data-testid="save-snippet-empty"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="save-snippet-preview"]')).toContainText('2 object(s)')
    await window.locator('[data-testid="save-snippet-name"]').fill('Two boxes')
    await window.locator('[data-testid="save-snippet-confirm"]').click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    // It is stored as a draw snippet, positions relative to the block's top-left.
    const saved = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.snippets.list({ kinds: ['draw'] })
      return list.map((s) => ({ name: s.name, kind: s.kind, body: s.body }))
    })
    expect(saved.map((s) => s.name)).toEqual(['Two boxes'])
    const savedObjects = (saved[0].body as unknown as { objects: Node[] }).objects
    expect(savedObjects).toHaveLength(2)
    expect(Math.min(...savedObjects.map((o) => box(o).x))).toBe(0)
    expect(Math.min(...savedObjects.map((o) => box(o).y))).toBe(0)

    // Clear the selection first. A paste in Draw adds beside the selection
    // rather than replacing it, but the guide's trap is worth closing anyway:
    // the test must not depend on what was selected.
    await runMenu(window, 'edit', 'Deselect')

    await runMenu(window, 'edit', 'Insert snippet')
    const library = window.locator('[data-testid="snippet-library"]')
    await expect(library).toBeVisible({ timeout: 5_000 })
    const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Two boxes' })
    await expect(row).toBeVisible()
    // A drawing honours Duplicate only, so Live is not offered.
    await expect(row.locator('[data-testid="snippet-insert-live"]')).toHaveCount(0)
    await row.locator('[data-testid="snippet-insert-duplicate"]').click()
    await expect(library).toBeHidden({ timeout: 5_000 })

    // Two copies of the block: four objects, all ids distinct, and the copy
    // has exactly the originals' shapes, sizes, fills and spacing.
    const objects = await storedObjects(window, id, 4)
    const ids = objects.map((o) => o.id)
    expect(new Set(ids).size).toBe(4)
    const originals = objects.filter((o) => o.id === 'a' || o.id === 'b')
    const copies = objects.filter((o) => o.id !== 'a' && o.id !== 'b')
    expect(originals.map((o) => o.id)).toEqual(['a', 'b'])
    expect(copies).toHaveLength(2)
    expect(relative(copies)).toEqual(relative(originals))
    // The originals did not move.
    expect(box(originals[0])).toEqual({ x: 100, y: 120, w: 160, h: 90 })

    // The use was counted, because the drawing actually took the snippet.
    const usage = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.snippets.list({ kinds: ['draw'] })
      return list[0]?.usageCount ?? -1
    })
    expect(usage).toBe(1)
  } finally {
    await dispose()
  }
})
