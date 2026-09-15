import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Every planning field as a column, editable in place.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('the task widget switches to a table of every field, and edits stick', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Plan desk' })
    const a = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'ALPHA' })
    const b = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'BETA' })
    await api.nodes.create({ parentId: a.id, kind: 'task', title: 'sub one' })
    await api.nodes.update(a.id, { dueDate: Date.UTC(2026, 8, 20), assignee: 'Michael' })
    await api.nodes.update(b.id, { dependsOn: a.id, lagDays: -2 })
    await api.widgets.create({
      taskId: desk.id, kind: 'task-list' as never, title: 'Tasks',
      content: '', x: 100, y: 100, width: 720, height: 420
    })
    return { deskId: desk.id, aId: a.id, bId: b.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, ids.deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })

  await widget.getByTestId('task-view-toggle').click()
  const table = widget.getByTestId('task-table')
  await expect(table).toBeVisible()

  // Every field is a column.
  for (const h of ['Task', 'Status', 'Who', 'Start', 'Due', 'Days', 'Waits for', 'Lag', 'Sub']) {
    await expect(table).toContainText(h)
  }
  await expect(table).toContainText('ALPHA')
  await expect(table).toContainText('BETA')
  // Field values live in inputs, so they are read as values rather than text.
  await expect(table.locator('input[placeholder="—"]').first()).toHaveValue('Michael')
  await expect(table.locator('input[type="date"]').nth(1)).toHaveValue('2026-09-20')
  // The subtask count...
  await expect(table).toContainText('0/1')
  // ...and BETA's negative lag, which means it overlaps ALPHA rather than
  // waiting for it.
  await expect(table.locator('input[type="number"]').nth(1)).toHaveValue('-2')

  // Edit in place: change a status and confirm it reached the record.
  await table.locator('select').first().selectOption('done')
  await window.waitForTimeout(600)
  const status = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.nodes.list()).find((n: { id: string }) => n.id === id)?.status
  }, ids.aId)
  expect(status).toBe('done')

  // ...and back to the list.
  await widget.getByTestId('task-view-toggle').click()
  await expect(widget.getByTestId('task-table')).toHaveCount(0)
})
