import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, selectBarTab } from './_helpers'

// Regression guard for the page-view pagination: no top-level block may straddle
// the grey gap between two sheets, and the page uses the default 1-inch (96px)
// margins. Before the fix, the plugin summed per-block heights (ignoring CSS
// margin collapse), so spacers landed short and text spilled across the page gap.
test('page view: no block straddles the page gap, default 1in margins', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // A doc with headings + paragraphs long enough to fill several pages.
    const docId = await window.evaluate(async () => {
      const blocks: unknown[] = []
      for (let i = 0; i < 60; i++) {
        if (i % 6 === 0) {
          blocks.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Section ${i / 6 + 1}` }] })
        }
        blocks.push({
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: `Paragraph ${i + 1}. This is a line of body text long enough to wrap once or twice so pages fill up naturally as we go, giving the pagination something real to measure and break across sheets.`
            }
          ]
        })
      }
      const created = await window.api.documents.create({
        docType: 'doc',
        title: 'PaginationRegression',
        body: { type: 'doc', content: blocks }
      })
      return created.id
    })

    await window.evaluate((id) => {
      const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
      w.__fbView?.getState().goDocument(id)
    }, docId)
    await window.locator('[data-testid="doc-editor-surface"]').waitFor({ timeout: 8000 }).catch(() => {})
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-pageview-btn"]').click()
    await window.waitForTimeout(1200)

    const report = await window.evaluate(() => {
      const content = document.querySelector('[data-testid="doc-page-content"]') as HTMLElement | null
      const sheets = Array.from(document.querySelectorAll('[data-testid="doc-page-sheet"]')) as HTMLElement[]
      const pageEl = document.querySelector('[data-testid="doc-page"]') as HTMLElement | null
      const cs = content ? getComputedStyle(content) : null
      const pr = pageEl?.getBoundingClientRect()
      const sheetRects = sheets.map((s) => {
        const r = s.getBoundingClientRect()
        return { top: r.top - (pr?.top ?? 0), bottom: r.bottom - (pr?.top ?? 0) }
      })
      const gaps = sheetRects.slice(0, -1).map((s, i) => ({ from: s.bottom, to: sheetRects[i + 1].top }))
      const pm = content?.querySelector('.ProseMirror') as HTMLElement | null
      const blocks = Array.from(pm?.children ?? []).filter((el) => !el.classList.contains('fb-page-spacer')) as HTMLElement[]
      let overlapCount = 0
      blocks.forEach((b) => {
        const r = b.getBoundingClientRect()
        const top = r.top - (pr?.top ?? 0)
        const bot = r.bottom - (pr?.top ?? 0)
        for (const g of gaps) {
          if (bot > g.from + 1 && top < g.to - 1) {
            overlapCount++
            break
          }
        }
      })
      return {
        sheetCount: sheets.length,
        blockCount: blocks.length,
        overlapCount,
        padTop: cs?.paddingTop,
        padBottom: cs?.paddingBottom,
        padLeft: cs?.paddingLeft
      }
    })

    // Multi-page doc actually paginated.
    expect(report.sheetCount).toBeGreaterThan(1)
    expect(report.blockCount).toBeGreaterThan(1)
    // The core guarantee: nothing crosses the page gap.
    expect(report.overlapCount).toBe(0)
    // Default 1-inch margins (96px at 96dpi) are applied to the page content.
    expect(report.padTop).toBe('96px')
    expect(report.padBottom).toBe('96px')
    expect(report.padLeft).toBe('96px')
  } finally {
    await dispose()
  }
})
