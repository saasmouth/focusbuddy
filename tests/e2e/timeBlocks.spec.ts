import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, gotoView, openBookTimeDialog } from './_helpers'

// Calendar time-blocking. Two layers: the backend round-trip (real SQLite —
// create, range query, reschedule, complete, delete) and the week-grid UI
// (book a block from an empty slot and see it render + persist).

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('TB-1 — time block CRUD + range query round-trips through real SQLite', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    // A fixed, timezone-agnostic anchor.
    const start = 1_750_000_000_000 // some ms
    const created = await api.timeBlocks.create({
      taskId: null,
      title: 'Deep work',
      startMs: start,
      durationMin: 60
    })

    // In-range query finds it; an earlier window does not.
    const inRange = await api.timeBlocks.list(start - 3_600_000, start + 3_600_000)
    const outRange = await api.timeBlocks.list(start - 10 * 3_600_000, start - 5 * 3_600_000)

    // Reschedule + complete.
    const moved = await api.timeBlocks.update(created.id, {
      startMs: start + 2 * 3_600_000,
      status: 'done'
    })

    // The moved block is found at its new time, not the old one.
    const atNew = await api.timeBlocks.list(start + 3_600_000, start + 4 * 3_600_000)
    const atOld = await api.timeBlocks.list(start - 60_000, start + 60_000)

    const deleted = await api.timeBlocks.delete(created.id)
    const afterDelete = await api.timeBlocks.list(start - 10 * 3_600_000, start + 10 * 3_600_000)

    return {
      createdId: created.id,
      inRangeHasIt: inRange.some((b) => b.id === created.id),
      outRangeEmpty: outRange.length === 0,
      movedStart: moved?.startMs ?? null,
      movedStatus: moved?.status ?? null,
      atNewHasIt: atNew.some((b) => b.id === created.id),
      atOldHasIt: atOld.some((b) => b.id === created.id),
      deleted,
      afterDeleteEmpty: afterDelete.length === 0
    }
  })

  expect(result.createdId).toBeTruthy()
  expect(result.inRangeHasIt).toBe(true)
  expect(result.outRangeEmpty).toBe(true)
  expect(result.movedStart).toBe(1_750_000_000_000 + 2 * 3_600_000)
  expect(result.movedStatus).toBe('done')
  expect(result.atNewHasIt).toBe(true)
  expect(result.atOldHasIt).toBe(false)
  expect(result.deleted).toBe(true)
  expect(result.afterDeleteEmpty).toBe(true)
})

test('TB-2 — booking a block from the week grid renders it and it persists', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Open the Calendar view, switch to Week.
  await gotoView(window, 'goCalendar')
  await window.locator('[data-testid="calendar-mode-week"]').click()
  await expect(window.locator('[data-testid="week-time-grid"]')).toBeVisible({ timeout: 6000 })

  // Click an empty slot in a weekday column to open the composer, then book it.
  const dialog = await openBookTimeDialog(window)
  await dialog.locator('[data-testid="book-commit"]').click()

  // A block now renders on the grid.
  await expect(window.locator('[data-testid="time-block"]')).toHaveCount(1, { timeout: 4000 })

  // It persisted: reload, return to Week, the block is still there.
  await window.reload()
  await waitForReady(window)
  await gotoView(window, 'goCalendar')
  await window.locator('[data-testid="calendar-mode-week"]').click()
  await expect(window.locator('[data-testid="time-block"]')).toHaveCount(1, { timeout: 6000 })
})

test('TB-3 — dragging a task onto a day column books a block for that task', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Seed a task to drag.
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'Write the report' })
    return t.id
  })
  await window.reload()
  await waitForReady(window)

  await gotoView(window, 'goCalendar')
  await window.locator('[data-testid="calendar-mode-week"]').click()
  await expect(window.locator('[data-testid="week-time-grid"]')).toBeVisible({ timeout: 6000 })

  // Simulate the sidebar's HTML5 drag payload (text/fb-node = node id) dropping
  // onto a day column, the way Sidebar.handleRowDragStart publishes it.
  await window.evaluate((id) => {
    const col = document.querySelector('[data-testid="day-col-3"]') as HTMLElement
    const rect = col.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.setData('text/fb-node', id)
    const base = { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 160 }
    col.dispatchEvent(new DragEvent('dragover', { ...base, dataTransfer: dt }))
    col.dispatchEvent(new DragEvent('drop', { ...base, dataTransfer: dt }))
  }, taskId)

  // The booking dialog opens pre-filled: a dragged node arrives as the dialog's
  // Attach value (BookTimeDialog seeds `attached` from prefillNode and passes
  // its real id through as the block's taskId — the hardcoded STUB_ATTACH is
  // explicitly excluded there, so only a real drag can book against a task).
  const dialog = window.locator('[data-testid="book-time-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 4000 })
  await expect(dialog.locator('[data-testid="book-attach-row"]')).toContainText('Write the report')
  await dialog.locator('[data-testid="book-commit"]').click()

  // A block for that task now renders, carries the task's title, and offers a
  // jump-to-task button.
  const block = window.locator('[data-testid="time-block"]')
  await expect(block).toHaveCount(1, { timeout: 4000 })
  await expect(block).toContainText('Write the report')
  await block.hover()
  await expect(block.locator('[data-testid="block-jump"]')).toBeVisible()
})
