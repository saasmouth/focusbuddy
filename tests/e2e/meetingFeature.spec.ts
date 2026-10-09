import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, openProduct, gotoView } from './_helpers'
import type { LaunchedApp } from './_helpers'

// Tests for the "start/schedule a meeting from anywhere" feature.
// Goal 2: calendar block composer meeting toggle + persistence (meeting_json column).
// Goal 3: editor Insert → Meeting item navigates to meetings view without throw.
// Goal 4: chat composer meet button exists and navigates.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ─── Goal 2a: meeting_json column migration runs cleanly + meeting persists ───

test('MF-1 — DB boots cleanly and meeting_json column exists on time_blocks', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Create a regular (non-meeting) time block to confirm base CRUD works.
  const block = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const start = Date.now() + 3_600_000
    return api.timeBlocks.create({ taskId: null, title: 'Focus', startMs: start, durationMin: 30 })
  })

  expect(block.id).toBeTruthy()
  expect(block.meeting).toBeNull()

  // Now create a meeting block — exercises the meeting_json column.
  const meetingBlock = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const start = Date.now() + 7_200_000
    return api.timeBlocks.create({
      taskId: null,
      title: 'Standup',
      startMs: start,
      durationMin: 30,
      meeting: { roomId: 'meet-test-abc123', invitees: ['alice@example.com', 'bob@example.com'] }
    })
  })

  expect(meetingBlock.id).toBeTruthy()
  expect(meetingBlock.meeting).not.toBeNull()
  expect(meetingBlock.meeting?.roomId).toBe('meet-test-abc123')
  expect(meetingBlock.meeting?.invitees).toEqual(['alice@example.com', 'bob@example.com'])

  // Confirm it persists: re-query the range and find it.
  const persisted = await window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const blocks = await api.timeBlocks.list(Date.now(), Date.now() + 24 * 3_600_000)
    return blocks.find((b) => b.id === id) ?? null
  }, meetingBlock.id)

  expect(persisted).not.toBeNull()
  expect(persisted?.meeting?.roomId).toBe('meet-test-abc123')
})

// ─── Goal 2b: calendar block composer — meeting toggle reveals invitees ────────

test('MF-2 — calendar block composer meeting toggle reveals invitees field', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Open Calendar and switch to Week view.
  await gotoView(window, 'goCalendar')
  // The calendar-mode-* buttons are gone; the mode is persisted under
  // localStorage 'calendar.mode' (and defaults to week). Set it and reload
  // rather than clicking a control that no longer exists.
  await window.evaluate(() => localStorage.setItem('calendar.mode', 'week'))
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goCalendar: () => void } } }
    w.__fbView?.getState().goCalendar()
  })
  await expect(window.locator('[data-testid="week-time-grid"]')).toBeVisible({ timeout: 6000 })

  // Click a slot to open the booking surface.
  //
  // The inline BlockComposer was deleted by DEC-080 (34feaab1, 2026-08-30):
  // the Book time dialog is now the create, edit and proposal surface, and a
  // plain click on the grid opens it at the pressed slot. Its meeting toggle is
  // the mode slider in its header (Focus time | Meeting), and the meeting-only
  // fields — guests first — are revealed by choosing Meeting.
  await window.locator('[data-testid="day-col-2"]').click({ position: { x: 20, y: 180 } })
  const dialog = window.locator('[data-testid="book-time-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 4000 })

  // The meeting toggle is present and starts on Focus time: no guest field yet.
  const meetingTab = dialog.getByRole('tab', { name: 'Meeting' })
  await expect(meetingTab).toBeVisible()
  await expect(meetingTab).toHaveAttribute('aria-selected', 'false')
  await expect(dialog.locator('[data-testid="guest-field"]')).toHaveCount(0)

  // Toggle ON → the invitees (guests) field appears.
  await meetingTab.click()
  await expect(meetingTab).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.locator('[data-testid="guest-input"]')).toBeVisible({ timeout: 2000 })
})

// ─── Goal 2c: booking a meeting block schedules it and it persists ─────────────

test('MF-3 — scheduling a meeting block creates it with meeting data', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Navigate to Calendar week view.
  await gotoView(window, 'goCalendar')
  // The calendar-mode-* buttons are gone; the mode is persisted under
  // localStorage 'calendar.mode' (and defaults to week). Set it and reload
  // rather than clicking a control that no longer exists.
  await window.evaluate(() => localStorage.setItem('calendar.mode', 'week'))
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goCalendar: () => void } } }
    w.__fbView?.getState().goCalendar()
  })
  await expect(window.locator('[data-testid="week-time-grid"]')).toBeVisible({ timeout: 6000 })

  // Open the booking surface (the Book time dialog — see MF-2 for why it is
  // not the old inline composer).
  await window.locator('[data-testid="day-col-2"]').click({ position: { x: 20, y: 200 } })
  const dialog = window.locator('[data-testid="book-time-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 4000 })

  // Enable meeting mode, and invite someone so the meeting carries real data.
  await dialog.getByRole('tab', { name: 'Meeting' }).click()
  const guests = dialog.locator('[data-testid="guest-input"]')
  await expect(guests).toBeVisible({ timeout: 2000 })
  await guests.fill('alice@example.com')
  await guests.press('Enter')
  await expect(dialog.locator('[data-testid="guest-chip"]')).toHaveCount(1)

  // The primary button text should read "Schedule meeting".
  const createBtn = dialog.locator('[data-testid="book-commit"]')
  await expect(createBtn).toContainText(/schedule meeting/i)

  // Create the block.
  await createBtn.click()
  await expect(dialog).toHaveCount(0, { timeout: 4000 })

  // A block renders on the grid.
  await expect(window.locator('[data-testid="time-block"]')).toHaveCount(1, { timeout: 4000 })

  // It was stored WITH its meeting data: a room to join and the invitee.
  const stored = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const now = Date.now()
    const blocks = await api.timeBlocks.list(now - 8 * 86_400_000, now + 8 * 86_400_000)
    return blocks.map((b) => ({ meeting: b.meeting }))
  })
  expect(stored).toHaveLength(1)
  expect(stored[0].meeting, 'the block carries a meeting').not.toBeNull()
  expect(stored[0].meeting?.roomId, 'a meeting is always minted a room to join').toBeTruthy()
  expect(stored[0].meeting?.invitees).toEqual(['alice@example.com'])

  // The block has a join-meeting button (because it has a meeting attached).
  // It is a hover action like the block's other controls, so hover first.
  const block = window.locator('[data-testid="time-block"]')
  await block.hover()
  await expect(block.locator('[data-testid="block-join-meeting"]')).toBeVisible({ timeout: 2000 })
  // Persistence of the meeting field across a reload is covered by MF-1's IPC
  // round-trip, so this test stops at the rendered block to avoid a flaky
  // reload + re-ready dance in the harness.
})

// ─── Goal 4: chat composer meet button navigates to meetings ──────────────────

// Skipped in the headless harness: the chat composer only mounts for a
// signed-in user with an active conversation, which a fresh test database has
// no way to provide. The composer-meet button and its launchMeeting wiring are
// verified by static inspection (ChatComposer.tsx). This test is kept for when
// the harness can seed an authenticated session with a conversation.
test.skip('MF-4 — chat composer meet button exists and navigates to meetings', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Navigate to the chat surface.
  await openProduct(window, 'chat')

  // The composer meet button should be in the DOM.
  const meetBtn = window.locator('[data-testid="composer-meet"]')
  await expect(meetBtn).toBeVisible({ timeout: 6000 })

  // Clicking it calls launchMeeting → goMeetings. The view store drives view
  // transitions; verify via the view store rather than a fragile UI assertion.
  // We evaluate before click to confirm no throw.
  let threw = false
  try {
    await meetBtn.click()
    // Give the navigation a moment to settle.
    await window.waitForTimeout(800)
  } catch (e) {
    threw = true
    console.error('meet button click threw:', e)
  }
  expect(threw).toBe(false)

  // Confirm we're now in the meetings view by checking the view state directly.
  const view = await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { current: string } } }
    return w.__fbView?.getState().current ?? 'unknown'
  })
  // The view should be 'meet' or 'meetings' after launchMeeting → goMeetings.
  expect(view).toMatch(/meet/i)
})

// ─── Goal 3: Insert → Meeting in all five editors (checked by static analysis
// confirmed above; a smoke E2E for Doc) ────────────────────────────────────────

test('MF-5 — DocMenuBar Insert→Meeting item exists and navigates without throw', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Create a doc and open it.
  const docId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const doc = await api.documents.create({ docType: 'doc', title: 'Test doc' })
    return doc.id
  })

  // Navigate to the doc via view store.
  await window.evaluate((id: string) => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
    w.__fbView?.getState().goDocument(id)
  }, docId)

  // Wait for the doc menu bar to appear.
  await expect(window.locator('text=Insert').first()).toBeVisible({ timeout: 6000 })

  // Open Insert menu.
  await window.locator('text=Insert').first().click()

  // "Meeting" item should be in the dropdown.
  await expect(window.locator('text=Meeting').first()).toBeVisible({ timeout: 2000 })

  // Click it — should call launchMeeting → goMeetings without throwing.
  let threw = false
  try {
    await window.locator('text=Meeting').first().click()
    await window.waitForTimeout(800)
  } catch (e) {
    threw = true
    console.error('Insert→Meeting click threw:', e)
  }
  expect(threw).toBe(false)

  // New contract: launching from an artifact opens the start-meeting dialog
  // first (to collect attendees + access), and does NOT jump to the meetings
  // view until the user clicks Start.
  await expect(window.locator('[data-testid="meeting-launch-dialog"]')).toBeVisible({ timeout: 4000 })
  const view = await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { view?: { kind: string } } } }
    return w.__fbView?.getState().view?.kind ?? 'unknown'
  })
  expect(view).not.toMatch(/^meet/i)
})
