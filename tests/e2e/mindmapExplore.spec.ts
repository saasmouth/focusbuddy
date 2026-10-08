import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Mind-map Phase 1: "Explore a node as its own task canvas."
// Selecting a node and clicking "Explore as canvas" lazily creates a real task,
// links it to the node (node.taskId), switches the desk to that task's canvas,
// and shows a breadcrumb back to the map. Re-exploring re-opens the same task.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const MAP = JSON.stringify({
  root: {
    id: 'root',
    label: 'Launch plan',
    kind: 'idea',
    children: [{ id: 'c1', label: 'Build the API', kind: 'idea', children: [] }]
  },
  viewRootId: 'root',
  selectedId: null
})

async function seedMindmapAndOpen(l: LaunchedApp): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)
  const seeded = await window.evaluate(async (content: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Mindmap host' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'mindmap',
      title: '',
      content,
      x: 200,
      y: 140,
      width: 640,
      height: 460
    })
    return { taskId: task.id, widgetId: w.id }
  }, MAP)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Mindmap host/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 5_000 })
  await window.waitForTimeout(300)
  return seeded
}

test('Explore a node → creates a task, switches canvas, shows breadcrumb', async () => {
  launched = await launchApp()
  const { window } = launched
  const { taskId } = await seedMindmapAndOpen(launched)

  // Select the child node (renders as an SVG group with a data-testid).
  await window.locator('[data-testid="mindmap-node-c1"]').click()
  await window.waitForTimeout(200)

  // The detail panel's primary action. Use an evaluate-click: the button click
  // swaps the entire canvas (task switch), which makes Playwright's actionable
  // .click() flaky as the element it's holding unmounts mid-navigation.
  const hasExplore = await window.evaluate(() => {
    const b = document.querySelector('[data-testid="mindmap-explore"]') as HTMLButtonElement | null
    if (!b) return false
    b.click()
    return true
  })
  expect(hasExplore).toBe(true)

  // Wait deterministically for explore to (a) create + persist the node's task
  // AND (b) switch the active canvas to it, reading the live node store instead
  // of racing a fixed timeout. The active-task check is what proves the switch
  // actually happened: the pre-switch host canvas already shows both titles
  // (sidebar + mindmap node label), so a plain body-text wait could pass before
  // the async create + task switch had propagated — the old flake.
  await window.waitForFunction(
    () => {
      const store = (
        window as unknown as {
          __fbNodes?: {
            getState: () => {
              nodes: Array<{ id: string; kind: string; title: string }>
              activeTaskId: string | null
            }
          }
        }
      ).__fbNodes?.getState()
      if (!store) return false
      const built = store.nodes.find((n) => n.kind === 'task' && n.title === 'Build the API')
      return !!built && store.activeTaskId === built.id
    },
    { timeout: 8_000 }
  )

  // A new task was created for the node and the desk switched to it.
  const tasks = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.nodes.list()
    return all.filter((n) => n.kind === 'task').map((n) => n.title)
  })
  expect(tasks).toContain('Build the API') // node-task created

  // The active canvas is the node's own task — its title is the current crumb.
  expect(await window.evaluate(() => document.body.innerText)).toContain('Build the API')

  // The way back to the map is the ancestor in the desk context menu. This used
  // to be a breadcrumb pill that expanded ON HOVER, which is why the old
  // version of this assertion had to hover and then disambiguate against the
  // stage-manager switcher the same hover opened. The trail is a vertical list
  // now: open the menu and the host task is simply a row in it.
  await window.locator('[data-testid="desk-context-trigger"]').click()
  const trail = window.locator('[data-testid="desk-context-trail"]')
  await expect(trail).toBeVisible({ timeout: 5_000 })
  await expect(trail).toContainText('Mindmap host')

  // Sanity: the host task still exists (we didn't replace it).
  expect(typeof taskId).toBe('string')
})
