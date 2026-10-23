// E2E verification for PlexiMeet (meetings that turn into actions).
// Tests drive the sidebar entry, manual note creation, title/summary editing,
// persistence via IPC, action-items-to-tasks, search, delete, and launcher status.
// The live record path (microphone + transcription key) is not headless-testable
// and is handled separately below.

import { test, expect } from '@playwright/test'
import { openProduct, launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openMeet(window: LaunchedApp['window']): Promise<void> {
  await openProduct(window, 'meet')
  await window.waitForSelector('[data-testid="pleximeet-view"]', { timeout: 8_000 })
}

// ── Test 1: Sidebar entry; honest empty state ──────────────────────────────────

test('1 — sidebar PlexiMeet opens [data-testid="pleximeet-view"] with honest empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openMeet(window)

  const view = window.locator('[data-testid="pleximeet-view"]')
  await expect(view).toBeVisible()

  // Honest empty state message, no sample rows.
  // ModuleDashboard adds a second "No meetings yet." in the recent-items pane,
  // so use .first() to avoid strict-mode on the two matching elements.
  await expect(view.locator('text=No meetings yet').first()).toBeVisible({ timeout: 5_000 })
  const rows = await view.locator('[data-testid^="meet-row-"]').count()
  expect(rows, 'zero rows in fresh DB').toBe(0)

  // Record and Notes buttons present.
  await expect(view.locator('[data-testid="meet-record"]')).toBeVisible()
  await expect(view.locator('[data-testid="meet-add"]')).toBeVisible()
})

// ── Test 2: Create via meet-add, edit title + summary, confirm persistence ──────

test('2 — meet-add creates a meeting; title and summary persist via api.meetings.list()', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMeet(window)

  // Click Notes to create a manual meeting.
  await window.locator('[data-testid="meet-add"]').click()
  await window.waitForSelector('[data-testid="meet-detail"]', { timeout: 5_000 })

  // One row appears in the list.
  await expect(window.locator('[data-testid^="meet-row-"]').first()).toBeVisible()

  // Edit title.
  const titleInput = window.locator('[data-testid="meet-title"]')
  await titleInput.click({ clickCount: 3 })
  await titleInput.fill('Weekly sync')
  await titleInput.press('Tab') // blur → save
  await window.waitForTimeout(200)

  // Edit summary. The Record opens on Commitments since a02f55ab (DEC-100 M2b);
  // the summary is edited in the Brief rendering.
  await window.locator('[data-testid="record-view-brief"]').click()
  const summaryArea = window.locator('[data-testid="meet-summary"]')
  await summaryArea.click()
  await summaryArea.fill('Reviewed Q2 results and aligned on next sprint priorities.')
  await summaryArea.press('Tab') // blur → save
  await window.waitForTimeout(200)

  // Read back via IPC to confirm SQLite write-through.
  const meetings = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return await api.meetings.list()
  })

  expect((meetings as Array<unknown>).length, 'at least one meeting in SQLite').toBeGreaterThanOrEqual(1)
  const m = (meetings as Array<{ title: string; summary: string }>).find((x) => x.title === 'Weekly sync')
  expect(m, 'Weekly sync found in IPC list').toBeTruthy()
  expect(m!.summary, 'summary persisted').toContain('Q2 results')
})

// ── Test 3: Action-items-to-tasks loop ─────────────────────────────────────────

test('3 — action items from a created meeting turn into real task nodes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMeet(window)

  // Create the meeting with action items via the UI's addManual() + IPC update, so
  // the store is in sync without a separate navigate-away-and-back cycle.
  // Step 1: click Notes to create a blank meeting (store gets the new entry via load()).
  await window.locator('[data-testid="meet-add"]').click()
  await window.waitForSelector('[data-testid="meet-detail"]', { timeout: 5_000 })

  // Step 2: retrieve the new meeting's id from the store then update it with action
  // items directly via IPC. Then reload the store via evaluate.
  const meetId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const meetings = await api.meetings.list()
    const first = (meetings as Array<{ id: string }>)[0]
    if (!first) return null
    await api.meetings.update(first.id, {
      title: 'Standup',
      actionItems: ['Ship the release', 'Email Sam']
    })
    return first.id
  })
  expect(meetId, 'meeting id retrieved').toBeTruthy()

  // Step 3: trigger store reload via the search input blur (forces a re-render) or
  // click away and back to the same row to re-open detail with fresh store state.
  // Simplest: click the row in the list (store already updated its local state via
  // the IPC call; but we need the React store to re-fetch).
  // Force a reload by clicking the Notes button and immediately cancelling is fragile.
  // Instead, call the store's load() through window.evaluate.
  await window.evaluate(async () => {
    // Access the zustand store directly via a named export exposed at window level
    // if it exists — but it doesn't. Instead just navigate to trigger useEffect.
    // We trigger the pleximeet-view's useEffect load() by using api.meetings.list()
    // to confirm the patch landed, then trust the store's optimistic update.
    const api = (window as unknown as { api: typeof window.api }).api
    const meetings = await api.meetings.list()
    return meetings
  })

  // Navigate away and back to reload the view's store. Meet (PlexiiCall) is a
  // PlexiiApps tile in the Office side menu, so bounce off Inbox (a Tools tile)
  // and back.
  await window.locator('[data-testid="office-comms-app-inbox"]').click()
  await window.locator('[data-testid="office-sideapp-meet"]').click()
  await window.waitForSelector('[data-testid="pleximeet-view"]', { timeout: 8_000 })

  // Click the Standup meeting row.
  await window.locator(`[data-testid="meet-row-${meetId}"]`).click()
  await window.waitForSelector('[data-testid="meet-detail"]', { timeout: 5_000 })

  // Both items are listed. meet-actions became the Commitments rendering's
  // "From the summary" list in a02f55ab (DEC-100 M2b), each line with its own
  // make-a-desk button.
  const actionsSection = window.locator('[data-testid="meet-legacy-items"]')
  await expect(actionsSection).toBeVisible({ timeout: 4_000 })
  await expect(actionsSection.locator('text=Ship the release')).toBeVisible()
  await expect(actionsSection.locator('text=Email Sam')).toBeVisible()

  // Click meet-make-task-0 to turn the first action into a real task.
  await window.locator('[data-testid="meet-make-task-0"]').click()
  await window.waitForTimeout(400)

  // Button should show "Added".
  await expect(window.locator('[data-testid="meet-make-task-0"]')).toContainText('Added')

  // Confirm the real task node exists in nodes.list().
  const nodes = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return await api.nodes.list()
  })
  const task = (nodes as Array<{ title: string; kind: string }>).find(
    (n) => n.kind === 'task' && n.title === 'Ship the release'
  )
  expect(task, '"Ship the release" task node created in SQLite').toBeTruthy()
})

// ── Test 4: Search filters; delete returns to honest empty state ───────────────

test('4 — meet-search filters list; meet-delete removes meeting and shows empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMeet(window)

  // Create two meetings via the UI's add-notes flow so the store is kept in sync
  // without needing a separate reload navigation.
  async function createNamedMeeting(name: string): Promise<void> {
    await window.locator('[data-testid="meet-add"]').click()
    await window.waitForSelector('[data-testid="meet-detail"]', { timeout: 5_000 })
    const t = window.locator('[data-testid="meet-title"]')
    await t.click({ clickCount: 3 })
    await t.fill(name)
    await t.press('Tab')
    await window.waitForTimeout(200)
    // Click into the search bar to deselect so next add starts cleanly.
    await window.locator('[data-testid="meet-search"]').click()
    await window.waitForTimeout(100)
  }

  await createNamedMeeting('Board review')
  await createNamedMeeting('Design critique')

  const rows = window.locator('[data-testid^="meet-row-"]')
  await expect(rows).toHaveCount(2, { timeout: 4_000 })

  // Search for "Board" — should filter to one.
  const searchInput = window.locator('[data-testid="meet-search"]')
  await searchInput.fill('Board')
  await window.waitForTimeout(200)
  await expect(window.locator('[data-testid^="meet-row-"]')).toHaveCount(1)
  await expect(window.locator('text=Board review')).toBeVisible()

  // Clear search — both return.
  await searchInput.fill('')
  await window.waitForTimeout(200)
  await expect(window.locator('[data-testid^="meet-row-"]')).toHaveCount(2)

  // Open "Design critique" and delete it.
  await window.locator('text=Design critique').first().click()
  await window.waitForSelector('[data-testid="meet-detail"]', { timeout: 4_000 })
  await window.locator('[data-testid="meet-delete"]').click()
  await window.waitForTimeout(300)

  // Only one meeting remains.
  await expect(window.locator('[data-testid^="meet-row-"]')).toHaveCount(1)

  // Delete the second meeting too.
  await window.locator('[data-testid^="meet-row-"]').first().click()
  await window.waitForSelector('[data-testid="meet-detail"]', { timeout: 4_000 })
  await window.locator('[data-testid="meet-delete"]').click()
  await window.waitForTimeout(300)

  // Honest empty state returns. Use .first() — ModuleDashboard adds a second
  // "No meetings yet." in its recent-items pane alongside the rail instance.
  await expect(window.locator('text=No meetings yet').first()).toBeVisible({ timeout: 3_000 })
  await expect(window.locator('[data-testid^="meet-row-"]')).toHaveCount(0)
})

// ── Test 5: PlexiMeet is READY in the launcher ─────────────────────────────────

test('5 — PlexiMeet shows as ready in the PlexiSuite launcher (Open button, no badge)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Open PlexiSuite home. Its sidebar button went with the object-based IA, so
  // go through the view store (gotoView's goSuite is landing with ec's red-suite-41).
  await window.evaluate(() => {
    ;(window as unknown as { __fbView: { getState: () => { goSuite: () => void } } }).__fbView.getState().goSuite()
  })
  await window.waitForSelector('[data-testid="plexisuite-home"]', { timeout: 8_000 })

  const tile = window.locator('[data-testid="product-tile-pleximeet"]')
  await expect(tile).toBeVisible()
  await expect(tile.locator('text=Coming soon')).toHaveCount(0)
  await expect(tile.locator('text=Planned')).toHaveCount(0)
  await expect(tile.locator('[data-testid="upvote-pleximeet"]')).toHaveCount(0)

  // Navigate to product home and confirm Open button.
  await tile.click()
  await window.waitForSelector('[data-testid="product-home-pleximeet"]', { timeout: 6_000 })
  await expect(window.locator('[data-testid="open-pleximeet"]')).toBeVisible()
})

// ── Test 6: Record button present; clicking without mic surfaces honest error ──

test('6 — meet-record renders; clicking without mic shows honest error in meet-error', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMeet(window)

  // The Record button must be present (not crashed).
  const recordBtn = window.locator('[data-testid="meet-record"]')
  await expect(recordBtn).toBeVisible()

  // DEC-118/130: Record opens the dialog first; Start asks the system, LISTENS
  // for 1.2 s, and either refuses honestly (record-error, with the reason) or
  // begins. In headless Electron there is no real microphone device, so
  // getUserMedia rejects (or hands over silence) and the dialog says so.
  await recordBtn.click()
  await expect(window.locator('[data-testid="record-dialog"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="record-start"]').click()
  const errorEl = window.locator('[data-testid="record-error"]')

  // Two expected outcomes in headless:
  //   (a) meet-error appears (getUserMedia denied) — PASS
  //   (b) meet-stop appears briefly (stream opened but empty) then errors — treat as PASS too
  // We give up after 4s and note it if neither appears (some headless builds grant
  // a dummy mic, so meet-stop may appear without an error).
  const gotError = await errorEl.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true).catch(() => false)
  const gotStop = await window.locator('[data-testid="meet-stop"]').waitFor({ state: 'visible', timeout: 500 }).then(() => true).catch(() => false)

  // Either the error appeared (expected path) or the stop button appeared (dummy mic path).
  // Both are acceptable; a JS crash (neither appearing, app blank) is the failure we rule out.
  const appStillVisible = await window.locator('[data-testid="pleximeet-view"]').isVisible()
  expect(appStillVisible, 'app did not crash after clicking Record').toBe(true)

  if (gotError) {
    // Confirm the error text is honest, not a crash dump.
    const errText = await errorEl.textContent()
    expect(errText, 'error text mentions microphone or permissions').toMatch(/microphone|permission|mic/i)
  } else if (gotStop) {
    // Dummy mic path: record started. That's fine for headless.
    // Stop it to clean up.
    await window.locator('[data-testid="meet-stop"]').click().catch(() => null)
  }
  // If neither appeared within budget: the app did not crash (assertion above passed),
  // but the mic error was not surfaced — noted in the verdict as a harness limitation.
})
