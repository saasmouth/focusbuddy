import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// A task is a task. It only has a desk if somebody put something on it, and
// even then a click asks rather than silently leaving the desk you are on.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function open(window: LaunchedApp['window'], deskId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
}

test('a plain task opens in place — no desk, no question', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Home desk' })
    await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'PLAINTASK' })
    await api.widgets.create({
      taskId: desk.id, kind: 'task-list' as never, title: 'Tasks',
      content: '', x: 100, y: 100, width: 460, height: 400
    })
    return { deskId: desk.id }
  })
  await open(window, ids.deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await widget.getByText('PLAINTASK').click()

  // No chooser, and we are still on the same desk.
  await expect(window.locator('[data-testid="task-open-choice"]')).toHaveCount(0)
  await expect(widget.getByTestId('task-make-desk')).toBeVisible()
  const view = await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { view: { taskId?: string } } } }
    return w.__fbView?.getState().view
  })
  expect(view?.taskId).toBe(ids.deskId)
})

test('a task WITH a desk asks, and either answer works', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Home desk' })
    const sub = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'HASDESK' })
    // Something on it: that IS what having a desk means.
    await api.widgets.create({
      taskId: sub.id, kind: 'sticky' as never, title: '',
      content: 'on the subtask desk', x: 80, y: 80, width: 240, height: 180
    })
    await api.widgets.create({
      taskId: desk.id, kind: 'task-list' as never, title: 'Tasks',
      content: '', x: 100, y: 100, width: 460, height: 400
    })
    return { deskId: desk.id, subId: sub.id }
  })
  await open(window, ids.deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await widget.getByText('HASDESK').click()

  const choice = window.locator('[data-testid="task-open-choice"]')
  await expect(choice).toBeVisible({ timeout: 5000 })
  await expect(choice).toContainText('1 widget')

  // "Open here" keeps you where you are.
  await choice.getByTestId('task-open-here').click()
  await expect(choice).toHaveCount(0)
  let view = await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { view: { taskId?: string } } } }
    return w.__fbView?.getState().view
  })
  expect(view?.taskId).toBe(ids.deskId)

  // Asked again, "go to its desk" navigates.
  await widget.getByText('HASDESK').click()
  await expect(choice).toBeVisible()
  await choice.getByTestId('task-go-to-desk').click()
  await window.waitForTimeout(700)
  view = await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { view: { taskId?: string } } } }
    return w.__fbView?.getState().view
  })
  expect(view?.taskId).toBe(ids.subId)
})
