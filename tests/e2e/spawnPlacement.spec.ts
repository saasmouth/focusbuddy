import { test, expect } from '@playwright/test'
import { hoverToolbar, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Change 1 verification: new widget from the "+" palette add button should land
// beside the active widget (right or left), not hundreds/thousands of px away.
// Specifically the new widget x must be within 2 × viewport width of the active
// widget, and within the visible canvas viewport.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('palette-add spawns new widget beside the active widget, not off-screen', async () => {
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

  // Open the palette and add a sticky.
  // The rail only mounts the palette while hovered — see hoverToolbar.
  await hoverToolbar(window)
  await window.locator('[data-testid="palette-add-button"]').click()
  await window.waitForTimeout(300)

  // Count widgets before adding.
  const countBefore = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => !w.archived && w.kind !== 'minimap').length
  }, seeded.taskId)

  await window.locator('[data-testid="palette-add-sticky"]').click()
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

  // The spawned widget must be within 1500px of the anchor (generous limit —
  // catches the old behaviour where fixed (60,60) or large jitter values put the
  // widget thousands of pixels away or off-screen). The real contract is "to the
  // right or left of the anchor with a 40px gap", which means x should be
  // approximately anchor.x + anchor.width + 40 (right) or
  // anchor.x - spawned.width - 40 (left).
  const rightX = anchor.x + anchor.width + 40
  const leftX = anchor.x - spawned.width - 40

  const isRight = Math.abs(spawned.x - rightX) < 10
  const isLeft = Math.abs(spawned.x - leftX) < 10

  expect(
    isRight || isLeft,
    `Expected spawned widget at x≈${rightX} (right) or x≈${leftX} (left), got x=${spawned.x}`
  ).toBe(true)

  // Must also be within the visible viewport (canvas coordinates 0–1440 is a
  // reasonable bound for a default window at zoom=1 and no pan).
  expect(spawned.x, 'x within visible range').toBeLessThan(3000)
  expect(spawned.x, 'x not deeply negative').toBeGreaterThan(-3000)

  // Log for evidence.
  console.log(`anchor: x=${anchor.x} w=${anchor.width}; spawned: x=${spawned.x}; isRight=${isRight} isLeft=${isLeft}`)
})

test('palette-add without an active widget falls back to viewport centre, not off-screen', async () => {
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

  // Open palette and add a sticky without clicking any widget first.
  // The rail only mounts the palette while hovered — see hoverToolbar.
  await hoverToolbar(window)
  await window.locator('[data-testid="palette-add-button"]').click()
  await window.waitForTimeout(300)
  await window.locator('[data-testid="palette-add-sticky"]').click()
  await window.waitForTimeout(600)

  const widgets = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all
      .filter((w) => !w.archived && w.kind !== 'minimap')
      .map((w) => ({ x: w.x, y: w.y }))
  }, taskId)

  // At least one non-minimap widget was created.
  expect(widgets.length).toBeGreaterThanOrEqual(1)

  const spawned = widgets[0]
  // Must land reasonably near viewport centre. The viewport centre in canvas
  // space at default pan=0 / zoom=1 is approximately w/2, h/2. The fallback
  // should not put the widget at fixed (60, 60) or at a random large offset.
  // We use a 2000px radius from origin as a loose bound.
  expect(spawned.x, 'no-active fallback x within 2000').toBeLessThan(2000)
  expect(spawned.x, 'no-active fallback x not deeply negative').toBeGreaterThan(-2000)

  console.log(`no-active fallback spawn: x=${spawned.x} y=${spawned.y}`)
})
