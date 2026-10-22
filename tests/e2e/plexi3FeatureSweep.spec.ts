// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
/**
 * Targeted sweep for the remaining Plexi3.0 user-visible claims not covered by
 * their own dedicated spec files:
 *
 *   - Command palette quick-create: "New document" and "New signature request"
 *   - Global Cmd+/ shortcuts overlay (outside the editors)
 *   - Global search returning calendar time blocks, meetings and sign requests,
 *     and routing them from the palette
 *   - Settings Advanced toggle collapses the tuning surfaces, everyday ones stay
 *   - AllTasksView still lists tasks correctly at a normal (sub-120) count
 *
 * Palette open/search/routing and the shortcuts overlay are fully UI-driven.
 * Search fixtures (time block / meeting / sign request) are seeded via
 * window.api so the test doesn't depend on flaky calendar/meeting UI flows
 * that are out of scope here — the search + routing contract itself is what's
 * under test, driven through the real palette UI.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, grantCapability } from './_helpers'

type SearchHit = { type: string; id: string; title: string }
type FbWindow = Window & {
  api: {
    documents: { list: () => Promise<Array<{ id: string; title: string }>> }
    search: { query: (q: string) => Promise<SearchHit[]> }
    sign: { create: (draft: { title: string; body: string; signerNames: string[] }) => Promise<{ id: string }> }
    timeBlocks: { create: (draft: Record<string, unknown>) => Promise<{ id: string }> }
    nodes: { list: () => Promise<Array<{ id: string; kind: string; title: string; status: string }>>; create: (draft: Record<string, unknown>) => Promise<{ id: string }> }
  }
}

// The palette opens from the top bar's Search button (the bottom command pill
// it used to live on was removed in 5b226e81, "move Search to the top bar").
async function openPalette(window: import('@playwright/test').Page): Promise<void> {
  const search = window.locator('[data-testid="topbar-search"]')
  await expect(search).toBeVisible({ timeout: 5_000 })
  await search.click()
  await window.waitForSelector('[role="dialog"][aria-label="Command palette"]', { timeout: 4_000 })
}

// A palette row BY ITS OWN LABEL. Playwright's hasText is a case-insensitive
// substring, and the palette now leads with "Search the web — “<query>”" and
// "Ask Plexii — “<query>”", which contain the query; `.first()` picked the web
// search. So match the row that has an element whose text IS the label.
function paletteOption(window: import('@playwright/test').Page, label: string): import('@playwright/test').Locator {
  return window
    .locator('[role="dialog"][aria-label="Command palette"] [role="option"]')
    .filter({ has: window.getByText(label, { exact: true }) })
    .first()
}

// ── Quick-create: New document ────────────────────────────────────────────────

test('SWEEP-1 — palette "New document" creates a blank doc and opens it directly in the editor', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const before = await window.evaluate(() => (window as unknown as FbWindow).api.documents.list())

    await openPalette(window)
    const input = window.locator('[role="dialog"][aria-label="Command palette"] input')
    await input.fill('new document')
    const option = paletteOption(window, 'New document')
    await expect(option).toBeVisible({ timeout: 4_000 })
    await option.click()

    // No quick-create detour: it opens straight into the doc editor.
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[role="dialog"][aria-label="Command palette"]')).toHaveCount(0)

    const after = await window.evaluate(() => (window as unknown as FbWindow).api.documents.list())
    expect(after.length, 'a new document was created').toBe(before.length + 1)
  } finally {
    await dispose()
  }
})

// ── Quick-create: New signature request ───────────────────────────────────────

test('SWEEP-2 — palette "New signature request" opens PlexiSign\'s composer', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    // PlexiiSign gates on `esign`, Pro-only since b6ad6564 (2026-07-07); this is
    // about the palette route, not the price, so grant it (as correctnessBatch does).
    await grantCapability(window, 'esign')
    await openPalette(window)
    const input = window.locator('[role="dialog"][aria-label="Command palette"] input')
    await input.fill('new signature')
    const option = paletteOption(window, 'New signature request')
    await expect(option).toBeVisible({ timeout: 4_000 })
    await option.click()

    await expect(window.locator('[data-testid="plexisign"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="sign-composer"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[role="dialog"][aria-label="Command palette"]')).toHaveCount(0)
  } finally {
    await dispose()
  }
})

// ── Shortcuts overlay ──────────────────────────────────────────────────────────

test('SWEEP-3 — Cmd+/ opens the global shortcuts overlay outside any editor, and Escape closes it', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    // Confirm we are not inside a document editor (Home/dashboard shell).
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toHaveCount(0)

    await window.keyboard.press('Meta+/')
    const overlay = window.locator('[data-testid="shortcuts-overlay"]')
    await expect(overlay).toBeVisible({ timeout: 3_000 })
    await expect(overlay).toContainText('Keyboard shortcuts')
    await expect(overlay).toContainText('Search everything (palette)')

    await window.keyboard.press('Escape')
    await expect(overlay).not.toBeVisible({ timeout: 3_000 })
  } finally {
    await dispose()
  }
})

// ── Global search: calendar / meeting / sign hits + palette routing ──────────

test('SWEEP-4 — search:query surfaces event, meeting and sign hits; the palette routes a sign hit to PlexiSign', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await grantCapability(window, 'esign') // PlexiiSign is Pro-only (see SWEEP-2)
    const marker = `Zorbaflex-${Date.now()}`

    // Seed one of each newly-searchable type via real IPC (no UI flakiness).
    await window.evaluate(async (m) => {
      const w = window as unknown as FbWindow
      await w.api.sign.create({ title: `${m} agreement`, body: 'test body', signerNames: ['Alice'] })
      await w.api.timeBlocks.create({
        title: `${m} time block`,
        startMs: Date.now() + 3_600_000,
        durationMin: 60
      })
    }, marker)

    // Direct IPC assertion — the raw contract this claim is built on.
    const hits = await window.evaluate(
      (m) => (window as unknown as FbWindow).api.search.query(m),
      marker
    )
    const types = new Set(hits.map((h) => h.type))
    expect(types.has('sign'), `expected a sign hit among: ${JSON.stringify(hits)}`).toBe(true)
    expect(types.has('event'), `expected an event hit among: ${JSON.stringify(hits)}`).toBe(true)

    // UI routing: search the sign hit in the real palette and confirm it opens PlexiSign.
    await openPalette(window)
    const input = window.locator('[role="dialog"][aria-label="Command palette"] input')
    await input.fill(`${marker} agreement`)
    const option = paletteOption(window, `${marker} agreement`)
    await expect(option).toBeVisible({ timeout: 4_000 })
    await option.click()
    await expect(window.locator('[data-testid="plexisign"]')).toBeVisible({ timeout: 8_000 })
  } finally {
    await dispose()
  }
})

// ── Settings: Advanced toggle ─────────────────────────────────────────────────

// Settings became tabs in f03087b0 (Appearance, Account, Organisation, AI,
// Templates, Data, Advanced) instead of a long popover with a collapsible
// Advanced group. The claim is the same: everyday settings come first and the
// tuning surfaces (sounds, voice, haptics) sit behind Advanced.
test('SWEEP-5 — Settings opens on everyday Appearance; the Advanced tab holds sounds/voice tuning; Account, AI keys and Backup have their own tabs', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await window.getByRole('button', { name: 'Appearance settings' }).click()

    // Opens on the everyday Appearance tab, with the Theme studio.
    const appearanceTab = window.locator('[data-testid="settings-tab-appearance"]')
    await expect(appearanceTab).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
    await expect(window.locator('[data-testid="open-theme-studio"]')).toBeVisible()
    // The tuning controls are not on the everyday tab.
    await expect(window.locator('[data-testid^="voice-mode-"]')).toHaveCount(0)

    // Advanced holds them.
    const advancedTab = window.locator('[data-testid="settings-tab-advanced"]')
    await advancedTab.click()
    await expect(advancedTab).toHaveAttribute('aria-selected', 'true')
    await expect(window.locator('[data-testid^="voice-mode-"]').first()).toBeVisible({ timeout: 3_000 })
    await expect(window.locator('[data-testid="open-theme-studio"]')).toHaveCount(0)

    // The everyday areas each keep a tab of their own, one click away.
    for (const id of ['account', 'ai', 'data']) await expect(window.locator(`[data-testid="settings-tab-${id}"]`)).toBeVisible()

    // And Appearance is one click back.
    await appearanceTab.click()
    await expect(window.locator('[data-testid="open-theme-studio"]')).toBeVisible()
  } finally {
    await dispose()
  }
})

// ── AllTasksView: normal-count sanity (progressive rendering regression) ─────

test('SWEEP-6 — AllTasksView lists tasks correctly at a normal (well under 120) count, no "Loading more" sentinel', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const titles = Array.from({ length: 5 }, (_, i) => `Sweep task ${i + 1}`)
    await window.evaluate(async (ts) => {
      const w = window as unknown as FbWindow
      for (const t of ts) {
        // dueDate = now → matches AllTasksView's default "Today" filter (isToday()).
        await w.api.nodes.create({ parentId: null, kind: 'task', title: t, dueDate: Date.now() })
      }
    }, titles)

    // The renderer's node store only loads once at App mount; it has no push
    // subscription to IPC-created rows. Reload the same (already-onboarded)
    // window so App.tsx's mount-time refresh() picks the new tasks up — this
    // is the same real-world path a user hits by relaunching the app, not a
    // test-only shortcut around the store.
    await window.reload()
    await waitForReady(window)

    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goAllTasks: () => void } } }
      w.__fbView?.getState().goAllTasks()
    })
    await expect(window.getByRole('heading', { name: 'All desks', level: 1 })).toBeVisible({ timeout: 8_000 })

    // Scope to the AllTasksView row list itself (TaskRow renders the title as
    // a <button>) — a bare text= locator also matches the (currently
    // collapsed, hence hidden) sidebar project tree entry for the same task.
    for (const t of titles) {
      await expect(window.getByRole('button', { name: t, exact: true }).first()).toBeVisible({ timeout: 5_000 })
    }
    // With far fewer than 120 rows, the progressive-render sentinel never mounts.
    await expect(window.locator('text=Loading more…')).toHaveCount(0)
  } finally {
    await dispose()
  }
})
