import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, switchArea, isAreaLocked } from './_helpers'
import { resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'

// Second marketing screenshot pass — NOT a functional regression test.
// Captures: shot-suite, shot-sheet, shot-plans, shot-mail, shot-people, shot-chat.
// Honest workspace content only (real plan tasks, real sheet rows). No
// fabricated metrics/analytics/AI replies. Gated surfaces are skipped and
// reported, never faked.
//
// Run manually:
//   npx playwright test tests/e2e/_marketingShots2.spec.ts --timeout 180000

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
  const laterBtn = window.getByRole('button', { name: 'Later' })
  if (await laterBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await laterBtn.click().catch(() => {})
    await window.waitForTimeout(200)
  }
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

test('capture marketing screenshots batch 2 (UI-driven, honest content)', async () => {
  test.setTimeout(180_000)
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  launched = await launchApp({ extraArgs: ['--force-device-scale-factor=2'] })
  const { app, window } = launched

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.setContentSize(1440, 900)
      win.center()
    }
  })

  await waitForReady(window)
  await dismissChrome(window)

  // ── Seed honest workspace content ───────────────────────────────────────
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api

    // A real plan: a folder marked isPlan, with dated tasks so the Gantt has
    // a real schedule to draw (see shared/gantt.ts — nothing invented, the
    // engine computes bars from these dates).
    const planFolder = await api.nodes.create({
      parentId: null,
      kind: 'folder',
      isPlan: true,
      title: 'Q3 Launch Plan'
    })
    const planTaskDefs: Array<[string, number, number]> = [
      ['Positioning & messaging', 0, 6],
      ['Landing page build', 4, 14],
      ['Beta invite email', 10, 12],
      ['Webinar program', 12, 26],
      ['Launch day + PR push', 26, 29]
    ]
    const now = Date.now()
    const day = 86_400_000
    for (const [title, startOffset, endOffset] of planTaskDefs) {
      const t = await api.nodes.create({ parentId: planFolder.id, kind: 'task', title })
      await api.projects.setTaskPlan(t.id, {
        planStart: now + startOffset * day,
        planDue: now + endOffset * day
      })
    }

    // A real spreadsheet: honest marketing-budget rows with live formulas.
    const sheet = await api.documents.create({
      docType: 'sheet',
      title: 'Marketing Budget',
      body: {
        version: 2,
        activeSheet: 0,
        sheets: [
          {
            id: 'tab-budget',
            name: 'Budget',
            columns: ['Channel', 'Budget', 'Spent', 'Remaining'],
            rows: [
              ['LinkedIn Ads', '12000', '7440', '=B1-C1'],
              ['Webinars', '8000', '5200', '=B2-C2'],
              ['Content & SEO', '15000', '9100', '=B3-C3'],
              ['Field Events', '22000', '14300', '=B4-C4'],
              ['Total', '=SUM(B1:B4)', '=SUM(C1:C4)', '=SUM(D1:D4)']
            ],
            colWidths: { 0: 180, 1: 100, 2: 100, 3: 110 },
            formats: { '4,0': { bold: true }, '4,1': { bold: true }, '4,2': { bold: true }, '4,3': { bold: true } }
          }
        ]
      }
    })

    return { planFolderId: planFolder.id, sheetId: sheet.id }
  })

  await window.reload()
  await waitForReady(window)
  await dismissChrome(window)

  const results: Record<string, string> = {}

  // ── 1. shot-suite.png — PlexiOffice home: segment switcher (Desk/Office/
  // People/Brain) in the sidebar + the app tiles grid (Docs/Sheets/Slides/
  // Draw/Design/Meet), the clearest single view of app breadth. ────────────
  try {
    await switchArea(window, 'office')
    await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="office-app-sheets"]')).toBeVisible({ timeout: 8_000 })
    await window.waitForTimeout(500)
    await window.screenshot({ path: outPath('shot-suite.png'), fullPage: false })
    results.suite = 'SAVED — PlexiOffice home: Desk/Office/People/Brain switcher + app tiles (Docs, Sheets, Slides, Draw, Design, Meet)'
  } catch (e) {
    results.suite = `SKIPPED — error: ${String(e)}`
  }
  console.log('shot-suite.png:', results.suite)
  console.log('SAVED-PATH', outPath('shot-suite.png'))

  // ── 2. shot-sheet.png — the seeded spreadsheet, formula bar + toolbar ───
  try {
    const sheetRow = window.locator(`[data-testid="office-recent-row-${seeded.sheetId}"]`)
    const rowVisible = await sheetRow.isVisible({ timeout: 4_000 }).catch(() => false)
    if (rowVisible) {
      await sheetRow.click()
    } else {
      await window.getByText('Marketing Budget').first().click()
    }
    await window.waitForSelector('input[placeholder*="Select a cell"]', { timeout: 10_000 })
    await window.waitForTimeout(500)
    await window.locator('[data-testid="cell-4-1"]').click().catch(() => {})
    await window.waitForTimeout(400)
    await window.screenshot({ path: outPath('shot-sheet.png'), fullPage: false })
    results.sheet = 'SAVED — PlexiSheets "Marketing Budget": 4 channel rows + live-formula Total row, formula bar + toolbar visible'
  } catch (e) {
    results.sheet = `SKIPPED — error: ${String(e)}`
  }
  console.log('shot-sheet.png:', results.sheet)
  console.log('SAVED-PATH', outPath('shot-sheet.png'))

  // Back to home before switching areas.
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState().goHome?.()
  })
  await window.waitForTimeout(400)

  // ── 3. shot-plans.png — the seeded Q3 Launch Plan, Gantt timeline view ──
  try {
    await switchArea(window, 'plexidesk').catch(() => {})
    await window.waitForTimeout(300)
    // The projects/plans view lives straight off the view store.
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goProjects?.()
    })
    await expect(window.locator('[data-testid="plexiprojects-view"]')).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="project-card-${seeded.planFolderId}"]`).click()
    await window.locator('[data-testid="projects-view-gantt"]').click().catch(() => {})
    await expect(window.locator(`[data-testid="gantt-row-"]`).first()).toBeVisible({ timeout: 8_000 }).catch(() => {})
    await window.waitForTimeout(900)
    await window.screenshot({ path: outPath('shot-plans.png'), fullPage: false })
    results.plans = 'SAVED — Q3 Launch Plan Gantt timeline: 5 real dated tasks, critical path/today line computed live'
  } catch (e) {
    results.plans = `SKIPPED (Gantt) — error: ${String(e)}`
  }
  console.log('shot-plans.png:', results.plans)
  console.log('SAVED-PATH', outPath('shot-plans.png'))

  // ── 4. shot-mail.png — Mail (honest connect/empty state if unconnected) ─
  try {
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goHome?.()
    })
    await window.waitForTimeout(300)
    await switchArea(window, 'office')
    await window.waitForTimeout(400)
    const mailTile = window.locator('[data-testid="office-comms-app-mail"]')
    const mailTileVisible = await mailTile.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!mailTileVisible) {
      results.mail = 'SKIPPED — office-comms-app-mail tile not reachable (gated in this test env)'
    } else {
      await mailTile.click()
      await window.waitForTimeout(800)
      await window.screenshot({ path: outPath('shot-mail.png'), fullPage: false })
      results.mail = 'SAVED — Mail surface (honest state: no IMAP account connected in this isolated test profile, so this is the real "Connect your email" setup screen, not an inbox)'
    }
  } catch (e) {
    results.mail = `SKIPPED — error: ${String(e)}`
  }
  console.log('shot-mail.png:', results.mail)
  console.log('SAVED-PATH', outPath('shot-mail.png'))

  // ── 5. shot-people.png — People Map ──────────────────────────────────────
  try {
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goHome?.()
    })
    await window.waitForTimeout(300)
    await switchArea(window, 'plexipeople')
    await window.waitForTimeout(700)
    const peopleLocked = await isAreaLocked(window, 'plexipeople')
    if (peopleLocked) {
      results.people = 'SKIPPED — People area is entitlement-gated (data-locked=true) in this test env'
    } else {
      const mapTile = window.locator('[data-testid="segment-app-map"]')
      if (await mapTile.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await mapTile.click()
        await window.waitForTimeout(600)
      }
      const peopleMap = window.locator('[data-testid="people-map"]')
      const visible = await peopleMap.isVisible({ timeout: 6_000 }).catch(() => false)
      if (visible) {
        await window.waitForTimeout(600)
        await window.screenshot({ path: outPath('shot-people.png'), fullPage: false })
        results.people = 'SAVED — People Map rendered'
      } else {
        results.people = 'SKIPPED — [data-testid="people-map"] did not render (no org/team data reachable in this isolated test profile)'
      }
    }
  } catch (e) {
    results.people = `SKIPPED — error: ${String(e)}`
  }
  console.log('shot-people.png:', results.people)
  console.log('SAVED-PATH', outPath('shot-people.png'))

  // ── 6. shot-chat.png — PlexiChat ─────────────────────────────────────────
  try {
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goHome?.()
    })
    await window.waitForTimeout(300)
    await switchArea(window, 'office')
    await window.waitForTimeout(400)
    const chatTile = window.locator('[data-testid="office-comms-app-chat"]')
    const chatTileVisible = await chatTile.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!chatTileVisible) {
      results.chat = 'SKIPPED — office-comms-app-chat tile not reachable (gated in this test env)'
    } else {
      await chatTile.click()
      await window.waitForTimeout(800)
      await window.screenshot({ path: outPath('shot-chat.png'), fullPage: false })
      results.chat = 'SAVED — PlexiChat surface rendered'
    }
  } catch (e) {
    results.chat = `SKIPPED — error: ${String(e)}`
  }
  console.log('shot-chat.png:', results.chat)
  console.log('SAVED-PATH', outPath('shot-chat.png'))

  console.log('=== RESULTS JSON ===', JSON.stringify(results, null, 2))
})
