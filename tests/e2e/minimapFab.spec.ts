// The minimap as built-in chrome.
//
// It used to be a widget: a kind='minimap' auto-created and pinned bottom-right
// on first desk open, which needed dedup logic because extras accumulated in
// SQLite. It is now a FAB, and Canvas carries a migration that REMOVES any
// legacy minimap widget it finds.
//
// This replaces minimapDedup.spec.ts and minimapWidget.spec.ts, which asserted
// the old contract ("exactly one minimap WIDGET exists per task") and so
// asserted the opposite of what the app now does. The intent they were
// protecting — never more than one minimap, and no stray one rendering
// mid-canvas — is kept here against the current design.
//
// Anchoring to the bottom-right corner is covered by canvasSurfaceAnchor CS-1.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

async function seedDesk(window: LaunchedApp['window'], title: string): Promise<string> {
  return window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: t })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'anchor',
      content: '',
      x: 120,
      y: 120,
      width: 240,
      height: 180
    })
    return task.id
  }, title)
}

async function openDesk(window: LaunchedApp['window'], title: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: title }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
}

test('MM-1 — a desk has exactly one minimap, and it is chrome rather than a widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const taskId = await seedDesk(window, 'Minimap chrome')
  await openDesk(window, 'Minimap chrome')

  await expect(window.locator('[data-minimap-fab]')).toHaveCount(1)

  // And no minimap WIDGET is created for the desk any more.
  const widgetCount = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.listByTask(tid)).filter((w) => w.kind === 'minimap').length
  }, taskId)
  expect(widgetCount).toBe(0)
})

test('MM-2 — legacy minimap widgets are swept away on desk open', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const taskId = await seedDesk(window, 'Legacy minimaps')

  // Three of them, as an old database could hold.
  await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    for (let i = 0; i < 3; i++) {
      await api.widgets.create({
        taskId: tid,
        kind: 'minimap',
        title: 'Minimap',
        content: '',
        x: 40 * i,
        y: 40 * i,
        width: 220,
        height: 160
      })
    }
  }, taskId)

  await openDesk(window, 'Legacy minimaps')

  // The sweep converges to none — the FAB is the minimap now, so a leftover
  // widget would render a second one stranded on the canvas.
  await expect
    .poll(
      async () =>
        window.evaluate(async (tid: string) => {
          const api = (window as unknown as { api: typeof window.api }).api
          return (await api.widgets.listByTask(tid)).filter((w) => w.kind === 'minimap').length
        }, taskId),
      { timeout: 8000 }
    )
    .toBe(0)
  await expect(window.locator('[data-minimap-fab]')).toHaveCount(1)
})

test('MM-3 — the panel opens on navigation and the toggle pins it open', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedDesk(window, 'Minimap opening')
  await openDesk(window, 'Minimap opening')

  const panel = window.locator('[data-testid="minimap-fab-panel"]')
  const toggle = window.locator('[data-testid="minimap-fab-toggle"]')

  // Panning auto-opens the panel (it closes itself a couple of seconds later).
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbWidgets?: { getState: () => { setPan: (x: number, y: number) => void } }
    }
    w.__fbWidgets!.getState().setPan(-240, -160)
  })
  await expect(panel).toBeVisible({ timeout: 4000 })

  // It stands down on its own, leaving the icon. Polled rather than waited on
  // a fixed delay: the auto-close timer restarts on any pan or zoom, so a
  // single 2.2s window is not something to assert against directly — the
  // panel and the icon are mutually exclusive, so the icon appearing IS the
  // panel having closed.
  await expect.poll(async () => toggle.isVisible().catch(() => false), { timeout: 15000 }).toBe(true)

  // Clicking the icon pins it open, and it stays past the auto-close window.
  await toggle.click()
  await expect(panel).toBeVisible()
  await window.waitForTimeout(3000)
  await expect(panel).toBeVisible()
  await expect(toggle).toHaveCount(0)
})

test('MM-4 — clicking inside the panel moves the camera there', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const taskId = await seedDesk(window, 'Minimap panning')

  // Spread a few widgets so the map has an area worth clicking into. Seeded
  // BEFORE opening the desk, using the id seedDesk returned — the active task
  // lives on the node store, not the view store.
  await window.evaluate(
    async (tid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      for (let i = 0; i < 6; i++) {
        await api.widgets.create({
          taskId: tid,
          kind: 'sticky',
          title: `s${i}`,
          content: '',
          x: i * 480,
          y: (i % 2) * 420,
          width: 240,
          height: 180
        })
      }
    },
    taskId
  )
  await openDesk(window, 'Minimap panning')
  await window.waitForTimeout(400)

  const toggle = window.locator('[data-testid="minimap-fab-toggle"]')
  if (await toggle.isVisible().catch(() => false)) await toggle.click()
  const panel = window.locator('[data-testid="minimap-fab-panel"]')
  await expect(panel).toBeVisible({ timeout: 4000 })

  const read = () =>
    window.evaluate(() => {
      const w = window as unknown as {
        __fbWidgets?: { getState: () => { panX: number; panY: number } }
      }
      const s = w.__fbWidgets!.getState()
      return { panX: s.panX, panY: s.panY }
    })

  const before = await read()
  // Press near one corner of the overview; the camera should travel there.
  const box = (await panel.boundingBox())!
  await window.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.3)
  await window.mouse.down()
  await window.mouse.up()
  await window.waitForTimeout(300)
  const after = await read()

  expect(
    Math.abs(after.panX - before.panX) + Math.abs(after.panY - before.panY),
    'the camera moved'
  ).toBeGreaterThan(20)
})
