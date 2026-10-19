/**
 * settingsConsolidation.spec.ts — E2E coverage for consolidating Organisation
 * and Templates under Settings and removing them as standalone sidebar items.
 *
 * The change:
 *   - Adds a settings section "Organisation" (data-testid settings-section-
 *     organisation) with a "Manage organisation" button (settings-org-manage)
 *     that opens the full OrgAdminView and closes the popover. Org data comes
 *     from the real listOrgs API; with no session it shows the honest empty
 *     state, but the section and manage button still render.
 *   - Adds a settings section "Templates" (settings-section-templates) that
 *     lists the real STARTER_TEMPLATES with per-template testids
 *     (settings-template-<id>) and applies one via the shared
 *     applyTemplateToActiveTask helper.
 *   - Removes the standalone "Organization" NavRow and the "Templates"
 *     collapsible section from the sidebar.
 *
 * No live signal server / signed-in session is needed for these DOM assertions.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openSettings(window: LaunchedApp['window']): Promise<void> {
  const settingsBtn = window.getByRole('button', { name: /appearance settings/i })
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
  await settingsBtn.click()
  const panel = window.locator('[role="dialog"][aria-label="Settings"]').first()
  await expect(panel).toBeVisible({ timeout: 5_000 })
}

// Settings is tabbed now; each section lives under its tab. Open the tab that
// hosts the section under test before asserting on it.
async function openSettingsTab(window: LaunchedApp['window'], tab: string): Promise<void> {
  await openSettings(window)
  await window.locator(`[data-testid="settings-tab-${tab}"]`).click()
}

test('Settings shows an Organisation section whose Manage button opens OrgAdminView', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)
  await openSettingsTab(window, 'organisation')

  const orgSection = window.locator('[data-testid="settings-section-organisation"]')
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-section-organisation"]')
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
  await expect(orgSection).toBeVisible({ timeout: 5_000 })

  // Signed-out shows the honest empty state; the Manage button still renders.
  const manageBtn = window.locator('[data-testid="settings-org-manage"]')
  await expect(manageBtn).toBeVisible({ timeout: 5_000 })

  // Clicking Manage navigates to the Organisation view and closes the popover.
  // On a paid/entitled account that view is OrgAdminView; on a free or signed-out
  // account the org directory is capability-gated, so the view renders the honest
  // upsell (CapabilityGate) instead. Either proves the Manage button routed to the
  // organisation surface — assert whichever the current entitlement produces.
  await manageBtn.click()
  const orgAdmin = window.locator('[data-testid="org-admin"]')
  const orgGate = window.locator('[data-testid="capability-gate"]')
  await expect(orgAdmin.or(orgGate).first()).toBeVisible({ timeout: 8_000 })

  expect(pageErrors).toHaveLength(0)
})

test('Settings shows a Templates section listing the real starter templates', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)
  await openSettingsTab(window, 'templates')

  const tplSection = window.locator('[data-testid="settings-section-templates"]')
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-section-templates"]')
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
  await expect(tplSection).toBeVisible({ timeout: 5_000 })

  // The built-in starters must render by their real ids (from starterTemplates.ts).
  await expect(
    window.locator('[data-testid="settings-template-starter-daily-focus"]')
  ).toBeVisible({ timeout: 5_000 })
  await expect(
    window.locator('[data-testid="settings-template-starter-brainstorm"]')
  ).toBeVisible({ timeout: 5_000 })

  expect(pageErrors).toHaveLength(0)
})

test('Sidebar no longer shows a standalone Organization row or Templates section', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)

  // The sidebar is the <aside> chrome. Scope the checks to it so unrelated
  // "Organization"/"Templates" text elsewhere cannot mask a regression.
  const sidebar = window.locator('aside').first()
  await expect(sidebar).toBeVisible({ timeout: 5_000 })

  // No sidebar control labelled "Organization" (the removed NavRow) and no
  // sidebar "Templates" section header remain.
  const sidebarText = await sidebar.evaluate((el) => el.textContent ?? '')
  expect(sidebarText).not.toContain('Organization')

  const orgRow = sidebar.locator('button', { hasText: 'Organization' })
  await expect(orgRow).toHaveCount(0)

  // The Templates section header button (SectionHeader label="Templates") is gone.
  const tplHeader = sidebar.getByRole('button', { name: /^Templates$/ })
  await expect(tplHeader).toHaveCount(0)

  // The Desk sidebar still renders its nav (proof we removed only the settings
  // blocks, not the whole sidebar). People Map now lives in the PlexiPeople area.
  const sidebarHasPlans = sidebarText.includes('Plans')
  expect(sidebarHasPlans).toBe(true)
})
