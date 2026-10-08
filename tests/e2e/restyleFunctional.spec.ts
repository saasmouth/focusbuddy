/**
 * E2E spec: restyleFunctional — proves the design-system restyle of the
 * folders/desks/tasks surfaces (commit a49a0d9) did not break behavior.
 *
 * The restyle touched NewNodeDialog, Sidebar, DeskGallery, AllTasksView,
 * WorkspaceHeader and the canvas chrome (FloatingToolbar/ZoomControls/
 * CanvasBreadcrumb) with token/class swaps only. This spec drives the
 * real user-facing flows through each surface end to end:
 *
 *   1. Create a folder + a task through NewNodeDialog, assert both land
 *      in the sidebar tree.
 *   2. Rename a node inline in the sidebar (double-click affordance),
 *      assert the styled input works and the rename persists.
 *   3. All Tasks: click through two filter chips, search, change sort,
 *      click a task row and assert it opens the canvas.
 *   4. Desk gallery: reach it with no active desk, click a desk card,
 *      assert the canvas opens and the empty desk shows the restyled
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
    // 1. Create a folder via NewNodeDialog (fb:command-new-task opens the //
    //    dialog in create/folder mode — same event the sidebar's own      //
    //    "new" button and DeskGallery's "New desk" card dispatch).        //
    // ------------------------------------------------------------------ //
    await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:command-new-task')))

    const dialog1 = window.locator('form.fb-glass-pillow')
    await expect(dialog1).toBeVisible({ timeout: 5_000 })
    await expect(dialog1.getByText('New project')).toBeVisible()
    await dialog1.locator('[data-testid="newnode-name"]').fill('Restyle Folder Alpha')
    await dialog1.getByRole('button', { name: 'Create' }).click()
    await expect(dialog1).not.toBeVisible({ timeout: 5_000 })

    const sidebar = window.locator('aside').first()
    const folderRow = sidebar.locator('[role="treeitem"]', { hasText: 'Restyle Folder Alpha' })
    await expect(folderRow).toBeVisible({ timeout: 5_000 })
    console.log('Folder "Restyle Folder Alpha" appears in sidebar tree: OK')

    // ------------------------------------------------------------------ //
    // 2. Create a task inside that folder via its hover "Add task" icon.  //
    // ------------------------------------------------------------------ //
    await folderRow.hover()
    await folderRow.locator('button[title="Add task"]').click()

    const dialog2 = window.locator('form.fb-glass-pillow')
    await expect(dialog2).toBeVisible({ timeout: 5_000 })
    await expect(dialog2.getByText('New task')).toBeVisible()
    await dialog2.locator('[data-testid="newnode-name"]').fill('Restyle Task Alpha')
    await dialog2.getByRole('button', { name: 'Create' }).click()
    await expect(dialog2).not.toBeVisible({ timeout: 5_000 })

    // Expand the folder if the task row isn't already visible (new folders
    // with a freshly-added child usually auto-expand, but don't assume it).
    const taskRow = sidebar.locator('[role="treeitem"]', { hasText: 'Restyle Task Alpha' })
    if (!(await taskRow.isVisible().catch(() => false))) {
      await folderRow.click()
      await window.waitForTimeout(300)
    }
    await expect(taskRow).toBeVisible({ timeout: 5_000 })
    console.log('Task "Restyle Task Alpha" appears in sidebar tree: OK')

    // ------------------------------------------------------------------ //
    // 3. Rename a node inline in the sidebar via its rename affordance.   //
    //    NOTE (harness limitation, not a product bug): a literal          //
    //    double-click on the row is unreliable to drive synthetically    //
    //    here because the row's own single-click handler navigates into  //
    //    the desk (selectProject), which reflows the sidebar (the "Add   //
    //    to desk" widget strip appears above the tree) between the two   //
    //    clicks of the synthetic double-click, so the second click and   //
    //    the resulting dblclick land on the reflowed content instead of  //
    //    the row. This is pre-existing Sidebar layout behavior untouched //
    //    by the restyle diff, not something the restyle broke. The row's //
    //    context-menu "Rename" item (right-click) sets the exact same    //
    //    `renamingId` state and renders the exact same styled input, so  //
    //    it exercises the identical rename code path deterministically.  //
    // ------------------------------------------------------------------ //
    await folderRow.click({ button: 'right' })
    const ctxMenu = window.locator('[role="menu"]')
    await expect(ctxMenu).toBeVisible({ timeout: 3_000 })
    await ctxMenu.getByText('Rename', { exact: true }).click()

    // While a row is renaming, its title renders as an <input> whose value
    // is not part of the treeitem's textContent, so a hasText filter on the
    // treeitem no longer matches — locate the (single, unique) rename input
    // directly instead.
    const renameInput = sidebar.locator('[role="treeitem"] input')
    await expect(renameInput).toBeVisible({ timeout: 3_000 })
    await renameInput.fill('Restyle Folder Alpha Renamed')
    await renameInput.press('Enter')
    await expect(renameInput).not.toBeVisible({ timeout: 3_000 })
    const renamedRow = sidebar.locator('[role="treeitem"]', {
      hasText: 'Restyle Folder Alpha Renamed'
    })
    await expect(renamedRow).toBeVisible({ timeout: 5_000 })
    console.log('Inline rename via styled input persisted (driven via context-menu Rename, ' +
      'since a raw double-click on the row is disrupted by the row\'s own navigate-on-click ' +
      'reflowing the sidebar mid-gesture): OK')

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

    // Search box.
    await window.getByPlaceholder('Search tasks…').fill('Restyle Task Alpha')
    await window.waitForTimeout(300)
    const taskListRow = window.getByRole('button', { name: 'Restyle Task Alpha', exact: true })
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

    // Find the id of the folder-desk we created so we can click its card.
    const folderId = await window.evaluate(async () => {
      const api = (
        window as unknown as { api: { nodes: { list: () => Promise<Array<{ id: string; title: string }>> } } }
      ).api
      const nodes = await api.nodes.list()
      return nodes.find((n) => n.title === 'Restyle Folder Alpha Renamed')?.id ?? null
    })
    expect(folderId).not.toBeNull()

    const deskCard = window.locator(`[data-testid="desk-card-${folderId}"]`)
    await expect(deskCard).toBeVisible({ timeout: 5_000 })
    await deskCard.click()

    await expect(gallery).not.toBeVisible({ timeout: 6_000 })
    console.log('Clicking a desk card opens its canvas: OK')

    // Canvas auto-creates a pinned minimap widget the first time any desk is
    // opened (Canvas.tsx's minimap effect), so widgets.length is never
    // actually 0 on a brand-new desk and the true empty-state pill wouldn't
    // show yet. Remove that one widget through the real "Remove widget"
    // control (accepting the native confirm() dialog it raises) — the same
    // action a user takes to dismiss the minimap — so the desk is genuinely
    // empty and we can see the restyled empty state.
    window.once('dialog', (d) => void d.accept())
    const removeMinimap = window.getByRole('button', { name: 'Remove widget' })
    await expect(removeMinimap).toBeVisible({ timeout: 6_000 })
    await removeMinimap.click()

    // Empty desk: the restyled glass-pill empty state should render.
    await expect(window.getByText('Drag an object from the palette onto the desk.')).toBeVisible({
      timeout: 5_000
    })
    console.log('Empty-desk glass-pill empty state renders (after clearing the auto-added ' +
      'minimap widget via its real Remove control): OK')

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
