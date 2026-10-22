// PlexiiDiagrams: two shapes, a connector drawn by a real pointer drag, a shape
// renamed inline, and all of it surviving a FULL app relaunch against the same
// userData. The only relaunch-persistence check diagrams have.
//
// It used to boot the standalone PlexiiOffice app (PLEXI_APP=office), retired in
// c0712e64; it now opens the diagram inside the suite, as people do. It is also
// strict where the old one was not: no "fallback" if the drag or the inline
// rename fails to land; each must really happen.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

interface Body {
  nodes: { id: string; label: string }[]
  edges: { id: string; source: string; target: string }[]
}

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function cloudAiSource(window: Page): Promise<void> {
  // Since 4.3.39 a fresh profile routes AI locally; without the bundled model a
  // notice sits over the editor's toolbar row. Not what this spec is about.
  await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))
}

async function openDoc(window: Page, id: string): Promise<void> {
  await window.evaluate((docId: string) => (window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }).__fbView?.getState().goDocument(docId), id)
  await expect(window.locator('[data-testid="diagram-editor"]')).toBeVisible({ timeout: 12_000 })
}

async function readBody(window: Page, id: string): Promise<Body> {
  return window.evaluate(async (docId: string) => {
    const api = (window as unknown as { api: { documents: { get: (id: string) => Promise<{ body: unknown } | null> } } }).api
    return ((await api.documents.get(docId))?.body ?? { nodes: [], edges: [] }) as Body
  }, id)
}

test('PlexiiDiagrams: two shapes, a drag-connected line and an inline rename survive a full app relaunch', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await cloudAiSource(window)

  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } } }).api
    return (await api.documents.create({ docType: 'map', title: 'Relaunch' })).id
  })
  await openDoc(window, id)
  // A new diagram starts with one shape; add a second from the library.
  await expect(window.locator('.react-flow__node')).toHaveCount(1, { timeout: 8_000 })
  // The library opens from the rail as an overlay panel; close it again so it
  // does not cover the shapes being dragged.
  await window.locator('[data-testid="diagram-toggle-library"]').click()
  await window.locator('[data-testid="map-add-process"]').click()
  await expect(window.locator('.react-flow__node')).toHaveCount(2, { timeout: 5_000 })
  await window.locator('[data-testid="diagram-toggle-library"]').click()
  await expect(window.locator('[data-testid="diagram-panel-library"]')).toHaveCount(0)

  const nodes = window.locator('.react-flow__node')
  const idA = (await nodes.nth(0).getAttribute('data-id'))!
  const idB = (await nodes.nth(1).getAttribute('data-id'))!
  const nodeEl = (nid: string) => window.locator(`.react-flow__node[data-id="${nid}"]`)

  // Pull them apart so the connector has room.
  for (const [nid, dx] of [[idA, -220], [idB, 220]] as const) {
    const b = (await nodeEl(nid).boundingBox())!
    await window.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await window.mouse.down()
    await window.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + 40, { steps: 8 })
    await window.mouse.up()
  }

  // A real pointer drag from A's right connection dot onto B.
  await nodeEl(idA).hover()
  const handle = nodeEl(idA).locator('.react-flow__handle-right').first()
  const h = (await handle.boundingBox())!
  const target = (await nodeEl(idB).boundingBox())!
  await window.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await window.mouse.down()
  await window.mouse.move((h.x + target.x) / 2, (h.y + target.y + target.height / 2) / 2, { steps: 6 })
  await window.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 })
  await window.mouse.up()
  await expect(window.locator('.react-flow__edge')).toHaveCount(1, { timeout: 5_000 })

  // Rename A inline: double-click, type, Enter.
  await nodeEl(idA).dblclick()
  const editor = window.locator('[data-testid="diagram-label-editor"]')
  await expect(editor).toBeVisible({ timeout: 5_000 })
  await editor.fill('Renamed Shape A')
  await window.keyboard.press('Enter')
  await expect(nodeEl(idA)).toContainText('Renamed Shape A')

  // The save is debounced; wait until the stored body has all of it.
  let before: Body = { nodes: [], edges: [] }
  await expect
    .poll(
      async () => {
        before = await readBody(window, id)
        return before.edges.length === 1 && before.nodes.find((n) => n.id === idA)?.label === 'Renamed Shape A'
      },
      { timeout: 10_000 }
    )
    .toBe(true)
  expect(before.nodes).toHaveLength(2)
  expect(before.edges[0]!.source).toBe(idA)
  expect(before.edges[0]!.target).toBe(idB)

  // Full relaunch against the SAME userData directory.
  const dir = launched.userDataDir
  try {
    await Promise.race([launched.app.close(), new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))])
  } catch {
    try {
      launched.app.process().kill()
    } catch {
      /* already gone */
    }
  }
  launched = await launchApp({ userDataDir: dir })
  const w2 = launched.window
  await waitForReady(w2)
  await cloudAiSource(w2)

  const after = await readBody(w2, id)
  expect(after.nodes.map((n) => [n.id, n.label]).sort()).toEqual(before.nodes.map((n) => [n.id, n.label]).sort())
  expect(after.edges.map((e) => [e.id, e.source, e.target])).toEqual(before.edges.map((e) => [e.id, e.source, e.target]))

  // And the reopened editor shows it.
  await openDoc(w2, id)
  await expect(w2.locator('.react-flow__node')).toHaveCount(2, { timeout: 8_000 })
  await expect(w2.locator('.react-flow__edge')).toHaveCount(1)
  await expect(w2.locator(`.react-flow__node[data-id="${idA}"]`)).toContainText('Renamed Shape A')
})
