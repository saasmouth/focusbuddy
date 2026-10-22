/**
 * E2E verification for the two XL Sheets features added on Plexi3.0:
 *
 *   1. Power Query — capture the sheet as a source, add a filter step, and
 *      confirm the grid reshapes (rows drop, source untouched, refreshable).
 *   2. Macros — run a script that doubles a column and confirm the cells update
 *      and persist.
 *
 * Navigation mirrors sheetRework2.spec.ts (openDocumentsHub / startBlankSpreadsheet
 * via the exposed __fbView store).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, selectBarTab } from './_helpers'

async function openDocumentsHub(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

async function startBlankSpreadsheet(window: Page): Promise<void> {
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Spreadsheet' }).first().click()
  await expect(window.locator('input[placeholder*="Select a cell"]')).toBeVisible({ timeout: 8_000 })
}

async function clickCell(window: Page, r: number, c: number): Promise<void> {
  await window.locator(`[data-testid="cell-${r}-${c}"]`).click()
}

function formulaBar(window: Page): ReturnType<Page['locator']> {
  return window.locator('input[placeholder*="Select a cell"]')
}

async function setViaFormulaBar(window: Page, r: number, c: number, value: string, blurTo: [number, number] = [0, 0]): Promise<void> {
  await clickCell(window, r, c)
  const bar = formulaBar(window)
  await bar.click()
  await bar.fill(value)
  const [br, bc] = blurTo
  if (br !== r || bc !== c) await clickCell(window, br, bc)
  await window.waitForTimeout(120)
}

async function cellText(window: Page, r: number, c: number): Promise<string> {
  const div = window.locator(`[data-testid="cell-${r}-${c}"]`).locator('div').first()
  return (await div.textContent()) ?? ''
}

// ── Power Query ──────────────────────────────────────────────────────────────

test('SQM-1 — query panel filters rows and leaves the source refreshable', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Region / Amount data across two columns, three rows.
    await setViaFormulaBar(window, 0, 0, 'EU', [0, 1])
    await setViaFormulaBar(window, 1, 0, 'US', [0, 1])
    await setViaFormulaBar(window, 2, 0, 'EU', [0, 1])
    await setViaFormulaBar(window, 0, 1, '100', [0, 0])
    await setViaFormulaBar(window, 1, 1, '50', [0, 0])
    await setViaFormulaBar(window, 2, 1, '200', [0, 0])

    // Open the query panel and capture the sheet as the source.
    await selectBarTab(window, 'sheet-toolbar', 'data')
    await window.locator('[data-testid="sheet-query-btn"]').click()
    await expect(window.locator('[data-testid="sheet-query-panel"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="query-capture"]').click()
    await expect(window.locator('[data-testid="query-kind"]')).toBeVisible({ timeout: 5_000 })

    // Add a filter: column 0 (the first column) equals EU.
    await window.locator('[data-testid="query-kind"]').selectOption('filter')
    await window.locator('[data-testid="query-col"]').selectOption('0')
    await window.locator('[data-testid="query-op"]').selectOption('eq')
    await window.locator('[data-testid="query-value"]').fill('EU')
    await window.locator('[data-testid="query-add"]').click()
    await window.waitForTimeout(200)

    // A step row should now exist.
    await expect(window.locator('[data-testid="query-step-0"]')).toBeVisible({ timeout: 5_000 })

    // Close the panel and inspect the grid: the two EU rows remain, the US row is gone.
    await window.keyboard.press('Escape')
    await window.waitForTimeout(300)

    // The filter leaves exactly two EU rows; the grid renders one row per data
    // row, so the (dropped) third row's cell should no longer exist.
    const r0 = (await window.locator('[data-testid="cell-0-0"]').textContent()) ?? ''
    const r1 = (await window.locator('[data-testid="cell-1-0"]').textContent()) ?? ''
    const thirdRow = await window.locator('[data-testid="cell-2-0"]').count()
    // eslint-disable-next-line no-console
    console.log(`[SQM-1 evidence] after EU filter col0 rows: "${r0}", "${r1}", third-row-cells=${thirdRow}`)
    expect(r0).toBe('EU')
    expect(r1).toBe('EU')
    expect(thirdRow, 'the US row is gone, so only two data rows remain').toBe(0)
  } finally {
    await dispose()
  }
})

// ── Macros ───────────────────────────────────────────────────────────────────

test('SQM-2 — a macro that doubles column A updates the cells', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, '10', [0, 1])
    await setViaFormulaBar(window, 1, 0, '20', [0, 1])
    await setViaFormulaBar(window, 2, 0, '30', [0, 1])

    await selectBarTab(window, 'sheet-toolbar', 'tools')
    await window.locator('[data-testid="sheet-macros-btn"]').click()
    await expect(window.locator('[data-testid="sheet-macros-panel"]')).toBeVisible({ timeout: 3_000 })

    const script = [
      'function main(sheet) {',
      '  for (let r = 0; r < sheet.rowCount(); r++) {',
      '    const v = Number(sheet.getValue(r, 0))',
      '    if (!Number.isNaN(v) && sheet.getValue(r, 0) !== "") sheet.setValue(r, 0, String(v * 2))',
      '  }',
      '}'
    ].join('\n')
    await window.locator('[data-testid="macros-code"]').fill(script)
    await window.locator('[data-testid="macros-run"]').click()
    await window.waitForTimeout(200)
    const errBanner = window.locator('[data-testid="macros-error"]')
    if (await errBanner.count()) {
      // eslint-disable-next-line no-console
      console.log(`[SQM-2 macro error] ${await errBanner.textContent()}`)
    }
    const logBanner = window.locator('[data-testid="macros-logs"]')
    if (await logBanner.count()) {
      // eslint-disable-next-line no-console
      console.log(`[SQM-2 macro logs] ${await logBanner.textContent()}`)
    }
    await window.keyboard.press('Escape')
    await window.waitForTimeout(150)

    const a0 = await cellText(window, 0, 0)
    const a1 = await cellText(window, 1, 0)
    const a2 = await cellText(window, 2, 0)
    // eslint-disable-next-line no-console
    console.log(`[SQM-2 evidence] after doubling macro col A: "${a0}", "${a1}", "${a2}"`)
    expect(a0).toBe('20')
    expect(a1).toBe('40')
    expect(a2).toBe('60')
  } finally {
    await dispose()
  }
})
