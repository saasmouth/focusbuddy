import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// PLX-APP-010 Phase 2 (ADR-0006) — driven through the REAL UI, complementing the
// store-driven contract spec (deskLayoutObjectOverlay.spec.ts):
//   1. Right-click the bare canvas shows "Customise this device's layout"; a real
//      click toggles it (label + checkbox icon flip), no console/page errors.
//   2. With it ON, a real mouse drag (dispatched pointer events on the actual
//      .widget-handle DOM node — see dragPriority.spec.ts's dispatchDragBy, the
//      established mechanism for driving react-rnd reliably in headless
//      Electron) moves a top-level sticky; switching Desks away and back
//      restores the moved position from the personal overlay.
//   3. Toggling OFF via the real menu reverts the sticky to the shared position.
//   4. A real drag + real Cmd-Z / Cmd-Shift-Z (keyboard undo/redo, the same combo
//      undoKeyboard.spec.ts proves for the global handler) both with the overlay
//      OFF (regression: unchanged from shipping behaviour) and ON (the reversal
//      lands back in the overlay; the shared base is never touched by either the
//      move or its undo).
//
// Desk navigation between the drag and the restore-check uses the view-store
// handle (matches deskLayoutCameraOverlay.spec.ts's documented convention,
// avoiding the Home-dashboard grid's flaky variable-suffix button names) so the
// real GESTURES under test — right-click, menu click, pointer drag, keyboard
// undo — stay fully UI-driven.

function trackErrors(window: Page): string[] {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  return errors
}
function relevantErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.includes('Failed to load resource'))
}

async function openDesk(window: Page, deskId: string): Promise<void> {
  await window.evaluate((tid) => {
    const w = window as unknown as {
      __fbNodes?: { getState: () => { setActive: (id: string) => void } }
      __fbView?: { getState: () => { goTask: (id: string) => void } }
    }
    w.__fbNodes?.getState().setActive(tid)
    w.__fbView?.getState().goTask(tid)
  }, deskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
}

// Real right-click on an empty patch of the canvas (must avoid any widget so
// the event target itself carries data-bare-canvas — handleCanvasContextMenu
// in Canvas.tsx requires that, not a bubbled child).
async function openCanvasMenu(window: Page): Promise<void> {
  await window.locator('[data-canvas-surface="true"]').click({ button: 'right', position: { x: 900, y: 560 } })
  await window.waitForSelector('[role="menu"].fb-context-menu', { timeout: 4_000 })
}

function customiseItem(window: Page) {
  return window.locator('[role="menu"].fb-context-menu [role="menuitem"]').filter({
    hasText: /Customise this device's layout|Stop customising this device's layout/
  })
}

// Real pointer drag: mousedown on the widget's .widget-handle, a run of
// mousemove events on document, mouseup — dispatched as genuine MouseEvents on
// the live DOM nodes so both React's delegated listener and DraggableCore's
// document-level listeners fire, exactly as dragPriority.spec.ts established
// for headless Electron (Playwright's CDP mouse API doesn't reliably reach
// react-rnd's own listeners in this harness).
async function dragWidgetBy(window: Page, widgetId: string, dx: number, dy: number): Promise<void> {
  await window.evaluate(
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
  await window.waitForTimeout(200)
}

async function widgetScreenBox(
  window: Page,
  widgetId: string
): Promise<{ x: number; y: number }> {
  const box = await window.locator(`[data-widget-id="${widgetId}"]`).boundingBox()
  if (!box) throw new Error(`no bounding box for widget ${widgetId}`)
  return { x: Math.round(box.x), y: Math.round(box.y) }
}

async function baseWidgetXY(window: Page, deskId: string, widgetId: string): Promise<{ x: number; y: number }> {
  return window.evaluate(
    async ({ deskId, widgetId }) => {
      const list = (await window.api.widgets.listByTask(deskId)) as Array<{ id: string; x: number; y: number }>
      const w = list.find((x) => x.id === widgetId)!
      return { x: w.x, y: w.y }
    },
    { deskId, widgetId }
  )
}

async function overlayObjects(
  window: Page,
  deskId: string
): Promise<{ customLayout: boolean; objects: Array<{ objectId: string; x: number; y: number }> } | null> {
  return window.evaluate(async (id) => {
    const l = await window.api.deskLayout.load('local', id, 'desktop')
    return l ? { customLayout: l.customLayout === true, objects: l.objects } : null
  }, deskId)
}

// Real Shift+mousedown->mouseup on the widget header (react-rnd's drag
// handle), exactly as multiSelect.spec.ts's shiftClick — this is the gesture
// that exercises react-rnd's onDragStart shift-select branch, not a synthetic
// click.
async function shiftClick(window: Page, widgetId: string): Promise<void> {
  const pt = await window.evaluate((wid: string) => {
    const h = document.querySelector(`[data-widget-id="${wid}"] .widget-handle`)
    const target = h ?? document.querySelector(`[data-widget-id="${wid}"]`)
    const b = (target as HTMLElement).getBoundingClientRect()
    return { x: b.left + 26, y: b.top + (h ? b.height / 2 : 44) }
  }, widgetId)
  await window.keyboard.down('Shift')
  await window.mouse.click(pt.x, pt.y)
  await window.keyboard.up('Shift')
  await window.waitForTimeout(150)
}

test('CUSTOMISE-MENU — real right-click shows the toggle; a real click flips label + checkbox icon; no errors', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const errors = trackErrors(window)
    const seeded = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.nodes.create({ parentId: null, kind: 'task', title: 'Menu UI Desk' })
      return { deskId: a.id }
    })
    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: /Menu UI Desk/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

    // OFF by default: unchecked box.
    await openCanvasMenu(window)
    const item = customiseItem(window)
    await expect(item).toHaveText(/Customise this device's layout/)
    await expect(item.locator('.material-symbols-outlined')).toHaveText('check_box_outline_blank')

    // Real click toggles it ON.
    await item.click()
    await window.waitForTimeout(300)

    await openCanvasMenu(window)
    const item2 = customiseItem(window)
    await expect(item2).toHaveText(/Stop customising this device's layout/)
    await expect(item2.locator('.material-symbols-outlined')).toHaveText('check_box')

    // Real click toggles it back OFF.
    await item2.click()
    await window.waitForTimeout(300)
    await openCanvasMenu(window)
    const item3 = customiseItem(window)
    await expect(item3).toHaveText(/Customise this device's layout/)
    await expect(item3.locator('.material-symbols-outlined')).toHaveText('check_box_outline_blank')
    await window.keyboard.press('Escape')

    const ov = await overlayObjects(window, seeded.deskId)
    expect(ov?.customLayout, 'ends OFF after on/off toggle').toBe(false)

    expect(relevantErrors(errors), `unexpected errors: ${JSON.stringify(relevantErrors(errors))}`).toEqual([])
  } finally {
    await dispose()
  }
})

test('CUSTOMISE-DRAG — real drag while opted in restores on reopen; real toggle-off reverts; base row never moves', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const errors = trackErrors(window)
    const seeded = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.nodes.create({ parentId: null, kind: 'task', title: 'Drag UI Desk A' })
      const b = await api.nodes.create({ parentId: null, kind: 'task', title: 'Drag UI Desk B' })
      const w = await api.widgets.create({
        taskId: a.id,
        kind: 'sticky',
        title: '',
        content: 'drag me for real',
        x: 60,
        y: 60,
        width: 220,
        height: 160
      })
      return { deskAId: a.id, deskBId: b.id, widgetId: w.id }
    })
    // Snap-to-grid is on by default since 2212d6f6 and would round the drop
    // (190 -> 200); these assert the overlay round-trip, not the grid, so drag free.
    await window.evaluate(() => localStorage.setItem('fb.canvas.snap', '0'))
    await window.reload()
    await waitForReady(window)
    await openDesk(window, seeded.deskAId)
    await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 5_000 })
    await window.waitForTimeout(250)

    // Real menu toggle ON.
    await openCanvasMenu(window)
    await customiseItem(window).click()
    await window.waitForTimeout(200)

    const before = await widgetScreenBox(window, seeded.widgetId)
    const dx = 260
    const dy = 190
    await dragWidgetBy(window, seeded.widgetId, dx, dy)
    const after = await widgetScreenBox(window, seeded.widgetId)
    expect(Math.abs(after.x - before.x - dx), `moved on screen by ~${dx}px, got ${after.x - before.x}`).toBeLessThan(8)
    expect(Math.abs(after.y - before.y - dy), `moved on screen by ~${dy}px, got ${after.y - before.y}`).toBeLessThan(8)

    // Past the 600ms overlay-save debounce.
    await window.waitForTimeout(900)

    // Shared base is untouched by the opted-in move.
    const base1 = await baseWidgetXY(window, seeded.deskAId, seeded.widgetId)
    expect(base1.x, 'shared base x unchanged after a real opted-in drag').toBe(60)
    expect(base1.y).toBe(60)

    // Switch away and back (view-store nav — see file header) — the overlay wins.
    await openDesk(window, seeded.deskBId)
    await openDesk(window, seeded.deskAId)
    await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 5_000 })
    await window.waitForTimeout(250)
    const restored = await widgetScreenBox(window, seeded.widgetId)
    expect(Math.abs(restored.x - after.x), 'restored screen x after Desk switch').toBeLessThan(4)
    expect(Math.abs(restored.y - after.y), 'restored screen y after Desk switch').toBeLessThan(4)

    // Real menu toggle OFF reverts to the shared base position.
    await openCanvasMenu(window)
    await customiseItem(window).click()
    await window.waitForTimeout(400)
    const reverted = await widgetScreenBox(window, seeded.widgetId)
    expect(Math.abs(reverted.x - before.x), 'reverted screen x on opt-out').toBeLessThan(4)
    expect(Math.abs(reverted.y - before.y), 'reverted screen y on opt-out').toBeLessThan(4)

    expect(relevantErrors(errors), `unexpected errors: ${JSON.stringify(relevantErrors(errors))}`).toEqual([])
  } finally {
    await dispose()
  }
})

test('GROUP-DRAG regression (customLayout OFF, the default) — shift-select two stickies, drag one, both ride along and both undo in one Cmd-Z', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const errors = trackErrors(window)
    const seeded = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.nodes.create({ parentId: null, kind: 'task', title: 'Group Drag UI Desk' })
      const w0 = await api.widgets.create({
        taskId: a.id,
        kind: 'sticky',
        title: '',
        content: 's0',
        x: 100,
        y: 100,
        width: 160,
        height: 120
      })
      const w1 = await api.widgets.create({
        taskId: a.id,
        kind: 'sticky',
        title: '',
        content: 's1',
        x: 400,
        y: 100,
        width: 160,
        height: 120
      })
      return { deskId: a.id, ids: [w0.id, w1.id] }
    })
    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: /Group Drag UI Desk/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
    for (const id of seeded.ids) await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 5_000 })
    await window.waitForTimeout(250)

    // customLayout is OFF by default for every fresh Desk (widgets.ts initial
    // state) — this is the shipping regression path this diff must not disturb.
    const custom = await window.evaluate(
      () => (window as unknown as { __fbWidgets?: { getState: () => { customLayout: boolean } } }).__fbWidgets?.getState().customLayout
    )
    expect(custom, 'customLayout is OFF by default').toBe(false)

    // Real shift-click both stickies to build a 2-widget selection.
    await shiftClick(window, seeded.ids[0])
    await shiftClick(window, seeded.ids[1])
    const toolbarText = await window.evaluate(() => document.body.innerText)
    expect(toolbarText).toContain('2 selected')

    const before0 = await widgetScreenBox(window, seeded.ids[0])
    const before1 = await widgetScreenBox(window, seeded.ids[1])

    // Real (non-shift) drag on widget 0's handle — since it's part of a 2+
    // selection, WidgetFrame's onDragStart makes it the group-drag leader and
    // both widgets ride along (endGroupDrag commits both through the same
    // store.update() this diff modified).
    const dx = 180
    const dy = 120
    await dragWidgetBy(window, seeded.ids[0], dx, dy)

    const after0 = await widgetScreenBox(window, seeded.ids[0])
    const after1 = await widgetScreenBox(window, seeded.ids[1])
    expect(Math.abs(after0.x - before0.x - dx), 'dragged widget moved by dx').toBeLessThan(8)
    expect(Math.abs(after0.y - before0.y - dy)).toBeLessThan(8)
    expect(Math.abs(after1.x - before1.x - dx), 'co-selected widget rode along by the same dx').toBeLessThan(8)
    expect(Math.abs(after1.y - before1.y - dy), 'co-selected widget rode along by the same dy').toBeLessThan(8)

    // Both widgets wrote to the shared base (customLayout OFF — unchanged path).
    const baseAfter = await window.evaluate(async (tid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const all = (await api.widgets.listByTask(tid)) as Array<{ id: string; x: number; y: number }>
      return all
    }, seeded.deskId)
    const b0 = baseAfter.find((w) => w.id === seeded.ids[0])!
    const b1 = baseAfter.find((w) => w.id === seeded.ids[1])!
    expect(b0.x, 'shared base holds the dragged widget move').toBe(100 + dx)
    expect(b1.x, 'shared base holds the co-selected widget move').toBe(400 + dx)

    // One combined Cmd-Z reverses BOTH widgets (endGroupDrag records a single
    // "Move 2 widgets" action).
    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await window.keyboard.press('Meta+KeyZ')
    await window.waitForTimeout(300)
    const undone0 = await widgetScreenBox(window, seeded.ids[0])
    const undone1 = await widgetScreenBox(window, seeded.ids[1])
    expect(Math.abs(undone0.x - before0.x), 'Cmd-Z reverts widget 0').toBeLessThan(4)
    expect(Math.abs(undone1.x - before1.x), 'Cmd-Z reverts widget 1 in the same undo').toBeLessThan(4)

    await window.keyboard.press('Meta+Shift+KeyZ')
    await window.waitForTimeout(300)
    const redone0 = await widgetScreenBox(window, seeded.ids[0])
    const redone1 = await widgetScreenBox(window, seeded.ids[1])
    expect(Math.abs(redone0.x - after0.x), 'Cmd-Shift-Z redoes widget 0').toBeLessThan(4)
    expect(Math.abs(redone1.x - after1.x), 'Cmd-Shift-Z redoes widget 1').toBeLessThan(4)

    expect(relevantErrors(errors), `unexpected errors: ${JSON.stringify(relevantErrors(errors))}`).toEqual([])
  } finally {
    await dispose()
  }
})

test('CUSTOMISE-UNDO — real drag + Cmd-Z/Cmd-Shift-Z: OFF is unchanged (base), ON reverses through the overlay (base still untouched)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const errors = trackErrors(window)
    const seeded = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const a = await api.nodes.create({ parentId: null, kind: 'task', title: 'Undo UI Desk' })
      const w = await api.widgets.create({
        taskId: a.id,
        kind: 'sticky',
        title: '',
        content: 'undo drag',
        x: 80,
        y: 80,
        width: 220,
        height: 160
      })
      return { deskId: a.id, widgetId: w.id }
    })
    // Snap-to-grid is on by default since 2212d6f6 and would round the drop
    // (190 -> 200); these assert the overlay round-trip, not the grid, so drag free.
    await window.evaluate(() => localStorage.setItem('fb.canvas.snap', '0'))
    await window.reload()
    await waitForReady(window)
    await openDesk(window, seeded.deskId)
    await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 5_000 })
    await window.waitForTimeout(250)

    // --- Regression: customLayout OFF (default). A real drag + real Cmd-Z/Cmd-Shift-Z
    // behaves exactly as shipping: reversed through the shared base.
    const p0 = await widgetScreenBox(window, seeded.widgetId)
    await dragWidgetBy(window, seeded.widgetId, 150, 100)
    const p1 = await widgetScreenBox(window, seeded.widgetId)
    expect(Math.abs(p1.x - p0.x - 150)).toBeLessThan(8)

    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await window.keyboard.press('Meta+KeyZ')
    await window.waitForTimeout(300)
    const p2 = await widgetScreenBox(window, seeded.widgetId)
    expect(Math.abs(p2.x - p0.x), 'Cmd-Z reverts the move (customLayout OFF)').toBeLessThan(4)
    expect(Math.abs(p2.y - p0.y)).toBeLessThan(4)
    const baseOff = await baseWidgetXY(window, seeded.deskId, seeded.widgetId)
    expect(baseOff, 'undo wrote the reversal to the shared base (OFF path)').toEqual({ x: 80, y: 80 })

    await window.keyboard.press('Meta+Shift+KeyZ')
    await window.waitForTimeout(300)
    const p3 = await widgetScreenBox(window, seeded.widgetId)
    expect(Math.abs(p3.x - p1.x), 'Cmd-Shift-Z redoes the move').toBeLessThan(4)

    // Undo the redo too, back to the clean starting point before opting in.
    await window.keyboard.press('Meta+KeyZ')
    await window.waitForTimeout(300)

    // --- Opt in via the real menu, then a real drag + real Cmd-Z: the reversal
    // must land in the overlay and the shared base must stay untouched throughout.
    await openCanvasMenu(window)
    await customiseItem(window).click()
    await window.waitForTimeout(200)

    const q0 = await widgetScreenBox(window, seeded.widgetId)
    await dragWidgetBy(window, seeded.widgetId, 200, 140)
    const q1 = await widgetScreenBox(window, seeded.widgetId)
    expect(Math.abs(q1.x - q0.x - 200)).toBeLessThan(8)
    await window.waitForTimeout(900) // past the overlay-save debounce

    const baseBeforeUndo = await baseWidgetXY(window, seeded.deskId, seeded.widgetId)
    expect(baseBeforeUndo, 'base never moved by the opted-in drag').toEqual({ x: 80, y: 80 })

    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await window.keyboard.press('Meta+KeyZ')
    await window.waitForTimeout(300)
    const q2 = await widgetScreenBox(window, seeded.widgetId)
    expect(Math.abs(q2.x - q0.x), 'Cmd-Z reverts the opted-in move on screen').toBeLessThan(4)
    expect(Math.abs(q2.y - q0.y)).toBeLessThan(4)

    await window.waitForTimeout(900) // past the overlay-save debounce triggered by the reversal
    const baseAfterUndo = await baseWidgetXY(window, seeded.deskId, seeded.widgetId)
    expect(baseAfterUndo, 'base STILL untouched after undoing an opted-in move').toEqual({ x: 80, y: 80 })
    const ovAfterUndo = await overlayObjects(window, seeded.deskId)
    const entry = ovAfterUndo?.objects.find((o) => o.objectId === seeded.widgetId)
    expect(entry, 'the reversal landed in the overlay').toBeTruthy()
    expect(entry!.x, 'overlay holds the reverted position').toBe(80)
    expect(entry!.y).toBe(80)

    expect(relevantErrors(errors), `unexpected errors: ${JSON.stringify(relevantErrors(errors))}`).toEqual([])
  } finally {
    await dispose()
  }
})
