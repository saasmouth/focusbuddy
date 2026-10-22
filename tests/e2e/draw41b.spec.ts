/**
 * PlexiiDraw 4.3.41 (draw-41b) end to end: Zoom to Selection, paint layers
 * that follow their artboard, Convert to Artboards, Show/Hide Artboards and
 * the unlimited pasteboard -- each driven as a person does (menus, keys, the
 * bar, the canvas) and read back from the screen and the stored drawing.
 * Throwaway profile (launchApp), PLEXI_APP=preview3. Nothing here touches the
 * system clipboard.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, openDrawPanel, readStored, rectObject, runMenu, seedDrawDoc, stagePoint, v1Body } from './_drawHelpers'

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

async function zoomPct(): Promise<number> {
  return Number(((await t('draw-zoom').textContent()) ?? '').replace('%', ''))
}

/** The selection frame's on-screen box (the overlay's first rect). */
async function selectionOnScreen(): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await window.locator('[data-testid="draw-selection"] rect').first().boundingBox()
  if (!b) throw new Error('no selection frame on screen')
  return b
}

test('ZS-1 Zoom to Selection: greyed with its reason until something is selected, then fits it with padding, beside a pinned panel too', async () => {
  // An 800 × 600 page with a small square near its bottom-right corner.
  const id = await seedDrawDoc(window, v1Body([rectObject('small', 640, 460, 40, 30)]), 'Zoom to selection')
  await openDocument(window, id)

  // Nothing selected: the View menu item is off and says why.
  await t('draw-studio-menubar-view').click()
  const item = window.locator('[data-testid="draw-studio-menubar-view-list"] button').filter({ hasText: 'Zoom to Selection' }).first()
  await expect(item).toBeDisabled()
  await expect(item).toContainText('select something to zoom to')
  await window.keyboard.press('Escape')
  // …and so is the zoom menu's.
  await t('draw-zoom-menu').click()
  await expect(t('draw-zoom-item-zoomToSelection')).toBeDisabled()
  await expect(t('draw-zoom-item-zoomToSelection')).toContainText('Select something to zoom to')
  await window.keyboard.press('Escape')
  await window.mouse.click(5, 5) // close the menu if Escape did not
  await expect(t('draw-zoom-menu-list')).toHaveCount(0)

  // Select the square and zoom to it from the View menu.
  const before = await zoomPct()
  const at = await stagePoint(window, 800, { x: 660, y: 475 })
  await window.mouse.click(at.x, at.y)
  await expect(window.locator('[data-testid="draw-selection"]')).toHaveCount(1)
  await runMenu(window, 'view', 'Zoom to Selection')
  await expect.poll(zoomPct).toBeGreaterThan(before * 3)

  // It fills the window, less 40 px each side, and sits in the middle of it.
  const sc = (await t('draw-canvas-scroll').boundingBox())!
  await expect
    .poll(async () => {
      const s = await selectionOnScreen()
      return Math.abs(s.x + s.width / 2 - (sc.x + sc.width / 2)) < 12 && Math.abs(s.y + s.height / 2 - (sc.y + sc.height / 2)) < 12
    })
    .toBe(true)
  const s1 = await selectionOnScreen()
  expect(Math.max(s1.width / (sc.width - 80), s1.height / (sc.height - 80))).toBeGreaterThan(0.9)
  expect(s1.x).toBeGreaterThan(sc.x + 20)
  expect(s1.x + s1.width).toBeLessThan(sc.x + sc.width - 20)

  // Pin the Layers panel: the selection is fitted into the part it leaves.
  await openDrawPanel(window, 'layers')
  await t('draw-panel-layers-pin').click()
  const panel = (await t('draw-panel-layers').boundingBox())!
  await t('draw-zoom-menu').click()
  await t('draw-zoom-item-zoomToSelection').click()
  const left = panel.x + panel.width
  await expect
    .poll(async () => {
      const s = await selectionOnScreen()
      return s.x > left && Math.abs(s.x + s.width / 2 - (left + sc.x + sc.width) / 2) < 16
    })
    .toBe(true)
  // Unpin again, for the specs after this one.
  await t('draw-panel-layers-pin').click()
  await window.keyboard.press('Escape')
})

async function artboardsMenuItem(label: string) {
  await t('draw-studio-menubar-object').click()
  await window.locator('[data-testid="draw-studio-menubar-object-list"] button').filter({ hasText: 'Artboards' }).hover()
  return window.locator('button').filter({ hasText: label }).first()
}

type Board = { id: string; name: string; x: number; y: number; w: number; h: number }
type StoredDoc = { artboards?: Board[]; layers: Array<{ kind: string; objects?: Array<{ id: string }> }> }
const storedDoc = async (id: string): Promise<StoredDoc> => (await readStored(window, id)).raw as StoredDoc

test('CA-1 Object › Artboards › Convert to Artboards: off with its reason for a non-rectangle, then the selected rectangles become artboards in one undo step', async () => {
  const ellipse = {
    id: 'oval',
    type: 'path',
    shapeKind: 'ellipse',
    path: { subpaths: [{ closed: true, nodes: [{ x: 650, y: 400, outX: 700, outY: 400 }, { x: 750, y: 450 }, { x: 650, y: 500 }, { x: 600, y: 450 }] }] },
    fill: { type: 'solid', color: '#40c057' }
  }
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 200, 150), rectObject('b', 400, 100, 150, 150), ellipse]), 'Convert to artboards')
  await openDocument(window, id)

  // Only the ellipse selected: off, saying why.
  const oval = await stagePoint(window, 800, { x: 680, y: 450 })
  await window.mouse.click(oval.x, oval.y)
  const off = await artboardsMenuItem('Convert to Artboards')
  await expect(off).toBeDisabled()
  await expect(off).toContainText('select one or more rectangles')
  await window.keyboard.press('Escape')
  await window.keyboard.press('Escape')

  // Both rectangles (and the ellipse, which is left alone).
  const a = await stagePoint(window, 800, { x: 120, y: 120 })
  const b = await stagePoint(window, 800, { x: 420, y: 120 })
  await window.keyboard.down('Shift')
  await window.mouse.click(a.x, a.y)
  await window.mouse.click(b.x, b.y)
  await window.keyboard.up('Shift')
  await (await artboardsMenuItem('Convert to Artboards')).click()
  await expect.poll(async () => ((await storedDoc(id)).artboards ?? []).map((x) => [x.name, x.x, x.y, x.w, x.h])).toEqual([
    ['Artboard 1', 0, 0, 800, 600],
    ['Artboard 2', 100, 100, 200, 150],
    ['Artboard 3', 400, 100, 150, 150]
  ])
  expect((await storedDoc(id)).layers[0].objects!.map((o) => o.id)).toEqual(['oval'])
  await expect(t('draw-status')).toContainText('Made 2 artboards: Artboard 2, Artboard 3.')

  // One undo step puts the rectangles back and takes the artboards away.
  await t('draw-undo').click()
  await expect.poll(async () => ((await storedDoc(id)).artboards ?? []).length).toBe(1)
  expect((await storedDoc(id)).layers[0].objects!.map((o) => o.id)).toEqual(['a', 'b', 'oval'])
})
