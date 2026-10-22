/**
 * PlexiiDraw on the office shell (SPEC §6.2): the tool rail with its flyouts,
 * the top bar's tabs and contextual tabs, the overlay panels (Layers F7,
 * Artboards) pinned and unpinned, read-only greying, and the keyboard rules
 * (the shell adds no key handler; the canvas keeps arrows and Enter; ⌥F6
 * moves focus). Throwaway profile (launchApp), PLEXI_APP=preview3.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { barTab, keepNoticesOutOfTheWay, openDocument, pickTool, readStored, rectObject, runMenu, seedDrawDoc, stagePoint, v1Body, waitForSave } from './_drawHelpers'

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
async function click(x: number, y: number, modifiers: Array<'Shift' | 'Alt'> = []): Promise<void> {
  const p = await stagePoint(window, 800, { x, y })
  await window.mouse.click(p.x, p.y, { modifiers })
}
const ONE_PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
function mixed(): Record<string, unknown> {
  return v1Body([
    rectObject('r', 60, 60, 160, 100),
    { id: 'st', type: 'path', shapeKind: 'star', sides: 5, innerRatio: 0.5, path: { subpaths: [{ closed: true, nodes: [{ x: 400, y: 60 }, { x: 430, y: 130 }, { x: 500, y: 140 }, { x: 445, y: 185 }, { x: 465, y: 260 }, { x: 400, y: 220 }, { x: 335, y: 260 }, { x: 355, y: 185 }, { x: 300, y: 140 }, { x: 370, y: 130 }] }] }, fill: { type: 'solid', color: '#f59e0b' } },
    { id: 'tx', type: 'text', x: 60, y: 360, w: 300, text: 'Shell', fontSize: 40, fill: { type: 'solid', color: '#1c1917' } },
    { id: 'im', type: 'image', x: 560, y: 360, w: 160, h: 120, src: ONE_PX }
  ])
}
const tabIds = async (): Promise<string[]> =>
  window.locator('[data-testid="draw-bar"] [role="tab"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').replace('draw-bar-tab-', '')))

test('SH-1 rail: flyouts show the last tool used (kept for the profile), Alt-click steps through a group, the Pen shows when it is mid-path, ⌘ shows Direct Selection borrowed', async () => {
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  await expect(t('draw-toolbox')).toBeVisible()
  // The shapes flyout: pick Star, and its button now shows Star.
  await pickTool(window, 'star')
  await expect(t('draw-tool-star')).toHaveAttribute('aria-pressed', 'true')
  await window.keyboard.press('v')
  await expect(t('draw-tool-star')).toBeVisible()
  await expect(t('draw-tool-rect')).toHaveCount(0)
  // Kept per profile: a reopened drawing shows Star on that button too.
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  await expect(t('draw-tool-star')).toBeVisible()
  // M still means Rectangle (and the button follows the active tool).
  await window.keyboard.press('m')
  await expect(t('draw-tool-rect')).toHaveAttribute('aria-pressed', 'true')
  // Alt-click on the button steps to the next tool of the group (Illustrator).
  await t('draw-tool-rect').click({ modifiers: ['Alt'] })
  await expect(t('draw-tool-roundRect')).toHaveAttribute('aria-pressed', 'true')
  // The Pen mid-path wears a dot and says so.
  await window.keyboard.press('p')
  await click(100, 100)
  await click(200, 100)
  await expect(t('draw-tool-pen')).toHaveAttribute('aria-label', /continuing a path/)
  await window.keyboard.press('Enter')
  await expect(t('draw-tool-pen')).not.toHaveAttribute('aria-label', /continuing a path/)
  // Holding ⌘ with the Pen borrows Direct Selection, and the rail shows it.
  await window.locator('[data-testid="draw-stage"]').hover()
  await window.keyboard.down('Meta')
  await expect(t('draw-tool-direct')).toHaveAttribute('aria-pressed', 'true')
  await window.keyboard.up('Meta')
  await expect(t('draw-tool-pen')).toHaveAttribute('aria-pressed', 'true')
  // Space borrows the Hand.
  await window.keyboard.down('Space')
  await expect(t('draw-tool-hand')).toHaveAttribute('aria-pressed', 'true')
  await window.keyboard.up('Space')
  await window.keyboard.press('v')
})

test('SH-2 top bar: contextual tabs come and go with the selection and never take over; a vanished tab falls back to Home', async () => {
  await openDocument(window, await seedDrawDoc(window, mixed()))
  await barTab(window, 'home')
  expect(await tabIds()).toEqual(['home', 'object', 'align'])
  await click(120, 100)
  expect(await tabIds()).toEqual(['home', 'object', 'align', 'path'])
  await expect(t('draw-bar-tab-path')).toHaveAttribute('data-contextual', 'true')
  await expect(t('draw-bar-tab-home')).toHaveAttribute('aria-selected', 'true')
  await barTab(window, 'path')
  await expect(t('draw-bool-union')).toBeDisabled()
  // The star: Shape (and Path); the type: Type; the picture: Image.
  await click(400, 180)
  expect(await tabIds()).toEqual(['home', 'object', 'align', 'shape', 'path'])
  await expect(t('draw-bar-tab-path')).toHaveAttribute('aria-selected', 'true')
  await click(100, 380)
  expect(await tabIds()).toEqual(['home', 'object', 'align', 'type'])
  // Path vanished while active: Home again.
  await expect(t('draw-bar-tab-home')).toHaveAttribute('aria-selected', 'true')
  await click(640, 420)
  expect(await tabIds()).toEqual(['home', 'object', 'align', 'image'])
  // Several objects: Group (and Path for the paths among them).
  await window.keyboard.press('Meta+a')
  expect(await tabIds()).toEqual(['home', 'object', 'align', 'path', 'group'])
  await window.keyboard.press('Meta+Shift+a')
  // Tools: Brush with a painting tool, Anchors with an anchor tool on a path, Artboard with ⇧O.
  await window.keyboard.press('b')
  expect(await tabIds()).toEqual(['home', 'object', 'align', 'brush'])
  await window.keyboard.press('v')
  await click(120, 100)
  await window.keyboard.press('a')
  expect(await tabIds()).toContain('anchors')
  await window.keyboard.press('Shift+o')
  expect(await tabIds()).toContain('artboard')
  await window.keyboard.press('v')
  await window.keyboard.press('Meta+Shift+a')
  expect(await tabIds()).toEqual(['home', 'object', 'align'])
})

test('SH-3 Home edits the selection or, with nothing selected, the next shape; Undo and Redo are pinned', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 100, 100)]))
  await openDocument(window, id)
  await barTab(window, 'home')
  await expect(t('draw-undo')).toBeDisabled()
  await click(150, 150)
  await t('draw-fill').click()
  await t('draw-fill-color').fill('#123456')
  await window.keyboard.press('Escape')
  await t('draw-object-opacity').fill('50')
  await t('draw-object-opacity').press('Enter')
  await waitForSave(window)
  const o = ((await readStored(window, id)).raw as { layers: Array<{ objects: Array<{ fill: unknown; opacity: number }> }> }).layers[0].objects[0]
  expect(o.fill).toEqual({ type: 'solid', color: '#123456' })
  expect(o.opacity).toBe(0.5)
  await expect(t('draw-undo')).toBeEnabled()
  await t('draw-undo').click()
  await waitForSave(window)
  expect(((await readStored(window, id)).raw as { layers: Array<{ objects: Array<{ opacity?: number }> }> }).layers[0].objects[0].opacity ?? 1).toBe(1)
  // Nothing selected: opacity has nothing to act on, and says so.
  await window.keyboard.press('Meta+Shift+a')
  await expect(t('draw-object-opacity')).toBeDisabled()
  await expect(t('draw-object-opacity')).toHaveAttribute('aria-label', /select an object first/)
})

test('SH-4 panels: F7 toggles Layers (the rail button and Window › Layers agree), Esc closes it to the canvas, a pinned panel stays and Fit centres beside it', async () => {
  await openDocument(window, await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 100, 100)])))
  await window.locator('[data-testid="draw-stage"]').click({ position: { x: 2, y: 2 } })
  await window.keyboard.press('F7')
  await expect(t('draw-panel-layers')).toBeVisible()
  await expect(t('draw-rail-layers')).toHaveAttribute('aria-pressed', 'true')
  await expect(t('draw-rail-layers')).toHaveAttribute('aria-label', 'Layers (F7)')
  await window.keyboard.press('F7')
  await expect(t('draw-panel-layers')).toHaveCount(0)
  await expect(t('draw-rail-layers')).toHaveAttribute('aria-pressed', 'false')
  await runMenu(window, 'window', 'Layers')
  await expect(t('draw-panel-layers')).toBeVisible()
  // Esc inside an unpinned panel closes it and puts focus back on the canvas.
  await t('draw-add-vector-layer').focus()
  await window.keyboard.press('Escape')
  await expect(t('draw-panel-layers')).toHaveCount(0)
  expect(await window.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('draw-canvas-scroll')
  // An unpinned panel closes on a click on the canvas; a pinned one stays.
  await t('draw-rail-layers').click()
  await click(400, 300)
  await expect(t('draw-panel-layers')).toHaveCount(0)
  await t('draw-rail-layers').click()
  await t('draw-panel-layers-pin').click()
  await click(400, 300)
  await expect(t('draw-panel-layers')).toBeVisible()
  // ⌘0 fits the artboard into the part of the canvas the pinned panel leaves.
  await window.keyboard.press('Meta+0')
  await window.waitForTimeout(400)
  const geo = await window.evaluate(() => {
    const r = (s: string): DOMRect => document.querySelector(s)!.getBoundingClientRect()
    return { panel: r('[data-testid="draw-panel-layers"]'), stage: r('[data-testid="draw-stage"]'), scroll: r('[data-testid="draw-canvas-scroll"]') }
  })
  expect(geo.stage.left, 'the artboard starts right of the pinned panel').toBeGreaterThan(geo.panel.right)
  const visibleMid = (geo.panel.right + geo.scroll.right) / 2
  expect(Math.abs(geo.stage.left + geo.stage.width / 2 - visibleMid), 'centred in the visible part').toBeLessThan(24)
  // Pinned panels reopen with the next drawing; unpin and close.
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  await expect(t('draw-panel-layers')).toBeVisible()
  await t('draw-panel-layers-pin').click()
  await t('draw-panel-layers-close').click()
  await expect(t('draw-panel-layers')).toHaveCount(0)
})

test('SH-5 keys: arrows on the bar move focus and never nudge; ⌥F6 cycles canvas → bar → rail; arrows and Enter on the canvas still work', async () => {
  const id = await seedDrawDoc(window, v1Body([rectObject('a', 100, 100, 100, 100)]))
  await openDocument(window, id)
  await click(150, 150)
  // ⌥F6: the top bar's active tab, then the rail, then the canvas.
  await window.keyboard.press('Alt+F6')
  expect(await window.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('tab')
  // Arrows on the tabs switch tabs; the rectangle stays where it is.
  await window.keyboard.press('ArrowRight')
  await window.keyboard.press('ArrowLeft')
  await window.keyboard.press('Alt+F6')
  expect(await window.evaluate(() => !!document.activeElement?.closest('[data-testid="draw-toolbox"]'))).toBe(true)
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('Alt+F6')
  expect(await window.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('draw-canvas-scroll')
  await waitForSave(window)
  const x0 = () => readStored(window, id).then((s) => (s.raw as { layers: Array<{ objects: Array<{ path: { subpaths: Array<{ nodes: Array<{ x: number }> }> } }> }> }).layers[0].objects[0].path.subpaths[0].nodes[0].x)
  expect(await x0()).toBe(100)
  // On the canvas the arrows nudge, and Enter opens the active tool's options.
  await window.keyboard.press('ArrowRight')
  await waitForSave(window)
  expect(await x0()).toBe(101)
  await window.keyboard.press('Enter')
  await expect(t('draw-move-dialog-ok')).toBeVisible()
  await window.keyboard.press('Escape')
})

test('SH-6 double-clicking the active tab hides Row 2 and it stays hidden for the next drawing; the chevron brings it back', async () => {
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  await t('draw-bar-tab-home').dblclick()
  await expect(t('draw-bar-panel')).toHaveCount(0)
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  await expect(t('draw-bar-panel')).toHaveCount(0)
  await t('draw-bar-collapse').click()
  await expect(t('draw-bar-panel')).toBeVisible()
})

test('SH-7 a drawing from a newer PlexiiDraw: the bar and the editing tools are greyed with the reason; looking still works', async () => {
  await openDocument(window, await seedDrawDoc(window, { ...mixed(), schemaVersion: 3, minWriterVersion: 3 }))
  await expect(t('draw-readonly-banner')).toBeVisible()
  await expect(t('draw-tool-pen')).toBeDisabled()
  await expect(t('draw-tool-select')).toBeEnabled()
  await expect(t('draw-fill')).toBeDisabled()
  await expect(t('draw-fill')).toHaveAttribute('aria-label', /this document is read-only/)
  await expect(t('draw-undo')).toBeDisabled()
  await expect(t('draw-zoom-in')).toBeEnabled()
  await barTab(window, 'object')
  await expect(t('draw-transform-flip-h')).toBeDisabled()
  await window.keyboard.press('F7')
  await expect(t('draw-panel-layers')).toBeVisible()
  await expect(t('draw-add-vector-layer')).toBeDisabled()
  await window.keyboard.press('F7')
})
