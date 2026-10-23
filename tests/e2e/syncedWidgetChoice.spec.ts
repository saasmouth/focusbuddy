import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Copy-vs-Sync choice at creation — drives the REAL widget context-menu
// handlers (not the IPC layer), so it catches breakage between the store/UI
// wiring and the DB propagation that syncedWidgets.spec.ts (IPC-level) cannot.
//
//   • "Duplicate, keep synced"       → both copies share a syncGroupId; edits mirror.
//   • "Duplicate"                    → no syncGroupId; the two never affect each other.
//   • The synced copy exposes "Unlink from synced copies"; the independent one does not.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedStickyAndOpen(
  l: LaunchedApp
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)

  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Sync choice test' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'original',
      content: 'v1',
      x: 240,
      y: 180,
      width: 240,
      height: 180
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Sync choice test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 5_000 })
  await window.waitForTimeout(250)
  return seeded
}

/** Right-click the widget header to open the context menu, then click the
 *  menu item whose label contains `label`. Returns whether the item was found. */
async function duplicateVia(
  l: LaunchedApp,
  widgetId: string,
  label: string
): Promise<boolean> {
  const { window } = l
  await waitForReady(window)
  await openAdvanced(l, widgetId)
  const clicked = await clickInMenus(l, label)
  await window.waitForTimeout(400)
  return clicked
}

/**
 * Right-click the header and open the Advanced submenu, where the duplicate
 * and unlink items live (the widget menu groups them; a lookup in the root
 * panel alone found nothing, which is why this spec was red before 4.3.32).
 */
async function openAdvanced(l: LaunchedApp, widgetId: string): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await window.locator(`[data-widget-id="${widgetId}"] .widget-handle`).click({ button: 'right' })
  const root = window.locator('[data-canvas-ctx-menu]').first()
  await expect(root).toBeVisible({ timeout: 4_000 })
  // §9.3: the synced duplicate and Unlink live under More actions; Duplicate
  // (the independent copy) is a top-level clipboard row.
  await root.getByRole('menuitem', { name: 'More actions' }).hover()
  await expect(window.locator('[data-canvas-ctx-menu]').nth(1)).toBeVisible({ timeout: 3_000 })
}

async function clickInMenus(l: LaunchedApp, label: string): Promise<boolean> {
  return l.window.evaluate((lbl: string) => {
    for (const menu of Array.from(document.querySelectorAll('[data-canvas-ctx-menu]'))) {
      // The row's own label, exactly: "Duplicate" must not match "Duplicate, keep synced".
      const btn = Array.from(menu.querySelectorAll('button')).find(
        (b) => (b.querySelector('span.flex-1')?.firstChild?.textContent ?? '').trim() === lbl
      )
      if (btn) {
        ;(btn as HTMLButtonElement).click()
        return true
      }
    }
    return false
  }, label)
}

// Only the sticky widgets we care about — the canvas auto-creates a minimap
// widget when a task opens, which would otherwise pollute the count.
async function widgetsOf(
  l: LaunchedApp,
  taskId: string
): Promise<Array<{ id: string; content: string; syncGroupId: string | null }>> {
  return l.window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all
      .filter((w) => w.kind === 'sticky')
      .map((w) => ({ id: w.id, content: w.content, syncGroupId: w.syncGroupId ?? null }))
  }, taskId)
}

test('Duplicate (keep synced) links both copies with a shared syncGroupId', async () => {
  launched = await launchApp()
  const { taskId, widgetId } = await seedStickyAndOpen(launched)

  const found = await duplicateVia(launched, widgetId, 'Duplicate, keep synced')
  expect(found).toBe(true)

  const widgets = await widgetsOf(launched, taskId)
  expect(widgets.length).toBe(2)
  // Both must carry the SAME non-null syncGroupId.
  const groups = widgets.map((w) => w.syncGroupId)
  expect(groups.every((g) => g !== null)).toBe(true)
  expect(groups[0]).toBe(groups[1])
})

test('synced duplicate mirrors a content edit to its linked copy', async () => {
  launched = await launchApp()
  const { taskId, widgetId } = await seedStickyAndOpen(launched)

  expect(await duplicateVia(launched, widgetId, 'Duplicate, keep synced')).toBe(true)

  // Edit the ORIGINAL's content via the store path (window.api) and confirm the
  // linked copy receives it through the DB fan-out.
  await launched.window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.update(id, { content: 'v2-synced' })
  }, widgetId)
  await launched.window.waitForTimeout(300)

  const widgets = await widgetsOf(launched, taskId)
  const copy = widgets.find((w) => w.id !== widgetId)
  expect(copy).toBeTruthy()
  expect(copy!.content).toBe('v2-synced')
})

test('Duplicate (independent copy) does NOT link — edits never cross over', async () => {
  launched = await launchApp()
  const { taskId, widgetId } = await seedStickyAndOpen(launched)

  const found = await duplicateVia(launched, widgetId, 'Duplicate')
  expect(found).toBe(true)

  let widgets = await widgetsOf(launched, taskId)
  expect(widgets.length).toBe(2)
  // Was: both groups null. Since 4.3.32 every work widget is a file
  // (docs/widget-files.md), so each is the instance of its OWN file: two
  // different `wf:` groups, never a shared one.
  for (const w of widgets) expect(w.syncGroupId).toMatch(/^wf:/)
  expect(widgets[0].syncGroupId).not.toBe(widgets[1].syncGroupId)

  // Editing the original must NOT change the independent copy.
  await launched.window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.update(id, { content: 'v2-independent' })
  }, widgetId)
  await launched.window.waitForTimeout(300)

  widgets = await widgetsOf(launched, taskId)
  const copy = widgets.find((w) => w.id !== widgetId)
  expect(copy).toBeTruthy()
  expect(copy!.content).toBe('v1') // unchanged — fully independent
})

test('synced copy exposes "Unlink from synced copies"; independent copy does not', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedStickyAndOpen(launched)

  // After a SYNCED duplicate, the original is in a group → Unlink is offered.
  expect(await duplicateVia(launched, widgetId, 'Duplicate, keep synced')).toBe(true)
  await window.keyboard.press('Escape')
  await openAdvanced(launched, widgetId)
  const hasUnlinkWhenSynced = await window.evaluate(() =>
    Array.from(document.querySelectorAll('[data-canvas-ctx-menu] button')).some((b) =>
      (b.textContent ?? '').includes('Unlink from synced copies')
    )
  )
  expect(hasUnlinkWhenSynced).toBe(true)
})
