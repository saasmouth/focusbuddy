import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// SCREENSHOT + BEHAVIOR CAPTURE for the operator — verifying commits
// 2df837f ("Fix full-bleed chrome overlaps") + 849a31e ("AI: one context-aware
// assistant, remove the duplicate rail") before shipping. plexidesk-tester
// evidence pass, not a permanent regression suite — left uncommitted per the
// dispatch brief.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function setupTaskWithWidgets(window: LaunchedApp['window']): Promise<{ taskId: string }> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Single-AI-context verification desk'
    })
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
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Sticky four',
      content: 'Fourth widget.',
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

async function readAssistantPanel(
  window: LaunchedApp['window']
): Promise<{ subtitle: string; firstSuggestion: string | null }> {
  const aside = window.locator('aside').filter({ has: window.getByRole('heading', { name: 'Plexii', exact: true }) })
  await expect(aside).toBeVisible({ timeout: 5_000 })
  // Subtitle is the small text under the "ASSISTANT" heading.
  const subtitleLoc = aside.locator('p').first()
  const subtitle = (await subtitleLoc.textContent().catch(() => '')) ?? ''
  const chip = window.locator('[data-testid="chat-suggestion"]').first()
  const hasChip = await chip.isVisible({ timeout: 2_000 }).catch(() => false)
  const firstSuggestion = hasChip ? await chip.textContent() : null
  return { subtitle: subtitle.trim(), firstSuggestion: firstSuggestion?.trim() ?? null }
}

test('single AI assistant + context-aware subtitle/suggestions + overlap fixes (UI-driven)', async () => {
  test.setTimeout(150_000)
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
  await openDesk(window, 'Single-AI-context verification desk')

  const widgetsOnSurface = await window.locator('[data-widget-id]').count()
  console.log('widgets rendered on surface after seeding:', widgetsOnSurface)
  expect(widgetsOnSurface).toBeGreaterThanOrEqual(4)

  const laterBtn = window.getByRole('button', { name: 'Later' })
  if (await laterBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await laterBtn.click().catch(() => {})
    await window.waitForTimeout(300)
  }

  // ── CHECK 1 — exactly one AI assistant panel on the desk ──────────────────
  const nextBestActions = window.getByText(/NEXT BEST ACTIONS/i)
  const nextBestActionsCount = await nextBestActions.count()
  console.log('"NEXT BEST ACTIONS" element count (should be 0):', nextBestActionsCount)

  const asideCount = await window.locator('aside').count()
  const assistantHeadings = window.getByRole('heading', { name: 'Plexii', exact: true })
  const assistantHeadingCount = await assistantHeadings.count()
  console.log('<aside> element count on desk:', asideCount)
  console.log('"ASSISTANT" heading count (should be exactly 1):', assistantHeadingCount)

  const oldRailByTestId = await window.locator('[data-testid="canvas-ai-assistant-rail"]').count().catch(() => 0)
  const onTrackText = await window.getByText(/ON TRACK/i).count().catch(() => 0)
  console.log('legacy CanvasAIAssistantRail testid count (should be 0):', oldRailByTestId)
  console.log('"ON TRACK" text count (should be 0):', onTrackText)

  await window.waitForTimeout(400)
  await window.screenshot({ path: 'test-results/ai-single.png' })
  console.log('Saved test-results/ai-single.png')

  expect(nextBestActionsCount).toBe(0)
  expect(assistantHeadingCount).toBe(1)

  // ── CHECK 2 — assistant is contextual to the current screen ───────────────
  const observed: Record<string, { subtitle: string; firstSuggestion: string | null }> = {}

  // 2a. Desk (view task)
  observed.desk = await readAssistantPanel(window)
  await window.screenshot({ path: 'test-results/ai-desk.png' })
  console.log('Saved test-results/ai-desk.png')
  console.log('DESK subtitle:', JSON.stringify(observed.desk.subtitle))
  console.log('DESK first suggestion:', JSON.stringify(observed.desk.firstSuggestion))

  // 2b. Document
  const docId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const doc = await api.documents.create({
      docType: 'doc',
      title: 'Single-AI-context verification doc',
      body: { type: 'doc', html: '<p>Verification doc body.</p>' } as unknown as never
    })
    return doc.id
  })
  await window.evaluate((id) => {
    const w = window as unknown as {
      __fbView?: { getState: () => Record<string, (arg?: unknown) => void> }
    }
    w.__fbView?.getState().goDocument?.(id)
  }, docId)
  await window.waitForTimeout(1000)
  observed.doc = await readAssistantPanel(window)
  await window.screenshot({ path: 'test-results/ai-doc.png' })
  console.log('Saved test-results/ai-doc.png')
  console.log('DOC subtitle:', JSON.stringify(observed.doc.subtitle))
  console.log('DOC first suggestion:', JSON.stringify(observed.doc.firstSuggestion))

  // 2c. Messages (chat)
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => Record<string, (arg?: unknown) => void> }
    }
    w.__fbView?.getState().goMessages?.()
  })
  await window.waitForTimeout(1000)
  observed.chat = await readAssistantPanel(window)
  await window.screenshot({ path: 'test-results/ai-chat.png' })
  console.log('Saved test-results/ai-chat.png')
  console.log('CHAT subtitle:', JSON.stringify(observed.chat.subtitle))
  console.log('CHAT first suggestion:', JSON.stringify(observed.chat.firstSuggestion))

  // 2d. Meetings (best-effort)
  try {
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbView?: { getState: () => Record<string, (arg?: unknown) => void> }
      }
      w.__fbView?.getState().goMeetings?.()
    })
    await window.waitForTimeout(1000)
    observed.meet = await readAssistantPanel(window)
    await window.screenshot({ path: 'test-results/ai-meet.png' })
    console.log('Saved test-results/ai-meet.png')
    console.log('MEET subtitle:', JSON.stringify(observed.meet.subtitle))
    console.log('MEET first suggestion:', JSON.stringify(observed.meet.firstSuggestion))
  } catch (err) {
    console.log('MEET view unreachable:', err instanceof Error ? err.message : String(err))
  }

  // 2e. Design (best-effort)
  try {
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbView?: { getState: () => Record<string, (arg?: unknown) => void> }
      }
      w.__fbView?.getState().goDesign?.()
    })
    await window.waitForTimeout(1000)
    observed.design = await readAssistantPanel(window)
    await window.screenshot({ path: 'test-results/ai-design.png' })
    console.log('Saved test-results/ai-design.png')
    console.log('DESIGN subtitle:', JSON.stringify(observed.design.subtitle))
    console.log('DESIGN first suggestion:', JSON.stringify(observed.design.firstSuggestion))
  } catch (err) {
    console.log('DESIGN view unreachable:', err instanceof Error ? err.message : String(err))
  }

  console.log('ALL OBSERVED CONTEXT STRINGS:', JSON.stringify(observed, null, 2))

  expect(observed.desk.subtitle.toLowerCase()).toContain('this desk')
  expect(observed.doc.subtitle.toLowerCase()).toContain('this document')
  expect(observed.chat.subtitle.toLowerCase()).toContain('your chats')

  // ── Back to the desk for CHECK 3 (overlap fixes need the canvas surface) ──
  await window.evaluate((id) => {
    const w = window as unknown as {
      __fbView?: { getState: () => Record<string, (arg?: unknown) => void> }
    }
    w.__fbView?.getState().goTask?.(id)
  }, (await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    return nodes.find((n: { title?: string }) => n.title === 'Single-AI-context verification desk')?.id ?? null
  })) as unknown as string)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForTimeout(800)

  const viewport = window.viewportSize() ?? { width: 1440, height: 900 }

  // ── CHECK 3a — minimap fully visible above the +Add FAB ───────────────────
  const minimapOverlays = window.locator('[data-minimap-overlay="true"]')
  const minimapCount = await minimapOverlays.count()
  console.log('minimap overlay count:', minimapCount)
  const minimapBox = minimapCount > 0 ? await minimapOverlays.first().boundingBox() : null
  const addFab = window.locator('[data-testid="palette-fab-button"]')
  const addFabBox = await addFab.boundingBox().catch(() => null)
  console.log('minimap box:', JSON.stringify(minimapBox))
  console.log('Add-FAB box:', JSON.stringify(addFabBox))
  let overlapPct = 0
  if (minimapBox && addFabBox) {
    const overlapX = Math.max(
      0,
      Math.min(minimapBox.x + minimapBox.width, addFabBox.x + addFabBox.width) -
        Math.max(minimapBox.x, addFabBox.x)
    )
    const overlapY = Math.max(
      0,
      Math.min(minimapBox.y + minimapBox.height, addFabBox.y + addFabBox.height) -
        Math.max(minimapBox.y, addFabBox.y)
    )
    const overlapArea = overlapX * overlapY
    const minimapArea = minimapBox.width * minimapBox.height
    overlapPct = minimapArea > 0 ? (overlapArea / minimapArea) * 100 : 0
    console.log(`minimap/Add-FAB overlap: ${overlapArea}px^2 of ${minimapArea}px^2 (${overlapPct.toFixed(1)}% covered)`)
  }
  await window.screenshot({
    path: 'test-results/overlap-minimap.png',
    clip: {
      x: Math.max(0, viewport.width - 340),
      y: Math.max(0, viewport.height - 340),
      width: 340,
      height: 340
    }
  })
  console.log('Saved test-results/overlap-minimap.png')

  // ── CHECK 3b — FloatingPill expand no longer overlaps the breadcrumb pill ─
  const breadcrumb = window.locator('[data-testid="desk-context-trigger"]')
  const floatingPill = window.locator('[data-testid="floating-pill"]')
  await expect(breadcrumb).toBeVisible({ timeout: 5_000 })
  await expect(floatingPill).toBeVisible({ timeout: 5_000 })
  const bcBoxBefore = await breadcrumb.boundingBox()
  await floatingPill.hover()
  await window.waitForTimeout(500)
  const pillBoxAfter = await floatingPill.boundingBox()
  const bcBoxAfter = await breadcrumb.boundingBox()
  console.log('breadcrumb box (pre-hover):', JSON.stringify(bcBoxBefore))
  console.log('breadcrumb box (post-hover):', JSON.stringify(bcBoxAfter))
  console.log('FloatingPill box (expanded):', JSON.stringify(pillBoxAfter))
  let pillBreadcrumbOverlapPct = 0
  if (pillBoxAfter && bcBoxAfter) {
    const overlapX = Math.max(
      0,
      Math.min(pillBoxAfter.x + pillBoxAfter.width, bcBoxAfter.x + bcBoxAfter.width) -
        Math.max(pillBoxAfter.x, bcBoxAfter.x)
    )
    const overlapY = Math.max(
      0,
      Math.min(pillBoxAfter.y + pillBoxAfter.height, bcBoxAfter.y + bcBoxAfter.height) -
        Math.max(pillBoxAfter.y, bcBoxAfter.y)
    )
    const overlapArea = overlapX * overlapY
    console.log(`FloatingPill/breadcrumb overlap area: ${overlapArea}px^2`)
    const smallerArea = Math.min(
      pillBoxAfter.width * pillBoxAfter.height,
      bcBoxAfter.width * bcBoxAfter.height
    )
    pillBreadcrumbOverlapPct = smallerArea > 0 ? (overlapArea / smallerArea) * 100 : 0
  }
  await window.screenshot({ path: 'test-results/overlap-pill.png' })
  console.log('Saved test-results/overlap-pill.png')
  await window.mouse.move(viewport.width / 2, viewport.height / 2)
  await window.waitForTimeout(300)

  console.log('minimap/FAB overlap pct:', overlapPct.toFixed(1))
  console.log('pill/breadcrumb overlap pct:', pillBreadcrumbOverlapPct.toFixed(1))

  const bodyText = await window.locator('body').innerText()
  const errorBoundaryHit = /Something went wrong|Uncaught|Cannot read propert/i.test(bodyText)
  console.log('error boundary text present:', errorBoundaryHit)
  console.log('console errors captured:', JSON.stringify(consoleErrors, null, 2))

  expect(errorBoundaryHit).toBe(false)
  expect(overlapPct).toBeLessThan(15)
  expect(pillBreadcrumbOverlapPct).toBeLessThan(15)
})
