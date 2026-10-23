/**
 * Any content into PlexiiDiagrams and PlexiiDraw, end to end in the real app
 * (the office-apps half of any-to-any: snippet insertion and cross-app paste,
 * through one conversion matrix).
 *
 * AG-1 a SHEET snippet inserted into a diagram lands as a table-header shape
 *      holding what the cells display (=B2*3 shows 6), and the insert says
 *      it was converted ("Formulas become their values.").
 * AG-2 a PlexiiCells range copied with ⌘C and pasted with ⌘V into a diagram
 *      lands as a table shape holding those cells (not as notes).
 * AW-3 a DIAGRAM snippet inserted into a drawing lands as editable vector
 *      objects (its SVG imported, not a picture), and says connectors became
 *      plain lines.
 * AW-4 a PlexiiDeck text box copied with ⌘C and pasted with ⌘V into a drawing
 *      lands as ONE picture of the slide element (an SVG asset), not as a
 *      text object holding its words.
 *
 * Every result is read back from the stored document. This spec uses the
 * machine's real clipboard: every item and type on it is saved before and put
 * back after (tests/e2e/_macPasteboard.ts).
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, switchArea, gotoView, selectBarTab, type LaunchedApp } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, runMenu, seedDrawDoc, v1Body } from './_drawHelpers'
import { restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'

let app: LaunchedApp
let window: Page
let savedPasteboard: SavedPasteboard | null = null

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (process.platform === 'darwin') savedPasteboard = savePasteboard()
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await suppressFeatureSpotlights(window)
  await keepNoticesOutOfTheWay(window)
})

test.afterAll(async () => {
  await app?.dispose()
  if (savedPasteboard) restorePasteboard(savedPasteboard)
})

// ── Shared ───────────────────────────────────────────────────────────────────

async function seedSnippet(kind: string, name: string, body: unknown): Promise<string> {
  return window.evaluate(
    async ({ kind, name, body }) => {
      const api = (window as unknown as { api: { snippets: { create: (d: unknown) => Promise<{ ok: boolean; snippet?: { id: string }; error?: string }> } } }).api
      const res = await api.snippets.create({ kind, name, body, scope: 'personal' })
      if (!res.ok || !res.snippet) throw new Error(res.error ?? 'not saved')
      return res.snippet.id
    },
    { kind, name, body }
  )
}

async function insertDuplicateFromLibrary(name: string): Promise<void> {
  const library = window.locator('[data-testid="snippet-library"]')
  await expect(library).toBeVisible({ timeout: 5_000 })
  const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: name })
  await expect(row).toBeVisible()
  await row.locator('[data-testid="snippet-insert-duplicate"]').click()
  await expect(library).toBeHidden({ timeout: 5_000 })
}

// ── PlexiiDiagrams ───────────────────────────────────────────────────────────

interface MapNode {
  id: string
  shape?: string
  cells?: string[][]
}

const SEED_MAP = {
  version: 1,
  nodes: [{ id: 'seed-a', x: 80, y: 120, label: 'Start', shape: 'process', color: '#2563eb' }],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 }
}

async function createSeededMap(title: string): Promise<string> {
  const id = await window.evaluate(
    async ({ t, body }) => {
      const w = window as unknown as {
        api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }
        __fbView?: { getState: () => { goDocument: (id: string) => void } }
      }
      const d = await w.api.documents.create({ docType: 'map', title: t, body })
      w.__fbView?.getState().goDocument(d.id)
      return d.id
    },
    { t: title, body: SEED_MAP }
  )
  await expect(window.locator('[data-testid="diagram-editor"]')).toBeVisible({ timeout: 12_000 })
  await expect(window.locator('.react-flow__node')).toHaveCount(1, { timeout: 8_000 })
  return id
}

async function mapNodes(id: string): Promise<MapNode[]> {
  return window.evaluate(async (docId: string) => {
    const api = (window as unknown as { api: { documents: { get: (id: string) => Promise<{ body: unknown } | null> } } }).api
    const doc = await api.documents.get(docId)
    return ((doc?.body ?? {}) as { nodes?: MapNode[] }).nodes ?? []
  }, id)
}

async function waitForTable(id: string): Promise<MapNode> {
  let found: MapNode | undefined
  await expect
    .poll(
      async () => {
        found = (await mapNodes(id)).find((n) => n.id !== 'seed-a' && typeof n.shape === 'string' && n.shape.startsWith('table'))
        return !!found
      },
      { timeout: 10_000 }
    )
    .toBe(true)
  return found!
}

async function bareCanvasPoint(): Promise<{ x: number; y: number }> {
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

async function diagramMenu(menu: 'edit' | 'insert', label: string): Promise<void> {
  await window.locator(`[data-testid="draw-menubar-${menu}"]`).click()
  await window.locator(`[data-testid="draw-menubar-${menu}-list"]`).getByText(label, { exact: true }).click()
}

test('AG-1 a sheet snippet into a diagram: a table shape of computed values, said to be converted', async () => {
  test.setTimeout(90_000)
  await seedSnippet('sheet', 'Pens total', { kind: 'sheet', rows: [['Item', 'Qty', 'Total'], ['Pens', '2', '=B2*3']], origin: { r: 0, c: 0 } })
  const id = await createSeededMap('AG-1 map')
  const spot = await bareCanvasPoint()
  await window.mouse.click(spot.x, spot.y)

  await diagramMenu('insert', 'Insert snippet…')
  await insertDuplicateFromLibrary('Pens total')

  const table = await waitForTable(id)
  expect(table.shape).toBe('table-header')
  expect(table.cells).toEqual([
    ['Item', 'Qty', 'Total'],
    ['Pens', '2', '6']
  ])
  await expect(window.locator('[data-testid="notice-toast"]')).toContainText('Formulas become their values.', { timeout: 5_000 })
})

test('AG-2 a PlexiiCells range copied and pasted into a diagram lands as a table shape', async () => {
  test.setTimeout(120_000)
  // A new spreadsheet with a 2 × 2 block.
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-sheets"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-sheets"]').click()
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
  const cell = (r: number, c: number) => window.locator(`[data-testid="cell-${r}-${c}"]`)
  const enter = async (r: number, c: number, v: string): Promise<void> => {
    await cell(r, c).click()
    await window.keyboard.type(v)
    await window.keyboard.press('Enter')
  }
  await enter(0, 0, 'Item')
  await enter(0, 1, 'Qty')
  await enter(1, 0, 'Pens')
  await enter(1, 1, '2')
  await expect.poll(async () => ((await cell(1, 1).textContent()) ?? '').trim()).toBe('2')

  // Select A1:B2 and copy with Cells' own ⌘C.
  await cell(0, 0).click()
  await cell(1, 1).click({ modifiers: ['Shift'] })
  await window.keyboard.press('Meta+c')
  await expect
    .poll(async () => app.app.evaluate(async ({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toBe('Item\tQty\nPens\t2')

  // Paste into a diagram.
  const id = await createSeededMap('AG-2 map')
  const spot = await bareCanvasPoint()
  await window.mouse.click(spot.x, spot.y)
  await window.keyboard.press('Meta+v')

  const table = await waitForTable(id)
  expect(table.shape).toBe('table-header')
  expect(table.cells).toEqual([
    ['Item', 'Qty'],
    ['Pens', '2']
  ])
  // A table, not one note per line (Diagrams' own text paste).
  const nodes = await mapNodes(id)
  expect(nodes.filter((n) => n.shape === 'note' || n.shape === 'process').map((n) => n.id)).toEqual(['seed-a'])
})

// ── PlexiiDraw ───────────────────────────────────────────────────────────────

type DrawNode = { id: string; type: string; assetId?: string; children?: DrawNode[] }
type DrawBody = { layers?: Array<{ kind: string; objects?: DrawNode[] }>; assets?: Record<string, { dataUrl?: string }> }

function drawObjects(raw: unknown): DrawNode[] {
  return ((raw as DrawBody).layers ?? []).filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}

function deepTypes(nodes: DrawNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    out.push(n.type)
    if (n.children) deepTypes(n.children, out)
  }
  return out
}

async function storedNew(id: string, existing: string[]): Promise<{ added: DrawNode[]; raw: unknown }> {
  let added: DrawNode[] = []
  let raw: unknown = null
  await expect
    .poll(
      async () => {
        raw = (await readStored(window, id)).raw
        added = drawObjects(raw).filter((o) => !existing.includes(o.id))
        return added.length
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0)
  return { added, raw }
}

test('AW-3 a diagram snippet into a drawing: editable vectors, connectors said to become lines', async () => {
  test.setTimeout(90_000)
  await seedSnippet('diagram', 'Approval flow', {
    kind: 'diagram',
    nodes: [
      { id: 'a', x: 0, y: 0, label: 'Submit', shape: 'process', color: '#2563eb', width: 140, height: 60 },
      { id: 'b', x: 240, y: 0, label: 'Approve', shape: 'process', color: '#2563eb', width: 140, height: 60 }
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }]
  })
  const id = await seedDrawDoc(window, v1Body([rectObject('existing', 20, 20, 40, 40)]), 'AW-3 drawing')
  await openDocument(window, id)

  await runMenu(window, 'edit', 'Insert snippet')
  await insertDuplicateFromLibrary('Approval flow')

  const { added } = await storedNew(id, ['existing'])
  // Editable vectors: not one picture of the diagram.
  expect(added.some((o) => o.type === 'image')).toBe(false)
  const types = deepTypes(added)
  expect(types).toContain('path')
  expect(types.filter((t) => t === 'image')).toEqual([])
  await expect(window.locator('[data-testid="notice-toast"]')).toContainText('Connectors become plain lines.', { timeout: 5_000 })
})

test('AW-4 a Deck text box copied and pasted into a drawing lands as one picture, not its words', async () => {
  test.setTimeout(120_000)
  // A blank deck with one text box.
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
  await window.locator('[data-testid="slides-menubar-insert"]').click()
  await window.locator('[data-testid="slides-menubar-insert-list"]').getByRole('button', { name: /^Text box/ }).click()
  const el = window.locator('[data-testid="slide-element"]')
  await expect(el).toHaveCount(1)

  // Out of text editing, then select the box and copy it with Deck's own ⌘C.
  await window.keyboard.press('Escape')
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // Select the box: a click on it (its own drag wrapper takes the pointer),
  // proven on the Arrange tab, whose Delete is enabled only with a selection.
  await el.first().click({ force: true })
  await selectBarTab(window, 'slides-toolbar', 'arrange')
  await expect(window.locator('[data-testid="slides-el-delete"]')).toBeEnabled({ timeout: 3_000 })
  await window.keyboard.press('Meta+c')
  // The element clip is on the pasteboard (Chromium's web custom data).
  await expect
    .poll(
      async () =>
        app.app.evaluate(async ({ clipboard }) => {
          const items = await clipboard.read()
          return items.some((i) => i.types.some((t) => t.includes('org.chromium.web-custom-data')))
        }),
      { timeout: 5_000 }
    )
    .toBe(true)

  // Paste into a drawing.
  const id = await seedDrawDoc(window, v1Body([rectObject('existing', 20, 20, 40, 40)]), 'AW-4 drawing')
  await openDocument(window, id)
  const stage = window.locator('[data-testid="draw-stage"]')
  const box = (await stage.boundingBox())!
  await window.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8)
  await window.keyboard.press('Meta+v')

  const { added, raw } = await storedNew(id, ['existing'])
  expect(added).toHaveLength(1)
  expect(added[0].type).toBe('image')
  const asset = (raw as DrawBody).assets?.[added[0].assetId ?? '']
  expect(asset?.dataUrl?.startsWith('data:image/svg+xml')).toBe(true)
})
