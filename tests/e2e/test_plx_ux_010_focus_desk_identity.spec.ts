// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// PLX-UX-010 — a full-screen focused widget (WidgetFocusMode, z-50) must not
// obscure the active desk's identity. A data-testid="focus-desk-identity"
// element carrying the desk's title must be present in BOTH:
//   1. the classic single-widget overlay (useGrid === false)
//   2. the grid/split header (useGrid === true, >=2 panes engaged)
//
// Landed in WidgetFocusMode.tsx (commit 81e0b78). Entering split mode via a
// real drag-and-drop gesture is unreliable to drive in Playwright, so the
// cluster is seeded through the same window.api.clusters IPC surface the
// dock's drag-drop path itself persists to (see _focusModeSmoke.spec.ts for
// precedent) — the cluster-on-entry effect then opens it deterministically
// the moment a member widget is focused. Everything else (opening the desk,
// opening focus mode) is driven through real UI clicks.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function setup(window: LaunchedApp['window']): Promise<{
  taskId: string
  widgetAId: string
  widgetBId: string
  deskTitle: string
}> {
  const deskTitle = 'UX-010 identity desk'
  return window.evaluate(async (title: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title })
    const a = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'Widget A', content: 'WIDGET-A',
      x: 160, y: 160, width: 220, height: 180
    })
    const b = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'Widget B', content: 'WIDGET-B',
      x: 460, y: 160, width: 220, height: 180
    })
    return { taskId: task.id, widgetAId: a.id, widgetBId: b.id, deskTitle: title }
  }, deskTitle)
}

async function openDesk(window: LaunchedApp['window'], title: string): Promise<void> {
  await window.getByRole('button', { name: title }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(500)
}

async function openFocusModeOn(window: LaunchedApp['window'], widgetId: string): Promise<void> {
  const widgetEl = window.locator(`[data-widget-id="${widgetId}"]`).first()
  await expect(widgetEl).toBeVisible({ timeout: 5_000 })
  await widgetEl.hover()
  const expandBtn = widgetEl.locator('button[aria-label="Expand options"]')
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click({ force: true })
  const focusModeOption = window.getByText('Full view', { exact: true })
  await expect(focusModeOption).toBeVisible({ timeout: 3_000 })
  await focusModeOption.click({ force: true })
}

test('test_plx_ux_010_single_widget_overlay_shows_desk_identity', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Only widget A on this desk, unclustered, so focus mode renders the
  // classic single-widget overlay (useGrid === false).
  const { taskId, deskTitle } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const title = 'UX-010 solo desk'
    const task = await api.nodes.create({ parentId: null, kind: 'task', title })
    const a = await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'Solo widget', content: 'SOLO',
      x: 160, y: 160, width: 220, height: 180
    })
    return { taskId: task.id, widgetAId: a.id, deskTitle: title }
  })
  void taskId

  await window.reload()
  await waitForReady(window)
  await openDesk(window, deskTitle)

  const widgetEl = window.locator('[data-widget-id]').first()
  const widgetId = await widgetEl.getAttribute('data-widget-id')
  await openFocusModeOn(window, widgetId!)

  const overlay = window.locator('[data-testid="widget-focus-mode"]')
  await expect(overlay).toBeVisible({ timeout: 5_000 })

  // Single-widget overlay: not in grid mode.
  const identity = overlay.locator('[data-testid="focus-desk-identity"]')
  await expect(identity).toBeVisible({ timeout: 4_000 })
  await expect(identity).toContainText(deskTitle)

  console.log('Single-widget overlay showed desk identity:', deskTitle)
})

test('test_plx_ux_010_grid_split_header_shows_desk_identity', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { widgetAId, widgetBId, deskTitle } = await setup(window)

  await window.reload()
  await waitForReady(window)
  await openDesk(window, deskTitle)
  await openFocusModeOn(window, widgetAId)

  const overlay = window.locator('[data-testid="widget-focus-mode"]')
  await expect(overlay).toBeVisible({ timeout: 5_000 })
  // Confirm we start single-pane (not grid) before driving the split gesture.
  await expect(overlay.locator('[data-testid="focus-nav-next"]')).toBeVisible({ timeout: 4_000 })

  // Drive the REAL split gesture: drag widget B's dock tile up into the card
  // body. This is a pointer-based custom drag (focusSplitDrag.tsx), not
  // native HTML5 DnD, so real Playwright mouse move/down/up events drive it
  // reliably. This engages a genuine 2-pane split via the same store path a
  // real user's drag takes (splitAddPane), sidestepping any need to seed a
  // persisted cluster out of band.
  const dockTile = window.locator(`[data-testid="focus-dock-tile-${widgetBId}"]`)
  await expect(dockTile).toBeVisible({ timeout: 4_000 })
  const tileBox = await dockTile.boundingBox()
  const card = overlay.locator('[data-focus-card]')
  const cardBox = await card.boundingBox()
  if (!tileBox || !cardBox) throw new Error('could not measure dock tile / card bounding boxes')

  const dropX = cardBox.x + cardBox.width * 0.75
  const dropY = cardBox.y + cardBox.height * 0.5

  await window.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2)
  await window.mouse.down()
  // Multiple intermediate steps: clear the drag-promotion threshold and let
  // the live hit-test (which reads real rendered rects on each pointermove)
  // settle on the target cell before release.
  await window.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y - 40, { steps: 5 })
  await window.mouse.move(dropX, dropY, { steps: 10 })
  await window.waitForTimeout(150)
  await window.mouse.up()

  // Split now engaged (2 panes) — the grid header replaces the classic card header.
  await expect(overlay.getByText(/Split · 2 panes/)).toBeVisible({ timeout: 5_000 })

  const identity = overlay.locator('[data-testid="focus-desk-identity"]')
  await expect(identity).toBeVisible({ timeout: 4_000 })
  await expect(identity).toContainText(deskTitle)

  console.log('Grid/split header showed desk identity:', deskTitle)
})
