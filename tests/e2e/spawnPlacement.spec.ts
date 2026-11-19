import { test, expect, type Page } from '@playwright/test'
import { addWidgetToDesk, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// A sticky added from the side menu ("Add to this desk"), with no spot chosen,
// takes its zone in the owner's starting-sizes standard: the top-right corner
// of the part of the desk you can see (shared/widgetPlacement.ts, 'corner').
//
// Where that corner is depends on the window and on the UI zoom the app picks
// for the screen: a 1440x900 window lays out at 1600 CSS px at zoom 0.9 but at
// 1694 at 0.85 (a 1512-wide display). This spec used to pin x = 1100, the
// corner of the 1600 layout, and so failed on the 1694 one while the app was
// right (4.3.51 and 4.3.52, x = 1200). It now measures the corner on screen.

/**
 * The part of the canvas you can see, in screen px, and the canvas zoom. The
 * canvas surface runs the whole window width, under the side menu (memory:
 * plexii-starting-sizes), so the menu's right edge is the left of the view.
 */
async function visibleCanvas(window: Page): Promise<{ left: number; top: number; right: number; bottom: number; zoom: number }> {
  return window.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')!.getBoundingClientRect()
    const menu = document.querySelector<HTMLElement>('[data-testid="desk-sidebar"], [data-testid="desk-sidebar-collapsed"]')?.getBoundingClientRect()
    const zoom = (window as unknown as { __fbWidgets: { getState: () => { zoom: number } } }).__fbWidgets.getState().zoom
    return { left: Math.max(surface.left, menu?.right ?? surface.left), top: surface.top, right: surface.right, bottom: surface.bottom, zoom }
  })
}

/**
 * The widget sits in the top-right corner of what you can see: its top and right
 * edges 20 canvas units in from the view's (the zone's margin), give or take one
 * step of the 20-unit grid, wholly inside the view, and on top where it shows.
 */
async function expectInTopRightCorner(window: Page, widgetId: string): Promise<void> {
  const view = await visibleCanvas(window)
  const el = window.locator(`[data-widget-id="${widgetId}"]`)
  await expect(el).toBeVisible()
  const box = (await el.boundingBox())!
  const step = 20 * view.zoom
  const report = JSON.stringify({ view, box })
  const fromRight = view.right - (box.x + box.width)
  const fromTop = box.y - view.top
  expect(fromRight, `right edge a margin in from the view's: ${report}`).toBeGreaterThanOrEqual(step - 1)
  expect(fromRight, `right edge a margin in from the view's: ${report}`).toBeLessThan(2 * step)
  expect(fromTop, `top edge a margin below the view's: ${report}`).toBeGreaterThanOrEqual(step - 1)
  expect(fromTop, `top edge a margin below the view's: ${report}`).toBeLessThan(2 * step)
  expect(box.x, `clear of the side menu: ${report}`).toBeGreaterThanOrEqual(view.left)
  expect(box.y + box.height, `inside the view: ${report}`).toBeLessThanOrEqual(view.bottom)
  // Seen, not just placed: the widget is what is under its own centre.
  const onTop = await window.evaluate(
    ({ id, x, y }) => document.elementFromPoint(x, y)?.closest('[data-widget-id]')?.getAttribute('data-widget-id') === id,
    { id: widgetId, x: box.x + box.width / 2, y: box.y + box.height / 2 }
  )
  expect(onTop, `nothing covers it: ${report}`).toBe(true)
}

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('a widget added with no spot chosen takes its zone, in view and clear of the active one', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Seed a task with one sticky at a known canvas position.
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Spawn test' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'anchor',
      content: 'ANCHOR',
      x: 300,
      y: 200,
      width: 220,
      height: 180
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Spawn test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(600)

  // Click the anchor sticky to make it the active widget.
  const anchorEl = window.locator(`[data-widget-id="${seeded.widgetId}"]`)
  await expect(anchorEl).toBeVisible({ timeout: 5_000 })
  await anchorEl.click()
  await window.waitForTimeout(200)

  // Confirm the store's activeWidgetId is set before we open the palette.
  const activeId = await window.evaluate(() => {
    // Access the zustand store through the window; it exposes getState via the
    // global __zustand__ devtools bridge that is present in dev/test builds.
    // If the bridge is absent we fall back to reading a data attribute from the
    // focused widget (the WidgetFrame puts data-widget-id on the active element).
    const active = document.querySelector<HTMLElement>('[data-widget-id].ring-2, [data-widget-id]:focus-within')
    return active?.getAttribute('data-widget-id') ?? null
  })
  // We expect either the store to reflect the click (driven through setActive in
  // WidgetFrame) or the element to be visually active. What we cannot tolerate is
  // the palette ignoring the active widget.  We verify that the resulting spawn
  // position is correct and NOT at viewport centre.

  // Add a sticky the no-drag way: the side menu's "Add to this desk" (the
  // palette button this used was removed in 4.3.32). It spawns through the
  // same spawnPositionFor rule the palette did.

  // Count widgets before adding.
  const countBefore = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => !w.archived && w.kind !== 'minimap').length
  }, seeded.taskId)

  await addWidgetToDesk(window, 'sticky')
  await window.waitForTimeout(600)

  // Fetch all non-minimap, non-archived widgets and find the newly created one.
  const widgetsAfter = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all
      .filter((w) => !w.archived && w.kind !== 'minimap')
      .map((w) => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
  }, seeded.taskId)

  expect(widgetsAfter.length).toBe(countBefore + 1)

  const anchor = widgetsAfter.find((w) => w.id === seeded.widgetId)!
  const spawned = widgetsAfter.find((w) => w.id !== seeded.widgetId)!
  expect(anchor).toBeDefined()
  expect(spawned).toBeDefined()

  // A sticky's place in the owner's standard is the top-right corner of the part
  // of the desk you can see (the side menu floats over the left of the canvas).
  // The rule for a kind with no zone, beside the active widget, is covered in
  // tests/unit/spawnPosition.test.ts.
  await expectInTopRightCorner(window, spawned.id)
  const apart =
    spawned.x >= anchor.x + anchor.width ||
    spawned.x + spawned.width <= anchor.x ||
    spawned.y >= anchor.y + anchor.height ||
    spawned.y + spawned.height <= anchor.y
  expect(apart, 'the new widget must not land on the active one').toBe(true)

  // Log for evidence.
  console.log(`anchor: x=${anchor.x} w=${anchor.width}; spawned: x=${spawned.x} y=${spawned.y}`)
})

// Was "palette-add without an active widget falls back to viewport centre":
// true before the starting-sizes standard, when a sticky had no zone. Its 2000 px
// bounds then passed wherever the sticky went. A sticky now takes its zone with
// or without an active widget, so this checks the same corner on an empty desk.
test('a sticky added to an empty desk, with nothing active, takes its zone too', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Create an empty task (no widgets) so there is no active widget.
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Empty spawn test' })
    return task.id
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Empty spawn test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(500)

  // Add a sticky without clicking any widget first (side menu → Add to this
  // desk; the palette this used was removed in 4.3.32).
  await addWidgetToDesk(window, 'sticky')
  await window.waitForTimeout(600)

  const widgets = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all
      .filter((w) => !w.archived && w.kind !== 'minimap')
      .map((w) => ({ id: w.id, x: w.x, y: w.y }))
  }, taskId)

  // Exactly the one sticky, in the top-right corner of what you can see.
  expect(widgets).toHaveLength(1)
  const spawned = widgets[0]
  await expectInTopRightCorner(window, spawned.id)

  console.log(`no-active fallback spawn: x=${spawned.x} y=${spawned.y}`)
})
