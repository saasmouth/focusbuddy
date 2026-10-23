import { test, expect } from '@playwright/test'
import { gotoView, launchApp, openProduct, waitForReady } from './_helpers'

// PlexiReports verification.
// Node-create API used: window.api.tables.create({ taskId: null, title }) +
// window.api.tables.createRow({ tableId }) to seed source data.
// Reports API: window.api.reports.{list, create, update, generate}.

test('1. empty state: no reports shows reports-empty (no fake report)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'reports')
    await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="reports-empty"]')).toBeVisible({ timeout: 5_000 })

    // Confirm IPC also returns empty
    const list = await window.evaluate(async () => window.api.reports.list())
    expect(Array.isArray(list)).toBe(true)
    expect((list as unknown[]).length).toBe(0)
  } finally {
    await dispose()
  }
})

test('2. create report + select table: card appears, editor shows table checkbox', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed a table
    const table = await window.evaluate(async () =>
      window.api.tables.create({ taskId: null, title: 'Sales Table' })
    )
    const tableId: string = (table as { id: string }).id

    // Open PlexiReports
    await openProduct(window, 'reports')
    await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })

    // Create a report
    await window.locator('[data-testid="report-new"]').click()
    await window.waitForTimeout(400)

    // A report card should appear
    const reports = await window.evaluate(async () => window.api.reports.list())
    const reportList = reports as Array<{ id: string }>
    expect(reportList.length).toBeGreaterThan(0)
    const reportId = reportList[0].id

    await expect(window.locator(`[data-testid="report-card-${reportId}"]`)).toBeVisible({ timeout: 5_000 })

    // Editor should be open with the table checkbox
    await expect(window.locator(`[data-testid="report-table-${tableId}"]`)).toBeVisible({ timeout: 5_000 })

    // Tick the table checkbox
    await window.locator(`[data-testid="report-table-${tableId}"]`).click()
    await window.waitForTimeout(300)

    // Confirm selection persisted via IPC
    const updated = await window.evaluate(
      async (id) => window.api.reports.get(id),
      reportId
    )
    const updatedTyped = updated as { sourceTableIds: string[] }
    expect(updatedTyped.sourceTableIds).toContain(tableId)
  } finally {
    await dispose()
  }
})

test('3 + 4. generate: output is real data, label matches actual path (no-fakery)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed a table with 4 rows
    const table = await window.evaluate(async () =>
      window.api.tables.create({ taskId: null, title: 'Inventory Table' })
    )
    const tableId: string = (table as { id: string }).id

    for (let i = 0; i < 4; i++) {
      await window.evaluate(
        async (tid) => window.api.tables.createRow({ tableId: tid }),
        tableId
      )
    }

    // Create and configure report via IPC
    const report = await window.evaluate(
      async (tid) => window.api.reports.create({ title: 'Inventory Report', sourceTableIds: [tid] }),
      tableId
    )
    const reportId: string = (report as { id: string }).id

    // Open PlexiReports and select the report card
    await openProduct(window, 'reports')
    await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="report-card-${reportId}"]`).click()
    await expect(window.locator('[data-testid="report-generate"]')).toBeVisible({ timeout: 5_000 })

    // Click Generate now
    await window.locator('[data-testid="report-generate"]').click()

    // Wait for report-output to appear
    const outputLocator = window.locator('[data-testid="report-output"]')
    await expect(outputLocator).toBeVisible({ timeout: 15_000 })

    // Verify via IPC: real data, honest isAi flag
    const genResult = await window.evaluate(
      async (id) => window.api.reports.generate(id),
      reportId
    )
    const gen = genResult as { ok: boolean; isAi: boolean; needsApiKey?: boolean; output: string }
    expect(gen.ok).toBe(true)

    // Core no-fakery invariant: the data summary (ground truth) must contain
    // the real row count. The AI narrative is grounded on this summary, so either
    // path should reference 4 rows (the AI received it as context).
    // The data summary format is deterministic: "4 rows, 0 columns."
    expect(gen.output).toMatch(/4 row/)

    // No-fakery label check: UI label must match what was actually generated.
    // isAi=true → UI shows "AI narrative". isAi=false → UI shows "Data summary".
    // Either is honest. The only violation would be: isAi=false but UI shows "AI narrative"
    // (or vice versa).
    const view = window.locator('[data-testid="plexireports-view"]')
    const viewText = await view.innerText()

    if (gen.isAi) {
      // Real AI narrative: must be labelled as such
      expect(viewText).toContain('AI narrative')
      // Must NOT be falsely called a data summary
      expect(viewText).not.toContain('Data summary')
    } else {
      // No-key fallback: must be labelled as a data summary
      expect(viewText).toContain('Data summary')
      expect(viewText).not.toContain('AI narrative')
      // Must inform user that a key would produce a narrative
      expect(viewText).toContain('Anthropic key')
      // The data summary itself must name the table
      expect(gen.output).toContain('Inventory Table')
    }
  } finally {
    await dispose()
  }
})

test('5. email path: with no mail account, shows honest error (not fake "sent")', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Create a report and generate it so there is output to send
    const table = await window.evaluate(async () =>
      window.api.tables.create({ taskId: null, title: 'Email Test Table' })
    )
    const tableId: string = (table as { id: string }).id
    const report = await window.evaluate(
      async (tid) => window.api.reports.create({ title: 'Email Test Report', sourceTableIds: [tid] }),
      tableId
    )
    const reportId: string = (report as { id: string }).id

    // Generate via IPC so output exists
    await window.evaluate(async (id) => window.api.reports.generate(id), reportId)

    // Open PlexiReports and select the report
    await openProduct(window, 'reports')
    await expect(window.locator('[data-testid="plexireports-view"]')).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="report-card-${reportId}"]`).click()
    await expect(window.locator('[data-testid="report-generate"]')).toBeVisible({ timeout: 5_000 })

    // Report output must be visible (we generated via IPC; onChanged reload will show it)
    // Generate via UI to populate the output state in the component
    await window.locator('[data-testid="report-generate"]').click()
    await expect(window.locator('[data-testid="report-output"]')).toBeVisible({ timeout: 15_000 })

    // Set a recipient
    await window.locator('[data-testid="report-recipients"]').fill('test@example.com')
    await window.locator('[data-testid="report-recipients"]').dispatchEvent('blur')
    await window.waitForTimeout(300)

    // Click Email to recipients
    await window.locator('[data-testid="report-email"]').click()
    await window.waitForTimeout(1_500)

    // Must show a message. With no mail account configured it should say "Could not send"
    // or a similar honest error, not "Sent to 1 recipient(s)."
    const view = window.locator('[data-testid="plexireports-view"]')
    const viewText = await view.innerText()

    // The view text must contain some delivery feedback
    const hasDeliveryFeedback =
      viewText.includes('Could not send') ||
      viewText.includes('Sending') ||
      viewText.includes('Sent to') ||
      viewText.includes('sending')

    expect(hasDeliveryFeedback).toBe(true)

    // Must NOT silently succeed with fake confirmation when no mail is configured.
    // If it shows "Sent to", that's only acceptable if mail.send actually returns ok:true
    // (a real configured account). If no account: must show "Could not send".
    const mailAccounts = await window.evaluate(async () => {
      // Check if any mail accounts are configured
      try {
        return await window.api.mail.listAccounts()
      } catch {
        return []
      }
    })
    const hasMailAccount = Array.isArray(mailAccounts) && (mailAccounts as unknown[]).length > 0

    if (!hasMailAccount) {
      // Strict check: no mail account means send must fail honestly
      expect(viewText).toContain('Could not send')
      expect(viewText).not.toContain('Sent to')
    }
    // If mail account IS configured, "Sent to" is a real send — also acceptable.
  } finally {
    await dispose()
  }
})

test('6. suite launcher: PlexiReports tile opens Insights (reporting home)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Go to suite home (already the default view, but navigate explicitly)
    // STALE: there is no "PlexiiSuite" button to click — the object-based IA
    // dropped the literal sidebar entries, so this waited out the full 30s
    // timeout. goSuite ({ kind: 'suite' }) is the view store's own route to it.
    await gotoView(window, 'goSuite')
    await expect(window.locator('[data-testid="plexisuite-home"]')).toBeVisible({ timeout: 8_000 })

    // Click the PlexiReports tile — opens ProductHome
    await window.locator('[data-testid="product-tile-plexireports"]').click()
    await expect(window.locator('[data-testid="product-home-plexireports"]')).toBeVisible({ timeout: 8_000 })

    // Click the Open button. In the three-segment IA, reporting lives in
    // PlexiBrain > Insights ("Insights is dashboards and reporting"), so the
    // Reports tile now opens the Insights view.
    await window.locator('[data-testid="open-plexireports"]').click()
    await expect(window.locator('[data-testid="insights-view"]')).toBeVisible({ timeout: 8_000 })
  } finally {
    await dispose()
  }
})
