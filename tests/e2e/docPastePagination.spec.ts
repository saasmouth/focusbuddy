/**
 * Regression: pasted text must bind to the page content zone, not flow
 * continuously through the page-break gaps. A wall of text (single newlines)
 * collapses into ONE giant paragraph; between-block pagination alone left it
 * spilling across every gap. The pagination engine now breaks WITHIN a paragraph
 * at line boundaries (like Word), so no text line lands in a gap or off the
 * sheets. Also asserts the sheet is white paper.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

test.describe('pasted text paginates within the content zone', () => {
  let app: LaunchedApp
  let window: Page
  test.beforeAll(async () => { app = await launchApp(); window = app.window; await waitForReady(window) })
  test.afterAll(async () => { await app.dispose() })

  test('a wall of pasted text breaks across pages with no line in a gap', async () => {
    await switchArea(window, 'office')
    await window.locator('[data-testid="office-app-docs"]').click()
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
    await window.locator('[data-testid="doc-pageview-btn"]').click()
    await expect(window.locator('[data-testid="doc-page-canvas"]')).toBeVisible({ timeout: 6_000 })

    const para = 'The quick brown fox jumps over the lazy dog, and then pauses to consider the meadow before continuing past the river. '.repeat(4)
    await window.evaluate((t) => {
      const ed = (window as unknown as { __docEditor?: { chain: () => { focus: () => { clearContent: () => { run: () => void } } } } }).__docEditor
      ed?.chain().focus().clearContent().run()
      const pm = document.querySelector('.ProseMirror') as HTMLElement
      pm.focus()
      const dt = new DataTransfer(); dt.setData('text/plain', t)
      pm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, Array.from({ length: 40 }, (_, i) => `Line ${i + 1}. ${para}`).join('\n'))
    await window.waitForTimeout(1200)

    const r = await window.evaluate(() => {
      const sheets = [...document.querySelectorAll('[data-testid="doc-page-sheet"]')].map((s) => { const b = s.getBoundingClientRect(); return { top: b.top, bottom: b.bottom } })
      const sheetBg = getComputedStyle(document.querySelector('[data-testid="doc-page-sheet"]')!).backgroundColor
      const spacers = document.querySelectorAll('.ProseMirror .fb-page-spacer').length
      const blocks = [...document.querySelector('.ProseMirror')!.children].filter((c) => !(c as HTMLElement).classList.contains('fb-page-spacer'))
      let linesOff = 0, linesTotal = 0
      for (const b of blocks) {
        const range = document.createRange(); range.selectNodeContents(b)
        for (const rc of Array.from(range.getClientRects())) {
          if (rc.width < 1 || rc.height < 1 || rc.height > 200) continue
          linesTotal++
          const mid = (rc.top + rc.bottom) / 2
          if (!sheets.some((s) => mid >= s.top - 1 && mid <= s.bottom + 1)) linesOff++
        }
      }
      return { sheets: sheets.length, spacers, linesTotal, linesOff, sheetBg }
    })

    expect(r.sheets, 'wall of text must span multiple pages').toBeGreaterThanOrEqual(3)
    expect(r.spacers, 'must break within the paragraph at line boundaries').toBeGreaterThanOrEqual(2)
    expect(r.linesTotal, 'sanity: measured many text lines').toBeGreaterThan(50)
    expect(r.linesOff, 'no text line may sit in a gap or off the sheets').toBe(0)
    expect(r.sheetBg, 'pages are white paper').toBe('rgb(255, 255, 255)')
  })
})
