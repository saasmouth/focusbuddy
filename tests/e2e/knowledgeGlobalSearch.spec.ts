// E2E: verifies that PlexiBrain knowledge entries are findable via global Cmd+K
// search (the CommandCenter "deep search") and that adding the knowledge category
// did not regress existing search categories (tasks, documents).
//
// All assertions exercise the IPC surface (window.api) directly for the
// search contract, and use Playwright UI gestures only where user-visible
// routing is being verified (opening the palette, confirming the row label).

import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import type { SearchHit } from '../../src/shared/types'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// 1. IPC contract: knowledge entry is returned by search.query (keyword path,
//    no embedding key set in the test environment).
// ──────────────────────────────────────────────────────────────────────────────

test('search.query returns a knowledge hit for a matching title token (no embedding key)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Use a UUID-like token so the hit cannot come from an existing entry.
  const token = `KBSRCH_${Date.now()}`

  // Create a knowledge entry via IPC.
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.knowledge.create({ title: `Quarterly board offsite ${t}`, body: 'Planning session for the board', tags: [] })
  }, token)

  // Query via the search IPC.
  const hits = await window.evaluate(async (q: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query(q)
  }, token) as SearchHit[]

  const kHit = hits.find((h) => h.type === 'knowledge' && h.title.includes(token))
  expect(kHit, `expected a knowledge hit containing token "${token}"`).toBeDefined()
  expect(kHit!.score, 'knowledge hit must have a positive score').toBeGreaterThan(0)
})

// ──────────────────────────────────────────────────────────────────────────────
// 2. IPC contract: body-text match also surfaces the entry.
// ──────────────────────────────────────────────────────────────────────────────

test('search.query returns a knowledge hit when query matches body text', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const bodyToken = `KBBODY_${Date.now()}`

  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.knowledge.create({ title: 'Untitled board entry', body: `Annual leave policy ${t}`, tags: [] })
  }, bodyToken)

  const hits = await window.evaluate(async (q: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query(q)
  }, bodyToken) as SearchHit[]

  const kHit = hits.find((h) => h.type === 'knowledge')
  expect(kHit, `expected a knowledge hit for body token "${bodyToken}"`).toBeDefined()
})

// ──────────────────────────────────────────────────────────────────────────────
// 3. Regression: existing category (task) still returns hits after searchAll
//    became async. Both a task hit and a knowledge hit can exist in the same
//    result set for a shared query token.
// ──────────────────────────────────────────────────────────────────────────────

test('existing task category still returns hits alongside knowledge hits (async searchAll regression)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const sharedToken = `MIXED_${Date.now()}`

  // Create a task and a knowledge entry that both contain the same token.
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: `Task with ${t}` })
    await api.knowledge.create({ title: `Knowledge with ${t}`, body: 'context', tags: [] })
  }, sharedToken)

  const hits = await window.evaluate(async (q: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query(q)
  }, sharedToken) as SearchHit[]

  const taskHit = hits.find((h) => h.type === 'task' && h.title.includes(sharedToken))
  const kHit = hits.find((h) => h.type === 'knowledge' && h.title.includes(sharedToken))

  expect(taskHit, 'task hit must still appear (async regression)').toBeDefined()
  expect(kHit, 'knowledge hit must appear alongside the task hit').toBeDefined()
})

// ──────────────────────────────────────────────────────────────────────────────
// 4. UI: Cmd+K palette shows a "PlexiBrain" label row when a knowledge entry
//    matches; activating the row navigates to the PlexiBrain view.
// ──────────────────────────────────────────────────────────────────────────────

test('Cmd+K palette shows PlexiBrain-labelled row for knowledge hit and navigates on Enter', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Create a knowledge entry with a distinctive unique title so the palette
  // returns it and only it for this token.
  const token = `OFFSITE_${Date.now()}`

  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.knowledge.create({
      title: `Quarterly board offsite ${t}`,
      body: 'Annual strategy day for executives',
      tags: ['board']
    })
  }, token)

  // Open the command palette.
  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(400)

  // Palette must be present (an INPUT in a fixed element is our canary).
  await window.waitForFunction(
    () => document.activeElement?.tagName === 'INPUT',
    null,
    { timeout: 3_000 }
  )

  // Type the unique token.
  await window.keyboard.type(token)
  // Wait for the 160ms debounce + render.
  await window.waitForTimeout(600)

  // The palette text must contain "PlexiBrain" (the hitKindLabel for 'knowledge').
  const paletteText = await window.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (window.getComputedStyle(el).position === 'fixed' && el.querySelector('input')) {
        return el.textContent ?? ''
      }
    }
    return ''
  })

  expect(paletteText, 'palette must show "PlexiiBrain" label for the knowledge hit').toContain('PlexiiBrain')
  // The entry title must be visible too.
  expect(paletteText, 'palette must show the entry title').toContain('board offsite')

  // Activate the top result with Enter — this should navigate to PlexiBrain.
  await window.keyboard.press('Enter')
  await window.waitForTimeout(600)

  // Confirm the PlexiBrain view is now visible.
  await expect(window.locator('[data-testid="plexibrain-view"]')).toBeVisible({ timeout: 5_000 })
})

// ──────────────────────────────────────────────────────────────────────────────
// 5. Sanity: entries with no keyword overlap do NOT appear when semantic is off.
//    (The no-fakery invariant: scoreMatch + knowledgeHitScore(0, rank, false) = 0
//    and the deduper drops score=0 hits.)
// ──────────────────────────────────────────────────────────────────────────────

test('knowledge entry with zero keyword overlap does not appear in results (semantic inactive)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Create a knowledge entry about "bananas" but query for a completely
  // different unique token — no keyword overlap, no embedding key in test env.
  const noMatchToken = `NOMATCH_${Date.now()}`

  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.knowledge.create({ title: 'Banana cultivation techniques', body: 'tropical fruit growing', tags: [] })
  })

  const hits = await window.evaluate(async (q: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query(q)
  }, noMatchToken) as SearchHit[]

  const falsePositive = hits.find((h) => h.type === 'knowledge' && h.title.includes('Banana'))
  expect(falsePositive, 'banana entry must NOT appear for an unrelated query (no-fakery)').toBeUndefined()
})
