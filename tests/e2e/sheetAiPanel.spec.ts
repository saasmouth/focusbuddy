/**
 * E2E for the PlexiSheets right-side AI Assistant panel.
 *
 * The panel runs on the real AI infrastructure (window.api.ai.suggestDocContent),
 * so we stub that IPC channel before interacting, making the test deterministic
 * and offline. We assert:
 *   AP-1 the panel renders with its header and the honest empty states for
 *        Recent Activity and Data Connections, and an empty insights prompt;
 *   AP-2 entering data then generating insights calls the stub and shows a result;
 *   AP-3 asking a question calls the stub and shows the answer;
 *   AP-4 the panel collapses and re-expands via the toolbar toggle.
 *
 * The sheet is opened through PlexiOffice, matching sheetDefaults.spec.ts.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function newSheet(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-sheets"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-sheets"]').click()
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
}

// Stub the doc-content AI channel that both the insights and ask flows call.
// suggestDocContent resolves to { ok, html }, so we return constrained HTML.
async function stubSuggestDocContent(app: LaunchedApp['app'], html: string): Promise<void> {
  await app.evaluate(({ ipcMain }, h: string) => {
    ipcMain.removeHandler('ai:suggestDocContent')
    ipcMain.handle('ai:suggestDocContent', async () => ({ ok: true, html: h }))
  }, html)
}

// Enter a value into a cell via the formula bar, then blur by clicking another
// cell. Mirrors the workflow used in sheetEditor.spec.ts.
async function setCell(window: Page, r: number, c: number, value: string, blurTo: [number, number] = [0, 0]): Promise<void> {
  await window.locator(`[data-testid="cell-${r}-${c}"]`).click()
  const bar = window.locator('input[placeholder*="Select a cell"]')
  await bar.click()
  await bar.fill(value)
  const [br, bc] = blurTo
  if (br !== r || bc !== c) await window.locator(`[data-testid="cell-${br}-${bc}"]`).click()
  await window.waitForTimeout(120)
}

test.describe('PlexiSheets AI Assistant panel', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
  })
  test.afterAll(async () => {
    await app.dispose()
  })

  test('AP-1 — panel renders with header and honest empty states', async () => {
    await newSheet(window)
    const panel = window.locator('[data-testid="sheet-ai-panel"]')
    await expect(panel).toBeVisible({ timeout: 8_000 })
    await expect(panel.getByText('AI Assistant')).toBeVisible()
    await expect(panel.getByText('Here are some insights from your data')).toBeVisible()
    await expect(panel.getByText('Ask a question about your data')).toBeVisible()

    // Recent Activity and Data Connections are honest empty states, never the
    // mockup's invented people or integration badges.
    await expect(window.locator('[data-testid="sheet-ai-activity-empty"]')).toContainText('No recent activity yet.')
    await expect(window.locator('[data-testid="sheet-ai-connections-empty"]')).toContainText('No data sources connected yet.')
    // No invented connections leak in.
    await expect(panel).not.toContainText('Google Analytics')
    await expect(panel).not.toContainText('HubSpot')
    await expect(panel).not.toContainText('Connected')
    // The connect affordance is disabled (coming soon), not a working integration.
    await expect(window.locator('[data-testid="sheet-ai-connect-source"]')).toBeDisabled()
  })

  test('AP-2 — empty sheet shows the honest insights empty state, not a fabricated result', async () => {
    await newSheet(window)
    // A fresh sheet has no data, so generating insights must show the empty state
    // and must NOT call the model (no fabricated insight).
    await window.locator('[data-testid="sheet-ai-insights-run"]').click()
    await expect(window.locator('[data-testid="sheet-ai-insights-empty"]')).toBeVisible({ timeout: 4_000 })
    await expect(window.locator('[data-testid="sheet-ai-insights-empty"]')).toContainText('Add some data')
  })

  test('AP-3 — entering data then generating insights calls the stub and shows a result', async () => {
    await newSheet(window)
    await stubSuggestDocContent(app.app, '<ul><li>Revenue rises across the three rows shown.</li></ul>')

    await setCell(window, 0, 0, 'Month', [1, 0])
    await setCell(window, 0, 1, 'Revenue', [1, 0])
    await setCell(window, 1, 0, 'Jan', [2, 0])
    await setCell(window, 1, 1, '100', [2, 0])
    await setCell(window, 2, 0, 'Feb', [0, 0])
    await setCell(window, 2, 1, '200', [0, 0])

    await window.locator('[data-testid="sheet-ai-insights-run"]').click()
    await expect(window.locator('[data-testid="sheet-ai-insights-result"]')).toBeVisible({ timeout: 6_000 })
    await expect(window.locator('[data-testid="sheet-ai-insights-result"]')).toContainText('Revenue rises')
  })

  test('AP-4 — asking a question calls the stub and shows the answer', async () => {
    await newSheet(window)
    await stubSuggestDocContent(app.app, '<p>The highest revenue shown is 200.</p>')

    await setCell(window, 0, 0, 'Month', [1, 0])
    await setCell(window, 0, 1, 'Revenue', [1, 0])
    await setCell(window, 1, 1, '100', [2, 0])
    await setCell(window, 2, 1, '200', [0, 0])

    const input = window.locator('[data-testid="sheet-ai-ask-input"]')
    await input.fill('What was the highest revenue?')
    await window.locator('[data-testid="sheet-ai-ask-send"]').click()

    await expect(window.locator('[data-testid="sheet-ai-result"]')).toBeVisible({ timeout: 6_000 })
    await expect(window.locator('[data-testid="sheet-ai-result"]')).toContainText('highest revenue shown is 200')
  })

  test('AP-5 — the panel collapses and re-expands', async () => {
    await newSheet(window)
    await expect(window.locator('[data-testid="sheet-ai-panel"]')).toBeVisible()
    // Collapse via the in-panel control.
    await window.locator('[data-testid="sheet-ai-collapse"]').click()
    await expect(window.locator('[data-testid="sheet-ai-panel"]')).toHaveCount(0)
    // Re-open via the toolbar toggle.
    await window.locator('[data-testid="sheet-ai-toggle"]').click()
    await expect(window.locator('[data-testid="sheet-ai-panel"]')).toBeVisible({ timeout: 4_000 })
  })
})
