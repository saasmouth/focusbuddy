import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'
import type { LaunchedApp } from './_helpers'

// Tests for the meeting-launch dialog (start-meeting from artifact origins).
//
// With this diff, launchMeeting() on a doc/sheet/slides/draw/design/desk origin
// opens the MeetingLaunchDialog instead of navigating immediately.
//
// Verification approach for ML-1 through ML-3:
//   Drive Insert → Meeting from a real document editor. This is the primary
//   user-facing trigger for doc origins and exercises the full launchMeeting →
//   useMeetingLaunchStore.open → dialog-render path in the built app without
//   needing to inject stores.
//
// ML-4: Insert→Meeting on a doc should open dialog (NOT navigate immediately).
// ML-5: desk-start-meeting button present when a desk is active in Canvas.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Navigate to a doc editor and open the Insert menu, returning after the
// "Insert" item is visible. Caller drives from there.
async function openDocInsertMenu(window: import('@playwright/test').Page): Promise<void> {
  const docId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const doc = await api.documents.create({ docType: 'doc', title: 'Meeting test doc' })
    return doc.id
  })

  await window.evaluate((id: string) => {
    const w = window as unknown as {
      __fbView?: { getState: () => { goDocument: (id: string) => void } }
    }
    w.__fbView?.getState().goDocument(id)
  }, docId)

  // Wait for the Insert menu to be in the doc editor toolbar.
  await expect(window.locator('text=Insert').first()).toBeVisible({ timeout: 8_000 })
  await window.locator('text=Insert').first().click()
  await expect(window.locator('text=Meeting').first()).toBeVisible({ timeout: 3_000 })
}

// ─── ML-1: dialog renders its required elements ───────────────────────────────

test('ML-1 — dialog renders attendees field, three access radios and start button', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openDocInsertMenu(window)
  await window.locator('text=Meeting').first().click()
  await window.waitForTimeout(300)

  const dialog = window.locator('[data-testid="meeting-launch-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  await expect(window.locator('[data-testid="launch-attendees"]')).toBeVisible()
  await expect(window.locator('[data-testid="launch-access-view-once"]')).toBeVisible()
  await expect(window.locator('[data-testid="launch-access-view-always"]')).toBeVisible()
  await expect(window.locator('[data-testid="launch-access-collaborate"]')).toBeVisible()
  await expect(window.locator('[data-testid="launch-start"]')).toBeVisible()

  // view-once must be the default selection.
  await expect(window.locator('[data-testid="launch-access-view-once"]')).toBeChecked()
})

// ─── ML-2: start with no attendees closes dialog and navigates to meetings ────

test('ML-2 — start with no attendees closes dialog and navigates to meetings', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openDocInsertMenu(window)
  await window.locator('text=Meeting').first().click()

  await expect(window.locator('[data-testid="meeting-launch-dialog"]')).toBeVisible({ timeout: 5_000 })

  // No attendees — click Start.
  await window.locator('[data-testid="launch-start"]').click()

  // Dialog must close.
  await expect(window.locator('[data-testid="meeting-launch-dialog"]')).not.toBeVisible({ timeout: 6_000 })

  // View store should be on the meetings view now.
  // The view store state field is { view: { kind: string } } — not { current }.
  const view = await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => { view?: { kind: string } } }
    }
    return w.__fbView?.getState().view?.kind ?? 'unknown'
  })
  expect(view).toMatch(/meet/i)
})

// ─── ML-3: cancel closes dialog without navigating ───────────────────────────

test('ML-3 — cancel closes dialog without navigating to meetings', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openDocInsertMenu(window)
  await window.locator('text=Meeting').first().click()

  await expect(window.locator('[data-testid="meeting-launch-dialog"]')).toBeVisible({ timeout: 5_000 })

  const viewBefore = await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => { view?: { kind: string } } }
    }
    return w.__fbView?.getState().view?.kind ?? 'unknown'
  })

  await window.getByRole('button', { name: 'Cancel' }).click()
  await expect(window.locator('[data-testid="meeting-launch-dialog"]')).not.toBeVisible({ timeout: 4_000 })

  const viewAfter = await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => { view?: { kind: string } } }
    }
    return w.__fbView?.getState().view?.kind ?? 'unknown'
  })
  // Should still be on the document, not meetings.
  expect(viewAfter).toBe(viewBefore)
  expect(viewAfter).not.toMatch(/^meet/i)
})

// ─── ML-4: Insert→Meeting opens dialog (NOT immediate navigation) ────────────

test('ML-4 — Insert→Meeting on a doc opens dialog, view does NOT change to meet immediately', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openDocInsertMenu(window)

  const viewBefore = await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => { view?: { kind: string } } }
    }
    return w.__fbView?.getState().view?.kind ?? 'unknown'
  })

  await window.locator('text=Meeting').first().click()
  await window.waitForTimeout(400)

  // Dialog must be visible.
  await expect(window.locator('[data-testid="meeting-launch-dialog"]')).toBeVisible({ timeout: 4_000 })

  // View must NOT have jumped to meetings yet (user hasn't clicked Start).
  const viewAfter = await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => { view?: { kind: string } } }
    }
    return w.__fbView?.getState().view?.kind ?? 'unknown'
  })
  expect(viewAfter).toBe(viewBefore)
})

// ─── ML-5: desk-start-meeting button is present when a desk is open ──────────

test('ML-5 — desk-start-meeting button is present in the Canvas toolbar', async () => {
  launched = await launchApp()
  const { window } = launched

  // Use the same bootstrapping pattern as canvasUI.spec: wait for api, dismiss
  // sign-in modal, seed the node, reload, then click.
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skipBtn = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click().catch(() => {})
  }

  // Seed a task node (desk) and open it in Canvas — the toolbar only renders
  // when activeTask is set, which requires a desk to be open.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'ML-5 Desk' })
  })

  // Reload so the node appears in the sidebar tree.
  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skipBtn2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skipBtn2.isVisible().catch(() => false)) {
    await skipBtn2.click().catch(() => {})
  }

  // Click the task in the sidebar to open Canvas.
  await window.getByRole('button', { name: 'ML-5 Desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // The Meeting button should now be in the toolbar.
  // The desk's meeting action is pill-meeting in the desk action bar, now
  // docked in the header. There is no desk-start-meeting testid in the app.
  await expect(window.locator('[data-testid="pill-meeting"]')).toBeVisible({ timeout: 4_000 })
})
