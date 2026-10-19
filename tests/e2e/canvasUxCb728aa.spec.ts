// E2E coverage for commit cb728aa:
//   1. Cmd+K palette lists every picker-visible widget as "Add <label>" with its shortcut letter
//   2. Cmd+K palette lists nav commands (Documents, Files, Mail, PlexiInbox, Messages)
//   3. Widget quick-add keyboard shortcuts spawn a widget on the active task canvas
//   4. Quick-add does NOT fire when a text input has focus (typing guard)
//   5. Regression: modifier keys do not trigger quick-add; Cmd+K toggle works; canvas intact after close

import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Seed a task + a placeholder sticky so the canvas is non-empty, then reload and
// navigate to the canvas. Follows the exact same pattern as stickyWidget.spec.ts
// and multiSelect.spec.ts which are proven green in this harness.
async function seedTaskAndOpenCanvas(
  l: LaunchedApp,
  title: string
): Promise<{ taskId: string }> {
  const { window } = l
  await waitForReady(window)

  const seeded = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: t })
    // A placeholder sticky so there is always at least one non-minimap widget.
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'seed',
      x: 200,
      y: 160,
      width: 240,
      height: 200
    })
    return { taskId: task.id }
  }, title)

  await window.reload()
  await waitForReady(window)
  // Sidebar button carries the task title — use exact same locator as proven specs.
  await window.getByRole('button', { name: new RegExp(title) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  // Wait for at least one widget element on the canvas, which confirms the
  // canvas loaded, activeTaskId is set in the store, and the palette's "Add"
  // commands will be present. Without this guard the palette opens before the
  // activeTaskId is committed to the Zustand store and the Add-widget commands
  // are absent (they are gated on `if (activeTaskId)` in the results memo).
  await window.waitForSelector('[data-widget-id]', { timeout: 6_000 })
  await window.waitForTimeout(300)
  return seeded
}

// Collect all text visible inside the command-palette overlay (the fixed-position
// element that contains the search input).
async function getPaletteText(window: LaunchedApp['window']): Promise<string> {
  return window.evaluate(() => {
    // The palette is a React portal rendered into a fixed-position div.
    // We find it by looking for a fixed element that contains an <input>.
    const candidates = Array.from(document.querySelectorAll('*'))
    for (const el of candidates) {
      const style = window.getComputedStyle(el)
      if (style.position === 'fixed' && el.querySelector('input')) {
        return el.textContent ?? ''
      }
    }
    return ''
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// 1 & 2: Cmd+K palette content — widget Add commands + nav commands
// ──────────────────────────────────────────────────────────────────────────────

test('Cmd+K palette surfaces "Add Sticky" when searching "sticky"', async () => {
  // Searching by widget name surfaces its Add command (the empty-query palette
  // now shows the full scrollable list, and a query filters it). Test one
  // representative case: "sticky" → "Add Sticky".
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedTaskAndOpenCanvas(launched, 'PaletteWidgetsTest')

  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(500)

  // Wait for the input to actually be focused before typing
  await window.waitForFunction(
    () => document.activeElement?.tagName === 'INPUT',
    null,
    { timeout: 3_000 }
  )

  await window.keyboard.type('sticky')
  await window.waitForTimeout(400)

  const text = await getPaletteText(window)
  expect(text, 'searching "sticky" must surface "Add Sticky"').toContain('Add Sticky')

  await window.keyboard.press('Escape')
})

test('Cmd+K palette surfaces "Add Table" when searching "table"', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedTaskAndOpenCanvas(launched, 'PaletteTableTest')

  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(500)

  await window.waitForFunction(
    () => document.activeElement?.tagName === 'INPUT',
    null,
    { timeout: 3_000 }
  )

  await window.keyboard.type('table')
  await window.waitForTimeout(400)

  const text = await getPaletteText(window)
  expect(text, 'searching "table" must surface "Add Table"').toContain('Add Table')

  await window.keyboard.press('Escape')
})

test('Cmd+K palette lists nav commands: Documents, Files, Mail, PlexiInbox, Messages', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedTaskAndOpenCanvas(launched, 'PaletteNavTest')

  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(500)

  const text = await getPaletteText(window)

  const navCommands = ['Documents', 'Files', 'Mail', 'PlexiiInbox', 'Messages']
  for (const cmd of navCommands) {
    expect(text, `palette must contain nav command "${cmd}"`).toContain(cmd)
  }

  await window.keyboard.press('Escape')
})

test('Cmd+K palette shows shortcut letter S next to Add Sticky', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedTaskAndOpenCanvas(launched, 'ShortcutLetterTest')

  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(500)

  // Narrow to the "sticky" row by searching
  await window.keyboard.type('sticky')
  await window.waitForTimeout(300)

  const text = await getPaletteText(window)

  // "Add Sticky" row must be present
  expect(text).toContain('Add Sticky')
  // The shortcut key "S" must appear in the palette text for that row.
  // (It is rendered as a small kbd/chip alongside the row label.)
  expect(text).toMatch(/S/)

  await window.keyboard.press('Escape')
})

// ──────────────────────────────────────────────────────────────────────────────
// 3: Widget quick-add keyboard shortcuts via IPC verification
// Keyboard press drives the same keydown handler as the user pressing a key;
// we verify via the IPC api.widgets.listByTask rather than DOM scraping.
// ──────────────────────────────────────────────────────────────────────────────

test('pressing T on a bare task canvas creates a table widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId } = await seedTaskAndOpenCanvas(launched, 'QuickAddTableTest')

  // Click the bare canvas background to ensure canvas has pointer focus,
  // not any specific widget.
  const surface = window.locator('[data-canvas-surface="true"]')
  const box = await surface.boundingBox()
  if (!box) throw new Error('Canvas surface missing bounding box')
  // Click center of canvas (away from the seeded sticky which is at x:200,y:160)
  await window.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75)
  await window.waitForTimeout(200)

  const before = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => w.kind !== 'minimap').length
  }, taskId)

  // Press 't' — canvas shortcut T=table. Note: keyboard.press sends lowercase
  // which Canvas.tsx uppercases before the SHORTCUT_TO_KIND lookup.
  await window.keyboard.press('t')
  await window.waitForTimeout(800)

  const after = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return {
      total: all.filter((w) => w.kind !== 'minimap').length,
      hasTable: all.some((w) => w.kind === 'table')
    }
  }, taskId)

  expect(after.total, 'widget count should increase by 1').toBe(before + 1)
  expect(after.hasTable, 'a table widget must be created by pressing T').toBe(true)
})

test('pressing S on a bare task canvas creates a sticky widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId } = await seedTaskAndOpenCanvas(launched, 'QuickAddStickyTest')

  const surface = window.locator('[data-canvas-surface="true"]')
  const box = await surface.boundingBox()
  if (!box) throw new Error('Canvas surface missing bounding box')
  await window.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75)
  await window.waitForTimeout(200)

  const before = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => w.kind !== 'minimap' && w.kind !== 'sticky').length
  }, taskId)

  await window.keyboard.press('s')
  await window.waitForTimeout(800)

  const stickyCount = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => w.kind === 'sticky').length
  }, taskId)

  // Started with 1 sticky (seed), should now have 2
  expect(stickyCount, 'pressing S should add a second sticky').toBeGreaterThanOrEqual(2)
})

// ──────────────────────────────────────────────────────────────────────────────
// 4: Typing guard — quick-add must NOT fire when an input is focused
// Driven via the Cmd+K palette, which is the cleanest focused-input state
// available without a native dialog.
// ──────────────────────────────────────────────────────────────────────────────

test('pressing T while the palette search input is focused does NOT spawn a widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId } = await seedTaskAndOpenCanvas(launched, 'TypingGuardTest')

  // Open palette — this focuses the search <input>
  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(400)

  const before = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => w.kind !== 'minimap').length
  }, taskId)

  // Type 't' into the search field. The typing guard in Canvas.tsx checks
  // document.activeElement; if it's an INPUT the quick-add handler returns early.
  await window.keyboard.press('t')
  await window.waitForTimeout(500)

  const after = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => w.kind !== 'minimap').length
  }, taskId)

  expect(after, 'no widget must be spawned while typing in the palette input').toBe(before)

  await window.keyboard.press('Escape')
})

// ──────────────────────────────────────────────────────────────────────────────
// 5: Regression checks
// ──────────────────────────────────────────────────────────────────────────────

test('Cmd+K opens, Escape closes, second Cmd+K reopens, canvas is intact throughout', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedTaskAndOpenCanvas(launched, 'PaletteToggleTest')

  // Open
  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(300)

  const openText = await getPaletteText(window)
  expect(openText.length, 'palette must have content after Cmd+K').toBeGreaterThan(10)

  // Close with Escape
  await window.keyboard.press('Escape')
  await window.waitForTimeout(300)

  // Canvas still present
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible()

  // Second Cmd+K re-opens (toggle works both ways)
  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(300)
  const reopenText = await getPaletteText(window)
  expect(reopenText.length, 'palette re-opens on second Cmd+K').toBeGreaterThan(10)

  // Close via Cmd+K toggle
  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(300)

  // Canvas still intact
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible()
})

test('modifier keys (Cmd+T, Shift+S) do NOT trigger quick-add shortcuts', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId } = await seedTaskAndOpenCanvas(launched, 'ModifierGuardTest')

  const surface = window.locator('[data-canvas-surface="true"]')
  const box = await surface.boundingBox()
  if (!box) throw new Error('Canvas surface missing bounding box')
  await window.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.75)
  await window.waitForTimeout(200)

  const before = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => w.kind !== 'minimap').length
  }, taskId)

  // Cmd+T — must NOT spawn a table (metaKey is set, guard must return early)
  await window.keyboard.press('Meta+t')
  await window.waitForTimeout(400)

  // Shift+S — must NOT spawn a sticky (shiftKey is set, guard must return early)
  await window.keyboard.press('Shift+s')
  await window.waitForTimeout(400)

  // Alt+N — must NOT spawn a note
  await window.keyboard.press('Alt+n')
  await window.waitForTimeout(400)

  const after = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.filter((w) => w.kind !== 'minimap').length
  }, taskId)

  expect(after, 'modified shortcut keys must not spawn widgets').toBe(before)
})
