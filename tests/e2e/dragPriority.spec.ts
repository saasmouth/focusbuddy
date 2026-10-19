import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Drag priority: dropping a free widget on top of another free widget keeps
// the DROPPED widget at (or near) the drop point and pushes the overlapping
// NEIGHBOUR out of the way. This is the inverse of the old behaviour, which
// relocated the dropped widget instead. See sectionGeometry.ts
// (resolvePushFromAnchor) and WidgetFrame.tsx's canvas-drop block.
//
// Real pointer drag on react-rnd is used here (not the DOM drag-event style
// used in dragDrop.spec.ts, which is for HTML5 dataTransfer drops from the
// sidebar) — mouse down on .widget-handle, move in steps, mouse up. Canvas
// zoom/pan default to 1/0 on a fresh task, so screen-pixel deltas map 1:1 to
// stored widget x/y deltas.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedWidgetsAndOpen(
  l: LaunchedApp,
  positions: Array<{ x: number; y: number; width: number; height: number }>
): Promise<{ taskId: string; ids: string[] }> {
  const { window } = l
  await waitForReady(window)
  const seeded = await window.evaluate(async (pts) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Drag priority test' })
    const ids: string[] = []
    for (let i = 0; i < pts.length; i++) {
      const w = await api.widgets.create({
        taskId: task.id,
        kind: 'sticky',
        title: `w${i}`,
        content: `w${i}`,
        x: pts[i].x,
        y: pts[i].y,
        width: pts[i].width,
        height: pts[i].height
      })
      ids.push(w.id)
    }
    return { taskId: task.id, ids }
  }, positions)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Drag priority test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  for (const id of seeded.ids) {
    await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 5_000 })
  }
  await window.waitForTimeout(250)
  return seeded
}

async function listWidgets(
  l: LaunchedApp,
  taskId: string
): Promise<Array<{ id: string; x: number; y: number; width: number; height: number }>> {
  return l.window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.map((w) => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
  }, taskId)
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return !(a.x + a.width <= b.x || a.x >= b.x + b.width || a.y + a.height <= b.y || a.y >= b.y + b.height)
}

// Real pointer drag via Playwright's CDP mouse API, kept for reference /
// future retry — see dispatchDragBy below for the mechanism that actually
// drives react-draggable (react-rnd's engine) reliably in this harness.
async function dragWidgetBy(l: LaunchedApp, widgetId: string, dx: number, dy: number): Promise<void> {
  const { window } = l
  await waitForReady(window)
  const handle = window.locator(`[data-widget-id="${widgetId}"] .widget-handle`)
  const box = await handle.boundingBox()
  if (!box) throw new Error(`no bounding box for widget-handle of ${widgetId}`)
  const startX = box.x + box.width / 2
  const startY = box.y + Math.min(20, box.height / 2)
  await window.mouse.move(startX, startY)
  await window.mouse.down()
  await window.mouse.move(startX + 6, startY + 6, { steps: 3 })
  await window.waitForTimeout(80)
  const steps = 20
  for (let i = 1; i <= steps; i++) {
    await window.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps, { steps: 3 })
    await window.waitForTimeout(15)
  }
  await window.waitForTimeout(80)
  await window.mouse.up()
  await window.waitForTimeout(400)
}

// react-draggable (react-rnd's drag engine) attaches its own mousedown
// listener on the handle node, then adds document-level mousemove/mouseup
// listeners imperatively. Playwright's CDP-level mouse.move/down/up (used
// above) doesn't reliably reach those in headless Electron — a limitation
// already called out in sectionDragEject.spec.ts ("Full Playwright native
// drag of Rnd is unreliable in headless Electron"). Dispatching real
// MouseEvent objects in-page (bubbles:true, button:0) reaches both React's
// delegated listener on the handle AND DraggableCore's document listeners,
// which is what actually exercises the commitDrop/resolvePushFromAnchor
// code path deterministically.
async function dispatchDragBy(l: LaunchedApp, widgetId: string, dx: number, dy: number): Promise<void> {
  await l.window.evaluate(
    async ({ widgetId, dx, dy }) => {
      const handle = document.querySelector(`[data-widget-id="${widgetId}"] .widget-handle`) as HTMLElement | null
      if (!handle) throw new Error('no widget-handle found')
      const box = handle.getBoundingClientRect()
      const startX = box.left + box.width / 2
      const startY = box.top + Math.min(20, box.height / 2)
      const fire = (target: EventTarget, type: string, x: number, y: number): void => {
        target.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y })
        )
      }
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      fire(handle, 'mousedown', startX, startY)
      await sleep(20)
      const steps = 20
      for (let i = 1; i <= steps; i++) {
        fire(document, 'mousemove', startX + (dx * i) / steps, startY + (dy * i) / steps)
        await sleep(10)
      }
      await sleep(20)
      fire(document, 'mouseup', startX + dx, startY + dy)
    },
    { widgetId, dx, dy }
  )
  await l.window.waitForTimeout(400)
}

test('dropping a widget on top of a neighbour keeps the dropped widget put and pushes the neighbour clear', async () => {
  launched = await launchApp()
  const consoleErrors: string[] = []
  launched.window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  const A = { x: 60, y: 60, width: 200, height: 150 }
  const B = { x: 600, y: 60, width: 200, height: 150 }
  const { taskId, ids } = await seedWidgetsAndOpen(launched, [A, B])
  const [idA, idB] = ids

  const before = await listWidgets(launched, taskId)
  const bBefore = before.find((w) => w.id === idB)!
  expect(overlaps({ ...A }, bBefore)).toBe(false)

  // Drag A from (60,60) so its top-left lands on top of B, i.e. delta of
  // (540, 40) → target top-left ~ (600, 100), squarely inside B's rect.
  const dx = 540
  const dy = 40
  await dispatchDragBy(launched, idA, dx, dy)

  const after = await listWidgets(launched, taskId)
  const aAfter = after.find((w) => w.id === idA)!
  const bAfter = after.find((w) => w.id === idB)!

  // Core inversion: A ends up at (or very near) the drop point — not
  // relocated elsewhere. Some slack for handle-grab-point rounding.
  expect(Math.abs(aAfter.x - (A.x + dx))).toBeLessThanOrEqual(20)
  expect(Math.abs(aAfter.y - (A.y + dy))).toBeLessThanOrEqual(20)

  // B moved (it was in the way) and no longer overlaps A.
  expect(bAfter.x !== bBefore.x || bAfter.y !== bBefore.y).toBe(true)
  expect(overlaps(aAfter, bAfter)).toBe(false)

  // Only fail on errors that look drag/geometry related — a stray 404 for an
  // unrelated resource (favicon, font, etc.) is harness noise, not a product
  // bug in the drag-priority change under test.
  const relevantErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e))
  expect(relevantErrors, `console errors during drag: ${relevantErrors.join(' | ')}`).toEqual([])
})

test('dropping a widget into clear space does not move anything else', async () => {
  launched = await launchApp()
  const A = { x: 60, y: 60, width: 180, height: 120 }
  const B = { x: 500, y: 400, width: 180, height: 120 }
  const { taskId, ids } = await seedWidgetsAndOpen(launched, [A, B])
  const [idA, idB] = ids

  const before = await listWidgets(launched, taskId)
  const bBefore = before.find((w) => w.id === idB)!

  // Move A to (300, 60) — nowhere near B (500,400) — plenty of clearance.
  await dispatchDragBy(launched, idA, 240, 0)

  const after = await listWidgets(launched, taskId)
  const aAfter = after.find((w) => w.id === idA)!
  const bAfter = after.find((w) => w.id === idB)!

  expect(Math.abs(aAfter.x - (A.x + 240))).toBeLessThanOrEqual(20)
  expect(Math.abs(aAfter.y - A.y)).toBeLessThanOrEqual(20)
  // B untouched.
  expect(bAfter.x).toBe(bBefore.x)
  expect(bAfter.y).toBe(bBefore.y)
})
