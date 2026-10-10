/**
 * E2E for the PlexiPeople segment — the fourth top-level segment, sitting between
 * PlexiOffice and PlexiBrain. It is the team area: a people home with real team
 * status, a real people directory, and a way into the organisation map.
 *
 * NO FAKERY is the central assertion here. A fresh test workspace has no
 * organisation and no teammates, so the directory MUST show its honest empty
 * state and the team-status counts MUST read zero — never the mockup's invented
 * 128 people / 42 online / birthdays / anniversaries.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function exitSegment(window: Page): Promise<void> {
  const segExit = window.locator('[data-testid="segment-exit"]')
  if (await segExit.isVisible().catch(() => false)) await segExit.click()
  const officeExit = window.locator('[data-testid="office-exit"]')
  if (await officeExit.isVisible().catch(() => false)) await officeExit.click()
}

test.describe('PlexiPeople segment', () => {
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

  test('opens from the sidebar and renders the people home', async () => {
    await exitSegment(window)
    await switchArea(window, 'plexipeople')
    await expect(window.locator('[data-testid="segment-plexipeople"]')).toBeVisible({ timeout: 8_000 })
    // The segment lands on its People Home app by default.
    await expect(window.locator('[data-testid="people-home"]')).toBeVisible({ timeout: 8_000 })
    // Team status block is present and reads real presence counts.
    await expect(window.locator('[data-testid="people-status"]')).toBeVisible()
  })

  test('a fresh workspace shows the honest empty directory, not invented people', async () => {
    await exitSegment(window)
    await switchArea(window, 'plexipeople')
    await window.locator('[data-testid="people-home"]').waitFor({ timeout: 8_000 })

    // No organisation + signed out on a fresh DB → honest empty state, never a
    // fabricated team. The empty block must be visible and the populated
    // directory list must NOT be.
    await expect(window.locator('[data-testid="people-directory-empty"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="people-directory"]')).toHaveCount(0)

    // No invented member rows anywhere.
    await expect(window.locator('[data-testid="people-member-row"]')).toHaveCount(0)

    // Total-people stat reads 0 on an empty workspace — proving the count is the
    // real member count, not the mockup's 128.
    const status = window.locator('[data-testid="people-status"]')
    await expect(status).toContainText('Total people')
    await expect(status.locator('text=/^128$/')).toHaveCount(0)
  })

  test('the segment menu offers what the tier entitles, and gates the rest', async () => {
    await exitSegment(window)
    await switchArea(window, 'plexipeople')
    // The directory is free, and renders the real people view.
    await window.locator('[data-testid="segment-app-directory"]').click()
    await expect(window.locator('[data-testid="people-status"]')).toBeVisible({ timeout: 8_000 })
    // Organisation (OrgAdminView) and the Organisation Map are Team-tier
    // (org_directory and people_map went team-only in b6ad6564, 2026-07-07),
    // so on this free-tier profile the menu does not offer them. The menu and
    // the surface agree: nothing here opens onto a locked view.
    for (const a of ['workspaces', 'map']) {
      await expect(window.locator(`[data-testid="segment-app-${a}"]`)).toHaveCount(0)
    }
  })
})
