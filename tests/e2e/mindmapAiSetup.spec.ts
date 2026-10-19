import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Build with AI on a mind map: the unified menu opens on the mind map body, the
// mocked draft of branch labels is approved, and they are appended to the mind
// map's native JSON as root children and rendered live (content-sync).

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedMindmap(l: LaunchedApp, taskTitle: string): Promise<string> {
  const { window } = l
  await waitForReady(window)
  return window.evaluate(async ({ taskTitle }: { taskTitle: string }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: taskTitle })
    const w = await api.widgets.create({
      taskId: t.id,
      kind: 'mindmap',
      title: '',
      content: '',
      x: 120,
      y: 120,
      width: 560,
      height: 420
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

test('MM-AI — Build with AI appends approved branches as native mind-map nodes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const widgetId = await seedMindmap(launched, 'MindMapAiTest')
  await openTask(launched, 'MindMapAiTest')

  await launched.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:suggestWidgetSetup')
    ipcMain.handle('ai:suggestWidgetSetup', async () => ({
      ok: true,
      kind: 'mindmap',
      applyAs: 'mindmap-nodes',
      noun: 'branches',
      items: [
        { id: 's0', text: 'Marketing' },
        { id: 's1', text: 'Pricing' },
        { id: 's2', text: 'Hiring' }
      ]
    }))
  })

  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 8_000 })
  // Right-click the mind map body to open the unified menu.
  await window.click(`[data-widget-id="${widgetId}"]`, { button: 'right', position: { x: 280, y: 240 } })
  await window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4_000 })
  await window.locator('[data-canvas-ctx-menu]').getByText('Build with AI', { exact: true }).click()

  await window.waitForSelector('[data-testid="widget-setup-items"]', { timeout: 6_000 })
  // Drop the third branch, keep the first two.
  await window.click('[data-testid="widget-setup-item-s2"]')
  await window.click('[data-testid="widget-setup-add"]')

  await window.waitForFunction(
    async (wid: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const tasks = await api.nodes.list()
      for (const task of tasks as Array<{ id: string; kind: string }>) {
        if (task.kind !== 'task') continue
        const widgets = await api.widgets.listByTask(task.id)
        const w = (widgets as Array<{ id: string; content?: string }>).find((x) => x.id === wid)
        if (w) return (w.content ?? '').includes('Marketing')
      }
      return false
    },
    widgetId,
    { timeout: 6_000 }
  )

  const after = await readContent(launched, widgetId)
  const parsed = JSON.parse(after)
  const labels = parsed.root.children.map((c: { label: string }) => c.label)
  console.log('[MM-AI] mind map root children:', JSON.stringify(labels))
  expect(labels).toContain('Marketing')
  expect(labels).toContain('Pricing')
  expect(labels).not.toContain('Hiring')
  // Each appended node is a well-formed mind-map node with a unique id.
  const ids = parsed.root.children.map((c: { id: string }) => c.id)
  expect(new Set(ids).size).toBe(ids.length)

  // The new branches render live without a reload (content-sync).
  await expect(window.locator(`[data-widget-id="${widgetId}"]`)).toContainText('Marketing', {
    timeout: 4_000
  })
})
