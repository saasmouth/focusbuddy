import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Plexi3.0 UI-scale / density feature verification. The user reported the
// View-menu Zoom In / Zoom Out / Actual Size items did nothing — this spec
// proves the fix by reading Chromium's real zoom factor before and after
// each menu item is clicked (driven through the actual application menu the
// main process installs, not a simulated shortcut). It also covers the new
// Density lever and the Theme Studio "Compact" text-size preset, plus a
// regression pass on the FloatingPill (fb-pill class + Resume modal).

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('View menu Zoom In / Zoom Out / Actual Size drive the real Chromium zoom factor', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  const getZoom = (): Promise<number> =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      return win.webContents.getZoomFactor()
    })

  const bootZoom = await getZoom()
  console.log('Boot zoom factor:', bootZoom)

  // Confirm the application menu actually has a View submenu with the three
  // items the user said did nothing.
  const menuShape = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const viewMenu = menu?.items.find((i) => i.label === 'View')
    const labels = viewMenu?.submenu?.items.map((i) => i.label) ?? []
    return { hasViewMenu: !!viewMenu, labels }
  })
  console.log('View menu items:', JSON.stringify(menuShape.labels))
  expect(menuShape.hasViewMenu).toBe(true)
  expect(menuShape.labels).toContain('Zoom In')
  expect(menuShape.labels).toContain('Zoom Out')
  expect(menuShape.labels).toContain('Actual Size')

  // Reset to a known baseline first (Actual Size), then read that as our
  // reference so this test isn't sensitive to whatever scale a previous
  // theme-studio interaction left behind.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const viewMenu = menu?.items.find((i) => i.label === 'View')
    const item = viewMenu?.submenu?.items.find((i) => i.label === 'Actual Size')
    item?.click()
  })
  await window.waitForTimeout(300)
  const baselineZoom = await getZoom()
  console.log('Zoom after Actual Size click:', baselineZoom)
  expect(baselineZoom).toBeCloseTo(1.0, 2)

  // Zoom Out must DECREASE the real zoom factor.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const viewMenu = menu?.items.find((i) => i.label === 'View')
    const item = viewMenu?.submenu?.items.find((i) => i.label === 'Zoom Out')
    item?.click()
  })
  await window.waitForTimeout(300)
  const afterZoomOut = await getZoom()
  console.log('Zoom after Zoom Out click:', afterZoomOut)
  expect(afterZoomOut).toBeLessThan(baselineZoom)

  // Zoom In must INCREASE it again.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const viewMenu = menu?.items.find((i) => i.label === 'View')
    const item = viewMenu?.submenu?.items.find((i) => i.label === 'Zoom In')
    item?.click()
  })
  await window.waitForTimeout(300)
  const afterZoomIn = await getZoom()
  console.log('Zoom after Zoom In click:', afterZoomIn)
  expect(afterZoomIn).toBeGreaterThan(afterZoomOut)

  // A second Zoom In should push us above the 1.0 baseline.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const viewMenu = menu?.items.find((i) => i.label === 'View')
    const item = viewMenu?.submenu?.items.find((i) => i.label === 'Zoom In')
    item?.click()
  })
  await window.waitForTimeout(300)
  const afterSecondZoomIn = await getZoom()
  console.log('Zoom after second Zoom In click:', afterSecondZoomIn)
  expect(afterSecondZoomIn).toBeGreaterThan(baselineZoom)

  // Actual Size returns to exactly 1.0 from a zoomed-in state.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const viewMenu = menu?.items.find((i) => i.label === 'View')
    const item = viewMenu?.submenu?.items.find((i) => i.label === 'Actual Size')
    item?.click()
  })
  await window.waitForTimeout(300)
  const afterReset = await getZoom()
  console.log('Zoom after final Actual Size click:', afterReset)
  expect(afterReset).toBeCloseTo(1.0, 2)
})

test('data-density is applied on boot, Theme Studio Compact preset and Density toggle work live', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  const getZoom = (): Promise<number> =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      return win.webContents.getZoomFactor()
    })

  // CHECK 2 — data-density attribute is present after boot.
  const bootDensity = await window.evaluate(() => document.documentElement.getAttribute('data-density'))
  console.log('Boot data-density:', bootDensity)
  expect(['comfortable', 'compact']).toContain(bootDensity)

  // CHECK 3 — open Settings -> Theme Studio, confirm 6 presets incl Compact,
  // and a Density section with both buttons.
  await window.getByRole('button', { name: 'Appearance settings' }).click()
  await window.locator('[data-testid="open-theme-studio"]').click()
  await expect(window.locator('[data-testid="theme-builder"]')).toBeVisible()

  const uiScaleTestIds = [0.8, 0.9, 1.0, 1.15, 1.3, 1.5]
  const presetVisibility: Record<string, boolean> = {}
  for (const v of uiScaleTestIds) {
    const loc = window.locator(`[data-testid="themestudio-uiscale-${v}"]`)
    presetVisibility[String(v)] = await loc.isVisible({ timeout: 2_000 }).catch(() => false)
  }
  console.log('Text-size preset visibility:', JSON.stringify(presetVisibility))
  for (const v of uiScaleTestIds) {
    expect(presetVisibility[String(v)], `preset ${v} should be visible`).toBe(true)
  }
  const compactLabel = (
    await window.locator('[data-testid="themestudio-uiscale-0.8"]').textContent()
  )?.trim()
  console.log('0.8 preset label:', compactLabel)
  expect(compactLabel).toContain('Compact')

  const densityComfortableVisible = await window
    .locator('[data-testid="themestudio-density-comfortable"]')
    .isVisible({ timeout: 2_000 })
    .catch(() => false)
  const densityCompactVisible = await window
    .locator('[data-testid="themestudio-density-compact"]')
    .isVisible({ timeout: 2_000 })
    .catch(() => false)
  console.log('Density buttons visible (comfortable, compact):', densityComfortableVisible, densityCompactVisible)
  expect(densityComfortableVisible).toBe(true)
  expect(densityCompactVisible).toBe(true)

  // Click Density -> Compact and confirm the root attribute flips live.
  await window.locator('[data-testid="themestudio-density-compact"]').click()
  await window.waitForTimeout(200)
  const densityAfterClick = await window.evaluate(() =>
    document.documentElement.getAttribute('data-density')
  )
  console.log('data-density after clicking Compact:', densityAfterClick)
  expect(densityAfterClick).toBe('compact')

  // Click Text size 0.9 preset and confirm the real Chromium zoom factor
  // follows it (not just a stored value).
  await window.locator('[data-testid="themestudio-uiscale-0.9"]').click()
  await window.waitForTimeout(300)
  const zoomAfterPreset = await getZoom()
  console.log('Zoom factor after clicking 0.9 preset:', zoomAfterPreset)
  expect(zoomAfterPreset).toBeCloseTo(0.9, 2)

  await window.screenshot({ path: 'test-results/uiscale-density-theme-studio.png' })
  console.log('Saved test-results/uiscale-density-theme-studio.png')
})

test('regression: FloatingPill (fb-pill) still resolves and Resume opens the ResumeModal after the ui-scale change', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const { window } = launched

  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

  await waitForReady(window)

  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'UI-scale regression desk'
    })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Sticky one',
      content: 'First widget.',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    return task.id
  })
  console.log('seeded task id:', taskId)

  await window.reload()
  await waitForReady(window)

  await window.getByRole('button', { name: 'UI-scale regression desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(800)

  // CHECK 4 — at most one assistant surface, no duplicate rail.
  //
  // This counted elements with a heading named exactly "Plexii". The assistant
  // header shows the PlexiiLogo mark now instead of that text heading, and the
  // mark is legitimately used in several places in the chrome (the header
  // wordmark, the assistant header, the minimised pill), so a global count of
  // the name says nothing about duplication. The assistant panel is not even
  // open at this point in this test.
  //
  // What is asserted here instead is the thing this test can actually see: no
  // more than one assistant panel is mounted. The duplicate-assistant-rail
  // regression itself is owned by assistantChrome.spec.ts and plexiiHub.spec.ts,
  // which open the assistant and inspect it properly.
  const assistantPanels = await window.locator('[data-testid="assistant-panel"]').count()
  console.log('Assistant panels mounted (want 0 or 1):', assistantPanels)
  expect(assistantPanels).toBeLessThanOrEqual(1)

  // The desk action bar is docked in the header now ("desk-action-bar");
  // "floating-pill" survives only in HeaderSlot's fallback. It still carries
  // the fb-pill compact-density hook, which is what this regression guards.
  const floatingPill = window.locator('[data-testid="desk-action-bar"]')
  await expect(floatingPill).toBeVisible({ timeout: 5_000 })
  const hasPillClass = await floatingPill.evaluate((el) => el.classList.contains('fb-pill'))
  console.log('FloatingPill has fb-pill class:', hasPillClass)
  expect(hasPillClass).toBe(true)

  await floatingPill.hover()
  await window.waitForTimeout(500)

  const pillResumeVisible = await window
    .locator('[data-testid="pill-resume"]')
    .isVisible({ timeout: 2_000 })
    .catch(() => false)
  console.log('pill-resume visible:', pillResumeVisible)
  expect(pillResumeVisible).toBe(true)

  await window.locator('[data-testid="pill-resume"]').click()
  await window.waitForTimeout(500)
  const resumeOpened = await window
    .getByText(/^Resume —/)
    .isVisible({ timeout: 3_000 })
    .catch(() => false)
  console.log('ResumeModal opened:', resumeOpened)
  expect(resumeOpened).toBe(true)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(300)

  // CHECK 5 — no error boundary / uncaught exceptions. Ignore known
  // pre-existing focusbuddy-signal.fly.dev 404s from offline dev runs.
  const bodyText = await window.locator('body').innerText()
  const errorBoundaryHit = /Something went wrong|Uncaught|Cannot read propert/i.test(bodyText)
  const relevantConsoleErrors = consoleErrors.filter(
    (e) => !e.includes('focusbuddy-signal.fly.dev') && !e.includes('404')
  )
  console.log('Error boundary text present (want false):', errorBoundaryHit)
  console.log('Relevant console errors:', JSON.stringify(relevantConsoleErrors, null, 2))
  expect(errorBoundaryHit).toBe(false)
  expect(relevantConsoleErrors).toEqual([])
})
