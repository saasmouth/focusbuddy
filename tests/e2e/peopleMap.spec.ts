/**
 * E2E test for the People Map view (PlexiDesk desktop).
 *
 * Boot scope: hermetic test DB (no signed-in session, no org, no people).
 * Goals:
 *   1. The map is reachable from People Home in the PlexiiPeople area.
 *   2. After navigation data-testid="people-map" is visible.
 *   3. All three tab buttons are present (offices / global / hierarchy).
 *   4. With no session the view shows the honest "Sign in" empty state and
 *      renders NO fabricated people cards, office cards, or pins.
 *   5. Clicking each tab button does not throw a JS error.
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, switchArea } from './_helpers'

test('People Map: mounts with honest empty state and no fake data in unauthenticated session', async () => {
  const { window, dispose } = await launchApp()
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  try {
    await waitForReady(window)

    // PEOPLE MAP IS TEAM-ONLY NOW. 3a40a6ba ("comprehensive entitlement
    // enforcement across all feature surfaces") put the view behind
    // people_map, which capabilityDefaults has as { free: false, pro: false,
    // team: true } — so on the free tier this spec was testing a view the
    // product correctly refuses to show, and the entry point is hidden by
    // design (PeopleHomeView only renders it when viewEnabled('people-map')).
    //
    // The entitlement is seeded rather than the gate worked around, because
    // what this spec is actually for is further in: that the map mounts with
    // an HONEST EMPTY STATE and invents no people when there is no session.
    // That is worth keeping, and it only happens on a tier that can open it.
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbCapabilities?: { setState: (s: object) => void; getState: () => { capabilities: Record<string, unknown> } }
      }
      const current = w.__fbCapabilities?.getState().capabilities ?? {}
      w.__fbCapabilities?.setState({ capabilities: { ...current, people_map: true, org_directory: true } })
    })

    // --- Navigate to People Map the way a person now does ---
    // There is no "People Map" row in the sidebar any more. The map lives in
    // the PlexiiPeople area: People Home carries the entry point, labelled
    // "Organisation map" (data-testid people-open-map). Driven through the
    // area switcher rather than calling goPeopleMap() on the store, so this
    // still proves the view is REACHABLE and not merely mountable — which is
    // what the spec's own header says it is for.
    await switchArea(window, 'plexipeople')
    await expect(window.locator('[data-testid="people-home"]')).toBeVisible({ timeout: 8_000 })
    const openMap = window.locator('[data-testid="people-open-map"]')
    await expect(openMap).toBeVisible({ timeout: 8_000 })
    await openMap.click()

    // --- View root must be visible ---
    const root = window.locator('[data-testid="people-map"]')
    await expect(root).toBeVisible({ timeout: 8_000 })

    // --- All three tab buttons must be present ---
    await expect(window.locator('[data-testid="people-map-tab-offices"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="people-map-tab-global"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="people-map-tab-hierarchy"]')).toBeVisible({ timeout: 5_000 })

    // --- No session → honest "Sign in" empty state, NO fake people ---
    // The view short-circuits to the sign-in empty state when token is absent.
    await expect(window.getByText('Sign in to see your team')).toBeVisible({ timeout: 5_000 })

    // Confirm zero fabricated person rows (.pm-prow) and zero office cards (.pm-office).
    const personRows = window.locator('.pm-prow')
    await expect(personRows).toHaveCount(0, { timeout: 3_000 })
    const officeCards = window.locator('.pm-office')
    await expect(officeCards).toHaveCount(0, { timeout: 3_000 })
    // No map pins either.
    const pins = window.locator('.pm-pin')
    await expect(pins).toHaveCount(0, { timeout: 3_000 })

    // --- Clicking each tab must not throw ---
    // The empty state is rendered before the tab body, so the body content
    // changes only when there is actual data. Without data the empty state
    // persists across tab clicks, but clicking tabs must be error-free.
    await window.locator('[data-testid="people-map-tab-global"]').click()
    await window.locator('[data-testid="people-map-tab-hierarchy"]').click()
    await window.locator('[data-testid="people-map-tab-collaboration"]').click()
    await window.locator('[data-testid="people-map-tab-offices"]').click()

    // Allow a brief moment for any async reactions to settle.
    await window.waitForTimeout(400)

    // Still no fake data after tab cycling.
    await expect(window.locator('.pm-prow')).toHaveCount(0, { timeout: 3_000 })
    await expect(window.locator('.pm-office')).toHaveCount(0, { timeout: 3_000 })
    await expect(window.locator('.pm-pin')).toHaveCount(0, { timeout: 3_000 })

    // No JS errors during the whole interaction.
    expect(errors, `JS errors: ${errors.join('; ')}`).toHaveLength(0)
  } finally {
    await dispose()
  }
})
