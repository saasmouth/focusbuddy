/**
 * E2E for PlexiiDeck's AI side pane and the slide properties that used to sit
 * under it. On the office shell (SPEC §2.5a, §6.4) the assistant is the AI pane
 * of the shared right ShellSidePane (switcher: PlexiiAssist / Generate deck),
 * the slide's layout, theme, background and font are on the Design tab, and the
 * speaker notes stay under the canvas.
 *
 * The AI actions are made deterministic and offline by stubbing the real IPC
 * channels (ai:rewriteSelection, ai:suggestDocContent) at the ipcMain level, the
 * same technique docSidePanel.spec.ts and sheetEditor.spec.ts SE-18 use. The
 * contextBridge exposes a frozen proxy that cannot be monkey-patched from the
 * renderer, so the stub must live in the main process.
 *
 * Coverage:
 *  1. The side pane renders (slides-side-panel) with PlexiiAssist and its six
 *     action buttons, and a switcher to deck generation.
 *  2. The switcher swaps panes; it collapses to an edge tab and reopens.
 *  3. An AI action (Improve slide) calls the stubbed rewriteSelection and shows
 *     the real result in slides-ai-result.
 *  4. The Design tab reflects the REAL slide state: the actual layout name, the
 *     real theme, and the real font; Layouts and themes opens as a panel.
 *  5. Typing in the notes editor (under the canvas) updates the stored notes.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea, selectBarTab } from './_helpers'

const REWRITE_HTML = '<p>Sharper rewritten slide line.</p>'

/** Stub ai:rewriteSelection + ai:suggestDocContent at the ipcMain level. */
async function stubSlideAi(app: LaunchedApp['app'], html: string): Promise<void> {
  await app.evaluate(({ ipcMain }, h: string) => {
    ipcMain.removeHandler('ai:rewriteSelection')
    ipcMain.removeHandler('ai:suggestDocContent')
    ipcMain.handle('ai:rewriteSelection', async () => ({ ok: true, html: h }))
    ipcMain.handle('ai:suggestDocContent', async () => ({ ok: true, html: h }))
  }, html)
}

/** Open PlexiOffice and launch a fresh presentation; wait for the panel. */
async function openSlides(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-slides"]').click()
  await expect(window.locator('[data-testid="slides-toolbar"]')).toBeVisible({ timeout: 12_000 })
  await expect(window.locator('[data-testid="slides-side-panel"]')).toBeVisible({ timeout: 8_000 })
}

/** Read the most-recent document's body from the store. */
async function readBody(window: Page): Promise<unknown> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    if (!docs.length) return null
    const doc = await api.documents.get(docs[0].id)
    return doc?.body ?? null
  })
}

test.describe('PlexiSlides side panel', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await stubSlideAi(app.app, REWRITE_HTML)
    await openSlides(window)
  })

  test.afterAll(async () => {
    await app.dispose()
  })

  test('SP-1 — the side pane renders with PlexiiAssist and a switcher to deck generation', async () => {
    const panel = window.locator('[data-testid="slides-side-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-testid="slides-ai-assistant"]')).toBeVisible()
    await expect(panel.getByText('Here are some ideas for your slide')).toBeVisible()

    // The six per-slide actions.
    for (const id of [
      'slides-ai-improve',
      'slides-ai-rewrite',
      'slides-ai-shorten',
      'slides-ai-design',
      'slides-ai-notes',
      'slides-ai-more'
    ]) {
      await expect(window.locator(`[data-testid="${id}"]`)).toBeVisible()
    }

    await expect(window.locator('[data-testid="slides-side-panel-tab-ai"]')).toHaveAttribute('aria-selected', 'true')
    await expect(window.locator('[data-testid="slides-side-panel-tab-generate"]')).toBeVisible()
    // The top bar's toggle and the rail's AI item both point at it.
    await expect(window.locator('[data-testid="slides-sidepane-toggle"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(window.locator('[data-testid="slides-rail-ai"]')).toHaveAttribute('aria-controls', 'shell-sidepane')
  })

  test('SP-2 — the switcher swaps panes; the pane collapses to an edge tab and comes back', async () => {
    await window.locator('[data-testid="slides-side-panel-tab-generate"]').click()
    await expect(window.locator('[data-testid="slides-ai-panel"]')).toBeVisible()
    await expect(window.locator('[data-testid="slides-ai-improve"]')).toHaveCount(0)
    await window.locator('[data-testid="slides-side-panel-tab-ai"]').click()
    await expect(window.locator('[data-testid="slides-ai-improve"]')).toBeVisible()
    // Collapse, then the edge tab's chevron brings back the pane last open.
    await window.locator('[data-testid="slides-side-panel-collapse"]').click()
    await expect(window.locator('[data-testid="slides-side-panel-edge"]')).toBeVisible()
    await window.locator('[data-testid="slides-side-panel-expand"]').click()
    await expect(window.locator('[data-testid="slides-ai-improve"]')).toBeVisible()
  })

  test('SP-3 — an AI action calls the real (stubbed) API and shows the result', async () => {
    await window.locator('[data-testid="slides-ai-improve"]').click()
    const result = window.locator('[data-testid="slides-ai-result"]')
    await expect(result).toBeVisible({ timeout: 8_000 })
    await expect(result).toContainText('Sharper rewritten slide line.')
    // The Apply and Copy controls are present.
    await expect(window.locator('[data-testid="slides-ai-result-apply"]')).toBeVisible()
    await expect(window.locator('[data-testid="slides-ai-result-copy"]')).toBeVisible()
  })

  test('SP-4 — the Design tab reflects the real slide layout, theme, and font; Layouts and themes opens as a panel', async () => {
    await selectBarTab(window, 'slides-toolbar', 'design')
    // A fresh deck's first slide uses the 'title' layout (emptyBody seeds it).
    await expect(window.locator('[data-testid="slides-prop-layout"]')).toContainText('Title')
    // The theme control names the resolved deck theme, and its menu marks it.
    const themeName = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const docs = await api.documents.list()
      const doc = docs.length ? await api.documents.get(docs[0].id) : null
      return ((doc?.body as { theme?: string } | undefined)?.theme ?? 'plexi-default') as string
    })
    await window.locator('[data-testid="slides-prop-theme"]').click()
    await expect(window.locator(`[data-testid="slides-theme-${themeName}"]`)).toHaveAttribute('aria-checked', 'true')
    await window.keyboard.press('Escape')
    // The font shows the real heading font family's first name (default: Inter).
    await expect(window.locator('[data-testid="slides-prop-font"]')).toContainText('Inter')
    await expect(window.locator('[data-testid="slides-prop-background"]')).toBeVisible()
    // "Layouts and themes" (the old Master slides button) opens the visual grids as a panel.
    await window.locator('[data-testid="slides-prop-master"]').click()
    await expect(window.locator('[data-testid="slides-panel-layouts"] [data-testid="slides-panel-layout-title"]')).toBeVisible()
    await window.locator('[data-testid="slides-panel-layouts-close"]').click()
    await expect(window.locator('[data-testid="slides-panel-layouts"]')).toHaveCount(0)
  })

  test('SP-5 — typing in the notes editor under the canvas updates the slide notes', async () => {
    const notes = window.locator('[data-testid="slides-notes-editor"]')
    await expect(notes).toHaveCount(1) // one notes editor: under the canvas
    await notes.click()
    await notes.fill('Remember to greet the audience.')
    await notes.press('Tab') // blur, then let the autosave debounce flush
    await window.waitForTimeout(1_200)
    const body = (await readBody(window)) as { slides: Array<{ notes?: string }> } | null
    expect(body?.slides?.[0]?.notes).toBe('Remember to greet the audience.')
  })
})
