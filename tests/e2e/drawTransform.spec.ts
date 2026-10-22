/**
 * E2E for WP-TRANSFORM: the Transform panel, the Reflect tool's options
 * dialog, Alt-drag copy with Transform Again (⌘D), and the Align panel's key
 * object. Every assertion reads the stored document back from the main
 * process, plus one visible consequence in the DOM. Throwaway profile only.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { barTab, keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, stagePoint, v1Body, waitForSave } from './_drawHelpers'

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

type Node = { x: number; y: number }
type StoredObject = { id: string; type: string; path?: { subpaths: Array<{ nodes: Node[] }> } }

function objectsOf(raw: unknown): StoredObject[] {
  const layers = (raw as { layers: Array<{ kind: string; objects?: StoredObject[] }> }).layers
  return layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}

function bounds(o: StoredObject): { x: number; y: number; w: number; h: number } {
  const ns = o.path!.subpaths.flatMap((s) => s.nodes)
  const xs = ns.map((n) => n.x)
  const ys = ns.map((n) => n.y)
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/** Click an artboard point with the current tool. */
async function clickAt(p: { x: number; y: number }, modifiers: Array<'Alt' | 'Shift'> = []): Promise<void> {
  const s = await stagePoint(window, 800, p)
  for (const m of modifiers) await window.keyboard.down(m)
  await window.mouse.click(s.x, s.y)
  for (const m of modifiers) await window.keyboard.up(m)
}

test('TR-1 typing W = 200 in the Object tab\'s Transform fields makes the object 200 wide', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 100, 100, 100, 50)]))
  await openDocument(window, id)
  await clickAt({ x: 150, y: 125 })
  await barTab(window, 'object')
  const w = window.locator('[data-testid="draw-transform-w"]')
  await expect(w).toHaveValue('100 px')
  await w.fill('200')
  await w.press('Enter')
  await expect(w).toHaveValue('200 px')
  await waitForSave(window)
  const r = objectsOf((await readStored(window, id)).raw).find((o) => o.id === 'r')!
  expect(bounds(r).w).toBeCloseTo(200, 6)
  expect(bounds(r).h).toBeCloseTo(50, 6)
  // The default reference point is the centre: the middle stayed put.
  expect(bounds(r).x + bounds(r).w / 2).toBeCloseTo(150, 6)
})

test('TR-2 reflecting twice with the Reflect tool\'s dialog gives back the identical path', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 300, 200, 120, 40)]))
  await openDocument(window, id)
  await clickAt({ x: 360, y: 220 })
  const original = objectsOf((await readStored(window, id)).raw).find((o) => o.id === 'r')!.path!.subpaths[0].nodes
  await window.locator('[data-testid="draw-stage"]').hover()
  await window.keyboard.press('o')
  await expect(window.locator('[data-testid="draw-tool-reflect"]')).toHaveAttribute('aria-pressed', 'true')
  for (let i = 0; i < 2; i++) {
    await window.keyboard.press('Enter')
    await expect(window.locator('[data-testid="draw-reflect-dialog"]')).toBeVisible()
    await window.locator('[data-testid="draw-reflect-axis-vertical"]').check()
    await window.locator('[data-testid="draw-reflect-dialog-ok"]').click()
    await expect(window.locator('[data-testid="draw-reflect-dialog"]')).toHaveCount(0)
    await waitForSave(window)
    const nodes = objectsOf((await readStored(window, id)).raw).find((o) => o.id === 'r')!.path!.subpaths[0].nodes
    if (i === 0) expect(nodes.map((n) => Math.round(n.x))).not.toEqual(original.map((n) => Math.round(n.x)))
    else nodes.forEach((n, j) => {
      expect(n.x).toBeCloseTo(original[j].x, 6)
      expect(n.y).toBeCloseTo(original[j].y, 6)
    })
  }
})

test('TR-3 Alt-drag moves a copy, and ⌘D (Transform Again) repeats it', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 100, 300, 40, 40)]))
  await openDocument(window, id)
  await window.keyboard.press('v')
  const from = await stagePoint(window, 800, { x: 120, y: 320 })
  const to = await stagePoint(window, 800, { x: 220, y: 320 })
  await window.mouse.move(from.x, from.y)
  await window.keyboard.down('Alt')
  await window.mouse.down()
  await window.mouse.move((from.x + to.x) / 2, from.y)
  await window.mouse.move(to.x, to.y)
  await window.mouse.up()
  await window.keyboard.up('Alt')
  await waitForSave(window)
  expect(objectsOf((await readStored(window, id)).raw)).toHaveLength(2)
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+d' : 'Control+d')
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  expect(objs).toHaveLength(3)
  const xs = objs.map((o) => bounds(o).x).sort((a, b) => a - b)
  expect(xs[0]).toBeCloseTo(100, 0)
  // The copies are evenly spaced by the drag's distance (snapping may round it).
  expect(xs[2] - xs[1]).toBeCloseTo(xs[1] - xs[0], 3)
  expect(xs[1] - xs[0]).toBeGreaterThan(50)
})

test('TR-4 Align tab: clicking a selected object makes it the key object, which stays put', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 40, 40), rectObject('b', 300, 200, 60, 60), rectObject('c', 500, 150, 40, 40)]))
  await openDocument(window, id)
  await window.keyboard.press('v')
  await clickAt({ x: 120, y: 120 })
  await clickAt({ x: 330, y: 230 }, ['Shift'])
  await clickAt({ x: 520, y: 170 }, ['Shift'])
  await barTab(window, 'align')
  await window.locator('[data-testid="draw-align-to"]').selectOption('key')
  await clickAt({ x: 330, y: 230 })
  await expect(window.locator('[data-testid="draw-align-key"]')).toHaveCount(1)
  await window.locator('[data-testid="draw-alignpanel-top"]').click()
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  expect(objs.map((o) => Math.round(bounds(o).y))).toEqual([200, 200, 200])
  expect(Math.round(bounds(objs.find((o) => o.id === 'b')!).x)).toBe(300)
})
