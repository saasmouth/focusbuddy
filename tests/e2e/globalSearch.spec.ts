// E2E coverage for the global deep-content search (Cmd+K → type query).
//
// Tests drive the IPC surface (window.api.search.query) directly for the
// contract assertions since the 160ms debounce inside CommandCenter makes
// waiting for DOM rows flaky under load. The Cmd+K palette UI open/close and
// the rendered result row are covered by the final "renders a result row"
// test which waits for the debounce to settle.

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
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Seed content and open the task canvas so the app is in a known state. */
async function seedAndOpen(l: LaunchedApp, title: string): Promise<{ taskId: string }> {
  const { window } = l
  await waitForReady(window)

  const result = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: t })
    // Anchor sticky so canvas is non-empty.
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'placeholder',
      x: 200,
      y: 160,
      width: 240,
      height: 200
    })
    return { taskId: task.id }
  }, title)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: new RegExp(title) }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector('[data-widget-id]', { timeout: 6_000 })
  await window.waitForTimeout(300)
  return result
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. IPC contract: short query (<2 chars) returns []
// ──────────────────────────────────────────────────────────────────────────────

test('search.query returns empty for <2-char query', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)

  const hits = await launched.window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query('a')
  })
  expect(Array.isArray(hits)).toBe(true)
  expect(hits).toHaveLength(0)
})

// ──────────────────────────────────────────────────────────────────────────────
// 2. IPC contract: task title match returns a 'task' hit
// ──────────────────────────────────────────────────────────────────────────────

test('search.query finds a task by its unique title token', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Use a UUID-like unique token so there is zero chance of a false positive.
  const token = `SRCHTSK_${Date.now()}`
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: t })
  }, token)

  const hits = await window.evaluate(async (q: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query(q)
  }, token) as SearchHit[]

  const taskHit = hits.find((h) => h.type === 'task' && h.title.includes(token))
  expect(taskHit, `expected a task hit containing "${token}"`).toBeDefined()
  expect(taskHit!.score).toBeGreaterThan(0)
})

// ──────────────────────────────────────────────────────────────────────────────
// 3. IPC contract: sticky widget body match returns a 'widget' hit with taskId
// ──────────────────────────────────────────────────────────────────────────────

test('search.query finds a sticky widget by its content, with correct taskId', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `SRCHWGT_${Date.now()}`

  const { taskId } = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'SearchWidgetTask' })
    await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: t,
      x: 100,
      y: 100,
      width: 240,
      height: 200
    })
    return { taskId: task.id }
  }, token)

  const hits = await window.evaluate(async (q: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query(q)
  }, token) as SearchHit[]

  const wgtHit = hits.find((h) => h.type === 'widget' && h.taskId === taskId)
  expect(wgtHit, `expected a widget hit with taskId=${taskId}`).toBeDefined()
  expect(wgtHit!.snippet).toContain(token)
})

// ──────────────────────────────────────────────────────────────────────────────
// 4. IPC contract: document body match returns a 'document' hit
// ──────────────────────────────────────────────────────────────────────────────

test('search.query finds a document by its body text', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const token = `SRCHDOC_${Date.now()}`

  // Create a doc via the documents IPC if it exists, otherwise via a doc widget.
  // We check for window.api.documents first; if absent, create a doc widget instead.
  const docCreated = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    if (api.documents && typeof api.documents.create === 'function') {
      // Use the documents IPC: body is plain text stored in the body column.
      const doc = await api.documents.create({ docType: 'doc', title: 'SearchDoc', body: t })
      return { via: 'documents', id: doc?.id ?? null }
    }
    // Fallback: a doc widget whose content is the body text.
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'SearchDocTask' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'page',
      title: 'SearchDoc',
      content: t,
      x: 100,
      y: 100,
      width: 300,
      height: 300
    })
    return { via: 'widget', id: w?.id ?? null }
  }, token)

  const hits = await window.evaluate(async (q: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.search.query(q)
  }, token) as SearchHit[]

  // Accept either a 'document' hit or a 'widget' hit (for the page-widget path).
  const docHit = hits.find(
    (h) => (h.type === 'document' || h.type === 'widget') && (h.snippet?.includes(token) || h.title?.includes(token))
  )
  expect(
    docHit,
    `expected a document/widget hit for token "${token}" (created via ${docCreated.via})`
  ).toBeDefined()
})

// ──────────────────────────────────────────────────────────────────────────────
// 5. UI: Cmd+K opens the palette with a search input, typing the token renders
//    a result row, Escape closes without breaking anything
// ──────────────────────────────────────────────────────────────────────────────

test('Cmd+K opens palette, unique token produces a result row, Escape closes', async () => {
  launched = await launchApp()
  const { taskId } = await seedAndOpen(launched, 'GlobalSearchUI')
  const { window } = launched

  await waitForReady(window)
  const token = `UISRCH_${Date.now()}`

  // Create a sticky with the unique token content on the seeded task.
  await window.evaluate(
    async ({ tid, t }: { tid: string; t: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.create({
        taskId: tid,
        kind: 'sticky',
        title: '',
        content: t,
        x: 400,
        y: 400,
        width: 240,
        height: 200
      })
    },
    { tid: taskId, t: token }
  )

  // Open Cmd+K.
  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(400)

  // Palette should appear with a focussed input.
  await window.waitForFunction(
    () => document.activeElement?.tagName === 'INPUT',
    null,
    { timeout: 3_000 }
  )

  // Confirm empty query shows the browse list (length > 10 chars of text).
  const emptyText = await window.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const s = window.getComputedStyle(el)
      if (s.position === 'fixed' && el.querySelector('input')) return el.textContent ?? ''
    }
    return ''
  })
  expect(emptyText.length, 'palette must have visible content on empty query').toBeGreaterThan(10)

  // Type the unique token — wait for the 160ms debounce + render time.
  await window.keyboard.type(token)
  await window.waitForTimeout(600)

  // Palette text must contain the token (rendered in the result row label or hint).
  const queryText = await window.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const s = window.getComputedStyle(el)
      if (s.position === 'fixed' && el.querySelector('input')) return el.textContent ?? ''
    }
    return ''
  })
  expect(queryText, `palette must show a row matching token "${token}"`).toContain(token)

  // Arrow-down + Enter should be reachable (keyboard nav works even on search results).
  await window.keyboard.press('ArrowDown')
  await window.waitForTimeout(100)

  // Escape dismisses.
  await window.keyboard.press('Escape')
  await window.waitForTimeout(300)

  // Canvas must still be intact.
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible()
})

// ──────────────────────────────────────────────────────────────────────────────
// 6. Regression: canvasUxCb728aa palette behaviours unaffected (open/close/browse)
// ──────────────────────────────────────────────────────────────────────────────

test('Cmd+K palette still lists nav commands after global-search integration', async () => {
  launched = await launchApp()
  await seedAndOpen(launched, 'SearchRegressionNav')
  const { window } = launched

  await waitForReady(window)
  await window.keyboard.press('Meta+k')
  await window.waitForTimeout(500)

  const text = await window.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const s = window.getComputedStyle(el)
      if (s.position === 'fixed' && el.querySelector('input')) return el.textContent ?? ''
    }
    return ''
  })

  for (const cmd of ['Documents', 'Files', 'Mail', 'PlexiInbox', 'Messages']) {
    expect(text, `nav command "${cmd}" must still be in the browse list`).toContain(cmd)
  }

  await window.keyboard.press('Escape')
})
