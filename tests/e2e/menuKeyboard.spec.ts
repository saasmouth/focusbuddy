import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The unified context menu is keyboard navigable: type-ahead jumps to a label,
// ArrowRight opens a submenu, type-ahead selects within it, and Enter activates.
// Driven entirely by the keyboard here, ending in a real widget creation.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedNote(l: LaunchedApp, content: string, taskTitle: string): Promise<string> {
  const { window } = l
  await waitForReady(window)
  return window.evaluate(async ({ content, taskTitle }: { content: string; taskTitle: string }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: taskTitle })
    const w = await api.widgets.create({
      taskId: t.id,
      kind: 'note',
      title: '',
      content,
      x: 140,
      y: 140,
      width: 460,
      height: 320
    })
    return w.id
  }, { content, taskTitle })
}

async function openTask(l: LaunchedApp, taskTitle: string): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(taskTitle) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
}

async function stickyCount(l: LaunchedApp): Promise<number> {
  return l.window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const tasks = await api.nodes.list()
    let n = 0
    for (const task of tasks as Array<{ id: string; kind: string }>) {
      if (task.kind !== 'task') continue
      const widgets = await api.widgets.listByTask(task.id)
      n += (widgets as Array<{ kind: string }>).filter((w) => w.kind === 'sticky').length
    }
    return n
  })
}

test('KB-1 — drive the unified menu by keyboard to create a sticky', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedNote(launched, 'keyboard nav test', 'MenuKeyboardTest')
  await openTask(launched, 'MenuKeyboardTest')

  // Open the menu from the note as read (not its editing textarea: text gets
  // the native text menu, SPEC §9.3, E-5).
  await window.waitForSelector(`[data-widget-id="${widgetId}"] .fb-note-rendered`, { timeout: 8_000 })
  await window.click(`[data-widget-id="${widgetId}"] .fb-note-rendered`, { button: 'right' })
  await window.waitForSelector('[data-canvas-ctx-menu][role="menu"]', { timeout: 4_000 })

  // Make sure the menu panel has keyboard focus.
  await window.evaluate(() =>
    (document.querySelector('[data-canvas-ctx-menu][role="menu"]') as HTMLElement)?.focus()
  )

  expect(await stickyCount(launched)).toBe(0)

  // Type-ahead to "More actions" and open it (§9.3: Create & link lives
  // there), then to "Create & link", open it, type-ahead to "Sticky", activate.
  await window.keyboard.type('more')
  await window.waitForTimeout(120)
  await window.keyboard.press('ArrowRight') // open More actions
  await window.waitForTimeout(700) // the type-ahead buffer clears after 600ms
  await window.keyboard.type('create')
  await window.waitForTimeout(120)
  await window.keyboard.press('ArrowRight') // open the Create & link submenu
  await window.waitForTimeout(200)
  await window.keyboard.type('sticky')
  await window.waitForTimeout(120)
  await window.keyboard.press('Enter')

  await window.waitForFunction(
    async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const tasks = await api.nodes.list()
      let n = 0
      for (const task of tasks as Array<{ id: string; kind: string }>) {
        if (task.kind !== 'task') continue
        const widgets = await api.widgets.listByTask(task.id)
        n += (widgets as Array<{ kind: string }>).filter((w) => w.kind === 'sticky').length
      }
      return n === 1
    },
    null,
    { timeout: 6_000 }
  )
  console.log('[KB-1] stickies after keyboard create:', await stickyCount(launched))
  expect(await stickyCount(launched)).toBe(1)
})
