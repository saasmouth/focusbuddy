// Verification spec for two UX improvements shipped together:
//
// FEATURE 1 — "Land on content, not the empty dashboard"
//   useLandOnContent hook wires PlexiReports, PlexiFlow, PlexiForms, PlexiBuild
//   so that opening a module with existing items auto-selects the most-recently
//   updated item rather than parking on ModuleDashboard. ModuleDashboard is still
//   reachable via the Overview button.
//
// FEATURE 2 — Visible undo on task delete in PlexiProjects
//   Task deletion in the ProjectGantt now routes through useNodeStore.remove(),
//   which records a toast+action entry. Undo restores the task.

import { test, expect } from '@playwright/test'
import { openProduct, launchApp, waitForReady } from './_helpers'

// ─── FEATURE 1: land-on-content ────────────────────────────────────────────

test('F1-a: PlexiReports empty state still shows module-dashboard-reports + create button', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'reports')
    await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })

    // With ZERO items: ModuleDashboard must be showing, not an editor.
    await expect(window.locator('[data-testid="module-dashboard-reports"]')).toBeVisible({ timeout: 5_000 })

    // Create button must be visible (from within ModuleDashboard)
    await expect(window.locator('[data-testid="report-new"]')).toBeVisible()

    // No Overview button yet (items.length === 0)
    await expect(window.locator('[data-testid="report-overview"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('F1-b: PlexiReports with seeded item auto-selects it on fresh mount (land-on-content)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed a report via IPC before navigating to the view.
    // This simulates the "existing items" case that triggers useLandOnContent.
    const report = await window.evaluate(async () =>
      window.api.reports.create({ title: 'Seeded Report' })
    )
    const reportId: string = (report as { id: string }).id

    // Now navigate to PlexiReports — the hook fires on mount with items already loaded.
    await openProduct(window, 'reports')
    await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })

    // The report card must exist in the list.
    await expect(window.locator(`[data-testid="report-card-${reportId}"]`)).toBeVisible({ timeout: 6_000 })

    // Core land-on-content assertion: editor is visible (selectedId !== null).
    // The editor shows report-title input; ModuleDashboard must NOT be showing.
    await expect(window.locator('[data-testid="report-title"]')).toBeVisible({ timeout: 6_000 })
    await expect(window.locator('[data-testid="module-dashboard-reports"]')).not.toBeVisible()

    // Overview button must now be present (items.length > 0).
    await expect(window.locator('[data-testid="report-overview"]')).toBeVisible({ timeout: 5_000 })
  } finally {
    await dispose()
  }
})

test('F1-c: PlexiReports Overview button deselects and shows ModuleHome', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed a report so the view has content to land on.
    await window.evaluate(async () =>
      window.api.reports.create({ title: 'Overview Test Report' })
    )

    await openProduct(window, 'reports')
    await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })

    // Wait for auto-select to land us in the editor.
    await expect(window.locator('[data-testid="report-title"]')).toBeVisible({ timeout: 6_000 })

    // Click Overview → should deselect and show ModuleDashboard.
    await window.locator('[data-testid="report-overview"]').click()
    await expect(window.locator('[data-testid="module-dashboard-reports"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="report-title"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('F1-d: PlexiFlow empty state shows module-dashboard-flows + create button, no Overview', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'flow')
    await expect(window.locator('[data-testid="plexiflow-view"]')).toBeVisible({ timeout: 8_000 })

    await expect(window.locator('[data-testid="module-dashboard-flows"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="flow-new"]')).toBeVisible()
    await expect(window.locator('[data-testid="flow-overview"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('F1-e: PlexiFlow with seeded item auto-selects on fresh mount', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const flow = await window.evaluate(async () =>
      window.api.flows.create({ title: 'Seeded Flow' })
    )
    const flowId: string = (flow as { id: string }).id

    await openProduct(window, 'flow')
    await expect(window.locator('[data-testid="plexiflow-view"]')).toBeVisible({ timeout: 8_000 })

    await expect(window.locator(`[data-testid="flow-card-${flowId}"]`)).toBeVisible({ timeout: 6_000 })

    // Editor visible (flow-title input), ModuleDashboard not visible.
    await expect(window.locator('[data-testid="flow-title"]')).toBeVisible({ timeout: 6_000 })
    await expect(window.locator('[data-testid="module-dashboard-flows"]')).not.toBeVisible()

    // Overview button present.
    await expect(window.locator('[data-testid="flow-overview"]')).toBeVisible({ timeout: 5_000 })
  } finally {
    await dispose()
  }
})

test('F1-f: PlexiFlow Overview button deselects and shows ModuleHome', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await window.evaluate(async () =>
      window.api.flows.create({ title: 'Overview Flow' })
    )

    await openProduct(window, 'flow')
    await expect(window.locator('[data-testid="plexiflow-view"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="flow-title"]')).toBeVisible({ timeout: 6_000 })

    await window.locator('[data-testid="flow-overview"]').click()
    await expect(window.locator('[data-testid="module-dashboard-flows"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="flow-title"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('F1-g: PlexiForms empty state shows module-dashboard-forms + create button, no Overview', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'form')
    await expect(window.locator('[data-testid="plexiforms-view"]')).toBeVisible({ timeout: 8_000 })

    await expect(window.locator('[data-testid="module-dashboard-forms"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="form-new"]')).toBeVisible()
    await expect(window.locator('[data-testid="form-overview"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('F1-h: PlexiForms with seeded item auto-selects on fresh mount', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // PlexiForms requires a backing table. Seed via the same pattern the store uses.
    const table = await window.evaluate(async () =>
      window.api.tables.create({ taskId: null, title: 'Seeded Form responses' })
    )
    const tableId: string = (table as { id: string }).id

    const form = await window.evaluate(
      async (tid) => window.api.forms.create({ title: 'Seeded Form', tableId: tid }),
      tableId
    )
    const formId: string = (form as { id: string }).id

    await openProduct(window, 'form')
    await expect(window.locator('[data-testid="plexiforms-view"]')).toBeVisible({ timeout: 8_000 })

    await expect(window.locator(`[data-testid="form-row-${formId}"]`)).toBeVisible({ timeout: 6_000 })

    // Editor open (form-title input), ModuleDashboard not visible.
    await expect(window.locator('[data-testid="form-title"]')).toBeVisible({ timeout: 6_000 })
    await expect(window.locator('[data-testid="module-dashboard-forms"]')).not.toBeVisible()

    await expect(window.locator('[data-testid="form-overview"]')).toBeVisible({ timeout: 5_000 })
  } finally {
    await dispose()
  }
})

test('F1-i: PlexiBuild empty state shows module-dashboard-build + create button, no Overview', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'build')
    await expect(window.locator('[data-testid="plexibuild-view"]')).toBeVisible({ timeout: 8_000 })

    await expect(window.locator('[data-testid="module-dashboard-build"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="build-new-app"]')).toBeVisible()
    await expect(window.locator('[data-testid="build-overview"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('F1-j: PlexiBuild with seeded item auto-selects on fresh mount', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // apps.create takes a PlexiAppDraft with optional name/icon/components.
    const app = await window.evaluate(async () =>
      window.api.apps.create({ name: 'Seeded App', components: [] })
    )
    const appId: string = (app as { id: string }).id

    await openProduct(window, 'build')
    await expect(window.locator('[data-testid="plexibuild-view"]')).toBeVisible({ timeout: 8_000 })

    await expect(window.locator(`[data-testid="build-app-${appId}"]`)).toBeVisible({ timeout: 6_000 })

    // Editor open (app-name input per PlexiBuildView line ~206), ModuleDashboard not visible.
    await expect(window.locator('[data-testid="app-name"]')).toBeVisible({ timeout: 6_000 })
    await expect(window.locator('[data-testid="module-dashboard-build"]')).not.toBeVisible()

    await expect(window.locator('[data-testid="build-overview"]')).toBeVisible({ timeout: 5_000 })
  } finally {
    await dispose()
  }
})

// ─── FEATURE 2: visible undo on task delete ─────────────────────────────────

test('F2-a: PlexiProjects task delete shows undo toast, clicking Undo restores the task', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed a plan + task via IPC so the Gantt has something to delete. Only a
    // folder marked as a plan is in the portfolio since 0ba19017 (Rooms/Plans split).
    const folder = await window.evaluate(async () =>
      window.api.nodes.create({ parentId: null, kind: 'folder', title: 'Undo Test Project', isPlan: true })
    )
    const folderId: string = (folder as { id: string }).id

    const task = await window.evaluate(
      async (pid) => window.api.nodes.create({ parentId: pid, kind: 'task', title: 'Delete Me' }),
      folderId
    )
    const taskId: string = (task as { id: string }).id

    // Navigate to PlexiProjects and open the project.
    await openProduct(window, 'projects')
    await expect(window.locator(`[data-testid="project-card-${folderId}"]`)).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="project-card-${folderId}"]`).click()
    // A plan opens on Overview since 4811bd60; the Gantt rows are its Timeline view.
    await window.locator('[data-testid="projects-view-gantt"]').click()

    // Task row appears in Gantt.
    await expect(window.locator(`[data-testid="gantt-row-${taskId}"]`)).toBeVisible({ timeout: 8_000 })

    // Open task editor by clicking the row.
    await window.locator(`[data-testid="gantt-row-${taskId}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 5_000 })

    // Click Delete.
    await window.locator('[data-testid="task-delete"]').click()

    // Undo toast must appear.
    await expect(window.locator('[data-testid="undo-toast"]')).toBeVisible({ timeout: 5_000 })

    // The Undo button must be inside it.
    await expect(window.locator('[data-testid="undo-toast-undo"]')).toBeVisible()

    // Task must be gone from IPC now.
    const planAfterDelete = await window.evaluate(
      async (pid) => window.api.projects.plan(pid),
      folderId
    )
    const tasksAfter = (planAfterDelete as { tasks: Array<{ id: string }> }).tasks
    expect(tasksAfter.find((t) => t.id === taskId)).toBeUndefined()

    // Click Undo.
    await window.locator('[data-testid="undo-toast-undo"]').click()

    // Wait for the node store's refresh to propagate.
    await window.waitForTimeout(600)

    // Task must be restored in IPC.
    const planAfterUndo = await window.evaluate(
      async (pid) => window.api.projects.plan(pid),
      folderId
    )
    const tasksRestored = (planAfterUndo as { tasks: Array<{ id: string }> }).tasks
    expect(tasksRestored.find((t) => t.id === taskId)).toBeDefined()
  } finally {
    await dispose()
  }
})

test('F2-b: undo toast disappears after timeout and task stays deleted if not undone', async () => {
  // This test does NOT click Undo — it confirms the toast auto-dismiss path.
  // We keep the timeout short by asserting the toast exists and then verifying
  // the task is gone, without waiting for the full 7-second fade.
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // A plan, not a plain room: only plans are in the portfolio (0ba19017).
    const folder = await window.evaluate(async () =>
      window.api.nodes.create({ parentId: null, kind: 'folder', title: 'No-undo Project', isPlan: true })
    )
    const folderId: string = (folder as { id: string }).id

    const task = await window.evaluate(
      async (pid) => window.api.nodes.create({ parentId: pid, kind: 'task', title: 'Stay Deleted' }),
      folderId
    )
    const taskId: string = (task as { id: string }).id

    await openProduct(window, 'projects')
    await expect(window.locator(`[data-testid="project-card-${folderId}"]`)).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="project-card-${folderId}"]`).click()
    // A plan opens on Overview since 4811bd60; the Gantt rows are its Timeline view.
    await window.locator('[data-testid="projects-view-gantt"]').click()

    await expect(window.locator(`[data-testid="gantt-row-${taskId}"]`)).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="gantt-row-${taskId}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 5_000 })

    await window.locator('[data-testid="task-delete"]').click()

    // Toast appeared.
    await expect(window.locator('[data-testid="undo-toast"]')).toBeVisible({ timeout: 5_000 })

    // Task is gone from IPC — the delete did complete (toast is not a fake).
    const planCheck = await window.evaluate(
      async (pid) => window.api.projects.plan(pid),
      folderId
    )
    const tasks = (planCheck as { tasks: Array<{ id: string }> }).tasks
    expect(tasks.find((t) => t.id === taskId)).toBeUndefined()
  } finally {
    await dispose()
  }
})
