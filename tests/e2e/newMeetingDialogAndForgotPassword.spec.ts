// E2E verification for two Plexi3.0 changes:
//
// 1. PlexiMeet's NewMeetingDialog — meet-start-live now opens a dialog to
//    start-or-schedule a meeting and invite anyone by email, instead of
//    immediately opening a live room.
// 2. LaunchSignInModal's "Forgot password?" link — visible in login mode
//    only, opens the brochure's /account/forgot page with the typed email
//    via window.api.files.openExternal.
//
// files:openExternal is stubbed at the ipcMain level (same pattern as
// addToCalendarAndProposals.spec.ts) so the test stays hermetic and never
// pops a real OS browser.

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

/** Stub files:openExternal so clicking "Forgot password?" doesn't pop a real
 * browser; records the URL it was called with. */
async function stubOpenExternal(app: LaunchedApp['app']): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('files:openExternal')
    ipcMain.handle('files:openExternal', async (_e, url: string) => {
      ;(globalThis as unknown as { __lastOpenExternal?: string }).__lastOpenExternal = url
      return { ok: true }
    })
  })
}

// ── NM-1: meet-start-live opens the New meeting dialog, not a live room ───────

test('NM-1 — meet-start-live opens new-meeting-dialog with mode toggle', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMeet(window)

  await expect(window.locator('[data-testid="meet-start-live"]')).toContainText('Start or schedule a meeting')

  await window.locator('[data-testid="meet-start-live"]').click()

  const dialog = window.locator('[data-testid="new-meeting-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 4_000 })

  // Must NOT have gone straight to a live meeting overlay.
  await expect(window.locator('[data-testid="meeting-window"]')).toHaveCount(0)

  // Mode toggle present, "now" is default.
  await expect(dialog.locator('[data-testid="new-meeting-mode"]')).toBeVisible()
  await expect(dialog.locator('[data-testid="new-meeting-mode-now"]')).toBeVisible()
  await expect(dialog.locator('[data-testid="new-meeting-mode-schedule"]')).toBeVisible()
  await expect(dialog.locator('[data-testid="new-meeting-start"]')).toBeVisible()

  // Toggle to schedule mode — the date / start chips appear (DEC-117: the
  // composer's chips open native pickers; the inputs behind them are sr-only).
  await dialog.locator('[data-testid="new-meeting-mode-schedule"]').click()
  await expect(dialog.locator('[data-testid="new-meeting-when"]')).toBeVisible()
  await expect(dialog.locator('[data-testid="new-meeting-date"]')).toBeVisible()
  await expect(dialog.locator('[data-testid="new-meeting-time"]')).toBeVisible()
  await expect(dialog.locator('[data-testid="new-meeting-date-input"]')).toHaveCount(1)
  await expect(dialog.locator('[data-testid="new-meeting-schedule"]')).toBeVisible()
})

// ── NM-2: schedule path creates a real TimeBlock with meeting.roomId + invitees ─

test('NM-2 — schedule mode creates a real TimeBlock meeting with roomId and invitees', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMeet(window)

  await window.locator('[data-testid="meet-start-live"]').click()
  const dialog = window.locator('[data-testid="new-meeting-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 4_000 })

  await dialog.locator('[data-testid="new-meeting-mode-schedule"]').click()
  await dialog.locator('[data-testid="new-meeting-title"]').fill('Roadmap sync')
  // DEC-117: guests are chips on the composer's field; a typed, uncommitted
  // address still counts at commit (finalGuests), so fill-then-schedule holds.
  await dialog.locator('[data-testid="new-meeting-invitees"]').fill('guest@example.com')

  await dialog.locator('[data-testid="new-meeting-schedule"]').click()

  // Honest note about the mailbox (no account connected in this headless env).
  await expect(dialog.locator('[data-testid="new-meeting-note"]')).toBeVisible({ timeout: 4_000 })
  const noteText = await dialog.locator('[data-testid="new-meeting-note"]').textContent()
  expect(noteText, 'note is honest about scheduling + mailbox state').toMatch(/scheduled|mailbox|connect/i)

  // Dialog auto-closes ~1.4s after scheduling.
  await expect(dialog).toHaveCount(0, { timeout: 4_000 })

  // Confirm the real side effect: a TimeBlock exists with meeting.roomId and
  // meeting.invitees including guest@example.com, via window.api.timeBlocks.list.
  const blocks = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const now = Date.now()
    // Wide range: from a week ago to a year out, so the scheduled time (next
    // half hour, could be tomorrow near midnight) is always inside it.
    return await api.timeBlocks.list(now - 7 * 24 * 60 * 60 * 1000, now + 365 * 24 * 60 * 60 * 1000)
  })

  type Block = { title: string; meeting?: { roomId?: string; invitees?: string[] } | null }
  const found = (blocks as Block[]).find((b) => b.title === 'Roadmap sync')
  expect(found, 'Roadmap sync TimeBlock found via timeBlocks.list').toBeTruthy()
  expect(found!.meeting?.roomId, 'meeting.roomId set').toBeTruthy()
  expect(found!.meeting?.invitees, 'meeting.invitees includes guest@example.com').toContain('guest@example.com')
})

// ── NM-3: start-now path does not crash; honest error surfaces (no mic/cam) ───

test('NM-3 — new-meeting-start (now mode) does not crash the app; no uncaught console errors', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openMeet(window)

  const pageErrors: string[] = []
  window.on('pageerror', (e) => pageErrors.push(String(e)))

  await window.locator('[data-testid="meet-start-live"]').click()
  const dialog = window.locator('[data-testid="new-meeting-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 4_000 })

  // "now" is the default mode. (DEC-117: the dialog is the Calendar
  // composer's twin — the active tab is the slider thumb + accent text, not
  // a rose fill; aria-selected is the truth.)
  await expect(dialog.locator('[data-testid="new-meeting-mode-now"]')).toHaveAttribute('aria-selected', 'true')

  await dialog.locator('[data-testid="new-meeting-start"]').click()

  // Give the getUserMedia rejection time to resolve. Two acceptable outcomes:
  // (a) the dialog shows new-meeting-error (mic/camera check), or
  // (b) a headless dummy device grants media and the dialog closes (room opened).
  const gotError = await dialog
    .locator('[data-testid="new-meeting-error"]')
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  const dialogClosed = await dialog
    .waitFor({ state: 'hidden', timeout: 500 })
    .then(() => true)
    .catch(() => false)

  expect(gotError || dialogClosed, 'either an honest error appeared or the dialog closed (room opened)').toBe(true)

  if (gotError) {
    const text = await dialog.locator('[data-testid="new-meeting-error"]').textContent()
    expect(text, 'error mentions mic/camera/permissions, not a crash dump').toMatch(/microphone|camera|permission/i)
  }

  // App shell still alive — no crash.
  await expect(window.locator('[data-testid="pleximeet-view"]')).toBeVisible()
  expect(pageErrors, `no uncaught page errors: ${pageErrors.join(' | ')}`).toHaveLength(0)
})

// ── NM-4: Forgot password link — login mode only, calls files:openExternal ────

test('NM-4 — signin-forgot visible in login mode only; opens /account/forgot with typed email', async () => {
  launched = await launchApp()
  const { app, window } = launched
  await stubOpenExternal(app)

  // Do NOT dismiss the sign-in modal itself, but a fresh test DB triggers
  // first-run onboarding first (LaunchSignInModal defers to it), so clear
  // that the same way waitForReady does before checking for sign-in.
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  if (await onb.isVisible().catch(() => false)) {
    await window.getByRole('button', { name: 'Get started' }).click().catch(() => {})
    await window.locator('[data-testid="onboarding-key-skip"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-tour-continue"]').click().catch(() => {})
    await window.locator('[data-testid="onboarding-start-blank"]').click().catch(() => {})
  }

  const dialog = window.locator('[role="dialog"][aria-label="Sign in to PlexiiDesk"]')
  await expect(dialog).toBeVisible({ timeout: 8_000 })

  // Ensure login mode is selected (fresh DB defaults to signup since there's no
  // cached email — switch explicitly).
  await dialog.getByRole('button', { name: 'Log in' }).click()

  // signin-forgot must be visible in login mode.
  const forgotBtn = dialog.locator('[data-testid="signin-forgot"]')
  await expect(forgotBtn).toBeVisible()

  // Type an email, then click.
  await dialog.locator('input[type="email"]').fill('operator@example.com')
  await forgotBtn.click()

  await window.waitForTimeout(300)
  const captured = await window.evaluate(
    () => (globalThis as unknown as { __lastOpenExternal?: string }).__lastOpenExternal
  )
  // Read back from the main process global, since the stub sets it there, not
  // in the renderer's globalThis. Re-fetch via app.evaluate.
  const capturedMain = await app.evaluate(
    () => (globalThis as unknown as { __lastOpenExternal?: string }).__lastOpenExternal
  )
  const url = capturedMain ?? captured
  expect(url, 'files:openExternal was called').toBeTruthy()
  expect(url).toContain('/account/forgot')
  expect(url).toContain(encodeURIComponent('operator@example.com'))

  // Switch to signup mode — the link must disappear.
  await dialog.getByRole('button', { name: 'Sign up' }).click()
  await expect(dialog.locator('[data-testid="signin-forgot"]')).toHaveCount(0)
})
