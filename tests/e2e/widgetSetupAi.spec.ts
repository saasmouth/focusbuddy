import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Per-widget AI setup ("Build with AI"), end to end on a sticky: the context
// menu opens the preview, the mocked draft renders as tickable items, and Add
// appends the approved ones to the sticky in checklist format.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedSticky(l: LaunchedApp, content: string, taskTitle: string): Promise<string> {
  const { window } = l
  await waitForReady(window)
  return window.evaluate(
    async ({ content, taskTitle }: { content: string; taskTitle: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: taskTitle })
      const w = await api.widgets.create({
        taskId: t.id,
        kind: 'sticky',
        title: '',
        content,
        x: 140,
        y: 140,
        width: 320,
        height: 280
      })
      return w.id
    },
    { content, taskTitle }
  )
}

async function openTask(l: LaunchedApp, taskTitle: string): Promise<void> {
  const { window } = l
  await waitForReady(window)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(taskTitle) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
}

async function readContent(l: LaunchedApp, widgetId: string): Promise<string> {
  return l.window.evaluate(async (wid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const tasks = await api.nodes.list()
    for (const task of tasks as Array<{ id: string; kind: string }>) {
      if (task.kind !== 'task') continue
      const widgets = await api.widgets.listByTask(task.id)
      const w = (widgets as Array<{ id: string; content?: string }>).find((x) => x.id === wid)
      if (w) return w.content ?? ''
    }
    return ''
  }, widgetId)
}

test('AS-1 — Build with AI drafts items, approve and add appends a checklist', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedSticky(launched, 'Launch plan', 'BuildWithAiTest')
  await openTask(launched, 'BuildWithAiTest')

  // Mock the generator in the MAIN process (the renderer api is frozen).
  await launched.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:suggestWidgetSetup')
    ipcMain.handle('ai:suggestWidgetSetup', async () => ({
      ok: true,
      kind: 'sticky',
      applyAs: 'sticky-checklist',
      noun: 'tasks',
      items: [
        { id: 's0', text: 'Book the venue' },
        { id: 's1', text: 'Email the speakers' },
        { id: 's2', text: 'Draft the run sheet' }
      ]
    }))
  })

  // Enter edit mode and open the unified menu from the sticky textarea.
  await window.waitForSelector(`[data-widget-id="${widgetId}"] .fb-sticky-rendered`, { timeout: 8_000 })
  await window.click(`[data-widget-id="${widgetId}"] .fb-sticky-rendered`)
  await window.waitForSelector(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`, { timeout: 4_000 })
  await window.click(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`, { button: 'right' })
  await window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4_000 })

  // Click "Build with AI" inside the context menu (the task toolbar also has a
  // button of the same name, so scope to the menu).
  await window.locator('[data-canvas-ctx-menu]').getByText('Build with AI', { exact: true }).click()

  // Preview opens and shows the drafted items.
  await window.waitForSelector('[data-testid="widget-setup-preview"]', { timeout: 4_000 })
  await window.waitForSelector('[data-testid="widget-setup-items"]', { timeout: 6_000 })
  const itemsText = await window.evaluate(
    () => (document.querySelector('[data-testid="widget-setup-items"]') as HTMLElement)?.innerText ?? ''
  )
  console.log('[AS-1] drafted items:', JSON.stringify(itemsText))
  expect(itemsText).toContain('Book the venue')

  // Untick the second item, then Add.
  await window.click('[data-testid="widget-setup-item-s1"]')
  await window.click('[data-testid="widget-setup-add"]')

  await window.waitForFunction(
    async (wid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const tasks = await api.nodes.list()
      for (const task of tasks as Array<{ id: string; kind: string }>) {
        if (task.kind !== 'task') continue
        const widgets = await api.widgets.listByTask(task.id)
        const w = (widgets as Array<{ id: string; content?: string }>).find((x) => x.id === wid)
        if (w) return (w.content ?? '').includes('[ ] Book the venue')
      }
      return false
    },
    widgetId,
    { timeout: 6_000 }
  )

  const after = await readContent(launched, widgetId)
  console.log('[AS-1] sticky content after add:', JSON.stringify(after))
  // The original text is preserved, the two ticked items are appended as a
  // checklist, and the unticked item is absent.
  expect(after).toContain('Launch plan')
  expect(after).toContain('[ ] Book the venue')
  expect(after).toContain('[ ] Draft the run sheet')
  expect(after).not.toContain('Email the speakers')
})
