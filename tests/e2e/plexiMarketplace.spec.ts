import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// PlexiMarketplace verification.
// Priority: opening the view creates nothing; each Apply creates real store objects.
// IPC APIs used to verify: window.api.tables.{list,listRows},
//   window.api.reports.list, window.api.flows.list, window.api.knowledge.list.

test('1. view renders all template cards; opening creates nothing', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Navigate to Marketplace
    await window.getByRole('button', { name: 'Marketplace' }).first().click()
    await expect(window.locator('[data-testid="pleximarketplace-view"]')).toBeVisible({ timeout: 8_000 })

    // All 6 template cards must be visible
    for (const key of ['sprint-board', 'content-calendar', 'client-tracker', 'weekly-report', 'daily-standup', 'team-wiki']) {
      await expect(window.locator(`[data-testid="template-card-${key}"]`)).toBeVisible({ timeout: 5_000 })
    }

    // Nothing was created just by opening — fresh DB should have empty stores
    const tables = await window.evaluate(async () => window.api.tables.list())
    expect((tables as unknown[]).length).toBe(0)

    const nodes = await window.evaluate(async () => window.api.nodes.list())
    expect((nodes as unknown[]).length).toBe(0)

    const knowledge = await window.evaluate(async () => window.api.knowledge.list())
    expect((knowledge as unknown[]).length).toBe(0)

    const reports = await window.evaluate(async () => window.api.reports.list())
    expect((reports as unknown[]).length).toBe(0)

    const flows = await window.evaluate(async () => window.api.flows.list())
    expect((flows as unknown[]).length).toBe(0)
  } finally {
    await dispose()
  }
})

test('2. apply sprint-board: real table + 3 real rows', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await window.getByRole('button', { name: 'Marketplace' }).first().click()
    await expect(window.locator('[data-testid="template-apply-sprint-board"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="template-apply-sprint-board"]').click()

    // Confirm done indicator appears
    await expect(window.locator('[data-testid="template-done-sprint-board"]')).toBeVisible({ timeout: 8_000 })

    // Confirm real table in store
    const tables = await window.evaluate(async () => window.api.tables.list())
    const tableList = tables as Array<{ id: string; title: string }>
    const sprintTable = tableList.find((t) => t.title === 'Sprint board')
    expect(sprintTable).toBeDefined()

    // Confirm 3 real rows
    const rows = await window.evaluate(
      async (id) => window.api.tables.listRows(id),
      sprintTable!.id
    )
    const rowList = rows as unknown[]
    expect(rowList.length).toBe(3)
  } finally {
    await dispose()
  }
})

test('3. apply weekly-report: real table + real report referencing it', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await window.getByRole('button', { name: 'Marketplace' }).first().click()
    await expect(window.locator('[data-testid="template-apply-weekly-report"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="template-apply-weekly-report"]').click()
    await expect(window.locator('[data-testid="template-done-weekly-report"]')).toBeVisible({ timeout: 8_000 })

    // Real "Work tracker" table
    const tables = await window.evaluate(async () => window.api.tables.list())
    const tableList = tables as Array<{ id: string; title: string }>
    const trackerTable = tableList.find((t) => t.title === 'Work tracker')
    expect(trackerTable).toBeDefined()

    // Real "Weekly status" report whose sourceTableIds includes the table
    const reports = await window.evaluate(async () => window.api.reports.list())
    const reportList = reports as Array<{ id: string; title: string; sourceTableIds: string[]; schedule: string }>
    const weeklyReport = reportList.find((r) => r.title === 'Weekly status')
    expect(weeklyReport).toBeDefined()
    expect(weeklyReport!.sourceTableIds).toContain(trackerTable!.id)
    expect(weeklyReport!.schedule).toBe('weekly')
  } finally {
    await dispose()
  }
})

test('4. apply daily-standup: real flow with schedule + 2 actions', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await window.getByRole('button', { name: 'Marketplace' }).first().click()
    await expect(window.locator('[data-testid="template-apply-daily-standup"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="template-apply-daily-standup"]').click()
    await expect(window.locator('[data-testid="template-done-daily-standup"]')).toBeVisible({ timeout: 8_000 })

    const flows = await window.evaluate(async () => window.api.flows.list())
    const flowList = flows as Array<{
      id: string
      title: string
      trigger: { kind: string; every?: string }
      actions: Array<{ type: string }>
    }>
    const standup = flowList.find((f) => f.title === 'Daily standup')
    expect(standup).toBeDefined()
    expect(standup!.trigger.kind).toBe('schedule')
    expect(standup!.trigger.every).toBe('daily')
    expect(standup!.actions.length).toBe(2)
    expect(standup!.actions[0].type).toBe('ai-step')
    expect(standup!.actions[1].type).toBe('create-task')
  } finally {
    await dispose()
  }
})

test('5. apply team-wiki: 2 real knowledge entries with expected titles', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await window.getByRole('button', { name: 'Marketplace' }).first().click()
    await expect(window.locator('[data-testid="template-apply-team-wiki"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="template-apply-team-wiki"]').click()
    await expect(window.locator('[data-testid="template-done-team-wiki"]')).toBeVisible({ timeout: 8_000 })

    const knowledge = await window.evaluate(async () => window.api.knowledge.list())
    const kList = knowledge as Array<{ id: string; title: string; body: string }>

    const howWeWork = kList.find((k) => k.title === 'How we work')
    expect(howWeWork).toBeDefined()
    expect(howWeWork!.body.length).toBeGreaterThan(0)

    const glossary = kList.find((k) => k.title === 'Glossary')
    expect(glossary).toBeDefined()
    expect(glossary!.body.length).toBeGreaterThan(0)

    expect(kList.length).toBe(2)
  } finally {
    await dispose()
  }
})

test('6. suite launcher: PlexiMarketplace tile opens the view', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await window.getByRole('button', { name: 'PlexiiSuite' }).first().click()
    await expect(window.locator('[data-testid="plexisuite-home"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="product-tile-pleximarketplace"]').click()
    await expect(window.locator('[data-testid="product-home-pleximarketplace"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="open-pleximarketplace"]').click()
    await expect(window.locator('[data-testid="pleximarketplace-view"]')).toBeVisible({ timeout: 8_000 })
  } finally {
    await dispose()
  }
})
