/**
 * Regression: wide, non-wrapping content (code blocks with long lines, long
 * unbreakable URLs, big tables) must stay within the page in Page view — it must
 * not run off the right margin / paper edge, and it must not stretch the page
 * itself wider than the paper. This guards the fix for the reported bug where a
 * long code line ran off the edge of the page, dragging the margins with it,
 * because the page (a flex item) had no min-width floor and wide content had no
 * containment CSS.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

async function openDoc(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await window.locator('[data-testid="office-app-docs"]').click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
}

async function measureOverflow(window: Page): Promise<{
  pageWidth: number; preOverEdge: number; preOverMargin: number; urlOverEdge: number; urlOverMargin: number
}> {
  return window.evaluate(() => {
    const pageEl = document.querySelector('[data-testid="doc-page"]') as HTMLElement
    const content = document.querySelector('[data-testid="doc-page-content"]') as HTMLElement
    const pageRect = pageEl.getBoundingClientRect()
    const cRect = content.getBoundingClientRect()
    const marginRight = cRect.right - parseFloat(getComputedStyle(content).paddingRight)
    const pm = document.querySelector('.ProseMirror') as HTMLElement
    const pre = pm.querySelector('pre') as HTMLElement
    const url = [...pm.querySelectorAll('p')].find((p) => (p as HTMLElement).innerText.startsWith('https://')) as HTMLElement
    return {
      pageWidth: pageRect.width,
      preOverEdge: pre.getBoundingClientRect().right - pageRect.right,
      preOverMargin: pre.getBoundingClientRect().right - marginRight,
      urlOverEdge: url.getBoundingClientRect().right - pageRect.right,
      urlOverMargin: url.getBoundingClientRect().right - marginRight
    }
  })
}

test.describe('Page view contains wide content', () => {
  let app: LaunchedApp
  let window: Page
  test.beforeAll(async () => { app = await launchApp(); window = app.window; await waitForReady(window) })
  test.afterAll(async () => { await app.dispose() })

  test('a long code line + long URL stay within the page and do not blow out the width', async () => {
    await openDoc(window)
    await window.evaluate(() => {
      const ed = (window as unknown as { __docEditor?: any }).__docEditor
      const line = 'const config = { ' + Array.from({ length: 26 }, (_, i) => `key_number_${i}: value_${i}`).join(', ') + ' };'
      ed.chain().focus().clearContent()
        .insertContent({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Wide content' }] })
        .insertContent({ type: 'codeBlock', content: [{ type: 'text', text: line + '\n' + line }] })
        .insertContent({ type: 'paragraph', content: [{ type: 'text', text: 'https://example.com/' + 'x'.repeat(220) }] })
        .run()
    })
    await window.waitForTimeout(400)
    await window.locator('[data-testid="doc-pageview-btn"]').click()
    await window.locator('[data-testid="doc-page-canvas"]').waitFor({ state: 'visible', timeout: 6_000 })
    await window.waitForTimeout(500)

    // The reported bug was zoom-dependent, so assert containment at 100% and at a
    // fractional zoom (the app zoom is Chromium page zoom via setZoomFactor).
    for (const zoom of [1.0, 1.25]) {
      await app.app.evaluate(({ BrowserWindow }, z) => { BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(z) }, zoom)
      await window.waitForTimeout(500)
      const r = await measureOverflow(window)
      // Letter portrait at 96dpi is 816px wide. The page must not be stretched by
      // its content (pre-fix this blew out past 1800px).
      expect(r.pageWidth, `[zoom ${zoom}] page should stay ~816px, got ${r.pageWidth}`).toBeLessThan(860)
      // Nothing crosses the paper edge or the right margin (small sub-pixel tolerance).
      expect(r.preOverEdge, `[zoom ${zoom}] code block must not cross the paper edge`).toBeLessThanOrEqual(1)
      expect(r.preOverMargin, `[zoom ${zoom}] code block must not cross the right margin`).toBeLessThanOrEqual(1)
      expect(r.urlOverEdge, `[zoom ${zoom}] long URL must not cross the paper edge`).toBeLessThanOrEqual(1)
      expect(r.urlOverMargin, `[zoom ${zoom}] long URL must not cross the right margin`).toBeLessThanOrEqual(1)
    }
    await app.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1) })
  })
})
