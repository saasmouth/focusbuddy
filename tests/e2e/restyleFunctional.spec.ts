/**
 * E2E spec: restyleFunctional — proves the design-system restyle of the
 * folders/desks/tasks surfaces (commit a49a0d9) did not break behavior.
 *
 * The restyle touched NewNodeDialog, Sidebar, DeskGallery, AllTasksView,
 * WorkspaceHeader and the canvas chrome (FloatingToolbar/ZoomControls/
 * CanvasBreadcrumb) with token/class swaps only. This spec drives the
 * real user-facing flows through each surface end to end.
 *
 * Retargeted 2026-10-10 to where those flows live now. The behaviour it
 * protects is unchanged; the furniture moved:
 *   - "Folders" are Rooms, and the sidebar no longer carries a folder/desk
 *     tree (role=treeitem). Rooms are organised on the All Rooms index, which
 *     is where a new Room appears and where it is renamed (its row action /
 *     right-click menu opens the house prompt dialog).
 *   - NewNodeDialog is a solid fb-card now, not the fb-glass-pillow form, and
 *     names what it makes ("New Room" / "Create Room", "New Desk" / "Create
 *     Desk"). A desk is filed into a Room from that Room's Desks index.
 *   - The minimap is built-in chrome, not a widget auto-added to every desk
 *     (Canvas sweeps legacy ones away), so an empty desk is genuinely empty
 *     and shows its empty state without first deleting anything.
 *
 *   1. Create a Room through NewNodeDialog; it lands on the All Rooms index.
 *   2. Create a desk inside that Room through NewNodeDialog, from the Room's
 *      Desks index; it is filed under the Room.
 *   3. Rename the Room from its index row; the rename persists.
 *   4. All Tasks: click through two filter chips, search, change sort,
 *      click a task row and assert it opens the canvas.
 *   5. Desk gallery: reach it with no active desk, click the Room's card,
 *      assert its canvas opens and the empty desk shows the restyled
 *      glass-pill empty state ("Drag an object...").
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

test('restyled folders/desks/tasks surfaces: functional flows still work', async () => {
  const { window, dispose } = await launchApp()
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  try {
    await waitForReady(window)

    // ------------------------------------------------------------------ //
    // 1. Create a Room via NewNodeDialog (fb:command-new-task with kind     //
    //    'folder' opens it in create/Room mode — the same event the stage   //
    //    strip's "new room" dispatches).                                    //
    // ------------------------------------------------------------------ //
    await window.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('fb:command-new-task', { detail: { parentId: null, kind: 'folder' } })
      )
    )

    const nameField = window.locator('[data-testid="newnode-name"]')
    const dialog1 = window.locator('form', { has: nameField })
    await expect(dialog1).toBeVisible({ timeout: 5_000 })
    await expect(dialog1.getByText('New Room', { exact: true })).toBeVisible()
    await nameField.fill('Restyle Folder Alpha')
    await dialog1.getByRole('button', { name: 'Create Room' }).click()
    await expect(dialog1).not.toBeVisible({ timeout: 5_000 })

    const nodeIdByTitle = (title: string): Promise<string | null> =>
      window.evaluate(async (t: string) => {
        const api = (
          window as unknown as {
            api: { nodes: { list: () => Promise<Array<{ id: string; title: string }>> } }
          }
        ).api
        const nodes = await api.nodes.list()
        return nodes.find((n) => n.title === t)?.id ?? null
      }, title)

    await expect.poll(() => nodeIdByTitle('Restyle Folder Alpha'), { timeout: 5_000 }).not.toBeNull()
    const folderId = (await nodeIdByTitle('Restyle Folder Alpha'))!

    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goRooms: () => void } } }
      w.__fbView?.getState().goRooms()
    })
    const roomItem = window.locator(
      `[data-testid="index-row-${folderId}"], [data-testid="index-card-${folderId}"]`
    )
    await expect(roomItem).toBeVisible({ timeout: 5_000 })
    await expect(roomItem).toContainText('Restyle Folder Alpha')
    console.log('Room "Restyle Folder Alpha" appears on the All Rooms index: OK')

    // ------------------------------------------------------------------ //
    // 2. Create a desk inside that Room, from the Room's Desks index.     //
    // ------------------------------------------------------------------ //
    await window.evaluate((id: string) => {
      const w = window as unknown as { __fbView?: { getState: () => { goDesks: (r: string) => void } } }
      w.__fbView?.getState().goDesks(id)
    }, folderId)
    await window.locator('[data-testid="desks-index-new"]').click()

    const dialog2 = window.locator('form', { has: nameField })
    await expect(dialog2).toBeVisible({ timeout: 5_000 })
    await expect(dialog2.getByText('New Desk', { exact: true })).toBeVisible()
    await nameField.fill('Restyle Task Alpha')
    await dialog2.getByRole('button', { name: 'Create Desk' }).click()
    await expect(dialog2).not.toBeVisible({ timeout: 5_000 })

    await expect.poll(() => nodeIdByTitle('Restyle Task Alpha'), { timeout: 5_000 }).not.toBeNull()
    const taskId = (await nodeIdByTitle('Restyle Task Alpha'))!
    const parentOfTask = await window.evaluate(async (id: string) => {
      const api = (
        window as unknown as {
          api: { nodes: { list: () => Promise<Array<{ id: string; parentId: string | null }>> } }
        }
      ).api
      return (await api.nodes.list()).find((n) => n.id === id)?.parentId ?? null
    }, taskId)
    expect(parentOfTask, 'the desk is filed under the Room it was created from').toBe(folderId)
    console.log('Desk "Restyle Task Alpha" is created inside the Room: OK')

    // ------------------------------------------------------------------ //
    // 3. Rename the Room from its index row (right-click → Rename room),  //
    //    through the house prompt dialog.                                  //
    // ------------------------------------------------------------------ //
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goRooms: () => void } } }
      w.__fbView?.getState().goRooms()
    })
    await expect(roomItem).toBeVisible({ timeout: 5_000 })
    await roomItem.click({ button: 'right' })
    await window.locator('[data-testid="index-context-menu-rename"]').click()

    const renameInput = window.locator('[data-testid="prompt-dialog-input"]')
    await expect(renameInput).toBeVisible({ timeout: 3_000 })
    await expect(renameInput).toHaveValue('Restyle Folder Alpha')
    await renameInput.fill('Restyle Folder Alpha Renamed')
    await window.locator('[data-testid="prompt-dialog-confirm"]').click()
    await expect(window.locator('[data-testid="prompt-dialog"]')).toHaveCount(0, { timeout: 3_000 })
    await expect(roomItem).toContainText('Restyle Folder Alpha Renamed', { timeout: 5_000 })
    await expect.poll(() => nodeIdByTitle('Restyle Folder Alpha Renamed'), { timeout: 5_000 }).toBe(folderId)
    console.log('Room rename through the styled prompt persisted: OK')

    // ------------------------------------------------------------------ //
    // 4. All Tasks: filter chips, search, sort, click row opens canvas.   //
    // ------------------------------------------------------------------ //
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goAllTasks: () => void } } }
      w.__fbView?.getState().goAllTasks()
    })
    await window.waitForTimeout(500)
    await expect(window.getByText('All Tasks', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Click through two filter chips.
    await window.getByRole('button', { name: /^Overdue/ }).click()
    await window.waitForTimeout(200)
    await window.getByRole('button', { name: /^All open/ }).click()
    await window.waitForTimeout(200)

    // Search box. Its placeholder has read "Search desks…" since the S6
    // renames (9320c6b3, 2026-08-25) — a "task" node is a desk.
    await window.getByPlaceholder('Search desks…').fill('Restyle Task Alpha')
    await window.waitForTimeout(300)
    // Scoped to the list: creating the desk opened it, so the open-item tray
    // carries a button with the same name.
    const taskListRow = window
      .getByRole('listitem')
      .getByRole('button', { name: 'Restyle Task Alpha', exact: true })
    await expect(taskListRow).toBeVisible({ timeout: 5_000 })
    console.log('Filter chips + search narrowed to the created task: OK')

    // Sort dropdown.
    await window.locator('select').selectOption('due')
    await window.waitForTimeout(200)
    console.log('Sort dropdown change accepted: OK')

    // Click the task row — assert it opens the canvas (breadcrumb + toolbar chrome).
    await taskListRow.click()
    await expect(window.locator('[data-testid="desk-context-trigger"]')).toBeVisible({
      timeout: 6_000
    })
    console.log('Clicking a task row in All Tasks opens the canvas: OK')

    // ------------------------------------------------------------------ //
    // 5. Desk gallery: reach it with no active desk, click a desk card.   //
    // ------------------------------------------------------------------ //
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbView?: { getState: () => { goProject: (id: string) => void } }
      }
      w.__fbView?.getState().goProject('no-such-desk-restyle-functional')
    })

    const gallery = window.locator('[data-testid="desk-gallery"]')
    await expect(gallery).toBeVisible({ timeout: 8_000 })
    await expect(gallery.getByText('Your desks')).toBeVisible()
    console.log('Desk gallery renders with no active desk: OK')

    const deskCard = window.locator(`[data-testid="desk-card-${folderId}"]`)
    await expect(deskCard).toBeVisible({ timeout: 5_000 })
    await deskCard.click()

    await expect(gallery).not.toBeVisible({ timeout: 6_000 })
    console.log('Clicking a desk card opens its canvas: OK')

    // An empty desk is genuinely empty: the minimap is built-in chrome now,
    // not a widget Canvas adds on first open, so there is nothing to clear
    // before the empty state can show.
    // Empty desk: the restyled glass-pill empty state should render.
    await expect(window.getByText('Drag an object from the palette onto the desk.')).toBeVisible({
      timeout: 5_000
    })
    console.log('Empty-desk glass-pill empty state renders: OK')

    // ------------------------------------------------------------------ //
    // No uncaught console errors during the whole flow.                   //
    // ------------------------------------------------------------------ //
    const realErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('Non-Error promise') &&
        !e.includes('FOREIGN KEY')
    )
    if (realErrors.length > 0) {
      console.error('Uncaught JS errors:', realErrors)
    }
    expect(realErrors).toHaveLength(0)
  } finally {
    await dispose()
  }
})
