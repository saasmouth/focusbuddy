/**
 * E2E for in-cell sparklines in PlexiSheets.
 *
 * A =SPARKLINE(range) formula draws a mini line chart inside the cell; a "bar"
 * option draws bars. The cell still holds the formula, the grid renders the chart
 * instead of a number. A toolbar button inserts a sparkline for the current
 * selection.
 *
 * Coverage:
 *  SP-1  Type =SPARKLINE(B1:F1) into a cell — a line svg with 5 points appears.
 *  SP-2  The "bar" option draws a bar variant with one rect per value.
 *  SP-3  The sheet-insert-sparkline toolbar button writes =SPARKLINE(range) for
 *        the selected row into the next cell and renders it.
 *
 * The sheet is opened via PlexiOffice (sidebar button then office-app-sheets), the
 * open pattern from sheetDefaults.spec.ts. Values are entered through the formula
 * bar, the reliable path used by sheetEditor.spec.ts.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function openSheet(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-sheets"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-sheets"]').click()
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
}

function formulaBar(window: Page): import('@playwright/test').Locator {
  return window.locator('input[placeholder*="Select a cell"]')
}

async function clickCell(window: Page, r: number, c: number): Promise<void> {
  await window.locator(`[data-testid="cell-${r}-${c}"]`).click()
}

/** Enter a value via the formula bar then blur to another cell. */
async function setViaFormulaBar(
  window: Page,
  r: number,
  c: number,
  value: string,
  blurTo: [number, number] = [0, 0]
): Promise<void> {
  await clickCell(window, r, c)
  const bar = formulaBar(window)
  await bar.click()
  await bar.fill(value)
  const [br, bc] = blurTo
  if (br !== r || bc !== c) await clickCell(window, br, bc)
  await window.waitForTimeout(150)
}

test.describe('PlexiSheets sparklines', () => {
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

  test('SP-1 — =SPARKLINE(range) draws a line chart with one point per value', async () => {
    await openSheet(window)

    // Five numbers across row 0 (B1..F1 = columns 1..5).
    const vals = ['3', '7', '4', '9', '5']
    for (let i = 0; i < vals.length; i++) {
      await setViaFormulaBar(window, 0, i + 1, vals[i], [0, 0])
    }
    // A1 = =SPARKLINE(B1:F1). Blur to a far empty cell so nothing is disturbed.
    await setViaFormulaBar(window, 0, 0, '=SPARKLINE(B1:F1)', [10, 0])

    const spark = window.locator('[data-testid="sparkline-0-0"]')
    await expect(spark).toBeVisible({ timeout: 3_000 })
    await expect(spark).toHaveAttribute('data-sparkline-type', 'line')
    await expect(spark).toHaveAttribute('data-sparkline-count', '5')
    // A line is a single polyline path, not text.
    await expect(spark.locator('path')).toHaveCount(1)
    // The cell shows the chart, not the formula text or a number.
    await expect(window.locator('[data-testid="cell-0-0"]')).not.toContainText('SPARKLINE')
  })

  test('SP-2 — the "bar" option draws a bar per value', async () => {
    await openSheet(window)

    const vals = ['2', '8', '5', '6']
    for (let i = 0; i < vals.length; i++) {
      await setViaFormulaBar(window, 0, i + 1, vals[i], [0, 0])
    }
    await setViaFormulaBar(window, 0, 0, '=SPARKLINE(B1:E1,"bar")', [10, 0])

    const spark = window.locator('[data-testid="sparkline-0-0"]')
    await expect(spark).toBeVisible({ timeout: 3_000 })
    await expect(spark).toHaveAttribute('data-sparkline-type', 'bar')
    await expect(spark).toHaveAttribute('data-sparkline-count', '4')
    // One rect per value.
    await expect(spark.locator('rect')).toHaveCount(4)
  })

  test('SP-3 — the toolbar inserts a sparkline for the selected row', async () => {
    await openSheet(window)

    const vals = ['1', '4', '2', '8', '6']
    for (let i = 0; i < vals.length; i++) {
      await setViaFormulaBar(window, 0, i, vals[i], [0, 0])
    }
    // Select A1:E1 (single row), then insert a sparkline. It lands in F1 (col 5).
    await clickCell(window, 0, 0)
    await window.locator('[data-testid="cell-0-4"]').click({ modifiers: ['Shift'] })
    await window.locator('[data-testid="sheet-insert-sparkline"]').click()
    await window.waitForTimeout(200)

    // The formula bar (now anchored on the new cell) holds the SPARKLINE formula.
    await expect(formulaBar(window)).toHaveValue(/^=SPARKLINE\(A1:E1\)$/)

    const spark = window.locator('[data-testid="sparkline-0-5"]')
    await expect(spark).toBeVisible({ timeout: 3_000 })
    await expect(spark).toHaveAttribute('data-sparkline-type', 'line')
    await expect(spark).toHaveAttribute('data-sparkline-count', '5')
  })
})
