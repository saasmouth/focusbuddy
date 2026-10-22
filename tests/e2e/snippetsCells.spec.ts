/**
 * PlexiiCells as a saved-snippet surface, end to end in the real app.
 *
 * SC-1 A new spreadsheet: A1 = 2, A2 = 3, A3 = =A1+A2 (showing 5). Select
 *      A1:A3; Edit › Save selection as snippet…; move the active cell to C1;
 *      Insert › Insert snippet… › Duplicate. C1:C3 then hold 2, 3 and a formula
 *      reading =C1+C2 that shows 5, the original A1:A3 is untouched, the landed
 *      range is the selection, the workbook as saved holds it, and one undo
 *      takes the whole insertion back. The library offers Duplicate alone,
 *      because a spreadsheet declares supports: ['duplicate'].
 *
 * Traps this spec steps around (docs/saved-snippets.md, "Two traps"):
 *  - Insertion lands like a paste, REPLACING the selection, so the active cell
 *    is moved to C1 before inserting; inserting over A1:A3 would rewrite the
 *    original in place and prove nothing.
 *  - The first-run corner cards swallow bottom-band clicks while Playwright
 *    reports the target actionable, so both are dismissed up front.
 *  - Menu items are matched from the start of their accessible name.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, switchArea, chooseCloudAiSource, suppressFeatureSpotlights } from './_helpers'

type Stored = { version: number; sheets: Array<{ rows: string[][] }> }

async function newSheet(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-sheets"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-sheets"]').click()
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
}

async function menu(window: Page, id: string, item: string): Promise<void> {
  await window.locator(`[data-testid="sheet-menubar-${id}"]`).click()
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await window
    .locator(`[data-testid="sheet-menubar-${id}-list"]`)
    .getByRole('button', { name: new RegExp(`^${escaped}`) })
    .click()
}

const cellAt = (window: Page, r: number, c: number) => window.locator(`[data-testid="cell-${r}-${c}"]`)
const formulaBar = (window: Page) => window.locator('input[placeholder*="Select a cell"]')

/** Type into a cell the way a person does: select it, type, Enter. */
async function enter(window: Page, r: number, c: number, value: string): Promise<void> {
  await cellAt(window, r, c).click()
  await window.keyboard.type(value)
  await window.keyboard.press('Enter')
}

/** The displayed text of a cell. */
async function shown(window: Page, r: number, c: number): Promise<string> {
  return ((await cellAt(window, r, c).locator('div').first().textContent()) ?? '').trim()
}

async function readSheet(window: Page): Promise<string[][]> {
  // Autosave is debounced; give it time to land before reading the stored body.
  await window.waitForTimeout(1_500)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const sheet = docs.find((d) => d.docType === 'sheet')
    const doc = sheet ? await api.documents.get(sheet.id) : null
    return ((doc?.body ?? { sheets: [{ rows: [] }] }) as Stored).sheets[0]!.rows
  })
}

const block = (rows: string[][], c: number): string[] => [0, 1, 2].map((r) => rows[r]?.[c] ?? '')

test('SC-1: save A1:A3 with a relative formula as a sheet snippet, insert a duplicate at C1, and it shifts, recalculates and persists', async () => {
  test.setTimeout(120_000)
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await suppressFeatureSpotlights(window)
    await newSheet(window)

    await enter(window, 0, 0, '2')
    await enter(window, 1, 0, '3')
    await enter(window, 2, 0, '=A1+A2')
    await expect.poll(() => shown(window, 2, 0)).toBe('5')

    const before = await readSheet(window)
    expect(block(before, 0)).toEqual(['2', '3', '=A1+A2'])
    expect(block(before, 2)).toEqual(['', '', ''])

    // Select A1:A3; Edit › Save selection as snippet…
    await cellAt(window, 0, 0).click()
    await cellAt(window, 2, 0).click({ modifiers: ['Shift'] })
    await menu(window, 'edit', 'Save selection as snippet…')
    const dialog = window.locator('[data-testid="save-snippet-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="save-snippet-empty"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="save-snippet-preview"]')).toHaveText('3 × 1 cells')
    // Nothing in this range is lost, so the dialog has nothing to warn about.
    await expect(window.locator('[data-testid="save-snippet-not-kept"]')).toHaveCount(0)
    await window.locator('[data-testid="save-snippet-name"]').fill('Two plus three')
    await window.locator('[data-testid="save-snippet-confirm"]').click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    // Stored as a sheet snippet: the formula as written, and where it came from.
    const saved = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.snippets.list({ kinds: ['sheet'] })
      return list.find((s) => s.name === 'Two plus three') ?? null
    })
    expect(saved, 'the snippet was saved').toBeTruthy()
    expect(saved!.kind).toBe('sheet')
    expect(saved!.body).toMatchObject({ kind: 'sheet', rows: [['2'], ['3'], ['=A1+A2']], origin: { r: 0, c: 0 } })

    // Move the active cell to C1, so the insertion does not replace the original.
    await cellAt(window, 0, 2).click()
    await expect(formulaBar(window)).toHaveValue('')

    // Insert › Insert snippet… opens the library scoped to sheet snippets.
    await menu(window, 'insert', 'Insert snippet…')
    await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
    const row = window.locator('[data-testid="snippet-row"]').filter({ hasText: 'Two plus three' })
    await expect(row).toBeVisible()
    await expect(row.locator('[data-testid="snippet-insert-live"]')).toHaveCount(0)
    await row.locator('[data-testid="snippet-insert-duplicate"]').click()
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })

    // Shifted and recalculated on screen; the original is untouched.
    await expect.poll(() => shown(window, 2, 2)).toBe('5')
    expect([await shown(window, 0, 2), await shown(window, 1, 2)]).toEqual(['2', '3'])
    expect([await shown(window, 0, 0), await shown(window, 1, 0), await shown(window, 2, 0)]).toEqual(['2', '3', '5'])
    // The landed range is the selection with C1 active.
    await expect(formulaBar(window)).toHaveValue('2')
    await cellAt(window, 2, 2).click()
    await expect(formulaBar(window)).toHaveValue('=C1+C2')

    // Persisted in the saved workbook.
    const after = await readSheet(window)
    expect(block(after, 2)).toEqual(['2', '3', '=C1+C2'])
    expect(block(after, 0)).toEqual(['2', '3', '=A1+A2'])

    // One undo step takes the whole insertion back; redo restores it.
    await window.locator('[data-testid="sheet-undo"]').click()
    await expect.poll(() => shown(window, 2, 2)).toBe('')
    expect([await shown(window, 0, 2), await shown(window, 1, 2)]).toEqual(['', ''])
    const undone = await readSheet(window)
    expect(block(undone, 2)).toEqual(['', '', ''])
    expect(block(undone, 0)).toEqual(['2', '3', '=A1+A2'])
    await window.locator('[data-testid="sheet-redo"]').click()
    await expect.poll(() => shown(window, 2, 2)).toBe('5')

    // The use was counted, because the spreadsheet really took it.
    const used = await window.evaluate(async (id: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.snippets.list({ kinds: ['sheet'] })
      return list.find((s) => s.id === id)?.usageCount ?? -1
    }, saved!.id)
    expect(used).toBe(1)
  } finally {
    await dispose()
  }
})
