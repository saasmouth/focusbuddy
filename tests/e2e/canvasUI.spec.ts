import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp } from './_helpers'

// Regression check: minimap visible + edge-pan engages when cursor
// approaches the canvas margin.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('minimap renders + edge-pan moves the canvas', async () => {
  launched = await launchApp()
  const { window } = launched

  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skipBtn = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click().catch(() => {})
  }

  // Seed a task + a sticky widget so the canvas has something on it.
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Canvas UI regression'
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'edge-pan source',
      x: 400,
      y: 300,
      width: 240,
      height: 200
    })
    return { taskId: task.id }
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skipBtn2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skipBtn2.isVisible().catch(() => false)) {
    await skipBtn2.click().catch(() => {})
  }

  await window.getByRole('button', { name: 'Canvas UI regression' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // 1. The minimap is present as built-in chrome.
  //
  //    It used to be a regular widget kind ('minimap') auto-created pinned to
  //    BR on first task open. It is now a FAB, and Canvas actively REMOVES any
  //    legacy minimap widget it finds (see the migration sweep in Canvas.tsx),
  //    so asserting a kind=minimap widget exists now asserts the opposite of
  //    what the app does. Its anchoring is covered by canvasSurfaceAnchor
  //    CS-1 and its open/close behaviour by minimapFab.spec.ts.
  await window.waitForTimeout(500)
  await expect(window.locator('[data-minimap-fab]')).toHaveCount(1)

  // 2. Edge-pan: capture initial panX, mouse-move toward the right edge
  //    for ~600ms, expect panX to have decreased (canvas moves left to
  //    bring more of the world into view on the right).
  const before = await window.evaluate(() => {
    const w = (window as unknown as { useWidgetStore?: { getState: () => { panX: number } } })
    const state = w.useWidgetStore?.getState?.()
    return state ? state.panX : null
  })
  // useWidgetStore isn't on window — read via a more direct route.
  const beforePan = await window.evaluate(() => {
    // The canvas surface itself shows the transform in its child div.
    const inner = document.querySelector('[data-canvas-surface="true"] [data-bare-canvas]') as HTMLElement | null
    if (!inner) return null
    return inner.style.transform
  })
  expect(beforePan).toContain('translate')

  // Hover the right edge of the canvas surface.
  const surface = window.locator('[data-canvas-surface="true"]')
  const box = await surface.boundingBox()
  if (!box) throw new Error('No canvas surface bounding box')
  // Move the cursor to within 10px of the right edge, then hold for ~600ms.
  await window.mouse.move(box.x + box.width - 10, box.y + box.height / 2)
  await window.waitForTimeout(800)

  const afterPan = await window.evaluate(() => {
    const inner = document.querySelector('[data-canvas-surface="true"] [data-bare-canvas]') as HTMLElement | null
    return inner ? inner.style.transform : null
  })

  // The translate's X component should have changed if edge-pan fired.
  expect(afterPan).not.toEqual(beforePan)
  // Also explicitly confirm panX moved negative (camera scrolled right).
  const extractTx = (s: string | null): number | null => {
    if (!s) return null
    const m = s.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
    return m ? Number(m[1]) : null
  }
  const beforeX = extractTx(beforePan)
  const afterX = extractTx(afterPan)
  if (beforeX !== null && afterX !== null) {
    expect(afterX).toBeLessThan(beforeX)
  }

  void seeded
})
