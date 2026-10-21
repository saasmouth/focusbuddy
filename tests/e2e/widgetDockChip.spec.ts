import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// WidgetDock chip click behavior (post-change):
//
//   BEFORE: clicking a dock chip opened the widget in FOCUS MODE (setFocused).
//   AFTER:  clicking a dock chip calls zoomToWidget(id), which sets zoom=1,
//           activeWidgetId=id, and bumps centerToken so the canvas pans to
//           center on that widget. Focus mode is NOT opened.
//
// The active chip is highlighted via activeWidgetId (NOT focusedWidgetId).
//
// Also verifies: a 'living-doc' widget is rendered as a normal canvas item
// (data-widget-id present on the canvas surface) without entering focus mode.
//
// Assertions read pan/zoom from the canvas transform element (same approach
// as zoomToWidget.spec.ts). Focus mode presence is detected via its unique
// "Close focus mode" button (aria-label on WidgetFocusMode's close button).

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Read the current transform from the inner canvas div.
// Returns { panX, panY, zoom } parsed from "translate(Xpx, Ypx) scale(Z)".
async function readCanvasTransform(
  window: import('@playwright/test').Page
): Promise<{ panX: number; panY: number; zoom: number } | null> {
  return window.evaluate(() => {
    const all = Array.from(document.querySelectorAll<HTMLElement>('[data-bare-canvas]'))
    const inner = all.find((el) => !el.hasAttribute('data-canvas-surface'))
    if (!inner) return null
    const t = inner.style.transform
    const mScale = t.match(/scale\(([0-9.]+)\)/)
    const mTranslate = t.match(/translate\(([-.0-9]+)px,\s*([-.0-9]+)px\)/)
    if (!mScale || !mTranslate) return null
    return {
      panX: parseFloat(mTranslate[1]),
      panY: parseFloat(mTranslate[2]),
      zoom: parseFloat(mScale[1])
    }
  })
}

// Return true when the WidgetFocusMode overlay is currently mounted.
// We detect it via the "Close focus mode" button that WidgetFocusMode
// always renders (aria-label="Close focus mode").
async function isFocusModeOpen(window: import('@playwright/test').Page): Promise<boolean> {
  const btn = window.getByRole('button', { name: 'Close full view' })
  return btn.isVisible().catch(() => false)
}

// Collapse the assistant rail — best-effort after the canvas is open.
async function collapseRail(window: import('@playwright/test').Page): Promise<void> {
  const hide = window.getByRole('button', { name: 'Hide assistant panel' })
  if (await hide.isVisible().catch(() => false)) await hide.click().catch(() => {})
  await window.waitForTimeout(150)
}

// ── Test 1 + 2 + 3: dock chip centers widget, zoom resets, focus mode absent ──

test('dock chip calls zoomToWidget: camera centers on the far widget, focus mode stays closed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Seed a task with two widgets far apart.
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Dock chip test' })
    const near = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'near widget',
      x: 100,
      y: 100,
      width: 240,
      height: 180
    })
    const far = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'far widget',
      x: 3000,
      y: 2200,
      width: 240,
      height: 180
    })
    return { taskId: task.id, nearId: near.id, farId: far.id }
  })

  // Reload so the task appears in the sidebar.
  await window.reload()
  await waitForReady(window)

  // Navigate to the task.
  await window.getByRole('button', { name: 'Dock chip test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await collapseRail(window)

  // Both chips must appear in the dock ("On desk" row).
  const dockLabel = window.locator('text=On desk')
  await expect(dockLabel).toBeVisible({ timeout: 5_000 })

  await expect(window.locator('button[title*="near widget"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('button[title*="far widget"]')).toBeVisible({ timeout: 5_000 })

  // Capture transform BEFORE clicking the far-widget chip.
  const before = await readCanvasTransform(window)
  console.log('Transform before dock click:', before)
  expect(before).not.toBeNull()

  // Confirm focus mode is closed before the click.
  expect(await isFocusModeOpen(window)).toBe(false)

  // Click the far-widget dock chip. The floating Quick Actions toolbar can
  // sit above the dock and intercept Playwright's synthesized pointer events,
  // so we dispatch the click directly on the button element.
  await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const chip = btns.find((b) => b.title && b.title.includes('far widget'))
    if (!chip) throw new Error('far widget dock chip not found')
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await window.waitForTimeout(400)

  // Read transform after click.
  const after = await readCanvasTransform(window)
  console.log('Transform after dock click:', after)
  expect(after).not.toBeNull()

  // zoomToWidget explicitly sets zoom=1.
  expect(after!.zoom).toBeCloseTo(1, 1)

  // Pan must have changed — the canvas moved to center the far widget at x:3000,y:2200.
  const panChanged = after!.panX !== before!.panX || after!.panY !== before!.panY
  console.log('Pan changed:', panChanged, 'before:', before, 'after:', after)
  expect(panChanged).toBe(true)

  // Focus mode must NOT have opened.
  expect(await isFocusModeOpen(window)).toBe(false)
})

// ── Test 4: active chip highlight reflects activeWidgetId ─────────────────────

test('dock chip for the navigated-to widget gets the active highlight class', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Dock active test' })
    const w1 = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'alpha widget',
      x: 100,
      y: 100,
      width: 240,
      height: 180
    })
    const w2 = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'beta widget',
      x: 2500,
      y: 1800,
      width: 240,
      height: 180
    })
    return { taskId: task.id, w1Id: w1.id, w2Id: w2.id }
  })

  await window.reload()
  await waitForReady(window)

  await window.getByRole('button', { name: 'Dock active test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await collapseRail(window)

  // Dispatch click directly — the Quick Actions toolbar can intercept
  // Playwright's synthesized pointer events when it overlaps the dock.
  await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const chip = btns.find((b) => b.title && b.title.includes('beta widget'))
    if (!chip) throw new Error('beta widget dock chip not found')
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await window.waitForTimeout(300)

  // The active chip uses border-stone-900 (light mode) per the WidgetDock JSX.
  const betaChipClasses = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const chip = btns.find((b) => b.title && b.title.includes('beta widget'))
    return chip ? chip.className : ''
  })
  console.log('Beta chip classes after click:', betaChipClasses)
  expect(betaChipClasses).toContain('border-stone-900')

  // Alpha chip must NOT have the active styling.
  const alphaChipClasses = await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const chip = btns.find((b) => b.title && b.title.includes('alpha widget'))
    return chip ? chip.className : ''
  })
  console.log('Alpha chip classes (should be inactive):', alphaChipClasses)
  expect(alphaChipClasses).not.toContain('border-stone-900')
})

// ── Test 5: living-doc renders on canvas, not only in focus mode ───────────────

test('living-doc widget renders as a canvas item with data-widget-id on the surface', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Living doc canvas test'
    })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'living-doc',
      title: 'Living Doc',
      content: '',
      x: 300,
      y: 300,
      width: 500,
      height: 400
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await waitForReady(window)

  await window.getByRole('button', { name: 'Living doc canvas test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await collapseRail(window)

  // The widget MUST be on the canvas — renderWidget has case 'living-doc'
  // so it renders inside WidgetFrame on the canvas surface, not only in focus mode.
  await window.waitForSelector(`[data-widget-id="${ids.widgetId}"]`, { timeout: 5_000 })

  // The setup state input must be visible (no brief was set).
  await expect(window.locator('[data-testid="livingdoc-brief-input"]')).toBeVisible({ timeout: 5_000 })

  // Focus mode must NOT have opened automatically.
  expect(await isFocusModeOpen(window)).toBe(false)

  console.log(`Living-doc widget ${ids.widgetId} is present on canvas in setup state.`)
})

// ── Test 6: living-doc dock chip uses zoomToWidget, not focus mode ─────────────

test('clicking the living-doc dock chip centers the canvas widget, does not open focus mode', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Living doc dock chip test'
    })
    // Place the living-doc far from origin so the camera must move.
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'living-doc',
      title: 'My Living Doc',
      content: '',
      x: 2800,
      y: 2000,
      width: 500,
      height: 400
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await waitForReady(window)

  await window.getByRole('button', { name: 'Living doc dock chip test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await collapseRail(window)

  // The living doc chip title follows the "Go to <label> on the canvas" template.
  await expect(window.locator('button[title*="My Living Doc"]')).toBeVisible({ timeout: 5_000 })

  const before = await readCanvasTransform(window)
  expect(before).not.toBeNull()
  expect(await isFocusModeOpen(window)).toBe(false)

  await window.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    const chip = btns.find((b) => b.title && b.title.includes('My Living Doc'))
    if (!chip) throw new Error('My Living Doc dock chip not found')
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await window.waitForTimeout(400)

  const after = await readCanvasTransform(window)
  console.log('Living-doc dock chip: transform before', before, 'after', after)
  expect(after).not.toBeNull()
  expect(after!.zoom).toBeCloseTo(1, 1)

  // Camera must have moved toward the far widget.
  const panChanged = after!.panX !== before!.panX || after!.panY !== before!.panY
  expect(panChanged).toBe(true)

  // Focus mode must remain closed.
  expect(await isFocusModeOpen(window)).toBe(false)
})
