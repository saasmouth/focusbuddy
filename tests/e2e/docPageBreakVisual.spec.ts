/**
 * PBV-1  PAGE-BREAK VISUAL SPLIT
 *
 * After typing enough content to overflow one Letter-portrait page (~1056px
 * usable height), switching to Page view must produce:
 *  - [data-testid="doc-page-canvas"]  — the grey canvas wrapper
 *  - [data-testid="doc-page"]         — the white sheet
 *  - at least one [data-testid="doc-page-break"] element — the split band
 *
 * The split band must:
 *  - have a computed height of 26px (the GAP constant)
 *  - span the full width of the sheet (left:0, right:0 in its inline style)
 *  - carry a visible "Page 2" label (span child text)
 *  - NOT match the old thin-line pattern (height <= 2px)
 *
 * A screenshot of the page view is saved so the operator can confirm the
 * visual looks like two stacked sheets with a grey gap and inset shadows.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, switchArea } from './_helpers'
import { join } from 'path'
import { mkdirSync } from 'fs'

const SCREENSHOT_DIR = '/private/tmp/claude-501/-Applications-agentic-starter-kit-main/0d9ea3a0-0a94-4273-82da-09071878651b/scratchpad'
const SCREENSHOT_PATH = join(SCREENSHOT_DIR, 'doc-page-break-visual.png')

test('PBV-1 — page-break renders as a gap band (not a thin line) with Page-2 label', async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Navigate to PlexiOffice → PlexiDocs (the current IA: Documents lives
    // inside the office segment, not the Desk sidebar).
    await switchArea(window, 'office')
    await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
    await window.locator('[data-testid="office-app-docs"]').click()
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({
      timeout: 10_000
    })

    // ── Step 1: inject enough content to overflow one page ──────────────────────
    // A Letter portrait page at 96dpi is 816×1056px; default margins are 1" each
    // side, giving a usable content height of ~864px. We need contentH > 864px
    // to trigger at least one break.
    //
    // Drive via window.__docEditor (the exposed TipTap instance) to avoid the
    // slowness of typing 40 paragraphs one keystroke at a time through the DOM.
    // This is an API-driven path, not a pointer gesture — see test harness notes.
    const injected = await window.evaluate(() => {
      const ed = (window as unknown as { __docEditor?: { commands: { setContent: (c: object) => void } } }).__docEditor
      if (!ed) return false

      // Build 60 paragraphs — well above the ~10 needed to overflow a page.
      const paragraphs = Array.from({ length: 60 }, (_, i) => ({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: `Paragraph ${i + 1}: The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.`
          }
        ]
      }))
      ed.commands.setContent({ type: 'doc', content: paragraphs })
      return true
    })

    expect(injected, 'window.__docEditor must be available to inject content').toBe(true)

    // Wait a tick for React to process the editor update.
    await window.waitForTimeout(400)

    // ── Step 2: switch to Page view ─────────────────────────────────────────────
    const pageBtn = window.locator('[data-testid="doc-pageview-btn"]')
    await expect(pageBtn).toBeVisible({ timeout: 5_000 })
    await pageBtn.click()

    // Canvas and sheet must appear.
    const canvas = window.locator('[data-testid="doc-page-canvas"]')
    const sheet = window.locator('[data-testid="doc-page"]')
    await expect(canvas).toBeVisible({ timeout: 6_000 })
    await expect(sheet).toBeVisible({ timeout: 4_000 })

    // ── Step 3: wait for at least one page-break element ────────────────────────
    // The ResizeObserver in PageSheet fires after the DOM settles. Give it
    // time to measure contentH and render the break divs.
    const breakLocator = window.locator('[data-testid="doc-page-break"]')
    await expect(breakLocator.first()).toBeVisible({ timeout: 8_000 })

    const breakCount = await breakLocator.count()
    expect(breakCount, 'at least one doc-page-break must exist').toBeGreaterThanOrEqual(1)

    // ── Step 4: assert the break is a gap band, not a thin line ─────────────────
    const firstBreak = breakLocator.first()

    // Height must be the 26px GAP constant.
    const breakHeight = await firstBreak.evaluate((el) => {
      const h = (el as HTMLElement).style.height
      // Parse the inline style; fall back to computed.
      const inline = Number.parseFloat(h)
      if (Number.isFinite(inline) && inline > 0) return inline
      return Number.parseFloat(window.getComputedStyle(el).height)
    })
    expect(breakHeight, `page-break height must be 26px (GAP); got ${breakHeight}px`).toBeCloseTo(26, 0)

    // Must NOT be a thin line (the old < 2px dashed rule).
    expect(breakHeight, 'page-break must not be a thin line (height <= 2)').toBeGreaterThan(2)

    // The break must span the full width: computed left = 0 and offsetWidth
    // should equal the parent sheet's clientWidth (Tailwind left-0 right-0
    // classes set these; we check computed style since inline style is empty).
    const breakSpansWidth = await firstBreak.evaluate((el) => {
      const computed = window.getComputedStyle(el)
      const left = Number.parseFloat(computed.left)
      const right = Number.parseFloat(computed.right)
      const parent = el.parentElement
      if (!parent) return { spans: false, reason: 'no parent' }
      const parentW = parent.clientWidth
      const elW = (el as HTMLElement).offsetWidth
      return { spans: elW >= parentW - 2, left, right, parentW, elW, reason: '' }
    })
    expect(
      breakSpansWidth.spans,
      `page-break must span full sheet width; elW=${breakSpansWidth.elW} parentW=${breakSpansWidth.parentW}`
    ).toBe(true)

    // ── Step 5: "Page 2" label is visible ──────────────────────────────────────
    const page2Label = firstBreak.locator('span').filter({ hasText: 'Page 2' })
    await expect(page2Label).toBeVisible({ timeout: 3_000 })
    const labelText = await page2Label.textContent()
    expect(labelText?.trim(), 'label must read "Page 2"').toBe('Page 2')

    // ── Step 6: shadow children exist (the two inset-shadow overlays) ───────────
    // Each break div has two child divs: top-shadow (bottom-edge of page above)
    // and bottom-shadow (top-edge of page below).
    const shadowDivCount = await firstBreak.locator('div').count()
    expect(shadowDivCount, 'break must have 2 shadow overlay divs').toBe(2)

    // ── Step 7: screenshot for visual confirmation ───────────────────────────────
    // Scroll the canvas so a page-break is roughly centred before screenshotting.
    await firstBreak.scrollIntoViewIfNeeded()
    await window.waitForTimeout(200)
    await canvas.screenshot({ path: SCREENSHOT_PATH })

    console.log(`[PBV-1] screenshot saved: ${SCREENSHOT_PATH}`)
    console.log(`[PBV-1] breakCount=${breakCount}, breakHeight=${breakHeight}px, label="${labelText?.trim()}"`)

    // ── Step 8: no uncaught console errors ──────────────────────────────────────
    // We do not intercept all console events in this test (would need to be wired
    // before launch), but confirm the page is not in a crashed/detached state.
    const isAttached = await window.evaluate(() => typeof document !== 'undefined')
    expect(isAttached, 'renderer must still be attached after page-view render').toBe(true)
  } finally {
    await dispose()
  }
})
