import { test, expect } from '@playwright/test'
import { clickWidgetTool, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// WidgetFrame header +/− buttons:
//   - "Grow work widget" multiplies w/h by 1.5, each side clamped to the grow
//     ceiling GROW_CEILING (4800 × 3200 since 6aa80f61, "scaleWidgetBy's cap
//     raised to 4800x3200" — the owner's 4.3.41 any-size ruling; it was
//     1400 × 900 before)
//   - "Shrink work widget" multiplies w/h by 1/1.5 (floored 180 × 120)
//   - Operations are symmetric inverses: grow then shrink returns the
//     widget to its original dimensions within sub-pixel rounding
//
// The buttons are pressed through clickWidgetTool: a real pointer click on
// the header tool, inline or behind the header's "…" overflow. A widget
// grown past the viewport carries its header tools off screen, exactly as it
// would for a user, so the cap test brings it back into view the way a user
// would — the desk's Home shortcut (⌘H, fit all to view) — before each press.
// The cap test grows a note rather than a sticky; see the test for why.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedAndOpenStickyWidget(
  launched: LaunchedApp,
  kind: 'sticky' | 'note' = 'sticky'
): Promise<{
  widgetId: string
  taskId: string
  initialW: number
  initialH: number
}> {
  const { window } = launched

  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  const seeded = await window.evaluate(async (k) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Resize test'
    })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: k,
      title: '',
      content: 'resize me',
      x: 200,
      y: 200,
      width: 320,
      height: 240
    })
    return { taskId: task.id, widgetId: w.id, initialW: w.width, initialH: w.height }
  }, kind)

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'Resize test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  return seeded
}

async function clickResizeButton(
  launched: LaunchedApp,
  direction: 'grow' | 'shrink',
  widgetId: string
): Promise<void> {
  const { window } = launched
  // A 320px sticky folds Grow and Shrink into the header's "…" menu
  // (lib/widgetHeaderActions); after a grow they are back on the header.
  // Press the tool wherever it currently is.
  await clickWidgetTool(window, widgetId, direction === 'grow' ? 'Grow work widget' : 'Shrink work widget')
}

async function readWidget(
  launched: LaunchedApp,
  widgetId: string,
  taskId: string
): Promise<{ width: number; height: number } | null> {
  return launched.window.evaluate(
    async ({ id, tid }: { id: string; tid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const w = widgets.find((x) => x.id === id)
      return w ? { width: w.width, height: w.height } : null
    },
    { id: widgetId, tid: taskId }
  )
}

test('+ button grows widget by 50%, − button shrinks by inverse (1/1.5) — symmetric within 1px', async () => {
  launched = await launchApp()
  const { widgetId, taskId, initialW, initialH } = await seedAndOpenStickyWidget(launched)

  // Sanity: the work widget's header is mounted.
  await launched.window.waitForSelector(`[data-widget-id="${widgetId}"] [data-widget-header]`, { timeout: 5_000 })

  // Grow once.
  await clickResizeButton(launched, 'grow', widgetId)
  await launched.window.waitForTimeout(200)
  const grown = await readWidget(launched, widgetId, taskId)
  expect(grown).not.toBeNull()
  expect(grown!.width).toBe(Math.round(initialW * 1.5))
  expect(grown!.height).toBe(Math.round(initialH * 1.5))

  // Shrink once.
  await clickResizeButton(launched, 'shrink', widgetId)
  await launched.window.waitForTimeout(200)
  const shrunk = await readWidget(launched, widgetId, taskId)
  expect(shrunk).not.toBeNull()
  // 320 × 1.5 = 480, then × (1/1.5) = 320. Allow 1px tolerance for rounding.
  expect(Math.abs(shrunk!.width - initialW)).toBeLessThanOrEqual(1)
  expect(Math.abs(shrunk!.height - initialH)).toBeLessThanOrEqual(1)
})

test('Shrink button respects minWidth/minHeight floor (180 × 120)', async () => {
  launched = await launchApp()
  const { widgetId, taskId } = await seedAndOpenStickyWidget(launched)
  await launched.window.waitForSelector(`[data-widget-id="${widgetId}"] [data-widget-header]`, { timeout: 5_000 })

  // Click shrink many times — should clamp at min.
  for (let i = 0; i < 8; i++) {
    await clickResizeButton(launched, 'shrink', widgetId)
    await launched.window.waitForTimeout(80)
  }
  const final = await readWidget(launched, widgetId, taskId)
  expect(final).not.toBeNull()
  expect(final!.width).toBeGreaterThanOrEqual(180)
  expect(final!.height).toBeGreaterThanOrEqual(120)
})

test('Grow button stops at the grow ceiling (4800 × 3200), and its tooltip says so', async () => {
  launched = await launchApp()
  const { window } = launched
  // A note, not a sticky: this measures the Grow press's own ceiling, so the
  // widget must be one whose height nothing else owns. A sticky's height is
  // content-driven and held to its auto-grow ceiling (useAutoGrowHeight, sticky
  // 640 since 5d1d3beb), which pulls any taller sticky back down — a separate
  // rule, and not the one under test here.
  const { widgetId, taskId, initialW, initialH } = await seedAndOpenStickyWidget(launched, 'note')
  await window.waitForSelector(`[data-widget-id="${widgetId}"] [data-widget-header]`, { timeout: 5_000 })

  // The tool states the ceiling the press actually enforces — wherever it
  // sits. At 320px it is folded into the header's "…" menu, whose item had no
  // tooltip at all; inline it said "max 1400 × 900" for two releases after the
  // ceiling became 4800 × 3200.
  const GROW_TITLE = 'Grow this work widget by 50% (max 4800 × 3200)'
  const header = window.locator(`[data-widget-id="${widgetId}"] [data-widget-header]`).first()
  await header.hover()
  await header.locator(`[data-testid="widget-overflow-${widgetId}"]`).click()
  const folded = window
    .getByRole('menu', { name: 'More work widget actions' })
    .getByRole('menuitem', { name: 'Grow work widget', exact: true })
  await expect(folded).toHaveAttribute('title', GROW_TITLE)
  await window.keyboard.press('Escape')
  await expect(window.getByRole('menu', { name: 'More work widget actions' })).toHaveCount(0)

  // Every press is +50% per side, clamped per side to the ceiling. Starting
  // from 320 × 240: 480×360, 720×540, 1080×810, 1620×1215, 2430×1823,
  // 3645×2734, then 5468×4101 clamps to 4800×3200, and an eighth press at the
  // ceiling changes nothing.
  const CAP_W = 4800
  const CAP_H = 3200
  let expected = { width: initialW, height: initialH }
  // Give the desk the window: minimise the side menu, as someone growing a
  // widget this large would.
  await window.getByRole('button', { name: 'Minimise the menu to free the desk' }).click()
  for (let i = 0; i < 8; i++) {
    // Fit the desk to the view (Home) so the header tools are on screen — and
    // clear of the edge-pan zone, which Home did not guarantee before (lib/
    // deskCameraNav homeCamera): at 60px from the top, reaching for Grow
    // panned the desk away under the pointer. Esc first: it hands the keyboard
    // back from the widget to the desk, which is where Home is handled (the
    // canvas reads Control as well as ⌘).
    await window.keyboard.press('Escape')
    await window.keyboard.press('Control+h')
    await window.waitForTimeout(350) // the fit animates for 280ms
    const growRect = await window.evaluate((id) => {
      const frame = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
      return { left: frame.left, right: frame.right, top: frame.top, vw: window.innerWidth, vh: window.innerHeight }
    }, widgetId)
    expect(growRect.right, `press ${i + 1}: Home did not bring the widget into view`).toBeLessThanOrEqual(growRect.vw)
    expect(growRect.top, `press ${i + 1}: Home did not bring the widget into view`).toBeGreaterThanOrEqual(0)
    await clickResizeButton(launched, 'grow', widgetId)
    expected = {
      width: Math.min(CAP_W, Math.round(expected.width * 1.5)),
      height: Math.min(CAP_H, Math.round(expected.height * 1.5))
    }
    await expect
      .poll(() => readWidget(launched!, widgetId, taskId), { message: `size after grow press ${i + 1}` })
      .toEqual(expected)
  }
  // Growth really happened, all the way to the ceiling and no further.
  expect(expected).toEqual({ width: CAP_W, height: CAP_H })
  // At this width the tool is on the header itself, saying the same thing.
  await expect(header.locator(`.fb-widget-actions [data-testid="widget-grow-${widgetId}"]`)).toHaveAttribute(
    'title',
    GROW_TITLE
  )
})
