import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, chooseCloudAiSource, placeDesign, selectBarTab, type LaunchedApp } from './_helpers'

// Design and Diagrams actions that one surface implemented differently, or that
// a menu showed with a key that never fired (registry-41 inventory). Seen red on
// the e1f7ec5f build before the fix, except Diagrams ⇧⌘], which e1f7ec5f already
// fixed (proven by tests/unit/diagramKeys): that one guards against a regression.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

async function open(docType: string, body?: unknown): Promise<{ w: Page; id: string }> {
  launched = await launchApp()
  const w = launched.window
  await waitForReady(w)
  await chooseCloudAiSource(w)
  await suppressFeatureSpotlights(w)
  const id = await w.evaluate(
    async ({ docType, body }) =>
      ((await (window as unknown as { api: typeof window.api }).api.documents.create({ docType, title: 'One action', ...(body ? { body } : {}) } as never)) as { id: string }).id,
    { docType, body }
  )
  await w.reload()
  await waitForReady(w)
  await w.evaluate((i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
  return { w, id }
}

const storedBody = <T,>(w: Page, id: string): Promise<T> =>
  w.evaluate(async (i) => ((await (window as unknown as { api: typeof window.api }).api.documents.get(i)) as { body: unknown }).body, id) as Promise<T>

test('Design: the ribbon’s Bring forward moves every selected frame, as the keys and right-click do', async () => {
  test.setTimeout(120_000)
  const { w, id } = await open('design')
  await expect(w.locator('[data-testid="design-menubar"]')).toBeVisible({ timeout: 15_000 })
  // Three frames, A under B under C (creation order).
  await placeDesign(w, 'rect', { fx: 0.3, fy: 0.3 })
  await placeDesign(w, 'rect', { fx: 0.5, fy: 0.5 })
  await placeDesign(w, 'rect', { fx: 0.7, fy: 0.7 })
  type D = { elements: Array<{ id: string; z: number }> }
  await expect.poll(async () => (await storedBody<D>(w, id)).elements?.length ?? 0, { timeout: 8_000 }).toBe(3)
  const [a, b, c] = [...(await storedBody<D>(w, id)).elements].sort((x, y) => x.z - y.z).map((e) => e.id)
  const frame = (eid: string) => w.locator(`.react-draggable:has([data-element-id="${eid}"])`)
  await frame(a!).click()
  await frame(b!).click({ modifiers: ['Shift'] })
  await selectBarTab(w, 'design-toolbar', 'arrange')
  await w.locator('[data-testid="design-toolbar"]').getByRole('button', { name: /^Bring forward/ }).first().click()
  await expect
    .poll(async () => {
      const z = Object.fromEntries((await storedBody<D>(w, id)).elements.map((e) => [e.id, e.z]))
      return z[c!]! < z[a!]! && z[c!]! < z[b!]!
    }, { message: 'both selected frames stepped past C (only the first one used to move)', timeout: 5_000 })
    .toBe(true)
})

test('Diagrams: ⇧⌘] brings the selected shape to front (Shift used to turn ] into } and nothing fired)', async () => {
  test.setTimeout(90_000)
  const body = {
    version: 1,
    nodes: [
      { id: 'a', x: 200, y: 160, label: 'A', shape: 'rect', color: '#336699', width: 160, height: 80 },
      { id: 'b', x: 260, y: 190, label: 'B', shape: 'rect', color: '#993366', width: 160, height: 80 }
    ],
    edges: []
  }
  const { w, id } = await open('map', body)
  await expect(w.locator('.react-flow__node[data-id="a"]')).toBeVisible({ timeout: 15_000 })
  await w.locator('.react-flow__node[data-id="a"]').click({ position: { x: 10, y: 10 } })
  // What a Mac sends: Shift turns ] into }. Playwright's press keeps "]", which
  // is why this passed while the real key did nothing.
  await w.evaluate(() =>
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: '}', code: 'BracketRight', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  )
  type G = { nodes?: Array<{ id: string }>; pages?: Array<{ nodes: Array<{ id: string }> }> }
  await expect
    .poll(async () => {
      const g = await storedBody<G>(w, id)
      const nodes = g.nodes ?? g.pages?.[0]?.nodes ?? []
      return nodes[nodes.length - 1]?.id
    }, { message: 'A is now on top', timeout: 5_000 })
    .toBe('a')
})

type MapG = { nodes?: Array<{ id: string; label?: string; style?: { bold?: boolean } }>; pages?: Array<{ nodes: Array<{ id: string; label?: string; style?: { bold?: boolean } }> }> }
const nodesOf = (g: MapG) => g.nodes ?? g.pages?.[0]?.nodes ?? []

test('Diagrams: Edit › Paste pastes text from another app, as ⌘V does', async () => {
  test.setTimeout(90_000)
  const { w, id } = await open('map', { version: 1, nodes: [{ id: 'a', x: 200, y: 160, label: 'A', shape: 'process', width: 160, height: 80 }], edges: [] })
  await expect(w.locator('.react-flow__node[data-id="a"]')).toBeVisible({ timeout: 15_000 })
  await launched!.app.evaluate(({ clipboard }) => clipboard.writeText('Pasted from Notes'))
  await w.locator('[data-testid="draw-menubar-edit"]').click()
  await w.locator('[data-testid="draw-menubar-edit-list"]').getByText('Paste', { exact: true }).click()
  await expect
    .poll(async () => nodesOf(await storedBody<MapG>(w, id)).some((n) => n.label === 'Pasted from Notes'), { message: 'the menu pasted the text (it used to paste nothing from outside)', timeout: 5_000 })
    .toBe(true)
})

test('Diagrams: ⌘B on a shape that is bold by default makes it not bold, as the ribbon does', async () => {
  test.setTimeout(90_000)
  const { w, id } = await open('map', { version: 1, nodes: [{ id: 'm', x: 200, y: 160, label: 'Main topic', shape: 'mind-main', width: 150, height: 52 }], edges: [] })
  await expect(w.locator('.react-flow__node[data-id="m"]')).toBeVisible({ timeout: 15_000 })
  await w.locator('.react-flow__node[data-id="m"]').click({ position: { x: 8, y: 8 } })
  await w.keyboard.press('Meta+b')
  await expect
    .poll(async () => nodesOf(await storedBody<MapG>(w, id)).find((n) => n.id === 'm')?.style?.bold, { message: '⌘B turned the default bold off (it used to set bold:true, which changed nothing)', timeout: 5_000 })
    .toBe(false)
})

test('Design: ⌘B bolds the selected text frame (the key the ribbon shows)', async () => {
  test.setTimeout(120_000)
  const body = {
    width: 794,
    height: 1123,
    elements: [{ id: 't1', type: 'text', x: 120, y: 160, w: 360, h: 80, z: 1, paragraphs: [{ runs: [{ text: 'Heading here' }] }] }]
  }
  const { w, id } = await open('design', body)
  await expect(w.locator('[data-testid="design-menubar"]')).toBeVisible({ timeout: 15_000 })
  type D = { elements?: Array<{ id: string; type: string; paragraphs?: Array<{ runs: Array<{ bold?: boolean }> }> }>; pages?: Array<{ elements: Array<{ id: string; type: string; paragraphs?: Array<{ runs: Array<{ bold?: boolean }> }> }> }> }
  const textOf = async () => {
    const d = await storedBody<D>(w, id)
    return (d.elements ?? d.pages?.[0]?.elements ?? []).find((e) => e.type === 'text')
  }
  const tid = (await textOf())!.id
  await w.locator(`.react-draggable:has([data-element-id="${tid}"])`).click()
  await w.keyboard.press('Meta+b')
  await expect.poll(async () => !!(await textOf())?.paragraphs?.[0]?.runs[0]?.bold, { message: '⌘B made the frame bold', timeout: 5_000 }).toBe(true)
})
