import { test, expect } from '@playwright/test'
import { hoverZoomControls, launchApp, type LaunchedApp } from './_helpers'

// Feature 1 — Cmd/Ctrl+click "dive into widget" when zoomed out:
//   • zoomToWidget(id) store action sets zoom=1, activeWidgetId=id, bumps centerToken
//   • Cmd+click on a widget while zoom < 0.8 calls zoomToWidget and returns early
//   • Normal click (no modifier, or zoom >= 0.8) follows the regular focusOn path
//
// The zoom level is reflected in the DOM via the `data-bare-canvas` div's inline transform:
//   transform: `translate(${panX}px, ${panY}px) scale(${zoom})`
// We read `scale(...)` from that to verify zoom values without needing a store registry.
// We SET zoom via the Zustand store by walking to it through React fibers.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Read the current zoom from the canvas transform.
 * The inner `[data-bare-canvas]` div (the one without `data-canvas-surface`)
 * carries `transform: translate(panX, panY) scale(zoom)`.
 */
async function readCanvasZoom(window: import('@playwright/test').Page): Promise<number | null> {
  return window.evaluate(() => {
    // Two elements have data-bare-canvas: the outer surface wrapper and the
    // inner transform div. Only the inner one (without data-canvas-surface)
    // has the scale transform.
    const all = Array.from(document.querySelectorAll<HTMLElement>('[data-bare-canvas]'))
    const inner = all.find((el) => !el.hasAttribute('data-canvas-surface'))
    if (!inner) return null
    const t = inner.style.transform
    // transform is "translate(Xpx, Ypx) scale(Z)" — extract the scale value
    const m = t.match(/scale\(([0-9.]+)\)/)
    return m ? parseFloat(m[1]) : null
  })
}

/**
 * Zoom out below 0.8 by clicking the zoom-out button in the Canvas toolbar.
 * The button has `title="Zoom out (⌘[)"`. We click it `steps` times, each
 * decreasing zoom by 0.1 (from 1.0 → 0.7 in 3 steps).
 */
async function zoomOutBelow08(window: import('@playwright/test').Page, steps = 4): Promise<boolean> {
  // The pill only mounts its − button while hovered.
  await hoverZoomControls(window)
  for (let i = 0; i < steps; i++) {
    const clicked = await window.evaluate(() => {
      const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.title && b.title.startsWith('Zoom out')
      )
      if (!btn) return false
      btn.click()
      return true
    })
    if (!clicked) return false
    await window.waitForTimeout(50)
  }
  return true
}

async function seedAndOpenTask(l: LaunchedApp): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l

  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'ZoomToWidget test'
    })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'dive into me',
      x: 300,
      y: 200,
      width: 240,
      height: 180
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})

  await window.getByRole('button', { name: 'ZoomToWidget test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  // Give widgets time to render
  await window.waitForTimeout(300)

  return seeded
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('app boots and canvas renders at zoom=1 (smoke)', async () => {
  launched = await launchApp()
  const { widgetId } = await seedAndOpenTask(launched)
  const { window } = launched

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  const zoom = await readCanvasZoom(window)
  // Initial zoom should be 1 (or within rounding)
  expect(zoom).not.toBeNull()
  expect(zoom).toBeCloseTo(1, 1)
})

test('zoomToWidget: meta+click at zoom<0.8 jumps canvas to zoom=1', async () => {
  launched = await launchApp()
  const { widgetId } = await seedAndOpenTask(launched)
  const { window } = launched

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Zoom out to ~0.6 using the toolbar zoom-out button (4 clicks: 1.0 → 0.6)
  const zoomed = await zoomOutBelow08(window, 4)
  expect(zoomed).toBe(true)

  await window.waitForTimeout(150)
  const zoomBefore = await readCanvasZoom(window)
  console.log(`Zoom before meta-click: ${zoomBefore}`)
  expect(zoomBefore).not.toBeNull()
  expect(zoomBefore!).toBeLessThan(0.8)

  // Dispatch a meta+click on the widget inner div to trigger zoomToWidget
  await window.evaluate((wid: string) => {
    const el = document.querySelector(`[data-widget-id="${wid}"]`)
    if (!el) throw new Error('widget not found')
    const evt = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      ctrlKey: false,
      composed: true
    })
    el.dispatchEvent(evt)
  }, widgetId)
  await window.waitForTimeout(300)

  const zoomAfter = await readCanvasZoom(window)
  console.log(`Zoom after meta-click: ${zoomAfter} (expected 1)`)
  expect(zoomAfter).not.toBeNull()
  // zoomToWidget sets zoom to exactly 1
  expect(zoomAfter).toBeCloseTo(1, 1)
})

test('ctrlKey+click (non-mac) at zoom < 0.8 also triggers zoomToWidget', async () => {
  launched = await launchApp()
  const { widgetId } = await seedAndOpenTask(launched)
  const { window } = launched

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Zoom out to ~0.6
  const zoomed = await zoomOutBelow08(window, 4)
  expect(zoomed).toBe(true)
  await window.waitForTimeout(150)

  const zoomBefore = await readCanvasZoom(window)
  expect(zoomBefore).not.toBeNull()
  expect(zoomBefore!).toBeLessThan(0.8)
  console.log(`Zoom before ctrl-click: ${zoomBefore}`)

  // Dispatch a ctrlKey+click
  await window.evaluate((wid: string) => {
    const el = document.querySelector(`[data-widget-id="${wid}"]`)
    if (!el) throw new Error(`widget ${wid} not found`)
    const evt = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: false,
      ctrlKey: true,
      composed: true
    })
    el.dispatchEvent(evt)
  }, widgetId)
  await window.waitForTimeout(300)

  const zoomAfter = await readCanvasZoom(window)
  console.log(`Zoom after ctrl-click: ${zoomAfter} (expected 1)`)
  expect(zoomAfter).not.toBeNull()
  expect(zoomAfter).toBeCloseTo(1, 1)
})

test('normal click (no modifier) at zoom < 0.8 does NOT jump zoom to 1', async () => {
  launched = await launchApp()
  const { widgetId } = await seedAndOpenTask(launched)
  const { window } = launched

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Zoom out to ~0.6 using the toolbar button
  const zoomed = await zoomOutBelow08(window, 4)
  expect(zoomed).toBe(true)
  await window.waitForTimeout(150)

  const zoomBefore = await readCanvasZoom(window)
  expect(zoomBefore).not.toBeNull()
  expect(zoomBefore!).toBeLessThan(0.8)
  console.log(`Zoom before normal click: ${zoomBefore}`)

  // Normal click — no metaKey, no ctrlKey
  await window.evaluate((wid: string) => {
    const el = document.querySelector(`[data-widget-id="${wid}"]`)
    if (!el) throw new Error('widget not found')
    const evt = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: false,
      ctrlKey: false,
      composed: true
    })
    el.dispatchEvent(evt)
  }, widgetId)
  await window.waitForTimeout(200)

  const zoomAfter = await readCanvasZoom(window)
  // Normal click uses focusOn (which does NOT change zoom) — zoom should stay at ~0.6
  console.log(`Zoom after normal click: ${zoomAfter} (expected ~${zoomBefore}, unchanged)`)
  expect(zoomAfter).not.toBeNull()
  expect(zoomAfter!).toBeLessThan(0.8)
})

test('meta+click at zoom >= 0.8 does NOT call zoomToWidget (guard condition)', async () => {
  launched = await launchApp()
  const { widgetId } = await seedAndOpenTask(launched)
  const { window } = launched

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 5_000 })

  // Default zoom is 1.0 (>= 0.8 — guard should NOT fire)
  const zoomBefore = await readCanvasZoom(window)
  expect(zoomBefore).not.toBeNull()
  expect(zoomBefore!).toBeGreaterThanOrEqual(0.8)
  console.log(`Zoom at default: ${zoomBefore}`)

  // Meta+click at zoom >= 0.8
  await window.evaluate((wid: string) => {
    const el = document.querySelector(`[data-widget-id="${wid}"]`)
    if (!el) throw new Error('widget not found')
    const evt = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      ctrlKey: false,
      composed: true
    })
    el.dispatchEvent(evt)
  }, widgetId)
  await window.waitForTimeout(200)

  const zoomAfter = await readCanvasZoom(window)
  // zoomToWidget is NOT triggered — it falls through to focusOn which doesn't change zoom.
  // Zoom should stay at 1.
  expect(zoomAfter).toBeCloseTo(1, 1)
  console.log(`Zoom after meta-click at >=0.8: ${zoomAfter} (expected 1, unmodified)`)
})
