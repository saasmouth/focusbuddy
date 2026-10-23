/**
 * The rail and tab contract in the running app (SPEC §3.9, owner, 4.3.41-local.2:
 * "left side tool menus, and top settings, they should all work the same").
 *
 *  RT-1..4  the four canvas apps (Deck, Design, Diagrams, Draw), each:
 *           a rail shape places once and goes back to Select; a double-click
 *           locks it (two more placements, still armed); Esc disarms; Esc again
 *           clears the selection; the shapes flyout shows the last pick; the
 *           contextual tab appears without being selected.
 *  RT-5     every app opens on Home, even when another tab was left showing,
 *           and a collapsed ribbon stays collapsed on the next open.
 *  RT-6     Write and Cells: the rail runs Insert (Image first) → app → panels
 *           → AI; Cells' Filter on the rail is pressed exactly when the Data
 *           tab's Filter is (§3.7).
 *
 * Throwaway profile (launchApp), PLEXI_APP=preview3.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, selectBarTab } from './_helpers'
import { keepNoticesOutOfTheWay, readStored, seedDrawDoc, openDocument, storedView, v1Body, waitForSave } from './_drawHelpers'

let app: LaunchedApp
let window: Page

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
})
test.afterAll(async () => {
  await app.dispose()
})

const t = (id: string) => window.locator(`[data-testid="${id}"]`)

async function openNew(docType: string, title = 'Rails and tabs'): Promise<string> {
  return window.evaluate(
    async ({ dt, ti }) => {
      const w = window as unknown as { api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }; __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      const d = await w.api.documents.create({ docType: dt, title: ti })
      w.__fbView?.getState().goDocument(d.id)
      return d.id
    },
    { dt: docType, ti: title }
  )
}

interface CanvasApp {
  name: string
  open: () => Promise<string>
  bar: string
  rail: string
  canvas: string
  select: string
  rect: string
  ellipse: string
  /** How many things are on the page now. */
  count: (id: string) => Promise<number>
  /** A contextual tab that appears while a placed shape is selected. */
  ctxTab: string
}

const slideEls = (): Promise<number> => window.locator('[data-testid="slide-canvas"] [data-testid="slide-element"]').count()

const CANVAS: CanvasApp[] = [
  {
    name: 'Deck',
    open: () => openNew('slides'),
    bar: 'slides-toolbar',
    rail: 'slides-rail',
    canvas: '[data-testid="slide-canvas"]',
    select: 'slides-tool-select',
    rect: 'slides-tool-rect',
    ellipse: 'slides-tool-ellipse',
    count: () => slideEls(),
    ctxTab: 'shape'
  },
  {
    name: 'Design',
    open: () => openNew('design'),
    bar: 'design-toolbar',
    rail: 'design-rail',
    canvas: '[data-testid="slide-canvas"]',
    select: 'design-tool-select',
    rect: 'design-tool-rect',
    ellipse: 'design-tool-ellipse',
    count: () => slideEls(),
    // Design has no Shape tab; a selected frame shows Arrange's controls on Home. Its contextual tabs are Text and Image.
    ctxTab: ''
  },
  {
    name: 'Diagrams',
    open: () => openNew('map'),
    bar: 'diagram-toolbar',
    rail: 'diagram-rail',
    canvas: '[data-testid="diagram-canvas"]',
    select: 'diagram-tool-select',
    rect: 'diagram-tool-process',
    ellipse: 'diagram-tool-circle',
    count: () => window.locator('[data-testid="diagram-canvas"] .react-flow__node').count(),
    ctxTab: 'shape'
  },
  {
    name: 'Draw',
    open: async () => {
      const id = await seedDrawDoc(window, v1Body([]))
      await openDocument(window, id)
      return id
    },
    bar: 'draw-bar',
    rail: 'draw-toolbox',
    canvas: '[data-testid="draw-stage"]',
    select: 'draw-tool-select',
    rect: 'draw-tool-rect',
    ellipse: 'draw-tool-ellipse',
    count: async (id) => {
      await waitForSave(window)
      return storedView<{ layers: Array<{ objects?: unknown[] }> }>((await readStored(window, id)).raw).layers.flatMap((l) => l.objects ?? []).length
    },
    ctxTab: 'path'
  }
]

/** Place with the armed tool: a drag in the canvas (every app sizes on drag; Draw places only on a drag). */
async function place(c: CanvasApp, fx: number, fy: number): Promise<void> {
  const box = await window.locator(c.canvas).boundingBox()
  if (!box) throw new Error(`${c.name}: the canvas was not laid out`)
  const x = box.x + box.width * fx
  const y = box.y + box.height * fy
  await window.mouse.move(x, y)
  await window.mouse.down()
  await window.mouse.move(x + 30, y + 20, { steps: 6 })
  await window.mouse.move(x + 60, y + 40, { steps: 6 })
  await window.mouse.up()
}

const pressed = (id: string) => expect(t(id)).toHaveAttribute('aria-pressed', 'true')

for (const [i, c] of CANVAS.entries()) {
  test(`RT-${i + 1} ${c.name}: place → Select; double-click locks; Esc disarms, then deselects; the flyout shows the last shape; contextual tabs never take over`, async () => {
    const id = await c.open()
    await expect(t(c.rail)).toBeVisible({ timeout: 10_000 })
    await expect(t(`${c.bar}-tab-home`)).toHaveAttribute('aria-selected', 'true')
    const before = await c.count(id)

    // One placement, then back to Select.
    await t(c.rect).click()
    await pressed(c.rect)
    await place(c, 0.25, 0.3)
    await pressed(c.select)
    await expect.poll(() => c.count(id)).toBe(before + 1)
    // The contextual tab shows, and Home stays selected (D3).
    if (c.ctxTab) await expect(t(`${c.bar}-tab-${c.ctxTab}`)).toBeVisible()
    await expect(t(`${c.bar}-tab-home`)).toHaveAttribute('aria-selected', 'true')

    // A double-click locks the tool: two placements, still armed.
    await t(c.rect).dblclick()
    await pressed(c.rect)
    await place(c, 0.45, 0.55)
    await pressed(c.rect)
    await place(c, 0.6, 0.25)
    await pressed(c.rect)
    await expect.poll(() => c.count(id)).toBe(before + 3)

    // Esc: the armed tool goes back to Select…
    await window.locator(c.canvas).hover()
    await window.keyboard.press('Escape')
    await pressed(c.select)
    // …and with Select, a selection is cleared (the contextual tab goes with it).
    if (c.ctxTab) {
      await t(c.select).click()
      await place(c, 0.25, 0.3) // a drag with Select over the first shape selects/moves it
      await window.locator(c.canvas).hover()
      await window.keyboard.press('Escape')
      await expect(t(`${c.bar}-tab-${c.ctxTab}`)).toHaveCount(0)
    }

    // The shapes flyout shows the shape picked last.
    await t(`${c.rail}-flyout-shapes`).click()
    await t(`${c.ellipse}-flyout`).click()
    await pressed(c.ellipse)
    await window.keyboard.press('Escape')
    await pressed(c.select)
    await expect(t(c.ellipse)).toBeVisible()
    await expect(t(c.rect)).toHaveCount(0)
  })
}

test('RT-5 every app opens on Home, even when another tab was left showing; a collapsed ribbon stays collapsed', async () => {
  const apps: Array<{ name: string; open: () => Promise<unknown>; bar: string; other: string }> = [
    { name: 'Write', open: () => openNew('doc'), bar: 'doc-toolbar', other: 'layout' },
    { name: 'Cells', open: () => openNew('sheet'), bar: 'sheet-toolbar', other: 'data' },
    { name: 'Deck', open: () => openNew('slides'), bar: 'slides-toolbar', other: 'design' },
    { name: 'Design', open: () => openNew('design'), bar: 'design-toolbar', other: 'layout' },
    { name: 'Diagrams', open: () => openNew('map'), bar: 'diagram-toolbar', other: 'arrange' },
    { name: 'Draw', open: async () => openDocument(window, await seedDrawDoc(window, v1Body([]))), bar: 'draw-bar', other: 'object' }
  ]
  for (const a of apps) {
    await a.open()
    await expect(t(`${a.bar}-tab-home`), a.name).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 })
    await selectBarTab(window, a.bar, a.other)
    await t(`${a.bar}-collapse`).click()
    await expect(t(`${a.bar}-panel`), `${a.name}: collapsed`).toHaveCount(0)
    // Reopen: Home again, and still collapsed.
    await a.open()
    await expect(t(`${a.bar}-tab-home`), `${a.name}: reopened on Home`).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 })
    await expect(t(`${a.bar}-panel`), `${a.name}: collapse remembered`).toHaveCount(0)
    await t(`${a.bar}-collapse`).click()
    await expect(t(`${a.bar}-panel`)).toBeVisible()
  }
})

test('RT-6 Write and Cells rails run Insert (Image first) → app → panels → AI; Cells’ Filter on the rail follows the Data tab', async () => {
  const order = (rail: string): Promise<string[]> =>
    window.locator(`[data-testid="${rail}"] button[data-rail-role]`).evaluateAll((els) => els.map((e) => `${e.getAttribute('data-rail-role')}:${e.getAttribute('data-testid')}`))
  await openNew('doc')
  await expect(t('doc-rail')).toBeVisible({ timeout: 10_000 })
  const w = await order('doc-rail')
  expect(w[0]).toBe('image:doc-rail-image')
  expect(w[w.length - 1]).toBe('ai:doc-assistant-toggle')
  expect(w.map((s) => s.split(':')[0])).toEqual([...w.map((s) => s.split(':')[0])].sort((a, b) => RANK[a]! - RANK[b]!))

  await openNew('sheet')
  await expect(t('sheet-rail')).toBeVisible({ timeout: 10_000 })
  const c = await order('sheet-rail')
  expect(c[c.length - 1]).toBe('ai:sheet-rail-ai')
  expect(c.map((s) => s.split(':')[0])).toEqual([...c.map((s) => s.split(':')[0])].sort((a, b) => RANK[a]! - RANK[b]!))
  // The modal openers announce a dialog and point at no panel.
  await expect(t('sheet-rail-condformat')).toHaveAttribute('aria-haspopup', 'dialog')
  expect(await t('sheet-rail-condformat').getAttribute('aria-controls')).toBeNull()
  // Filter: one state, two controls.
  await window.locator('[data-testid="sheet-grid-wrap"]').click({ position: { x: 80, y: 40 } })
  await expect(t('sheet-rail-filter')).toHaveAttribute('aria-pressed', 'false')
  await t('sheet-rail-filter').click()
  await expect(t('sheet-rail-filter')).toHaveAttribute('aria-pressed', 'true')
  await selectBarTab(window, 'sheet-toolbar', 'data')
  await expect(t('sheet-filter-btn')).toHaveAttribute('aria-pressed', 'true')
  await t('sheet-filter-btn').click()
  await expect(t('sheet-rail-filter')).toHaveAttribute('aria-pressed', 'false')
})

const RANK: Record<string, number> = { select: 0, navigate: 0, hand: 0, text: 1, shape: 1, create: 1, image: 2, insert: 2, app: 3, panel: 4, ai: 5 }
