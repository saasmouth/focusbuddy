// E2E verification for PlexiBuild Phase 1 (no-code app builder).
// Tests drive sidebar entry, create, name edit, palette adds, preview mode,
// reorder/remove, delete, and launcher status.

import { test, expect } from '@playwright/test'
import { gotoView, launchApp, openProduct, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openBuild(window: LaunchedApp['window']): Promise<void> {
  await openProduct(window, 'build')
  await window.waitForSelector('[data-testid="plexibuild-view"]', { timeout: 8_000 })
}

// ── Test 1: Sidebar entry; honest empty state ──────────────────────────────────

test('1 — sidebar PlexiBuild opens [data-testid="plexibuild-view"] with honest empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openBuild(window)

  const view = window.locator('[data-testid="plexibuild-view"]')
  await expect(view).toBeVisible()

  // Honest empty state — no fabricated apps.
  // Both the list rail and ModuleHome show "No apps yet" when items=0; use .first()
  // to target the list-rail instance and satisfy Playwright strict mode.
  await expect(view.locator('text=No apps yet').first()).toBeVisible({ timeout: 5_000 })
  const rows = await view.locator('[data-testid^="build-app-"]').count()
  expect(rows, 'zero app rows in fresh DB').toBe(0)

  // New-app button visible.
  await expect(view.locator('[data-testid="build-new-app"]')).toBeVisible()
})

// ── Test 2: Create, edit app name ──────────────────────────────────────────────

test('2 — build-new-app creates an app; name edit persists', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBuild(window)

  await window.locator('[data-testid="build-new-app"]').click()
  await window.waitForSelector('[data-testid="app-builder"]', { timeout: 5_000 })

  // One app row appears.
  await expect(window.locator('[data-testid^="build-app-"]').first()).toBeVisible()

  // Edit the app name.
  const nameInput = window.locator('[data-testid="app-name"]')
  await nameInput.click({ clickCount: 3 })
  await nameInput.fill('Customer intake form')
  await nameInput.press('Tab') // blur → save
  await window.waitForTimeout(200)

  // The row label should update.
  await expect(window.locator('[data-testid^="build-app-"]').first().locator('text=Customer intake form')).toBeVisible()
})

// ── Test 3: Build a component stack; count badge updates ───────────────────────

test('3 — palette adds heading, field, button; component cards appear; count badge shows 3', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBuild(window)

  await window.locator('[data-testid="build-new-app"]').click()
  await window.waitForSelector('[data-testid="app-builder"]', { timeout: 5_000 })

  // Add heading.
  await window.locator('[data-testid="palette-heading"]').click()
  await window.waitForTimeout(150)
  // Add field.
  await window.locator('[data-testid="palette-field"]').click()
  await window.waitForTimeout(150)
  // Add button.
  await window.locator('[data-testid="palette-button"]').click()
  await window.waitForTimeout(150)

  // Three component cards rendered.
  await expect(window.locator('[data-testid="build-component-heading"]')).toBeVisible()
  await expect(window.locator('[data-testid="build-component-field"]')).toBeVisible()
  await expect(window.locator('[data-testid="build-component-button"]')).toBeVisible()

  // Set the heading label text via its input (placeholder "Heading text").
  const headingInput = window.locator('[data-testid="build-component-heading"] input[placeholder="Heading text"]')
  await headingInput.fill('Customer Intake')
  await window.waitForTimeout(100)

  // Set the field label.
  const fieldLabelInput = window.locator('[data-testid="build-component-field"] input[placeholder="Field label"]')
  await fieldLabelInput.fill('Full name')
  await window.waitForTimeout(100)

  // Change field type to 'number' via its select.
  const fieldTypeSelect = window.locator('[data-testid="build-component-field"] select')
  await fieldTypeSelect.selectOption('number')
  await window.waitForTimeout(100)

  // App row count badge must show 3.
  const appRow = window.locator('[data-testid^="build-app-"]').first()
  const badge = appRow.locator('span').last() // the ml-auto span showing component count
  await expect(badge).toHaveText('3')
})

// ── Test 4: Persistence via IPC ────────────────────────────────────────────────

test('4 — api.apps.list() returns app with 3 components and edited values', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBuild(window)

  await window.locator('[data-testid="build-new-app"]').click()
  await window.waitForSelector('[data-testid="app-builder"]', { timeout: 5_000 })

  // Rename app.
  const nameInput = window.locator('[data-testid="app-name"]')
  await nameInput.click({ clickCount: 3 })
  await nameInput.fill('PersistApp')
  await nameInput.press('Tab')
  await window.waitForTimeout(200)

  // Add heading + field + button.
  await window.locator('[data-testid="palette-heading"]').click()
  await window.waitForTimeout(100)
  await window.locator('[data-testid="palette-field"]').click()
  await window.waitForTimeout(100)
  await window.locator('[data-testid="palette-button"]').click()
  await window.waitForTimeout(100)

  // Edit heading label.
  const headingInput = window.locator('[data-testid="build-component-heading"] input[placeholder="Heading text"]')
  await headingInput.fill('Persist heading')
  await window.waitForTimeout(150)

  // Wait a tick for the debounced/immediate onChange calls to reach IPC.
  await window.waitForTimeout(300)

  // Read back via IPC.
  const apps = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return await api.apps.list()
  })

  const appList = apps as Array<{ name: string; components: Array<{ type: string; label?: string }> }>
  const found = appList.find((a) => a.name === 'PersistApp')
  expect(found, 'PersistApp found in IPC list').toBeTruthy()
  expect(found!.components.length, '3 components persisted').toBe(3)

  const types = found!.components.map((c) => c.type)
  expect(types, 'heading component present').toContain('heading')
  expect(types, 'field component present').toContain('field')
  expect(types, 'button component present').toContain('button')

  const heading = found!.components.find((c) => c.type === 'heading')
  expect(heading?.label, 'heading label persisted').toBe('Persist heading')
})

// ── Test 5: Preview mode ───────────────────────────────────────────────────────

test('5 — preview mode renders heading, interactive field, and button', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBuild(window)

  await window.locator('[data-testid="build-new-app"]').click()
  await window.waitForSelector('[data-testid="app-builder"]', { timeout: 5_000 })

  // Add heading + field + button.
  await window.locator('[data-testid="palette-heading"]').click()
  await window.waitForTimeout(100)
  await window.locator('[data-testid="palette-field"]').click()
  await window.waitForTimeout(100)
  await window.locator('[data-testid="palette-button"]').click()
  await window.waitForTimeout(100)

  // Set heading text so we can assert it in preview.
  const headingInput = window.locator('[data-testid="build-component-heading"] input[placeholder="Heading text"]')
  await headingInput.fill('Preview Test Heading')
  await window.waitForTimeout(100)

  // Set field label.
  const fieldLabel = window.locator('[data-testid="build-component-field"] input[placeholder="Field label"]')
  await fieldLabel.fill('Your name')
  await window.waitForTimeout(100)

  // Switch to Preview mode.
  await window.locator('[data-testid="app-preview-mode"]').click()
  await window.waitForSelector('[data-testid="app-preview"]', { timeout: 4_000 })

  const preview = window.locator('[data-testid="app-preview"]')
  await expect(preview).toBeVisible()

  // Heading text renders.
  await expect(preview.locator('text=Preview Test Heading')).toBeVisible()

  // Field renders as an input and is interactive.
  const previewField = preview.locator('input[type="text"]').first()
  await previewField.fill('Alice')
  await expect(previewField).toHaveValue('Alice')

  // Button renders.
  await expect(preview.locator('button')).toBeVisible()

  // Switch back to Build mode.
  await window.locator('[data-testid="app-build-mode"]').click()
  await expect(window.locator('[data-testid="build-component-heading"]')).toBeVisible()
  // Palette bar visible again in build mode.
  await expect(window.locator('[data-testid="palette-heading"]')).toBeVisible()
})

// ── Test 6: Reorder and remove in build mode ───────────────────────────────────

test('6 — move-down and remove controls update the component stack', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBuild(window)

  await window.locator('[data-testid="build-new-app"]').click()
  await window.waitForSelector('[data-testid="app-builder"]', { timeout: 5_000 })

  // Add heading then field (heading first, field second).
  await window.locator('[data-testid="palette-heading"]').click()
  await window.waitForTimeout(100)
  await window.locator('[data-testid="palette-field"]').click()
  await window.waitForTimeout(100)

  // Two components present.
  await expect(window.locator('[data-testid^="build-component-"]')).toHaveCount(2)

  // Move heading down (it is first, so "move down" button should be enabled).
  // The heading card's move-down button is title="Move down".
  const headingCard = window.locator('[data-testid="build-component-heading"]')
  const moveDownBtn = headingCard.locator('button[title="Move down"]')
  await moveDownBtn.click()
  await window.waitForTimeout(150)

  // After move, the first component in the DOM should now be the field.
  const allCards = window.locator('[data-testid^="build-component-"]')
  await expect(allCards.first()).toHaveAttribute('data-testid', 'build-component-field')
  await expect(allCards.nth(1)).toHaveAttribute('data-testid', 'build-component-heading')

  // Remove the field (now first) via its × button.
  const fieldCard = window.locator('[data-testid="build-component-field"]')
  const removeBtn = fieldCard.locator('button[title="Remove"]')
  await removeBtn.click()
  await window.waitForTimeout(150)

  // Only heading remains.
  await expect(window.locator('[data-testid^="build-component-"]')).toHaveCount(1)
  await expect(window.locator('[data-testid="build-component-heading"]')).toBeVisible()

  // App row count badge shows 1.
  const badge = window.locator('[data-testid^="build-app-"]').first().locator('span').last()
  await expect(badge).toHaveText('1')
})

// ── Test 7: Delete app; honest empty state ─────────────────────────────────────

test('7 — app-delete removes the app; list returns to honest empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBuild(window)

  await window.locator('[data-testid="build-new-app"]').click()
  await window.waitForSelector('[data-testid="app-builder"]', { timeout: 5_000 })
  await expect(window.locator('[data-testid^="build-app-"]').first()).toBeVisible()

  // Delete it.
  await window.locator('[data-testid="app-delete"]').click()
  await window.waitForTimeout(300)

  // Builder gone, row gone, empty state returns.
  await expect(window.locator('[data-testid="app-builder"]')).toHaveCount(0)
  await expect(window.locator('[data-testid^="build-app-"]')).toHaveCount(0)
  await expect(window.locator('text=No apps yet').first()).toBeVisible({ timeout: 3_000 })
})

// ── Test 8: PlexiBuild READY in the launcher ───────────────────────────────────

test('8 — PlexiBuild shows as ready in the PlexiSuite launcher (Open button, no badge)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Open PlexiSuite home.
  // STALE: no button contains "PlexiiSuite" — the object-based IA dropped the
  // literal sidebar entries, so the filtered click waited out the full 30s
  // timeout. goSuite ({ kind: 'suite' }) is the view store's own route, and is
  // also where a fresh profile already lands (see plexiSearch.spec.ts:257).
  await gotoView(window, 'goSuite')
  await window.waitForSelector('[data-testid="plexisuite-home"]', { timeout: 8_000 })

  const tile = window.locator('[data-testid="product-tile-plexibuild"]')
  await expect(tile).toBeVisible()
  await expect(tile.locator('text=Coming soon')).toHaveCount(0)
  await expect(tile.locator('text=Planned')).toHaveCount(0)
  await expect(tile.locator('[data-testid="upvote-plexibuild"]')).toHaveCount(0)

  // Product home shows Open button.
  await tile.click()
  await window.waitForSelector('[data-testid="product-home-plexibuild"]', { timeout: 6_000 })
  await expect(window.locator('[data-testid="open-plexibuild"]')).toBeVisible()
})
