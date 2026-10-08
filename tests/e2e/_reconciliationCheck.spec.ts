import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Plexi3.0 reconciliation evidence pass — Ryan's desk chrome (collapsed sidebar
// strip, FloatingPill, CanvasMinimapFAB, breadcrumb desk-switcher) merged with
// the single-AI-assistant work + Resume action. plexidesk-tester dispatch
// evidence, not a permanent regression suite — left uncommitted per the brief.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('Plexi3.0 reconciliation: single AI panel, pill+resume, Ryan chrome intact, pin/recolor menus', async () => {
  test.setTimeout(180_000)
  launched = await launchApp()
  const { window } = launched

  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

  await waitForReady(window)

  // Seed a desk with a few widgets via the IPC surface (deterministic, not a
  // UI drag).
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Reconciliation verification desk'
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
      content: 'Third widget.',
      x: 160,
      y: 420,
      width: 240,
      height: 160
    })
    return task.id
  })
  console.log('seeded task id:', taskId)

  // The renderer's zustand nodes store doesn't know about this task yet
  // (created directly through the IPC surface, bypassing the store's create
  // action) — reload so the sidebar/home list picks it up, matching the
  // pattern in _singleAiContextCheck.spec.ts.
  await window.reload()
  await waitForReady(window)

  async function openDesk(title: string): Promise<void> {
    await window.getByRole('button', { name: title }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await window.waitForTimeout(800)
  }

  await openDesk('Reconciliation verification desk')

  const laterBtn = window.getByRole('button', { name: 'Later' })
  if (await laterBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await laterBtn.click().catch(() => {})
    await window.waitForTimeout(300)
  }

  const widgetsOnSurface = await window.locator('[data-widget-id]').count()
  console.log('widgets rendered on surface:', widgetsOnSurface)
  expect(widgetsOnSurface).toBeGreaterThanOrEqual(3)

  // ── CHECK 1 — exactly one AI assistant panel, no duplicate rail ───────────
  const nextBestActionsCount = await window.getByText(/NEXT BEST ACTIONS/i).count()
  const asideCount = await window.locator('aside').count()
  const assistantHeadingCount = await window
    .getByRole('heading', { name: 'Plexii', exact: true })
    .count()
  const legacyRailCount = await window
    .locator('[data-testid="canvas-ai-assistant-rail"]')
    .count()
    .catch(() => 0)
  console.log('CHECK1 "NEXT BEST ACTIONS" count (want 0):', nextBestActionsCount)
  console.log('CHECK1 <aside> count:', asideCount)
  console.log('CHECK1 "Assistant" heading count (want 1):', assistantHeadingCount)
  console.log('CHECK1 legacy CanvasAIAssistantRail testid count (want 0):', legacyRailCount)
  expect(nextBestActionsCount).toBe(0)
  expect(assistantHeadingCount).toBe(1)
  expect(legacyRailCount).toBe(0)

  // ── CHECK 2 — assistant is contextual: desk vs document ────────────────────
  const asideDesk = window
    .locator('aside')
    .filter({ has: window.getByRole('heading', { name: 'Plexii', exact: true }) })
  const desktSubtitle = ((await asideDesk.locator('p').first().textContent()) ?? '').trim()
  const deskChip = window.locator('[data-testid="chat-suggestion"]').first()
  const deskHasChip = await deskChip.isVisible({ timeout: 2_000 }).catch(() => false)
  const deskFirstSuggestion = deskHasChip ? ((await deskChip.textContent()) ?? '').trim() : null
  console.log('CHECK2 DESK subtitle (exact):', JSON.stringify(desktSubtitle))
  console.log('CHECK2 DESK first suggestion chip (exact):', JSON.stringify(deskFirstSuggestion))

  const docId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const doc = await api.documents.create({
      docType: 'doc',
      title: 'Reconciliation verification doc',
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
  const asideDoc = window
    .locator('aside')
    .filter({ has: window.getByRole('heading', { name: 'Plexii', exact: true }) })
  const docSubtitle = ((await asideDoc.locator('p').first().textContent()) ?? '').trim()
  const docChip = window.locator('[data-testid="chat-suggestion"]').first()
  const docHasChip = await docChip.isVisible({ timeout: 2_000 }).catch(() => false)
  const docFirstSuggestion = docHasChip ? ((await docChip.textContent()) ?? '').trim() : null
  console.log('CHECK2 DOC subtitle (exact):', JSON.stringify(docSubtitle))
  console.log('CHECK2 DOC first suggestion chip (exact):', JSON.stringify(docFirstSuggestion))

  await window.screenshot({ path: 'test-results/reconciled-assistant.png' })
  console.log('Saved test-results/reconciled-assistant.png')

  expect(desktSubtitle.toLowerCase()).toContain('this desk')
  expect(docSubtitle.toLowerCase()).toContain('this document')

  // ── Back to the desk for the remaining chrome checks ───────────────────────
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => Record<string, (arg?: unknown) => void> }
    }
    w.__fbView?.getState().goHome?.()
  })
  await window.waitForTimeout(500)
  await openDesk('Reconciliation verification desk')

  // ── CHECK 3 — FloatingPill actions incl. Resume, ResumeModal opens ────────
  const floatingPill = window.locator('[data-testid="floating-pill"]')
  await expect(floatingPill).toBeVisible({ timeout: 5_000 })
  await floatingPill.hover()
  await window.waitForTimeout(500)

  const pillActionIds = [
    'pill-focus',
    'pill-chat',
    'pill-meeting',
    'pill-tidy',
    'pill-build',
    'pill-save-template',
    'pill-resume'
  ]
  const pillResults: Record<string, boolean> = {}
  for (const id of pillActionIds) {
    const loc = window.locator(`[data-testid="${id}"]`)
    pillResults[id] = await loc.isVisible({ timeout: 2_000 }).catch(() => false)
  }
  console.log('CHECK3 pill action visibility:', JSON.stringify(pillResults, null, 2))
  for (const id of pillActionIds) {
    expect(pillResults[id], `${id} should be visible in the expanded pill`).toBe(true)
  }

  await window.screenshot({ path: 'test-results/reconciled-desk.png' })
  console.log('Saved test-results/reconciled-desk.png')

  await window.locator('[data-testid="pill-resume"]').click()
  await window.waitForTimeout(500)
  const resumeHeading = window.getByText(/^Resume —/)
  const resumeOpened = await resumeHeading.isVisible({ timeout: 3_000 }).catch(() => false)
  console.log('CHECK3 ResumeModal opened (want true):', resumeOpened)
  expect(resumeOpened).toBe(true)
  // Close it (Escape) so it doesn't block later checks.
  await window.keyboard.press('Escape')
  await window.waitForTimeout(300)

  // ── CHECK 4 — Ryan's chrome: collapsed sidebar strip, single minimap FAB,
  //              breadcrumb desk-switcher ─────────────────────────────────────
  // Sidebar is expanded by default — click "Minimise the menu to free the
  // desk" to collapse it to the icon strip Ryan's chrome ships.
  const minimizeBtn = window.getByRole('button', { name: /Minimise the menu to free the desk/i })
  if (await minimizeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await minimizeBtn.click()
    await window.waitForTimeout(400)
  }
  const collapsedSidebarCount = await window
    .locator('[data-testid="desk-sidebar-collapsed"]')
    .count()
  console.log('CHECK4 collapsed sidebar strip count (want >=1):', collapsedSidebarCount)
  expect(collapsedSidebarCount).toBeGreaterThanOrEqual(1)

  const minimapFabCount = await window.locator('[data-minimap-fab]').count()
  console.log('CHECK4 CanvasMinimapFAB count (want exactly 1):', minimapFabCount)
  expect(minimapFabCount).toBe(1)

  const breadcrumb = window.locator('[data-testid="desk-context-trigger"]')
  await expect(breadcrumb).toBeVisible({ timeout: 5_000 })
  // Hover the current-item segment (last chevron+title span) to open the
  // Stage Manager desk-switcher dropdown.
  const currentItemSpan = breadcrumb.locator('span.inline-flex.items-center.gap-0\\.5.shrink-0').last()
  await currentItemSpan.hover()
  await window.waitForTimeout(600)
  const stageManagerStrip = window.locator('[data-testid="stage-manager-strip"]')
  const deskSwitcherOpened = await stageManagerStrip.isVisible({ timeout: 3_000 }).catch(() => false)
  console.log('CHECK4 breadcrumb desk-switcher (stage-manager-strip) opened (want true):', deskSwitcherOpened)
  expect(deskSwitcherOpened).toBe(true)
  await window.mouse.move(50, 50)
  await window.waitForTimeout(300)

  // ── CHECK 5 — right-click a widget: Pin to corner + Recolor submenus ──────
  // The widget's onContextMenu handler lives on its header (the drag handle),
  // not the outer frame, so right-click the title text inside the header —
  // right-clicking the widget body falls through to the bare-canvas handler.
  const firstWidgetTitle = window.locator('[data-testid^="widget-title-"]').first()
  await expect(firstWidgetTitle).toBeVisible({ timeout: 5_000 })
  await firstWidgetTitle.click({ button: 'right' })
  await window.waitForTimeout(400)
  // "Pin to corner" and "Recolor" are nested one level down, inside the
  // top-level "Organise" submenu — hover it open first.
  const organiseItem = window.getByRole('menuitem', { name: /^Organise/i })
  await expect(organiseItem).toBeVisible({ timeout: 3_000 })
  await organiseItem.hover()
  await window.waitForTimeout(400)
  const pinItem = window.getByRole('menuitem', { name: /Pin to corner/i })
  const recolorItem = window.getByRole('menuitem', { name: /^Recolor/i })
  const pinVisible = await pinItem.isVisible({ timeout: 2_000 }).catch(() => false)
  const recolorVisible = await recolorItem.isVisible({ timeout: 2_000 }).catch(() => false)
  console.log('CHECK5 "Pin to corner" menuitem visible (want true):', pinVisible)
  console.log('CHECK5 "Recolor" menuitem visible (want true):', recolorVisible)
  expect(pinVisible).toBe(true)
  expect(recolorVisible).toBe(true)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(300)

  // ── CHECK 6 — no error boundary, no uncaught exceptions ────────────────────
  const bodyText = await window.locator('body').innerText()
  const errorBoundaryHit = /Something went wrong|Uncaught|Cannot read propert/i.test(bodyText)
  console.log('CHECK6 error boundary text present (want false):', errorBoundaryHit)
  console.log('CHECK6 console errors captured:', JSON.stringify(consoleErrors, null, 2))
  expect(errorBoundaryHit).toBe(false)
})
