// E2E coverage for PlexiSearch: the full-page unified workspace search view.
// Verifies: (1) sidebar NavRow opens the view, (2) typing a query returns
// result rows, (3) a task hit navigates to the task canvas, (4) a knowledge
// hit navigates to PlexiBrain, (5) pressing Enter / clicking Ask produces
// either a real grounded answer or the honest nokey card (never a fake answer),
// (6) PlexiSuite launcher tile navigates to the same view.

import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null

// The first search of a fresh profile loads the bundled search model (nomic,
// on-device) to embed the query: ~0.6-0.8 s idle, several seconds on a loaded
// machine, which overran the old 4 s wait (plexiSearchV2 "plain Enter with a
// focused result…", red on one run in three). Later searches take ~10 ms. The
// assertion is unchanged; only the wait for the first results is longer.
const FIRST_RESULTS_MS = 15_000

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// 1. Sidebar NavRow opens [data-testid="plexisearch-view"]
// ──────────────────────────────────────────────────────────────────────────────

test('sidebar PlexiSearch NavRow renders plexisearch-view', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // The sidebar row is PlexiiBrain › Search (the "PlexiiSearch" button a
  // fresh profile shows first is the suite launcher's tile, which opens the
  // product page — test 7).
  await window.locator('[data-testid="nav-plexibrain-search"]').click()
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6_000 })
  await expect(window.locator('[data-testid="plexisearch-input"]')).toBeVisible()
  await expect(window.locator('[data-testid="plexisearch-ask"]')).toBeVisible()
})

// ──────────────────────────────────────────────────────────────────────────────
// 2. Typing a query matching a task returns a result row
// ──────────────────────────────────────────────────────────────────────────────

test('typing a matching query shows plexisearch-hit-* rows for a seeded task', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSRCH_${Date.now()}`

  // Seed a task with the token in its title.
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: `Board offsite ${t}` })
  }, token)

  // Open PlexiSearch.
  await window.locator('[data-testid="nav-plexibrain-search"]').click()
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6_000 })

  // Type the token into the search input.
  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)

  // Wait for the 160ms debounce + render.
  await window.waitForTimeout(600)

  // At least one plexisearch-hit-* row must appear.
  const hits = window.locator('[data-testid^="plexisearch-hit-"]')
  await expect(hits.first()).toBeVisible({ timeout: FIRST_RESULTS_MS })
  const count = await hits.count()
  expect(count, 'at least one result row').toBeGreaterThan(0)
})

// ──────────────────────────────────────────────────────────────────────────────
// 3. Clicking a task hit navigates to the task canvas
// ──────────────────────────────────────────────────────────────────────────────

test('clicking a task result row navigates to the task canvas', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSNAV_${Date.now()}`

  const taskId = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: `Task nav ${t}` })
    // Anchor a widget so the canvas renders non-empty.
    await api.widgets.create({ taskId: task.id, kind: 'sticky', title: '', content: 'anchor', x: 100, y: 100, width: 200, height: 160 })
    return task.id
  }, token)

  // Open PlexiSearch and type the token.
  await window.locator('[data-testid="nav-plexibrain-search"]').click()
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6_000 })

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(600)

  // Click the hit row for this specific task.
  const hitRow = window.locator(`[data-testid="plexisearch-hit-${taskId}"]`)
  await expect(hitRow).toBeVisible({ timeout: FIRST_RESULTS_MS })
  await hitRow.click()
  await window.waitForTimeout(600)

  // openHit calls goTask: the search view goes and THAT desk opens. The task
  // was created over IPC, so this window's desk tree does not hold it yet —
  // exactly a desk found by search that another window, the MCP server or sync
  // made. It used to land on "No desks yet" (DeskGallery) beside a desk that
  // exists; the canvas reloads the tree for an unknown id now.
  await expect(window.locator('[data-testid="plexisearch-view"]')).not.toBeVisible({ timeout: 6_000 })
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 6_000 })
  await expect(window.getByText('No desks yet')).toHaveCount(0)
  // The desk's own work widget is on it (its title span is hover-revealed, so attached, not visible).
  await expect(window.locator('[data-testid^="widget-title-"]', { hasText: 'anchor' })).toBeAttached({ timeout: 6_000 })
})

// ──────────────────────────────────────────────────────────────────────────────
// 4. Clicking a knowledge hit navigates to PlexiBrain
// ──────────────────────────────────────────────────────────────────────────────

test('clicking a knowledge result row navigates to plexibrain-view', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSKNOW_${Date.now()}`

  const entryId = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const e = await api.knowledge.create({ title: `Strategy doc ${t}`, body: 'Key planning notes', tags: [] })
    return e.id
  }, token)

  // Open PlexiSearch and search.
  await window.locator('[data-testid="nav-plexibrain-search"]').click()
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6_000 })

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(600)

  const hitRow = window.locator(`[data-testid="plexisearch-hit-${entryId}"]`)
  await expect(hitRow).toBeVisible({ timeout: FIRST_RESULTS_MS })
  await hitRow.click()

  // PlexiBrain view must appear.
  await expect(window.locator('[data-testid="plexibrain-view"]')).toBeVisible({ timeout: 6_000 })
})

// ──────────────────────────────────────────────────────────────────────────────
// 5. Pressing Enter / clicking Ask shows an honest answer card (real or nokey)
// ──────────────────────────────────────────────────────────────────────────────

// NOTE: After the keyboard-nav change, plain Enter opens the focused result
// instead of triggering the AI answer. Cmd+Enter / the Ask button now owns the
// answer-card path. This test is updated to match the new contract: Cmd+Enter
// (Meta+Enter on Mac) shows the answer card. The old plain-Enter-triggers-Ask
// behaviour is also asserted in plexiSearchV2.spec.ts (test 4 and 6).
test('Cmd+Enter on a query renders plexisearch-answer (real answer or honest nokey, never fake)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSASK_${Date.now()}`

  // Seed a knowledge entry so retrieveSources has something to ground on.
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.knowledge.create({ title: `Onboarding checklist ${t}`, body: 'Week-one steps for new hires', tags: ['hr'] })
  }, token)

  // Open PlexiSearch.
  await window.locator('[data-testid="nav-plexibrain-search"]').click()
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6_000 })

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(400)

  // Wait for results to arrive so focusIdx is set, then press Cmd+Enter to Ask.
  await expect(window.locator('[data-testid^="plexisearch-hit-"]').first()).toBeVisible({ timeout: FIRST_RESULTS_MS })
  await input.press('Meta+Enter')

  // Answer card must appear.
  const answer = window.locator('[data-testid="plexisearch-answer"]')
  await expect(answer).toBeVisible({ timeout: 20_000 })

  // plexisearch-view must still be present (Cmd+Enter did not navigate away).
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible()

  const cardText = await answer.textContent()
  expect(cardText?.trim().length, 'answer card must have content').toBeGreaterThan(5)

  if (cardText?.includes('Add an Anthropic key')) {
    expect(cardText).toContain('Add an Anthropic key')
  } else {
    expect(cardText).not.toContain('undefined')
    expect(cardText).not.toContain('[object Object]')
    expect(cardText?.trim().length).toBeGreaterThan(10)
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// 6. Ask button also triggers the answer card
// ──────────────────────────────────────────────────────────────────────────────

test('clicking the Ask button renders plexisearch-answer', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSASKBTN_${Date.now()}`

  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.knowledge.create({ title: `Budget overview ${t}`, body: 'Annual spend plan', tags: [] })
  }, token)

  await window.locator('[data-testid="nav-plexibrain-search"]').click()
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6_000 })

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(400)

  // Click the Ask button explicitly.
  await window.locator('[data-testid="plexisearch-ask"]').click()

  const answer = window.locator('[data-testid="plexisearch-answer"]')
  await expect(answer).toBeVisible({ timeout: 20_000 })
  const cardText = await answer.textContent()
  expect(cardText?.trim().length, 'answer card has content').toBeGreaterThan(5)
})

// ──────────────────────────────────────────────────────────────────────────────
// 7. PlexiSuite launcher tile for PlexiSearch navigates to plexisearch-view
// ──────────────────────────────────────────────────────────────────────────────

test('PlexiSuite launcher opens PlexiSearch product home and launch button navigates to plexisearch-view', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // A fresh profile lands on the PlexiiSuite launcher (view.ts defaults to
  // { kind: 'suite' }); there is no "PlexiiSuite" button on the launcher itself.
  await window.waitForSelector('[data-testid="plexisuite-home"]', { timeout: 8_000 })

  // PlexiSearch tile must be visible and NOT carry a "planned" or "coming soon" badge.
  const tile = window.locator('[data-testid="product-tile-plexisearch"]')
  await expect(tile).toBeVisible()
  await expect(tile.locator('text=Planned')).toHaveCount(0)
  await expect(tile.locator('text=Coming soon')).toHaveCount(0)
  await expect(tile.locator('[data-testid="upvote-plexisearch"]')).toHaveCount(0)

  // Click the tile to open the product home.
  await tile.click()
  await window.waitForSelector('[data-testid="product-home-plexisearch"]', { timeout: 6_000 })
  // Its tray tab reads the canonical name, not the humanised key "Plexisearch".
  const tab = window.locator('[data-testid="tray-item-product:plexisearch"]')
  await expect(tab).toContainText('PlexiiSearch')
  await expect(tab).not.toContainText('inventory_2')

  // The Open/Launch button must be present.
  const openBtn = window.locator('[data-testid="open-plexisearch"]')
  await expect(openBtn).toBeVisible()

  // Clicking it must navigate to PlexiSearch view.
  await openBtn.click()
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6_000 })
})
