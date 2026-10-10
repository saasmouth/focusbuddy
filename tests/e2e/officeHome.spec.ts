/**
 * E2E for the enriched PlexiOffice Home page — the app cards (now including
 * Meet), the Recent table with type filter tabs, and the right rail (Your day,
 * Quick actions, Unread). Everything on this page reads a real source and shows
 * an honest empty/zero state when there is nothing real to show; this test
 * exercises both the populated and the empty paths.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function openOffice(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
}

// Create a real document straight through the IPC API, the same path the office
// create flow uses. Returns the created document's id.
async function createDoc(window: Page, docType: string, title: string): Promise<string> {
  return window.evaluate(
    async ({ docType, title }) => {
      // @ts-expect-error window.api is exposed by the preload bridge.
      const doc = await window.api.documents.create({ docType, title })
      return doc.id as string
    },
    { docType, title }
  )
}

test.describe('PlexiOffice Home', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
  })
  test.afterAll(async () => {
    await app.dispose()
  })

  test('OH-1 the document app cards render, Meet among them', async () => {
    await openOffice(window)
    for (const a of ['docs', 'sheets', 'slides', 'draw', 'design']) {
      await expect(window.locator(`[data-testid="office-app-${a}"]`)).toBeVisible()
    }
    // Meet went free on 2026-08-17 (de386f8a — the second-person
    // collaboration surface is free for adoption), so it shows on the
    // free-tier test profile alongside the document apps. It still gates: the
    // card renders off the `meetings` view capability, not unconditionally.
    await expect(window.locator('[data-testid="office-app-meet"]')).toBeVisible()
  })

  test('OH-2 the Recent table renders a real doc and the Sheets tab filters', async () => {
    const docId = await createDoc(window, 'doc', 'Home recent doc')
    const sheetId = await createDoc(window, 'sheet', 'Home recent sheet')

    // Re-enter the office so the home refresh picks up the new documents.
    const exit = window.locator('[data-testid="office-exit"]')
    if (await exit.isVisible().catch(() => false)) await exit.click()
    await openOffice(window)
    await window.locator('[data-testid="office-nav-home"]').click()

    // The All tab shows the real table with both documents present.
    await expect(window.locator('[data-testid="office-home-recent-table"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator(`[data-testid="office-recent-row-${docId}"]`)).toBeVisible()
    await expect(window.locator(`[data-testid="office-recent-row-${sheetId}"]`)).toBeVisible()

    // Switch to Sheets: the sheet stays, the doc is filtered out.
    await window.locator('[data-testid="office-recent-tab-sheet"]').click()
    await expect(window.locator(`[data-testid="office-recent-row-${sheetId}"]`)).toBeVisible()
    await expect(window.locator(`[data-testid="office-recent-row-${docId}"]`)).toHaveCount(0)

    // The Mail tab has no document records, so it shows the honest empty state.
    await window.locator('[data-testid="office-recent-tab-mail"]').click()
    await expect(window.locator('[data-testid="office-recent-empty"]')).toBeVisible()

    // Back to All for the rest of the assertions.
    await window.locator('[data-testid="office-recent-tab-all"]').click()
  })

  test('OH-3 Your day shows its honest empty state on a fresh workspace', async () => {
    await expect(window.locator('[data-testid="office-home-day"]')).toBeVisible()
    await expect(window.locator('[data-testid="office-home-day-empty"]')).toBeVisible({ timeout: 8_000 })
  })

  test('OH-4 Quick actions render and New document opens a doc', async () => {
    await expect(window.locator('[data-testid="office-home-quickactions"]')).toBeVisible()
    // The always-available document quick actions (Compose / Meet gate on Pro).
    for (const id of ['doc', 'sheet', 'slides']) {
      await expect(window.locator(`[data-testid="office-qa-${id}"]`)).toBeVisible()
    }
    await window.locator('[data-testid="office-qa-doc"]').click()
    // The new document opens inline; the back control returns to the office.
    await expect(window.locator('button[title="Back to PlexiOffice"]')).toBeVisible({ timeout: 8_000 })
    await window.locator('button[title="Back to PlexiOffice"]').click()
    await window.locator('[data-testid="office-nav-home"]').click()
    await expect(window.locator('[data-testid="office-app-docs"]')).toBeVisible({ timeout: 8_000 })
  })

  test('OH-5 the Unread card shows real counts or an honest caught-up state', async () => {
    await expect(window.locator('[data-testid="office-home-unread"]')).toBeVisible()
    // A fresh workspace with no connected mailbox / chat is genuinely caught up.
    await expect(window.locator('[data-testid="office-home-unread-empty"]')).toBeVisible({ timeout: 8_000 })
  })
})
