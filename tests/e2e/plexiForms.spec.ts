// E2E verification for PlexiForms: form builder + fill + responses → real table rows.

import { test, expect } from '@playwright/test'
import { openProduct, launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openForms(window: LaunchedApp['window']): Promise<void> {
  await openProduct(window, 'form')
  await window.waitForSelector('[data-testid="plexiforms-view"]', { timeout: 8_000 })
}

// ── Test 1: Sidebar entry; honest empty state ──────────────────────────────────

test('1 — sidebar PlexiForms opens view with honest empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openForms(window)

  const view = window.locator('[data-testid="plexiforms-view"]')
  await expect(view).toBeVisible()
  // The list rail shows its own "No forms yet" and ModuleHome shows another in the
  // right pane — both are honest, but Playwright strict mode rejects an unscoped
  // locator that matches two elements. Use .first() to target the list-rail instance.
  await expect(view.locator('text=No forms yet').first()).toBeVisible({ timeout: 5_000 })
  expect(await view.locator('[data-testid^="form-row-"]').count(), 'zero form rows in fresh DB').toBe(0)
  await expect(view.locator('[data-testid="form-new"]')).toBeVisible()
})

// ── Test 2: Create form, edit title ───────────────────────────────────────────

test('2 — form-new creates a form and backing table; title edit persists', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openForms(window)

  await window.locator('[data-testid="form-new"]').click()
  await window.waitForSelector('[data-testid="form-editor"]', { timeout: 5_000 })

  // Form row appears in list.
  await expect(window.locator('[data-testid^="form-row-"]').first()).toBeVisible()

  // Edit title.
  const titleInput = window.locator('[data-testid="form-title"]')
  await titleInput.click({ clickCount: 3 })
  await titleInput.fill('Customer intake')
  await titleInput.press('Tab')
  await window.waitForTimeout(200)

  // Row label updates.
  await expect(window.locator('[data-testid^="form-row-"]').first().locator('text=Customer intake')).toBeVisible()

  // Build tab is active by default; form-field-row for the starter "Name" field visible.
  await expect(window.locator('[data-testid="form-tab-build"]')).toBeVisible()
  await expect(window.locator('[data-testid="form-field-row"]').first()).toBeVisible()
})

// ── Test 3: Build fields; starter + 2 more = 3 rows ───────────────────────────

test('3 — starter Name field + form-add-number + form-add-single-select = 3 field rows', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openForms(window)

  await window.locator('[data-testid="form-new"]').click()
  await window.waitForSelector('[data-testid="form-editor"]', { timeout: 5_000 })

  // Starter field already present.
  await expect(window.locator('[data-testid="form-field-row"]')).toHaveCount(1, { timeout: 3_000 })

  // Add a number field.
  await window.locator('[data-testid="form-add-number"]').click()
  await window.waitForTimeout(300)

  // Add a single-select field.
  await window.locator('[data-testid="form-add-single-select"]').click()
  await window.waitForTimeout(300)

  // Three field rows total.
  await expect(window.locator('[data-testid="form-field-row"]')).toHaveCount(3, { timeout: 3_000 })

  // Edit the starter Name field label to "Full name".
  const firstFieldInput = window.locator('[data-testid="form-field-row"]').first().locator('input').first()
  await firstFieldInput.fill('Full name')
  await window.waitForTimeout(200)

  // Label change is reflected.
  await expect(firstFieldInput).toHaveValue('Full name')
})

// ── Test 4: Core loop — fill → submit → responses table → real table row ───────

test('4 — fill + submit creates a real table row; responses tab shows it; IPC confirms', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openForms(window)

  // Create a form.
  await window.locator('[data-testid="form-new"]').click()
  await window.waitForSelector('[data-testid="form-editor"]', { timeout: 5_000 })

  // Wait for the backing table to be fully loaded — columns appear in Build tab.
  // Give the async loadTable() call time to complete before switching tabs.
  await expect(window.locator('[data-testid="form-field-row"]')).toHaveCount(1, { timeout: 5_000 })
  await window.waitForTimeout(400)

  // Switch to Fill tab.
  await window.locator('[data-testid="form-tab-fill"]').click()
  await window.waitForSelector('[data-testid="form-fill"]', { timeout: 4_000 })

  // The Name field renders via FieldEditor (text-short, variant=cell) as a plain
  // input with placeholder="Name". Wait for it to appear after the tab renders.
  const nameInput = window.locator('[data-testid="form-fill"] input[placeholder="Name"]').first()
  await expect(nameInput).toBeVisible({ timeout: 4_000 })
  await nameInput.fill('Alice Tester')
  // FieldEditor uses onCommit on blur, so blur the field to commit the value.
  await nameInput.press('Tab')
  await window.waitForTimeout(150)

  // Click Submit.
  await window.locator('[data-testid="form-submit"]').click()
  await window.waitForTimeout(200)

  // Confirmation appears (visible for 2.5s).
  await expect(window.locator('[data-testid="form-submitted"]')).toBeVisible({ timeout: 3_000 })

  // Switch to Responses tab.
  await window.locator('[data-testid="form-tab-responses"]').click()
  await window.waitForSelector('[data-testid="form-responses"]', { timeout: 4_000 })

  const responsesTable = window.locator('[data-testid="form-responses"]')
  await expect(responsesTable).toBeVisible()
  // The row shows the submitted value.
  await expect(responsesTable.locator('text=Alice Tester')).toBeVisible()

  // Verify via IPC that a real row exists in the backing table.
  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const forms = await api.forms.list() as Array<{ id: string; tableId: string }>
    if (!forms.length) return { rows: [], tableId: null }
    const tableId = forms[0].tableId
    const rows = await api.tables.listRows(tableId) as Array<{ cells: Record<string, unknown> }>
    return { rows, tableId }
  })

  expect((result.rows as unknown[]).length, 'at least one row in the backing table').toBeGreaterThanOrEqual(1)

  // Find the row whose cells contain 'Alice Tester'.
  const submitted = (result.rows as Array<{ cells: Record<string, unknown> }>).find((r) =>
    Object.values(r.cells).some((v) => String(v).includes('Alice Tester'))
  )
  expect(submitted, 'row with "Alice Tester" found in backing table via IPC').toBeTruthy()
})

// ── Test 5: Delete form; honest empty state returns ────────────────────────────

test('5 — form-delete removes the form; list returns to honest empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openForms(window)

  await window.locator('[data-testid="form-new"]').click()
  await window.waitForSelector('[data-testid="form-editor"]', { timeout: 5_000 })
  await expect(window.locator('[data-testid^="form-row-"]').first()).toBeVisible()

  await window.locator('[data-testid="form-delete"]').click()
  await window.waitForTimeout(300)

  await expect(window.locator('[data-testid="form-editor"]')).toHaveCount(0)
  await expect(window.locator('[data-testid^="form-row-"]')).toHaveCount(0)
  await expect(window.locator('text=No forms yet').first()).toBeVisible({ timeout: 3_000 })
})

// ── Test 6: PlexiForms READY in launcher ──────────────────────────────────────

test('6 — PlexiForms shows as ready in the PlexiSuite launcher', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.locator('button').filter({ hasText: 'PlexiiSuite' }).first().click()
  await window.waitForSelector('[data-testid="plexisuite-home"]', { timeout: 8_000 })

  const tile = window.locator('[data-testid="product-tile-plexiforms"]')
  await expect(tile).toBeVisible()
  await expect(tile.locator('text=Coming soon')).toHaveCount(0)
  await expect(tile.locator('text=Planned')).toHaveCount(0)
  await expect(tile.locator('[data-testid="upvote-plexiforms"]')).toHaveCount(0)

  await tile.click()
  await window.waitForSelector('[data-testid="product-home-plexiforms"]', { timeout: 6_000 })
  await expect(window.locator('[data-testid="open-plexiforms"]')).toBeVisible()
})
