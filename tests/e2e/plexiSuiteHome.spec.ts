// E2E verification for the PlexiSuite home launcher + per-product pages + upvote.
// Tests drive the sidebar entry, the launcher grid, product tile navigation, and
// the local-first upvote toggle, then confirm vote persistence in localStorage.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openSuite(window: LaunchedApp['window']): Promise<void> {
  // Click the PlexiSuite sidebar entry (aria-label or visible label).
  const suiteBtn = window.locator('[data-testid="sidebar-btn-suite"], button[aria-label="PlexiiSuite"]').first()
  // Fallback: find by text "PlexiSuite" in the sidebar strip.
  const fallback = window.locator('button').filter({ hasText: 'PlexiiSuite' }).first()

  // Try the test-id first, then text fallback.
  const hasSuiteBtn = await suiteBtn.count()
  if (hasSuiteBtn) {
    await suiteBtn.click()
  } else {
    await fallback.click()
  }

  await window.waitForSelector('[data-testid="plexisuite-home"]', { timeout: 8_000 })
}

// ── Test 1: Sidebar "PlexiSuite" opens the launcher ────────────────────────────

test('1 — sidebar PlexiSuite entry opens [data-testid="plexisuite-home"]', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openSuite(window)
  const home = window.locator('[data-testid="plexisuite-home"]')
  await expect(home).toBeVisible()
})

// ── Test 2: Launcher renders hero and all group sections ────────────────────────

test('2 — launcher renders PlexiDesk hero and all product group headers', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSuite(window)

  // PlexiDesk hero
  await expect(window.locator('[data-testid="hero-plexidesk"]')).toBeVisible()

  // Each group should appear as text in the launcher.
  const expectedGroups = ['PlexiiOffice', 'PlexiiWork', 'PlexiiAI', 'PlexiiData', 'PlexiiBuild', 'PlexiiConnect', 'PlexiiOps']
  for (const group of expectedGroups) {
    await expect(window.locator(`[data-testid="plexisuite-home"]`).locator(`text=${group}`).first()).toBeVisible({
      timeout: 4_000
    })
  }
})

// ── Test 3: Ready vs coming-soon product rendering ──────────────────────────────

test('3 — ready products render full-colour; coming-soon products get badge + upvote', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSuite(window)

  // A ready product tile (PlexiDash, status=ready).
  const dashTile = window.locator('[data-testid="product-tile-plexidash"]')
  await expect(dashTile).toBeVisible()
  // Ready tiles must NOT contain the status badge text.
  await expect(dashTile.locator('text=Coming soon')).toHaveCount(0)
  await expect(dashTile.locator('text=Planned')).toHaveCount(0)
  // Ready tiles must NOT have an upvote button.
  await expect(dashTile.locator('[data-testid="upvote-plexidash"]')).toHaveCount(0)

  // PlexiForms is now 'ready' (forms shipped). Confirm it has no badge and no upvote.
  const formsTile = window.locator('[data-testid="product-tile-plexiforms"]')
  await expect(formsTile).toBeVisible()
  await expect(formsTile.locator('text=Coming soon')).toHaveCount(0)
  await expect(formsTile.locator('text=Planned')).toHaveCount(0)
  await expect(formsTile.locator('[data-testid="upvote-plexiforms"]')).toHaveCount(0)

  // The one remaining planned product is PlexiOps; it must show the Planned badge
  // and an upvote control. Projects, Flow, Forms, Reports, Sign, Meet and Brain
  // have all shipped and are now full-colour ready tiles.
  const opsTile = window.locator('[data-testid="product-tile-plexiops"]')
  await expect(opsTile).toBeVisible()
  await expect(opsTile.locator('text=Planned')).toBeVisible()
  await expect(opsTile.locator('[data-testid="upvote-plexiops"]')).toBeVisible()

  // These have all shipped, so like PlexiDash they are full-colour with no badge
  // and no upvote.
  for (const key of ['plexibrain', 'pleximeet', 'plexisign', 'plexiflow']) {
    const tile = window.locator(`[data-testid="product-tile-${key}"]`)
    await expect(tile).toBeVisible()
    await expect(tile.locator('text=Coming soon')).toHaveCount(0)
    await expect(tile.locator('text=Planned')).toHaveCount(0)
    await expect(tile.locator(`[data-testid="upvote-${key}"]`)).toHaveCount(0)
  }
})

// ── Test 4: Product tile navigation ────────────────────────────────────────────

test('4a — clicking a ready product tile opens its product home page with Open button', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSuite(window)

  // Click PlexiDash tile.
  await window.locator('[data-testid="product-tile-plexidash"]').click()
  await window.waitForSelector('[data-testid="product-home-plexidash"]', { timeout: 6_000 })
  await expect(window.locator('[data-testid="product-home-plexidash"]')).toBeVisible()
  // Ready product must have an Open button.
  await expect(window.locator('[data-testid="open-plexidash"]')).toBeVisible()
})

test('4b — clicking a coming-soon product tile opens product home with upvote + planned list', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSuite(window)

  // Click the PlexiOps tile (the remaining planned product).
  await window.locator('[data-testid="product-tile-plexiops"]').click()
  await window.waitForSelector('[data-testid="product-home-plexiops"]', { timeout: 6_000 })
  await expect(window.locator('[data-testid="product-home-plexiops"]')).toBeVisible()
  // Planned product must NOT have an Open button.
  await expect(window.locator('[data-testid="open-plexiops"]')).toHaveCount(0)
  // Must have an upvote control.
  await expect(window.locator('[data-testid="upvote-plexiops"]')).toBeVisible()
  // Must show the "What we are building" list.
  await expect(window.locator('text=What we are building')).toBeVisible()
})

// ── Test 5: Upvote behaviour (local-first, no fabricated counts) ────────────────

test('5 — upvote-plexiops toggles aria-pressed and count; persists in localStorage', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSuite(window)

  const btn = window.locator('[data-testid="upvote-plexiops"]').first()
  await expect(btn).toBeVisible()

  // Initially not voted.
  await expect(btn).toHaveAttribute('aria-pressed', 'false')

  // Count before voting: should be 0 (server not reachable in test environment,
  // not synced, user has not voted, so display = 0, not a fabricated number).
  const countBefore = await btn.locator('span.tabular-nums').textContent()
  expect(countBefore?.trim(), 'count before voting must be 0 (not fabricated)').toBe('0')

  // Click to vote.
  await btn.click()
  await window.waitForTimeout(150)

  // aria-pressed should be true now.
  await expect(btn).toHaveAttribute('aria-pressed', 'true')

  // Count should now show 1 (the user's own real vote; server not synced).
  const countAfter = await btn.locator('span.tabular-nums').textContent()
  expect(countAfter?.trim(), 'count after voting must be 1 (own real vote)').toBe('1')

  // Vote must persist in localStorage.
  const stored = await window.evaluate(() => {
    try {
      const raw = localStorage.getItem('fb.featureVotes.mine')
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  expect(stored['plexiops'], 'plexiops vote stored in fb.featureVotes.mine').toBe(true)

  // Click again to remove vote.
  await btn.click()
  await window.waitForTimeout(150)

  await expect(btn).toHaveAttribute('aria-pressed', 'false')
  const countRemoved = await btn.locator('span.tabular-nums').textContent()
  expect(countRemoved?.trim(), 'count after removing vote must be 0').toBe('0')

  // localStorage must no longer contain the key.
  const storedAfter = await window.evaluate(() => {
    try {
      const raw = localStorage.getItem('fb.featureVotes.mine')
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  expect('plexiops' in storedAfter, 'plexiops key removed from localStorage after unvote').toBe(false)
})

// ── Test 6: PlexiOps content check ─────────────────────────────────────────────

test('6 — PlexiOps is planned and describes a business-management suite', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSuite(window)

  // Navigate to PlexiOps product home.
  await window.locator('[data-testid="product-tile-plexiops"]').click()
  await window.waitForSelector('[data-testid="product-home-plexiops"]', { timeout: 6_000 })

  const home = window.locator('[data-testid="product-home-plexiops"]')
  await expect(home).toBeVisible()

  // Must be labelled Planned (not Ready or Coming soon).
  await expect(home.locator('text=Planned').first()).toBeVisible()

  // About text must mention business-management capabilities.
  const text = await home.textContent()
  const lower = (text ?? '').toLowerCase()
  expect(lower, 'PlexiiOps mentions CRM').toContain('crm')
  expect(lower, 'PlexiiOps mentions accounting').toContain('accounting')
  expect(lower, 'PlexiiOps mentions payroll').toContain('payroll')
  expect(lower, 'PlexiiOps mentions inventory').toContain('inventory')

  // "What we are building" section should list the planned capabilities.
  await expect(home.locator('text=What we are building')).toBeVisible()
  // Use exact-match + .first() throughout: the about text repeats these phrases, so a
  // plain text= selector hits two elements and Playwright strict-mode rejects it.
  await expect(home.getByText('Marketing and CRM', { exact: true }).first()).toBeVisible()
  await expect(home.getByText('Payroll', { exact: true }).first()).toBeVisible()
  await expect(home.getByText('Inventory and MRP', { exact: true }).first()).toBeVisible()
})

// ── Test 7: No fabricated data check ───────────────────────────────────────────

test('7 — no fabricated vote counts: server-unsynced display is 0 or own vote only', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSuite(window)

  // In a fresh test env the signal server is not running, so serverSynced stays false.
  // All upvote counts must be 0 (no votes cast), never a fabricated positive number.
  await window.waitForTimeout(500) // give load() time to attempt and fail

  const fakeCounts = await window.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('[data-testid^="upvote-"]'))
    return buttons
      .filter((btn) => btn.getAttribute('aria-pressed') === 'false') // not voted
      .map((btn) => {
        const countEl = btn.querySelector('span.tabular-nums')
        return { key: btn.getAttribute('data-testid'), count: Number(countEl?.textContent?.trim() ?? 0) }
      })
      .filter((r) => r.count > 0) // any non-zero count on an unvoted button is fabricated
  })

  expect(fakeCounts, 'no upvote-* button should show a non-zero count when not voted and server not synced').toEqual([])
})
