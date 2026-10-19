import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, openNewDesk, addWidgetToDesk, type LaunchedApp } from './_helpers'

// Typing into a work widget that was just added must reach the work widget,
// never the desk's single-key quick-add (S = sticky, T = table, …).
//
// Reported while capturing a help clip: a Tasks work widget was added from the
// side menu (right-click → "Add to this desk"), a task was typed, and the
// letters made a sticky and a table on the desk instead.
//
// What this found (4.3.32): a person who clicks into the "Add a task" box and
// types gets the task; that path never leaked (NWT-1). But nothing took the
// keyboard after placement: focus stayed on the document body, so whatever was
// typed straight away went nowhere, and the moment nothing was engaged (a
// click that landed on the empty desk, Escape) the same letters were desk
// shortcuts. Now the placed work widget takes focus in its own entry field
// (NWT-2), and quick-add ignores keys aimed anywhere inside a work widget.
// NWT-3 keeps the desk's quick-add working when nothing is engaged.
//
// Throwaway profiles only (launchApp mints a temp userData per test).

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

async function boot(): Promise<Page> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  await waitForReady(launched.window)
  return launched.window
}

type W = { id: string; kind: string }
async function deskKinds(window: Page, deskId: string): Promise<W[]> {
  return window.evaluate(
    (d) =>
      (
        window as unknown as { __fbWidgets: { getState: () => { widgets: Array<W & { taskId: string }> } } }
      ).__fbWidgets
        .getState()
        .widgets.filter((w) => w.taskId === d && w.kind !== 'minimap')
        .map((w) => ({ id: w.id, kind: w.kind })),
    deskId
  )
}

async function nodeTitles(window: Page): Promise<string[]> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.nodes.list()).map((n) => n.title)
  })
}

/** Add a Tasks work widget the way the clip did; returns its widget id. */
async function addTasksWidget(window: Page, deskId: string): Promise<string> {
  await addWidgetToDesk(window, 'task-list')
  const list = (await deskKinds(window, deskId)).find((w) => w.kind === 'task-list')
  expect(list, 'a Tasks work widget is on the desk').toBeTruthy()
  return list!.id
}

// Letters that are quick-add keys (S = sticky, T = table) in a real task.
const TASK = 'Send the stats to Tess'

test('NWT-1 click into the new Tasks work widget and type: the task is added, the desk makes nothing', async () => {
  const window = await boot()
  const deskId = await openNewDesk(window, 'Typing desk')
  const id = await addTasksWidget(window, deskId)
  const input = window.locator(`[data-widget-id="${id}"]`).first().getByPlaceholder('Add a task to this desk')
  await expect(input).toBeVisible({ timeout: 8_000 })
  await input.click()
  await window.keyboard.type(TASK)
  await expect(input).toHaveValue(TASK)
  await window.keyboard.press('Enter')
  await expect.poll(() => nodeTitles(window), { timeout: 8_000 }).toContain(TASK)
  // Give a stray quick-add time to land before asserting there was none.
  await window.waitForTimeout(600)
  expect((await deskKinds(window, deskId)).map((w) => w.kind)).toEqual(['task-list'])
})

test('NWT-2 a just-placed Tasks work widget takes the keyboard: typing straight away goes into it', async () => {
  const window = await boot()
  const deskId = await openNewDesk(window, 'Typing desk')
  const id = await addTasksWidget(window, deskId)
  const input = window.locator(`[data-widget-id="${id}"]`).first().getByPlaceholder('Add a task to this desk')
  await expect(input).toBeVisible({ timeout: 8_000 })
  // What has focus right after placement: the new work widget's entry field.
  await expect(input).toBeFocused({ timeout: 3_000 })
  await window.keyboard.type(TASK)
  await expect(input).toHaveValue(TASK)
  await window.waitForTimeout(600)
  expect((await deskKinds(window, deskId)).map((w) => w.kind)).toEqual(['task-list'])
})

test('NWT-3 with nothing engaged the desk still quick-adds: click the empty desk, press S', async () => {
  const window = await boot()
  const deskId = await openNewDesk(window, 'Typing desk')
  const id = await addTasksWidget(window, deskId)
  const frame = window.locator(`[data-widget-id="${id}"]`).first()
  await expect(frame).toBeVisible({ timeout: 8_000 })
  const wb = (await frame.boundingBox())!
  const cb = (await window.locator('[data-canvas-surface="true"]').boundingBox())!
  // The canvas corner farthest from the new work widget is empty desk.
  const corners = [
    { x: cb.x + 80, y: cb.y + 80 },
    { x: cb.x + cb.width - 80, y: cb.y + 80 },
    { x: cb.x + 80, y: cb.y + cb.height - 80 },
    { x: cb.x + cb.width - 80, y: cb.y + cb.height - 80 }
  ]
  const cx = wb.x + wb.width / 2
  const cy = wb.y + wb.height / 2
  const far = corners.sort((a, b) => Math.hypot(b.x - cx, b.y - cy) - Math.hypot(a.x - cx, a.y - cy))[0]
  await window.mouse.click(far.x, far.y)
  await expect.poll(() => window.evaluate(() => document.activeElement?.tagName ?? 'none')).toBe('BODY')
  await window.keyboard.press('s')
  await expect
    .poll(async () => (await deskKinds(window, deskId)).map((w) => w.kind).sort(), { timeout: 8_000 })
    .toEqual(['sticky', 'task-list'])
})

/** Right-click the empty desk → Add object → Tools → Tasks. */
async function addTasksByAddObject(window: Page): Promise<void> {
  const surface = window.locator('[data-canvas-surface="true"]')
  await surface.click({ button: 'right', position: { x: 360, y: 300 } })
  const root = window.locator('[data-canvas-ctx-menu]').first()
  await expect(root).toBeVisible({ timeout: 4_000 })
  await root.getByRole('menuitem', { name: 'Add object' }).hover()
  const addMenu = window.locator('[data-canvas-ctx-menu]').nth(1)
  await expect(addMenu).toBeVisible({ timeout: 3_000 })
  await addMenu.getByRole('menuitem', { name: 'Tools' }).hover()
  const tools = window.locator('[data-canvas-ctx-menu]').nth(2)
  await expect(tools).toBeVisible({ timeout: 3_000 })
  await tools.getByRole('menuitem', { name: 'Tasks', exact: true }).click()
}

test('NWT-4 right-click Add object places a Tasks work widget that takes the keyboard, like Add to this desk', async () => {
  const window = await boot()
  const deskId = await openNewDesk(window, 'Typing desk')
  await addTasksByAddObject(window)
  await expect
    .poll(async () => (await deskKinds(window, deskId)).map((w) => w.kind), { timeout: 8_000 })
    .toEqual(['task-list'])
  const id = (await deskKinds(window, deskId))[0].id
  const input = window.locator(`[data-widget-id="${id}"]`).first().getByPlaceholder('Add a task to this desk')
  await expect(input).toBeVisible({ timeout: 8_000 })
  // Before 4.3.32's fix this path left focus on the body (only the side
  // menu, a drag and the palette handed it over), so TASK made a sticky
  // and a table the moment nothing was engaged.
  await expect(input).toBeFocused({ timeout: 3_000 })
  await window.keyboard.type(TASK)
  await expect(input).toHaveValue(TASK)
  await window.waitForTimeout(600)
  expect((await deskKinds(window, deskId)).map((w) => w.kind)).toEqual(['task-list'])
})

test('NWT-5 a quick-add key does not move focus into the work widget it makes', async () => {
  const window = await boot()
  // No default quick-add key makes a Tasks work widget (the only kind with a
  // primary input today), so map K to it the way Settings → Keyboard does.
  await window.evaluate(() => localStorage.setItem('fb.keymap.quickadd', JSON.stringify({ 'task-list': 'K' })))
  await window.reload()
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Typing desk')
  // Engage nothing: a click on the empty desk (where NWT-4 right-clicks).
  await window.locator('[data-canvas-surface="true"]').click({ position: { x: 360, y: 300 } })
  await expect.poll(() => window.evaluate(() => document.activeElement?.tagName ?? 'none')).toBe('BODY')
  await window.keyboard.press('k')
  await expect
    .poll(async () => (await deskKinds(window, deskId)).map((w) => w.kind), { timeout: 8_000 })
    .toEqual(['task-list'])
  const id = (await deskKinds(window, deskId))[0].id
  const input = window.locator(`[data-widget-id="${id}"]`).first().getByPlaceholder('Add a task to this desk')
  await expect(input).toBeVisible({ timeout: 8_000 })
  // Long enough for focusNewWidget's frame polling to have acted, if it ran.
  await window.waitForTimeout(800)
  await expect(input).not.toBeFocused()
  expect(await window.evaluate(() => document.activeElement?.tagName ?? 'none')).toBe('BODY')
})
