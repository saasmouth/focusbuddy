import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// FOCUSED re-check for commit 7681a3e ("FloatingPill: anchor below the desk
// header, not level with it"). Verifies the fix holds at the exact long-title
// length that reproduced the prior 33% overlap. plexidesk-tester evidence
// pass, not a permanent regression suite — left uncommitted per the dispatch
// brief.

const LONG_TITLE = 'Single-AI-context verification desk' // 36 chars — the failing repro length

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): { overlaps: boolean; area: number } {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const area = overlapX * overlapY
  return { overlaps: area > 0, area }
}

test('FloatingPill sits strictly below breadcrumb + header at long desk title (UI-driven)', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const { window } = launched

  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

  await waitForReady(window)

  // 1. Create the desk with the long title, seed widgets so the load ring renders.
  const taskId = await window.evaluate(async (title) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Sticky one',
      content: 'First widget so the desk chrome is populated.',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Sticky two',
      content: 'Second widget.',
      x: 460,
      y: 160,
      width: 220,
      height: 180
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'Note widget',
      content: 'Third widget, a different kind.',
      x: 160,
      y: 420,
      width: 240,
      height: 160
    })
    return task.id
  }, LONG_TITLE)

  await window.reload()
  await waitForReady(window)

  // 2. Open the desk.
  await window.getByRole('button', { name: LONG_TITLE }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(800)

  const widgetsOnSurface = await window.locator('[data-widget-id]').count()
  console.log('widgets rendered on surface:', widgetsOnSurface)
  expect(widgetsOnSurface).toBeGreaterThanOrEqual(3)

  const laterBtn = window.getByRole('button', { name: 'Later' })
  if (await laterBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await laterBtn.click().catch(() => {})
    await window.waitForTimeout(300)
  }

  const breadcrumb = window.locator('[data-testid="desk-context-trigger"]')
  const header = window.locator('[data-testid="canvas-task-header"]')
  const floatingPill = window.locator('[data-testid="floating-pill"]')

  await expect(breadcrumb).toBeVisible({ timeout: 5_000 })
  await expect(header).toBeVisible({ timeout: 5_000 })
  await expect(floatingPill).toBeVisible({ timeout: 5_000 })

  const deskTitleEl = window.locator('[data-testid="desk-title"]')
  const deskTitleText = (await deskTitleEl.textContent().catch(() => ''))?.trim()
  console.log('desk title rendered as:', JSON.stringify(deskTitleText), 'length:', LONG_TITLE.length)
  expect(deskTitleText).toBe(LONG_TITLE)

  // 3. Hover the pill to expand it fully.
  await floatingPill.hover()
  await window.waitForTimeout(500)

  // Confirm expanded actions are present while hovered.
  const tidyVisible = await window.locator('[data-testid="pill-tidy"]').isVisible().catch(() => false)
  const buildVisible = await window.locator('[data-testid="pill-build"]').isVisible().catch(() => false)
  const saveVisible = await window.locator('[data-testid="pill-save-template"]').isVisible().catch(() => false)
  const zoomVisible = await window.locator('[data-testid="pill-zoom"]').isVisible().catch(() => false)
  console.log('pill actions visible while expanded:', {
    tidyVisible,
    buildVisible,
    saveVisible,
    zoomVisible
  })

  // 4. Measure bounding boxes.
  const bcBox = await breadcrumb.boundingBox()
  const headerBox = await header.boundingBox()
  const pillBox = await floatingPill.boundingBox()

  console.log('breadcrumb box:', JSON.stringify(bcBox))
  console.log('header box:', JSON.stringify(headerBox))
  console.log('FloatingPill box (expanded):', JSON.stringify(pillBox))

  await window.screenshot({ path: 'test-results/pill-longtitle.png' })
  console.log('Saved test-results/pill-longtitle.png')

  const viewport = window.viewportSize() ?? { width: 1440, height: 900 }

  await window.mouse.move(viewport.width / 2, viewport.height / 2)
  await window.waitForTimeout(300)

  const bodyText = await window.locator('body').innerText()
  const errorBoundaryHit = /Something went wrong|Uncaught|Cannot read propert/i.test(bodyText)
  console.log('error boundary text present:', errorBoundaryHit)
  console.log('console errors captured:', JSON.stringify(consoleErrors, null, 2))

  expect(errorBoundaryHit).toBe(false)
  expect(bcBox).not.toBeNull()
  expect(headerBox).not.toBeNull()
  expect(pillBox).not.toBeNull()

  if (bcBox && headerBox && pillBox) {
    const vsBreadcrumb = rectsOverlap(pillBox, bcBox)
    const vsHeader = rectsOverlap(pillBox, headerBox)
    console.log('pill vs breadcrumb overlap area (px^2, must be 0):', vsBreadcrumb.area)
    console.log('pill vs header overlap area (px^2, must be 0):', vsHeader.area)

    // Pill must sit strictly below both chrome pills (top edge >= their bottom edge).
    const pillTop = pillBox.y
    const bcBottom = bcBox.y + bcBox.height
    const headerBottom = headerBox.y + headerBox.height
    console.log('pill top:', pillTop, 'breadcrumb bottom:', bcBottom, 'header bottom:', headerBottom)

    expect(vsBreadcrumb.overlaps).toBe(false)
    expect(vsHeader.overlaps).toBe(false)
    expect(pillTop).toBeGreaterThanOrEqual(bcBottom)
    expect(pillTop).toBeGreaterThanOrEqual(headerBottom)

    // Sanity: pill fully on-screen, not pushed off the bottom.
    expect(pillBox.y).toBeGreaterThanOrEqual(0)
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(viewport.height)
    expect(pillBox.x).toBeGreaterThanOrEqual(0)
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(viewport.width)
  }

  expect(tidyVisible).toBe(true)
  expect(buildVisible).toBe(true)
  expect(saveVisible).toBe(true)
  expect(zoomVisible).toBe(true)

  void taskId
})
