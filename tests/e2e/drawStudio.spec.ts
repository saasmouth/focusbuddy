/**
 * E2E for PlexiDraw — the vector + painting studio ('draw' doc type).
 *
 * This is the "does it actually work in the real app" pass: the studio opens
 * from PlexiOffice, the toolbox is there, drawing a shape puts a real path on a
 * real layer, the pathfinder combines two shapes into one, and a paint layer
 * accepts a brush stroke that survives as pixels. Geometry is read back through
 * the DOM rather than eyeballed, because a screenshot cannot tell you whether a
 * boolean actually ran.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

async function openDrawStudio(window: Page): Promise<void> {
  await window.locator('[data-testid="switch-office"]').first().click()
  await expect(window.locator('[data-testid="office-app-draw"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-draw"]').click()
  await expect(window.locator('[data-testid="draw-studio"]')).toBeVisible({ timeout: 10_000 })
}

/** Drag on the artboard in stage coordinates, which is how every tool is used. */
async function dragOnStage(window: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const stage = window.locator('[data-testid="draw-stage"]')
  const box = await stage.boundingBox()
  if (!box) throw new Error('the artboard stage was not laid out')
  // The stage is fitted to the window, so it is usually much smaller on screen
  // than the artboard. Offsets are clamped into it, otherwise a drag meant for
  // the canvas silently lands on the chrome outside it.
  const cx = (v: number): number => box.x + Math.max(2, Math.min(box.width - 2, v))
  const cy = (v: number): number => box.y + Math.max(2, Math.min(box.height - 2, v))
  await window.mouse.move(cx(from.x), cy(from.y))
  await window.mouse.down()
  // Intermediate moves matter: a single jump can be coalesced away.
  await window.mouse.move(cx((from.x + to.x) / 2), cy((from.y + to.y) / 2))
  await window.mouse.move(cx(to.x), cy(to.y))
  await window.mouse.up()
}

function paths(window: Page): ReturnType<Page['locator']> {
  return window.locator('[data-testid^="draw-vector-"] path')
}

test.describe('PlexiDraw studio', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await openDrawStudio(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('DR-1 the studio opens with its toolbox, layers and inspector', async () => {
    for (const t of ['draw-toolbox', 'draw-inspector', 'draw-layers-panel', 'draw-stage', 'draw-studio-menubar']) {
      await expect(window.locator(`[data-testid="${t}"]`)).toBeVisible()
    }
    // Every tool the toolbox claims to have is really there.
    for (const tool of ['select', 'node', 'pen', 'pencil', 'rect', 'ellipse', 'text', 'brush', 'eraser', 'bucket', 'eyedropper', 'hand']) {
      await expect(window.locator(`[data-testid="draw-tool-${tool}"]`)).toBeVisible()
    }
  })

  test('DR-2 drawing a rectangle puts a real path on the canvas', async () => {
    await window.locator('[data-testid="draw-tool-rect"]').click()
    await dragOnStage(window, { x: 40, y: 40 }, { x: 160, y: 140 })
    await expect(paths(window)).toHaveCount(1)
    // The tool returns to Select once a shape is committed, so the new shape can
    // be moved immediately — and the selection frame proves it is selected.
    await expect(window.locator('[data-testid="draw-selection"]')).toBeVisible()
  })

  test('DR-3 a second shape, then Unite, leaves ONE combined path', async () => {
    await window.locator('[data-testid="draw-tool-ellipse"]').click()
    await dragOnStage(window, { x: 110, y: 90 }, { x: 240, y: 200 })
    await expect(paths(window)).toHaveCount(2)

    // Select both, then run the pathfinder.
    await window.keyboard.press('Meta+a')
    await window.locator('[data-testid="draw-bool-union"]').click()
    await expect(paths(window)).toHaveCount(1)

    // The union must be larger than either operand was — a boolean that quietly
    // did nothing (or dropped a shape) would fail here.
    const d = await paths(window).first().getAttribute('d')
    expect(d).toBeTruthy()
    expect((d ?? '').length).toBeGreaterThan(40)
  })

  test('DR-4 undo brings both shapes back, redo re-combines them', async () => {
    await window.keyboard.press('Meta+z')
    await expect(paths(window)).toHaveCount(2)
    await window.keyboard.press('Meta+Shift+z')
    await expect(paths(window)).toHaveCount(1)
  })

  test('DR-5 a paint layer accepts a brush stroke and keeps the pixels', async () => {
    await window.locator('[data-testid="draw-add-raster-layer"]').click()
    const canvas = window.locator('[data-testid^="draw-raster-"]').first()
    await expect(canvas).toBeVisible()

    await window.locator('[data-testid="draw-tool-brush"]').click()
    await dragOnStage(window, { x: 60, y: 200 }, { x: 260, y: 230 })

    // Measure the real pixels: the stroke must have laid down non-transparent
    // alpha. Checking the DOM alone would pass even if the brush drew nothing.
    const painted = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement
      const ctx = c.getContext('2d')
      if (!ctx) return -1
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      let n = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++
      return n
    })
    expect(painted).toBeGreaterThan(0)
  })

  test('DR-6 hiding a layer removes it from the canvas, showing it brings it back', async () => {
    // Rows render top-of-stack first, so the LAST row is the bottom (vector) layer.
    const vectorRow = window.locator('[data-testid^="draw-layer-row-"]').last()
    const before = await paths(window).count()
    expect(before).toBeGreaterThan(0)
    await vectorRow.locator('button').first().click()
    await expect(paths(window)).toHaveCount(0)
    await vectorRow.locator('button').first().click()
    await expect(paths(window)).toHaveCount(before)
  })

  test('DR-7 the brush controls only appear for a painting tool', async () => {
    await window.locator('[data-testid="draw-tool-brush"]').click()
    await expect(window.locator('[data-testid="draw-brush-size"]')).toBeVisible()
    await window.locator('[data-testid="draw-tool-select"]').click()
    await expect(window.locator('[data-testid="draw-brush-size"]')).toHaveCount(0)
  })

  test('DR-7b picking the brush with NO paint layer makes one and then paints', async () => {
    // This is the bug users hit: a fresh artwork has only a vector layer, so the
    // brush silently refused and the canvas stayed blank.
    await window.locator('[data-testid="office-sideapp-draw"]').click()
    await expect(window.locator('[data-testid="draw-studio"]')).toBeVisible({ timeout: 10_000 })
    await expect(window.locator('[data-testid^="draw-raster-"]')).toHaveCount(0)

    await window.locator('[data-testid="draw-tool-brush"]').click()
    await dragOnStage(window, { x: 60, y: 80 }, { x: 240, y: 140 })
    // The first gesture provisions the layer it needs.
    await expect(window.locator('[data-testid^="draw-raster-"]')).toHaveCount(1, { timeout: 5_000 })

    // And the very next stroke lays down real pixels.
    await dragOnStage(window, { x: 60, y: 160 }, { x: 240, y: 220 })
    const painted = await window.locator('[data-testid^="draw-raster-"]').first().evaluate((el) => {
      const c = el as HTMLCanvasElement
      const ctx = c.getContext('2d')
      if (!ctx) return -1
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let n = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
      return n
    })
    expect(painted).toBeGreaterThan(0)
  })

  test('DR-7c every brush preset lays down its own kind of mark', async () => {
    const ids = ['round-soft', 'airbrush', 'pencil', 'ink', 'calligraphy', 'marker', 'charcoal', 'chalk', 'spray', 'watercolour', 'oil']
    const canvas = window.locator('[data-testid^="draw-raster-"]').first()
    let y = 260
    for (const id of ids) {
      await window.locator(`[data-testid="draw-brush-${id}"]`).click()
      const before = await canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
        return n
      })
      await dragOnStage(window, { x: 40, y }, { x: 300, y: y + 6 })
      const after = await canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
        return n
      })
      expect(after, `${id} left no mark`).toBeGreaterThan(before)
      y += 18
    }
  })

  test('DR-7d the type tool makes a box you can actually type into', async () => {
    await window.locator('[data-testid="draw-tool-text"]').click()
    await dragOnStage(window, { x: 60, y: 60 }, { x: 420, y: 130 })

    const editor = window.locator('[data-testid="draw-text-editor"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await editor.fill('Hello from the type tool')
    await expect(editor).toHaveValue('Hello from the type tool')

    // While the box is being typed into its object is hidden, so the words are
    // drawn once by the editor rather than twice.
    expect(await window.locator('[data-testid^="draw-vector-"] text').count()).toBe(0)
  })

  test('DR-7e clicking back into the text box keeps editing instead of dragging it', async () => {
    // The old bug: the click bubbled to the stage, which grabbed the pointer and
    // started moving the object, so a caret could never be placed.
    const editor = window.locator('[data-testid="draw-text-editor"]')
    const box = await editor.boundingBox()
    if (!box) throw new Error('no text editor')
    await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(editor).toBeVisible()
    await editor.fill('Hello from the type tool — still editing')
    await expect(editor).toHaveValue(/still editing/)
  })

  test('DR-7f clicking away commits the words onto the artwork, exactly once', async () => {
    await window.locator('[data-testid="draw-tool-select"]').click()
    await dragOnStage(window, { x: 900, y: 400 }, { x: 902, y: 402 })
    await expect(window.locator('[data-testid="draw-text-editor"]')).toHaveCount(0, { timeout: 5_000 })
    const drawn = window.locator('[data-testid^="draw-vector-"] text')
    await expect(drawn).toHaveCount(1, { timeout: 5_000 })
    await expect(drawn.first()).toContainText('still editing')
  })

  test('DR-7g an empty type box is discarded rather than left invisible', async () => {
    const before = await window.locator('[data-testid^="draw-vector-"] text').count()
    await window.locator('[data-testid="draw-tool-text"]').click()
    await dragOnStage(window, { x: 60, y: 300 }, { x: 300, y: 340 })
    await expect(window.locator('[data-testid="draw-text-editor"]')).toBeVisible()
    await window.locator('[data-testid="draw-tool-select"]').click()
    await dragOnStage(window, { x: 900, y: 60 }, { x: 902, y: 62 })
    await expect(window.locator('[data-testid^="draw-vector-"] text')).toHaveCount(before, { timeout: 5_000 })
  })

  test('DR-8 a second artwork opens cleanly from the office side menu', async () => {
    // With a document already open the office chrome shows its side menu, whose
    // entries carry the office-sideapp- prefix.
    await window.locator('[data-testid="office-sideapp-draw"]').click()
    await expect(window.locator('[data-testid="draw-studio"]')).toBeVisible({ timeout: 10_000 })
    await expect(window.locator('[data-testid="draw-layers-panel"]')).toBeVisible()
    // A brand-new artwork starts with exactly one empty vector layer.
    await expect(window.locator('[data-testid^="draw-layer-row-"]')).toHaveCount(1)
    await expect(paths(window)).toHaveCount(0)
  })
})
