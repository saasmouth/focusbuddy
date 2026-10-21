import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, openProduct } from './_helpers'

// Verifies the Rooms/Desks restructure (Plexi3.0, commits 0ba1901 + 4802064):
//
//   1. DECOUPLING — a folder ("Room") only shows in the Plans portfolio when
//      is_plan = 1. A plain Room with a Desk (task) inside must NOT surface in
//      Plans; a Room explicitly created as a Plan must.
//   2. NAV — the sidebar "Rooms" entry opens the rooms index and its group
//      lists "All desks" (rooms-index-view / desks-index-view).
//   3. INDEX PAGES — five view modes (gallery/list/kanban/table/timeline),
//      search, group-by and filter all function.
//
// Strategy: node creation is IPC-driven (window.api.nodes.create) since a real
// drag/drop desk-creation gesture is not the surface under test here; nav and
// the index-page controls are UI-driven (real clicks/typing) since that is
// exactly the user-visible contract being verified.

test('boots cleanly with no console errors from the plan-flag migration', async () => {
  const errors: string[] = []
  const { window, dispose } = await launchApp()
  try {
    window.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    window.on('pageerror', (err) => errors.push(err.message))
    await waitForReady(window)
    // Give any deferred boot work (migration, initial fetches) a moment to settle.
    await window.waitForTimeout(500)
    // Filter out the known-benign network 404 against the production signal
    // server's /features/votes endpoint — confirmed via a response listener
    // that this is the only 404 firing at boot, the test app has no network
    // reachability to that host, and it is unrelated to the plan-flag
    // migration under test here (a "Failed to load resource" console line
    // carries no URL, so match on the generic resource-load-failure text).
    const relevant = errors.filter((e) => !e.includes('Failed to load resource'))
    expect(relevant, `console errors on boot: ${JSON.stringify(relevant)}`).toEqual([])
  } finally {
    await dispose()
  }
})

test('sidebar Rooms nav lists All desks, and both index views render', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    // Rooms opens the rooms index; its chevron group (open by default) holds
    // "All desks". There is no "All rooms" row any more: Rooms itself is that
    // page. Scoped to the desk sidebar, because Home also carries "All desks"
    // buttons (hero + dashboard rail) and an unscoped query matches all three.
    const sidebar = window.locator('[data-testid="desk-sidebar"]')

    await sidebar.getByRole('button', { name: 'Rooms', exact: true }).click()
    await expect(window.locator('[data-testid="rooms-index-view"]')).toBeVisible({ timeout: 8_000 })

    await sidebar.getByRole('button', { name: 'All desks', exact: true }).click()
    await expect(window.locator('[data-testid="desks-index-view"]')).toBeVisible({ timeout: 8_000 })

    await sidebar.getByRole('button', { name: 'Rooms', exact: true }).click()
    await expect(window.locator('[data-testid="rooms-index-view"]')).toBeVisible({ timeout: 8_000 })
  } finally {
    await dispose()
  }
})

test('Rooms index: five modes, search, group and filter all function', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed two Rooms: one plain, one explicitly a Plan, each with one Desk.
    const roomA = (await window.evaluate(
      () => window.api.nodes.create({ parentId: null, kind: 'folder', title: 'Alpha Plain Room' }),
      undefined
    )) as { id: string }
    await window.evaluate(
      (pid: string) => window.api.nodes.create({ parentId: pid, kind: 'task', title: 'Alpha Desk' }),
      roomA.id
    )

    const roomB = (await window.evaluate(
      () =>
        window.api.nodes.create({
          parentId: null,
          kind: 'folder',
          title: 'Beta Plan Room',
          isPlan: true
        }),
      undefined
    )) as { id: string }
    await window.evaluate(
      (pid: string) => window.api.nodes.create({ parentId: pid, kind: 'task', title: 'Beta Desk' }),
      roomB.id
    )

    // The nodes created above went straight through IPC, bypassing the
    // renderer's node store (which only picks up new nodes via its own
    // create()/refresh() actions). Reload so the store hydrates them — same
    // pattern as deskGallery.spec.ts.
    await window.reload()
    await waitForReady(window)

    await window.getByRole('button', { name: 'Rooms', exact: true }).click()
    await expect(window.locator('[data-testid="rooms-index-view"]')).toBeVisible({ timeout: 8_000 })

    // Both rooms visible in gallery (default) mode.
    await expect(window.locator(`[data-testid="index-card-${roomA.id}"]`)).toBeVisible()
    await expect(window.locator(`[data-testid="index-card-${roomB.id}"]`)).toBeVisible()

    // --- Mode switching ---
    await window.locator('[data-testid="rooms-index-mode-list"]').click()
    await expect(window.locator(`[data-testid="index-row-${roomA.id}"]`)).toBeVisible()

    await window.locator('[data-testid="rooms-index-mode-kanban"]').click()
    await expect(window.locator(`[data-testid="kanban-card-${roomA.id}"]`)).toBeVisible()

    await window.locator('[data-testid="rooms-index-mode-table"]').click()
    await expect(window.locator(`[data-testid="table-row-${roomA.id}"]`)).toBeVisible()

    await window.locator('[data-testid="rooms-index-mode-timeline"]').click()
    await expect(window.locator(`[data-testid="timeline-row-${roomA.id}"]`)).toBeVisible()

    await window.locator('[data-testid="rooms-index-mode-gallery"]').click()
    await expect(window.locator(`[data-testid="index-card-${roomA.id}"]`)).toBeVisible()

    // --- Search narrows ---
    await window.locator('[data-testid="rooms-index-search"]').fill('Alpha')
    await expect(window.locator(`[data-testid="index-card-${roomA.id}"]`)).toBeVisible()
    await expect(window.locator(`[data-testid="index-card-${roomB.id}"]`)).toHaveCount(0)
    await window.locator('[data-testid="rooms-index-search"]').fill('')
    await expect(window.locator(`[data-testid="index-card-${roomB.id}"]`)).toBeVisible()

    // --- Group re-buckets (Type: Rooms vs Plans) ---
    const roomsIndex = window.locator('[data-testid="rooms-index-view"]')
    await window.locator('[data-testid="rooms-index-group"]').selectOption('type')
    await expect(roomsIndex.getByText('Rooms', { exact: true })).toBeVisible()
    await expect(roomsIndex.getByText('Plans', { exact: true })).toBeVisible()
    await window.locator('[data-testid="rooms-index-group"]').selectOption('none')

    // --- Filter subsets ---
    await window.locator('[data-testid="rooms-index-filter"]').selectOption('plans')
    await expect(window.locator(`[data-testid="index-card-${roomB.id}"]`)).toBeVisible()
    await expect(window.locator(`[data-testid="index-card-${roomA.id}"]`)).toHaveCount(0)
    await window.locator('[data-testid="rooms-index-filter"]').selectOption('rooms')
    await expect(window.locator(`[data-testid="index-card-${roomA.id}"]`)).toBeVisible()
    await expect(window.locator(`[data-testid="index-card-${roomB.id}"]`)).toHaveCount(0)
    await window.locator('[data-testid="rooms-index-filter"]').selectOption('all')
  } finally {
    await dispose()
  }
})

test('decoupling: a plain Room with a Desk does not appear in Plans; an is_plan Room does', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const plainRoom = (await window.evaluate(
      () => window.api.nodes.create({ parentId: null, kind: 'folder', title: 'Plain Room With Desk' }),
      undefined
    )) as { id: string }
    await window.evaluate(
      (pid: string) => window.api.nodes.create({ parentId: pid, kind: 'task', title: 'A Desk' }),
      plainRoom.id
    )

    const planRoom = (await window.evaluate(
      () =>
        window.api.nodes.create({
          parentId: null,
          kind: 'folder',
          title: 'Real Plan Room',
          isPlan: true
        }),
      undefined
    )) as { id: string }
    await window.evaluate(
      (pid: string) => window.api.nodes.create({ parentId: pid, kind: 'task', title: 'Plan Desk' }),
      planRoom.id
    )

    // Deterministic check straight against the IPC contract the Plans view reads.
    const summaries = (await window.evaluate(() => window.api.projects.list())) as Array<{
      id: string
      title: string
    }>
    const ids = summaries.map((s) => s.id)
    expect(ids).not.toContain(plainRoom.id)
    expect(ids).toContain(planRoom.id)

    // UI confirmation: open Plans and check the portfolio cards directly.
    await openProduct(window, 'projects')
    await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator(`[data-testid="project-card-${planRoom.id}"]`)).toBeVisible()
    await expect(window.locator(`[data-testid="project-card-${plainRoom.id}"]`)).toHaveCount(0)
  } finally {
    await dispose()
  }
})
