import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Every widget can be named. Until the user types a name the header inherits one
// from the widget's own content (the first line of a note). Double-clicking the
// header label sets a manual name, which persists.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('a widget inherits its name from the first line and can be manually renamed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Naming' })
    const s = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'Buy milk\nand eggs',
      x: 140,
      y: 140,
      width: 220,
      height: 160
    })
    return { taskId: task.id, widgetId: s.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Naming/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  const label = window.locator(`[data-testid="widget-title-${ids.widgetId}"]`)
  // Inherited from the first line of content, with no manual title set.
  await expect(label).toHaveText('Buy milk')

  // Rename button → edit → commit on Enter.
  await window.getByRole('button', { name: 'Rename work widget' }).first().click()
  const input = window.locator('input[aria-label="Work widget name"]')
  await expect(input).toBeVisible()
  await input.fill('Groceries')
  await input.press('Enter')
  await expect(label).toHaveText('Groceries')

  // The manual name persists across a reload.
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Naming/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await expect(window.locator(`[data-testid="widget-title-${ids.widgetId}"]`)).toHaveText('Groceries')

  // Clearing the name falls back to the inherited first line again.
  await window.getByRole('button', { name: 'Rename work widget' }).first().click()
  const input2 = window.locator('input[aria-label="Work widget name"]')
  await input2.fill('')
  await input2.press('Enter')
  await expect(window.locator(`[data-testid="widget-title-${ids.widgetId}"]`)).toHaveText('Buy milk')
})

test('double-clicking the header label also opens the rename editor', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'DblClick' })
    const s = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'Original line',
      x: 160,
      y: 160,
      width: 220,
      height: 160
    })
    return { widgetId: s.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /DblClick/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  const label = window.locator(`[data-testid="widget-title-${ids.widgetId}"]`)
  await expect(label).toHaveText('Original line')
  // Two quick clicks on the label open the editor (manual dblclick detection).
  await label.click()
  await label.click({ delay: 40 })
  const input = window.locator('input[aria-label="Work widget name"]')
  await expect(input).toBeVisible()
  await input.fill('Renamed by dblclick')
  await input.press('Enter')
  await expect(label).toHaveText('Renamed by dblclick')
})
