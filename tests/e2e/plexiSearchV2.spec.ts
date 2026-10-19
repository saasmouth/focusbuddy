// E2E coverage for the PlexiSearch completeness pass:
// (1) table-by-name search path, (2) keyboard navigation (ArrowDown/Up moves
// focus, plain Enter opens focused result, not the AI answer),
// (3) Cmd+Enter / Ask button still produces the answer card.

import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// helper: open PlexiSearch and wait for the view.
async function openPlexiSearch(window: LaunchedApp['window']): Promise<void> {
  await window.locator('button').filter({ hasText: 'PlexiiSearch' }).first().click()
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6_000 })
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Table-by-name path: a table whose title matches the query appears as a
//    result row even when no row cells contain the query text.
// ──────────────────────────────────────────────────────────────────────────────

test('table-by-name: table with matching title appears as a result row', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `TBLTITLE_${Date.now()}`

  // Create a task and a table scoped to that task. The table title contains
  // the token; the row cells deliberately do NOT.
  const { tableId } = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Table host task' })
    const table = await api.tables.create({
      taskId: task.id,
      title: `Project tracker ${t}`,
      columns: [{ key: 'col1', label: 'Name', type: 'text' }]
    })
    // Add a row with content that does NOT contain the token.
    await api.tables.createRow({ tableId: table.id, cells: { col1: 'unrelated cell content' } })
    return { taskId: task.id, tableId: table.id }
  }, token)

  // Verify directly via IPC that search.query returns the table as a hit.
  const hits = await window.evaluate(async (q: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query(q)
  }, token) as Array<{ type: string; id: string; title: string; taskId?: string }>

  const tableHit = hits.find((h) => h.type === 'table-row' && h.id === tableId)
  expect(tableHit, `table "${token}" must appear as a table-row hit via search.query`).toBeDefined()
  expect(tableHit!.title, 'hit title must include the token').toContain(token)

  // Also confirm the hit appears in the PlexiSearch UI.
  await openPlexiSearch(window)
  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(600)

  const hitRow = window.locator(`[data-testid="plexisearch-hit-${tableId}"]`)
  await expect(hitRow, 'table hit row must be visible in PlexiiSearch').toBeVisible({ timeout: 4_000 })
})

// ──────────────────────────────────────────────────────────────────────────────
// 2. Keyboard navigation: ArrowDown moves the active (accent-highlighted) row;
//    ArrowUp moves it back. Active row has the accent bg class.
// ──────────────────────────────────────────────────────────────────────────────

test('ArrowDown/Up move the active row highlight in the result list', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSKBD_${Date.now()}`

  // Seed three tasks so there are multiple results.
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: `Alpha ${t}` })
    await api.nodes.create({ parentId: null, kind: 'task', title: `Beta ${t}` })
    await api.nodes.create({ parentId: null, kind: 'task', title: `Gamma ${t}` })
  }, token)

  await openPlexiSearch(window)

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(600)

  // After results arrive, the first result must be auto-focused (accent bg).
  const allHits = window.locator('[data-testid^="plexisearch-hit-"]')
  await expect(allHits.first()).toBeVisible({ timeout: 4_000 })
  const count = await allHits.count()
  expect(count, 'need at least 2 results for arrow-key test').toBeGreaterThanOrEqual(2)

  // The first row must have the accent background (active style).
  const firstActive = await allHits.first().evaluate((el) =>
    el.className.includes('accent') || el.className.includes('rgb(var(--accent)')
  )
  expect(firstActive, 'first result must start with active accent style').toBe(true)

  // Press ArrowDown — second row should now be active, first should not.
  await input.press('ArrowDown')
  await window.waitForTimeout(100)

  const secondActive = await allHits.nth(1).evaluate((el) =>
    el.className.includes('accent') || el.className.includes('rgb(var(--accent)')
  )
  const firstNoLongerActive = await allHits.first().evaluate((el) =>
    !(el.className.includes('accent') || el.className.includes('rgb(var(--accent)'))
  )
  expect(secondActive, 'second result must be active after ArrowDown').toBe(true)
  expect(firstNoLongerActive, 'first result must lose active style after ArrowDown').toBe(true)

  // Press ArrowUp — first row should be active again.
  await input.press('ArrowUp')
  await window.waitForTimeout(100)

  const firstActiveAgain = await allHits.first().evaluate((el) =>
    el.className.includes('accent') || el.className.includes('rgb(var(--accent)')
  )
  expect(firstActiveAgain, 'first result must be active again after ArrowUp').toBe(true)
})

// ──────────────────────────────────────────────────────────────────────────────
// 3. Plain Enter opens the focused result and does NOT show the answer card.
// ──────────────────────────────────────────────────────────────────────────────

test('plain Enter opens the focused result and does not trigger the answer card', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSENTR_${Date.now()}`

  // Seed a knowledge entry — clicking it opens PlexiBrain, which is a clear
  // navigation signal we can assert on without needing the canvas to fully load.
  const entryId = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const e = await api.knowledge.create({
      title: `Keyboard test entry ${t}`,
      body: 'Keyboard navigation test',
      tags: []
    })
    return e.id
  }, token)

  await openPlexiSearch(window)

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(600)

  // The entry hit row must be present and auto-focused (it will be the first result).
  const hitRow = window.locator(`[data-testid="plexisearch-hit-${entryId}"]`)
  await expect(hitRow).toBeVisible({ timeout: 4_000 })

  // Press plain Enter — must open the focused hit, NOT run Ask.
  await input.press('Enter')
  await window.waitForTimeout(600)

  // PlexiBrain view must be visible (knowledge hit navigation succeeded).
  await expect(window.locator('[data-testid="plexibrain-view"]')).toBeVisible({ timeout: 6_000 })

  // The answer card must NOT be visible (plain Enter did not trigger Ask).
  await expect(window.locator('[data-testid="plexisearch-answer"]')).not.toBeVisible()
})

// ──────────────────────────────────────────────────────────────────────────────
// 4. Cmd+Enter (meta+Enter on Mac) shows the answer card (honest nokey state).
// ──────────────────────────────────────────────────────────────────────────────

test('Cmd+Enter shows the answer card (not the focused-result navigation)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSMETA_${Date.now()}`

  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.knowledge.create({ title: `Meta enter test ${t}`, body: 'Content', tags: [] })
  }, token)

  await openPlexiSearch(window)

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(600)

  // Confirm results arrived so focusIdx is set.
  await expect(window.locator('[data-testid^="plexisearch-hit-"]').first()).toBeVisible({ timeout: 4_000 })

  // Press Cmd+Enter — this must call runAsk, NOT openHit.
  await input.press('Meta+Enter')

  // Answer card must appear.
  await expect(window.locator('[data-testid="plexisearch-answer"]')).toBeVisible({ timeout: 15_000 })

  // We must still be on the plexisearch-view (not navigated away).
  await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible()
})

// ──────────────────────────────────────────────────────────────────────────────
// 5. Ask button still shows the answer card (regression guard).
// ──────────────────────────────────────────────────────────────────────────────

test('Ask button shows the answer card regardless of keyboard focus state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSASKBTN2_${Date.now()}`

  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.knowledge.create({ title: `Ask button test ${t}`, body: 'Content', tags: [] })
  }, token)

  await openPlexiSearch(window)

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(600)

  await expect(window.locator('[data-testid^="plexisearch-hit-"]').first()).toBeVisible({ timeout: 4_000 })

  await window.locator('[data-testid="plexisearch-ask"]').click()

  await expect(window.locator('[data-testid="plexisearch-answer"]')).toBeVisible({ timeout: 15_000 })
  const cardText = await window.locator('[data-testid="plexisearch-answer"]').textContent()
  expect(cardText?.trim().length, 'answer card has content').toBeGreaterThan(5)
})

// ──────────────────────────────────────────────────────────────────────────────
// 6. Confirm plain Enter does NOT trigger AI ask when results are focused
//    (direct state check via the answer card's non-appearance)
// ──────────────────────────────────────────────────────────────────────────────

test('plain Enter with a focused result does not show the answer card', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `PSNOANSR_${Date.now()}`

  // Seed a task (navigates to canvas, which unmounts plexisearch-view).
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: `No answer task ${t}` })
  }, token)

  await openPlexiSearch(window)

  const input = window.locator('[data-testid="plexisearch-input"]')
  await input.click()
  await input.fill(token)
  await window.waitForTimeout(600)

  // Confirm at least one hit arrived.
  await expect(window.locator('[data-testid^="plexisearch-hit-"]').first()).toBeVisible({ timeout: 4_000 })

  // Press plain Enter.
  await input.press('Enter')
  await window.waitForTimeout(800)

  // plexisearch-view must no longer be visible (navigation fired, not Ask).
  await expect(window.locator('[data-testid="plexisearch-view"]')).not.toBeVisible({ timeout: 4_000 })
})
