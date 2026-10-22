/**
 * E2E for the PlexiSlides chart element (closes the "Slides has no charts"
 * blocker). Inserts a chart via the Insert menu and confirms it renders through
 * the shared chart core, then links it to a real spreadsheet range and confirms
 * the snapshot picks up the live computed values.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, gotoView } from './_helpers'

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

async function insertChartViaMenu(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Insert', exact: true }).click()
  // Scoped to the Insert menu: a bare `text=Chart` first matches the side
  // menu's Chart work-widget tile (sidemenu-widget-chart), not this action.
  const item = window.locator('[data-testid="slides-menubar-insert-list"]').getByText('Chart', { exact: true })
  await expect(item).toBeVisible({ timeout: 3_000 })
  await item.click()
  await window.waitForTimeout(400)
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

test('SC-1 — Insert > Chart adds a chart element that renders through the chart core', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankSlides(window)

    await insertChartViaMenu(window)

    const chartEl = window.locator('[data-testid="slide-element"][data-eltype="chart"]')
    await expect(chartEl.first()).toBeVisible({ timeout: 4_000 })
    await expect(chartEl.locator('[data-testid="plexi-chart"]').first()).toBeVisible({ timeout: 4_000 })

    const deck = await readDeck(window)
    const els = deck.slides?.[0]?.elements ?? []
    const chart = els.find((e) => e.type === 'chart') as { chart?: { type?: string; data?: { series?: unknown[] } } } | undefined
    expect(chart, 'a chart element persisted').toBeTruthy()
    expect(chart!.chart?.type).toBe('bar')
    expect((chart!.chart?.data?.series ?? []).length).toBeGreaterThan(0)
  } finally {
    await dispose()
  }
})

test('SC-2 — linking a chart to a sheet range pulls the live computed values', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Seed a spreadsheet with headers + a formula so we can prove it charts the
    // computed result, not the text.
    await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.documents.create({
        docType: 'sheet',
        title: 'Sales sheet',
        body: {
          sheets: [
            {
              id: 's1',
              name: 'Sheet1',
              columns: ['A', 'B', 'C'],
              rows: [
                ['Quarter', 'EU', 'US'],
                ['Q1', '10', '5'],
                ['Q2', '20', '=5*3']
              ]
            }
          ]
        }
      })
    })

    await openDocumentsHub(window)
    await startBlankSlides(window)
    await insertChartViaMenu(window)

    // Select the chart so the inspector shows its controls, then open the link
    // dialog. The rendered element layer is pointer-events:none (the Rnd wrapper
    // beneath handles selection), so force the click through to it.
    await window.locator('[data-testid="slide-element"][data-eltype="chart"]').first().click({ force: true })
    await expect(window.locator('[data-testid="inspector-chart"]')).toBeVisible({ timeout: 4_000 })
    await window.locator('[data-testid="chart-link"]').click()

    const dialog = window.locator('[data-testid="chart-link-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 4_000 })
    // The seeded sheet appears in the picker.
    await expect(dialog.locator('[data-testid="chart-link-doc"]')).toContainText('Sales sheet')
    await dialog.locator('[data-testid="chart-link-range"]').fill('A1:C3')
    await dialog.locator('[data-testid="chart-link-apply"]').click()
    await window.waitForTimeout(600)

    const deck = await readDeck(window)
    const chart = (deck.slides?.[0]?.elements ?? []).find((e) => e.type === 'chart') as
      | { source?: { range?: string }; chart?: { data?: { categories?: string[]; series?: Array<{ name: string; values: number[] }> } } }
      | undefined
    expect(chart?.source?.range).toBe('A1:C3')
    const series = chart?.chart?.data?.series ?? []
    expect(series.map((s) => s.name)).toEqual(['EU', 'US'])
    expect(series[0].values).toEqual([10, 20])
    expect(series[1].values).toEqual([5, 15]) // =5*3 charted as its result
    expect(chart?.chart?.data?.categories).toEqual(['Q1', 'Q2'])
  } finally {
    await dispose()
  }
})
