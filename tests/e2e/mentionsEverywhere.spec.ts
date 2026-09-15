import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// @ is not a sticky feature. Every prose field offers it, and a reference
// typed into any of them is the same record.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: LaunchedApp['window'], kinds: string[]) {
  return window.evaluate(async (ks) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Ridgeway Campaign' })
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Writing desk' })
    let x = 80
    for (const k of ks) {
      await api.widgets.create({
        taskId: desk.id,
        kind: k as never,
        title: '',
        // The card stores JSON; an empty string is not a card.
        content: k === 'card' ? JSON.stringify({ title: 'Card', body: '', accent: '#6366f1' }) : '',
        x,
        y: 80,
        width: 340,
        height: 260
      })
      x += 380
    }
    return desk.id
  }, kinds)
}

async function open(window: LaunchedApp['window'], deskId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
}

// The prose widgets that should all behave identically.
for (const kind of ['note', 'card', 'sticky']) {
  test(`@ offers candidates in a ${kind} widget`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    const deskId = await seed(window, [kind])
    await open(window, deskId)

    const widget = window.locator(`[data-widget-kind="${kind}"]`).first()
    await expect(widget).toBeVisible({ timeout: 10_000 })

    // Each of these opens its editor on click; the sticky starts in one.
    const box = widget.locator('textarea').first()
    if ((await box.count()) === 0) {
      await widget.click()
    }
    const field = widget.locator('textarea').first()
    await expect(field).toBeVisible({ timeout: 5000 })
    await field.click()
    await field.type('see @ridge')

    await expect(window.locator('[data-testid="mention-picker"]')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('[data-testid="mention-picker"]')).toContainText('Ridgeway Campaign')
  })
}

test('@ offers candidates in a task’s notes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Ridgeway Campaign' })
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Task desk' })
    await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'NOTEDTASK' })
    await api.widgets.create({
      taskId: desk.id, kind: 'task-list' as never, title: 'Tasks',
      content: '', x: 100, y: 100, width: 460, height: 420
    })
    return desk.id
  })
  await open(window, deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await widget.getByText('NOTEDTASK').click()

  const notes = widget.locator('textarea').first()
  await expect(notes).toBeVisible({ timeout: 5000 })
  await notes.click()
  await notes.type('about @ridge')
  await expect(window.locator('[data-testid="mention-picker"]')).toBeVisible({ timeout: 5000 })
})
