/**
 * E2E for the PlexiSlides native table element: insert via the Insert menu,
 * render on the canvas, and edit cells + add a row from the inspector.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, gotoView, selectBarTab } from './_helpers'

async function openDocumentsHub(window: Page): Promise<void> {
  await gotoView(window, 'goDocuments')
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

async function startBlankSlides(window: Page): Promise<void> {
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Slides' }).first().click()
  await expect(window.locator('[data-testid="slides-toolbar"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible({ timeout: 8_000 })
}

async function readDeck(window: Page): Promise<{ slides?: Array<{ elements?: Array<Record<string, unknown>> }> }> {
  await window.waitForTimeout(1_200)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const deck = docs.find((d) => d.docType === 'slides')
    const doc = deck ? await api.documents.get(deck.id) : null
    return (doc?.body as never) ?? {}
  })
}

test('ST-1 — insert a table, render it, edit a cell and add a row', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSlides(window)

    await window.getByRole('button', { name: 'Insert', exact: true }).click()
    // Scoped to the Insert menu: a bare `text=Table` first matches the side
    // menu's Table work-widget tile (sidemenu-widget-table), which is not this
    // action, so the spec never reached the insert path.
    await window.locator('[data-testid="slides-menubar-insert-list"]').getByText('Table', { exact: true }).click()
    await window.waitForTimeout(400)

    const tableEl = window.locator('[data-testid="slide-element"][data-eltype="table"]')
    await expect(tableEl.first()).toBeVisible({ timeout: 4_000 })
    // Renders as a real HTML table with the header text.
    await expect(tableEl.locator('table')).toBeVisible()
    await expect(tableEl).toContainText('Column 1')

    // Select it (element layer is pointer-events:none; force through to the Rnd).
    await tableEl.first().click({ force: true })
    // Its controls are on the contextual Table tab (D3: select it); the cells open in a panel.
    await selectBarTab(window, 'slides-toolbar', 'table')
    await window.locator('[data-testid="table-edit-cells"]').click()
    await expect(window.locator('[data-testid="slides-panel-cells"]')).toBeVisible({ timeout: 4_000 })

    // Edit the first cell.
    const firstCell = window.locator('[data-testid="table-cells"] input').first()
    await firstCell.fill('Region')

    // Add a row.
    await window.locator('[data-testid="table-add-row"]').click()
    await window.waitForTimeout(300)

    const deck = await readDeck(window)
    const table = (deck.slides?.[0]?.elements ?? []).find((e) => e.type === 'table') as { cells?: string[][] } | undefined
    expect(table, 'table element persisted').toBeTruthy()
    expect(table!.cells![0][0]).toBe('Region')
    expect(table!.cells!.length).toBe(4) // 3 seeded + 1 added
  } finally {
    await dispose()
  }
})
