/**
 * E2E regression tests for the Phase 0 audit bugs that need the real app:
 * the Edit menu's Select all, ⌘/Ctrl-wheel zoom, live-shape node editing and
 * artboard resizing over painted pixels. Each one failed on the base build.
 * State is read back from the main process or measured in the DOM, never
 * eyeballed.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { dragOnStage, keepNoticesOutOfTheWay, openDocument, readStored, rectObject, runMenu, seedDrawDoc, stagePoint, v1Body, waitForSave } from './_drawHelpers'

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

type StoredObject = { id: string; type: string; shapeKind?: string; sides?: number; path?: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }
function objectsOf(raw: unknown): StoredObject[] {
  const layers = (raw as { layers: Array<{ kind: string; objects?: StoredObject[] }> }).layers
  return layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}
function minX(o: StoredObject): number {
  return Math.min(...(o.path?.subpaths[0].nodes.map((n) => n.x) ?? [NaN]))
}

test('P0-1 Edit › Select all then Align left never moves a locked object', async () => {
  const id = await seedDrawDoc(
    window,
    v1Body([rectObject('free', 300, 100, 80, 80), rectObject('locked', 500, 300, 80, 80, { locked: true }), rectObject('other', 150, 400, 80, 80)])
  )
  await openDocument(window, id)
  await runMenu(window, 'edit', 'Select all')
  await window.locator('[data-testid="draw-align-left"]').click()
  await waitForSave(window)
  const objs = objectsOf((await readStored(window, id)).raw)
  expect(minX(objs.find((o) => o.id === 'locked')!)).toBe(500)
  // The unlocked ones really were aligned (to the leftmost of them).
  expect(minX(objs.find((o) => o.id === 'free')!)).toBe(150)
})

test('P0-2 ⌘/Ctrl-wheel zooms about the pointer', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 100, 100, 200, 200)], { width: 1600, height: 1200 }))
  await openDocument(window, id)
  // Zoom in with the buttons until the artboard is larger than the window, so
  // there is room to scroll and the anchor can be held exactly.
  for (let i = 0; i < 6; i++) await window.locator('button[title="Zoom in"]').click()
  const scroller = await window.locator('[data-testid="draw-canvas-scroll"]').boundingBox()
  if (!scroller) throw new Error('no canvas')
  const pointer = { x: scroller.x + scroller.width * 0.7, y: scroller.y + scroller.height * 0.6 }
  const docUnder = async (): Promise<{ x: number; y: number }> => {
    const box = await window.locator('[data-testid="draw-stage"]').boundingBox()
    if (!box) throw new Error('no stage')
    const k = box.width / 1600
    return { x: (pointer.x - box.x) / k, y: (pointer.y - box.y) / k }
  }
  await window.mouse.move(pointer.x, pointer.y)
  const before = await docUnder()
  await window.keyboard.down('Control')
  await window.mouse.wheel(0, -100)
  await window.keyboard.up('Control')
  await expect.poll(async () => (await window.locator('[data-testid="draw-zoom"]').textContent()) ?? '').not.toBe('')
  await window.waitForTimeout(300)
  const after = await docUnder()
  expect(Math.abs(after.x - before.x)).toBeLessThan(2)
  expect(Math.abs(after.y - before.y)).toBeLessThan(2)
})

test('P0-3 dragging a live star\'s point turns it into a path, so Points can no longer undo the edit', async () => {
  const star = {
    id: 'star',
    type: 'path',
    shapeKind: 'star',
    sides: 5,
    innerRatio: 0.5,
    fill: { type: 'solid', color: '#f59e0b' },
    path: {
      subpaths: [
        {
          closed: true,
          nodes: [
            { x: 400, y: 100 },
            { x: 459, y: 219 },
            { x: 590, y: 238 },
            { x: 495, y: 331 },
            { x: 518, y: 462 },
            { x: 400, y: 400 },
            { x: 282, y: 462 },
            { x: 305, y: 331 },
            { x: 210, y: 238 },
            { x: 341, y: 219 }
          ]
        }
      ]
    }
  }
  const id = await seedDrawDoc(window, v1Body([star]))
  await openDocument(window, id)
  // Select it, then switch to Edit points and drag the top point up.
  const centre = await stagePoint(window, 800, { x: 400, y: 300 })
  await window.mouse.click(centre.x, centre.y)
  await expect(window.locator('[data-testid="draw-shape-sides"]')).toBeVisible()
  await window.locator('[data-testid="draw-tool-node"]').click()
  const top = await stagePoint(window, 800, { x: 400, y: 100 })
  const up = await stagePoint(window, 800, { x: 400, y: 40 })
  await window.mouse.move(top.x, top.y)
  await window.mouse.down()
  await window.mouse.move(top.x, (top.y + up.y) / 2)
  await window.mouse.move(up.x, up.y)
  await window.mouse.up()
  await waitForSave(window)

  const o = objectsOf((await readStored(window, id)).raw)[0]
  expect(o.shapeKind).toBe('path')
  expect(o.sides).toBeUndefined()
  expect(o.path!.subpaths[0].nodes[0].y).toBeLessThan(70)
  // The Shape section that offered Points is gone: there is nothing left to regenerate.
  await window.locator('[data-testid="draw-tool-select"]').click()
  await expect(window.locator('[data-testid="draw-shape-sides"]')).toHaveCount(0)
})

test('P0-4 resizing the artboard keeps painted pixels where they were, at their size', async () => {
  // A paint layer holding one opaque 20 x 20 red square at (100, 100) on a 400 x 300 artboard.
  const src = await window.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 400
    c.height = 300
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(100, 100, 20, 20)
    return c.toDataURL('image/png')
  })
  const body = {
    ...v1Body([], { width: 400, height: 300 }),
    activeLayerId: 'P1',
    layers: [
      { id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] },
      { id: 'P1', kind: 'raster', name: 'Paint', visible: true, locked: false, opacity: 1, blend: 'normal', src }
    ]
  }
  const id = await seedDrawDoc(window, body)
  await openDocument(window, id)
  await runMenu(window, 'document', 'Artboard size…')
  await window.locator('[data-testid="draw-size-width"]').fill('800')
  await window.locator('[data-testid="draw-size-height"]').fill('300')
  await window.locator('[data-testid="draw-size-apply"]').click()

  const canvas = window.locator('[data-testid="draw-raster-P1"]')
  await expect(canvas).toHaveAttribute('width', '800')
  // Measure the painted pixels on the live canvas: same place, same size.
  await expect
    .poll(async () =>
      canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        let minX = Infinity
        let maxX = -Infinity
        for (let y = 0; y < c.height; y++)
          for (let x = 0; x < c.width; x++)
            if (d[(y * c.width + x) * 4 + 3] > 0) {
              minX = Math.min(minX, x)
              maxX = Math.max(maxX, x)
            }
        return `${minX}-${maxX}`
      })
    )
    .toBe('100-119')
  // And the stored layer was re-laid at the new size, not left to be stretched later.
  await waitForSave(window)
  const stored = (await readStored(window, id)).raw as { width: number; layers: Array<{ id: string; src?: string }> }
  expect(stored.width).toBe(800)
  const dims = await window.evaluate(async (s) => {
    const img = new Image()
    img.src = s
    await img.decode()
    return `${img.naturalWidth}x${img.naturalHeight}`
  }, stored.layers.find((l) => l.id === 'P1')!.src!)
  expect(dims).toBe('800x300')
})

test('P0-5 the artboard can grow around its centre: art and pixels move together', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 10, 10, 50, 50)], { width: 400, height: 300 }))
  await openDocument(window, id)
  await runMenu(window, 'document', 'Artboard size…')
  await window.locator('[data-testid="draw-size-width"]').fill('600')
  await window.locator('[data-testid="draw-size-height"]').fill('500')
  await window.locator('[data-testid="draw-size-anchor-c"]').click()
  await window.locator('[data-testid="draw-size-apply"]').click()
  await waitForSave(window)
  const o = objectsOf((await readStored(window, id)).raw)[0]
  expect(minX(o)).toBe(110)
  // Undo puts the page and the art back in one step.
  await window.keyboard.press('Meta+z')
  await waitForSave(window)
  const back = (await readStored(window, id)).raw as { width: number }
  expect(back.width).toBe(400)
})

test('P0-6 a drag on the canvas still draws (sanity: the fixes did not break drawing)', async () => {
  const id = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, id)
  await window.locator('[data-testid="draw-tool-rect"]').click()
  await dragOnStage(window, { x: 40, y: 40 }, { x: 160, y: 140 })
  await expect(window.locator('[data-testid^="draw-vector-"] path')).toHaveCount(1)
})
