import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The unified context menu, exercised end to end on a Note: the menu opens with
// the canonical sections, AI Assist runs through a mocked transform, and Apply
// writes the result back in place.

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
  const r = await window.evaluate(
    async ({ content, taskTitle }: { content: string; taskTitle: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: taskTitle })
      const w = await api.widgets.create({
        taskId: t.id,
        kind: 'note',
        title: '',
        content,
        x: 120,
        y: 120,
        width: 460,
        height: 320
      })
      return w.id
    },
    { content, taskTitle }
  )
  return r
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

test('CM-1 — unified menu opens on a note with the canonical sections', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedNote(launched, 'the quick brown fox jumps', 'CtxMenuTest')
  await openTask(launched, 'CtxMenuTest')

  // Enter edit mode (the textarea is what carries the content context menu).
  await window.waitForSelector(`[data-widget-id="${widgetId}"] .fb-note-rendered`, { timeout: 8_000 })
  await window.click(`[data-widget-id="${widgetId}"] .fb-note-rendered`)
  await window.waitForSelector(`[data-widget-id="${widgetId}"] textarea`, { timeout: 4_000 })

  await window.click(`[data-widget-id="${widgetId}"] textarea`, { button: 'right' })
  await window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4_000 })

  const menuText = await window.evaluate(
    () => (document.querySelector('[data-canvas-ctx-menu]') as HTMLElement)?.innerText ?? ''
  )
  console.log('[CM-1] menu text:', JSON.stringify(menuText))
  expect(menuText).toContain('AI assist')
  // §9.3: Create & link lives under More actions (the eight-row ceiling, E-6).
  expect(menuText).toContain('More actions')
  // Destructive present (Archive or Delete or a Remove parent).
  expect(/Archive|Delete|Remove/.test(menuText)).toBe(true)
})

test('CM-2 — AI Assist runs a transform and Apply writes it back in place', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedNote(launched, 'the quick brown fox jumps', 'AiAssistApply')
  await openTask(launched, 'AiAssistApply')

  // Mock the model in the MAIN process so the test is deterministic and
  // offline. The renderer api is a frozen contextBridge object, so the only
  // reliable interception point is the IPC handler itself.
  await launched.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:transformText')
    ipcMain.handle('ai:transformText', async () => ({ ok: true, result: 'A fox jumps.' }))
  })

  await window.waitForSelector(`[data-widget-id="${widgetId}"] .fb-note-rendered`, { timeout: 8_000 })
  await window.click(`[data-widget-id="${widgetId}"] .fb-note-rendered`)
  await window.waitForSelector(`[data-widget-id="${widgetId}"] textarea`, { timeout: 4_000 })
  await window.click(`[data-widget-id="${widgetId}"] textarea`, { button: 'right' })
  await window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4_000 })

  // Open the AI Assist submenu and pick a preset action.
  await window.getByText('AI assist', { exact: true }).hover()
  await window.getByText('Summarise', { exact: true }).click()

  // The preview opens and the preset auto-runs against the mock.
  await window.waitForSelector('[data-testid="ai-assist-preview"]', { timeout: 4_000 })
  await window.waitForSelector('[data-testid="ai-assist-result"]', { timeout: 6_000 })
  const resultText = await window.evaluate(
    () => (document.querySelector('[data-testid="ai-assist-result"]') as HTMLElement)?.innerText ?? ''
  )
  console.log('[CM-2] result text:', JSON.stringify(resultText))
  expect(resultText).toContain('A fox jumps.')

  await window.click('[data-testid="ai-assist-apply"]')

  // Wait for the write-back to land in the store.
  await window.waitForFunction(
    async (wid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const tasks = await api.nodes.list()
      for (const task of tasks as Array<{ id: string; kind: string }>) {
        if (task.kind !== 'task') continue
        const widgets = await api.widgets.listByTask(task.id)
        const w = (widgets as Array<{ id: string; content?: string }>).find((x) => x.id === wid)
        if (w) return (w.content ?? '').includes('A fox jumps.')
      }
      return false
    },
    widgetId,
    { timeout: 6_000 }
  )

  const after = await readContent(launched, widgetId)
  console.log('[CM-2] note content after apply:', JSON.stringify(after))
  expect(after).toBe('A fox jumps.')
})
