import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Tasks and Attention are one thing, so the desk widget gets Attention's
// working parts: queues, its ranker, its reasons, and snooze.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: LaunchedApp['window']) {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Queue desk' })
    const day = 86_400_000
    const overdue = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'OVERDUETASK' })
    await api.nodes.update(overdue.id, { dueDate: Date.now() - 2 * day })
    const later = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'LATERTASK' })
    await api.nodes.update(later.id, { dueDate: Date.now() + 20 * day })
    const toDecide = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'DECIDETASK' })
    await api.widgets.create({
      taskId: desk.id, kind: 'task-list' as never, title: 'Tasks',
      content: '', x: 100, y: 100, width: 520, height: 460
    })
    return { deskId: desk.id, overdueId: overdue.id, laterId: later.id, decideId: toDecide.id }
  })
}

async function open(window: LaunchedApp['window'], deskId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
}

test('a task can be reclassified into a queue, and the queue survives a reload', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)
  await open(window, ids.deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })

  // Open the task's detail and give it a queue.
  await widget.getByText('DECIDETASK').click()
  await widget.getByTestId('task-queue').first().selectOption('to_decide')
  await window.waitForTimeout(800)

  const stored = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.nodes.list()).find((n: { id: string }) => n.id === id)?.intentClass
  }, ids.decideId)
  expect(stored).toBe('to_decide')

  // Grouped by queue, it lands under Decide rather than To Do.
  await widget.getByTestId('task-group').selectOption('queue')
  await expect(widget).toContainText('Decide')
})

test('the ranker puts the overdue task first', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)
  await open(window, ids.deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await widget.getByTestId('task-rank').click()
  await window.waitForTimeout(400)

  const order = await window.evaluate(() =>
    [...document.querySelectorAll('[data-widget-kind="task-list"] [data-testid="task-expand"]')]
      .map((b) => b.closest('.group')?.textContent ?? '')
      .join('|')
  )
  expect(order.indexOf('OVERDUETASK')).toBeLessThan(order.indexOf('LATERTASK'))
  // ...and it says WHY, in Attention's own words.
  await expect(widget).toContainText('Past due')
})

test('snoozing a task takes it out of the active list until it wakes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)
  await open(window, ids.deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toContainText('LATERTASK', { timeout: 10_000 })

  await widget.getByText('LATERTASK').click()
  await widget.getByTitle(/Put this down for 1w/).click()
  await window.waitForTimeout(800)

  // Gone from Active — that is what snoozing is for.
  await expect(widget).not.toContainText('LATERTASK')
  // ...but not lost: All still has it.
  await widget.getByText('All', { exact: true }).click()
  await expect(widget).toContainText('LATERTASK')
})
