// E2E: the table widget's AI button must be reachable for BOTH columns and rows.
//
// The AI assistant used to be reachable only from the widget header's overflow
// menu, while the table's own empty state told the user to "use the AI button
// to generate some" — a button that existed nowhere in the table. These tests
// pin a visible affordance in each of the two places a user is already working:
// beside the add-column "+", and beside Add row.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedTableDesk(window: LaunchedApp['window']): Promise<string> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'AiButtonsDesk' })
    const table = await api.tables.create({
      title: 'AiButtons',
      schema: {
        columns: [{ id: 'c-name', type: 'text-short', label: 'Name', config: {} }]
      }
    })
    await api.tables.createRow({ tableId: table.id, cells: { 'c-name': 'first' } })
    const widget = await api.widgets.create({
      taskId: task.id,
      kind: 'table',
      title: 'AiButtons',
      content: table.id,
      x: 80,
      y: 80,
      width: 620,
      height: 400
    })
    return widget.id
  })
}

async function openDesk(window: LaunchedApp['window'], widgetId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /AiButtonsDesk/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForFunction(
    (wid: string) => !!document.querySelector(`[data-widget-id="${wid}"] [data-testid="table-ai-rows"]`),
    widgetId,
    { timeout: 10_000 }
  )
}

test('TAI-1 — the table shows an AI button for columns and one for rows', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedTableDesk(window)
  await openDesk(window, widgetId)

  const widget = window.locator(`[data-widget-id="${widgetId}"]`)
  await expect(widget.locator('[data-testid="table-ai-columns"]')).toBeVisible()
  await expect(widget.locator('[data-testid="table-ai-rows"]')).toBeVisible()
})

test('TAI-2 — either AI button opens the assistant, and it names columns and rows', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedTableDesk(window)
  await openDesk(window, widgetId)

  const widget = window.locator(`[data-widget-id="${widgetId}"]`)
  const panel = widget.getByText(/AI assistant — columns and rows/i)

  // The rows button opens it.
  await expect(panel).toHaveCount(0)
  await widget.locator('[data-testid="table-ai-rows"]').click()
  await expect(panel).toBeVisible()

  // Close it, then the columns button opens the same assistant.
  await widget.getByLabel('Close').first().click()
  await expect(panel).toHaveCount(0)
  await widget.locator('[data-testid="table-ai-columns"]').click()
  await expect(panel).toBeVisible()
})
