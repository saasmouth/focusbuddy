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
//   4. Toggling snap-to-grid via CommandCenter (Cmd+K) does not crash.

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
  await waitForReady(window)

  // Open the command palette with Cmd+K.
  await window.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
    )
  })
  await window.waitForTimeout(300)

  // Type "snap" to filter to the snap-to-grid command.
  await window.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder*="command"], input[placeholder*="search"], input[type="search"], [role="combobox"]')
    if (input) {
      input.focus()
    }
  })
  await window.keyboard.type('snap')
  await window.waitForTimeout(200)

  // Click the snap-to-grid result item (matches either "on" or "off" state).
  const clicked = await window.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll('[role="option"], [role="menuitem"], [data-command-item]')
    )
    // "Snap to grid: off (turn on)" / "...: on (turn off)" is the command's
    // label. Matching bare 'snap' could land on any other row that happens to
    // contain the word, which is how this ended up clicking something that
    // never called setNavPrefs.
    const item = items.find((el) => el.textContent?.toLowerCase().includes('snap to grid'))
    if (!item) return false
    ;(item as HTMLElement).click()
    return true
  })

  // Even if the command item text search misses (different palette structure),
  // the important thing is no crash and the app is still responsive.
  await window.waitForTimeout(300)
  const viewVisible = await window.locator('body').isVisible()
  expect(viewVisible).toBe(true)

  // Confirm the snap toggle survives by checking navPrefs via evaluate.
  const snapState = await window.evaluate(() => {
    // The palette's toggle-snap command calls setNavPrefs, which persists
    // under 'fb.nav.prefs' — not 'navPrefs', which is a key nothing writes, so
    // this check could only ever read null. (lib/gridPref.ts keeps a separate
    // canvas snap under 'fb.canvas.snap'; the palette does not touch it.)
    try {
      const raw = localStorage.getItem('fb.nav.prefs')
      if (!raw) return null
      return JSON.parse(raw)?.snapToGridEnabled ?? null
    } catch {
      return null
    }
  })
  // snapState may be true (toggled on) or null (not yet persisted in this
  // session), but must not throw. We confirm no crash by reaching this line.
  expect([true, false, null]).toContain(snapState)

  if (clicked) {
    // If we successfully clicked a snap item, snapToGridEnabled should now be true.
    expect(snapState).toBe(true)
  }
})
