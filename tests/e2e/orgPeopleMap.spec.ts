/**
 * orgPeopleMap.spec.ts — E2E coverage for the org people-map UI additions in
 * OrgAdminView: company working-hours inputs, offices section, and per-member
 * profile editor.
 *
 * No real server / real account is needed for DOM-rendering assertions.
 * The view is opened by calling goOrg() on the view store (same call the
 * sidebar button makes) with a text-click fallback. Because there is no
 * signed-in session, the API calls fired by the component will fail silently
 * (no token), leaving the UI in its unauthenticated empty state — which is
 * enough to prove the new DOM structure exists and mounts without a crash.
 *
 * What is proven here (UI-driven + DOM assertions):
 *   - org-admin wrapper renders when view is set to 'organization'
 *   - org-hours section (data-testid org-hours) is present and visible
 *   - org-hours-start and org-hours-end inputs render inside it
 *   - org-offices section (data-testid org-offices) is present and visible
 *   - org-office-new input and org-office-add button render inside it
 *   - add-office button is disabled when input is empty, enabled when filled
 *   - no page-level JS errors on mount
 *
 * What is NOT proven here (requires a real signed-in org session):
 *   - API round-trips (covered by backend tests/peopleMapFlow.mjs)
 *   - org-profile-toggle (member list is empty without auth)
 *   - office-row-<id> appearing after add (add requires auth to persist)
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { signInWithFakeSignal } from './_fakeSignal'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

/**
 * OrgAdminView is TEAM-ONLY.
 *
 * 3a40a6ba ("comprehensive entitlement enforcement across all feature
 * surfaces") put the organization view behind org_directory, which
 * capabilityDefaults has as { free: false, pro: false, team: true }. These
 * specs run unauthenticated, so MainPane renders the gate instead of the view
 * and "Manage organisation" leads nowhere — the second of the two reasons they
 * went red, the first being the tabbed Settings shell below.
 *
 * Seeded rather than worked around: what these three are for is that the view
 * MOUNTS and renders its sections without throwing, which only happens on a
 * tier entitled to open it.
 */
const ORG_ID = 'org-e2e-1'

/**
 * A signed-in account that belongs to an organisation it administers.
 *
 * OrgAdminView's working-hours and offices sections live inside `detail`
 * (OrgAdminView:284), and detail comes from GET /orgs/:id with a session
 * token, with canAdmin requiring role owner|admin (OrgAdminView:169). With no
 * account and no org the view mounts and those two sections simply are not in
 * the tree — which is why "mounts without JS errors" passes while the other
 * two cannot.
 *
 * The routes are registered AFTER signInWithFakeSignal, because Playwright
 * tries the most recently added route first and that helper installs a
 * catch-all for the whole signal origin.
 */
async function signInWithOrg(window: LaunchedApp['window']): Promise<void> {
  await signInWithFakeSignal(window, { name: { firstName: 'Dana', lastName: 'Reed' } })

  const membership = {
    id: ORG_ID,
    name: 'E2E Org',
    slug: 'e2e-org',
    personal: false,
    role: 'owner',
    memberCount: 1,
    createdAt: Date.now()
  }
  await window.route('**/orgs', async (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, orgs: [membership] })
    })
  })
  await window.route(`**/orgs/${ORG_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        org: { id: ORG_ID, name: 'E2E Org', personal: false },
        role: 'owner',
        members: [{ accountId: 'acc_e2e', handle: 'e2e', firstName: 'Dana', lastName: 'Reed', role: 'owner' }],
        invites: []
      })
    })
  })
  // Everything else under the org (offices, hours, invite policy, audit, SSO,
  // SCIM) answers empty rather than erroring, so refreshAux completes and the
  // sections render their own empty states.
  await window.route(`**/orgs/${ORG_ID}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, offices: [], events: [], config: null, status: 'off', baseUrl: null, start: 9, end: 17, policy: 'admins' })
    })
  })
}

async function grantOrgEntitlement(window: LaunchedApp['window']): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as {
      __fbCapabilities?: { setState: (s: object) => void; getState: () => { capabilities: Record<string, unknown> } }
    }
    const current = w.__fbCapabilities?.getState().capabilities ?? {}
    w.__fbCapabilities?.setState({ capabilities: { ...current, org_directory: true } })
  })
}

async function openOrgView(window: LaunchedApp['window']): Promise<void> {
  await grantOrgEntitlement(window)
  // Organisation used to be a standalone sidebar row, then a section of the
  // one long-scroll Settings popover. f03087b07 made Settings a TABBED shell,
  // so OrganisationSection only mounts while its own tab is selected
  // (`{tab === 'organisation' && <OrganisationSection …>}`): scrolling to
  // "Manage organisation" and clicking it now waits on a node that is not in
  // the document, which is the whole of why these three went red.
  await window.getByRole('button', { name: /appearance settings/i }).click()
  const tab = window.locator('[data-testid="settings-tab-organisation"]')
  await expect(tab).toBeVisible({ timeout: 5_000 })
  await tab.click()
  await expect(window.locator('[data-testid="settings-pane-organisation"]')).toBeVisible({ timeout: 5_000 })
  const manage = window.locator('[data-testid="settings-org-manage"]')
  await manage.scrollIntoViewIfNeeded()
  await manage.click()
  // Waiting on the view, not on a timer: the popover closes and OrgAdminView
  // mounts in the same commit, so there is state to wait for.
  await expect(window.locator('[data-testid="org-admin"]')).toBeVisible({ timeout: 8_000 })
}

test('OrgAdminView: mounts without JS errors', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)
  await openOrgView(window)

  // Give React a tick to render after navigation.
  await window.waitForTimeout(500)

  // The org-admin wrapper must be in the DOM.
  await expect(window.locator('[data-testid="org-admin"]')).toBeVisible({ timeout: 8_000 })

  expect(pageErrors).toHaveLength(0)
})

test('OrgAdminView: company working-hours inputs render', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)
  // These two need an ORG, not just an account: their sections are inside
  // `detail`. See signInWithOrg.
  await signInWithOrg(window)
  await openOrgView(window)

  await expect(window.locator('[data-testid="org-admin"]')).toBeVisible({ timeout: 8_000 })

  // Scroll the hours section into view in case it is below the fold.
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="org-hours"]')
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })

  const hoursSection = window.locator('[data-testid="org-hours"]')
  await expect(hoursSection).toBeVisible({ timeout: 5_000 })

  const startInput = window.locator('[data-testid="org-hours-start"]')
  const endInput = window.locator('[data-testid="org-hours-end"]')

  await expect(startInput).toBeVisible({ timeout: 5_000 })
  await expect(endInput).toBeVisible({ timeout: 5_000 })

  // Values may be empty string if getOrgHours fails (no auth). What matters
  // is the inputs exist without a crash.
  const startVal = await startInput.inputValue()
  const endVal = await endInput.inputValue()
  expect(typeof startVal).toBe('string')
  expect(typeof endVal).toBe('string')

  expect(pageErrors).toHaveLength(0)
})

test('OrgAdminView: offices section with add-input and add-button render', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)
  // These two need an ORG, not just an account: their sections are inside
  // `detail`. See signInWithOrg.
  await signInWithOrg(window)
  await openOrgView(window)

  await expect(window.locator('[data-testid="org-admin"]')).toBeVisible({ timeout: 8_000 })

  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="org-offices"]')
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })

  const officesSection = window.locator('[data-testid="org-offices"]')
  await expect(officesSection).toBeVisible({ timeout: 5_000 })

  const newOfficeInput = window.locator('[data-testid="org-office-new"]')
  const addOfficeBtn = window.locator('[data-testid="org-office-add"]')

  await expect(newOfficeInput).toBeVisible({ timeout: 5_000 })
  await expect(addOfficeBtn).toBeVisible({ timeout: 5_000 })

  // The add button is disabled when the input is empty (as per component logic).
  await expect(addOfficeBtn).toBeDisabled()

  // Typing into the input enables the button.
  await newOfficeInput.fill('London HQ')
  await expect(addOfficeBtn).toBeEnabled({ timeout: 2_000 })

  expect(pageErrors).toHaveLength(0)
})
