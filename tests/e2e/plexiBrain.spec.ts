// E2E verification for PlexiBrain (knowledge base).
// Tests drive the sidebar entry, CRUD through the UI, persistence via IPC,
// search filtering, delete, and the PlexiSuite launcher status for PlexiBrain.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, switchArea } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openBrain(window: LaunchedApp['window']): Promise<void> {
  // Reaching the knowledge view is two clicks. First the Brain entry in the
  // always-visible sidebar segment switcher (labelled "Brain", kind
  // 'plexibrain'; the testid is the stable handle, not the visible text) — that
  // lands on the Brain segment's app-tile home, not the knowledge view. Then the
  // "Ask Brain" app tile, which renders KnowledgeView ([data-testid="plexibrain-view"]).
  await switchArea(window, 'plexibrain')
  await window.locator('[data-testid="segment-app-ask"]').first().click()
  await window.waitForSelector('[data-testid="plexibrain-view"]', { timeout: 8_000 })
}

// ── Test 1: Sidebar entry opens PlexiBrain; empty state is honest ───────────────

test('1 — sidebar PlexiBrain opens [data-testid="plexibrain-view"] and shows honest empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openBrain(window)

  const view = window.locator('[data-testid="plexibrain-view"]')
  await expect(view).toBeVisible()

  // With a fresh DB there are no entries; confirm the honest empty-state text.
  await expect(view.locator('text=No knowledge yet')).toBeVisible({ timeout: 5_000 })

  // No fabricated sample entries in the list.
  const entryRows = await view.locator('[data-testid^="brain-entry-"]').count()
  expect(entryRows, 'zero entries in fresh DB').toBe(0)
})

// ── Test 2: Create, edit title/body/tag/pin ─────────────────────────────────────

test('2 — brain-new creates an entry; title, body, tag, and pin are editable', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBrain(window)

  // Click new-entry button.
  await window.locator('[data-testid="brain-new"]').click()
  await window.waitForSelector('[data-testid="brain-editor"]', { timeout: 5_000 })

  // Exactly one entry row should now appear in the list.
  await expect(window.locator('[data-testid^="brain-entry-"]').first()).toBeVisible()

  // Edit the title.
  const titleInput = window.locator('[data-testid="brain-title"]')
  await titleInput.click({ clickCount: 3 })
  await titleInput.fill('Refund policy')
  await titleInput.press('Tab') // blur to trigger save

  await window.waitForTimeout(200)

  // Edit the body.
  const bodyArea = window.locator('[data-testid="brain-body"]')
  await bodyArea.click()
  await bodyArea.fill('Customers can return any product within 30 days for a full refund.')
  await bodyArea.press('Tab') // blur to trigger save

  await window.waitForTimeout(200)

  // Add a tag via the tag input (Enter to commit).
  const tagInput = window.locator('[data-testid="brain-editor"] input[placeholder="Add tag…"]')
  await tagInput.click()
  await tagInput.fill('policy')
  await tagInput.press('Enter')
  await window.waitForTimeout(100)

  // Confirm tag appears in the editor.
  await expect(window.locator('[data-testid="brain-editor"]').locator('text=policy').first()).toBeVisible()

  // Click pin.
  await window.locator('[data-testid="brain-pin"]').click()
  await window.waitForTimeout(150)

  // Confirm pin icon is active (button background changes via class).
  // The pin button has text-violet-500 when pinned; verify aria or class indirectly
  // by confirming the pin icon renders in the entry row list (pin icon appears when pinned: true).
  const entryRow = window.locator('[data-testid^="brain-entry-"]').first()
  // The row shows a push_pin icon when pinned.
  await expect(entryRow.locator('span[class*="material"]').first()).toBeVisible()
})

// ── Test 3: Persistence via IPC ────────────────────────────────────────────────

test('3 — SQLite write-through: entry with title/body/tags/pinned survives api.knowledge.list()', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBrain(window)

  // Create an entry.
  await window.locator('[data-testid="brain-new"]').click()
  await window.waitForSelector('[data-testid="brain-editor"]', { timeout: 5_000 })

  const titleInput = window.locator('[data-testid="brain-title"]')
  await titleInput.click({ clickCount: 3 })
  await titleInput.fill('PersistTest')
  await titleInput.press('Tab')
  await window.waitForTimeout(200)

  const bodyArea = window.locator('[data-testid="brain-body"]')
  await bodyArea.click()
  await bodyArea.fill('Body content for persistence test.')
  await bodyArea.press('Tab')
  await window.waitForTimeout(200)

  const tagInput = window.locator('[data-testid="brain-editor"] input[placeholder="Add tag…"]')
  await tagInput.fill('persist')
  await tagInput.press('Enter')
  await window.waitForTimeout(100)

  await window.locator('[data-testid="brain-pin"]').click()
  await window.waitForTimeout(300)

  // Read back via IPC.
  const entries = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return await api.knowledge.list()
  })

  expect(entries.length, 'at least one entry in SQLite').toBeGreaterThanOrEqual(1)
  const e = (entries as Array<{ title: string; body: string; tags: string[]; pinned: boolean }>).find(
    (x) => x.title === 'PersistTest'
  )
  expect(e, 'PersistTest entry found in IPC list').toBeTruthy()
  expect(e!.body, 'body persisted').toContain('persistence test')
  expect(e!.tags, 'tag persisted').toContain('persist')
  expect(e!.pinned, 'pinned persisted').toBe(true)
})

// ── Test 4: Search filters list, clear restores all ────────────────────────────

test('4 — brain-search filters entries by query; clearing restores all', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBrain(window)

  // Create two entries with distinct titles.
  async function createNamed(name: string): Promise<void> {
    await window.locator('[data-testid="brain-new"]').click()
    await window.waitForSelector('[data-testid="brain-editor"]', { timeout: 5_000 })
    const t = window.locator('[data-testid="brain-title"]')
    await t.click({ clickCount: 3 })
    await t.fill(name)
    await t.press('Tab')
    await window.waitForTimeout(200)
    // Click away so the next create starts fresh.
    await window.locator('[data-testid="brain-search"]').click()
  }

  await createNamed('Refund Rules')
  await createNamed('Holiday Schedule')

  // Both entries should appear with empty search.
  const allRows = window.locator('[data-testid^="brain-entry-"]')
  await expect(allRows).toHaveCount(2, { timeout: 3_000 })

  // Type a query that matches only one. Search is now async+debounced (~200ms)
  // so we wait 400ms after typing before asserting.
  const searchInput = window.locator('[data-testid="brain-search"]')
  await searchInput.fill('Refund')
  await window.waitForTimeout(400)

  const filteredRows = window.locator('[data-testid^="brain-entry-"]')
  const filteredCount = await filteredRows.count()
  expect(filteredCount, 'search narrows to matching entries').toBe(1)
  await expect(filteredRows.first().locator('text=Refund Rules')).toBeVisible()

  // Clear search — all entries return. Wait for debounce.
  await searchInput.fill('')
  await window.waitForTimeout(400)
  await expect(window.locator('[data-testid^="brain-entry-"]')).toHaveCount(2)
})

// ── Test 5: Delete removes entry; honest empty state returns ───────────────────

test('5 — brain-delete removes the entry; list returns to honest empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openBrain(window)

  // Create one entry.
  await window.locator('[data-testid="brain-new"]').click()
  await window.waitForSelector('[data-testid="brain-editor"]', { timeout: 5_000 })
  await window.locator('[data-testid^="brain-entry-"]').first().waitFor({ state: 'visible' })

  // Delete it.
  await window.locator('[data-testid="brain-delete"]').click()
  await window.waitForTimeout(300)

  // Editor should be gone.
  await expect(window.locator('[data-testid="brain-editor"]')).toHaveCount(0)

  // Entry rows should be empty.
  await expect(window.locator('[data-testid^="brain-entry-"]')).toHaveCount(0)

  // Honest empty state appears again.
  await expect(window.locator('text=No knowledge yet')).toBeVisible({ timeout: 3_000 })
})

// ── Test 6: PlexiBrain is READY in the PlexiSuite launcher ─────────────────────

test('6 — PlexiBrain shows as ready in the PlexiSuite launcher (full colour, no badge, Open button)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // A fresh launch uses an isolated userData dir with no saved view, so the app
  // boots straight onto the PlexiSuite home (view store defaults to kind:'suite').
  // No navigation click needed — just confirm we're there.
  await window.waitForSelector('[data-testid="plexisuite-home"]', { timeout: 8_000 })

  // PlexiBrain tile.
  const brainTile = window.locator('[data-testid="product-tile-plexibrain"]')
  await expect(brainTile).toBeVisible()

  // Must NOT have "Coming soon" or "Planned" badge.
  await expect(brainTile.locator('text=Coming soon')).toHaveCount(0)
  await expect(brainTile.locator('text=Planned')).toHaveCount(0)

  // Must NOT have an upvote button (ready products don't have one).
  await expect(brainTile.locator('[data-testid="upvote-plexibrain"]')).toHaveCount(0)

  // Click tile -> product home -> Open button.
  await brainTile.click()
  await window.waitForSelector('[data-testid="product-home-plexibrain"]', { timeout: 6_000 })
  await expect(window.locator('[data-testid="open-plexibrain"]')).toBeVisible()
})
