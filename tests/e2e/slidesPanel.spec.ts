/**
 * E2E for the persistent right-side panel in PlexiSlides (AI Assistant + Slide /
 * Layout properties). Opens a fresh presentation through the PlexiOffice shell and
 * exercises the panel.
 *
 * The AI actions are made deterministic and offline by stubbing the real IPC
 * channels (ai:rewriteSelection, ai:suggestDocContent) at the ipcMain level, the
 * same technique docSidePanel.spec.ts and sheetEditor.spec.ts SE-18 use. The
 * contextBridge exposes a frozen proxy that cannot be monkey-patched from the
 * renderer, so the stub must live in the main process.
 *
 * Coverage:
 *  1. The panel renders (slides-side-panel) with the AI Assistant heading and the
 *     six action buttons, plus the Slide / Layout tabs.
 *  2. Slide / Layout tabs switch the visible content.
 *  3. An AI action (Improve slide) calls the stubbed rewriteSelection and shows
 *     the real result in slides-ai-result.
 *  4. The properties panel reflects the REAL slide state: the actual layout name,
 *     the real theme swatches, and the real font.
 *  5. Typing in the notes editor updates the slide's notes in the stored body.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

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

  test('SP-1 — the panel renders with the AI Assistant and the Slide / Layout tabs', async () => {
    const panel = window.locator('[data-testid="slides-side-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('AI Assistant')).toBeVisible()
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

    await expect(window.locator('[data-testid="slides-tab-slide"]')).toBeVisible()
    await expect(window.locator('[data-testid="slides-tab-layout"]')).toBeVisible()
  })

  test('SP-2 — Slide / Layout tabs switch the visible content', async () => {
    // The Slide tab is the default; its layout property row is visible.
    await window.locator('[data-testid="slides-tab-slide"]').click()
    await expect(window.locator('[data-testid="slides-prop-layout"]')).toBeVisible()
    // The Layout tab swaps in the layout/theme grids (and hides the prop rows).
    await window.locator('[data-testid="slides-tab-layout"]').click()
    await expect(window.locator('[data-testid="slides-layout-title"]')).toBeVisible()
    await expect(window.locator('[data-testid="slides-prop-layout"]')).toHaveCount(0)
    // Back to Slide.
    await window.locator('[data-testid="slides-tab-slide"]').click()
    await expect(window.locator('[data-testid="slides-prop-layout"]')).toBeVisible()
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

  test('SP-4 — the properties panel reflects the real slide layout, theme, and font', async () => {
    await window.locator('[data-testid="slides-tab-slide"]').click()
    // A fresh deck's first slide uses the 'title' layout (emptyBody seeds it).
    await expect(window.locator('[data-testid="slides-prop-layout"]')).toContainText('Title')
    // The theme swatches reflect the resolved deck theme (5 colour dots).
    const swatches = window.locator('[data-testid="slides-prop-theme"] span[style*="background"]')
    await expect(swatches.first()).toBeVisible()
    expect(await swatches.count()).toBeGreaterThanOrEqual(3)
    // The font row shows the real heading font family's first name (default: Inter).
    await expect(window.locator('[data-testid="slides-prop-font"]')).toContainText('Inter')
    // Background row is present and reflects the real fill.
    await expect(window.locator('[data-testid="slides-prop-background"]')).toBeVisible()
  })

  test('SP-5 — typing in the notes editor updates the slide notes', async () => {
    await window.locator('[data-testid="slides-tab-slide"]').click()
    const notes = window.locator('[data-testid="slides-notes-editor"]')
    await notes.click()
    await notes.fill('Remember to greet the audience.')
    // Blur and let autosave debounce flush.
    await window.locator('[data-testid="slides-tab-slide"]').click()
    await window.waitForTimeout(1_200)
    const body = (await readBody(window)) as { slides: Array<{ notes?: string }> } | null
    expect(body?.slides?.[0]?.notes).toBe('Remember to greet the audience.')
  })
})
