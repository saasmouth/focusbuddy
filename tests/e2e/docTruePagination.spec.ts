/**
 * TRUE-PAG  TRUE PAGINATION E2E
 *
 * Verifies the ProseMirror PagePagination extension (pagination.ts) + PageSheet
 * component (DocEditor.tsx) together produce genuine discrete-sheet pagination:
 *
 *  1. Multiple [data-testid="doc-page-sheet"] divs — one per page.
 *  2. Real vertical gap between sheets (~28px) — bounding box of sheet[i+1].top
 *     must exceed sheet[i].bottom by approximately PAGE_GAP (28px).
 *  3. .fb-page-spacer elements exist inside the ProseMirror content.
 *  4. Typing after pagination is active does not freeze the editor.
 *  5. Console stays quiet — no uncaught error flood (no runaway loop).
 *  6. Switching to Continuous view removes the sheets and spacers.
 *  7. Switching back to Page view re-paginates correctly (second toggle).
 *
 * All content injection is API-driven via window.__docEditor (exposed by DocEditor
 * for exactly this purpose) so we avoid the slowness and flakiness of typing
 * 60+ paragraphs through DOM synthetic events.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, switchArea } from './_helpers'
import { join } from 'path'
import { mkdirSync } from 'fs'

// Beside every other spec's evidence, not in one agent session's scratchpad.
const SCREENSHOT_DIR = 'test-results/doc-true-pagination'
const SCREENSHOT_PATH = join(SCREENSHOT_DIR, 'doc-true-pagination.png')

// ── Helper: navigate to Documents hub and open the first doc (or create one) ──

async function navigateToDocEditor(window: import('@playwright/test').Page): Promise<void> {
  // PlexiOffice houses Documents. Use the area-switcher.
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-docs"]').click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
}

// ── TRPAG-1  Multi-sheet, spacers, gap, typing, console, toggle x2 ───────────

test('TRPAG-1 — true pagination: discrete sheets with gap, spacers, typing safe, no loop, toggle survives', async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const { window, dispose } = await launchApp()

  // Collect renderer console errors so we can assert no flood at the end.
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  try {
    await waitForReady(window)
    await navigateToDocEditor(window)

    // ── Step 1: inject enough content for ~3 pages ─────────────────────────────
    // Letter portrait at 96dpi: 816×1056, default 1" margins → usable height
    // ~864px. Each paragraph at ~20px → need ~44+ for 1 break; 90 is well over 3.
    const injected = await window.evaluate(() => {
      const ed = (window as unknown as {
        __docEditor?: { commands: { setContent: (c: object) => void } }
      }).__docEditor
      if (!ed) return false
      const paragraphs = Array.from({ length: 90 }, (_, i) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: `Line ${i + 1}: The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.` }]
      }))
      ed.commands.setContent({ type: 'doc', content: paragraphs })
      return true
    })
    expect(injected, 'window.__docEditor must be available to inject content').toBe(true)

    // Allow React + ResizeObserver a tick to process.
    await window.waitForTimeout(500)

    // ── Step 2: switch to Page view ────────────────────────────────────────────
    const pageViewBtn = window.locator('[data-testid="doc-pageview-btn"]')
    await expect(pageViewBtn).toBeVisible({ timeout: 5_000 })
    await pageViewBtn.click()

    // The canvas must appear.
    const canvas = window.locator('[data-testid="doc-page-canvas"]')
    await expect(canvas).toBeVisible({ timeout: 6_000 })

    // ── Step 3: wait for multiple sheet elements ───────────────────────────────
    // The pagination plugin fires on a rAF after mount; give it up to 8 s.
    await window.waitForFunction(
      () => document.querySelectorAll('[data-testid="doc-page-sheet"]').length >= 2,
      null,
      { timeout: 8_000 }
    )

    const sheets = window.locator('[data-testid="doc-page-sheet"]')
    const sheetCount = await sheets.count()
    console.log(`[TRPAG-1] sheetCount=${sheetCount}`)
    expect(sheetCount, 'must have at least 2 page sheets for 90 paragraphs').toBeGreaterThanOrEqual(2)

    // ── Step 3b: measure the gap between the first two sheets ──────────────────
    // Each sheet is `position:absolute; top: i*stride; height: geom.h`. The gap
    // between sheet 0's bottom edge and sheet 1's top edge must equal PAGE_GAP
    // (28px). We read their bounding rects from the page.
    const gapPx = await window.evaluate(() => {
      const sheets = document.querySelectorAll('[data-testid="doc-page-sheet"]')
      if (sheets.length < 2) return null
      const r0 = sheets[0].getBoundingClientRect()
      const r1 = sheets[1].getBoundingClientRect()
      return r1.top - r0.bottom
    })
    console.log(`[TRPAG-1] measured gap between sheet[0] and sheet[1]: ${gapPx}px`)
    expect(gapPx, 'gap between consecutive sheets must not be null').not.toBeNull()
    // Allow ±4px tolerance for scroll/rounding.
    expect(
      Math.abs((gapPx as number) - 28),
      `gap must be ~28px (PAGE_GAP); got ${gapPx}px`
    ).toBeLessThanOrEqual(4)
    // Confirm sheets are NOT overlapping and NOT a single continuous sheet.
    expect(gapPx as number, 'sheets must not overlap (gap must be positive)').toBeGreaterThan(0)

    // ── Step 3b-ii: each gap is labelled with the page it begins ─────────────
    // Carried over from docPageBreakVisual.spec.ts, which was deleted: it
    // asserted the OLD model, where `doc-page-break` was itself a 26px band
    // spanning the sheet. d8ebb926 replaced that band with these discrete
    // sheets and the real gap measured above, and `doc-page-break` became the
    // small page-number label sitting in the gap. Everything else that spec
    // checked is covered here already; the label was the one thing that was not.
    const breaks = window.locator('[data-testid="doc-page-break"]')
    // One label per gap, and there is one gap fewer than there are sheets.
    await expect(breaks).toHaveCount(sheetCount - 1)
    await expect(breaks.first()).toBeVisible()
    expect((await breaks.first().textContent())?.trim()).toBe('Page 2')

    // The label sits INSIDE the gap it names, not on either sheet.
    const labelInGap = await window.evaluate(() => {
      const sheetEls = document.querySelectorAll('[data-testid="doc-page-sheet"]')
      const label = document.querySelector('[data-testid="doc-page-break"]')
      if (sheetEls.length < 2 || !label) return null
      const r0 = sheetEls[0].getBoundingClientRect()
      const r1 = sheetEls[1].getBoundingClientRect()
      const rl = label.getBoundingClientRect()
      // Allow a pixel of rounding at each edge of the band.
      return rl.top >= r0.bottom - 1 && rl.bottom <= r1.top + 1
    })
    expect(labelInGap, 'the "Page 2" label must sit in the gap, not on a sheet').toBe(true)

    // ── Step 3c: fb-page-spacer elements exist inside ProseMirror ─────────────
    const spacerCount = await window.evaluate(
      () => document.querySelectorAll('.fb-page-spacer').length
    )
    console.log(`[TRPAG-1] fb-page-spacer count: ${spacerCount}`)
    expect(spacerCount, '.fb-page-spacer elements must exist inside ProseMirror content').toBeGreaterThanOrEqual(1)

    // Also confirm spacers carry contenteditable=false and aria-hidden=true.
    const spacerAttrs = await window.evaluate(() => {
      const s = document.querySelector('.fb-page-spacer')
      if (!s) return null
      return {
        ce: s.getAttribute('contenteditable'),
        aria: s.getAttribute('aria-hidden'),
        height: (s as HTMLElement).style.height
      }
    })
    expect(spacerAttrs?.ce, 'spacer contenteditable must be "false"').toBe('false')
    expect(spacerAttrs?.aria, 'spacer aria-hidden must be "true"').toBe('true')
    const spacerH = parseFloat(spacerAttrs?.height ?? '0')
    expect(spacerH, 'spacer must have a positive height').toBeGreaterThan(0)

    // ── Step 4a: screenshot for visual confirmation ────────────────────────────
    // Scroll the second sheet into view so the gap is visible in the screenshot.
    await sheets.nth(1).scrollIntoViewIfNeeded()
    await window.waitForTimeout(300)
    await canvas.screenshot({ path: SCREENSHOT_PATH })
    console.log(`[TRPAG-1] screenshot saved: ${SCREENSHOT_PATH}`)

    // ── Step 4b: typing after pagination is active (editor safety) ─────────────
    // Click at the very start of the editor surface and append a line.
    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await window.keyboard.press('End')
    await window.keyboard.press('Enter')
    await window.keyboard.type('Typing after pagination is active — editor safety test.')
    // Give React a moment to process the update.
    await window.waitForTimeout(300)
    // Confirm the new text is visible in the surface — editor did not freeze.
    await expect(surface.locator('text=Typing after pagination is active')).toBeVisible({
      timeout: 4_000
    })
    console.log('[TRPAG-1] typing after pagination active: OK')

    // ── Step 4c: console quiet (no error flood / runaway loop) ────────────────
    // Collect console for 3 more seconds while idle in page view.
    // A runaway measure→dispatch loop would produce dozens of errors quickly.
    const errorsBefore = consoleErrors.length
    await window.waitForTimeout(3_000)
    const errorsAfter = consoleErrors.length
    const newErrors = errorsAfter - errorsBefore
    console.log(`[TRPAG-1] console errors during 3s idle: ${newErrors}`)
    // Allow at most 2 incidental errors (e.g. a single unrelated network warn).
    expect(
      newErrors,
      `console error flood detected (${newErrors} errors in 3s idle); likely runaway loop. First: ${consoleErrors[errorsBefore] ?? 'none'}`
    ).toBeLessThanOrEqual(2)

    // ── Step 5: toggle to Continuous view — sheets and spacers disappear ───────
    const continuousBtn = window.locator('[data-testid="doc-layout-toggle"] button', { hasText: 'Continuous' })
    await expect(continuousBtn).toBeVisible({ timeout: 3_000 })
    await continuousBtn.click()
    // Give pagination plugin time to clear decorations.
    await window.waitForTimeout(600)

    // doc-page-canvas (the grey wrapper) should be gone.
    await expect(canvas).not.toBeVisible({ timeout: 4_000 })
    // No sheet elements.
    const sheetsAfterContinuous = await window.locator('[data-testid="doc-page-sheet"]').count()
    expect(sheetsAfterContinuous, 'sheets must be removed in Continuous view').toBe(0)
    // No spacers.
    const spacersAfterContinuous = await window.evaluate(
      () => document.querySelectorAll('.fb-page-spacer').length
    )
    expect(spacersAfterContinuous, 'spacers must be cleared in Continuous view').toBe(0)

    // Typing still works in continuous view.
    await surface.click()
    await window.keyboard.press('End')
    await window.keyboard.press('Enter')
    await window.keyboard.type('Continuous view typing OK.')
    await expect(surface.locator('text=Continuous view typing OK')).toBeVisible({ timeout: 4_000 })
    console.log('[TRPAG-1] continuous view: sheets/spacers cleared, typing OK')

    // ── Step 6: toggle BACK to Page view — re-paginates (second toggle) ────────
    await pageViewBtn.click()
    await expect(canvas).toBeVisible({ timeout: 6_000 })
    await window.waitForFunction(
      () => document.querySelectorAll('[data-testid="doc-page-sheet"]').length >= 2,
      null,
      { timeout: 8_000 }
    )
    const sheetsAfterReenter = await window.locator('[data-testid="doc-page-sheet"]').count()
    expect(sheetsAfterReenter, 'must re-paginate to >= 2 sheets after second toggle to Page view').toBeGreaterThanOrEqual(2)
    const spacersAfterReenter = await window.evaluate(
      () => document.querySelectorAll('.fb-page-spacer').length
    )
    expect(spacersAfterReenter, 'spacers must re-appear after second toggle').toBeGreaterThanOrEqual(1)
    console.log(`[TRPAG-1] second toggle to Page view: sheetCount=${sheetsAfterReenter}, spacerCount=${spacersAfterReenter}`)

    // Final summary log
    console.log(`[TRPAG-1] VERDICT: sheets=${sheetCount}, gap=${gapPx}px, spacers=${spacerCount}, no error flood, typing works in both views, second toggle OK`)

  } finally {
    await dispose()
  }
})
