/**
 * PlexiiDraw editor parity: drives every tool, the keyboard, the menus, the
 * inspector and the layers panel in the real app, reading results back from
 * the stored document and the DOM.
 *
 * Written for the Phase 0 refactor (DrawStudio split into tool, command and
 * panel registries): this spec passes on the build BEFORE the refactor and on
 * the build after it, which is the proof that behaviour did not change. It also
 * covers the brush-provisioning and brush-preset flows that drawStudio.spec
 * DR-7b/7c only reach through the office side menu.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, runMenu, seedDrawDoc, stagePoint, v1Body, waitForSave, storedView } from './_drawHelpers'

let app: LaunchedApp
let window: Page

test.beforeAll(async () => {
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
})

test.afterAll(async () => {
  await app.dispose()
})

type Obj = { id: string; type: string; shapeKind?: string; fill?: { type: string; color?: string }; path?: { subpaths: Array<{ closed: boolean; nodes: Array<{ x: number; y: number }> }> } }
type Layer = { id: string; kind: string; visible: boolean; objects?: Obj[]; src?: string }
async function stored(id: string): Promise<{ layers: Layer[]; width: number }> {
  return storedView<{ layers: Layer[] }>((await readStored(window, id)).raw)
}
const objectsOf = (b: { layers: Layer[] }): Obj[] => b.layers.flatMap((l) => l.objects ?? [])

async function at(p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return stagePoint(window, 800, p)
}
async function click(x: number, y: number): Promise<void> {
  const s = await at({ x, y })
  await window.mouse.click(s.x, s.y)
}
async function drag(from: [number, number], to: [number, number], steps = 4): Promise<void> {
  const a = await at({ x: from[0], y: from[1] })
  const b = await at({ x: to[0], y: to[1] })
  await window.mouse.move(a.x, a.y)
  await window.mouse.down()
  for (let i = 1; i <= steps; i++) await window.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps)
  await window.mouse.up()
}
async function paintedPixels(layerTestId: string): Promise<number> {
  return window.locator(`[data-testid="${layerTestId}"]`).evaluate((el) => {
    const c = el as HTMLCanvasElement
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
    return n
  })
}

test('EP-1 the toolbox offers every tool, in order, with its shortcut (Illustrator\'s since WP-KEYS)', async () => {
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  const titles = await window.locator('[data-testid^="draw-tool-"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-testid')}=${e.getAttribute('title')}`))
  expect(titles).toEqual([
    'draw-tool-select=Select (V) — double-click for options',
    // WP-OBJ: Group Selection has no default letter, as in Illustrator.
    'draw-tool-groupSelect=Group selection',
    'draw-tool-direct=Direct Selection (A)',
    'draw-tool-lasso=Lasso (Q)',
    'draw-tool-pen=Pen (P)',
    'draw-tool-curvature=Curvature (⇧`)',
    'draw-tool-addAnchor=Add Anchor Point (+)',
    'draw-tool-deleteAnchor=Delete Anchor Point (-)',
    'draw-tool-anchorConvert=Anchor Point (⇧C)',
    'draw-tool-scissors=Scissors (C)',
    'draw-tool-knife=Knife',
    'draw-tool-pencil=Pencil (N)',
    'draw-tool-smooth=Smooth',
    'draw-tool-pathEraser=Path Eraser',
    'draw-tool-join=Join',
    'draw-tool-rect=Rectangle (M)',
    'draw-tool-roundRect=Rounded rectangle',
    'draw-tool-ellipse=Ellipse (L)',
    'draw-tool-polygon=Polygon',
    'draw-tool-star=Star',
    'draw-tool-line=Line (\\)',
    'draw-tool-text=Type (T)',
    'draw-tool-rotate=Rotate (R) — double-click for options',
    'draw-tool-reflect=Reflect (O) — double-click for options',
    'draw-tool-scale=Scale (S) — double-click for options',
    'draw-tool-shear=Shear — double-click for options',
    'draw-tool-reshape=Reshape',
    'draw-tool-freeTransform=Free Transform (E)',
    'draw-tool-brush=Brush (B)',
    'draw-tool-eraser=Eraser (⇧E)',
    'draw-tool-bucket=Paint bucket (K)',
    'draw-tool-eyedropper=Eyedropper (I)',
    'draw-tool-hand=Pan (H)'
  ])
})

test('EP-2 the menus list the same items, with the same enabled states', async () => {
  await openDocument(window, await seedDrawDoc(window, v1Body([rectObject('a', 10, 10, 50, 50)])))
  const read = async (menu: string): Promise<string[]> => {
    await window.locator(`[data-testid="draw-studio-menubar-${menu}"]`).click()
    const items = await window.locator(`[data-testid="draw-studio-menubar-${menu}-list"] > button`).evaluateAll((els) =>
      els.map((e) => `${(e.querySelector('span.flex-1')?.textContent ?? '').trim()}${(e as HTMLButtonElement).disabled ? ' (off)' : ''}`)
    )
    await window.keyboard.press('Escape')
    await expect(window.locator(`[data-testid="draw-studio-menubar-${menu}-list"]`)).toHaveCount(0)
    return items
  }
  // WP-CLIPBOARD's clipboard group (Illustrator's order), then Select all / Deselect, then WP-KEYS' dialog.
  expect(await read('edit')).toEqual([
    'Undo (off)',
    'Redo (off)',
    'Cut (off)',
    'Copy (off)',
    'Paste',
    'Paste in Front',
    'Paste in Back',
    'Paste in Place',
    'Paste on All Artboards',
    'Duplicate (off)',
    'Delete (off)',
    'Select all',
    'Deselect (off)',
    'Keyboard shortcuts…'
  ])
  expect(await read('layer')).toEqual(['New vector layer', 'New paint layer'])
  expect(await read('view')).toEqual(['Fit to window', 'Zoom to 100%', 'Grid', 'Snap to edges'])
})

test('EP-3 shapes, Pathfinder, undo/redo and Delete through the keyboard', async () => {
  const id = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, id)
  await window.keyboard.press('m')
  await drag([100, 100], [300, 250])
  await window.keyboard.press('l')
  await drag([200, 150], [400, 350])
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(2)
  await window.keyboard.press('Meta+a')
  await window.locator('[data-testid="draw-bool-union"]').click()
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(1)
  await window.keyboard.press('Meta+z')
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(2)
  await window.keyboard.press('Meta+Shift+z')
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(1)
  // ⌘D is Transform Again now (Illustrator); Duplicate stays in the Edit menu.
  await runMenu(window, 'edit', 'Duplicate')
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(2)
  await window.keyboard.press('Delete')
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(1)
  await waitForSave(window)
  expect(objectsOf(await stored(id))).toHaveLength(1)
})

test('EP-4 arrows nudge the selection; Shift-arrows nudge by 10', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 50, 50)]))
  await openDocument(window, id)
  await click(120, 120)
  await window.keyboard.press('ArrowRight')
  await window.keyboard.press('Shift+ArrowDown')
  await waitForSave(window)
  const n = objectsOf(await stored(id))[0].path!.subpaths[0].nodes[0]
  expect(n).toMatchObject({ x: 101, y: 110 })
})

test('EP-5 the pen closes a path by clicking its first point, and Enter finishes an open one', async () => {
  const id = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, id)
  await window.keyboard.press('p')
  await click(100, 100)
  await click(300, 100)
  await click(300, 300)
  await click(101, 101)
  await click(500, 100)
  await click(600, 200)
  await window.keyboard.press('Enter')
  await waitForSave(window)
  const objs = objectsOf(await stored(id))
  expect(objs.map((o) => [o.shapeKind, o.path!.subpaths[0].closed, o.path!.subpaths[0].nodes.length])).toEqual([
    ['pen', true, 3],
    ['pen', false, 2]
  ])
})

test('EP-6 the pencil draws one smoothed path; the type tool makes text you can type', async () => {
  const id = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, id)
  await window.keyboard.press('n')
  await drag([50, 400], [400, 450], 12)
  await window.keyboard.press('t')
  await click(100, 100)
  const editor = window.locator('[data-testid="draw-text-editor"]')
  await expect(editor).toBeVisible()
  await editor.fill('Parity')
  await click(700, 550)
  await expect(editor).toHaveCount(0)
  await waitForSave(window)
  const objs = objectsOf(await stored(id))
  expect(objs.map((o) => o.type)).toEqual(['path', 'text'])
  expect(objs[0].shapeKind).toBe('pencil')
  expect((objs[1] as unknown as { text: string }).text).toBe('Parity')
})

test('EP-7 Edit points moves an anchor of the selected path', async () => {
  const id = await seedDrawDoc(window, v1Body([{ ...rectObject('a', 200, 200, 200, 100), shapeKind: 'path' }]))
  await openDocument(window, id)
  await click(300, 250)
  await window.keyboard.press('a')
  await drag([200, 200], [150, 120])
  await waitForSave(window)
  // Screen pixels are whole numbers on a fitted (scaled-down) artboard, so the
  // point lands within a few artboard pixels of the target.
  const n = objectsOf(await stored(id))[0].path!.subpaths[0].nodes[0]
  expect(Math.abs(n.x - 150)).toBeLessThan(6)
  expect(Math.abs(n.y - 120)).toBeLessThan(6)
})

test('EP-8 the brush with no paint layer makes one, then paints; every preset leaves a mark', async () => {
  const id = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, id)
  await window.keyboard.press('b')
  await drag([60, 80], [240, 140])
  const raster = window.locator('[data-testid^="draw-raster-"]')
  await expect(raster).toHaveCount(1, { timeout: 5_000 })
  const testId = (await raster.getAttribute('data-testid'))!
  await drag([60, 160], [240, 220])
  expect(await paintedPixels(testId)).toBeGreaterThan(0)
  let y = 260
  for (const preset of ['round-soft', 'airbrush', 'pencil', 'ink', 'calligraphy', 'marker', 'charcoal', 'chalk', 'spray', 'watercolour', 'oil']) {
    await window.locator(`[data-testid="draw-brush-${preset}"]`).click()
    const before = await paintedPixels(testId)
    await drag([40, y], [700, y + 6], 6)
    expect(await paintedPixels(testId), preset).toBeGreaterThan(before)
    y += 24
  }
  await waitForSave(window)
  const layers = (await stored(id)).layers
  expect(layers.map((l) => l.kind)).toEqual(['vector', 'raster'])
  expect(layers[1].src?.startsWith('data:image/png')).toBe(true)
})

test('EP-9 the eraser removes pixels and the bucket fills; the eyedropper picks a shape colour', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 600, 400, 100, 100, { fill: { type: 'solid', color: '#ff8800' } })]))
  await openDocument(window, id)
  await window.locator('[data-testid="draw-add-raster-layer"]').click()
  const raster = window.locator('[data-testid^="draw-raster-"]')
  const testId = (await raster.getAttribute('data-testid'))!
  await window.keyboard.press('k')
  await click(50, 50)
  const full = await paintedPixels(testId)
  expect(full).toBeGreaterThan(400 * 300)
  await window.keyboard.press('Shift+E')
  await drag([20, 300], [780, 300], 10)
  expect(await paintedPixels(testId)).toBeLessThan(full)
  await window.keyboard.press('i')
  await click(650, 450)
  await expect(window.locator('[data-testid="draw-status"]')).toContainText('Picked #ff8800')
})

test('EP-10 the layers panel adds, hides and shows layers; the inspector recolours', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 100, 100)]))
  await openDocument(window, id)
  await window.locator('[data-testid="draw-add-vector-layer"]').click()
  await expect(window.locator('[data-testid^="draw-layer-row-"]')).toHaveCount(2)
  const bottom = window.locator('[data-testid^="draw-layer-row-"]').last()
  await bottom.locator('button').first().click()
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(0)
  await bottom.locator('button').first().click()
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(1)
  await click(150, 150)
  await window.locator('[data-testid="draw-fill-color"]').fill('#123456')
  await waitForSave(window)
  expect(objectsOf(await stored(id))[0].fill).toEqual({ type: 'solid', color: '#123456' })
})

test('EP-11 View: grid and snap toggle from the menu; zoom buttons change the zoom', async () => {
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  const zoom = window.locator('[data-testid="draw-zoom"]')
  const before = await zoom.textContent()
  await window.locator('button[title="Zoom in"]').click()
  await expect(zoom).not.toHaveText(before ?? '')
  await runMenu(window, 'view', 'Zoom to 100%')
  await expect(zoom).toHaveText('100%')
  await runMenu(window, 'view', 'Grid')
  await expect(window.locator('[data-testid="draw-overlay"] g[opacity="0.25"]')).toHaveCount(1)
  await expect(window.locator('[data-testid="draw-snap-toggle"]')).toHaveClass(/bg-accent/)
  await runMenu(window, 'view', 'Snap to edges')
  await expect(window.locator('[data-testid="draw-snap-toggle"]')).not.toHaveClass(/bg-accent/)
})
