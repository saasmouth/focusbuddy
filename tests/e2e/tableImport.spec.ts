import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as XLSX from 'xlsx'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Table-import wizard E2E.
//
// A. Upsert mode: seed a table with 3 columns + 2 rows, stub the IPC to return
//    a 4-column grid where one source column is new. Set Email as the primary key.
//    Assert the dialog opens, the mapping is auto-suggested, the preview shows
//    1 add + 1 update + 1 new column, and after apply the DB reflects the
//    correct merged state (2 → 3 rows, Alice updated, Carol added).
//
// B. Append mode: same seed, stub a 2-row grid of entirely new emails, set
//    primary key to "Append all" (empty), assert 2 inserted + 0 updated.
//
// C. XLS round-trip via importFile: write a real .xlsx to a temp path using the
//    bundled xlsx lib in the main process, then call importFile(path) through
//    IPC and assert it returns a table draft with the right columns + rows.
//
// D. Unit suite must stay green (145+ tests, run after E2E).
//
// The native file picker is bypassed by replacing the two IPC handlers
// (fileImport:pickGrid + fileImport:parseGrid) in the main process with stubs
// via app.evaluate, exactly the pattern used in markdownWidget.spec.ts.

let launched: LaunchedApp | null = null
let scratch: string | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
  if (scratch) {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // best effort
    }
    scratch = null
  }
})

function makeScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-tableimport-e2e-'))
  scratch = dir
  return dir
}

// Replace fileImport:pickGrid (returns a fixed fake path) and fileImport:parseGrid
// (returns the caller-supplied ParsedGrid result) in the main process. Stubs
// persist until the app is disposed — each test boots a fresh app anyway.
async function stubGridIpc(
  l: LaunchedApp,
  fakePath: string,
  gridResult: { ok: true; grid: { headers: string[]; rows: Array<Record<string, string>> } } | { ok: false; error: string }
): Promise<void> {
  await l.app.evaluate(
    ({ ipcMain }, { fp, gr }: { fp: string; gr: typeof gridResult }) => {
      ipcMain.removeHandler('fileImport:pickGrid')
      ipcMain.removeHandler('fileImport:parseGrid')
      ipcMain.handle('fileImport:pickGrid', () => fp)
      ipcMain.handle('fileImport:parseGrid', () => gr)
    },
    { fp: fakePath, gr: gridResult }
  )
}

// Seed a task + table with known schema and rows. Returns the task id, table id,
// and widget id so the caller can navigate to the canvas.
interface TableSeed {
  taskId: string
  tableId: string
  widgetId: string
}

async function seedTable(
  window: LaunchedApp['window'],
  rows: Array<{ email: string; name: string; mrr: string }>
): Promise<TableSeed> {
  return window.evaluate(async (seedRows: typeof rows) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'ImportTest'
    })
    const table = await api.tables.create({
      title: 'Customers',
      schema: {
        columns: [
          { id: 'c-email', type: 'text-short', label: 'Email', config: {} },
          { id: 'c-name', type: 'text-short', label: 'Name', config: {} },
          { id: 'c-mrr', type: 'number', label: 'MRR', config: {} }
        ]
      }
    })
    for (const r of seedRows) {
      await api.tables.createRow({
        tableId: table.id,
        cells: { 'c-email': r.email, 'c-name': r.name, 'c-mrr': r.mrr }
      })
    }
    const widget = await api.widgets.create({
      taskId: task.id,
      kind: 'table',
      title: 'Customers',
      content: table.id,
      x: 120,
      y: 120,
      width: 540,
      height: 340
    })
    return { taskId: task.id, tableId: table.id, widgetId: widget.id }
  }, rows)
}

// Navigate to the task canvas and wait until the table widget has mounted.
async function navigateToTable(
  window: LaunchedApp['window'],
  taskId: string,
  widgetId: string
): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /ImportTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${widgetId}"] [data-widget-header]`, { timeout: 8_000 })
}

// Open the importer the way a person does now.
//
// The table used to carry a second title bar of its own with an Import button
// (data-testid "table-import-button") in it. Teardown 3.1 (196e4110,
// 2026-09-17) removed that duplicate bar: the row count rides in the frame's one
// title bar, and Import moved into the frame's header menu, where every other
// widget keeps its actions. So: right-click the widget's title bar, then pick
// the Import row. Same handler (TableWidget handleImport), same dialog.
async function openImportFromHeaderMenu(
  window: LaunchedApp['window'],
  widgetId: string
): Promise<void> {
  const header = window.locator(`[data-widget-id="${widgetId}"] [data-widget-header]`)
  await header.click({ button: 'right', position: { x: 40, y: 8 } })
  const menu = window.locator('[role="menu"]')
  await expect(menu).toBeVisible({ timeout: 4_000 })
  await menu.getByRole('menuitem', { name: /Import CSV, JSON or Excel/ }).click()
}

// ── Test A: Upsert mode ──────────────────────────────────────────────────────

test('A — upsert mode: dialog opens, mapping auto-suggested, correct state after apply', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const seed = await seedTable(window, [
    { email: 'a@x.com', name: 'Alice', mrr: '100' },
    { email: 'b@x.com', name: 'Bob', mrr: '50' }
  ])

  // Stub the IPC before navigating so the handler is ready when the button is clicked.
  await stubGridIpc(launched, '/tmp/fake-import.csv', {
    ok: true,
    grid: {
      headers: ['Email', 'Name', 'MRR', 'Plan'],
      rows: [
        { Email: 'a@x.com', Name: 'Alice Cooper', MRR: '150', Plan: 'Team' },
        { Email: 'c@x.com', Name: 'Carol', MRR: '75', Plan: 'Pro' }
      ]
    }
  })

  await navigateToTable(window, seed.taskId, seed.widgetId)

  await openImportFromHeaderMenu(window, seed.widgetId)

  // Dialog must appear.
  await expect(window.locator('[data-testid="table-import-dialog"]')).toBeVisible({
    timeout: 6_000
  })

  // Mapping row 0 (Email) should auto-select an existing column.
  const mapTarget0 = await window.locator('[data-testid="map-target-0"]').inputValue()
  expect(mapTarget0, 'Email maps to existing c-email column').toBe('existing:c-email')

  // Mapping row 1 (Name) should auto-select existing.
  const mapTarget1 = await window.locator('[data-testid="map-target-1"]').inputValue()
  expect(mapTarget1, 'Name maps to existing c-name column').toBe('existing:c-name')

  // Mapping row 2 (MRR) should auto-select existing.
  const mapTarget2 = await window.locator('[data-testid="map-target-2"]').inputValue()
  expect(mapTarget2, 'MRR maps to existing c-mrr column').toBe('existing:c-mrr')

  // Mapping row 3 (Plan) should propose a new column.
  const mapTarget3 = await window.locator('[data-testid="map-target-3"]').inputValue()
  expect(mapTarget3, 'Plan proposes a new column').toBe('new')

  // Set the primary key to the Email column (c-email).
  await window.locator('[data-testid="import-primary-key"]').selectOption('c-email')

  // Preview must say "1 to add, 1 to update" and "1 new column".
  const previewText = await window.locator('[data-testid="import-preview"]').innerText()
  expect(previewText, 'preview: 1 to add').toContain('1 to add')
  expect(previewText, 'preview: 1 to update').toContain('1 to update')
  expect(previewText, 'preview: 1 new column').toContain('1 new column')

  // Apply the import.
  await window.evaluate(() => {
    const btn = document.querySelector('[data-testid="import-apply"]') as HTMLButtonElement | null
    if (!btn) throw new Error('import-apply not found')
    btn.click()
  })

  // Dialog must close.
  await expect(window.locator('[data-testid="table-import-dialog"]')).not.toBeVisible({
    timeout: 8_000
  })

  // Read back the rows from the DB and assert the merged state.
  const finalState = await window.evaluate(async (tableId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const tbl = await api.tables.get(tableId)
    const rows = await api.tables.listRows(tableId)
    return { schema: tbl?.schema, rows }
  }, seed.tableId)

  const rows = finalState.rows ?? []
  const schema = finalState.schema

  // Row count: 2 original + 1 new = 3, not 4.
  expect(rows.length, 'row count is 3 (not 4 — no duplicate)').toBe(3)

  // Find Alice by email.
  const aliceRow = rows.find((r) => {
    const cells = r.cells as Record<string, unknown>
    return cells['c-email'] === 'a@x.com'
  })
  expect(aliceRow, 'Alice row exists').toBeTruthy()
  const aliceCells = aliceRow!.cells as Record<string, unknown>
  expect(String(aliceCells['c-name']), "Alice's name updated to Alice Cooper").toBe('Alice Cooper')
  expect(Number(aliceCells['c-mrr']), "Alice's MRR updated to 150").toBe(150)

  // Carol must be present.
  const carolRow = rows.find((r) => {
    const cells = r.cells as Record<string, unknown>
    return cells['c-email'] === 'c@x.com'
  })
  expect(carolRow, 'Carol row was inserted').toBeTruthy()

  // Schema must have a Plan column.
  const planColumn = schema?.columns.find((c) => c.label === 'Plan')
  expect(planColumn, 'schema now has a Plan column').toBeTruthy()

  // Alice must still exist only once (no duplicate).
  const aliceCount = rows.filter((r) => {
    const cells = r.cells as Record<string, unknown>
    return cells['c-email'] === 'a@x.com'
  }).length
  expect(aliceCount, 'Alice appears exactly once (no duplicate)').toBe(1)
})

// ── Test B: Append mode ──────────────────────────────────────────────────────

test('B — append mode: all rows insert, none updated', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const seed = await seedTable(window, [
    { email: 'a@x.com', name: 'Alice', mrr: '100' },
    { email: 'b@x.com', name: 'Bob', mrr: '50' }
  ])

  await stubGridIpc(launched, '/tmp/fake-append.csv', {
    ok: true,
    grid: {
      headers: ['Email', 'Name', 'MRR'],
      rows: [
        { Email: 'x@new.com', Name: 'Xena', MRR: '200' },
        { Email: 'y@new.com', Name: 'Yuri', MRR: '300' }
      ]
    }
  })

  await navigateToTable(window, seed.taskId, seed.widgetId)

  await openImportFromHeaderMenu(window, seed.widgetId)

  await expect(window.locator('[data-testid="table-import-dialog"]')).toBeVisible({ timeout: 6_000 })

  // Explicitly set primary key to empty = "Append all as new rows".
  await window.locator('[data-testid="import-primary-key"]').selectOption('')

  const previewText = await window.locator('[data-testid="import-preview"]').innerText()
  expect(previewText, 'preview: 2 to add, 0 to update').toContain('2 to add')
  expect(previewText, 'preview: 0 to update').toContain('0 to update')

  await window.evaluate(() => {
    const btn = document.querySelector('[data-testid="import-apply"]') as HTMLButtonElement | null
    if (!btn) throw new Error('import-apply not found')
    btn.click()
  })

  await expect(window.locator('[data-testid="table-import-dialog"]')).not.toBeVisible({ timeout: 8_000 })

  const rows = await window.evaluate(async (tableId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.tables.listRows(tableId)
  }, seed.tableId)

  // 2 original + 2 appended = 4 total.
  expect(rows.length, 'row count is 4 (all appended)').toBe(4)

  const emails = rows.map((r) => (r.cells as Record<string, unknown>)['c-email'] as string)
  expect(emails, 'x@new.com was inserted').toContain('x@new.com')
  expect(emails, 'y@new.com was inserted').toContain('y@new.com')
  expect(emails, 'a@x.com still present').toContain('a@x.com')
  expect(emails, 'b@x.com still present').toContain('b@x.com')
})

// ── Test C: XLS round-trip via importFile ─────────────────────────────────────
//
// Writes a real .xlsx in the test process using the xlsx package (same one
// bundled in main), then calls fileImport.run({path}) through the renderer IPC
// and asserts the draft has the right shape. This confirms SheetJS parses
// end-to-end in the packaged main process without any mock.

test('C — XLS round-trip: real .xlsx parses into a table draft via importFile', async () => {
  const dir = makeScratch()
  const xlsxPath = join(dir, 'test-data.xlsx')

  // Write the .xlsx from the test process — xlsx is available as a normal
  // package dep, same version bundled in main.
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['Product', 'Revenue', 'Active'],
    ['Sprocket', '1200', 'yes'],
    ['Widget', '450', 'no'],
    ['Gadget', '2100', 'yes']
  ])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, xlsxPath)

  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Call the existing fileImport:run handler with the real .xlsx path.
  // The main process reads the binary via SheetJS — no stub involved.
  const draft = await window.evaluate((p: string) =>
    window.api.fileImport.run({ path: p })
  , xlsxPath)

  const d = draft as {
    kind: string
    title: string
    schema: { columns: Array<{ label: string; type: string }> }
    rows: Array<Record<string, string>>
  }

  expect(d.kind, 'draft is a table').toBe('table')
  expect(d.title, 'title derived from filename').toBe('test-data')

  const labels = d.schema.columns.map((c) => c.label)
  expect(labels, 'headers are Product/Revenue/Active').toEqual(['Product', 'Revenue', 'Active'])

  // Type inference: Revenue = number, Active = checkbox.
  const revenueCol = d.schema.columns.find((c) => c.label === 'Revenue')
  const activeCol = d.schema.columns.find((c) => c.label === 'Active')
  expect(revenueCol?.type, 'Revenue inferred as number').toBe('number')
  expect(activeCol?.type, 'Active inferred as checkbox').toBe('checkbox')

  // Data rows: 3 data rows (header row stripped by SheetJS).
  expect(d.rows.length, '3 data rows').toBe(3)
  expect(d.rows[0].Product, 'first row Product = Sprocket').toBe('Sprocket')
  expect(d.rows[1].Revenue, 'second row Revenue = 450').toBe('450')
  expect(d.rows[2].Active, 'third row Active = yes').toBe('yes')
})
