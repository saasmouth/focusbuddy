import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Desk time-travel: snapshots of a desk can be previewed, restored (reversibly),
// and branched into a new task. We seed snapshots explicitly via the API so the
// test doesn't wait on the 6s debounced auto-recorder.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function hideAssistant(window: LaunchedApp['window']): Promise<void> {
  const btn = window.getByRole('button', { name: 'Hide assistant panel' })
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {})
  await window.waitForTimeout(150)
}

async function openHistory(window: LaunchedApp['window']): Promise<void> {
  // The header's open-history button went with the header bar in c48d0360;
  // History is the first row of the floating toolbar, revealed on hover.
  await window.locator('[data-testid="floating-toolbar"]').hover()
  await window.getByTitle(/^Desk history/).click()
}

async function stickyContent(
  window: LaunchedApp['window'],
  taskId: string,
  stickyId: string
): Promise<string | undefined> {
  return window.evaluate(
    async ({ taskId, stickyId }: { taskId: string; stickyId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(taskId)
      return ws.find((w) => w.id === stickyId)?.content
    },
    { taskId, stickyId }
  )
}

test('restore brings a past desk state back', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'TT restore' })
    const sticky = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'note',
      content: 'STATE-A',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    // Snapshot the STATE-A desk, then change the desk to STATE-B.
    await api.snapshots.create(task.id)
    await api.widgets.update(sticky.id, { content: 'STATE-B' })
    return { taskId: task.id, stickyId: sticky.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /TT restore/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await hideAssistant(window)

  expect(await stickyContent(window, ids.taskId, ids.stickyId)).toBe('STATE-B')

  // Open time travel; the only snapshot is the STATE-A desk and is auto-selected.
  await openHistory(window)
  await expect(window.locator('[data-testid="history-panel"]')).toBeVisible()
  await expect(window.locator('[data-testid="history-preview"]')).toContainText('STATE-A', {
    timeout: 5_000
  })

  // Restore it → the live desk reverts to STATE-A.
  await window.locator('[data-testid="history-restore"]').click()
  await expect
    .poll(() => stickyContent(window, ids.taskId, ids.stickyId), {
      timeout: 8_000,
      intervals: [300, 600]
    })
    .toBe('STATE-A')
})

test('branch creates a new desk from a snapshot and dives into it', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'TT branch' })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'note',
      content: 'BRANCH-SEED',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    await api.snapshots.create(task.id)
    return task.id
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /TT branch/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await hideAssistant(window)

  await openHistory(window)
  await expect(window.locator('[data-testid="history-panel"]')).toBeVisible()
  await window.locator('[data-testid="history-branch"]').click()

  // The canvas switches to the new branched desk.
  // The desk's name is on the desk context trigger since 4148318a (no breadcrumb).
  await expect(window.locator('[data-testid="desk-context-trigger"]')).toContainText('(branch)', {
    timeout: 6_000
  })
  // And the branched desk carries a copy of the seed content.
  const hasCopy = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    const branch = nodes.find((n) => n.title.includes('(branch)'))
    if (!branch) return false
    const ws = await api.widgets.listByTask(branch.id)
    return ws.some((w) => w.content === 'BRANCH-SEED')
  })
  expect(hasCopy).toBe(true)
})
