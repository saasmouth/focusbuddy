import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// WidgetFrame header +/− buttons:
//   - "Grow widget" multiplies w/h by 1.5 (capped 1400 × 900)
//   - "Shrink widget" multiplies w/h by 1/1.5 (floored 180 × 120)
//   - Operations are symmetric inverses: grow then shrink returns the
//     widget to its original dimensions within sub-pixel rounding
//
// We trigger the button via document.querySelector + .click() rather than
// Playwright's locator click — once the widget grows, the resize buttons
// can end up under the right-side sidebar's screen rect, and Playwright's
// coord-based click (even with force:true) lands on the sidebar instead.
// Direct DOM click bypasses every overlay and dispatches the React onClick
// against the actual button element, which is what a user's click would
// fundamentally trigger through React's synthetic-event delegation.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedAndOpenStickyWidget(launched: LaunchedApp): Promise<{
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

  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Resize test'
    })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'resize me',
      x: 200,
      y: 200,
      width: 320,
      height: 240
    })
    return { taskId: task.id, widgetId: w.id, initialW: w.width, initialH: w.height }
  })

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
  await waitForReady(window)
  await window.evaluate(
    ({ testid }: { testid: string }) => {
      const btn = document.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)
      if (!btn) throw new Error(`No button: ${testid}`)
      btn.click()
    },
    { testid: `widget-${direction}-${widgetId}` }
  )
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

  // Sanity: the test-id'd buttons are mounted in the DOM.
  await launched.window.waitForSelector(
    `[data-testid="widget-grow-${widgetId}"]`,
    { timeout: 5_000 }
  )

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
  await launched.window.waitForSelector(
    `[data-testid="widget-shrink-${widgetId}"]`,
    { timeout: 5_000 }
  )

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

test('Grow button respects MAX_W/MAX_H cap (1400 × 900)', async () => {
  launched = await launchApp()
  const { widgetId, taskId } = await seedAndOpenStickyWidget(launched)
  await launched.window.waitForSelector(
    `[data-testid="widget-grow-${widgetId}"]`,
    { timeout: 5_000 }
  )

  for (let i = 0; i < 8; i++) {
    await clickResizeButton(launched, 'grow', widgetId)
    await launched.window.waitForTimeout(80)
  }
  const final = await readWidget(launched, widgetId, taskId)
  expect(final).not.toBeNull()
  expect(final!.width).toBeLessThanOrEqual(1400)
  expect(final!.height).toBeLessThanOrEqual(900)
  // Sanity that growth actually happened.
  expect(final!.width).toBeGreaterThan(900)
})
