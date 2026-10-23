/**
 * PlexiiAssist in PlexiiDraw: describe it, see it, then apply it.
 *
 * The owner, after trying Diagrams' AI: "This works in diagrams, but not in
 * draw. Draw needs to be able to build vector designs and paint designs."
 *
 * The model is stubbed at the IPC, the same way slidesEditor and sheetEditor
 * stub theirs, so these tests are about what the STUDIO does with a reply:
 * that the pane starts closed, that a generation is previewed and not
 * applied, that applying is one undo step, that the art arrives as editable
 * objects rather than a picture, and that a reply the app cannot draw is
 * refused out loud instead of landing an empty layer.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, v1Body, waitForSave } from './_drawHelpers'

let app: LaunchedApp
let window: Page

test.beforeAll(async () => {
  test.setTimeout(90_000)
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
})
test.afterAll(async () => {
  await app.dispose()
})

const t = (id: string): ReturnType<Page['locator']> => window.locator(`[data-testid="${id}"]`)

/** A scene the model might return: two shapes and a group. */
const SCENE = {
  name: 'A badge',
  items: [
    { shape: { kind: 'rect', x: 0, y: 0, w: 200, h: 120, radius: 12 }, fill: '#2563eb', name: 'plate' },
    { shape: { kind: 'star', cx: 100, cy: 60, r: 40, points: 5 }, fill: '#fde047', name: 'star' }
  ]
}

async function stubGenerate(reply: object): Promise<void> {
  await app.app.evaluate(({ ipcMain }, r: object) => {
    ipcMain.removeHandler('draw:generate')
    ipcMain.handle('draw:generate', async () => r)
  }, reply)
}

/** No OpenAI key, which is what most people have: the paint route must say so. */
async function stubOpenAiKey(hasKey: boolean): Promise<void> {
  await app.app.evaluate(({ ipcMain }, has: boolean) => {
    ipcMain.removeHandler('settings:hintOpenAI')
    ipcMain.handle('settings:hintOpenAI', async () => ({ hasKey: has, last4: has ? '1234' : null }))
  }, hasKey)
}

let docId = ''

async function openStudio(): Promise<void> {
  docId = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, docId)
  await expect(t('draw-shell')).toBeVisible({ timeout: 15_000 })
}

/**
 * Layers as the DOCUMENT has them, not as a panel draws them: the Layers
 * panel renders rows only while it is open, and opening it to count would put
 * an overlay panel over the canvas in the middle of the pane's own geometry
 * checks.
 */
async function layerCount(): Promise<number> {
  await waitForSave(window)
  const stored = (await readStored(window, docId)).raw as { layers?: unknown[] } | null
  return stored?.layers?.length ?? 0
}

test('DG-1 the pane starts closed and opens from the bar, shrinking the canvas rather than covering it', async () => {
  await openStudio()
  // Closed on a fresh profile: an AI pane that opened itself would cover the
  // canvas of every drawing on the device (d1's condition).
  await expect(t('draw-ai-pane')).toHaveCount(0)
  await expect(t('draw-sidepane-edge')).toBeVisible()

  const before = (await t('draw-canvas-scroll').boundingBox())!
  await t('draw-sidepane-toggle').click()
  await expect(t('draw-ai-pane')).toBeVisible()
  const after = (await t('draw-canvas-scroll').boundingBox())!
  const pane = (await t('draw-sidepane').boundingBox())!

  // The canvas gives up the width the pane takes; it is not overlaid.
  expect(after.width).toBeLessThan(before.width - 100)
  expect(Math.round(pane.x)).toBeGreaterThanOrEqual(Math.round(after.x + after.width) - 1)

  await t('draw-sidepane-toggle').click()
  await expect(t('draw-ai-pane')).toHaveCount(0)
  const back = (await t('draw-canvas-scroll').boundingBox())!
  expect(Math.round(back.width)).toBe(Math.round(before.width))
})

test('DG-2 a generation is PREVIEWED, and the drawing is untouched until Apply', async () => {
  await stubGenerate({ ok: true, scene: SCENE, problems: [] })
  await t('draw-sidepane-toggle').click()
  await expect(t('draw-ai-pane')).toBeVisible()

  const layersBefore = await layerCount()
  await t('draw-ai-prompt').fill('a delivery van badge')
  await t('draw-ai-generate').click()

  await expect(t('draw-ai-preview')).toBeVisible({ timeout: 10_000 })
  // The preview is the real serializer's SVG, not a description of one.
  await expect(t('draw-ai-preview-svg')).toBeVisible()
  // And nothing has happened to the drawing yet.
  expect(await layerCount()).toBe(layersBefore)

  await t('draw-ai-discard').click()
  await expect(t('draw-ai-preview')).toHaveCount(0)
  expect(await layerCount()).toBe(layersBefore)
})

test('DG-3 Apply adds editable objects on their own layer, and ⌘Z takes the whole thing back', async () => {
  const layersBefore = await layerCount()
  await t('draw-ai-prompt').fill('a delivery van badge')
  await t('draw-ai-generate').click()
  await expect(t('draw-ai-preview')).toBeVisible({ timeout: 10_000 })
  await t('draw-ai-apply').click()

  await expect.poll(layerCount, { timeout: 8_000 }).toBe(layersBefore + 1)
  await waitForSave(window)

  // Editable art, not a picture: two PATH objects with their own geometry.
  const stored = (await readStored(window, docId)).raw as {
    layers?: Array<{ name?: string; objects?: Array<{ type: string; path?: { subpaths: unknown[] } }> }>
  }
  const added = stored.layers?.[stored.layers.length - 1]
  expect(added?.name).toBe('A badge')
  expect(added?.objects).toHaveLength(2)
  for (const o of added!.objects!) {
    expect(o.type).toBe('path')
    expect(o.path!.subpaths.length).toBeGreaterThan(0)
  }

  // ONE undo step for the whole generation, layer included.
  await window.keyboard.press('Meta+z')
  await expect.poll(layerCount, { timeout: 8_000 }).toBe(layersBefore)
})

test('DG-4 a reply the app cannot draw is refused out loud, not applied as an empty layer', async () => {
  await stubGenerate({ ok: false, error: 'The model did not return art this app can draw — items: nothing in the reply could be drawn' })
  const layersBefore = await layerCount()
  await t('draw-ai-prompt').fill('something impossible')
  await t('draw-ai-generate').click()

  await expect(t('draw-ai-error')).toBeVisible({ timeout: 10_000 })
  // The reason the model gave, shown as it is. (A try/catch around two
  // possible messages would pass whatever came back, which is not a test.)
  await expect(t('draw-ai-error')).toContainText('nothing in the reply could be drawn')
  await expect(t('draw-ai-preview')).toHaveCount(0)
  expect(await layerCount()).toBe(layersBefore)
})

test('DG-5 parts of a reply that could not be drawn are reported, not hidden', async () => {
  await stubGenerate({
    ok: true,
    scene: SCENE,
    problems: [{ at: 'items[7]', why: 'a shape with no fill and no stroke would be invisible' }]
  })
  await t('draw-ai-prompt').fill('a badge with something odd in it')
  await t('draw-ai-generate').click()
  await expect(t('draw-ai-preview')).toBeVisible({ timeout: 10_000 })
  await expect(t('draw-ai-problems')).toContainText('could not be drawn')
  await t('draw-ai-discard').click()
})

/** Close and reopen the pane, so it asks about the key again on mount. */
async function remountPane(): Promise<void> {
  await t('draw-sidepane-toggle').click()
  await expect(t('draw-ai-pane')).toHaveCount(0)
  await t('draw-sidepane-toggle').click()
  await expect(t('draw-ai-pane')).toBeVisible()
}

test('DG-6 paint follows the OpenAI key, and says so before anyone types a prompt', async () => {
  // BOTH directions. A test profile has no OpenAI key, so asserting only the
  // disabled case would pass with the pane ignoring the key entirely — the
  // enabled case is what proves it is actually reading it.
  await stubOpenAiKey(true)
  await remountPane()
  await expect(t('draw-ai-mode-paint')).toBeEnabled()
  await expect(t('draw-ai-paint-reason')).toHaveCount(0)

  await stubOpenAiKey(false)
  await remountPane()
  await expect(t('draw-ai-mode-paint')).toBeDisabled()
  await expect(t('draw-ai-paint-reason')).toContainText('your own OpenAI key')
  // Vector art is still offered: it runs on this device.
  await expect(t('draw-ai-mode-art')).toBeEnabled()
})

test('DG-7 with the pane OPEN the canvas geometry still holds: fit and zoom to selection land in the canvas that is left', async () => {
  // d1's condition: the pane must SHRINK the canvas, not overlay it, and
  // every centring operation must then centre in what remains. Draw measures
  // the scroll container's clientWidth (domServices), and an in-flow pane
  // changes exactly that — so this is the test that proves no second inset is
  // needed, rather than an assumption that one is not.
  const id = await seedDrawDoc(window, v1Body([rectObject('r', 100, 100, 200, 150)]), 'Geometry with the pane')
  await openDocument(window, id)
  await expect(t('draw-shell')).toBeVisible({ timeout: 15_000 })
  if ((await t('draw-ai-pane').count()) === 0) await t('draw-sidepane-toggle').click()
  await expect(t('draw-ai-pane')).toBeVisible()

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const inCanvas = async (): Promise<boolean> => {
    const [art, canvas, pane] = await Promise.all([
      t('draw-stage').boundingBox(),
      t('draw-canvas-scroll').boundingBox(),
      t('draw-sidepane').boundingBox()
    ])
    if (!art || !canvas || !pane) return false
    // The page sits inside the canvas, and clear of the pane beside it.
    return art.x >= canvas.x - 1 && art.x + art.width <= Math.min(canvas.x + canvas.width, pane.x) + 1
  }

  await t('draw-canvas-scroll').focus()
  await window.keyboard.press(`${mod}+0`)
  await expect.poll(inCanvas, { timeout: 5_000, message: 'Fit (⌘0) centres in the canvas beside the pane' }).toBe(true)

  // Zoom to Selection, the other centring path.
  await window.keyboard.press(`${mod}+a`)
  await window.keyboard.press(`Shift+2`)
  await expect.poll(inCanvas, { timeout: 5_000, message: 'Zoom to Selection stays inside the canvas' }).toBe(true)

  // And it settles rather than drifting, which is what a second, fighting
  // inset would look like.
  const settled = (await t('draw-stage').boundingBox())!
  await window.waitForTimeout(400)
  const again = (await t('draw-stage').boundingBox())!
  expect(Math.abs(again.x - settled.x)).toBeLessThan(1)

  // Paste centring is NOT asserted here. It reads the same visible box from
  // the same domServices code as Fit does (the clientWidth-minus-inset
  // formula), so it shares this risk rather than carrying its own; saying so
  // beats a test that pastes nothing and looks like coverage.
})
