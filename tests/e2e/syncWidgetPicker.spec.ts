import { test, expect } from '@playwright/test'
import { hoverToolbar, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Phase 4: "Bring a synced widget from another task." From task B, the +Add
// palette → "Bring a synced widget…" → pick task A → pick its sticky → a
// live-linked copy lands on B sharing the source's syncGroupId.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('bring a synced widget from another task onto this canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const a = await api.nodes.create({ parentId: null, kind: 'task', title: 'Source task A' })
    const b = await api.nodes.create({ parentId: null, kind: 'task', title: 'Target task B' })
    const src = await api.widgets.create({
      taskId: a.id,
      kind: 'sticky',
      title: 'src',
      content: 'SYNC-SOURCE-NOTE',
      x: 120,
      y: 120,
      width: 200,
      height: 160
    })
    return { taskA: a.id, taskB: b.id, srcId: src.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Target task B/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)

  // Open the + Add palette → "Bring a synced widget…"
  // The rail only mounts the palette while hovered — see hoverToolbar.
  await hoverToolbar(window)
  await window.locator('[data-testid="palette-add-button"]').click()
  await window.waitForTimeout(200)
  await window.locator('[data-testid="palette-bring-synced"]').click()
  await expect(window.locator('[data-testid="sync-widget-picker"]')).toBeVisible()

  // Pick task A, then its sticky.
  await window.locator(`[data-testid="sync-pick-task-${seeded.taskA}"]`).click()
  await window.waitForTimeout(300)
  await window.locator(`[data-testid="sync-pick-widget-${seeded.srcId}"]`).click()
  await window.waitForTimeout(600)

  // Target B now has a synced copy of the sticky; both share a syncGroupId.
  const result = await window.evaluate(
    async ({ taskA, taskB, srcId }: { taskA: string; taskB: string; srcId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const bWidgets = await api.widgets.listByTask(taskB)
      const aWidgets = await api.widgets.listByTask(taskA)
      const copy = bWidgets.find((w) => w.kind === 'sticky' && w.content === 'SYNC-SOURCE-NOTE')
      const source = aWidgets.find((w) => w.id === srcId)
      return {
        copyGroup: copy?.syncGroupId ?? null,
        sourceGroup: source?.syncGroupId ?? null,
        copyContent: copy?.content ?? null
      }
    },
    seeded
  )

  expect(result.copyContent).toBe('SYNC-SOURCE-NOTE')
  expect(result.copyGroup).not.toBeNull()
  expect(result.copyGroup).toBe(result.sourceGroup) // linked
})
