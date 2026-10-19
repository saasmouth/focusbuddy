import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Verifies plexi-4.0 polish change 1 (section-child link-arming):
//   WidgetFrame's hub button (aria-label "Link to another work widget") used to be
//   gated `!isChildOfSection && linkDrag`; it is now just `linkDrag`. A
//   section child in a free/grid/stacks layout renders a full WidgetFrame
//   header, so it now shows the hub and can be a link SOURCE. icons/list
//   children render via CompactChildView (no WidgetFrame header at all), so
//   they structurally never show the hub — no extra gate needed there.
// Dropping ONTO a child (regression, pre-existing behavior) must still work.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

async function bodyPoint(window: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await window.locator(`[data-widget-id="${id}"]`).boundingBox()
  if (!box) throw new Error(`no bounding box for widget ${id}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

interface Seeded {
  taskId: string
  topLevelId: string
  sectionId: string
  childId: string
}

async function seedSectionWithChild(
  window: Page,
  taskTitle: string,
  layout: 'free' | 'grid' | 'stacks' | 'icons' | 'list'
): Promise<Seeded> {
  const seeded = await window.evaluate(
    async ({ title, layoutArg }: { title: string; layoutArg: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title })
      const topLevel = await api.widgets.create({
        taskId: task.id,
        kind: 'sticky',
        title: 'top-level',
        content: 'top-level',
        x: 60,
        y: 400,
        width: 200,
        height: 140
      })
      const section = await api.widgets.create({
        taskId: task.id,
        kind: 'section',
        title: 'Arming section',
        content: '',
        x: 450,
        y: 60,
        width: 380,
        height: 260,
        color: '#3b82f6'
      })
      await api.widgets.update(section.id, { layout: layoutArg as never })
      const child = await api.widgets.create({
        taskId: task.id,
        kind: 'sticky',
        title: 'child',
        content: 'child',
        x: 20,
        y: 20,
        width: 160,
        height: 100
      })
      await api.widgets.update(child.id, { parentSectionId: section.id })
      return { taskId: task.id, topLevelId: topLevel.id, sectionId: section.id, childId: child.id }
    },
    { title: taskTitle, layoutArg: layout }
  )
  await openTask(window, new RegExp(taskTitle))
  await window.waitForSelector(`[data-widget-id="${seeded.topLevelId}"]`, { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.sectionId}"]`, { timeout: 5_000 })
  await window.waitForTimeout(200)
  return seeded
}

// ── (a) free-layout section child shows the hub button ─────────────────────

test('(a) a section child in FREE layout renders a WidgetFrame with the hub button', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seeded = await seedSectionWithChild(window, 'Free layout child arming', 'free')

  // The child renders inside its own data-widget-id node (a full WidgetFrame,
  // since free/grid/stacks layouts use renderChild, not CompactChildView).
  const childFrame = window.locator(`[data-widget-id="${seeded.childId}"]`)
  await expect(childFrame).toBeVisible({ timeout: 5_000 })

  const hub = childFrame.getByRole('button', { name: 'Link to another work widget' })
  await expect(hub, 'free-layout section child shows the hub button').toBeVisible({ timeout: 4_000 })
})

// ── (b) arm from the child, drop onto a top-level widget ───────────────────

test('(b) arming the hub on a free-layout section child and dropping on a top-level widget creates a link sourced from the child', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seeded = await seedSectionWithChild(window, 'Free layout child arm and drop', 'free')

  const childFrame = window.locator(`[data-widget-id="${seeded.childId}"]`)
  const hub = childFrame.getByRole('button', { name: 'Link to another work widget' })
  await expect(hub).toBeVisible({ timeout: 4_000 })
  await hub.click()

  const drop = await bodyPoint(window, seeded.topLevelId)
  await window.mouse.click(drop.x, drop.y)
  await window.waitForTimeout(200)

  const links = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const ls = await api.widgetLinks.listByTask(tid)
    return ls.map((l) => ({ sourceWidgetId: l.sourceWidgetId, targetWidgetId: l.targetWidgetId, type: l.type }))
  }, seeded.taskId)

  expect(links.length, 'a link was created').toBe(1)
  expect(links[0].sourceWidgetId, 'the section child is the SOURCE').toBe(seeded.childId)
  expect(links[0].targetWidgetId, 'the top-level widget is the target').toBe(seeded.topLevelId)
})

// ── (c) icons/list children use CompactChildView — no hub, ever ────────────

for (const layout of ['icons', 'list'] as const) {
  test(`(c) a section child in ${layout.toUpperCase()} layout renders via CompactChildView with NO hub button`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    const seeded = await seedSectionWithChild(window, `${layout} layout no hub`, layout)

    // CompactChildView DOES stamp data-widget-id on its root div (for eject /
    // open gestures) but never mounts a WidgetFrame header — so the node
    // exists, but scoped to it there must be no hub button, regardless of
    // linkDrag arm state. Arm from the top-level widget first so linkDrag is
    // truthy (the exact condition the hub button is now gated on) and confirm
    // the compact child still renders nothing inside its own node.
    const childNode = window.locator(`[data-widget-id="${seeded.childId}"]`)
    await expect(childNode, 'CompactChildView still stamps data-widget-id').toBeVisible({ timeout: 5_000 })

    const topLevelFrame = window.locator(`[data-widget-id="${seeded.topLevelId}"]`)
    const topLevelHub = topLevelFrame.getByRole('button', { name: 'Link to another work widget' })
    await expect(topLevelHub).toBeVisible({ timeout: 4_000 })
    await topLevelHub.click() // arms linkDrag — the exact truthy state the hub gate checks

    const childHub = childNode.getByRole('button', { name: 'Link to another work widget' })
    await expect(childHub, 'the compact child has no hub button even while linkDrag is armed').toHaveCount(0)

    // Clean up the arm so it doesn't leak into other assertions on this page.
    await window.keyboard.press('Escape')
  })

  test(`(c-regression) dropping a link onto a section child in ${layout.toUpperCase()} layout still works`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    const seeded = await seedSectionWithChild(window, `${layout} layout drop regression`, layout)

    const topLevelFrame = window.locator(`[data-widget-id="${seeded.topLevelId}"]`)
    const hub = topLevelFrame.getByRole('button', { name: 'Link to another work widget' })
    await expect(hub).toBeVisible({ timeout: 4_000 })
    await hub.click()

    // CompactChildView stamps data-widget-id={child.id} on its own root div
    // (list row / icon tile), so the normal bodyPoint helper resolves fine.
    const drop = await bodyPoint(window, seeded.childId)
    await window.mouse.click(drop.x, drop.y)
    await window.waitForTimeout(200)

    const links = await window.evaluate(async (tid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ls = await api.widgetLinks.listByTask(tid)
      return ls.map((l) => ({ sourceWidgetId: l.sourceWidgetId, targetWidgetId: l.targetWidgetId }))
    }, seeded.taskId)

    expect(links.length, 'a link was created from the drop').toBe(1)
    expect(links[0].sourceWidgetId).toBe(seeded.topLevelId)
    expect(links[0].targetWidgetId, 'the link lands on the compact child').toBe(seeded.childId)
  })
}
