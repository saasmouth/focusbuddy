// Renaming an item from the minimap's jump list.
//
// Asked for 2026-10-10: "right clicking a file name or double clicking a file
// name allows the user to edit the file name. A single click should take the
// user to the widget, also add a subtle hover effect to show its clickable".

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

async function openDeskWithWidgets(window: LaunchedApp['window']) {
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.nodes.create({ parentId: null, kind: 'task', title: 'Jump rename' })
    const a = await api.widgets.create({
      taskId: d.id, kind: 'sticky', title: 'First note', content: '',
      x: 120, y: 120, width: 240, height: 180
    })
    const b = await api.widgets.create({
      taskId: d.id, kind: 'sticky', title: 'Far away note', content: '',
      x: 2400, y: 1600, width: 240, height: 180
    })
    return { taskId: d.id, a: a.id, b: b.id }
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, seeded.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })
  await window.waitForTimeout(500)
  return seeded
}

/** Hover the minimap to reveal the jump list. */
async function openJumpList(window: LaunchedApp['window']) {
  await window.locator('[data-minimap-fab]').hover()
  const list = window.locator('[data-testid="desk-jump-list"]')
  await expect(list).toBeVisible({ timeout: 4000 })
  return list
}

test('JR-1 — double-clicking a name edits it, and the new name sticks', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seeded = await openDeskWithWidgets(window)
  await openJumpList(window)

  const row = window.locator(`[data-testid="desk-jump-${seeded.a}"]`)
  await expect(row).toContainText('First note')
  await row.dblclick()

  const input = window.locator(`[data-testid="desk-jump-edit-${seeded.a}"] input`)
  await expect(input).toBeVisible()
  await input.fill('Renamed by double click')
  await input.press('Enter')

  // Persisted, not just shown.
  await expect
    .poll(
      async () =>
        window.evaluate(async (id: string) => {
          const api = (window as unknown as { api: typeof window.api }).api
          const all = await api.widgets.listByTask(
            (await api.nodes.list()).find((n: { title: string }) => n.title === 'Jump rename')!.id
          )
          return all.find((w: { id: string }) => w.id === id)?.title ?? null
        }, seeded.a),
      { timeout: 6000 }
    )
    .toBe('Renamed by double click')
})

test('JR-2 — right-clicking a name edits it instead of opening the canvas menu', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seeded = await openDeskWithWidgets(window)
  await openJumpList(window)

  await window.locator(`[data-testid="desk-jump-${seeded.a}"]`).click({ button: 'right' })

  const input = window.locator(`[data-testid="desk-jump-edit-${seeded.a}"] input`)
  await expect(input).toBeVisible()
  // The desk's own context menu must not have opened over it.
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)

  // Escape abandons the edit and keeps the old name.
  await input.fill('discarded')
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(window.locator(`[data-testid="desk-jump-${seeded.a}"]`)).toContainText('First note')
})

test('JR-3 — a single click still jumps the camera', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seeded = await openDeskWithWidgets(window)
  await openJumpList(window)

  const before = await window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { panX: number; panY: number } } }
    const s = w.__fbWidgets!.getState()
    return { x: s.panX, y: s.panY }
  })

  await window.locator(`[data-testid="desk-jump-${seeded.b}"]`).click()
  await window.waitForTimeout(400)

  const after = await window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { panX: number; panY: number } } }
    const s = w.__fbWidgets!.getState()
    return { x: s.panX, y: s.panY }
  })
  expect(
    Math.abs(after.x - before.x) + Math.abs(after.y - before.y),
    'the camera travelled to the far widget'
  ).toBeGreaterThan(50)

  // A single click must not have started an edit.
  await expect(window.locator(`[data-testid="desk-jump-edit-${seeded.b}"]`)).toHaveCount(0)
})

test('JR-4 — the row shows it is clickable on hover', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seeded = await openDeskWithWidgets(window)
  await openJumpList(window)

  const hoveredRow = window.locator(`[data-testid="desk-jump-${seeded.a}"]`)
  const otherRow = window.locator(`[data-testid="desk-jump-${seeded.b}"]`)

  // Static affordances: the pointer says clickable, and the tooltip says the
  // name can be renamed, so the gesture is discoverable rather than hidden.
  expect(await hoveredRow.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer')
  expect(await hoveredRow.getAttribute('title')).toMatch(/rename/i)

  // Hover one row and compare against its unhovered sibling, rather than
  // against a reading taken before the pointer arrived — the list is only open
  // while the minimap area is hovered, so "before" is an awkward moment to
  // measure.
  await hoveredRow.hover()
  await window.waitForTimeout(250)
  const [hoveredBg, restingBg] = await Promise.all([
    hoveredRow.evaluate((el) => getComputedStyle(el).backgroundColor),
    otherRow.evaluate((el) => getComputedStyle(el).backgroundColor)
  ])
  expect(hoveredBg, 'the hovered row lifts out of the background').not.toBe(restingBg)
})
