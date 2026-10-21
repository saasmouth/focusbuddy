// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// SCREENSHOT CAPTURE for the operator — "I can't see any difference" between
// old and new Focus Mode. This spec is a plexidesk-tester evidence pass, not a
// permanent regression suite — left uncommitted per the dispatch brief.
//
// Produces three PNGs in test-results/:
//   focus-single.png  — a widget focused, dock visible with Add/AI Chat tabs
//   focus-chat.png    — the AI Chat chrome tab open inside focus mode
//   focus-split.png   — a real 2-pane split, engaged via a genuine pointer
//                        drag of a dock tile into the body (same gesture a
//                        real user performs — NOT a store shortcut)

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function setupTaskWithWidgets(
  window: LaunchedApp['window']
): Promise<{ taskId: string; widgetAId: string; widgetBId: string; widgetCId: string }> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Focus mode screenshot desk'
    })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Roadmap notes',
      content: 'Ship the split-view focus mode rebuild this week.',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    const b = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Open questions',
      content: 'Does the dock read as new chrome, or blend into the old card?',
      x: 460,
      y: 160,
      width: 220,
      height: 180
    })
    const c = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Third widget',
      content: 'Just here to prove the dock scrolls with 3+ tiles.',
      x: 760,
      y: 160,
      width: 220,
      height: 180
    })
    return { taskId: task.id, widgetAId: a.id, widgetBId: b.id, widgetCId: c.id }
  })
}

async function openDesk(window: LaunchedApp['window'], title: string): Promise<void> {
  await window.getByRole('button', { name: title }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(800)
}

async function enterFocusMode(window: LaunchedApp['window'], widgetId: string): Promise<void> {
  const widgetEl = window.locator(`[data-widget-id="${widgetId}"]`).first()
  await expect(widgetEl).toBeVisible({ timeout: 5_000 })
  await widgetEl.hover()
  const expandBtn = widgetEl.locator('button[aria-label="Expand options"]')
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click({ force: true })
  const focusModeOption = window.getByText('Full view', { exact: true })
  await expect(focusModeOption).toBeVisible({ timeout: 3_000 })
  await focusModeOption.click({ force: true })
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toBeVisible({ timeout: 5_000 })
}

test('capture Focus Mode screenshots: single, chat, split (UI-driven)', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { widgetAId, widgetBId } = await setupTaskWithWidgets(window)

  await window.reload()
  await waitForReady(window)
  await openDesk(window, 'Focus mode screenshot desk')

  // ── 1. Enter Focus Mode on widget A (single view) ────────────────────────
  await enterFocusMode(window, widgetAId)

  const dock = window.locator('[data-testid="widget-focus-dock"]')
  await expect(dock).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="focus-dock-chrome-add"]')).toBeVisible()
  await expect(window.locator('[data-testid="focus-dock-chrome-chat"]')).toBeVisible()
  // Let the entry spring settle before capturing.
  await window.waitForTimeout(500)
  await window.screenshot({ path: 'test-results/focus-single.png' })
  console.log('Saved test-results/focus-single.png')

  // ── 2. Open the AI Chat chrome tab ────────────────────────────────────────
  const chatTab = window.locator('[data-testid="focus-dock-chrome-chat"]')
  await chatTab.click()
  const chatSurface = window.locator('[data-testid="focus-chat-surface"]')
  await expect(chatSurface).toBeVisible({ timeout: 5_000 })
  await window.waitForTimeout(500)
  await window.screenshot({ path: 'test-results/focus-chat.png' })
  console.log('Saved test-results/focus-chat.png')

  // Return to widget A before attempting the split drag (leaves the chat tab).
  const tileA = window.locator(`[data-testid="focus-dock-tile-${widgetAId}"]`)
  await tileA.click()
  await expect(window.locator(`text=Roadmap notes`).first()).toBeVisible({ timeout: 3_000 })

  // ── 3. Engage split by dragging widget B's dock tile up into the body ────
  // Real pointer gesture: mouse down on the dock tile, move past the drag
  // threshold, move into the body/stage region, release. This is the same
  // gesture WidgetFocusDock's onPointerDown -> useSplitDrag.beginDrag expects.
  const tileB = window.locator(`[data-testid="focus-dock-tile-${widgetBId}"]`)
  await expect(tileB).toBeVisible({ timeout: 5_000 })
  const tileBox = await tileB.boundingBox()
  if (!tileBox) throw new Error('dock tile B has no bounding box')
  const startX = tileBox.x + tileBox.width / 2
  const startY = tileBox.y + tileBox.height / 2

  // Target: right-of-center in the stage area, well inside the padded body,
  // so the drop resolves to a real well cell (halves split, B on the right).
  const viewport = window.viewportSize() ?? { width: 1440, height: 900 }
  const targetX = viewport.width * 0.72
  const targetY = viewport.height * 0.5

  await window.mouse.move(startX, startY)
  await window.mouse.down()
  // Step through intermediate points so pointermove fires enough times to
  // clear the 6px drag threshold and let React state (and the drop-zone
  // preview) catch up before release.
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await window.mouse.move(startX + (targetX - startX) * t, startY + (targetY - startY) * t)
    await window.waitForTimeout(40)
  }
  await window.waitForTimeout(200)
  await window.mouse.up()

  // Two grid elements can be present briefly (a preview ghost + the real
  // committed grid) — target the committed one (data-previewing="false").
  const splitGrid = window.locator('[data-testid="focus-split-grid"][data-previewing="false"]')
  await expect(splitGrid).toBeVisible({ timeout: 5_000 })
  // Both source widgets' content should now be visible as two live panes.
  await expect(window.locator('text=Roadmap notes').first()).toBeVisible({ timeout: 3_000 })
  await expect(window.locator('text=Open questions').first()).toBeVisible({ timeout: 3_000 })
  await window.waitForTimeout(500)
  await window.screenshot({ path: 'test-results/focus-split.png' })
  console.log('Saved test-results/focus-split.png')

  const bodyText = await window.locator('body').innerText()
  expect(bodyText).not.toMatch(/Something went wrong|Uncaught|Cannot read propert/i)
})
