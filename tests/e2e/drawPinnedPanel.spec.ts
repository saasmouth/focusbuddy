/**
 * A pinned overlay panel (Layers) floats over the canvas's left edge. These
 * check that it never hides art without a way back, never steals or receives
 * the wrong presses, and that every way of framing or placing art keeps it
 * beside the panel, not under it:
 *
 *   PP-1 pinning while looking keeps the art you were looking at visible;
 *   PP-2 clicks and marquees beside the panel's edge go to the canvas, presses
 *        on the panel stay with the panel;
 *   PP-3 ⌘0, ⌥⌘0, Zoom to Selection and Paste all keep art beside the panel.
 *
 * Throwaway profile (launchApp), PLEXI_APP=preview3. PP-3 copies and pastes,
 * so every item and type on the real macOS pasteboard is saved first and put
 * back afterwards.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, openDrawPanel, readStored, rectObject, seedDrawDoc, stagePoint, v1Body } from './_drawHelpers'
import { restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'

let app: LaunchedApp
let window: Page
let savedPasteboard: SavedPasteboard | null = null
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  if (process.platform === 'darwin') savedPasteboard = savePasteboard()
})

test.afterAll(async () => {
  // Leave the panel unpinned for whatever runs next in this profile, and the pasteboard as it was.
  await window.locator('[data-testid="draw-panel-layers-pin"][aria-pressed="true"]').click().catch(() => undefined)
  if (savedPasteboard) restorePasteboard(savedPasteboard)
  await app.dispose()
})

const t = (id: string) => window.locator(`[data-testid="${id}"]`)

/** The panel's right edge and the canvas's box, on screen. */
async function geometry(): Promise<{ panelRight: number; canvas: { x: number; y: number; width: number; height: number } }> {
  const p = (await t('draw-panel-layers').boundingBox())!
  return { panelRight: p.x + p.width, canvas: (await t('draw-canvas-scroll').boundingBox())! }
}

/** The on-screen box of the nth path drawn on layer L1. */
async function pathBox(n = 0) {
  return (await window.locator('[data-testid="draw-vector-L1"] path').nth(n).boundingBox())!
}

async function pin(on: boolean): Promise<void> {
  await openDrawPanel(window, 'layers')
  const btn = t('draw-panel-layers-pin')
  if ((await btn.getAttribute('aria-pressed')) !== String(on)) await btn.click()
  await expect(btn).toHaveAttribute('aria-pressed', String(on))
}

/** Is a screen box wholly in the visible canvas, right of the panel? */
function besidePanel(b: { x: number; y: number; width: number; height: number }, g: Awaited<ReturnType<typeof geometry>>): boolean {
  return b.x >= g.panelRight - 1 && b.x + b.width <= g.canvas.x + g.canvas.width + 1 && b.y >= g.canvas.y - 1 && b.y + b.height <= g.canvas.y + g.canvas.height + 1
}

test('PP-1 pinning Layers while looking at art at the page’s left edge keeps that art visible beside the panel', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('left', 10, 250, 60, 60)]), 'Pin while looking')
  await openDocument(window, id)
  await t('draw-canvas-scroll').focus()
  await window.keyboard.press(`${mod}+0`)
  const before = await pathBox()
  await pin(true)
  const g = await geometry()
  // The panel covers the canvas's left edge, where the art was...
  expect(g.panelRight).toBeGreaterThan(before.x)
  // ...and pinning moved the view so the art is beside it, the same size.
  await expect.poll(async () => besidePanel(await pathBox(), g)).toBe(true)
  const after = await pathBox()
  expect(Math.abs(after.width - before.width)).toBeLessThan(1)
  // The view did not keep drifting (the inset does not feed back into itself).
  await window.waitForTimeout(400)
  expect(Math.abs((await pathBox()).x - after.x)).toBeLessThan(1)
  // Unpinning gives the room back.
  await pin(false)
  await window.keyboard.press('Escape')
  await expect.poll(async () => Math.abs((await pathBox()).x - before.x)).toBeLessThan(2)
})

test('PP-2 beside the pinned panel, clicks and marquees reach the canvas; presses on the panel stay with the panel', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 20, 40, 60, 60), rectObject('b', 120, 40, 60, 60)]), 'Panel edge')
  await openDocument(window, id)
  await pin(true)
  await t('draw-canvas-scroll').focus()
  await window.keyboard.press(`${mod}+0`)
  const g = await geometry()
  // The whole page is beside the panel after ⌘0.
  const stage = (await t('draw-stage').boundingBox())!
  expect(stage.x).toBeGreaterThanOrEqual(g.panelRight - 1)

  // A click 4 px right of the panel's edge, on art there, selects it.
  const a = await pathBox(0)
  await window.mouse.click(Math.max(a.x + 4, g.panelRight + 4), a.y + a.height / 2)
  await expect(t('draw-selection')).toHaveCount(1)

  // A press on the panel itself (its header, clear of the pin and close
  // buttons and of the layer rows, which act on layers) does not touch the
  // canvas: the selection stays.
  const pb = (await t('draw-panel-layers').boundingBox())!
  const header = { x: pb.x + Math.min(70, pb.width / 3), y: pb.y + 12 }
  await window.mouse.click(header.x, header.y)
  await expect(t('draw-selection')).toHaveCount(1)
  await expect(t('draw-panel-layers')).toBeVisible()

  // A marquee from just right of the panel's edge, on empty pasteboard, around both squares.
  await t('draw-canvas-scroll').focus()
  await window.keyboard.press(`${mod}+Shift+A`)
  await expect(t('draw-selection')).toHaveCount(0)
  const s0 = await stagePoint(window, 800, { x: 0, y: 0 })
  const s1 = await stagePoint(window, 800, { x: 200, y: 120 })
  const start = { x: Math.max(g.panelRight + 2, s0.x - 6), y: s0.y + 10 }
  await window.mouse.move(start.x, start.y)
  await window.mouse.down()
  await window.mouse.move((start.x + s1.x) / 2, (start.y + s1.y) / 2)
  await window.mouse.move(s1.x, s1.y)
  await window.mouse.up()
  await expect(t('draw-selection')).toHaveCount(1)
  const sel = (await t('draw-selection').locator('rect').first().boundingBox())!
  expect(sel.width).toBeGreaterThan((await pathBox(1)).x + (await pathBox(1)).width - (await pathBox(0)).x - 2)

  // A drag that starts on the panel never becomes a marquee on the canvas.
  await window.keyboard.press(`${mod}+Shift+A`)
  await window.mouse.move(header.x, header.y)
  await window.mouse.down()
  await window.mouse.move(s1.x, s1.y)
  await window.mouse.up()
  await expect(t('draw-selection')).toHaveCount(0)
  expect(((await readStored(window, id)).raw as { layers: Array<{ objects: unknown[] }> }).layers[0].objects).toHaveLength(2)
})

test('PP-3 with Layers pinned, ⌘0, ⌥⌘0, Zoom to Selection and Paste all keep the art beside the panel', async () => {
  const body = {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [
      { id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 800, h: 600, background: { type: 'solid', color: '#ffffff' } },
      { id: 'b2', name: 'Artboard 2', x: 900, y: 0, w: 400, h: 600, background: { type: 'solid', color: '#ffffff' } }
    ],
    activeArtboardId: 'artboard-1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [rectObject('a', 0, 0, 120, 90)] }],
    activeLayerId: 'L1',
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
  const id = await seedDrawDoc(window, body, 'Pinned framing')
  await openDocument(window, id)
  await pin(true)
  const g = await geometry()
  await t('draw-canvas-scroll').focus()

  // ⌘0: the active artboard, beside the panel.
  await window.keyboard.press(`${mod}+0`)
  await expect.poll(async () => besidePanel((await t('draw-artboard-artboard-1').boundingBox())!, g)).toBe(true)
  // ⌥⌘0: every artboard, beside the panel.
  await window.keyboard.press(`${mod}+Alt+0`)
  await expect
    .poll(async () => besidePanel((await t('draw-artboard-artboard-1').boundingBox())!, g) && besidePanel((await t('draw-artboard-b2').boundingBox())!, g))
    .toBe(true)
  // Zoom to Selection on the square at the page's top-left corner.
  await window.mouse.click((await pathBox()).x + 10, (await pathBox()).y + 10)
  await expect(t('draw-selection')).toHaveCount(1)
  await t('draw-zoom-menu').click()
  await t('draw-zoom-item-zoomToSelection').click()
  await expect.poll(async () => besidePanel(await pathBox(), g)).toBe(true)

  // Paste (⌘C, ⌘V) puts the copy in the middle of what you can see -- beside the panel.
  await window.keyboard.press(`${mod}+Alt+0`)
  await window.mouse.click((await pathBox()).x + 5, (await pathBox()).y + 5)
  await window.keyboard.press(`${mod}+C`)
  await window.keyboard.press(`${mod}+V`)
  await expect(window.locator('[data-testid="draw-vector-L1"] path')).toHaveCount(2)
  await expect.poll(async () => besidePanel(await pathBox(1), g)).toBe(true)
})
