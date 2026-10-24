import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The widget header right-click now resolves through the unified menu on EVERY
// widget, with the frame management actions (make-task, share, synced /
// independent duplicate, archive) preserved. Exercised on a timer, which has no
// content menu, so the header menu is its only menu.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedTimer(l: LaunchedApp, taskTitle: string): Promise<string> {
  const { window } = l
  await waitForReady(window)
  return window.evaluate(async ({ taskTitle }: { taskTitle: string }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: taskTitle })
    const w = await api.widgets.create({
      taskId: t.id,
      kind: 'timer',
      title: 'Focus timer',
      content: '',
      x: 160,
      y: 160,
      width: 240,
      height: 200
    })
    return w.id
  }, { taskTitle })
}

async function openTask(l: LaunchedApp, taskTitle: string): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(taskTitle) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
}

async function timerCount(l: LaunchedApp): Promise<number> {
  return l.window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const tasks = await api.nodes.list()
    let n = 0
    for (const task of tasks as Array<{ id: string; kind: string }>) {
      if (task.kind !== 'task') continue
      const widgets = await api.widgets.listByTask(task.id)
      n += (widgets as Array<{ kind: string }>).filter((w) => w.kind === 'timer').length
    }
    return n
  })
}

test('HM-1 — header right-click opens the unified menu with frame actions, and synced duplicate works', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedTimer(launched, 'HeaderMenuTest')
  await openTask(launched, 'HeaderMenuTest')

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8_000 })
  // Right-click the header strip (top of the widget).
  await window.click(`[data-widget-id="${widgetId}"]`, { button: 'right', position: { x: 110, y: 8 } })
  await window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4_000 })

  const menuText = await window.evaluate(
    () => (document.querySelector('[data-canvas-ctx-menu]') as HTMLElement)?.innerText ?? ''
  )
  console.log('[HM-1] header menu top-level:', JSON.stringify(menuText))
  // The unified spine is present on a non-content widget too.
  // §9.3 groups: object (Share…), clipboard (Duplicate), More actions, and the
  // explicit removal rows (E-2) last.
  expect(menuText).toContain('Share…')
  expect(menuText).toContain('Duplicate')
  expect(menuText).toContain('More actions')
  expect(/Archive/.test(menuText) && /Delete|Move to Trash/.test(menuText)).toBe(true)

  expect(await timerCount(launched)).toBe(1)

  // Open More actions and use the synced duplicate (a key preserved action).
  await window.locator('[data-canvas-ctx-menu]').getByText('More actions', { exact: true }).hover()
  await window.getByText('Duplicate, keep synced', { exact: true }).click()

  await window.waitForFunction(
    async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const tasks = await api.nodes.list()
      let n = 0
      for (const task of tasks as Array<{ id: string; kind: string }>) {
        if (task.kind !== 'task') continue
        const widgets = await api.widgets.listByTask(task.id)
        n += (widgets as Array<{ kind: string }>).filter((w) => w.kind === 'timer').length
      }
      return n === 2
    },
    null,
    { timeout: 6_000 }
  )
  console.log('[HM-1] timers after synced duplicate:', await timerCount(launched))
  expect(await timerCount(launched)).toBe(2)
})
