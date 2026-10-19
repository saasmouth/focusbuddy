import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Regression test for the "cursor stops mid-word" bug: StickyWidget and
// NoteWidget kept local textarea state and saved to the store on a 600ms
// debounce, but their reconcile effect re-adopted widget.content on EVERY
// store change — including the echo of their own save. When the debounce
// fired mid-typing (a brief pause between words), the store echoed the
// just-saved value back and the effect reset the textarea, dropping
// characters typed in the gap. The fix guards the reconcile so it only
// adopts content on a new widget id or a genuine EXTERNAL change
// (widget.content !== lastSavedRef.current), never the self-echo.
//
// All typing in these tests is driven via Playwright's pressSequentially,
// which dispatches real keydown/keypress/input DOM events into the actual
// textarea element — not via .fill()/.evaluate() value assignment.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedWidget(
  l: LaunchedApp,
  kind: 'sticky' | 'note'
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)

  const seeded = await window.evaluate(
    async ({ kind }: { kind: 'sticky' | 'note' }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'CursorRaceTest' })
      const w = await api.widgets.create({
        taskId: t.id,
        kind,
        title: '',
        content: '',
        x: 100,
        y: 100,
        width: 320,
        height: 260
      })
      return { taskId: t.id, widgetId: w.id }
    },
    { kind }
  )

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /CursorRaceTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 6_000 })

  return seeded
}

async function readContent(l: LaunchedApp, taskId: string, widgetId: string): Promise<string> {
  return l.window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const all = await api.widgets.listByTask(tid)
      return all.find((w) => w.id === wid)?.content ?? '__NOT_FOUND__'
    },
    { tid: taskId, wid: widgetId }
  )
}

// ─── 1: Sticky — key repro, single pause across the 600ms debounce ───────────

test('sticky — typing across the debounce boundary does not drop characters', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedWidget(launched, 'sticky')

  const textarea = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.click()

  await textarea.pressSequentially('hello', { delay: 40 })
  // Long enough for the 600ms debounce to fire and the store echo to land.
  await window.waitForTimeout(750)
  await textarea.pressSequentially(' world', { delay: 40 })

  // Give any further debounce/echo cycle a moment to settle before asserting.
  await window.waitForTimeout(300)

  const value = await textarea.inputValue()
  console.log('[sticky-pause] textarea value:', JSON.stringify(value))
  expect(value).toBe('hello world')

  // Caret should still be live in the textarea (still focused, not blurred/reset).
  const stillFocused = await textarea.evaluate((el) => el === document.activeElement)
  console.log('[sticky-pause] textarea still focused:', stillFocused)
  expect(stillFocused).toBe(true)
})

// ─── 2: Sticky — stronger repro, three chunks each separated by >650ms ───────

test('sticky — three chunks separated by pauses > debounce window all land in order', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedWidget(launched, 'sticky')

  const textarea = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.click()

  await textarea.pressSequentially('the ', { delay: 40 })
  await window.waitForTimeout(700)
  await textarea.pressSequentially('quick ', { delay: 40 })
  await window.waitForTimeout(700)
  await textarea.pressSequentially('brown', { delay: 40 })
  await window.waitForTimeout(700)

  const value = await textarea.inputValue()
  console.log('[sticky-3chunk] textarea value:', JSON.stringify(value))
  expect(value).toBe('the quick brown')
})

// ─── 3: Note — same pause-mid-typing repro ───────────────────────────────────

test('note — typing across the debounce boundary does not drop characters', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { widgetId } = await seedWidget(launched, 'note')

  const textarea = window.locator(`[data-widget-id="${widgetId}"] textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.click()

  await textarea.pressSequentially('hello', { delay: 40 })
  await window.waitForTimeout(750)
  await textarea.pressSequentially(' world', { delay: 40 })
  await window.waitForTimeout(300)

  const value = await textarea.inputValue()
  console.log('[note-pause] textarea value:', JSON.stringify(value))
  expect(value).toBe('hello world')
})

// ─── 4: Regression — fast continuous typing (no pauses) still yields full string

test('sticky — fast continuous typing with no pauses is not affected', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, widgetId } = await seedWidget(launched, 'sticky')

  const textarea = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.click()

  await textarea.pressSequentially('the quick brown fox jumps over the lazy dog', { delay: 15 })

  const value = await textarea.inputValue()
  console.log('[sticky-fast] textarea value immediately after typing:', JSON.stringify(value))
  expect(value).toBe('the quick brown fox jumps over the lazy dog')

  // Let the debounce flush and confirm the saved content in the DB matches too.
  await window.waitForTimeout(900)
  const saved = await readContent(launched, taskId, widgetId)
  console.log('[sticky-fast] saved content after debounce:', JSON.stringify(saved))
  expect(saved).toBe('the quick brown fox jumps over the lazy dog')
})

// ─── 5: Regression — a genuine EXTERNAL content change still surfaces ────────
//
// NOTE ON COVERAGE: the widgets Zustand store is not exposed on `window` for
// tests, so this spec cannot push a content change into the store while the
// widget stays mounted (the branch of the reconcile guard that fires on
// `widget.content !== lastSavedRef.current` while the component is live).
// What IS exercised here is the DB-level contract: an external actor (IPC,
// standing in for sync/AI/mirror) writes new content, and a fresh mount of
// the same widget (via reload) adopts it rather than getting stuck on stale
// local state. This is real coverage of "external writes aren't lost," just
// not of the specific live in-place re-adoption branch. Best-effort per the
// tester brief.

test('sticky — external content change via IPC survives and is adopted on remount', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, widgetId } = await seedWidget(launched, 'sticky')

  const textarea = window.locator(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.click()
  await textarea.pressSequentially('local text', { delay: 30 })
  await window.waitForTimeout(900) // let it save/settle

  // Blur so the widget is no longer the active edit target, then push an
  // external update via the IPC api directly (simulating sync/AI/mirror) —
  // a real, product-exposed write path, not a fabricated one.
  await textarea.blur()
  await window.waitForTimeout(200)

  await window.evaluate(
    async ({ wid, content }: { wid: string; content: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.update(wid, { content })
    },
    { wid: widgetId, content: 'external replacement text' }
  )

  const saved = await readContent(launched, taskId, widgetId)
  console.log('[sticky-external] saved content immediately after external write:', JSON.stringify(saved))
  expect(saved).toBe('external replacement text')
  await window.waitForTimeout(500)

  // Force a fresh mount by closing this Electron instance and launching a new
  // one against the SAME userData dir (the documented restart-persistence
  // pattern in _helpers.ts) — window.reload() proved unreliable in this
  // sandbox (the renderer's devtools/inspector wedges the reload, a harness
  // artifact unrelated to the product fix). A full restart avoids that.
  // NOTE: dispose() would rmSync the dir since this launch owns it (no
  // userDataDir was passed) — close the app directly instead, without
  // deleting the dir, so the second launch can see what was saved.
  const dir = launched.userDataDir
  try {
    await Promise.race([
      launched.app.close(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000))
    ])
  } catch {
    try {
      launched.app.process().kill()
    } catch {
      // already dead
    }
  }
  launched = await launchApp({ userDataDir: dir })
  const w2 = launched.window
  await waitForReady(w2)
  // A restart against the same userData dir restores the last-open view, so
  // the canvas (with the widget already on it) may already be showing —
  // navigating via the Home task-list button would then hang. Only click
  // through if the widget isn't already present.
  const alreadyOnCanvas = await w2
    .waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 3_000 })
    .then(() => true)
    .catch(() => false)
  if (!alreadyOnCanvas) {
    await w2.getByRole('button', { name: /CursorRaceTest/ }).first().click()
    await w2.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
    await w2.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 6_000 })
  }

  const textarea2 = w2.locator(`[data-widget-id="${widgetId}"] .fb-sticky-textarea`)
  const renderedDiv2 = w2.locator(`[data-widget-id="${widgetId}"] .fb-sticky-rendered`)
  await renderedDiv2.click()
  await expect(textarea2).toBeVisible({ timeout: 3_000 })
  const value = await textarea2.inputValue()
  console.log('[sticky-external] textarea value after restart:', JSON.stringify(value))
  expect(value).toBe('external replacement text')

  // Manually clean up the reused dir since this launch didn't own it.
  const { rmSync } = await import('fs')
  rmSync(dir, { recursive: true, force: true })
  launched = null
})
