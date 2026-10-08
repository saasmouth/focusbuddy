import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// SCREENSHOT + BEHAVIOR CAPTURE for the operator — verifying commit 7bc3189
// "Caleb desk-UX slice C: full-bleed canvas shell + re-homed chrome" before
// shipping. plexidesk-tester evidence pass, not a permanent regression suite
// — left uncommitted per the dispatch brief.
//
// Produces PNGs in test-results/:
//   desk-fullbleed.png       — whole desk, full-bleed surface + floating chrome
//   desk-header.png          — close crop of the floating header pill
//   desk-switcher.png        — breadcrumb hover-expand + StageManagerStrip open
//   desk-bottombar.png       — UnifiedBottomBar, collapsed-state pass
//   desk-bottombar-full.png  — UnifiedBottomBar expanded, all widgets + mic row
//   desk-minimap.png         — bottom-right minimap overlay, singular
//   desk-pill.png            — FloatingPill expanded (Tidy/Build/Save/zoom)

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function setupTaskWithWidgets(
  window: LaunchedApp['window']
): Promise<{ taskId: string }> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Full-bleed desk-UX verification'
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Sticky one',
      content: 'First widget for the full-bleed layout check.',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Sticky two',
      content: 'Second widget — confirms the dock lists more than one.',
      x: 460,
      y: 160,
      width: 220,
      height: 180
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'Note widget',
      content: 'Third widget, a different kind, for the bottom bar tray.',
      x: 160,
      y: 420,
      width: 240,
      height: 160
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Sticky four',
      content: 'Fourth widget so the bottom dock has 4+ items.',
      x: 460,
      y: 420,
      width: 220,
      height: 160
    })
    return { taskId: task.id }
  })
}

async function openDesk(window: LaunchedApp['window'], title: string): Promise<void> {
  await window.getByRole('button', { name: title }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(800)
}

test('capture full-bleed desk chrome screenshots + sanity checks (UI-driven)', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const { window } = launched

  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

  await waitForReady(window)

  await setupTaskWithWidgets(window)

  await window.reload()
  await waitForReady(window)
  await openDesk(window, 'Full-bleed desk-UX verification')

  // Confirm the 4 seeded widgets actually rendered on the surface before
  // doing any chrome checks — this is the follow-up ask: prove content
  // widgets are present, not an empty desk.
  const widgetsOnSurface = await window.locator('[data-widget-id]').count()
  console.log('widgets rendered on surface after seeding:', widgetsOnSurface)
  expect(widgetsOnSurface).toBeGreaterThanOrEqual(4)

  // Dismiss the "New: Rooms, Desks and Plans" onboarding toast if present —
  // it floats bottom-right and would otherwise occlude the minimap overlay
  // and skew the screenshots with unrelated chrome.
  const laterBtn = window.getByRole('button', { name: 'Later' })
  if (await laterBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await laterBtn.click().catch(() => {})
    await window.waitForTimeout(300)
  }

  // ── 1. Whole desk, full-bleed ─────────────────────────────────────────────
  const header = window.locator('[data-testid="canvas-task-header"]')
  await expect(header).toBeVisible({ timeout: 5_000 })
  const breadcrumb = window.locator('[data-testid="desk-context-trigger"]')
  await expect(breadcrumb).toBeVisible({ timeout: 5_000 })
  const pill = window.locator('[data-testid="floating-pill"]')
  await expect(pill).toBeVisible({ timeout: 5_000 }).catch(() => {})
  await window.waitForTimeout(600)
  await window.screenshot({ path: 'test-results/desk-fullbleed.png' })
  console.log('Saved test-results/desk-fullbleed.png')

  // Overlap check — do the breadcrumb and header pill boxes collide, and does
  // the header pill get clipped by the viewport?
  const bcBox = await breadcrumb.boundingBox()
  const hdBox = await header.boundingBox()
  const viewport = window.viewportSize() ?? { width: 1440, height: 900 }
  console.log('breadcrumb box:', JSON.stringify(bcBox))
  console.log('header box:', JSON.stringify(hdBox))
  console.log('viewport:', JSON.stringify(viewport))
  if (bcBox && hdBox) {
    const verticallyOverlapping = bcBox.y + bcBox.height > hdBox.y
    console.log('breadcrumb/header vertical overlap:', verticallyOverlapping)
  }
  if (hdBox) {
    const clippedRight = hdBox.x + hdBox.width > viewport.width
    const clippedBottom = hdBox.y + hdBox.height > viewport.height
    console.log('header clipped right:', clippedRight, 'clipped bottom:', clippedBottom)
  }

  // ── 2. Close crop of the header pill — verify every re-homed control ─────
  const controls: Record<string, string> = {}
  async function checkVisible(name: string, locatorFn: () => ReturnType<LaunchedApp['window']['locator']>): Promise<void> {
    try {
      const loc = locatorFn()
      const visible = await loc.first().isVisible({ timeout: 2_000 })
      controls[name] = visible ? 'FOUND' : 'NOT VISIBLE'
    } catch {
      controls[name] = 'MISSING'
    }
  }

  await checkVisible('desk-title (rename)', () => window.locator('[data-testid="desk-title"]'))
  await checkVisible('priority readout', () => window.locator('[title="Priority"]'))
  await checkVisible('interest readout', () => window.locator('[title="Interest / Novelty"]'))
  await checkVisible('importance readout', () => window.locator('[title="Importance"]'))
  await checkVisible('DeskPresenceBar', () => window.locator('[data-testid="desk-presence-bar"]'))
  await checkVisible('desk-chat-button', () => window.locator('[data-testid="desk-chat-button"]'))
  await checkVisible('status button', () =>
    window.locator('[data-testid="canvas-task-header"] button[title^="Mark as"]')
  )
  await checkVisible('FivePromiseButton', () =>
    window.locator('[data-testid="canvas-task-header"]').getByText(/Just 5 min|In session/)
  )
  await checkVisible('desk-start-meeting', () => window.locator('[data-testid="desk-start-meeting"]'))
  await checkVisible('Resume button', () =>
    window.locator('[data-testid="canvas-task-header"] button').filter({ hasText: 'Resume' })
  )
  await checkVisible('+Add palette', () => window.locator('[data-testid="palette-add-button"]'))
  await checkVisible('open-history', () => window.locator('[data-testid="open-history"]'))

  console.log('HEADER CONTROLS:', JSON.stringify(controls, null, 2))

  const hdBoxForCrop = await header.boundingBox()
  if (hdBoxForCrop) {
    await window.screenshot({
      path: 'test-results/desk-header.png',
      clip: {
        x: Math.max(0, hdBoxForCrop.x - 10),
        y: Math.max(0, hdBoxForCrop.y - 10),
        width: Math.min(viewport.width - Math.max(0, hdBoxForCrop.x - 10), hdBoxForCrop.width + 20),
        height: Math.min(viewport.height - Math.max(0, hdBoxForCrop.y - 10), hdBoxForCrop.height + 20)
      }
    })
  } else {
    await header.screenshot({ path: 'test-results/desk-header.png' })
  }
  console.log('Saved test-results/desk-header.png')

  // ── 3. Desk switcher — hover breadcrumb, open StageManagerStrip ─────────
  await breadcrumb.hover()
  await window.waitForTimeout(500)
  const switcherStrip = window.locator('[data-testid="stage-manager-strip"]')
  const switcherFound = await switcherStrip.isVisible({ timeout: 3_000 }).catch(() => false)
  if (!switcherFound) {
    // Fallback: click the breadcrumb to force-expand if hover alone doesn't do it.
    await breadcrumb.click().catch(() => {})
    await window.waitForTimeout(400)
  }
  const switcherVisible = await switcherStrip.isVisible({ timeout: 3_000 }).catch(() => false)
  console.log('desk switcher (stage-manager-strip) visible:', switcherVisible)
  await window.waitForTimeout(400)
  await window.screenshot({ path: 'test-results/desk-switcher.png' })
  console.log('Saved test-results/desk-switcher.png')

  // Move mouse away to close the switcher before continuing.
  await window.mouse.move(viewport.width / 2, viewport.height / 2)
  await window.waitForTimeout(400)

  // ── 4a. UnifiedBottomBar — collapsed-state screenshot ─────────────────────
  await window.mouse.move(viewport.width / 2, viewport.height / 2)
  await window.waitForTimeout(500)
  await window.screenshot({ path: 'test-results/desk-bottombar.png' })
  console.log('Saved test-results/desk-bottombar.png (collapsed state)')

  // ── 4b. UnifiedBottomBar expanded — hover so it opens, with widgets present.
  // The bar sits bottom-centre. Collapsed state is a 120x4px accent strip
  // (no data-testid) — locate it by geometry and hover the element itself via
  // Playwright's locator.hover() rather than raw mouse coordinates, since the
  // strip is tiny.
  const collapsedStrip = window.locator('div[style*="height: 4px"], div[style*="height:4px"]').last()
  const stripVisible = await collapsedStrip.isVisible({ timeout: 3_000 }).catch(() => false)
  console.log('bottom-bar collapsed strip visible pre-hover:', stripVisible)
  if (stripVisible) {
    await collapsedStrip.hover()
  } else {
    // Fallback — hover the bottom-centre wrapper region directly.
    await window.mouse.move(viewport.width / 2, viewport.height - 6)
  }
  await window.waitForTimeout(600)
  const onDeskLabel = window.getByText('On desk', { exact: true })
  const dockExpanded = await onDeskLabel.isVisible({ timeout: 3_000 }).catch(() => false)
  console.log('bottom bar expanded (On desk label visible):', dockExpanded)

  // Count widget chips in the tray via the per-item hover-delete X (aria-label="Remove").
  const chipRemoveCount = await window.locator('[aria-label="Remove"]').count().catch(() => -1)
  // Also count via the mic row to confirm it renders below the tray.
  const micRowVisible = await window
    .locator('button[aria-label*="voice" i], button[title*="voice" i], [class*="voice" i] button')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false)
  console.log(
    'bottom-bar widget chip count (via per-item Remove buttons):',
    chipRemoveCount,
    '(should be >= 4, the seeded widget count) — widgets on surface:',
    widgetsOnSurface
  )
  console.log('mic row visible below tray:', micRowVisible)

  await window.waitForTimeout(400)
  await window.screenshot({ path: 'test-results/desk-bottombar-full.png' })
  console.log('Saved test-results/desk-bottombar-full.png (expanded state)')

  // Move away before the next capture so the dock collapses again.
  await window.mouse.move(viewport.width / 2, viewport.height / 2)
  await window.waitForTimeout(500)

  // ── 5. Minimap — single overlay bottom-right, not doubled ────────────────
  const minimapOverlays = window.locator('[data-minimap-overlay="true"]')
  const minimapCount = await minimapOverlays.count()
  // Also check for any leftover on-canvas minimap WIDGET (the old auto-pinned
  // mechanism this commit was meant to retire) so we can confirm no doubling.
  const minimapWidgetCount = await window.locator('[data-widget-kind="minimap"]').count().catch(() => 0)
  console.log('minimap overlay count (CanvasMinimapOverlay):', minimapCount)
  console.log('legacy on-canvas minimap WIDGET count (should be 0):', minimapWidgetCount)
  const minimapBox = minimapCount > 0 ? await minimapOverlays.first().boundingBox() : null
  console.log('minimap overlay bounding box:', JSON.stringify(minimapBox))
  if (minimapBox) {
    const nearBottomRight =
      minimapBox.x + minimapBox.width > viewport.width * 0.75 && minimapBox.y + minimapBox.height > viewport.height * 0.75
    console.log('minimap positioned near bottom-right quadrant:', nearBottomRight)
  }

  // Check for overlap with the always-visible on-canvas "+" Add-widget FAB —
  // both are bottom-right anchored circular controls; confirm whether one
  // occludes the other.
  const addFab = window.locator('[data-testid="palette-fab-button"]')
  const addFabBox = await addFab.boundingBox().catch(() => null)
  console.log('Add-widget FAB bounding box:', JSON.stringify(addFabBox))
  if (minimapBox && addFabBox) {
    const overlapX = Math.max(0, Math.min(minimapBox.x + minimapBox.width, addFabBox.x + addFabBox.width) - Math.max(minimapBox.x, addFabBox.x))
    const overlapY = Math.max(0, Math.min(minimapBox.y + minimapBox.height, addFabBox.y + addFabBox.height) - Math.max(minimapBox.y, addFabBox.y))
    const overlapArea = overlapX * overlapY
    const minimapArea = minimapBox.width * minimapBox.height
    console.log(
      `minimap/Add-FAB overlap: ${overlapArea}px^2 of ${minimapArea}px^2 minimap area (${((overlapArea / minimapArea) * 100).toFixed(0)}% covered)`
    )
  }

  await window.waitForTimeout(300)
  // Wide crop of the whole bottom-right quadrant so both the minimap and the
  // Add-widget FAB are visible together for visual overlap inspection.
  await window.screenshot({
    path: 'test-results/desk-minimap.png',
    clip: {
      x: Math.max(0, viewport.width - 320),
      y: Math.max(0, viewport.height - 320),
      width: 320,
      height: 320
    }
  })
  console.log('Saved test-results/desk-minimap.png')

  // ── 6. FloatingPill expand check (Tidy/Build/Save-template/zoom) ─────────
  const floatingPill = window.locator('[data-testid="floating-pill"]')
  const pillBoxBefore = await floatingPill.boundingBox()
  console.log('FloatingPill bounding box (pre-hover, collapsed):', JSON.stringify(pillBoxBefore))
  await floatingPill.hover()
  await window.waitForTimeout(400)
  const pillControls = {
    tidy: await window.locator('[data-testid="pill-tidy"]').isVisible().catch(() => false),
    build: await window.locator('[data-testid="pill-build"]').isVisible().catch(() => false),
    saveTemplate: await window.locator('[data-testid="pill-save-template"]').isVisible().catch(() => false),
    zoom: await window.locator('[data-testid="pill-zoom"]').isVisible().catch(() => false)
  }
  console.log('FloatingPill expanded controls (on hover):', JSON.stringify(pillControls))
  const pillBoxAfter = await floatingPill.boundingBox()
  console.log('FloatingPill bounding box (post-hover, expanded):', JSON.stringify(pillBoxAfter))
  if (pillBoxAfter) {
    await window.screenshot({
      path: 'test-results/desk-pill.png',
      clip: {
        x: Math.max(0, pillBoxAfter.x - 40),
        y: Math.max(0, pillBoxAfter.y - 40),
        width: Math.min(viewport.width - Math.max(0, pillBoxAfter.x - 40), pillBoxAfter.width + 80),
        height: Math.min(viewport.height - Math.max(0, pillBoxAfter.y - 40), pillBoxAfter.height + 80)
      }
    })
  } else {
    await window.screenshot({ path: 'test-results/desk-pill.png' })
  }
  console.log('Saved test-results/desk-pill.png')
  await window.screenshot({ path: 'test-results/desk-pill-wide.png' })
  console.log('Saved test-results/desk-pill-wide.png (full window, pill expanded)')
  await window.mouse.move(viewport.width / 2, viewport.height / 2)
  await window.waitForTimeout(400)

  // ── Sanity checks ─────────────────────────────────────────────────────────

  // (a-pan via wheel) plain wheel-scroll pans the surface (Canvas.tsx
  // handleWheel: plain wheel -> panBy; ctrl/cmd+wheel -> zoom). Verify pan
  // first since that's the default gesture.
  const surface = window.locator('[data-canvas-surface="true"]')
  const zoomableLayer = window.locator('[data-canvas-surface="true"] [style*="transform"]').first()
  const beforeWheelPan = await zoomableLayer.getAttribute('style').catch(() => null)
  await surface.hover()
  await window.mouse.wheel(0, -200)
  await window.waitForTimeout(300)
  const afterWheelPan = await zoomableLayer.getAttribute('style').catch(() => null)
  console.log('pan-via-wheel sanity: transform changed after plain wheel scroll:', beforeWheelPan !== afterWheelPan)
  console.log('before:', beforeWheelPan)
  console.log('after:', afterWheelPan)

  // (a-zoom via ctrl+wheel) — the actual zoom gesture per handleWheel.
  const beforeCtrlZoom = await zoomableLayer.getAttribute('style').catch(() => null)
  await window.keyboard.down('Control')
  await window.mouse.wheel(0, -200)
  await window.keyboard.up('Control')
  await window.waitForTimeout(300)
  const afterCtrlZoom = await zoomableLayer.getAttribute('style').catch(() => null)
  console.log('zoom-via-ctrl-wheel sanity: transform changed:', beforeCtrlZoom !== afterCtrlZoom)
  console.log('before:', beforeCtrlZoom)
  console.log('after:', afterCtrlZoom)

  // (a-drag) plain left-drag on empty canvas is BY DESIGN a marquee-select,
  // not a pan (Canvas.tsx comment: "left-drag pans instead of marquee-select
  // ONLY when space is held"). Verify the documented behavior: plain drag
  // does NOT move the transform (this is the existing, pre-3.8 contract, not
  // a regression from this commit) — and space+drag DOES pan.
  const surfaceBox = await surface.boundingBox()
  const beforePlainDrag = await zoomableLayer.getAttribute('style').catch(() => null)
  if (surfaceBox) {
    const startX = surfaceBox.x + surfaceBox.width * 0.85
    const startY = surfaceBox.y + surfaceBox.height * 0.15
    await window.mouse.move(startX, startY)
    await window.mouse.down()
    for (let i = 1; i <= 6; i++) {
      await window.mouse.move(startX - i * 12, startY - i * 6)
      await window.waitForTimeout(25)
    }
    await window.mouse.up()
    await window.waitForTimeout(200)
  }
  const afterPlainDrag = await zoomableLayer.getAttribute('style').catch(() => null)
  console.log('plain left-drag transform changed (expected FALSE — marquee-select, not pan):', beforePlainDrag !== afterPlainDrag)

  const beforeSpaceDrag = await zoomableLayer.getAttribute('style').catch(() => null)
  if (surfaceBox) {
    const startX = surfaceBox.x + surfaceBox.width * 0.85
    const startY = surfaceBox.y + surfaceBox.height * 0.15
    await window.keyboard.down('Space')
    await window.mouse.move(startX, startY)
    await window.mouse.down()
    for (let i = 1; i <= 6; i++) {
      await window.mouse.move(startX - i * 12, startY - i * 6)
      await window.waitForTimeout(25)
    }
    await window.mouse.up()
    await window.keyboard.up('Space')
    await window.waitForTimeout(200)
  }
  const afterSpaceDrag = await zoomableLayer.getAttribute('style').catch(() => null)
  console.log('space+drag transform changed (expected TRUE — pan gesture):', beforeSpaceDrag !== afterSpaceDrag)

  // (b) +Add still adds a widget — use the toolbar palette to add a sticky.
  const widgetElsBefore = await window.locator('[data-widget-id]').count()
  await window.locator('[data-testid="palette-add-button"]').click()
  await window.waitForTimeout(300)
  const stickyOption = window.locator('[data-testid="palette-add-sticky"]')
  const addWorked = await stickyOption.isVisible({ timeout: 2_000 }).catch(() => false)
  if (addWorked) {
    await stickyOption.click()
    await window.waitForTimeout(500)
  } else {
    // Close whatever popover may be open and note the miss.
    await window.keyboard.press('Escape').catch(() => {})
  }
  const widgetElsAfter = await window.locator('[data-widget-id]').count()
  console.log('+Add sanity: widgets before:', widgetElsBefore, 'after:', widgetElsAfter, 'palette-add-sticky found:', addWorked)

  // (d) console / error-boundary check.
  const bodyText = await window.locator('body').innerText()
  const errorBoundaryHit = /Something went wrong|Uncaught|Cannot read propert/i.test(bodyText)
  console.log('error boundary text present:', errorBoundaryHit)
  console.log('console errors captured:', JSON.stringify(consoleErrors, null, 2))

  expect(errorBoundaryHit).toBe(false)
})
