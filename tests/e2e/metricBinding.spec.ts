import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// A bound card is a VIEW of a table, not a copy of one: the number has to
// follow the rows, including when the rows change underneath it.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('a stat card bound to a table computes from real rows and follows edits', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Numbers desk' })
    const table = await api.tables.create({
      taskId: desk.id,
      title: 'Deals',
      schema: {
        columns: [
          { id: 'amt', type: 'number', label: 'Amount', config: {} },
          { id: 'stage', type: 'text-short', label: 'Stage', config: {} }
        ]
      }
    })
    await api.tables.createRow({ tableId: table.id, cells: { amt: 100, stage: 'Won' } })
    await api.tables.createRow({ tableId: table.id, cells: { amt: 250, stage: 'Won' } })
    await api.tables.createRow({ tableId: table.id, cells: { amt: 900, stage: 'Lost' } })

    await api.widgets.create({
      taskId: desk.id,
      kind: 'stat-card' as never,
      title: 'Won',
      content: JSON.stringify({
        title: 'Won revenue',
        series: [],
        binding: {
          source: { kind: 'table', tableId: table.id },
          agg: 'sum',
          columnId: 'amt',
          filters: [{ columnId: 'stage', op: 'eq', value: 'Won' }],
          format: 'currency'
        }
      }),
      x: 120, y: 120, width: 340, height: 240
    })
    return { deskId: desk.id, tableId: table.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, ids.deskId)

  const card = window.locator('[data-widget-kind="stat-card"]').first()
  await expect(card).toBeVisible({ timeout: 10_000 })
  // 100 + 250, filtered to Won. Not 1250.
  await expect(card).toContainText('$350')
  // ...and it says what it read, so a zero can be told from no data.
  await expect(card).toContainText('2 of 3 rows')

  // Add a row: the card must follow without a reload.
  await window.evaluate(async (tableId) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.tables.createRow({ tableId, cells: { amt: 50, stage: 'Won' } })
  }, ids.tableId)
  await expect(card).toContainText('$400', { timeout: 10_000 })
  await expect(card).toContainText('3 of 4 rows')
})

test('a bound card shows a dash, not a zero, when nothing is numeric', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Empty numbers' })
    const table = await api.tables.create({
      taskId: desk.id,
      title: 'Blank',
      schema: { columns: [{ id: 'amt', type: 'number', label: 'Amount', config: {} }] }
    })
    await api.tables.createRow({ tableId: table.id, cells: {} })
    await api.widgets.create({
      taskId: desk.id,
      kind: 'stat-card' as never,
      title: 'Nothing',
      content: JSON.stringify({
        title: 'Unmeasured',
        series: [],
        binding: { source: { kind: 'table', tableId: table.id }, agg: 'sum', columnId: 'amt' }
      }),
      x: 120, y: 120, width: 340, height: 240
    })
    return desk.id
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)

  const card = window.locator('[data-widget-kind="stat-card"]').first()
  await expect(card).toBeVisible({ timeout: 10_000 })
  // "No data" must never render as a confident zero.
  await expect(card).toContainText('—')
  await expect(card).not.toContainText('$0')
})

test('a fresh metrics widget can be configured from its empty state', async () => {
  // It was a dead end: the configure control is per-cell, so with no cells
  // there was nothing to click.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Metrics desk' })
    const table = await api.tables.create({
      taskId: desk.id,
      title: 'Deals',
      schema: { columns: [{ id: 'amt', type: 'number', label: 'Amount', config: {} }] }
    })
    await api.tables.createRow({ tableId: table.id, cells: { amt: 120 } })
    await api.widgets.create({
      taskId: desk.id, kind: 'metrics' as never, title: 'Metrics',
      content: JSON.stringify({ cells: [] }), x: 120, y: 120, width: 420, height: 300
    })
    return desk.id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)

  const widget = window.locator('[data-widget-kind="metrics"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await expect(widget).toContainText('No figures yet')

  await widget.getByTestId('metrics-add-cell').click()
  // Adding a number opens the binding editor straight away, so there is a
  // path from an empty widget to a real number without guessing.
  await expect(widget.getByTestId('metric-binding-editor')).toBeVisible({ timeout: 5000 })
  await expect(widget.getByTestId('metric-search')).toBeVisible()
  await expect(widget).toContainText('Deals')
})
