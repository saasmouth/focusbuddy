import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Regression check: the LinkOverlay (the fixed-position SVG that draws
// widget-link bezier curves) must NOT cover the sidebar / chrome —
// only the canvas surface area. Without the clip-path fix, bezier
// curves rendered straight across the sidebar.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('LinkOverlay clips to the canvas surface — does not cover sidebar', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  // Seed a task; the canvas mount is what mounts LinkOverlay.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Clip test'
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'clip-check',
      x: 200,
      y: 200,
      width: 240,
      height: 200
    })
  })
  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'Clip test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // The LinkOverlay's clip-path should be set to the canvas surface
  // bounds. Read the computed style and the canvas bbox; verify the
  // clip's left inset matches the canvas surface's left position.
  const result = await window.evaluate(() => {
    const overlay = document.querySelector('[data-link-overlay]') as HTMLElement | null
    const surface = document.querySelector('[data-canvas-surface="true"]') as HTMLElement | null
    if (!overlay || !surface) return null
    const computed = window.getComputedStyle(overlay)
    const r = surface.getBoundingClientRect()
    return {
      clipPath: computed.clipPath || (computed as unknown as Record<string, string>).webkitClipPath,
      canvasLeft: r.left,
      canvasTop: r.top
    }
  })

  expect(result).not.toBeNull()
  expect(result!.clipPath).toBeTruthy()
  // The clip-path should contain an inset that includes the canvas
  // surface's left position. If the canvas surface starts at e.g.
  // 280px (after sidebar), the clip-path's left inset must be ~280px,
  // NOT 0 — which would mean we're still drawing over the sidebar.
  // Allow for sub-pixel rounding.
  const m = result!.clipPath?.match(/inset\(([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px\)/)
  expect(m).not.toBeNull()
  const leftInset = m ? Number(m[4]) : 0
  expect(leftInset).toBeGreaterThanOrEqual(Math.max(0, result!.canvasLeft - 1))
  expect(leftInset).toBeLessThanOrEqual(result!.canvasLeft + 1)
})
