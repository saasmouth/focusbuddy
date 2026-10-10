/**
 * A fresh PlexiSheets spreadsheet opens at 48 columns x 100 rows, and a column
 * heading can be edited (regression: the grid keydown handler used to hijack
 * keystrokes meant for the header input).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function newSheet(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-sheets"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-sheets"]').click()
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
}

test.describe('PlexiSheets defaults', () => {
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

  test('SD-1 a new sheet has 48 columns and 100 rows', async () => {
    await newSheet(window)
    // thead has the corner cell + one th per column = 49.
    const headerCells = await window.locator('[data-testid="sheet-grid"] thead th').count()
    expect(headerCells).toBe(49)
    await expect(window.locator('[data-testid="col-header-47"]')).toBeVisible()
    expect(await window.locator('[data-testid="col-header-48"]').count()).toBe(0)
    const rowCount = await window.locator('[data-testid="sheet-grid"] tbody tr').count()
    expect(rowCount).toBe(100)
  })

  test('SD-2 a column heading can be renamed (keystrokes not hijacked)', async () => {
    await newSheet(window)
    const input = window.locator('[data-testid="col-header-0"] input')
    // Type a character at a time so this genuinely exercises the keydown path the
    // grid used to hijack; the value must reflect what was typed.
    await input.focus()
    await input.fill('')
    await input.pressSequentially('Revenue', { delay: 20 })
    await expect(input).toHaveValue('Revenue')
  })
})
