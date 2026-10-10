import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, switchArea, isAreaLocked } from './_helpers'
import { resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'

// Brochure screenshot capture for early-adopter print material — NOT a
// functional regression test. Seeds honest workspace content (real planning
// text, a real table, a real doc) and captures the running Plexi3.0 build.
// No fabricated metrics, no faked AI replies — the assistant shot shows its
// real empty-state (contextual header + starter chips), nothing more.
//
// Run manually:
//   npx playwright test tests/e2e/_brochureShots.spec.ts --timeout 180000

const OUT_DIR = resolve(__dirname, '../../test-results')
function outPath(name: string): string {
  return resolve(OUT_DIR, name)
}

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function dismissChrome(window: LaunchedApp['window']): Promise<void> {
  // "New: Rooms, Desks and Plans" onboarding toast (bottom-right).
  const laterBtn = window.getByRole('button', { name: 'Later' })
  if (await laterBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await laterBtn.click().catch(() => {})
    await window.waitForTimeout(200)
  }
  // "What's new" panel, if present.
  const whatsNewClose = window.locator('[data-testid="whats-new-close"]')
  if (await whatsNewClose.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await whatsNewClose.click().catch(() => {})
    await window.waitForTimeout(200)
  }
  const genericClose = window.getByRole('button', { name: /^close$/i })
  if (await genericClose.first().isVisible({ timeout: 500 }).catch(() => false)) {
    await genericClose.first().click().catch(() => {})
    await window.waitForTimeout(200)
  }
}

test('capture brochure screenshots (UI-driven, honest content)', async () => {
  test.setTimeout(180_000)
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  launched = await launchApp()
  const { app, window } = launched

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.setContentSize(1440, 900)
      win.center()
    }
  })

  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  window.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

  await waitForReady(window)
  await dismissChrome(window)

  // ── Seed one honest desk: "Q3 Product Launch" ──────────────────────────
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api

    const desk = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Q3 Product Launch'
    })

    // y starts at 160, not 60 — the floating desk header pill (breadcrumb +
    // title + priority/interest/importance badges) sits at top-2 z-30 and can
    // extend wide enough to intercept clicks on a widget's own top-right
    // controls if the widget starts too close to the top of the canvas.
    const stickyA = await api.widgets.create({
      taskId: desk.id,
      kind: 'sticky',
      title: '',
      content: 'Ship the split-view focus mode',
      x: 60,
      y: 160,
      width: 240,
      height: 160
    })
    const stickyB = await api.widgets.create({
      taskId: desk.id,
      kind: 'sticky',
      title: '',
      content: 'Draft the launch email',
      x: 330,
      y: 160,
      width: 240,
      height: 160
    })
    const stickyC = await api.widgets.create({
      taskId: desk.id,
      kind: 'sticky',
      title: '',
      content: 'Line up 10 design partners',
      x: 600,
      y: 160,
      width: 240,
      height: 160
    })

    // Real table: backing fb_tables record + typed columns, then a table
    // WIDGET whose content is the table id (same pattern the app itself uses
    // — see Canvas.tsx's 'table' create branch).
    const launchTable = await api.tables.create({
      title: 'Launch Tasks',
      schema: {
        columns: [
          { id: 'col-task', type: 'text-short', label: 'Task', config: {} },
          { id: 'col-owner', type: 'text-short', label: 'Owner', config: {} },
          { id: 'col-status', type: 'single-select', label: 'Status', config: {
            options: [
              { id: 'st-done', label: 'Done', color: '#22c55e' },
              { id: 'st-prog', label: 'In progress', color: '#3b82f6' },
              { id: 'st-todo', label: 'To do', color: '#94a3b8' }
            ]
          } }
        ]
      }
    })
    const rows: Array<[string, string, string]> = [
      ['Finalise feature spec', 'Michael', 'st-done'],
      ['Build the landing page', 'Angie', 'st-prog'],
      ['Line up design partners', 'Caleb', 'st-prog'],
      ['Write launch email copy', 'Chris', 'st-todo']
    ]
    for (const [taskText, owner, statusId] of rows) {
      await api.tables.createRow({
        tableId: launchTable.id,
        cells: { 'col-task': taskText, 'col-owner': owner, 'col-status': statusId }
      })
    }
    const table = await api.widgets.create({
      taskId: desk.id,
      kind: 'table',
      title: 'Launch Tasks',
      content: launchTable.id,
      x: 60,
      y: 360,
      width: 560,
      height: 260
    })

    const note = await api.widgets.create({
      taskId: desk.id,
      kind: 'note',
      title: 'Launch Notes',
      content:
        'Beta opens to the first 50 signups on the waitlist.\nFocus the demo on split-view and the new desk canvas.',
      x: 660,
      y: 360,
      width: 300,
      height: 220
    })

    return { deskId: desk.id, stickyAId: stickyA.id, stickyBId: stickyB.id, stickyCId: stickyC.id, tableId: table.id, noteId: note.id }
  })

  await window.reload()
  await waitForReady(window)
  await dismissChrome(window)

  // Open the desk.
  await window.getByRole('button', { name: 'Q3 Product Launch' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.stickyAId}"]`, { timeout: 8_000 })
  await window.waitForTimeout(900)
  await dismissChrome(window)

  const widgetCount = await window.locator('[data-widget-id]').count()
  console.log('widgets rendered on Q3 Product Launch desk:', widgetCount)

  // ── PRIORITY 1: shot-desk.png — the hero shot ───────────────────────────
  await window.waitForTimeout(400)
  await window.screenshot({ path: outPath('shot-desk.png'), fullPage: false })
  console.log('SAVED', outPath('shot-desk.png'), '— Q3 Product Launch desk: 3 stickies, a 4-row table, a note; header pill + bottom dock + minimap visible')

  // ── PRIORITY 2: shot-assistant.png — right-rail assistant, honest empty state
  // The assistant panel is open by default (chatCollapsed=false in App.tsx).
  // Focus the desk (no widget) so the assistant context reads "this desk".
  await window.keyboard.press('Escape').catch(() => {})
  await window.waitForTimeout(300)
  const chatSuggestion = window.locator('[data-testid="chat-suggestion"]').first()
  const assistantReady = await chatSuggestion.isVisible({ timeout: 5_000 }).catch(() => false)
  console.log('assistant starter chips visible:', assistantReady)
  await window.waitForTimeout(300)
  await window.screenshot({ path: outPath('shot-assistant.png'), fullPage: false })
  console.log('SAVED', outPath('shot-assistant.png'), '— right-rail Assistant panel, contextual header ("this desk · Q3 Product Launch") + starter suggestion chips, no fabricated conversation')

  // ── PRIORITY 3: shot-focus.png — Focus Mode split view (2 panes) ────────
  const widgetA = window.locator(`[data-widget-id="${seeded.stickyAId}"]`).first()
  await expect(widgetA).toBeVisible({ timeout: 5_000 })
  await widgetA.scrollIntoViewIfNeeded().catch(() => {})
  const expandBtn = widgetA.locator('button[aria-label="Expand options"]')
  const focusModeOption = window.getByText('Focus mode', { exact: true })
  // Retry the hover -> click sequence a few times: the popover's position is
  // computed in a useEffect on `open`, so an occasional race between the click
  // and that effect can close/miss it. Re-hover + re-click if the option
  // hasn't appeared yet.
  let focusMenuOpen = false
  for (let attempt = 0; attempt < 4 && !focusMenuOpen; attempt++) {
    await widgetA.hover()
    await window.waitForTimeout(200)
    await expect(expandBtn).toBeVisible({ timeout: 5_000 })
    if (attempt % 2 === 0) {
      await expandBtn.click()
    } else {
      await expandBtn.click({ force: true })
    }
    focusMenuOpen = await focusModeOption.isVisible({ timeout: 1_500 }).catch(() => false)
    if (!focusMenuOpen) {
      console.log(`focus-mode popover attempt ${attempt + 1} did not open, retrying`)
      const widgetABox = await widgetA.boundingBox()
      const expandBtnBox = await expandBtn.boundingBox()
      console.log('widgetA box:', JSON.stringify(widgetABox), 'expandBtn box:', JSON.stringify(expandBtnBox))
      await window.keyboard.press('Escape').catch(() => {})
      await window.waitForTimeout(300)
    }
  }
  await expect(focusModeOption).toBeVisible({ timeout: 5_000 })
  await focusModeOption.click({ force: true })
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toBeVisible({ timeout: 5_000 })

  const tileB = window.locator(`[data-testid="focus-dock-tile-${seeded.stickyBId}"]`)
  await expect(tileB).toBeVisible({ timeout: 5_000 })
  const tileBox = await tileB.boundingBox()
  if (tileBox) {
    const startX = tileBox.x + tileBox.width / 2
    const startY = tileBox.y + tileBox.height / 2
    const viewport = window.viewportSize() ?? { width: 1440, height: 900 }
    const targetX = viewport.width * 0.72
    const targetY = viewport.height * 0.5
    await window.mouse.move(startX, startY)
    await window.mouse.down()
    const steps = 12
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await window.mouse.move(startX + (targetX - startX) * t, startY + (targetY - startY) * t)
      await window.waitForTimeout(40)
    }
    await window.waitForTimeout(200)
    await window.mouse.up()
  }
  const splitGrid = window.locator('[data-testid="focus-split-grid"][data-previewing="false"]')
  const splitOk = await splitGrid.isVisible({ timeout: 5_000 }).catch(() => false)
  console.log('focus split-view engaged via real pointer drag:', splitOk)
  await window.waitForTimeout(500)
  await window.screenshot({ path: outPath('shot-focus.png'), fullPage: false })
  console.log('SAVED', outPath('shot-focus.png'), '— Focus Mode 2-pane split view (', splitOk ? 'both panes confirmed' : 'split-grid not confirmed, screenshotted best-effort state', ')')

  // Exit focus mode back to the desk before continuing.
  await window.keyboard.press('Escape').catch(() => {})
  await window.waitForTimeout(400)
  const stillInFocus = await window.locator('[data-testid="widget-focus-mode"]').isVisible({ timeout: 1_000 }).catch(() => false)
  if (stillInFocus) {
    const exitBtn = window.locator('[data-testid="widget-focus-mode"] button[aria-label*="Close" i], [data-testid="widget-focus-mode"] button[title*="Close" i]').first()
    if (await exitBtn.isVisible({ timeout: 1_000 }).catch(() => false)) await exitBtn.click().catch(() => {})
    await window.waitForTimeout(400)
  }

  console.log('=== PRIORITY 1-3 COMPLETE ===')

  // ── PRIORITY 4: shot-office.png — a real PlexiOffice document ───────────
  let officeShotResult = 'attempted'
  try {
    const docSeed = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const doc = await api.documents.create({
        docType: 'doc',
        title: 'Q3 Launch — Product Brief',
        body: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Q3 Launch — Product Brief' }] },
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'We are opening the beta to the first 50 people on the waitlist this quarter. The focus of the demo is the new split-view focus mode and the redesigned desk canvas.'
                }
              ]
            },
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Everything in this brief should be honest and specific: real dates, real owners, real scope. No filler.'
                }
              ]
            }
          ]
        }
      })
      return { docId: doc.id }
    })

    await window.reload()
    await waitForReady(window)
    await dismissChrome(window)

    await switchArea(window, 'office')
    await window.waitForTimeout(600)
    const officeLocked = await isAreaLocked(window, 'office')
    if (officeLocked) {
      officeShotResult = 'SKIPPED — PlexiOffice area is entitlement-gated (data-locked=true) in this test env'
    } else {
      const docRow = window.locator(`[data-testid="office-recent-row-${docSeed.docId}"]`)
      const docRowVisible = await docRow.isVisible({ timeout: 5_000 }).catch(() => false)
      if (docRowVisible) {
        await docRow.click()
      } else {
        // Fallback: click by visible title text.
        await window.getByText('Q3 Launch — Product Brief').first().click()
      }
      const surface = window.locator('[data-testid="doc-editor-surface"]')
      const surfaceVisible = await surface.isVisible({ timeout: 8_000 }).catch(() => false)
      if (surfaceVisible) {
        await expect(window.locator('[data-testid="doc-toolbar"]')).toBeVisible({ timeout: 5_000 }).catch(() => {})
        await window.waitForTimeout(600)
        await window.screenshot({ path: outPath('shot-office.png'), fullPage: false })
        officeShotResult = 'SAVED — PlexiDocs editor open on "Q3 Launch — Product Brief" (real heading + 2 paragraphs), formatting toolbar visible'
      } else {
        // Fall back to the PlexiOffice suite home with app tiles.
        await window.waitForTimeout(500)
        await window.screenshot({ path: outPath('shot-office.png'), fullPage: false })
        officeShotResult = 'SAVED (fallback) — doc editor surface did not confirm; captured PlexiOffice home/app-tiles view instead'
      }
    }
  } catch (e) {
    officeShotResult = `SKIPPED — error: ${String(e)}`
  }
  console.log('shot-office.png result:', officeShotResult)

  // ── PRIORITY 5: shot-people.png — People Map ─────────────────────────────
  let peopleShotResult = 'attempted'
  try {
    // Navigate home first so switching area doesn't fight with the open doc editor.
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goHome?.()
    })
    await window.waitForTimeout(400)
    await switchArea(window, 'plexipeople')
    await window.waitForTimeout(700)
    const peopleLocked = await isAreaLocked(window, 'plexipeople')
    if (peopleLocked) {
      peopleShotResult = 'SKIPPED — People area is entitlement-gated (data-locked=true) in this test env'
    } else {
      // Click the "Organisation Map" app tile if we land on a segment home first.
      const mapTile = window.locator('[data-testid="segment-app-map"]')
      if (await mapTile.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await mapTile.click()
        await window.waitForTimeout(600)
      }
      const peopleMap = window.locator('[data-testid="people-map"]')
      const peopleMapVisible = await peopleMap.isVisible({ timeout: 6_000 }).catch(() => false)
      if (peopleMapVisible) {
        await window.waitForTimeout(700)
        await window.screenshot({ path: outPath('shot-people.png'), fullPage: false })
        peopleShotResult = 'SAVED — People Map view rendered'
      } else {
        peopleShotResult = 'SKIPPED — [data-testid="people-map"] did not render (no org/team data reachable in this isolated test profile)'
      }
    }
  } catch (e) {
    peopleShotResult = `SKIPPED — error: ${String(e)}`
  }
  console.log('shot-people.png result:', peopleShotResult)

  // ── PRIORITY 6: shot-chat.png — PlexiChat ────────────────────────────────
  let chatShotResult = 'attempted'
  try {
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goHome?.()
    })
    await window.waitForTimeout(400)
    await switchArea(window, 'office')
    await window.waitForTimeout(500)
    const chatTile = window.locator('[data-testid="office-comms-app-chat"]')
    const chatTileVisible = await chatTile.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!chatTileVisible) {
      chatShotResult = 'SKIPPED — office-comms-app-chat tile not reachable (gated or not rendered from this entry point)'
    } else {
      await chatTile.click()
      await window.waitForTimeout(800)
      const chatSurface = window.locator('[data-testid="office-comms-chat"]')
      const chatVisible = await chatSurface.isVisible({ timeout: 5_000 }).catch(() => false)
      await window.waitForTimeout(400)
      await window.screenshot({ path: outPath('shot-chat.png'), fullPage: false })
      chatShotResult = chatVisible
        ? 'SAVED — PlexiChat surface rendered (channel list + message pane)'
        : 'SAVED (best-effort) — office-comms-chat testid not confirmed but screenshotted current state'
    }
  } catch (e) {
    chatShotResult = `SKIPPED — error: ${String(e)}`
  }
  console.log('shot-chat.png result:', chatShotResult)

  console.log('=== ALL CAPTURES DONE ===')
  console.log('console errors captured during run:', JSON.stringify(consoleErrors, null, 2))
})
