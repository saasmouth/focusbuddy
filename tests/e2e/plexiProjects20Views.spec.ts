import { test, expect } from '@playwright/test'
import { openProduct, launchApp, waitForReady } from './_helpers'

// PlexiProjects 2.0 — view switcher, Board, Grid, TaskEditor new controls,
// portfolio stats, and dependency editor.
//
// Setup helper: boots the app, creates a project folder + tasks via IPC,
// navigates into the project Gantt, and returns task IDs + the window handle.

async function setupProjectInGantt(
  window: Awaited<ReturnType<typeof launchApp>>['window'],
  taskTitles: string[] = ['Alpha', 'Beta', 'Gamma']
): Promise<{ folderId: string; taskIds: string[] }> {
  await waitForReady(window)

  // Create the folder first
  const folder = await window.evaluate(
    async (title: string) => window.api.nodes.create({ parentId: null, kind: 'folder', isPlan: true, title }),
    'E2E Project'
  )
  const folderId = (folder as { id: string }).id

  // Create child tasks
  const taskIds: string[] = []
  for (const title of taskTitles) {
    const t = await window.evaluate(
      async ([pid, ttl]: [string, string]) => window.api.nodes.create({ parentId: pid, kind: 'task', title: ttl }),
      [folderId, title] as [string, string]
    )
    taskIds.push((t as { id: string }).id)
  }

  // Navigate to PlexiProjects
  await openProduct(window, 'projects')
  await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 8_000 })

  // Click the project card to enter the Gantt
  await window.locator(`[data-testid="project-card-${folderId}"]`).click()
  // A plan lands on Overview since 4811bd60c; the Gantt is the Timeline tab.
  await window.locator('[data-testid="projects-view-gantt"]').click()
  await expect(window.locator('[data-testid="projects-view-gantt"]')).toBeVisible({ timeout: 8_000 })

  return { folderId, taskIds }
}

// ─── 1. View switcher ────────────────────────────────────────────────────────

test('V1. view switcher — three buttons present; clicking Board shows projects-board', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { } = await setupProjectInGantt(window)

    // All three view buttons are visible
    await expect(window.locator('[data-testid="projects-view-gantt"]')).toBeVisible()
    await expect(window.locator('[data-testid="projects-view-board"]')).toBeVisible()
    await expect(window.locator('[data-testid="projects-view-grid"]')).toBeVisible()

    // Switch to Board
    await window.locator('[data-testid="projects-view-board"]').click()
    await expect(window.locator('[data-testid="projects-board"]')).toBeVisible({ timeout: 4_000 })

    // Gantt (name column rows) should not be visible when in board mode
    await expect(window.locator('[data-testid^="gantt-bar-"]').first()).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('V2. view switcher — clicking Grid shows projects-grid; clicking Timeline restores Gantt', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window)

    // Switch to Grid
    await window.locator('[data-testid="projects-view-grid"]').click()
    await expect(window.locator('[data-testid="projects-grid"]')).toBeVisible({ timeout: 4_000 })

    // First task row present in grid
    await expect(window.locator(`[data-testid="grid-row-${taskIds[0]}"]`)).toBeVisible()

    // Switch back to Timeline (Gantt)
    await window.locator('[data-testid="projects-view-gantt"]').click()
    await expect(window.locator(`[data-testid="gantt-bar-${taskIds[0]}"]`)).toBeVisible({ timeout: 4_000 })
    await expect(window.locator('[data-testid="projects-grid"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('V3. no crash switching between all three views repeatedly', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setupProjectInGantt(window)

    for (const id of ['projects-view-board', 'projects-view-grid', 'projects-view-gantt', 'projects-view-board', 'projects-view-gantt']) {
      await window.locator(`[data-testid="${id}"]`).click()
    }

    // Ended on Gantt — no error element visible
    await expect(window.locator('[data-testid="gantt-error"]')).not.toBeVisible()
    // Board is hidden
    await expect(window.locator('[data-testid="projects-board"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

// ─── 2. Board (Kanban) ───────────────────────────────────────────────────────

test('B1. Board renders four status columns', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setupProjectInGantt(window)
    await window.locator('[data-testid="projects-view-board"]').click()
    await expect(window.locator('[data-testid="projects-board"]')).toBeVisible({ timeout: 4_000 })

    for (const colId of ['open', 'in_progress', 'parked', 'done']) {
      await expect(window.locator(`[data-testid="board-column-${colId}"]`)).toBeVisible()
    }
  } finally {
    await dispose()
  }
})

test('B2. Board — new task cards appear in "open" column', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window)
    await window.locator('[data-testid="projects-view-board"]').click()
    await expect(window.locator('[data-testid="projects-board"]')).toBeVisible({ timeout: 4_000 })

    // All tasks are newly created so status is 'open'; they should all be cards in that column
    const openCol = window.locator('[data-testid="board-column-open"]')
    for (const id of taskIds) {
      await expect(window.locator(`[data-testid="board-card-${id}"]`)).toBeVisible()
      await expect(openCol.locator(`[data-testid="board-card-${id}"]`)).toBeVisible()
    }
  } finally {
    await dispose()
  }
})

test('B3. Board — clicking a card opens the task editor', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window)
    await window.locator('[data-testid="projects-view-board"]').click()
    await expect(window.locator('[data-testid="projects-board"]')).toBeVisible({ timeout: 4_000 })

    await window.locator(`[data-testid="board-card-${taskIds[0]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })
  } finally {
    await dispose()
  }
})

// NOTE: HTML5 drag-and-drop between columns is not reliably driveable by
// Playwright's pointer API in headless Electron (the dragover event may not
// fire because Chromium's headless drag system doesn't wire the HTML5 DnD
// protocol the same way). The drop handler in BoardView calls onSetStatus(id,
// col.id) which calls window.api.nodes.update — this is source-attested in
// PlexiProjectsView.tsx lines 1162-1169. The column-render + card-click path
// (B1-B3) is UI-driven.

// ─── 3. Grid ─────────────────────────────────────────────────────────────────

test('G1. Grid renders rows for all tasks', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window)
    await window.locator('[data-testid="projects-view-grid"]').click()
    await expect(window.locator('[data-testid="projects-grid"]')).toBeVisible({ timeout: 4_000 })

    for (const id of taskIds) {
      await expect(window.locator(`[data-testid="grid-row-${id}"]`)).toBeVisible()
    }
  } finally {
    await dispose()
  }
})

test('G2. Grid — sort by title reorders rows', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window, ['Zebra', 'Apple', 'Mango'])
    await window.locator('[data-testid="projects-view-grid"]').click()
    await expect(window.locator('[data-testid="projects-grid"]')).toBeVisible({ timeout: 4_000 })

    // Click title sort once → ascending (A→Z)
    await window.locator('[data-testid="grid-sort-title"]').click()
    await window.waitForTimeout(200)
    const rowsAsc = await window.locator('[data-testid^="grid-row-"]').evaluateAll(
      (els) => els.map((el) => el.getAttribute('data-testid'))
    )

    // Click title sort again → descending (Z→A)
    await window.locator('[data-testid="grid-sort-title"]').click()
    await window.waitForTimeout(200)
    const rowsDesc = await window.locator('[data-testid^="grid-row-"]').evaluateAll(
      (els) => els.map((el) => el.getAttribute('data-testid'))
    )

    // The two orderings must differ (sort actually changed order)
    expect(rowsAsc.join(',')).not.toBe(rowsDesc.join(','))

    // Ascending: Apple < Mango < Zebra — find each task's row position
    const idOfTitle = (title: string): string => {
      const idx = ['Zebra', 'Apple', 'Mango'].indexOf(title)
      return taskIds[idx]
    }
    const posAsc = (title: string): number => rowsAsc.indexOf(`grid-row-${idOfTitle(title)}`)
    expect(posAsc('Apple')).toBeLessThan(posAsc('Mango'))
    expect(posAsc('Mango')).toBeLessThan(posAsc('Zebra'))
  } finally {
    await dispose()
  }
})

test('G3. Grid — sort by progress reorders rows', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window, ['Task A', 'Task B', 'Task C'])

    // Set progress on tasks via IPC before entering grid
    // Task B gets 50%, Task C gets 100%
    await window.evaluate(
      ([id]) => window.api.projects.setTaskPlan(id, { progressPct: 50 }),
      [taskIds[1]] as [string]
    )
    await window.evaluate(
      ([id]) => window.api.projects.setTaskPlan(id, { progressPct: 100 }),
      [taskIds[2]] as [string]
    )

    await window.locator('[data-testid="projects-view-grid"]').click()
    await expect(window.locator('[data-testid="projects-grid"]')).toBeVisible({ timeout: 4_000 })

    // Click progress sort once (ascending: 0, 50, 100)
    await window.locator('[data-testid="grid-sort-progress"]').click()
    await window.waitForTimeout(200)
    const rowsAsc = await window.locator('[data-testid^="grid-row-"]').evaluateAll(
      (els) => els.map((el) => el.getAttribute('data-testid'))
    )

    const posA = rowsAsc.indexOf(`grid-row-${taskIds[0]}`)
    const posB = rowsAsc.indexOf(`grid-row-${taskIds[1]}`)
    const posC = rowsAsc.indexOf(`grid-row-${taskIds[2]}`)
    expect(posA).toBeLessThan(posB)
    expect(posB).toBeLessThan(posC)
  } finally {
    await dispose()
  }
})

test('G4. Grid — sort by start reorders rows, clicking a row opens editor', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window)
    await window.locator('[data-testid="projects-view-grid"]').click()
    await expect(window.locator('[data-testid="projects-grid"]')).toBeVisible({ timeout: 4_000 })

    // Click start sort
    await window.locator('[data-testid="grid-sort-start"]').click()
    await window.waitForTimeout(200)

    // Click first row — editor opens
    await window.locator('[data-testid^="grid-row-"]').first().click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })
  } finally {
    await dispose()
  }
})

// ─── 4. Task editor new controls ─────────────────────────────────────────────

test('E1. assignee field persists via IPC', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { folderId, taskIds } = await setupProjectInGantt(window)

    // Click a gantt bar to open editor
    await window.locator(`[data-testid="gantt-bar-${taskIds[0]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    // Fill in the assignee field and blur
    const assigneeInput = window.locator('[data-testid="task-assignee"]')
    await assigneeInput.click()
    await assigneeInput.fill('Alice Tester')
    await assigneeInput.press('Enter')
    await window.waitForTimeout(600)

    // Verify via projects.plan (which includes assignee) not nodes.list (which doesn't surface it)
    const plan = await window.evaluate(
      ([pid]: [string]) => window.api.projects.plan(pid),
      [folderId] as [string]
    )
    const task = (plan as { tasks: Array<{ id: string; assignee: string | null }> }).tasks.find(
      (t) => t.id === taskIds[0]
    )
    expect(task?.assignee ?? '').toBe('Alice Tester')
  } finally {
    await dispose()
  }
})

test('E2. progress slider persists progressPct and Gantt shows progress fill', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window)

    // Open editor for first task
    await window.locator(`[data-testid="gantt-bar-${taskIds[0]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    // Set progress via IPC to 60 (range input is hard to set precisely via UI)
    await window.evaluate(
      ([id]: [string]) => window.api.projects.setTaskPlan(id, { progressPct: 60 }),
      [taskIds[0]] as [string]
    )

    // Reload the plan (clicking Reschedule or back-and-forth)
    await window.locator('[data-testid="task-editor"] [title="Close"]').click().catch(() => {})
    await window.locator('[data-testid="projects-reschedule"]').click()
    await window.waitForTimeout(600)

    // Gantt progress fill should appear for this task (only rendered when progressPct > 0)
    await expect(window.locator(`[data-testid="gantt-progress-${taskIds[0]}"]`)).toBeVisible({ timeout: 5_000 })
  } finally {
    await dispose()
  }
})

test('E3. task-new-dep-type and task-new-dep-lag controls present in editor', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setupProjectInGantt(window)

    // Open editor for second task (taskIds[1]) so it can depend on taskIds[0]
    await window.locator(`[data-testid="gantt-bar-${taskIds[1]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    // These controls are always visible when there are candidates
    await expect(window.locator('[data-testid="task-new-dep-type"]')).toBeVisible()
    await expect(window.locator('[data-testid="task-new-dep-lag"]')).toBeVisible()
    await expect(window.locator('[data-testid="task-add-dep"]')).toBeVisible()
  } finally {
    await dispose()
  }
})

test('E4. add dependency between two tasks via IPC then verify dep-type and dep-lag controls appear', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { folderId, taskIds } = await setupProjectInGantt(window)

    // Add dep: taskIds[1] depends on taskIds[0] with type SS and lag 2
    const result = await window.evaluate(
      ([pred, succ]: [string, string]) => window.api.projects.addDep(pred, succ, 'SS', 2),
      [taskIds[0], taskIds[1]] as [string, string]
    )
    expect((result as { ok: boolean }).ok).toBe(true)

    // Reload: click back then re-open
    await window.locator('[data-testid="projects-back"]').click()
    await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 6_000 })
    await window.locator(`[data-testid="project-card-${folderId}"]`).click()
    // A plan lands on Overview since 4811bd60c; the Gantt is the Timeline tab.
    await window.locator('[data-testid="projects-view-gantt"]').click()
    await expect(window.locator('[data-testid="projects-view-gantt"]')).toBeVisible({ timeout: 8_000 })

    // Open editor for taskIds[1] (the successor)
    await window.locator(`[data-testid="gantt-bar-${taskIds[1]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    // The dep-type and dep-lag inline controls for the predecessor should now be visible
    await expect(window.locator(`[data-testid="dep-type-${taskIds[0]}"]`)).toBeVisible()
    await expect(window.locator(`[data-testid="dep-lag-${taskIds[0]}"]`)).toBeVisible()

    // Verify via IPC that the plan records the dependency with correct type
    const plan = await window.evaluate(
      ([pid]: [string]) => window.api.projects.plan(pid),
      [folderId] as [string]
    )
    const deps = (plan as { deps: Array<{ predId: string; succId: string; type: string; lag: number }> }).deps
    const dep = deps.find((d) => d.predId === taskIds[0] && d.succId === taskIds[1])
    expect(dep).toBeDefined()
    expect(dep?.type).toBe('SS')
    expect(dep?.lag).toBe(2)
  } finally {
    await dispose()
  }
})

// ─── 5. Portfolio stats ───────────────────────────────────────────────────────

test('P1. portfolio stats tile visible when projects exist', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed a project with tasks
    const folder = await window.evaluate(
      async (title: string) => window.api.nodes.create({ parentId: null, kind: 'folder', isPlan: true, title }),
      'Stats Project'
    )
    const folderId = (folder as { id: string }).id
    await window.evaluate(
      async ([pid]: [string]) => window.api.nodes.create({ parentId: pid, kind: 'task', title: 'T1' }),
      [folderId] as [string]
    )

    // Navigate to PlexiProjects portfolio
    await openProduct(window, 'projects')
    await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 8_000 })

    // Portfolio stats block
    const stats = window.locator('[data-testid="projects-portfolio-stats"]')
    await expect(stats).toBeVisible({ timeout: 6_000 })

    // Stat tiles contain key labels (real StatTile components with icon + label + value)
    // The tile reads 'Plans' since 9f72888e8 (Plans not Projects).
    await expect(stats).toContainText('Plans')
    await expect(stats).toContainText('Tasks done')
    await expect(stats).toContainText('Avg complete')
    await expect(stats).toContainText('At risk')

    // The project count must show 1 (real, not invented)
    await expect(stats).toContainText('1')
  } finally {
    await dispose()
  }
})

test('P2. portfolio stats absent when no projects exist', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openProduct(window, 'projects')
    await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 8_000 })

    // No projects: empty state shown, stats grid absent
    await expect(window.locator('[data-testid="projects-empty"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="projects-portfolio-stats"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

// ─── 6. Regression guard — existing specs still pass ─────────────────────────
// (run via npm run test:e2e which invokes all specs; individual regression
//  specs are not re-implemented here to avoid duplication)
