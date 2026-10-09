import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import type { AlignMode } from '../../src/renderer/src/lib/canvasAlign'

// Feature A: Canvas craft — align/distribute toolbar + snap-to-grid.
//
// Coverage:
//   1. With 2+ widgets selected the align buttons appear in the selection toolbar.
//   2. "Align left" converges all selected widgets' x to the same value via the
//      IPC-driven position check (window.api.widgets.listByTask).
//   3. With 3+ selected the Distribute buttons appear.
//   4. On an open desk, the CommandCenter (Cmd+K) snap-to-grid command flips the
//      persisted pref on and back off, without crashing.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// --------------------------------------------------------------------------
// Shared helpers (mirrors multiSelect.spec.ts pattern)
// --------------------------------------------------------------------------

async function seedWidgetsAndOpen(
  l: LaunchedApp,
  positions: Array<{ x: number; y: number }>
): Promise<{ taskId: string; ids: string[] }> {
  const { window } = l
  await waitForReady(window)
  const seeded = await window.evaluate(async (pts: Array<{ x: number; y: number }>) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Canvas craft test' })
    const ids: string[] = []
    for (let i = 0; i < pts.length; i++) {
      const w = await api.widgets.create({
        taskId: task.id,
        kind: 'sticky',
        title: `w${i}`,
        content: `w${i}`,
        x: pts[i].x,
        y: pts[i].y,
        width: 160,
        height: 120
      })
      ids.push(w.id)
    }
    return { taskId: task.id, ids }
  }, positions)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Canvas craft test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  for (const id of seeded.ids) {
    await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 5_000 })
  }
  await window.waitForTimeout(250)
  return seeded
}

async function shiftClick(l: LaunchedApp, id: string): Promise<void> {
  const pt = await l.window.evaluate((wid: string) => {
    const h = document.querySelector(`[data-widget-id="${wid}"] .widget-handle`)
    const target = h ?? document.querySelector(`[data-widget-id="${wid}"]`)
    const b = (target as HTMLElement).getBoundingClientRect()
    return { x: b.left + 26, y: b.top + (h ? b.height / 2 : 44) }
  }, id)
  await l.window.keyboard.down('Shift')
  await l.window.mouse.click(pt.x, pt.y)
  await l.window.keyboard.up('Shift')
  await l.window.waitForTimeout(150)
}

async function listWidgets(
  l: LaunchedApp,
  taskId: string
): Promise<Array<{ id: string; x: number; y: number }>> {
  return l.window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.map((w) => ({ id: w.id, x: w.x, y: w.y }))
  }, taskId)
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test('Align buttons appear in toolbar when 2 widgets are selected', async () => {
  launched = await launchApp()
  const { window } = launched
  const { ids } = await seedWidgetsAndOpen(launched, [
    { x: 100, y: 100 },
    { x: 400, y: 200 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])

  // The toolbar renders align buttons with aria-label matching "Align *".
  const alignBtn = await window.evaluate(() => {
    return !!document.querySelector('button[aria-label^="Align"]')
  })
  expect(alignBtn).toBe(true)
})

test('Align left converges selected widgets x to the leftmost x', async () => {
  launched = await launchApp()
  const { ids, taskId } = await seedWidgetsAndOpen(launched, [
    { x: 100, y: 100 },
    { x: 350, y: 180 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])

  // Click Align left via DOM (same as a user click, avoids fragile pointer
  // coordinates on the tiny toolbar).
  const clicked = await launched.window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Align left"]')
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked, 'Align left button must be present and clickable').toBe(true)
  await launched.window.waitForTimeout(400)

  const widgets = await listWidgets(launched, taskId)
  const xs = widgets.filter((w) => ids.includes(w.id)).map((w) => w.x)
  // All selected widgets should share the same x after aligning left.
  expect(new Set(xs).size, `Expected 1 unique x, got [${xs.join(', ')}]`).toBe(1)
})

test('Distribute buttons appear when 3 widgets are selected', async () => {
  launched = await launchApp()
  const { window } = launched
  const { ids } = await seedWidgetsAndOpen(launched, [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 600, y: 100 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])
  await shiftClick(launched, ids[2])

  const distributeBtn = await window.evaluate(() => {
    return !!document.querySelector('button[aria-label="Distribute horizontally"]')
  })
  expect(distributeBtn).toBe(true)
})

test('Snap-to-grid toggle via CommandCenter does not crash', async () => {
  launched = await launchApp()
  const { window } = launched
  const pageErrors: string[] = []
  window.on('pageerror', (e) => pageErrors.push(e.message))

  // Snap-to-grid is a CANVAS command: CommandCenter only lists toggle-snap
  // while a desk is open (it has sat inside `if (activeTaskId)` since it was
  // added in 553d05b6). This test used to open the palette on Home, where the
  // row does not exist — so it either clicked some other row that happened to
  // say "snap" (the web-search row did) or found nothing and skipped its only
  // real assertion behind `if (clicked)`. Open a desk, and require the row.
  await seedWidgetsAndOpen(launched, [{ x: 200, y: 200 }])

  const readSnap = (): Promise<boolean | null> =>
    window.evaluate(() => {
      // setNavPrefs persists under 'fb.nav.prefs' (lib/navPrefs). lib/gridPref
      // keeps a separate canvas snap under 'fb.canvas.snap'; the palette does
      // not touch it.
      try {
        const raw = localStorage.getItem('fb.nav.prefs')
        if (!raw) return null
        return JSON.parse(raw)?.snapToGridEnabled ?? null
      } catch {
        return null
      }
    })

  async function runSnapCommand(expectLabel: RegExp): Promise<void> {
    // Open the command palette with Cmd+K, the way the app's global key
    // handler hears it.
    await window.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    })
    const input = window.locator('[data-testid="command-palette-input"]')
    await expect(input).toBeVisible({ timeout: 4_000 })
    await input.fill('snap')
    // The command's own row, by its testid — not any row containing the word.
    const row = window.locator('[data-testid="palette-row-toggle-snap"]')
    await expect(row).toBeVisible({ timeout: 4_000 })
    await expect(row).toContainText(expectLabel)
    await row.click()
    // Running the command closes the palette.
    await expect(input).toHaveCount(0, { timeout: 4_000 })
  }

  expect(await readSnap(), 'snap starts off (default)').not.toBe(true)

  await runSnapCommand(/Snap to grid: off \(turn on\)/)
  expect(await readSnap(), 'the palette command turned snap ON').toBe(true)

  // And it is a toggle: the row now offers the way back, and takes it.
  await runSnapCommand(/Snap to grid: on \(turn off\)/)
  expect(await readSnap(), 'the palette command turned snap OFF again').toBe(false)

  // The desk is still there and nothing threw.
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible()
  expect(pageErrors, 'no renderer errors').toEqual([])
})
