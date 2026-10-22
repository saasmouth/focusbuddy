/**
 * E2E tests for the Excel-class spreadsheet editor (SheetEditor / SheetGrid).
 *
 * Coverage (13 scenarios):
 *  SE-1  Blank spreadsheet opens with toolbar + grid + tab strip.
 *  SE-2  Enter a value via the formula bar; it shows in the grid and persists.
 *  SE-3  Formula: 10 + 20, =SUM(...) computes; bad formula shows #ERR.
 *  SE-4  Number format: select Currency from sheet-number-format; cell displays $1,234.00.
 *  SE-5  Cell formatting: bold a cell via toolbar; fontWeight is bold + body formats map persists.
 *  SE-6  Structural ops: insert a row and column; grid dimensions change and persist.
 *  SE-7  Undo/redo: make an edit, Ctrl/Cmd+Z reverts it, redo reapplies.
 *  SE-8  Keyboard nav: arrow keys move the active cell; typing starts inline edit.
 *  SE-9  Charts: select a range, insert bar chart, data-testid="sheet-chart" renders (SVG present).
 *  SE-10 Tabs: add sheet, switch, rename, delete; body.sheets length changes + persists.
 *  SE-11 xlsx interop: stub sheet:import → fixed SheetBodyV2; assert grid loads it; stub
 *        sheet:export and assert sheet-status shows the path.
 *  SE-12 AI fill: stub ai:fillSheetRange → fixed matrix; open panel, generate, preview shows,
 *        Apply writes matrix into grid.
 *  SE-13 Backward compat: legacy v1 body normalizes and renders on open.
 *
 * IPC stubs follow the exact pattern from docEditor.spec.ts — app.evaluate → ipcMain so
 * no live Anthropic calls and no native file dialogs are involved.
 *
 * Interaction model for the sheet editor:
 *   - Click cell-{r}-{c} sets focus there (anchor + focus move, no inline edit).
 *   - The formula bar <input> (placeholder "Select a cell…") shows the raw value
 *     and directly sets it via onChange — so typing in the formula bar + clicking
 *     another cell is the most reliable way to enter a value.
 *   - Double-clicking a cell starts the inline floating input.
 *   - Arrow keys on the focused grid wrapper move the selection; Enter/F2 opens
 *     inline edit.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, gotoView, selectBarTab } from './_helpers'

// ── Shared navigation helpers ─────────────────────────────────────────────────

async function openDocumentsHub(window: Page): Promise<void> {
  await gotoView(window, 'goDocuments')
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({
    timeout: 8_000
  })
}

async function startBlankSpreadsheet(window: Page): Promise<void> {
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Spreadsheet' }).first().click()
  // Formula bar is the definitive signal that the sheet editor is mounted.
  await expect(window.locator('input[placeholder*="Select a cell"]')).toBeVisible({
    timeout: 8_000
  })
}

/** Click a grid cell by its data-testid. The click sets focus/anchor; the cell
 *  is NOT in inline-edit mode (that requires a double-click or Enter/F2).
 */
async function clickCell(window: Page, r: number, c: number): Promise<void> {
  await window.locator(`[data-testid="cell-${r}-${c}"]`).click()
}

/** Return the formula bar input. */
function formulaBar(window: Page): import('@playwright/test').Locator {
  return window.locator('input[placeholder*="Select a cell"]')
}

/** Enter a value into the focused cell by typing into the formula bar then
 *  clicking the target-cell to blur (which triggers commitEdit 'none' on the
 *  inline editor and also represents a real user workflow). After blurring we
 *  click cell-0-0 as a safe "another cell" unless we are already there.
 */
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
  // Clear whatever the formula bar holds, then type the value.
  await bar.fill(value)
  // Blur by clicking another cell; SheetEditor updates the cell on onChange of
  // the formula bar (no separate commit step), so blurring is just for focus.
  const [br, bc] = blurTo
  if (br !== r || bc !== c) {
    await clickCell(window, br, bc)
  }
  await window.waitForTimeout(150)
}

/** Read the displayed text of a cell (the inner div text, not the input value). */
async function cellText(window: Page, r: number, c: number): Promise<string> {
  const cell = window.locator(`[data-testid="cell-${r}-${c}"]`)
  // When not in inline-edit mode the cell renders a <div> with the displayed value.
  const div = cell.locator('div').first()
  return (await div.textContent()) ?? ''
}

// Read a column's header name (the editable input inside its col-header cell).
async function columnName(window: Page, c: number): Promise<string> {
  return window.locator(`[data-testid="col-header-${c}"] input`).inputValue()
}

// ── IPC stubs (main process) ──────────────────────────────────────────────────

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

async function stubAiFill(app: LaunchedApp['app'], rows: string[][]): Promise<void> {
  await app.evaluate(({ ipcMain }, r: string[][]) => {
    ipcMain.removeHandler('ai:fillSheetRange')
    ipcMain.handle('ai:fillSheetRange', async () => ({ ok: true, rows: r }))
  }, rows)
}

async function stubAiColumns(app: LaunchedApp['app'], columns: string[]): Promise<void> {
  await app.evaluate(({ ipcMain }, c: string[]) => {
    ipcMain.removeHandler('ai:suggestSheetColumns')
    ipcMain.handle('ai:suggestSheetColumns', async () => ({ ok: true, columns: c }))
  }, columns)
}

async function stubAiFormula(
  app: LaunchedApp['app'],
  result: { ok: boolean; formula?: string; explanation?: string; columnsToAdd?: string[] }
): Promise<void> {
  await app.evaluate(({ ipcMain }, r) => {
    ipcMain.removeHandler('ai:suggestFormula')
    ipcMain.handle('ai:suggestFormula', async () => r)
  }, result)
}

// ── SE-1: Basic layout ────────────────────────────────────────────────────────

test('SE-1 — blank spreadsheet opens with toolbar, grid and tab strip', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await expect(window.locator('[data-testid="sheet-toolbar"]')).toBeVisible()
    await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible()
    await expect(window.locator('[data-testid="sheet-tab-strip"]')).toBeVisible()

    // Formula bar present with correct placeholder
    await expect(formulaBar(window)).toBeVisible()
    await expect(formulaBar(window)).toHaveAttribute('placeholder', /Select a cell/)

    // Undo and Redo buttons present (disabled on fresh sheet)
    const toolbar = window.locator('[data-testid="sheet-toolbar"]')
    await expect(toolbar.getByRole('button', { name: /Undo/i })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: /Redo/i })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: /Bold/i })).toBeVisible()

    // Default tab is "Sheet 1"
    await expect(window.locator('[data-testid="sheet-tab-strip"]').locator('text=Sheet 1')).toBeVisible()

    // Grid has cells — cell-0-0 is present (0-indexed)
    await expect(window.locator('[data-testid="cell-0-0"]')).toBeVisible()
  } finally {
    await dispose()
  }
})

// ── SE-2: Value entry + persistence ──────────────────────────────────────────

test('SE-2 — enter value via formula bar; it shows in the grid and persists', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Enter "Hello" into cell (0,0)
    await setViaFormulaBar(window, 0, 0, 'Hello', [0, 1])

    // The cell display div should show "Hello"
    const shown = await cellText(window, 0, 0)
    expect(shown).toBe('Hello')

    // Wait for autosave debounce (600 ms + generous buffer)
    await window.waitForTimeout(1_500)

    // Read the persisted body back from the store
    const stored = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const docs = await api.documents.list()
      const latest = docs[0]
      const doc = await api.documents.get(latest.id)
      return doc?.body
    })

    const body = stored as { version: number; sheets: Array<{ rows: string[][] }> }
    expect(body.version, 'body is v2').toBe(2)
    expect(body.sheets[0].rows[0][0], 'cell (0,0) value persisted').toBe('Hello')
  } finally {
    await dispose()
  }
})

// ── SE-3: Formulas and #ERR ───────────────────────────────────────────────────

test('SE-3 — formula: SUM of two cells computes; bad formula shows #ERR', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // A1 = 10
    await setViaFormulaBar(window, 0, 0, '10', [0, 1])
    // B1 = 20
    await setViaFormulaBar(window, 0, 1, '20', [1, 0])
    // A2 = =SUM(A1:B1)
    await setViaFormulaBar(window, 1, 0, '=SUM(A1:B1)', [0, 0])

    const sumShown = await cellText(window, 1, 0)
    expect(sumShown, '=SUM(A1:B1) should compute to 30').toBe('30')

    // A3 = bad formula
    await setViaFormulaBar(window, 2, 0, '=2+', [0, 0])
    const errShown = await cellText(window, 2, 0)
    expect(errShown, 'broken formula should show #ERR').toBe('#ERR')
  } finally {
    await dispose()
  }
})

// ── SE-4: Number format ───────────────────────────────────────────────────────

test('SE-4 — number format: select Currency from sheet-number-format; cell displays $1,234.00', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Put 1234 in A1
    await setViaFormulaBar(window, 0, 0, '1234', [0, 1])

    // Click A1 to select it (focus must be there before applying format)
    await clickCell(window, 0, 0)
    await window.waitForTimeout(100)

    // NUMBER_FORMATS in cellsRibbon.tsx: index 3 = Currency ($), decimals 2. The
    // option is selected by VALUE, so the placeholder at the top of the list
    // does not shift the indices.
    const fmtSelect = window.locator('[data-testid="sheet-number-format"]')
    await fmtSelect.selectOption('3')
    await window.waitForTimeout(200)

    const shown = await cellText(window, 0, 0)
    // formatValue for { kind: 'currency', decimals: 2, symbol: '$' } of 1234 → "$1,234.00"
    expect(shown, 'currency format should show $1,234.00').toMatch(/^\$1[,.]?234\.00$/)
  } finally {
    await dispose()
  }
})

// ── SE-5: Cell formatting (bold) + format persistence ────────────────────────

test('SE-5 — bold a cell via toolbar; rendered fontWeight is bold and body.formats persists', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Put a value in A1 so we can see it
    await setViaFormulaBar(window, 0, 0, 'BoldTest', [0, 1])

    // Select A1 then click Bold in the toolbar
    await clickCell(window, 0, 0)
    await window.locator('[data-testid="sheet-toolbar"]').getByRole('button', { name: /Bold/i }).click()
    await window.waitForTimeout(200)

    // The cell's display div should have font-weight: 700 (bold)
    const cell = window.locator('[data-testid="cell-0-0"]')
    const fontWeight = await cell.locator('div').first().evaluate(
      (el) => window.getComputedStyle(el).fontWeight
    )
    expect(fontWeight, 'cell should be bold (fontWeight 700)').toBe('700')

    // Wait for autosave
    await window.waitForTimeout(1_500)

    // Verify body.formats['0,0'].bold === true
    const stored = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const docs = await api.documents.list()
      const doc = await api.documents.get(docs[0].id)
      return doc?.body
    })
    const body = stored as { version: number; sheets: Array<{ formats?: Record<string, { bold?: boolean }> }> }
    expect(body.sheets[0].formats?.['0,0']?.bold, 'bold format persisted to body.formats').toBe(true)
  } finally {
    await dispose()
  }
})

// ── SE-6: Structural ops (insert row + column) ────────────────────────────────

test('SE-6 — insert row and column; grid dimensions change and persist', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Mark A1 so we can tell the insert happened
    await setViaFormulaBar(window, 0, 0, 'Marker', [0, 1])

    // Read the initial row count (emptyTab default = 12 rows, 4 cols)
    const initialRowCount = await window.locator('[data-testid="sheet-grid"] tbody tr').count()
    const initialColCount = await window.locator('[data-testid="sheet-grid"] thead th').count()
    // thead has: row-number-th + col-headers; count = 1 + numColumns
    const initialDataCols = initialColCount - 1

    // Select A1, insert a row above it
    await clickCell(window, 0, 0)
    await selectBarTab(window, 'sheet-toolbar', 'insert')
    await window.locator('[data-testid="sheet-toolbar"]').getByRole('button', { name: /Insert row above/i }).click()
    await window.waitForTimeout(200)

    const rowsAfterInsert = await window.locator('[data-testid="sheet-grid"] tbody tr').count()
    expect(rowsAfterInsert, 'row count should increase by 1').toBe(initialRowCount + 1)

    // The old A1 "Marker" should now be at A2 (r=1) since a row was inserted above
    const markerCell = await cellText(window, 1, 0)
    expect(markerCell, '"Marker" shifted to row 2 (index 1) after row insert').toBe('Marker')

    // Now insert a column at the current selection (still at 0,0 logical, but row insert
    // put focus still at 0,0); select the original Marker cell to anchor correctly
    await clickCell(window, 0, 0)
    await selectBarTab(window, 'sheet-toolbar', 'insert')
    await window.locator('[data-testid="sheet-toolbar"]').getByRole('button', { name: /Insert column left/i }).click()
    await window.waitForTimeout(200)

    const colsAfterInsert = (await window.locator('[data-testid="sheet-grid"] thead th').count()) - 1
    expect(colsAfterInsert, 'column count should increase by 1').toBe(initialDataCols + 1)

    // Wait for autosave then verify shape persists
    await window.waitForTimeout(1_500)
    const stored = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const docs = await api.documents.list()
      const doc = await api.documents.get(docs[0].id)
      return doc?.body
    })
    const body = stored as { version: number; sheets: Array<{ rows: string[][]; columns: string[] }> }
    expect(body.sheets[0].rows.length, 'persisted row count increased').toBe(initialRowCount + 1)
    expect(body.sheets[0].columns.length, 'persisted column count increased').toBe(initialDataCols + 1)
  } finally {
    await dispose()
  }
})

// ── SE-7: Undo / redo ─────────────────────────────────────────────────────────

test('SE-7 — undo reverts an edit; redo reapplies it', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Enter a value
    await setViaFormulaBar(window, 0, 0, 'Original', [0, 1])
    let shown = await cellText(window, 0, 0)
    expect(shown, 'value entered').toBe('Original')

    // Enter a second value to create an undo-able step
    await setViaFormulaBar(window, 0, 0, 'Edited', [0, 1])
    shown = await cellText(window, 0, 0)
    expect(shown, 'value changed to Edited').toBe('Edited')

    // Focus the grid wrapper (the tabIndex=0 div that wraps SheetGrid and owns keydown).
    // sheet-grid is the direct child of that div, so the locator going one level up ('..')
    // IS the wrapper; click it directly to give it focus.
    const gridWrap = window.locator('[data-testid="sheet-grid"]').locator('..')
    await gridWrap.click()
    await window.waitForTimeout(100)

    // Undo with Cmd+Z / Ctrl+Z
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await window.keyboard.press(`${mod}+z`)
    await window.waitForTimeout(200)

    // Focus moved — re-check cell text (it may have reverted)
    // After undo the cell content should revert; click cell to read display
    const afterUndo = await cellText(window, 0, 0)
    expect(afterUndo, 'undo should revert to Original').toBe('Original')

    // Redo
    await gridWrap.click()
    await window.keyboard.press(`${mod}+z`)
    // Check redo via toolbar Redo button — some state may be tricky to reach via
    // keyboard after clicking the gridWrap. Use the toolbar Redo button instead.
    // First undo again to get back to "Original" so redo can fire.
    // Actually let us just verify redo via toolbar button:
    // We are now at "Original" (after one undo). Click Redo button.
    const redoBtn = window.locator('[data-testid="sheet-toolbar"]').getByRole('button', { name: /Redo/i })
    // The redo button is enabled only if there's something to redo. After one
    // undo from "Edited→Original", redo should re-apply "Edited".
    // But we then pressed Ctrl+Z a second time above — that undid "Original" to
    // the blank-cell state. Let us just test via the toolbar buttons from a
    // clean sequence: set value, then undo, then redo.
    // Re-enter a known value to have a clean undo stack:
    await setViaFormulaBar(window, 1, 0, 'RedoTest', [0, 0])
    shown = await cellText(window, 1, 0)
    expect(shown, 'RedoTest entered').toBe('RedoTest')

    // Undo via toolbar
    const undoBtn = window.locator('[data-testid="sheet-toolbar"]').getByRole('button', { name: /Undo/i })
    await undoBtn.click()
    await window.waitForTimeout(200)
    const afterUndoBtn = await cellText(window, 1, 0)
    expect(afterUndoBtn, 'undo via toolbar clears the cell').toBe('')

    // Redo via toolbar
    await redoBtn.click()
    await window.waitForTimeout(200)
    const afterRedoBtn = await cellText(window, 1, 0)
    expect(afterRedoBtn, 'redo via toolbar restores RedoTest').toBe('RedoTest')
  } finally {
    await dispose()
  }
})

// ── SE-8: Keyboard navigation ─────────────────────────────────────────────────

test('SE-8 — arrow keys move the active cell; typing starts inline edit', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Click cell (0,0) first — this fires onCellMouseDown which both sets the
    // selection (anchor/focus = 0,0) AND calls focusGrid() internally, which gives
    // keyboard focus to the grid wrapper. No need to click the wrapper separately.
    await clickCell(window, 0, 0)
    await window.waitForTimeout(100)

    // Arrow down should move focus to row 1, col 0.
    // The address display span is the <span> that sits just before the formula bar input.
    await window.keyboard.press('ArrowDown')
    await window.waitForTimeout(150)

    const addrAfterDown = await window.evaluate(() => {
      const inp = document.querySelector('input[placeholder*="Select a cell"]')
      const span = inp?.previousElementSibling
      return span?.textContent?.trim() ?? ''
    })
    expect(addrAfterDown, 'after ArrowDown focus is on A2').toBe('A2')

    // Arrow right should move to col 1 (B2)
    await window.keyboard.press('ArrowRight')
    await window.waitForTimeout(150)

    const addrAfterRight = await window.evaluate(() => {
      const inp = document.querySelector('input[placeholder*="Select a cell"]')
      const span = inp?.previousElementSibling
      return span?.textContent?.trim() ?? ''
    })
    expect(addrAfterRight, 'after ArrowRight focus is on B2').toBe('B2')

    // Type a printable character — this should start inline editing on the active cell.
    // The grid wrapper's onKeyDown handler calls startEdit(focus, e.key) for printable
    // keys, seeding the edit value with that key. The key may also be received by the
    // newly-focused inline input, so the value may be 'X' or 'XX' depending on event
    // propagation timing. We assert only that the inline input appeared and contains 'X'.
    await window.keyboard.press('X')
    await window.waitForTimeout(150)
    // cell-1-1 is the current active cell (row 1, col 1 = B2)
    const activeCell = window.locator('[data-testid="cell-1-1"]')
    const inlineInput = activeCell.locator('input')
    await expect(inlineInput, 'typing starts inline edit').toBeVisible({ timeout: 3_000 })
    const inlineVal = await inlineInput.inputValue()
    expect(inlineVal, 'inline input contains the typed key').toMatch(/^X/)

    // Escape cancels the inline edit
    await window.keyboard.press('Escape')
    await expect(inlineInput, 'Escape cancels inline edit').not.toBeVisible({ timeout: 2_000 })
  } finally {
    await dispose()
  }
})

// ── SE-9: Charts ──────────────────────────────────────────────────────────────

test('SE-9 — select a range, insert bar chart, sheet-chart node renders', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Seed a small numeric range: A1=10, A2=20, A3=30
    await setViaFormulaBar(window, 0, 0, '10', [0, 1])
    await setViaFormulaBar(window, 1, 0, '20', [0, 1])
    await setViaFormulaBar(window, 2, 0, '30', [0, 1])

    // Select A1 (click), then shift-click A3 to extend selection to rows 0-2, col 0
    await clickCell(window, 0, 0)
    await window.locator('[data-testid="cell-2-0"]').click({ modifiers: ['Shift'] })
    await window.waitForTimeout(100)

    // Click Insert chart button → menu appears
    const toolbar = window.locator('[data-testid="sheet-toolbar"]')
    await selectBarTab(window, 'sheet-toolbar', 'insert')
    await toolbar.getByRole('button', { name: /Insert chart/i }).click()
    await expect(window.locator('text=bar chart')).toBeVisible({ timeout: 3_000 })

    // Click "bar chart"
    await window.locator('text=bar chart').click()
    await window.waitForTimeout(300)

    // The sheet-chart container should now be visible
    await expect(window.locator('[data-testid="sheet-chart"]')).toBeVisible({ timeout: 5_000 })

    // recharts renders SVG; at least one svg element should be inside sheet-chart
    const svgCount = await window.locator('[data-testid="sheet-chart"] svg').count()
    expect(svgCount, 'recharts should render at least one SVG').toBeGreaterThan(0)
  } finally {
    await dispose()
  }
})

// ── SE-10: Tabs ───────────────────────────────────────────────────────────────

test('SE-10 — add tab, switch, rename, delete; body.sheets length changes and persists', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    const tabStrip = window.locator('[data-testid="sheet-tab-strip"]')

    // Initial state: 1 tab named "Sheet 1"
    await expect(tabStrip.locator('text=Sheet 1')).toBeVisible()

    // Add a sheet via the "+" button
    await tabStrip.getByTitle('Add sheet').click()
    await window.waitForTimeout(200)

    // "Sheet 2" tab should appear
    await expect(tabStrip.locator('text=Sheet 2')).toBeVisible({ timeout: 3_000 })

    // Switch to Sheet 2
    await tabStrip.locator('text=Sheet 2').click()
    await window.waitForTimeout(150)

    // Enter a value specific to Sheet 2 so we can confirm we are on the right tab
    await setViaFormulaBar(window, 0, 0, 'Sheet2Data', [0, 1])
    const tab2Cell = await cellText(window, 0, 0)
    expect(tab2Cell, 'Sheet 2 has its own data').toBe('Sheet2Data')

    // Switch back to Sheet 1 — the cell should be blank
    await tabStrip.locator('text=Sheet 1').click()
    await window.waitForTimeout(150)
    const tab1Cell = await cellText(window, 0, 0)
    expect(tab1Cell, 'Sheet 1 A1 is independent (blank)').toBe('')

    // Rename Sheet 2 via double-click
    await tabStrip.locator('text=Sheet 2').dblclick()
    await window.waitForTimeout(100)
    const renameInput = tabStrip.locator('input')
    await renameInput.fill('Renamed')
    await renameInput.press('Enter')
    await window.waitForTimeout(200)
    await expect(tabStrip.locator('text=Renamed')).toBeVisible({ timeout: 3_000 })

    // Wait for autosave and verify persistence
    await window.waitForTimeout(1_500)
    const storedBeforeDelete = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const docs = await api.documents.list()
      const doc = await api.documents.get(docs[0].id)
      return doc?.body
    })
    const b1 = storedBeforeDelete as { version: number; sheets: Array<{ name: string }> }
    expect(b1.sheets.length, '2 sheets persisted').toBe(2)
    expect(b1.sheets.find((s) => s.name === 'Renamed'), '"Renamed" tab in persisted body').toBeTruthy()

    // Delete "Renamed" tab. The tab is a div whose child span text is "Renamed".
    // The delete button (title="Delete sheet") is also inside that same div.
    // Use JS to find the delete button inside the tab containing "Renamed" and click it,
    // which avoids CSS visibility issues with the hover-only opacity class.
    await window.evaluate(() => {
      const strip = document.querySelector('[data-testid="sheet-tab-strip"]')
      if (!strip) throw new Error('tab strip not found')
      // Find the div that has a span child with exact text "Renamed"
      const tabs = Array.from(strip.querySelectorAll('div'))
      const renamedTab = tabs.find((d) => {
        const spans = Array.from(d.querySelectorAll('span'))
        return spans.some((s) => s.textContent?.trim() === 'Renamed')
      })
      if (!renamedTab) throw new Error('Renamed tab not found')
      const btn = renamedTab.querySelector('button[title="Delete sheet"]') as HTMLButtonElement | null
      if (!btn) throw new Error('Delete sheet button not found in Renamed tab')
      btn.click()
    })
    await window.waitForTimeout(200)

    await expect(tabStrip.locator('text=Renamed')).not.toBeVisible({ timeout: 3_000 })

    // Wait for autosave and verify only 1 sheet remains
    await window.waitForTimeout(1_500)
    const storedAfterDelete = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const docs = await api.documents.list()
      const doc = await api.documents.get(docs[0].id)
      return doc?.body
    })
    const b2 = storedAfterDelete as { version: number; sheets: Array<{ name: string }> }
    expect(b2.sheets.length, '1 sheet persisted after delete').toBe(1)
  } finally {
    await dispose()
  }
})

// ── SE-11: xlsx interop (stubbed) ─────────────────────────────────────────────

test('SE-11 — sheet:import stub loads a SheetBodyV2; export stub shows path in sheet-status', async () => {
  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Build a fixed SheetBodyV2 to inject via the import stub
    const fakeBody = {
      version: 2,
      sheets: [
        {
          id: 'st-test-1',
          name: 'ImportedSheet',
          columns: ['Product', 'Revenue'],
          rows: [
            ['Sprocket', '1200'],
            ['Widget', '450']
          ]
        }
      ],
      activeSheet: 0
    }

    await stubSheetImport(app, fakeBody, 'products.xlsx')

    // Open the IO menu and click Import
    const toolbar = window.locator('[data-testid="sheet-toolbar"]')
    await selectBarTab(window, 'sheet-toolbar', 'tools')
    await toolbar.getByRole('button', { name: /Import \.xlsx \/ \.csv/i }).click()
    await window.waitForTimeout(400)

    // The grid should now show "Sprocket" in cell (0,0)
    const shownA1 = await cellText(window, 0, 0)
    expect(shownA1, 'imported cell A1 = Sprocket').toBe('Sprocket')

    // Cell (0,1) should show "1200" (or "Revenue" if header row is treated as row 0)
    // The body has no header row concept — columns are ['Product','Revenue'] and the
    // rows start at index 0 with data, so row 0 col 0 = 'Sprocket', row 0 col 1 = '1200'.
    const shownB1 = await cellText(window, 0, 1)
    expect(shownB1, 'imported cell B1 = 1200').toBe('1200')

    // The status bar should show the import name
    await expect(window.locator('[data-testid="sheet-status"]')).toContainText('products.xlsx', {
      timeout: 3_000
    })

    // Now stub export and trigger it
    const fakePath = '/tmp/sheet-export.xlsx'
    await stubSheetExport(app, fakePath)

    // Dismiss the import status so we can read the export status cleanly
    await window.locator('[data-testid="sheet-status"] button').click()
    await expect(window.locator('[data-testid="sheet-status"]')).not.toBeVisible({ timeout: 2_000 })

    // Open IO menu and export
    await selectBarTab(window, 'sheet-toolbar', 'tools')
    await toolbar.getByRole('button', { name: /Export \.xlsx/i }).click()
    await window.waitForTimeout(300)

    // Status should show the saved path
    await expect(window.locator('[data-testid="sheet-status"]')).toContainText(fakePath, {
      timeout: 5_000
    })
  } finally {
    await dispose()
  }
})

// ── SE-12: AI fill (stubbed) ──────────────────────────────────────────────────

test('SE-12 — AI two-step: suggest columns → create them → generate rows → Apply writes matrix', async () => {
  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Stub BOTH steps before opening the panel: step 1 columns, step 2 rows.
    const fakeColumns = ['Company', 'ARR', 'Commission']
    const fakeMatrix = [
      ['Acme Corp', '500000', '=B1*0.1'],
      ['Beta LLC', '250000', '=B2*0.1'],
      ['Gamma Inc', '750000', '=B3*0.1']
    ]
    await stubAiColumns(app, fakeColumns)
    await stubAiFill(app, fakeMatrix)

    // Anchor the selection at A1.
    await clickCell(window, 0, 0)
    await window.waitForTimeout(100)

    // Open AI panel via toolbar button (the "AI fill" button)
    const toolbar = window.locator('[data-testid="sheet-toolbar"]')
    const aiFillBtn = toolbar.locator('button', { hasText: /AI fill/i })
    await aiFillBtn.click()
    await expect(window.locator('[data-testid="sheet-ai-fill"]')).toBeVisible({ timeout: 3_000 })

    const aiPanel = window.locator('[data-testid="sheet-ai-fill"]')
    await aiPanel.locator('textarea').fill('SaaS companies with ARR and 10% commission')

    // Step 1: suggest columns, then create them.
    await aiPanel.getByRole('button', { name: /Suggest columns/i }).click()
    await expect(window.locator('[data-testid="sheet-ai-columns"]')).toBeVisible({ timeout: 5_000 })
    await window.locator('[data-testid="sheet-ai-create-columns"]').click()
    await window.waitForTimeout(200)

    // Columns are written into the header row.
    expect(await columnName(window, 0), 'col A name').toBe('Company')
    expect(await columnName(window, 1), 'col B name').toBe('ARR')
    expect(await columnName(window, 2), 'col C name').toBe('Commission')

    // Step 2: the active headers are shown; the row mode defaults to "as many
    // as needed" (auto), so no fixed-count input is shown by default.
    await expect(window.locator('[data-testid="sheet-ai-active-headers"]')).toContainText('Company')
    await expect(window.locator('[data-testid="sheet-ai-row-mode"]')).toBeVisible()
    await expect(aiPanel.locator('input[type="number"]')).toHaveCount(0)
    await aiPanel.getByRole('button', { name: /Generate rows/i }).click()

    const previewTable = aiPanel.locator('table')
    await expect(previewTable).toBeVisible({ timeout: 5_000 })
    await expect(previewTable).toContainText('Acme Corp')

    // Apply via data-testid="sheet-ai-apply"
    await window.locator('[data-testid="sheet-ai-apply"]').click()
    await window.waitForTimeout(300)

    // Panel should close
    await expect(window.locator('[data-testid="sheet-ai-fill"]')).not.toBeVisible({ timeout: 3_000 })

    // The matrix should be written starting at the selection anchor (row 0, col 0)
    expect(await cellText(window, 0, 0), 'A1 = Acme Corp').toBe('Acme Corp')
    expect(await cellText(window, 0, 1), 'B1 = 500000').toBe('500000')
    expect(await cellText(window, 1, 0), 'A2 = Beta LLC').toBe('Beta LLC')
  } finally {
    await dispose()
  }
})

// ── SE-13: Backward compat (v1 body) ──────────────────────────────────────────

test('SE-13 — backward compat: legacy v1 sheet body normalizes and renders', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)

    // Create a doc with a v1 body directly via the API
    const legacyV1Body = {
      columns: ['Name', 'Score'],
      rows: [
        ['Alice', '95'],
        ['Bob', '87']
      ]
    }
    await window.evaluate(async (body: object) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.documents.create({
        docType: 'sheet',
        title: 'Legacy v1 Sheet',
        body
      })
    }, legacyV1Body)

    // Reload and navigate back so Recent refreshes
    await window.reload()
    await waitForReady(window)
    await openDocumentsHub(window)

    // The recent list should have "Legacy v1 Sheet"
    await expect(window.locator('text=Legacy v1 Sheet').first()).toBeVisible({ timeout: 5_000 })
    await window.locator('text=Legacy v1 Sheet').first().click()

    // Wait for the sheet editor to mount
    await expect(window.locator('input[placeholder*="Select a cell"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible()

    // After normalization the v1 data should be at cell (0,0)="Alice", (0,1)="95"
    const cellA1 = await cellText(window, 0, 0)
    expect(cellA1, 'v1 row[0][0] lifted to A1').toBe('Alice')

    const cellB1 = await cellText(window, 0, 1)
    expect(cellB1, 'v1 row[0][1] lifted to B1').toBe('95')

    // The tab strip should show "Sheet 1" (the default name normalizeBody assigns)
    await expect(
      window.locator('[data-testid="sheet-tab-strip"]').locator('text=Sheet 1')
    ).toBeVisible()
  } finally {
    await dispose()
  }
})

// ── SE-14: Ctrl+D fills down with relative formula references ──────────────────

test('SE-14 — Ctrl+D copies the top cell down, shifting relative references', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 1, '10') // B1
    await setViaFormulaBar(window, 1, 1, '20') // B2
    await setViaFormulaBar(window, 0, 2, '=B1*2') // C1 -> 20

    // Select C1:C2 then Ctrl+D.
    await clickCell(window, 0, 2)
    await window.locator('[data-testid="cell-1-2"]').click({ modifiers: ['Shift'] })
    await window.keyboard.press('Control+d')
    await window.waitForTimeout(150)

    // C2 should be =B2*2 -> 40 (relative shift), not a copy of 20.
    expect(await cellText(window, 1, 2), 'C2 = =B2*2 = 40').toBe('40')
  } finally {
    await dispose()
  }
})

// ── SE-15: Ctrl+Enter fills the selection with the active cell's content ───────

test('SE-15 — Ctrl+Enter fills the whole selection from the active cell', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, 'hi') // A1
    // Anchor at A3, extend focus up to A1 so the ACTIVE cell (focus) is A1 = "hi".
    await clickCell(window, 2, 0)
    await window.locator('[data-testid="cell-0-0"]').click({ modifiers: ['Shift'] })
    await window.keyboard.press('Control+Enter')
    await window.waitForTimeout(150)

    expect(await cellText(window, 1, 0), 'A2 filled').toBe('hi')
    expect(await cellText(window, 2, 0), 'A3 filled').toBe('hi')
  } finally {
    await dispose()
  }
})

// ── SE-16: double-click the fill handle fills to the end of the neighbour data ─

test('SE-16 — double-click fill handle extends a formula to the neighbour data extent', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, 'x') // A1
    await setViaFormulaBar(window, 1, 0, 'y') // A2
    await setViaFormulaBar(window, 2, 0, 'z') // A3
    await setViaFormulaBar(window, 0, 1, '=A1') // B1 -> x

    await clickCell(window, 0, 1) // select B1; fill handle appears on it
    await window.locator('[data-testid="sheet-fill-handle"]').dblclick()
    await window.waitForTimeout(150)

    expect(await cellText(window, 1, 1), 'B2 = =A2 = y').toBe('y')
    expect(await cellText(window, 2, 1), 'B3 = =A3 = z').toBe('z')
  } finally {
    await dispose()
  }
})

// ── SE-17: drag the fill handle to extrapolate a numeric series ────────────────

test('SE-17 — dragging the fill handle extends a numeric series; toggle to copy', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, '1') // A1
    await setViaFormulaBar(window, 1, 0, '2') // A2
    await clickCell(window, 0, 0)
    await window.locator('[data-testid="cell-1-0"]').click({ modifiers: ['Shift'] }) // select A1:A2

    const handle = window.locator('[data-testid="sheet-fill-handle"]')
    const hb = await handle.boundingBox()
    const target = window.locator('[data-testid="cell-3-0"]')
    const tb = await target.boundingBox()
    if (!hb || !tb) throw new Error('missing bounding boxes')
    await window.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await window.mouse.down()
    await window.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 })
    await window.mouse.up()
    await window.waitForTimeout(150)

    expect(await cellText(window, 2, 0), 'A3 = 3 (series)').toBe('3')
    expect(await cellText(window, 3, 0), 'A4 = 4 (series)').toBe('4')

    // Auto-fill options offer a switch to copy.
    await expect(window.locator('[data-testid="sheet-fill-options"]')).toBeVisible()
    await window.locator('[data-testid="sheet-fill-options"]').getByText(/Switch to copy/i).click()
    await window.waitForTimeout(150)
    expect(await cellText(window, 2, 0), 'A3 = 2 (copy of last)').toBe('2')
    expect(await cellText(window, 3, 0), 'A4 = 2 (copy of last)').toBe('2')
  } finally {
    await dispose()
  }
})

// ── SE-18: AI formula assistant (stubbed) writes a formula + adds a column ─────

test('SE-18 — formula assistant: stub suggestFormula; preview, Apply writes formula and adds column', async () => {
  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await stubAiFormula(app, {
      ok: true,
      formula: '=B1+C1',
      explanation: 'Adds B1 and C1.',
      columnsToAdd: ['Total']
    })

    // Active cell defaults to A1. Open the assistant from the formula bar.
    await window.locator('[data-testid="sheet-formula-ai-btn"]').click()
    await expect(window.locator('[data-testid="sheet-formula-assist"]')).toBeVisible({ timeout: 3_000 })

    const panel = window.locator('[data-testid="sheet-formula-assist"]')
    await panel.locator('textarea').fill('add the two numbers')
    await panel.getByRole('button', { name: /Suggest formula/i }).click()
    await expect(window.locator('[data-testid="sheet-formula-preview"]')).toContainText('=B1+C1', {
      timeout: 5_000
    })

    await window.locator('[data-testid="sheet-formula-apply"]').click()
    await window.waitForTimeout(200)

    // A1 holds =B1+C1; B1 and C1 are empty so it computes to 0.
    expect(await cellText(window, 0, 0), 'A1 computed').toBe('0')
    // A new "Total" column was appended as the last column.
    const lastCol = (await window.locator('[data-testid="sheet-grid"] thead th').count()) - 2
    expect(await columnName(window, lastCol), 'new Total column').toBe('Total')
  } finally {
    await dispose()
  }
})

// ── SE-19: Conditional formatting paints a matching cell ──────────────────────

test('SE-19 — conditional formatting "greater than 100" paints A1 but not A2', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // A1 = 150 (matches "> 100"); A2 = 50 (does not).
    await setViaFormulaBar(window, 0, 0, '150')
    await setViaFormulaBar(window, 1, 0, '50')

    // Select A1 so the rule's range is A1:A1, then open the dialog.
    await clickCell(window, 0, 0)
    await selectBarTab(window, 'sheet-toolbar', 'data')
    await window.locator('[data-testid="sheet-condformat-btn"]').click()
    await expect(window.locator('[data-testid="sheet-condformat-dialog"]')).toBeVisible({ timeout: 3_000 })

    // Default op is "Greater than"; set the value and add the rule (default fill swatch).
    await window.locator('[data-testid="condformat-value"]').fill('100')
    await window.locator('[data-testid="condformat-add"]').click()
    await window.waitForTimeout(200)

    // The rule paints A1 with the default swatch (#fee2e2 = rgb(254,226,226)) and
    // leaves A2 unpainted. Computed style is readable beneath the open dialog.
    const bgA1 = await window
      .locator('[data-testid="cell-0-0"] div.whitespace-pre-wrap')
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bgA1).toBe('rgb(254, 226, 226)')
    const bgA2 = await window
      .locator('[data-testid="cell-1-0"] div.whitespace-pre-wrap')
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bgA2).toBe('rgba(0, 0, 0, 0)')
  } finally {
    await dispose()
  }
})

// ── SE-20: Data validation — list dropdown sets a value; strict rejects invalid ─

test('SE-20 — data validation list dropdown sets a value and strict mode rejects invalid input', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Define a strict list validation on B1 (Open / Done).
    await clickCell(window, 0, 1)
    await selectBarTab(window, 'sheet-toolbar', 'data')
    await window.locator('[data-testid="sheet-validation-btn"]').click()
    await expect(window.locator('[data-testid="sheet-validation-dialog"]')).toBeVisible({ timeout: 3_000 })
    await window.locator('[data-testid="validation-list"]').fill('Open, Done')
    await window.locator('[data-testid="validation-add"]').click()
    await window.locator('[data-testid="sheet-validation-dialog"] button[aria-label="Close"]').click()
    await window.locator('[data-testid="sheet-validation-dialog"]').waitFor({ state: 'detached', timeout: 2_000 })

    // The in-cell dropdown appears on B1; pick "Open".
    await window.locator('[data-testid="cell-list-0-1"]').click()
    await window.locator('[data-testid="cell-list-opt-0-1-Open"]').click()
    await window.waitForTimeout(150)
    expect(await cellText(window, 0, 1), 'B1 set via dropdown').toBe('Open')

    // Strict mode: typing an invalid value inline is rejected; B1 keeps "Open".
    await window.locator('[data-testid="cell-0-1"]').dblclick()
    await window.keyboard.type('Nope')
    await window.keyboard.press('Enter')
    await window.waitForTimeout(150)
    await expect(window.locator('[data-testid="sheet-status"]')).toContainText('not allowed', { timeout: 3_000 })
    expect(await cellText(window, 0, 1), 'B1 unchanged after rejected entry').toBe('Open')
  } finally {
    await dispose()
  }
})

// ── SE-21: Cross-sheet references resolve in the live editor ──────────────────

test('SE-21 — a formula on Sheet 1 reads a value from Sheet 2', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    const tabStrip = window.locator('[data-testid="sheet-tab-strip"]')
    await tabStrip.getByTitle('Add sheet').click()
    await expect(tabStrip.locator('text=Sheet 2')).toBeVisible({ timeout: 3_000 })

    // Put 100 in Sheet 2 A1.
    await tabStrip.locator('text=Sheet 2').click()
    await window.waitForTimeout(150)
    await setViaFormulaBar(window, 0, 0, '100', [1, 0])

    // Back on Sheet 1, reference it (the tab name has a space, so it is quoted).
    await tabStrip.locator('text=Sheet 1').click()
    await window.waitForTimeout(150)
    await setViaFormulaBar(window, 0, 0, "='Sheet 2'!A1+5", [1, 0])

    expect(await cellText(window, 0, 0), "Sheet1 A1 = 'Sheet 2'!A1 + 5 = 105").toBe('105')
  } finally {
    await dispose()
  }
})

// ── SE-22: Column filter hides rows by value ──────────────────────────────────

test('SE-22 — create a filter, uncheck a value, matching rows are hidden', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, 'apple')
    await setViaFormulaBar(window, 1, 0, 'banana')
    await setViaFormulaBar(window, 2, 0, 'apple', [3, 0])

    // Turn on filtering; funnels appear on headers.
    await selectBarTab(window, 'sheet-toolbar', 'data')
    await window.locator('[data-testid="sheet-filter-btn"]').click()
    await expect(window.locator('[data-testid="col-filter-0"]')).toBeVisible({ timeout: 3_000 })

    // Open column A's funnel and uncheck "apple".
    await window.locator('[data-testid="col-filter-0"]').click()
    await expect(window.locator('[data-testid="sheet-filter-dropdown"]')).toBeVisible({ timeout: 3_000 })
    await window
      .locator('[data-testid="sheet-filter-dropdown"] label', { hasText: 'apple' })
      .locator('input')
      .click()
    await window.waitForTimeout(200)

    // The two "apple" rows (0 and 2) are no longer rendered; "banana" (row 1) stays.
    await expect(window.locator('[data-testid="cell-0-0"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="cell-2-0"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="cell-1-0"]')).toBeVisible()
  } finally {
    await dispose()
  }
})

// ── SE-23: Pivot table summarises the selection ──────────────────────────────

test('SE-23 — pivot: sum a value column grouped by a row column', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // A: Dept, B: Amount.  Eng/100, Sales/90, Eng/50.
    await setViaFormulaBar(window, 0, 0, 'Dept')
    await setViaFormulaBar(window, 0, 1, 'Amount')
    await setViaFormulaBar(window, 1, 0, 'Eng')
    await setViaFormulaBar(window, 1, 1, '100')
    await setViaFormulaBar(window, 2, 0, 'Sales')
    await setViaFormulaBar(window, 2, 1, '90')
    await setViaFormulaBar(window, 3, 0, 'Eng')
    await setViaFormulaBar(window, 3, 1, '50', [0, 0])

    // Select A1:B4, open the pivot dialog (defaults: rows=A, values=B, sum).
    await clickCell(window, 0, 0)
    await window.locator('[data-testid="cell-3-1"]').click({ modifiers: ['Shift'] })
    await selectBarTab(window, 'sheet-toolbar', 'data')
    await window.locator('[data-testid="sheet-pivot-btn"]').click()
    await expect(window.locator('[data-testid="sheet-pivot-dialog"]')).toBeVisible({ timeout: 3_000 })
    await window.locator('[data-testid="pivot-create"]').click()

    // The pivot renders: Eng = 150, grand total 240.
    const pivot = window.locator('[data-testid="sheet-pivot"]')
    await expect(pivot).toBeVisible({ timeout: 5_000 })
    await expect(pivot).toContainText('Eng')
    await expect(pivot).toContainText('150')
    await expect(pivot).toContainText('240')
  } finally {
    await dispose()
  }
})

// ── SE-24: Pivot slicer hides a row-field value and re-aggregates ─────────────

test('SE-24 — pivot slicer: unchecking a value hides it and updates the total', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // A: Dept, B: Amount.  Eng/100, Sales/90, Eng/50.
    await setViaFormulaBar(window, 0, 0, 'Dept')
    await setViaFormulaBar(window, 0, 1, 'Amount')
    await setViaFormulaBar(window, 1, 0, 'Eng')
    await setViaFormulaBar(window, 1, 1, '100')
    await setViaFormulaBar(window, 2, 0, 'Sales')
    await setViaFormulaBar(window, 2, 1, '90')
    await setViaFormulaBar(window, 3, 0, 'Eng')
    await setViaFormulaBar(window, 3, 1, '50', [0, 0])

    await clickCell(window, 0, 0)
    await window.locator('[data-testid="cell-3-1"]').click({ modifiers: ['Shift'] })
    await selectBarTab(window, 'sheet-toolbar', 'data')
    await window.locator('[data-testid="sheet-pivot-btn"]').click()
    await expect(window.locator('[data-testid="sheet-pivot-dialog"]')).toBeVisible({ timeout: 3_000 })
    await window.locator('[data-testid="pivot-create"]').click()

    const pivot = window.locator('[data-testid="sheet-pivot"]')
    await expect(pivot).toBeVisible({ timeout: 5_000 })
    await expect(pivot).toContainText('240')

    // The slicer offers the two Dept values (rowField 0).
    const slicer = window.locator('[data-testid="sheet-pivot-slicer-0"]')
    await expect(slicer).toBeVisible({ timeout: 4_000 })
    await expect(slicer.locator('[data-testid="sheet-pivot-slicer-0-item"]')).toHaveCount(2)

    // Uncheck "Sales" — its row disappears and the grand total drops to Eng's 150.
    const salesRow = slicer.locator('[data-testid="sheet-pivot-slicer-0-item"]', { hasText: 'Sales' })
    await salesRow.locator('input[type="checkbox"]').uncheck()

    await expect(pivot.locator('tbody')).not.toContainText('Sales')
    await expect(pivot).toContainText('150')
    await expect(pivot).not.toContainText('240')
  } finally {
    await dispose()
  }
})

test('SE-19 — array formula spills: =SEQUENCE(3,1) fills the cells below', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // Anchor A1; blur to a real, non-target empty cell so the spill stays clear.
    await setViaFormulaBar(window, 0, 0, '=SEQUENCE(3,1)', [7, 2])

    expect(await cellText(window, 0, 0)).toBe('1')
    expect(await cellText(window, 1, 0)).toBe('2')
    expect(await cellText(window, 2, 0)).toBe('3')

    await expect(window.locator('[data-testid="cell-1-0"]')).toHaveAttribute('data-spill', '1')
    await expect(window.locator('[data-testid="cell-2-0"]')).toHaveAttribute('data-spill', '1')
  } finally {
    await dispose()
  }
})

test('SE-20 — named ranges: define a name and use it in a formula', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // A1 = 10.
    await setViaFormulaBar(window, 0, 0, '10', [7, 2])

    // Open the Names panel and define Tax -> A1.
    await window.locator('[data-testid="sheet-names-toggle"]').click()
    await expect(window.locator('[data-testid="sheet-names-panel"]')).toBeVisible({ timeout: 3_000 })
    await window.locator('[data-testid="sheet-name-input"]').fill('Tax')
    await window.locator('[data-testid="sheet-ref-input"]').fill('A1')
    await window.locator('[data-testid="sheet-name-add"]').click()
    await expect(window.locator('[data-testid="sheet-name-row-Tax"]')).toBeVisible({ timeout: 3_000 })

    // B1 = =Tax*2 resolves through the named range to 20.
    await setViaFormulaBar(window, 0, 1, '=Tax*2', [7, 2])
    expect(await cellText(window, 0, 1)).toBe('20')
  } finally {
    await dispose()
  }
})
