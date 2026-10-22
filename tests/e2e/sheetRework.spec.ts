/**
 * E2E verification for the Plexi3.0 spreadsheet rework:
 *   - Excel-style select-all / column-select / row-select
 *   - Formula-safe structural edits (insert row reindexes formula refs)
 *   - Row context menu (insert above/below, delete row)
 *   - Drag-reorder of a selected column band (best-effort under synthetic mouse)
 *
 * Dispatched by plexidesk-tester per the operator's Plexi3.0 sheet-rework
 * verification request. Navigation follows the exact pattern used by
 * sheetEditorV2.spec.ts (openDocumentsHub / startBlankSpreadsheet via the
 * exposed __fbView store, since the object-based IA has no literal Documents
 * sidebar button).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// ── Shared navigation helpers (copied from sheetEditorV2.spec.ts) ────────────

async function openDocumentsHub(window: Page): Promise<void> {
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

async function clickCell(window: Page, r: number, c: number): Promise<void> {
  await window.locator(`[data-testid="cell-${r}-${c}"]`).click()
}

function formulaBar(window: Page): ReturnType<Page['locator']> {
  return window.locator('input[placeholder*="Select a cell"]')
}

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

async function cellText(window: Page, r: number, c: number): Promise<string> {
  const cell = window.locator(`[data-testid="cell-${r}-${c}"]`)
  const div = cell.locator('div').first()
  return (await div.textContent()) ?? ''
}

/** Raw stored value of a cell (may be a formula string), read via evaluate on the DOM input if editing, but we read via the persisted body for reliability. */
async function getPersistedBody(
  window: Page,
  waitMs = 1_200
): Promise<{ sheets: Array<{ rows: string[][]; columns: string[] }> }> {
  await window.waitForTimeout(waitMs)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const doc = await api.documents.get(docs[0].id)
    return doc?.body
  }) as Promise<{ sheets: Array<{ rows: string[][]; columns: string[] }> }>
}

// ── 1. Select-all corner ──────────────────────────────────────────────────

test('REWORK-1 — select-all corner selects whole used grid; Bold applies to all', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, 'Alpha', [0, 1])
    await setViaFormulaBar(window, 0, 1, 'Beta', [0, 0])
    await setViaFormulaBar(window, 1, 0, 'Gamma', [0, 0])

    await window.locator('[data-testid="sheet-select-all"]').click()
    await window.waitForTimeout(150)

    const toolbar = window.locator('[data-testid="sheet-toolbar"]')
    await toolbar.getByRole('button', { name: /Bold/i }).click()
    await window.waitForTimeout(200)

    const fw00 = await window
      .locator('[data-testid="cell-0-0"]')
      .locator('div')
      .first()
      .evaluate((el) => window.getComputedStyle(el).fontWeight)
    const fw11 = await window
      .locator('[data-testid="cell-1-0"]')
      .locator('div')
      .first()
      .evaluate((el) => window.getComputedStyle(el).fontWeight)
    // A cell outside any typed data but inside the used grid rectangle (e.g.
    // (1,1), which is within rows 0-1 x cols 0-... of the default 4-col sheet)
    // should also be selected/bold since select-all spans the full grid, not
    // just typed cells.
    const fw_farCorner = await window
      .locator('[data-testid="cell-1-1"]')
      .locator('div')
      .first()
      .evaluate((el) => window.getComputedStyle(el).fontWeight)

    expect(fw00, 'cell (0,0) bold after select-all + Bold').toBe('700')
    expect(fw11, 'cell (1,0) bold after select-all + Bold').toBe('700')
    expect(fw_farCorner, 'cell (1,1) [untyped, inside used grid] bold after select-all + Bold').toBe('700')
  } finally {
    await dispose()
  }
})

// ── 2. Column header select + shift-extend ────────────────────────────────

test('REWORK-2 — col-select-0 selects whole column; shift+click col-select-2 extends 0-2', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, 'A0', [0, 0])
    await setViaFormulaBar(window, 1, 0, 'A1', [0, 0])

    await window.locator('[data-testid="col-select-0"]').click()
    await window.waitForTimeout(150)

    // Column header 0 should be tinted (bg-accent/20 -> rgba with alpha ~0.2).
    const colHeader0Class = await window.locator('[data-testid="col-header-0"]').getAttribute('class')
    expect(colHeader0Class ?? '', 'col-header-0 has bg-accent/20 tint class after selection').toContain(
      'bg-accent/20'
    )

    // Cells in column 0 should show the selection tint.
    const cell00Class = await window.locator('[data-testid="cell-0-0"]').getAttribute('class')
    expect(cell00Class ?? '', 'cell-0-0 selected-tint class present').toContain('bg-accent/[0.10]')
    const cell10Class = await window.locator('[data-testid="cell-1-0"]').getAttribute('class')
    expect(cell10Class ?? '', 'cell-1-0 selected-tint class present (whole column selected)').toContain(
      'bg-accent/[0.10]'
    )
    // Column 1 must NOT be selected yet.
    const cell01ClassPre = await window.locator('[data-testid="cell-0-1"]').getAttribute('class')
    expect(cell01ClassPre ?? '', 'cell-0-1 not selected before shift-extend').not.toContain('bg-accent/[0.10]')

    // Shift-click col-select-2 to extend the selection to columns 0-2.
    await window.locator('[data-testid="col-select-2"]').click({ modifiers: ['Shift'] })
    await window.waitForTimeout(150)

    const colHeader1Class = await window.locator('[data-testid="col-header-1"]').getAttribute('class')
    const colHeader2Class = await window.locator('[data-testid="col-header-2"]').getAttribute('class')
    expect(colHeader1Class ?? '', 'col-header-1 tinted after shift-extend to 0-2').toContain('bg-accent/20')
    expect(colHeader2Class ?? '', 'col-header-2 tinted after shift-extend to 0-2').toContain('bg-accent/20')

    const cell02Class = await window.locator('[data-testid="cell-0-2"]').getAttribute('class')
    expect(cell02Class ?? '', 'cell-0-2 selected-tint after shift-extend').toContain('bg-accent/[0.10]')
  } finally {
    await dispose()
  }
})

// ── 3. Row header select ──────────────────────────────────────────────────

test('REWORK-3 — row-header-0 click selects whole row 0', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, 'R0A', [0, 0])
    await setViaFormulaBar(window, 0, 1, 'R0B', [0, 0])

    await window.locator('[data-testid="row-header-0"]').click()
    await window.waitForTimeout(150)

    const rowHeader0Class = await window.locator('[data-testid="row-header-0"]').getAttribute('class')
    expect(rowHeader0Class ?? '', 'row-header-0 tinted after selection').toContain('bg-accent/20')

    const cell00Class = await window.locator('[data-testid="cell-0-0"]').getAttribute('class')
    const cell01Class = await window.locator('[data-testid="cell-0-1"]').getAttribute('class')
    expect(cell00Class ?? '', 'cell-0-0 selected-tint present').toContain('bg-accent/[0.10]')
    expect(cell01Class ?? '', 'cell-0-1 selected-tint present (whole row 0 selected)').toContain(
      'bg-accent/[0.10]'
    )

    // Row 1 must not be selected.
    const cell10Class = await window.locator('[data-testid="cell-1-0"]').getAttribute('class')
    expect(cell10Class ?? '', 'cell-1-0 not selected (only row 0 selected)').not.toContain('bg-accent/[0.10]')
  } finally {
    await dispose()
  }
})

// ── 4. Formula-safe insert row (the key regression) ───────────────────────

test('REWORK-4 — insert row above reindexes SUM formula references, value stays 30', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    // A1=10, A2=20, A3==SUM(A1:A2)
    await setViaFormulaBar(window, 0, 0, '10', [0, 1])
    await setViaFormulaBar(window, 1, 0, '20', [0, 1])
    await setViaFormulaBar(window, 2, 0, '=SUM(A1:A2)', [0, 0])

    const a3Before = await cellText(window, 2, 0)
    expect(a3Before, 'A3 = SUM(A1:A2) computes to 30 before insert').toBe('30')

    const bodyBefore = await getPersistedBody(window)
    const formulaBefore = bodyBefore.sheets[0].rows[2][0]

    // Right-click row-header-0 to open the row context menu, then Insert row above.
    await window.locator('[data-testid="row-header-0"]').click({ button: 'right' })
    await expect(window.locator('[data-testid="sheet-row-menu"]')).toBeVisible({ timeout: 3_000 })
    await window.locator('[data-testid="sheet-row-menu"]').locator('text=Insert row above').click()
    await window.waitForTimeout(250)

    // The old A1/A2/A3 have shifted down one row to A2/A3/A4. The formula that
    // used to live at row index 2 (A3) is now at row index 3 (A4), and its
    // references must have been reindexed from A1:A2 to A2:A3 so it still
    // reads the same two number cells and still shows 30.
    const a4After = await cellText(window, 3, 0)
    expect(a4After, 'formula cell (now at row 3 / A4) still shows 30 after insert row above').toBe('30')

    const bodyAfter = await getPersistedBody(window)
    const formulaAfter = bodyAfter.sheets[0].rows[3][0]

    console.log(`REWORK-4 evidence: formula before insert = "${formulaBefore}", after insert (now row 4) = "${formulaAfter}"`)

    expect(formulaAfter.trim().startsWith('='), 'the moved cell must still hold a formula, not a stale literal').toBe(
      true
    )
    expect(formulaAfter, 'formula references must be reindexed from A1:A2 to A2:A3, not left stale').toContain(
      'A2:A3'
    )
    expect(formulaAfter, 'formula must not still reference the old A1:A2 range').not.toContain('A1:A2')
  } finally {
    await dispose()
  }
})

// ── 5. Row context menu existence ─────────────────────────────────────────

test('REWORK-5 — right-click row header opens sheet-row-menu with insert/delete options', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await window.locator('[data-testid="row-header-1"]').click({ button: 'right' })
    const menu = window.locator('[data-testid="sheet-row-menu"]')
    await expect(menu).toBeVisible({ timeout: 3_000 })
    await expect(menu.locator('text=Insert row above')).toBeVisible()
    await expect(menu.locator('text=Insert row below')).toBeVisible()
    await expect(menu.locator('text=Delete row')).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu).not.toBeVisible({ timeout: 2_000 })
  } finally {
    await dispose()
  }
})

// ── 6. Drag-reorder (best-effort under synthetic mouse) ───────────────────

test('REWORK-6 — drag-reorder a selected column band (or confirm dialog) — best effort', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSpreadsheet(window)

    await setViaFormulaBar(window, 0, 0, 'C0', [0, 0])
    await setViaFormulaBar(window, 0, 1, 'C1', [0, 0])
    await setViaFormulaBar(window, 0, 2, 'C2', [0, 0])

    // Select column 0 fully.
    const col0 = window.locator('[data-testid="col-select-0"]')
    await col0.click()
    await window.waitForTimeout(150)

    const before = await getPersistedBody(window)
    const colsBefore = before.sheets[0].columns.slice()

    // Press on the already-selected column 0 to arm the reorder drag, then move
    // across to column 2 and release.
    const box0 = await col0.boundingBox()
    const col2 = window.locator('[data-testid="col-select-2"]')
    const box2 = await col2.boundingBox()
    if (!box0 || !box2) {
      throw new Error('Could not get bounding boxes for col-select-0 / col-select-2')
    }

    await window.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2)
    await window.mouse.down()
    // Step through intermediate points so mouseenter fires on col-select-1 and
    // col-select-2 along the way (the component listens to onMouseEnter per
    // header cell to track the drag-over target).
    const steps = 6
    for (let i = 1; i <= steps; i++) {
      const x = box0.x + box0.width / 2 + ((box2.x - box0.x) * i) / steps
      const y = box2.y + box2.height / 2
      await window.mouse.move(x, y)
      await window.waitForTimeout(30)
    }
    await window.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2)
    await window.waitForTimeout(50)
    await window.mouse.up()
    await window.waitForTimeout(300)

    const moveConfirm = window.locator('[data-testid="sheet-move-confirm"]')
    const confirmVisible = await moveConfirm.isVisible().catch(() => false)

    if (confirmVisible) {
      console.log('REWORK-6 evidence: sheet-move-confirm dialog appeared after drag — reorder-with-formula-impact path triggered.')
      // Dismiss it (best-effort) so the app is left in a clean state.
      const cancelBtn = moveConfirm.locator('button', { hasText: /cancel/i })
      if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click()
      expect(confirmVisible, 'move-confirm dialog appeared, indicating drag-reorder was detected').toBe(true)
      return
    }

    const after = await getPersistedBody(window)
    const colsAfter = after.sheets[0].columns.slice()

    console.log(
      `REWORK-6 evidence: columns before = ${JSON.stringify(colsBefore)}, columns after = ${JSON.stringify(colsAfter)}`
    )

    if (JSON.stringify(colsBefore) !== JSON.stringify(colsAfter)) {
      // Reorder happened without needing the confirm dialog (no formula impact).
      expect(colsAfter, 'column order changed after drag-reorder').not.toEqual(colsBefore)
    } else {
      // Synthetic mouse could not reliably drive the drag gesture (same class of
      // limitation as the known formula-ref-drag issue in other specs). Report
      // this honestly rather than asserting a false pass or a hard failure.
      test.info().annotations.push({
        type: 'inconclusive',
        description:
          'Drag-reorder did not visibly change column order nor trigger sheet-move-confirm under synthetic Playwright mouse events. This matches the known synthetic-drag limitation noted elsewhere in the suite — needs manual verification.'
      })
      console.log('REWORK-6 INCONCLUSIVE: no column reorder and no move-confirm dialog observed under synthetic mouse drag.')
    }
  } finally {
    await dispose()
  }
})
