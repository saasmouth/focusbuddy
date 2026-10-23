import { test, expect } from '@playwright/test'
import { openProduct, launchApp, waitForReady } from './_helpers'

// New-feature E2E coverage for the five PlexiProjects additions:
//   1. View switcher: Calendar + Workload (total 5 modes)
//   2. Baselines: capture, IPC hasBaseline, ghost bars, task-variance
//   3. Per-project calendar settings: weekday toggles + holiday input
//   4. Assignee picker: list="plexi-assignee-suggestions" + datalist sibling
//
// Each test is independent (isolated userData DB via launchApp).
// UI-driven paths are noted; IPC-driven paths are noted where a pointer
// gesture is impractical (e.g. native date picker, calendar-task chip on a
// date that depends on the engine's scheduling output).

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup helper: boot, create folder + tasks, open the Gantt.
// ─────────────────────────────────────────────────────────────────────────────

async function setup(
  window: Awaited<ReturnType<typeof launchApp>>['window'],
  taskTitles: string[] = ['Alpha', 'Beta', 'Gamma']
): Promise<{ folderId: string; taskIds: string[] }> {
  await waitForReady(window)

  const folder = await window.evaluate(
    (title: string) => window.api.nodes.create({ parentId: null, kind: 'folder', isPlan: true, title }),
    'Test Project'
  )
  const folderId = (folder as { id: string }).id

  const taskIds: string[] = []
  for (const title of taskTitles) {
    const t = await window.evaluate(
      ([pid, ttl]: [string, string]) => window.api.nodes.create({ parentId: pid, kind: 'task', title: ttl }),
      [folderId, title] as [string, string]
    )
    taskIds.push((t as { id: string }).id)
  }

  // Navigate into the project Gantt
  await openProduct(window, 'projects')
  await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 8_000 })
  await window.locator(`[data-testid="project-card-${folderId}"]`).click()
  // A plan lands on Overview since 4811bd60c; the Gantt is the Timeline tab.
  await window.locator('[data-testid="projects-view-gantt"]').click()
  await expect(window.locator('[data-testid="projects-view-gantt"]')).toBeVisible({ timeout: 8_000 })

  return { folderId, taskIds }
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1: View switcher — Calendar and Workload (5th mode)
// ─────────────────────────────────────────────────────────────────────────────

test('VS1. all five view-switcher buttons are present', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)

    for (const id of ['gantt', 'board', 'grid', 'calendar', 'workload']) {
      await expect(window.locator(`[data-testid="projects-view-${id}"]`)).toBeVisible()
    }
  } finally {
    await dispose()
  }
})

test('VS2. clicking Calendar shows projects-calendar month grid with prev/next buttons', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)

    await window.locator('[data-testid="projects-view-calendar"]').click()
    await expect(window.locator('[data-testid="projects-calendar"]')).toBeVisible({ timeout: 4_000 })
    await expect(window.locator('[data-testid="calendar-prev"]')).toBeVisible()
    await expect(window.locator('[data-testid="calendar-next"]')).toBeVisible()

    // Gantt content should not be visible when in Calendar mode
    await expect(window.locator('[data-testid^="gantt-bar-"]').first()).not.toBeVisible()
  } finally {
    await dispose()
  }
})

test('VS3. calendar-prev and calendar-next navigate months', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)

    await window.locator('[data-testid="projects-view-calendar"]').click()
    await expect(window.locator('[data-testid="projects-calendar"]')).toBeVisible({ timeout: 4_000 })

    // Read the current month heading
    const headingBefore = await window.locator('[data-testid="projects-calendar"] h3').innerText()

    // Go back one month
    await window.locator('[data-testid="calendar-prev"]').click()
    const headingAfter = await window.locator('[data-testid="projects-calendar"] h3').innerText()
    expect(headingAfter).not.toBe(headingBefore)

    // Go forward one month — heading should return to the original value
    await window.locator('[data-testid="calendar-next"]').click()
    const headingRestored = await window.locator('[data-testid="projects-calendar"] h3').innerText()
    expect(headingRestored).toBe(headingBefore)
  } finally {
    await dispose()
  }
})

test('VS4. tasks appear as calendar-task-<id> chips in the calendar month grid', async () => {
  // Give tasks explicit dates so they land on a known month. Chips are only
  // rendered for tasks whose scheduled window covers the displayed month.
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setup(window)

    // Force plan dates to today so they land in the currently-displayed month
    const now = Date.now()
    const dayMs = 86_400_000
    for (const id of taskIds) {
      await window.evaluate(
        ([tid, start, due]: [string, number, number]) =>
          window.api.projects.setTaskPlan(tid, { planStart: start, planDue: due }),
        [id, now, now + dayMs] as [string, number, number]
      )
    }

    await window.locator('[data-testid="projects-view-calendar"]').click()
    await expect(window.locator('[data-testid="projects-calendar"]')).toBeVisible({ timeout: 4_000 })

    // At least one task chip should be visible — the calendar renders them via
    // the engine's scheduledStartMs / scheduledEndMs which the setTaskPlan call above
    // seeds. Wait for the plan to reload after the IPC set (the calendar reads
    // plan.tasks which is already in state from the Gantt load).
    await expect(
      window.locator(`[data-testid="calendar-task-${taskIds[0]}"]`).first()
    ).toBeVisible({ timeout: 6_000 })
  } finally {
    await dispose()
  }
})

test('VS5. clicking Workload shows projects-workload with workload-row-unassigned', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)

    await window.locator('[data-testid="projects-view-workload"]').click()
    await expect(window.locator('[data-testid="projects-workload"]')).toBeVisible({ timeout: 4_000 })

    // Newly-created tasks have no assignee — they land in the "Unassigned" row
    await expect(window.locator('[data-testid="workload-row-unassigned"]')).toBeVisible()
  } finally {
    await dispose()
  }
})

test('VS6. workload shows workload-task-<id> chips for unassigned tasks', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setup(window)

    await window.locator('[data-testid="projects-view-workload"]').click()
    await expect(window.locator('[data-testid="projects-workload"]')).toBeVisible({ timeout: 4_000 })

    for (const id of taskIds) {
      await expect(window.locator(`[data-testid="workload-task-${id}"]`)).toBeVisible()
    }
  } finally {
    await dispose()
  }
})

test('VS7. assigned task appears under workload-row-person, not unassigned', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { folderId, taskIds } = await setup(window, ['Solo'])

    // Assign the task via setTaskPlan
    await window.evaluate(
      ([tid]: [string]) => window.api.projects.setTaskPlan(tid, { assignee: 'Alice' }),
      [taskIds[0]] as [string]
    )

    // Reload plan (navigate back and re-enter)
    await window.locator('[data-testid="projects-back"]').click()
    await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 6_000 })
    await window.locator(`[data-testid="project-card-${folderId}"]`).click()
    // A plan lands on Overview since 4811bd60c; the Gantt is the Timeline tab.
    await window.locator('[data-testid="projects-view-gantt"]').click()
    await expect(window.locator('[data-testid="projects-view-gantt"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="projects-view-workload"]').click()
    await expect(window.locator('[data-testid="projects-workload"]')).toBeVisible({ timeout: 4_000 })

    // Should have a named-person row, not unassigned
    await expect(window.locator('[data-testid="workload-row-person"]')).toBeVisible()
    await expect(window.locator('[data-testid="workload-row-unassigned"]')).not.toBeVisible()
    await expect(window.locator(`[data-testid="workload-task-${taskIds[0]}"]`)).toBeVisible()
  } finally {
    await dispose()
  }
})

test('VS8. no crash cycling all five views repeatedly', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)

    for (const id of ['board', 'grid', 'calendar', 'workload', 'gantt', 'calendar', 'workload', 'gantt']) {
      await window.locator(`[data-testid="projects-view-${id}"]`).click()
      await window.waitForTimeout(150)
    }

    // End on Gantt — no error element
    await expect(window.locator('[data-testid="gantt-error"]')).not.toBeVisible()
    await expect(window.locator('[data-testid="projects-board"]')).not.toBeVisible()
    await expect(window.locator('[data-testid="projects-calendar"]')).not.toBeVisible()
    await expect(window.locator('[data-testid="projects-workload"]')).not.toBeVisible()
  } finally {
    await dispose()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 2: Baselines
// ─────────────────────────────────────────────────────────────────────────────

test('BL1. projects-set-baseline button is present in the Gantt header', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)
    await expect(window.locator('[data-testid="projects-set-baseline"]')).toBeVisible()
  } finally {
    await dispose()
  }
})

test('BL2. clicking Set baseline: button label changes to "Baseline set" + IPC hasBaseline:true', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { folderId } = await setup(window)

    // Confirm not yet set
    const planBefore = await window.evaluate(
      ([pid]: [string]) => window.api.projects.plan(pid),
      [folderId] as [string]
    )
    expect((planBefore as { hasBaseline: boolean }).hasBaseline).toBe(false)

    // Click the baseline button (UI-driven)
    await window.locator('[data-testid="projects-set-baseline"]').click()
    await window.waitForTimeout(600)

    // Label should have changed
    await expect(window.locator('[data-testid="projects-set-baseline"]')).toContainText('Baseline set')

    // IPC should now return hasBaseline: true
    const planAfter = await window.evaluate(
      ([pid]: [string]) => window.api.projects.plan(pid),
      [folderId] as [string]
    )
    expect((planAfter as { hasBaseline: boolean }).hasBaseline).toBe(true)
  } finally {
    await dispose()
  }
})

test('BL3. after baseline capture each task has baselineStartMs + baselineEndMs', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { folderId, taskIds } = await setup(window)

    await window.locator('[data-testid="projects-set-baseline"]').click()
    await window.waitForTimeout(600)

    const plan = await window.evaluate(
      ([pid]: [string]) => window.api.projects.plan(pid),
      [folderId] as [string]
    )
    const tasks = (plan as { tasks: Array<{ id: string; baselineStartMs: number | null; baselineEndMs: number | null }> }).tasks

    for (const id of taskIds) {
      const t = tasks.find((x) => x.id === id)
      expect(t?.baselineStartMs).not.toBeNull()
      expect(t?.baselineEndMs).not.toBeNull()
      expect(typeof t?.baselineStartMs).toBe('number')
      expect(typeof t?.baselineEndMs).toBe('number')
    }
  } finally {
    await dispose()
  }
})

test('BL4. gantt-baseline-<id> ghost bars appear in the Gantt after capture', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setup(window)

    // Capture baseline
    await window.locator('[data-testid="projects-set-baseline"]').click()
    await window.waitForTimeout(600)

    // Ghost bars should now be rendered in the timeline column
    for (const id of taskIds) {
      await expect(window.locator(`[data-testid="gantt-baseline-${id}"]`)).toBeVisible({ timeout: 4_000 })
    }
  } finally {
    await dispose()
  }
})

test('BL5. task-variance shown in editor after baseline capture', async () => {
  // After capture the variance is 0 so the text is "On baseline".
  // We open the editor for any task and confirm task-variance appears.
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setup(window)

    // Capture baseline (UI-driven)
    await window.locator('[data-testid="projects-set-baseline"]').click()
    await window.waitForTimeout(600)

    // Open the task editor by clicking the first gantt row
    await window.locator(`[data-testid="gantt-row-${taskIds[0]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    // task-variance must be present and say "On baseline" (variance == 0 right after capture)
    await expect(window.locator('[data-testid="task-variance"]')).toBeVisible({ timeout: 4_000 })
    await expect(window.locator('[data-testid="task-variance"]')).toContainText('On baseline')
  } finally {
    await dispose()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 3: Per-project calendar settings
// ─────────────────────────────────────────────────────────────────────────────

test('CAL1. projects-calendar-settings gear opens calendar-settings panel', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)

    await window.locator('[data-testid="projects-calendar-settings"]').click()
    await expect(window.locator('[data-testid="calendar-settings"]')).toBeVisible({ timeout: 4_000 })
  } finally {
    await dispose()
  }
})

test('CAL2. calendar-settings shows 7 day toggles (calendar-day-0 through calendar-day-6)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)

    await window.locator('[data-testid="projects-calendar-settings"]').click()
    await expect(window.locator('[data-testid="calendar-settings"]')).toBeVisible({ timeout: 4_000 })

    for (let i = 0; i <= 6; i++) {
      await expect(window.locator(`[data-testid="calendar-day-${i}"]`)).toBeVisible()
    }
  } finally {
    await dispose()
  }
})

test('CAL3. toggling calendar-day-3 (Wednesday) persists via getCalendar (workingDays[3] false)', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { folderId } = await setup(window)

    await window.locator('[data-testid="projects-calendar-settings"]').click()
    await expect(window.locator('[data-testid="calendar-settings"]')).toBeVisible({ timeout: 4_000 })

    // Confirm Wednesday (index 3) is on by default
    const calBefore = await window.evaluate(
      ([pid]: [string]) => window.api.projects.getCalendar(pid),
      [folderId] as [string]
    )
    expect((calBefore as { workingDays: boolean[] }).workingDays[3]).toBe(true)

    // Click Wednesday toggle (UI-driven) — turns it off
    await window.locator('[data-testid="calendar-day-3"]').click()
    await window.waitForTimeout(600)

    // IPC confirms workingDays[3] is now false
    const calAfter = await window.evaluate(
      ([pid]: [string]) => window.api.projects.getCalendar(pid),
      [folderId] as [string]
    )
    expect((calAfter as { workingDays: boolean[] }).workingDays[3]).toBe(false)
  } finally {
    await dispose()
  }
})

test('CAL4. calendar-holiday-input and Add button present in calendar-settings', async () => {
  const { window, dispose } = await launchApp()
  try {
    await setup(window)

    await window.locator('[data-testid="projects-calendar-settings"]').click()
    await expect(window.locator('[data-testid="calendar-settings"]')).toBeVisible({ timeout: 4_000 })
    await expect(window.locator('[data-testid="calendar-holiday-input"]')).toBeVisible()
    // "Add" button for holidays
    await expect(window.locator('[data-testid="calendar-settings"] button').filter({ hasText: 'Add' })).toBeVisible()
  } finally {
    await dispose()
  }
})

test('CAL5. adding a holiday via IPC + re-reading confirms it persists in getCalendar holidays', async () => {
  // The Add button requires a native date-picker interaction which is unreliable
  // in headless Electron. We drive via IPC (setCalendar) and read back via
  // getCalendar to verify the persistence contract, then confirm no crash.
  const { window, dispose } = await launchApp()
  try {
    const { folderId } = await setup(window)

    // Pick a known holiday timestamp (2026-01-01 00:00 local)
    const holidayMs = new Date(2026, 0, 1).getTime()

    // Set the calendar directly via IPC (same code path the UI calls)
    await window.evaluate(
      ([pid, h]: [string, number]) =>
        window.api.projects.setCalendar(pid, {
          workingDays: [false, true, true, true, true, true, false],
          holidays: [h]
        }),
      [folderId, holidayMs] as [string, number]
    )

    // Read back
    const cal = await window.evaluate(
      ([pid]: [string]) => window.api.projects.getCalendar(pid),
      [folderId] as [string]
    )
    const typed = cal as { workingDays: boolean[]; holidays: number[] }
    expect(typed.holidays).toContain(holidayMs)

    // No crash after the setCalendar call — the gear icon should still be clickable
    await window.locator('[data-testid="projects-calendar-settings"]').click()
    await expect(window.locator('[data-testid="calendar-settings"]')).toBeVisible({ timeout: 4_000 })
  } finally {
    await dispose()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 4: Assignee picker (datalist + list attribute)
// ─────────────────────────────────────────────────────────────────────────────

test('AP1. task-assignee input has list="plexi-assignee-suggestions" attribute', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setup(window)

    // Open the task editor
    await window.locator(`[data-testid="gantt-row-${taskIds[0]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    // Verify the list attribute on the input
    const listAttr = await window.locator('[data-testid="task-assignee"]').getAttribute('list')
    expect(listAttr).toBe('plexi-assignee-suggestions')
  } finally {
    await dispose()
  }
})

test('AP2. datalist#plexi-assignee-suggestions is present as a sibling in the DOM', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { taskIds } = await setup(window)

    await window.locator(`[data-testid="gantt-row-${taskIds[0]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    // datalist must exist in the DOM
    const exists = await window.locator('#plexi-assignee-suggestions').count()
    expect(exists).toBeGreaterThan(0)
  } finally {
    await dispose()
  }
})

test('AP3. free-text assignee typed in task-assignee persists via projects.plan', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { folderId, taskIds } = await setup(window)

    await window.locator(`[data-testid="gantt-row-${taskIds[0]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    const input = window.locator('[data-testid="task-assignee"]')
    await input.click()
    await input.fill('Bob Builder')
    await input.press('Enter')
    await window.waitForTimeout(700)

    // Verify via IPC
    const plan = await window.evaluate(
      ([pid]: [string]) => window.api.projects.plan(pid),
      [folderId] as [string]
    )
    const task = (plan as { tasks: Array<{ id: string; assignee: string | null }> }).tasks.find(
      (t) => t.id === taskIds[0]
    )
    expect(task?.assignee).toBe('Bob Builder')
  } finally {
    await dispose()
  }
})

test('AP4. reopening the task editor shows the previously-saved assignee', async () => {
  const { window, dispose } = await launchApp()
  try {
    const { folderId, taskIds } = await setup(window)

    // Assign via IPC to avoid any UI timing issues
    await window.evaluate(
      ([tid]: [string]) => window.api.projects.setTaskPlan(tid, { assignee: 'Carol Dev' }),
      [taskIds[0]] as [string]
    )

    // Navigate back and re-enter to force a fresh load
    await window.locator('[data-testid="projects-back"]').click()
    await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 6_000 })
    await window.locator(`[data-testid="project-card-${folderId}"]`).click()
    // A plan lands on Overview since 4811bd60c; the Gantt is the Timeline tab.
    await window.locator('[data-testid="projects-view-gantt"]').click()
    await expect(window.locator('[data-testid="projects-view-gantt"]')).toBeVisible({ timeout: 8_000 })

    // Open editor
    await window.locator(`[data-testid="gantt-row-${taskIds[0]}"]`).click()
    await expect(window.locator('[data-testid="task-editor"]')).toBeVisible({ timeout: 4_000 })

    // Assignee field should show the persisted value
    const value = await window.locator('[data-testid="task-assignee"]').inputValue()
    expect(value).toBe('Carol Dev')
  } finally {
    await dispose()
  }
})
