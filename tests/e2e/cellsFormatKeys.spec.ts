/**
 * E2E: the PlexiiCells keys the menu advertised and the grid never bound.
 *
 * Format ▸ Text showed Bold ⌘B, Italic ⌘I and Underline ⌘U, and Clear
 * formatting showed ⌘\, while onGridKeyDown handled none of the four: the menu
 * promised a key that did nothing. They are matched against the same `keys` the
 * hint is formatted from now (src/renderer/src/lib/menus/commandKeys.ts), so the
 * hint and the binding cannot disagree.
 *
 * ⌘A is NOT covered here, deliberately. It now calls selectAllCells instead of
 * its own copy of that function's first two lines, which is worth doing so the
 * menu's Select all and the key cannot diverge — but it changes no behaviour
 * you can observe, because onGridKeyDown opens with `if (editing) return`, so
 * the three extra lines (closing a cell editor, dropping a header drag,
 * refocusing the grid) are unreachable through this key. A spec asserting that
 * ⌘A closes an open cell editor was written first and FAILED here, correctly:
 * while a cell is being edited, ⌘A selects that cell's text, as it does in
 * Excel and Sheets, and making it close the editor would be a regression.
 *
 * The view-only half of each of these lives in tests/unit/cellsCommandRegistry
 * ("presses ⌘B and nothing is formatted"), where a viewer's sheet is cheap to
 * build; here the point is that the key reaches the grid at all.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

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
  await expect(window.locator('[data-testid="sheet-toolbar"]')).toBeVisible({ timeout: 8_000 })
}

/** A1 with a committed value, and the grid focused on it. */
async function withValueInA1(window: Page): Promise<void> {
  await window.locator('[data-testid="cell-0-0"]').click()
  await window.keyboard.type('Hello')
  await window.keyboard.press('Enter')
  await window.locator('[data-testid="cell-0-0"]').click()
  expect(await cellText(window, 0, 0)).toBe('Hello')
}

async function cellText(window: Page, r: number, c: number): Promise<string> {
  return (await window.locator(`[data-testid="cell-${r}-${c}"] div`).first().innerText()).trim()
}

/** The weight the cell really renders at — 700 when bold, 400 otherwise. */
async function weightOfA1(window: Page): Promise<number> {
  const w = await window
    .locator('[data-testid="cell-0-0"] div')
    .first()
    .evaluate((el) => getComputedStyle(el).fontWeight)
  return Number(w)
}

test('CK-1 — ⌘B bolds the selected cell, which the menu promised and nothing did', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDocumentsHub(window)
  await startBlankSpreadsheet(window)
  await withValueInA1(window)

  // The control, in the same run: not bold to begin with, so the assertion
  // below is about the keystroke and not about a cell that was always bold.
  expect(await weightOfA1(window), 'A1 starts unbolded').toBeLessThan(700)

  await window.keyboard.press('Meta+b')
  await expect
    .poll(() => weightOfA1(window), { timeout: 4_000, message: '⌘B bolds A1' })
    .toBeGreaterThanOrEqual(700)

  // It is a toggle, as the menu row's tick says.
  await window.keyboard.press('Meta+b')
  await expect
    .poll(() => weightOfA1(window), { timeout: 4_000, message: '⌘B again unbolds A1' })
    .toBeLessThan(700)
})

test('CK-2 — ⌘\\ clears the formatting ⌘B applied', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDocumentsHub(window)
  await startBlankSpreadsheet(window)
  await withValueInA1(window)

  await window.keyboard.press('Meta+b')
  await expect
    .poll(() => weightOfA1(window), { timeout: 4_000, message: '⌘B bolds A1 first' })
    .toBeGreaterThanOrEqual(700)

  await window.keyboard.press('Meta+\\')
  await expect
    .poll(() => weightOfA1(window), { timeout: 4_000, message: '⌘\\ clears the bold' })
    .toBeLessThan(700)
  // The value is formatting-only: Clear formatting must not empty the cell.
  expect(await cellText(window, 0, 0)).toBe('Hello')
})
