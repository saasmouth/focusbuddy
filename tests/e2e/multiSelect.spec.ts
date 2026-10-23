import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, shiftClickWidgetHeader, waitForReady } from './_helpers'

// Canvas multi-select:
//   • Shift+click a widget toggles it in the selection.
//   • Shift+drag a marquee over the desk selects everything it overlaps.
//   • The floating selection toolbar offers Group-into-section / Duplicate /
//     Delete / Clear; ⌘/Ctrl+A selects all, Esc clears.
//   • "Group into section" wraps the selected widgets in a new section.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedStickiesAndOpen(
  l: LaunchedApp,
  positions: Array<{ x: number; y: number }>
): Promise<{ taskId: string; ids: string[] }> {
  const { window } = l
  await waitForReady(window)
  const seeded = await window.evaluate(async (pts: Array<{ x: number; y: number }>) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Multiselect test' })
    const ids: string[] = []
    for (let i = 0; i < pts.length; i++) {
      const w = await api.widgets.create({
        taskId: task.id,
        kind: 'sticky',
        title: `s${i}`,
        content: `s${i}`,
        x: pts[i].x,
        y: pts[i].y,
        // The sticky's catalogue default. This used 160 x 120, below the
        // 180 x 120 floor every kind is clamped to (shared/widgetSizing.ts),
        // where the header action row leaves no grab point on the header.
        width: 240,
        height: 200
      })
      ids.push(w.id)
    }
    return { taskId: task.id, ids }
  }, positions)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Multiselect test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  for (const id of seeded.ids) {
    await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 5_000 })
  }
  await window.waitForTimeout(250)
  return seeded
}

// Real Shift+mousedown→mouseup on the HEADER (react-rnd's drag handle), the
// exact gesture a user makes, exercising react-rnd's onDragStart path (where
// header shift-select is wired). The point is hit-tested rather than a fixed
// `left + 26`, which now lands on the header's "Rewrite with AI" button; see
// shiftClickWidgetHeader in _helpers.ts.
async function shiftClick(l: LaunchedApp, id: string): Promise<void> {
  await shiftClickWidgetHeader(l.window, id)
}

async function stickiesOf(
  l: LaunchedApp,
  taskId: string
): Promise<Array<{ id: string; kind: string; parentSectionId: string | null; x: number; y: number }>> {
  return l.window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.map((w) => ({
      id: w.id,
      kind: w.kind,
      parentSectionId: w.parentSectionId ?? null,
      x: w.x,
      y: w.y
    }))
  }, taskId)
}

test('shift+click selects two widgets and the toolbar shows the count', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { ids } = await seedStickiesAndOpen(launched, [
    { x: 120, y: 120 },
    { x: 400, y: 120 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])

  const toolbarText = await window.evaluate(() => document.body.innerText)
  expect(toolbarText).toContain('2 selected')
})

test('Group into section wraps the shift-selected widgets in a new section', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedStickiesAndOpen(launched, [
    { x: 140, y: 140 },
    { x: 420, y: 160 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])

  // Click the toolbar's "Group into a section" button.
  const clicked = await window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      'button[title="Group into a section"]'
    )
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked).toBe(true)
  await window.waitForTimeout(500)

  const widgets = await stickiesOf(launched, taskId)
  const section = widgets.find((w) => w.kind === 'section')
  expect(section).toBeTruthy()
  // Both stickies now belong to the new section.
  const stickies = widgets.filter((w) => w.kind === 'sticky')
  expect(stickies.length).toBe(2)
  for (const s of stickies) expect(s.parentSectionId).toBe(section!.id)
})

test('Delete removes every selected widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedStickiesAndOpen(launched, [
    { x: 120, y: 120 },
    { x: 400, y: 120 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])

  const clicked = await window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked).toBe(true)

  // Since f019f6e3 ("Delete / Backspace on selected work widgets asks Remove
  // from this desk or Delete") the selection bar's delete asks the × question
  // for the whole selection (lib/widgetRemoval removeWorkWidgets). Stickies are
  // work widget files, so it offers Remove from this desk / Delete N. This spec
  // used to expect an immediate delete; answer Delete, the destructive choice.
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toHaveAttribute('aria-label', 'Remove or delete 2 work widgets?')
  await expect(dialog.locator('[data-testid="prompt-choice-delete"]')).toContainText('Delete 2 work widgets')
  await dialog.locator('[data-testid="prompt-choice-delete"]').click()
  await expect(dialog).toBeHidden()
  await window.waitForTimeout(500)

  const widgets = await stickiesOf(launched, taskId)
  expect(widgets.filter((w) => w.kind === 'sticky').length).toBe(0)
})

test('Cmd+A selects all desk widgets; Esc clears the selection', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedStickiesAndOpen(launched, [
    { x: 120, y: 120 },
    { x: 400, y: 120 },
    { x: 680, y: 120 }
  ])

  await window.evaluate(() => {
    document.body.focus()
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true })
    )
  })
  await window.waitForTimeout(150)
  expect(await window.evaluate(() => document.body.innerText)).toContain('3 selected')

  await window.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await window.waitForTimeout(150)
  expect(await window.evaluate(() => document.body.innerText)).not.toContain('selected')
})

test('shift+drag marquee selects the widgets it overlaps', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { ids } = await seedStickiesAndOpen(launched, [
    { x: 120, y: 120 },
    { x: 400, y: 140 }
  ])

  // Drag a Shift+marquee from empty desk above-left of the first sticky to a
  // point INSIDE the second one, so the second is overlapped, not contained.
  //
  // Placed from the stickies' rendered rects, not fixed surface offsets: since
  // fad098e8 ("the desk runs beneath the dock") the surface starts under the
  // side dock and the camera opens at panX = dock inset (272 px here). The old
  // fixed (20,20)→(600,420) began under the dock and, in canvas space, ended
  // at x≈328, short of the second sticky, so only one was selected.
  await window.evaluate((wids: string[]) => {
    const surf = document.querySelector('[data-canvas-surface="true"]') as HTMLElement
    const a = document.querySelector(`[data-widget-id="${wids[0]}"]`)!.getBoundingClientRect()
    const b = document.querySelector(`[data-widget-id="${wids[1]}"]`)!.getBoundingClientRect()
    const opts = (x: number, y: number, shift: boolean) => ({
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      shiftKey: shift,
      clientX: x,
      clientY: y
    })
    surf.dispatchEvent(new PointerEvent('pointerdown', opts(a.left - 30, a.top - 30, true)))
    surf.dispatchEvent(new PointerEvent('pointermove', opts(b.left + 40, b.top + 40, true)))
    surf.dispatchEvent(new PointerEvent('pointerup', opts(b.left + 40, b.top + 40, false)))
  }, ids)
  await window.waitForTimeout(200)

  expect(await window.evaluate(() => document.body.innerText)).toContain('2 selected')
})
