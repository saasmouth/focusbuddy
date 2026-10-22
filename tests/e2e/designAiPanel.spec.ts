/**
 * E2E for the persistent right-side AI Assistant panel in PlexiDesign. Opens the
 * design studio through the PlexiOffice shell and exercises the panel.
 *
 * The AI is made deterministic and offline by stubbing the real IPC channels
 * (ai:rewriteSelection, ai:suggestDocContent) at the ipcMain level, the same
 * technique docSidePanel.spec.ts uses. The contextBridge exposes a frozen proxy
 * that cannot be monkey-patched from the renderer, so the stub lives in main.
 *
 * Coverage:
 *  1. The panel renders and the toolbar toggle collapses / reopens it.
 *  2. An action with a selected text element calls the stub and shows the result,
 *     with Apply and Copy affordances.
 *  3. An action that needs a selection but has none shows the honest needs-selection
 *     message (no fabricated content).
 *  4. The free prompt with nothing selected calls the stub and shows a result.
 *  5. The design review (ai:designAdvice) reaches the model with the MEASURED
 *     findings and the real words on the page, and its answer is shown.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea, chooseCloudAiSource, placeDesign } from './_helpers'

const REWRITE_HTML = '<p>Stubbed improved copy.</p>'
const SUGGEST_HTML = '<p>Stubbed design idea.</p>'
const REVIEW_HTML = '<p>Stubbed design review.</p>'

/**
 * Stub ai:rewriteSelection + ai:suggestDocContent + ai:designAdvice at the
 * ipcMain level. The design-review stub also keeps the last brief it was
 * given, so the spec can check what actually reached the model rather than
 * only that something came back.
 */
async function stubDesignAi(app: LaunchedApp['app']): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, payload: { rewrite: string; suggest: string; review: string }) => {
      ipcMain.removeHandler('ai:rewriteSelection')
      ipcMain.removeHandler('ai:suggestDocContent')
      ipcMain.removeHandler('ai:designAdvice')
      ipcMain.handle('ai:rewriteSelection', async () => ({ ok: true, html: payload.rewrite }))
      ipcMain.handle('ai:suggestDocContent', async () => ({ ok: true, html: payload.suggest }))
      ipcMain.handle('ai:designAdvice', async (_e, input: unknown) => {
        ;(globalThis as unknown as { __lastDesignBrief?: unknown }).__lastDesignBrief = input
        return { ok: true, html: payload.review }
      })
    },
    { rewrite: REWRITE_HTML, suggest: SUGGEST_HTML, review: REVIEW_HTML }
  )
}

interface CapturedBrief {
  brief?: { digest?: string; text?: string; purpose?: string; findings?: Array<{ severity: string; title: string; detail: string }> }
}

async function lastBrief(app: LaunchedApp['app']): Promise<CapturedBrief | null> {
  return app.evaluate(
    async () => ((globalThis as unknown as { __lastDesignBrief?: CapturedBrief }).__lastDesignBrief ?? null)
  ) as Promise<CapturedBrief | null>
}

async function openDesignStudio(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-design"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-design"]').click()
  await expect(window.locator('[data-testid="design-editor"]')).toBeVisible({ timeout: 10_000 })
}

/** Add a text element to the canvas and select it, via the toolbar. */
async function addAndSelectText(window: Page): Promise<void> {
  await placeDesign(window, 'text')
  // Adding a text element selects it; the text inspector confirms a text selection.
  await expect(window.locator('[data-testid="design-font-family"]')).toBeVisible({ timeout: 5_000 })
}

/** Clear the selection by clicking the empty canvas margin. */
async function clearSelection(window: Page): Promise<void> {
  // Pressing Escape and clicking the canvas wrapper background deselects.
  await window.locator('[data-testid="slide-canvas"]').click({ position: { x: 4, y: 4 } })
  await expect(window.locator('[data-testid="design-canvas-inspector"]')).toBeVisible({ timeout: 5_000 })
}

test.describe('PlexiDesign AI panel', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    // A fresh profile's AI source is Local since 4.3.39. Choose the cloud
    // source explicitly: it is what these specs assume, and it clears the
    // fixed "local AI missing" notice, which otherwise intercepts clicks on
    // the design toolbar and fails as if Design were broken.
    await chooseCloudAiSource(window)
    await stubDesignAi(app.app)
    await openDesignStudio(window)
  })
  test.afterAll(async () => {
    await app.dispose()
  })

  test('DAP-1 — the panel renders and the toggle collapses / reopens it', async () => {
    await expect(window.locator('[data-testid="design-ai-panel"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-ai-improve"]')).toBeVisible()

    // Collapse via the panel's own button.
    await window.locator('[data-testid="design-ai-collapse"]').click()
    await expect(window.locator('[data-testid="design-ai-panel"]')).toHaveCount(0)

    // Reopen via the toolbar toggle.
    await window.locator('[data-testid="design-ai-toggle"]').click()
    await expect(window.locator('[data-testid="design-ai-panel"]')).toBeVisible()
  })

  test('DAP-2 — needs-selection shows the honest message when nothing is selected', async () => {
    await clearSelection(window)
    await window.locator('[data-testid="design-ai-improve"]').click()
    await expect(window.locator('[data-testid="design-ai-needs-selection"]')).toBeVisible({ timeout: 5_000 })
    // No fabricated result was shown.
    await expect(window.locator('[data-testid="design-ai-result"]')).toHaveCount(0)
  })

  test('DAP-3 — Improve copy on a selected text element calls the stub and shows the result', async () => {
    await addAndSelectText(window)
    await window.locator('[data-testid="design-ai-improve"]').click()
    const result = window.locator('[data-testid="design-ai-result"]')
    await expect(result).toBeVisible({ timeout: 8_000 })
    await expect(result).toContainText('Stubbed improved copy')
    // Apply (replace) and Copy affordances are present.
    await expect(window.locator('[data-testid="design-ai-result-apply"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-ai-result-copy"]')).toBeVisible()
    await expect(window.locator('[data-testid="design-ai-result-apply"]')).toHaveText('Apply')
  })

  test('DAP-4 — the free prompt with nothing selected calls the stub and shows a result', async () => {
    await clearSelection(window)
    await window.locator('[data-testid="design-ai-ask-input"]').fill('a bold tagline for a summer sale')
    await window.locator('[data-testid="design-ai-ask-send"]').click()
    const result = window.locator('[data-testid="design-ai-result"]')
    await expect(result).toBeVisible({ timeout: 8_000 })
    await expect(result).toContainText('Stubbed design idea')
    // With no selection the free prompt inserts a new element, so the action is Insert.
    await expect(window.locator('[data-testid="design-ai-result-apply"]')).toHaveText('Insert')
  })

  test('DAP-5 — the review sends the measured findings and the real words, and shows the answer', async () => {
    await addAndSelectText(window)
    // Put real words in the element: double-click to edit it, replace the
    // placeholder, and leave edit mode. The brief should then carry what is
    // actually set on the page.
    const box = await window.locator('[data-testid="slide-element"]').last().boundingBox()
    if (!box) throw new Error('the new text element has no box')
    await window.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
    await window.keyboard.press('Meta+a')
    await window.keyboard.type('Summer sale ends Friday')
    // The edit commits on blur, not on Escape — Escape cancels it.
    await clearSelection(window)
    await expect(window.locator('[data-testid="slide-canvas"]')).toContainText('Summer sale ends Friday')

    await window.locator('[data-testid="design-ai-purpose"]').fill('A shop window poster')
    await window.locator('[data-testid="design-ai-review-run"]').click()

    const result = window.locator('[data-testid="design-ai-review-result"]')
    await expect(result).toBeVisible({ timeout: 8_000 })
    await expect(result).toContainText('Stubbed design review')
    await expect(window.locator('[data-testid="design-ai-review-copy"]')).toBeVisible()

    // What reached the model: facts measured from this document, and nothing
    // that would let it invent a different one.
    const captured = await lastBrief(app.app)
    const brief = captured?.brief
    expect(brief).toBeTruthy()
    expect(brief?.digest).toContain('Canvas')
    expect(brief?.purpose).toBe('A shop window poster')
    expect(brief?.text).toContain('Summer sale')
    expect(Array.isArray(brief?.findings)).toBe(true)
    // The document itself never crosses: no elements, no image bytes.
    expect(JSON.stringify(captured)).not.toContain('"elements"')
  })
})
