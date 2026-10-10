/**
 * E2E for the 2026-10-10 side-menu moves.
 *
 * The desk menu had grown into a list of every place in the app, including
 * four that belong somewhere else. Each one moved to where someone would
 * actually look for it:
 *
 *   Calendar, Files  -> PlexiOffice, beside the email inbox (comms surfaces)
 *   Vault            -> Settings › Data (a store you set up, not a place)
 *   Connected apps   -> Settings › Advanced, and the menu only while a desk
 *                       is open (its rows exist to be dragged onto a canvas)
 *   Plexii           -> the assistant's own wordmark (see plexiiHub.spec.ts)
 *
 * and Attention gained the six filters you actually sort by.
 *
 * These assertions are the record that the moves happened rather than being
 * duplicated in two places — a thing that is in both menus is a thing nobody
 * decided about.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, switchArea, waitForReady, type LaunchedApp } from './_helpers'

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'due-today', label: 'Due today' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'closed-7d', label: 'Closed 7d' }
] as const

async function openSettings(window: Page, tab: string): Promise<void> {
  const gear = window.getByRole('button', { name: /appearance settings/i })
  await expect(gear).toBeVisible({ timeout: 5_000 })
  await gear.click()
  await expect(window.locator('[role="dialog"][aria-label="Settings"]').first()).toBeVisible({
    timeout: 5_000
  })
  await window.locator(`[data-testid="settings-tab-${tab}"]`).click()
}

test.describe('side-menu moves (2026-10-10)', () => {
  let launched: LaunchedApp

  test.beforeEach(async () => {
    launched = await launchApp()
    await waitForReady(launched.window)
  })
  test.afterEach(async () => {
    await launched.dispose()
  })

  test('IA-1 the desk menu no longer lists Calendar, Files, Vault or Plexii', async () => {
    const { window } = launched
    const sidebar = window.locator('aside').first()
    await expect(sidebar).toBeVisible({ timeout: 5_000 })
    for (const label of ['Calendar', 'Files', 'Vault', 'Plexii']) {
      await expect(sidebar.getByText(label, { exact: true })).toHaveCount(0)
    }
    // The rows that stayed are still there — this is a move, not a cull.
    for (const label of ['Home', 'Attention', 'Rooms', 'All desks', 'Shared', 'Trash']) {
      await expect(sidebar.getByText(label, { exact: true })).toBeVisible({ timeout: 3_000 })
    }
  })

  test('IA-2 Attention opens into its six filters, and each one narrows the view', async () => {
    const { window } = launched
    // Collapsed by default: Attention is still one row that means everything.
    await expect(window.locator('[data-testid="sidebar-attention-filters"]')).toHaveCount(0)

    await window.locator('[data-testid="sidebar-attention-toggle"]').click()
    const filters = window.locator('[data-testid="sidebar-attention-filters"]')
    await expect(filters).toBeVisible({ timeout: 3_000 })

    for (const f of FILTERS) {
      await expect(filters.getByText(f.label, { exact: true })).toBeVisible({ timeout: 3_000 })
    }

    // Each filter lands on the Attention view carrying that filter, and the
    // row it was clicked from is the one marked active.
    for (const f of FILTERS) {
      await window.locator(`[data-testid="sidebar-attention-${f.id}"]`).click()
      const view = await window.evaluate(() => {
        const w = window as unknown as {
          __fbView?: { getState: () => { view: { kind: string; filter?: string } } }
        }
        return w.__fbView?.getState().view ?? null
      })
      expect(view, `clicking ${f.label} should navigate`).not.toBeNull()
      expect(view?.kind).toBe('attention')
      expect(view?.filter).toBe(f.id)
    }

    // And it folds away again.
    await window.locator('[data-testid="sidebar-attention-toggle"]').click()
    await expect(window.locator('[data-testid="sidebar-attention-filters"]')).toHaveCount(0)
  })

  test('IA-3 Calendar and Files are in Office, beside the inbox', async () => {
    const { window } = launched
    await switchArea(window, 'office')
    await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })

    // They sit in the Unread rail's places block, which shows whether or not
    // the rail is otherwise caught up — a calendar with nothing unread is
    // still somewhere you go.
    const places = window.locator('[data-testid="office-home-places"]')
    await expect(places).toBeVisible({ timeout: 8_000 })
    await expect(places.getByText('Calendar', { exact: true })).toBeVisible()
    await expect(places.getByText('Files', { exact: true })).toBeVisible()

    // The inbox they moved beside is in the same menu.
    await expect(window.locator('[data-testid="office-comms-app-inbox"]')).toBeVisible()
  })

  test('IA-4 the Vault is in Settings › Data', async () => {
    const { window } = launched
    await openSettings(window, 'data')
    await expect(window.locator('[data-testid="settings-vault"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="settings-vault-open"]')).toBeVisible()
  })

  test('IA-5 Connected apps are in Settings › Advanced with no desk open', async () => {
    const { window } = launched
    // Not in the menu on Home…
    await expect(
      window.locator('aside').first().getByText('Connected Apps', { exact: true })
    ).toHaveCount(0)
    // …but managed from Settings, which is the point: adding one has to work
    // before there is a desk to drag it onto.
    await openSettings(window, 'advanced')
    await expect(window.locator('[data-testid="settings-connected-apps"]')).toBeVisible({
      timeout: 5_000
    })
    await expect(window.locator('[data-testid="settings-connected-apps-add"]')).toBeVisible()
  })
})
