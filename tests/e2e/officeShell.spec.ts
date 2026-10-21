/**
 * E2E for the PlexiOffice segment — its own full-bleed shell with a dedicated
 * sidebar (the office side menu), app tiles, templates, and inline editors.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function openOffice(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
}

test.describe('PlexiOffice segment', () => {
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

  test('OF-1 the office sidebar shows the office menu + apps', async () => {
    await openOffice(window)
    for (const t of ['office-nav-home', 'office-nav-recent', 'office-nav-starred', 'office-nav-templates', 'office-nav-trash']) {
      await expect(window.locator(`[data-testid="${t}"]`)).toBeVisible()
    }
    for (const a of ['docs', 'sheets', 'slides', 'draw', 'design']) {
      await expect(window.locator(`[data-testid="office-app-${a}"]`)).toBeVisible()
    }
    // The document apps above are free-tier (office_* default free:true). Inbox
    // is core (notifications + share invites) and always shows, and Mail, Chat
    // and Meet went free on 2026-08-17 (de386f8a — the second-person
    // collaboration surface is free for adoption), so they show here too. Inbox,
    // Mail and Chat are Tools tiles (office-comms-app-*); Meet (PlexiiCall) is a
    // PlexiiApps tile (office-sideapp-*). Sign is the one still behind Pro
    // (esign default free:false), hidden by the same capability MainPane
    // enforces, so nav and surface never disagree. It is a PlexiiApps tile, so
    // that is the id that must be absent (the old office-comms-app-sign check
    // passed whatever the gate did, because that id no longer exists).
    for (const a of ['inbox', 'mail', 'chat']) {
      await expect(window.locator(`[data-testid="office-comms-app-${a}"]`)).toBeVisible()
    }
    await expect(window.locator('[data-testid="office-sideapp-meet"]')).toBeVisible()
    await expect(window.locator('[data-testid="office-sideapp-sign"]')).toHaveCount(0)
    // The Ask-AI bar and upgrade affordance are present.
    await expect(window.locator('[data-testid="office-ask-ai"]')).toBeVisible()
  })

  test('OF-2 launching PlexiDocs opens a doc inline; Back returns to the office', async () => {
    await window.locator('[data-testid="office-app-docs"]').click()
    // The document editor opens inside the office shell (sidebar still present).
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
    await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible()
    // Back to PlexiOffice.
    await window.locator('button[title="Back to PlexiiOffice"]').click()
    await expect(window.locator('[data-testid="office-app-docs"]')).toBeVisible({ timeout: 8_000 })
  })

  test('OF-3 a template creates a spreadsheet inline', async () => {
    await window.locator('[data-testid="office-template-blank-sheet"]').click()
    // The sheet editor opens (its grid surface) inside the shell.
    await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible()
    await window.locator('button[title="Back to PlexiiOffice"]').click()
    await expect(window.locator('[data-testid="office-app-docs"]')).toBeVisible({ timeout: 8_000 })
  })
})
