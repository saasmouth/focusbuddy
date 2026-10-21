// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// SMOKE TEST for the Caleb Focus-Mode integration (split-view + clusters +
// focus-chat), landed on integrate/caleb-focus-mode across commits b0e0e52,
// 37b6eaa, 41cabb0, c9f990b, fd73342.
//
// This is a plexidesk-tester smoke pass, not a permanent regression suite —
// left uncommitted per the dispatch brief. It answers exactly the operator's
// question:
//   1. Does focusing a widget open the new split-view Focus Mode without crashing?
//   2. Do the new IPC surfaces (clusters, aiChat) respond (resolve arrays)
//      rather than throw "no handler registered"?
//   3. Does the focus-nav next/prev cycle the focused widget?
//   4. Does the chat chrome tab open the FocusChatSurface without crashing?

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function setupTaskWithWidgets(
  window: LaunchedApp['window']
): Promise<{ taskId: string; widgetAId: string; widgetBId: string }> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Focus mode smoke test'
    })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Widget A',
      content: 'WIDGET-A',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    const b = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Widget B',
      content: 'WIDGET-B',
      x: 460,
      y: 160,
      width: 220,
      height: 180
    })
    return { taskId: task.id, widgetAId: a.id, widgetBId: b.id }
  })
}

async function openDesk(window: LaunchedApp['window'], title: string): Promise<void> {
  await window.getByRole('button', { name: title }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(800)
}

test('IPC surfaces: clusters.list and aiChat.listConversations resolve (API-driven)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { taskId } = await setupTaskWithWidgets(window)

  // Directly exercise the two new IPC namespaces the way the renderer stores
  // do (window.api.clusters / window.api.aiChat). If the main-process handler
  // were missing this would reject with "No handler registered for 'X'".
  const result = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const clusters = await api.clusters.list(tid)
    const conversations = await api.aiChat.listConversations()
    return {
      clustersIsArray: Array.isArray(clusters),
      clustersLength: clusters.length,
      conversationsIsArray: Array.isArray(conversations),
      conversationsLength: conversations.length
    }
  }, taskId)

  console.log('IPC smoke result:', JSON.stringify(result))

  expect(result.clustersIsArray).toBe(true)
  expect(result.clustersLength).toBe(0) // fresh DB, nothing saved yet
  expect(result.conversationsIsArray).toBe(true)
  expect(result.conversationsLength).toBe(0)
})

test('IPC surfaces: clusters.save persists and clusters.list returns it back (API-driven)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { taskId, widgetAId, widgetBId } = await setupTaskWithWidgets(window)

  const result = await window.evaluate(
    async ({ tid, aId, bId }: { tid: string; aId: string; bId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const draft = {
        taskId: tid,
        shape: 'halves' as const,
        panes: [
          { id: 'p1', cell: 'L' as const, source: { kind: 'widget' as const, widgetId: aId } },
          { id: 'p2', cell: 'R' as const, source: { kind: 'widget' as const, widgetId: bId } }
        ],
        ratios: { x: 0.5 },
        activePaneId: 'p1'
      }
      const saved = await api.clusters.save(draft)
      const listed = await api.clusters.list(tid)
      return { savedId: saved?.id, listedCount: listed.length, listedShape: listed[0]?.shape }
    },
    { tid: taskId, aId: widgetAId, bId: widgetBId }
  )

  console.log('Cluster save/list result:', JSON.stringify(result))

  expect(result.savedId).toBeTruthy()
  expect(result.listedCount).toBe(1)
  expect(result.listedShape).toBe('halves')
})

test('IPC surfaces: aiChat.createConversation persists and is listed back (API-driven)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { taskId } = await setupTaskWithWidgets(window)

  const result = await window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const created = await api.aiChat.createConversation({ taskId: tid, title: 'Smoke chat' })
    const listed = await api.aiChat.listConversations()
    const fetched = await api.aiChat.getConversation(created.id)
    return {
      createdId: created?.id,
      listedCount: listed.length,
      fetchedTitle: fetched?.meta?.title
    }
  }, taskId)

  console.log('AiChat create/list result:', JSON.stringify(result))

  expect(result.createdId).toBeTruthy()
  expect(result.listedCount).toBe(1)
  expect(result.fetchedTitle).toBe('Smoke chat')
})

test('UI: focusing a widget opens the split-view Focus Mode overlay without crashing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { widgetAId } = await setupTaskWithWidgets(window)

  await window.reload()
  await waitForReady(window)
  await openDesk(window, 'Focus mode smoke test')

  // Open the widget's "Expand options" popover, then click "Focus mode" — the
  // real entry point (WidgetFrame's ExpandControl -> onFocusMode -> setFocused).
  const widgetEl = window.locator(`[data-widget-id="${widgetAId}"]`).first()
  await expect(widgetEl).toBeVisible({ timeout: 5_000 })
  await widgetEl.hover()

  const expandBtn = widgetEl.locator('button[aria-label="Expand options"]')
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click({ force: true })

  const focusModeOption = window.getByText('Full view', { exact: true })
  await expect(focusModeOption).toBeVisible({ timeout: 3_000 })
  await focusModeOption.click({ force: true })

  // The new split-view overlay renders with this testid regardless of split
  // engagement (single-pane by default) — proves it opened without crashing.
  const overlay = window.locator('[data-testid="widget-focus-mode"]')
  await expect(overlay).toBeVisible({ timeout: 5_000 })

  // No uncaught renderer error should have surfaced (window title / error
  // boundary text would show if the new 952-line component threw on mount).
  const bodyText = await window.locator('body').innerText()
  expect(bodyText).not.toMatch(/Something went wrong|Uncaught|Cannot read propert/i)

  console.log('Focus Mode overlay opened successfully for widget', widgetAId)
})

test('UI: focus-nav next/prev cycles the focused widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { widgetAId, widgetBId } = await setupTaskWithWidgets(window)

  await window.reload()
  await waitForReady(window)
  await openDesk(window, 'Focus mode smoke test')

  // Enter focus mode via the store directly is not exposed; drive the same UI
  // path as the previous test to get into Focus Mode on widget A.
  const widgetEl = window.locator(`[data-widget-id="${widgetAId}"]`).first()
  await expect(widgetEl).toBeVisible({ timeout: 5_000 })
  await widgetEl.hover()
  await widgetEl.locator('button[aria-label="Expand options"]').click({ force: true })
  await window.getByText('Full view', { exact: true }).click({ force: true })

  const overlay = window.locator('[data-testid="widget-focus-mode"]')
  await expect(overlay).toBeVisible({ timeout: 5_000 })

  // Confirm widget A's content is showing inside focus mode before navigating.
  await expect(overlay.locator('text=WIDGET-A').first()).toBeVisible({ timeout: 3_000 })

  const nextBtn = window.locator('[data-testid="focus-nav-next"]')
  await expect(nextBtn).toBeVisible({ timeout: 3_000 })
  await nextBtn.click()

  // After navigating next, widget B's content should now be showing.
  await expect(overlay.locator('text=WIDGET-B').first()).toBeVisible({ timeout: 3_000 })

  const prevBtn = window.locator('[data-testid="focus-nav-prev"]')
  await expect(prevBtn).toBeVisible({ timeout: 3_000 })
  await prevBtn.click()

  // Navigating prev should return to widget A.
  await expect(overlay.locator('text=WIDGET-A').first()).toBeVisible({ timeout: 3_000 })

  console.log('focus-nav-next/prev cycled A -> B -> A successfully', { widgetAId, widgetBId })
})

test('UI: chat chrome tab opens FocusChatSurface without crashing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { widgetAId } = await setupTaskWithWidgets(window)

  await window.reload()
  await waitForReady(window)
  await openDesk(window, 'Focus mode smoke test')

  const widgetEl = window.locator(`[data-widget-id="${widgetAId}"]`).first()
  await expect(widgetEl).toBeVisible({ timeout: 5_000 })
  await widgetEl.hover()
  await widgetEl.locator('button[aria-label="Expand options"]').click({ force: true })
  await window.getByText('Full view', { exact: true }).click({ force: true })

  const overlay = window.locator('[data-testid="widget-focus-mode"]')
  await expect(overlay).toBeVisible({ timeout: 5_000 })

  const chatTab = window.locator('[data-testid="focus-dock-chrome-chat"]')
  await expect(chatTab).toBeVisible({ timeout: 5_000 })
  await chatTab.click()

  const chatSurface = window.locator('[data-testid="focus-chat-surface"]')
  await expect(chatSurface).toBeVisible({ timeout: 5_000 })

  const bodyText = await window.locator('body').innerText()
  expect(bodyText).not.toMatch(/Something went wrong|Uncaught|Cannot read propert/i)

  console.log('FocusChatSurface opened without crashing via focus-dock-chrome-chat')
})
