/**
 * E2E tests for the SheetEditor bug-fixes and new features shipped in the
 * 2026-06-18 documents refinement batch.
 *
 * SE-V2-1  No first-keystroke duplication: type "1" → cell value is "1" not "11";
 *          formula "=SUM(A1:A2)" is not doubled to "==SUM(…)".
 * SE-V2-2  Formula computes correctly: 10 in A1, 20 in A2, =SUM(A1:A2) in A3
 *          renders "30"; a bad formula renders "#ERR".
 * SE-V2-3  Ctrl/Cmd+A selects all used cells; applying Bold via toolbar puts
 *          bold:true on every cell in the persisted formats map.
 * SE-V2-4  Column-header right-click opens sheet-col-menu; Insert column left
 *          increases the column count and persists; Delete column works;
 *          Delete is disabled when only 1 column remains.
 * SE-V2-5  sheet:import stub with a formula cell: the formula computes after
 *          import; sheet:export IPC is invoked and sheet-status shows the path.
 *
 * IPC stubs follow the same pattern as sheetEditor.spec.ts / docEditor.spec.ts:
 * app.evaluate → ipcMain so no live calls and no OS file dialogs are involved.
 *
 * Interaction model:
 *   - Click cell-{r}-{c} sets anchor/focus (no inline edit).
 *   - The formula bar <input> (placeholder "Select a cell…") directly reflects
 *     the raw cell value and applies onChange without a separate commit.
 *   - To type directly into a cell (testing the startEdit path): after clicking
 *     the cell, press a printable key on window.keyboard — the grid wrapper's
 *     onKeyDown calls startEdit(focus, e.key) and e.preventDefault() stops the
 *     same key landing in the inline input, so the input gets exactly one char.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, selectBarTab } from './_helpers'

// ── Shared navigation helpers ─────────────────────────────────────────────────

async function openDocumentsHub(window: Page): Promise<void> {
  // The object-based IA no longer has a literal "Documents" sidebar button;
  // navigation goes through the exposed view store (same approach as
  // documents.spec.ts / documentTrash.spec.ts).
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({
    timeout: 8_000
  })
}

async function startBlankSpreadsheet(window: Page): Promise<void> {
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Spreadsheet' }).first().click()
  await expect(window.locator('input[placeholder*="Select a cell"]')).toBeVisible({
    timeout: 8_000
  })
}

/** Click a cell by its data-testid. */
async function clickCell(window: Page, r: number, c: number): Promise<void> {
  await window.locator(`[data-testid="cell-${r}-${c}"]`).click()
}

/** Return the formula bar locator. */
function formulaBar(window: Page): ReturnType<Page['locator']> {
  return window.locator('input[placeholder*="Select a cell"]')
}

/** Enter a value via the formula bar and blur by clicking another cell. */
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
  if (br !== r || bc !== c) {
    await clickCell(window, br, bc)
  }
  await window.waitForTimeout(150)
}

/** Read the displayed text of a cell (the inner div, not an inline input). */
async function cellText(window: Page, r: number, c: number): Promise<string> {
  const cell = window.locator(`[data-testid="cell-${r}-${c}"]`)
  const div = cell.locator('div').first()
  return (await div.textContent()) ?? ''
}

/** Read the persisted sheet body from the store (waits for autosave). */
async function getPersistedBody(
  window: Page,
  waitMs = 1_500
): Promise<{ version: number; sheets: Array<{ rows: string[][]; formats?: Record<string, { bold?: boolean }>; columns: string[] }> }> {
  await window.waitForTimeout(waitMs)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const doc = await api.documents.get(docs[0].id)
    return doc?.body
  }) as Promise<{ version: number; sheets: Array<{ rows: string[][]; formats?: Record<string, { bold?: boolean }>; columns: string[] }> }>
}

// ── IPC stubs ─────────────────────────────────────────────────────────────────

async function stubSheetImport(
  app: LaunchedApp['app'],
  body: object,
  name = 'test.xlsx'
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { b, n }: { b: object; n: string }) => {
      ipcMain.removeHandler('sheet:import')
      ipcMain.handle('sheet:import', async () => ({ ok: true, body: b, name: n }))
    },
    { b: body, n: name }
  )
}

async function stubSheetExport(app: LaunchedApp['app'], path: string): Promise<void> {
  await app.evaluate(({ ipcMain }, p: string) => {
    ipcMain.removeHandler('sheet:export')
    ipcMain.handle('sheet:export', async () => ({ ok: true, path: p }))
  }, path)
}

// ── SE-V2-1: No first-keystroke duplication ───────────────────────────────────

test('SE-V2-1 — no first-keystroke duplication: typing "1" produces "1" not "11"', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Click cell (0,0) to give the grid focus, then press "1" as a real keypress.
    // The grid wrapper's onKeyDown fires: e.key === '1' is a printable char, so
    // startEdit(focus, '1') is called and e.preventDefault() is run. The inline
    // input is seeded with '1' and receives NO further synthetic input events,
    // so its value stays '1'.
    await clickCell(window, 0, 0)
    // We need the grid wrapper focused (clickCell gives it focus via focusGrid).
    await window.keyboard.press('1')
    await window.waitForTimeout(200)

    // The inline input for cell (0,0) should contain exactly '1'.
    const inlineInput = window.locator('[data-testid="cell-0-0"] input')
    await expect(inlineInput).toBeVisible({ timeout: 3_000 })
    const val = await inlineInput.inputValue()
    expect(val, 'inline input must be "1" not "11"').toBe('1')

    // Commit with Enter, then verify the cell display.
    await window.keyboard.press('Enter')
    await window.waitForTimeout(150)

    const shown = await cellText(window, 0, 0)
    expect(shown, 'cell display after commit must be "1" not "11"').toBe('1')

    // Verify via SQLite persistence.
    const body = await getPersistedBody(window)
    expect(body.sheets[0].rows[0][0], 'persisted cell value must be "1"').toBe('1')
  } finally {
    await dispose()
  }
})

// ── SE-V2-1b: No formula duplication (= not doubled) ─────────────────────────

test('SE-V2-1b — no "=" duplication: "=SUM(A1:A2)" is not stored as "==SUM(A1:A2)"', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Seed A1=10, A2=20 via formula bar.
    await setViaFormulaBar(window, 0, 0, '10', [0, 1])
    await setViaFormulaBar(window, 1, 0, '20', [0, 1])

    // Now type the formula directly into cell A3 by pressing printable keys.
    // Press "=" first — this triggers startEdit(focus, '=') with preventDefault.
    await clickCell(window, 2, 0)
    await window.keyboard.press('=')
    await window.waitForTimeout(150)

    // The inline input should show '=' (just one equals sign).
    const inlineInput = window.locator('[data-testid="cell-2-0"] input')
    await expect(inlineInput).toBeVisible({ timeout: 3_000 })
    const afterEq = await inlineInput.inputValue()
    expect(afterEq, '"=" key must seed exactly one "=" in the inline input').toBe('=')

    // Type the rest of the formula by typing into the inline input directly.
    await inlineInput.type('SUM(A1:A2)')
    await window.keyboard.press('Enter')
    await window.waitForTimeout(200)

    // The cell display should show '30' (the computed result), not '#ERR' or '==…'.
    const shown = await cellText(window, 2, 0)
    expect(shown, '=SUM(A1:A2) must compute to "30"').toBe('30')
  } finally {
    await dispose()
  }
})

// ── SE-V2-2: Formula computes correctly ──────────────────────────────────────

test('SE-V2-2 — formula: 10+20=SUM computes to 30; bad formula shows #ERR', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // A1 = 10, A2 = 20 (rows 0 and 1, col 0)
    await setViaFormulaBar(window, 0, 0, '10', [0, 1])
    await setViaFormulaBar(window, 1, 0, '20', [0, 1])

    // A3 = =SUM(A1:A2) — enter via formula bar to guarantee exact value.
    await setViaFormulaBar(window, 2, 0, '=SUM(A1:A2)', [0, 0])

    const sumShown = await cellText(window, 2, 0)
    expect(sumShown, '=SUM(A1:A2) must render as "30"').toBe('30')

    // A4 = bad formula
    await setViaFormulaBar(window, 3, 0, '=2+', [0, 0])
    const errShown = await cellText(window, 3, 0)
    expect(errShown, 'broken formula must render as "#ERR"').toBe('#ERR')
  } finally {
    await dispose()
  }
})

// ── SE-V2-3: Ctrl/Cmd+A selects all, Bold applies to all, persists ─────────

test('SE-V2-3 — Ctrl+A selects all cells; Bold applies across all cells and persists', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Seed a few cells so there is a "used grid" to select.
    await setViaFormulaBar(window, 0, 0, 'Alpha', [0, 1])
    await setViaFormulaBar(window, 0, 1, 'Beta', [0, 0])
    await setViaFormulaBar(window, 1, 0, 'Gamma', [0, 0])

    // Click the grid wrapper to give it keyboard focus (clicking A1 does that).
    await clickCell(window, 0, 0)
    await window.waitForTimeout(100)

    // Press Ctrl/Cmd+A to select all used cells.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await window.keyboard.press(`${mod}+a`)
    await window.waitForTimeout(200)

    // Now apply Bold via the sheet toolbar.
    const toolbar = window.locator('[data-testid="sheet-toolbar"]')
    await toolbar.getByRole('button', { name: /Bold/i }).click()
    await window.waitForTimeout(200)

    // Verify that cell (0,0) is rendered bold.
    const cell00 = window.locator('[data-testid="cell-0-0"]')
    const fw00 = await cell00.locator('div').first().evaluate(
      (el) => window.getComputedStyle(el).fontWeight
    )
    expect(fw00, 'cell (0,0) should be bold after Ctrl+A + Bold').toBe('700')

    // Also verify cell (0,1) is bold.
    const cell01 = window.locator('[data-testid="cell-0-1"]')
    const fw01 = await cell01.locator('div').first().evaluate(
      (el) => window.getComputedStyle(el).fontWeight
    )
    expect(fw01, 'cell (0,1) should also be bold (was in selection)').toBe('700')

    // Wait for autosave and confirm the formats map in SQLite has bold for all.
    const body = await getPersistedBody(window, 1_500)
    const fmts = body.sheets[0].formats ?? {}

    // At least (0,0) and (0,1) must be bold in the persisted map.
    expect(fmts['0,0']?.bold, 'formats["0,0"].bold persisted').toBe(true)
    expect(fmts['0,1']?.bold, 'formats["0,1"].bold persisted').toBe(true)
    expect(fmts['1,0']?.bold, 'formats["1,0"].bold persisted').toBe(true)
  } finally {
    await dispose()
  }
})

// ── SE-V2-4: Column-header right-click context menu ──────────────────────────

test('SE-V2-4 — right-click col-header-1 opens sheet-col-menu; Insert left + Delete work', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // The default blank sheet has 4 columns (indices 0-3). We will right-click
    // on column header at index 1.
    const initialColCount = (await window.locator('[data-testid="sheet-grid"] thead th').count()) - 1

    // Right-click on col-header-1.
    await window.locator('[data-testid="col-header-1"]').click({ button: 'right' })
    await expect(window.locator('[data-testid="sheet-col-menu"]')).toBeVisible({ timeout: 3_000 })

    // The menu has Insert column left, Insert column right, Delete column.
    const menu = window.locator('[data-testid="sheet-col-menu"]')
    await expect(menu.locator('text=Insert column left')).toBeVisible()
    await expect(menu.locator('text=Insert column right')).toBeVisible()
    await expect(menu.locator('text=Delete column')).toBeVisible()

    // Click "Insert column left".
    await menu.locator('text=Insert column left').click()
    await window.waitForTimeout(200)

    // The menu should close.
    await expect(window.locator('[data-testid="sheet-col-menu"]')).not.toBeVisible({ timeout: 2_000 })

    // Column count must have increased by 1.
    const colsAfterInsert = (await window.locator('[data-testid="sheet-grid"] thead th').count()) - 1
    expect(colsAfterInsert, 'column count increases after Insert column left').toBe(initialColCount + 1)

    // Persist check.
    const body = await getPersistedBody(window)
    expect(body.sheets[0].columns.length, 'persisted column count increased').toBe(initialColCount + 1)

    // Now right-click col-header-0 to test Delete column.
    await window.locator('[data-testid="col-header-0"]').click({ button: 'right' })
    await expect(window.locator('[data-testid="sheet-col-menu"]')).toBeVisible({ timeout: 3_000 })
    await window.locator('[data-testid="sheet-col-menu"]').locator('text=Delete column').click()
    await window.waitForTimeout(200)

    const colsAfterDelete = (await window.locator('[data-testid="sheet-grid"] thead th').count()) - 1
    expect(colsAfterDelete, 'column count decreases after Delete column').toBe(initialColCount)

    // Test the disabled state: reduce columns to 1 by deleting repeatedly,
    // then verify the Delete button is disabled.
    // Current count = initialColCount (typically 4). Delete down to 1.
    for (let i = colsAfterDelete; i > 1; i--) {
      await window.locator('[data-testid="col-header-0"]').click({ button: 'right' })
      await expect(window.locator('[data-testid="sheet-col-menu"]')).toBeVisible({ timeout: 3_000 })
      await window.locator('[data-testid="sheet-col-menu"]').locator('text=Delete column').click()
      await window.waitForTimeout(150)
    }
    const finalColCount = (await window.locator('[data-testid="sheet-grid"] thead th').count()) - 1
    expect(finalColCount, 'reduced to 1 column').toBe(1)

    // Right-click the single remaining header — Delete column should be disabled.
    await window.locator('[data-testid="col-header-0"]').click({ button: 'right' })
    await expect(window.locator('[data-testid="sheet-col-menu"]')).toBeVisible({ timeout: 3_000 })
    const deleteBtn = window.locator('[data-testid="sheet-col-menu"]').locator('button', { hasText: 'Delete column' })
    await expect(deleteBtn).toBeDisabled({ timeout: 2_000 })

    // Close the menu with Escape.
    await window.keyboard.press('Escape')
    await expect(window.locator('[data-testid="sheet-col-menu"]')).not.toBeVisible({ timeout: 2_000 })
  } finally {
    await dispose()
  }
})

// ── SE-V2-5: Import stub with formula cell; export stub shows path ────────────

test('SE-V2-5 — import stub with formula cell computes; export IPC invoked and status shows path', async () => {
  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Build a SheetBodyV2 that includes a formula cell so we can verify it computes.
    const fakeBody = {
      version: 2,
      sheets: [
        {
          id: 'st-v2-test',
          name: 'FormulaSheet',
          columns: ['A', 'B', 'C'],
          rows: [
            ['10', '20', '=SUM(A1:B1)'],  // row 0: A1=10, B1=20, C1=formula
            ['', '', '']                   // row 1: empty
          ]
        }
      ],
      activeSheet: 0
    }

    await stubSheetImport(app, fakeBody, 'formulas.xlsx')

    // Open the IO menu and click Import.
    const toolbar = window.locator('[data-testid="sheet-toolbar"]')
    await selectBarTab(window, 'sheet-toolbar', 'tools')
    await toolbar.getByRole('button', { name: /Import \.xlsx \/ \.csv/i }).click()
    await window.waitForTimeout(500)

    // After import: A1 = "10", B1 = "20", C1 formula should compute to "30".
    const a1 = await cellText(window, 0, 0)
    expect(a1, 'A1 after import = "10"').toBe('10')

    const b1 = await cellText(window, 0, 1)
    expect(b1, 'B1 after import = "20"').toBe('20')

    const c1 = await cellText(window, 0, 2)
    expect(c1, 'C1 formula =SUM(A1:B1) should compute to "30" not "#ERR"').toBe('30')

    // Status bar should mention the imported file name.
    await expect(window.locator('[data-testid="sheet-status"]')).toContainText('formulas.xlsx', {
      timeout: 3_000
    })

    // Now stub the export and trigger it.
    const fakePath = '/tmp/formulas-export.xlsx'
    await stubSheetExport(app, fakePath)

    // Dismiss the import status so we can cleanly read the export status.
    await window.locator('[data-testid="sheet-status"] button').click()
    await expect(window.locator('[data-testid="sheet-status"]')).not.toBeVisible({ timeout: 2_000 })

    // Open IO menu, export.
    await selectBarTab(window, 'sheet-toolbar', 'tools')
    await toolbar.getByRole('button', { name: /Export \.xlsx/i }).click()
    await window.waitForTimeout(300)

    // Status must show the saved path from the stubbed IPC.
    await expect(window.locator('[data-testid="sheet-status"]')).toContainText(fakePath, {
      timeout: 5_000
    })
  } finally {
    await dispose()
  }
})
