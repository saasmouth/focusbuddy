/**
 * E2E tests for per-document page setup in DocEditor.
 *
 * DPS-1  PAGE VIEW + CONTROLS: doc-layout-toggle toggles Continuous/Page.
 *        In Page view: doc-page appears, controls doc-orientation-btn,
 *        doc-paper-btn, doc-margins-btn are visible.
 *
 * DPS-2  ORIENTATION + SIZE are per-document and persist.
 *        Toggle orientation to Landscape + paper to A4.
 *        - data-orientation attribute on doc-page flips to "landscape".
 *        - Saved body.page reflects { size:'a4', orientation:'landscape' }.
 *        - A SECOND new doc opens at the default (letter/portrait): the first
 *          doc's state did not leak.
 *
 * DPS-3  MARGINS: doc-margins-btn opens doc-margins-menu with the four presets
 *        and custom inputs. Narrow preset sets margin = 0.5 all sides. Custom
 *        top = 1.5 is reflected in the saved body and in the sheet's paddingTop.
 *
 * DPS-4  WYSIWYG EXPORT WIRING: source-attest that exportDocx / exportPdf
 *        receive the page argument through the office.* IPC call
 *        (verified by stubbing at ipcMain level and confirming page in the
 *        call, and by checking the unit-attested source chain compiles).
 *
 * DPS-5  NO REGRESSIONS: heading styles flow still works after a page-setup
 *        change (exercises the metaRef so neither path clobbers the other).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, gotoView, selectBarTab } from './_helpers'

// ── Navigation helpers ────────────────────────────────────────────────────────

async function openDocumentsHub(window: Page): Promise<void> {
  // .first() because the home-dashboard card may render a second "Documents"
  // shortcut button alongside the sidebar nav entry.
  await gotoView(window, 'goDocuments')
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({
    timeout: 8_000
  })
}

async function startBlankDoc(window: Page): Promise<void> {
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Document' }).first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({
    timeout: 8_000
  })
}

/** Enter Page view, wait for doc-page to appear. */
async function enterPageView(window: Page): Promise<void> {
  // Only click if not already in page view (idempotent).
  const alreadyVisible = await window.locator('[data-testid="doc-page"]').isVisible().catch(() => false)
  if (!alreadyVisible) {
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-pageview-btn"]').click()
    await expect(window.locator('[data-testid="doc-page"]')).toBeVisible({ timeout: 4_000 })
  }
}

/** Wait for autosave debounce and read the saved document body from the API. */
async function savedBody(window: Page): Promise<Record<string, unknown>> {
  await window.waitForTimeout(1_600)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const doc = await api.documents.get(docs[0].id)
    return doc?.body as Record<string, unknown>
  })
}

// ── DPS-1: Page view + controls ──────────────────────────────────────────────

test('DPS-1 — doc-layout-toggle Continuous/Page; Page view reveals sheet and controls', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    // Default is Continuous — doc-page must be absent.
    await expect(window.locator('[data-testid="doc-page"]')).not.toBeVisible({ timeout: 3_000 })

    // The toggle group is present.
    await selectBarTab(window, 'doc-toolbar', 'layout')
    const toggle = window.locator('[data-testid="doc-layout-toggle"]')
    await expect(toggle).toBeVisible({ timeout: 3_000 })
    // Both buttons are inside the toggle.
    await expect(toggle.locator('button', { hasText: 'Continuous' })).toBeVisible()
    await expect(toggle.locator('button', { hasText: 'Page' })).toBeVisible()

    // Click Page.
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-pageview-btn"]').click()
    const sheet = window.locator('[data-testid="doc-page"]')
    await expect(sheet).toBeVisible({ timeout: 4_000 })

    // Page controls appear once page view is active.
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await expect(window.locator('[data-testid="doc-orientation-btn"]')).toBeVisible({ timeout: 3_000 })
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await expect(window.locator('[data-testid="doc-paper-btn"]')).toBeVisible({ timeout: 3_000 })
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await expect(window.locator('[data-testid="doc-margins-btn"]')).toBeVisible({ timeout: 3_000 })

    // Return to Continuous — sheet disappears and controls disappear.
    await toggle.locator('button', { hasText: 'Continuous' }).click()
    await expect(sheet).not.toBeVisible({ timeout: 3_000 })
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await expect(window.locator('[data-testid="doc-orientation-btn"]')).not.toBeVisible({ timeout: 2_000 })
  } finally {
    await dispose()
  }
})

// ── DPS-2: Orientation + size are per-document; no localStorage leak ──────────

test('DPS-2 — orientation+size persist on body.page; second doc opens at default (no global leak)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    // Type something to ensure the doc has a body ready to save.
    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await surface.type('Page setup doc')
    await window.waitForTimeout(200)

    await enterPageView(window)

    const sheet = window.locator('[data-testid="doc-page"]')

    // Default is portrait.
    await expect(sheet).toHaveAttribute('data-orientation', 'portrait')

    // Toggle to Landscape.
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-orientation-btn"]').click()
    await expect(sheet).toHaveAttribute('data-orientation', 'landscape', { timeout: 3_000 })

    // Toggle paper to A4 (it starts as Letter; one click toggles to A4).
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-paper-btn"]').click()
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await expect(window.locator('[data-testid="doc-paper-btn"]')).toContainText('A4', { timeout: 3_000 })

    // Confirm saved body carries the page setup.
    const body = await savedBody(window)
    const page = body.page as Record<string, unknown> | undefined
    expect(page, 'body.page must be present').toBeTruthy()
    expect(page?.size, 'size must be a4').toBe('a4')
    expect(page?.orientation, 'orientation must be landscape').toBe('landscape')

    // ── PER-DOCUMENT ISOLATION: open a second doc in the same session ──────────
    // Navigate back to Documents hub.
    await window.locator('button[title="Back to Documents"]').click()
    await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 5_000 })

    // Start a brand-new blank doc.
    await startBlankDoc(window)

    // Enter page view for the second doc.
    await enterPageView(window)

    const sheet2 = window.locator('[data-testid="doc-page"]')
    // Must open at portrait (default) — not landscape from doc 1.
    await expect(sheet2).toHaveAttribute('data-orientation', 'portrait', { timeout: 3_000 })
    // Paper must be Letter (default) — not A4 from doc 1.
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await expect(window.locator('[data-testid="doc-paper-btn"]')).toContainText('Letter', { timeout: 3_000 })
  } finally {
    await dispose()
  }
})

// ── DPS-3: Margins — preset + custom input + visual reflection ────────────────

test('DPS-3 — margins: preset Narrow sets 0.5 all sides; custom top=1.5 updates body + paddingTop (144px)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await surface.type('Margin test doc')
    await window.waitForTimeout(200)

    await enterPageView(window)

    // Open the margins menu.
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-margins-btn"]').click()
    const menu = window.locator('[data-testid="doc-margins-menu"]')
    await expect(menu).toBeVisible({ timeout: 3_000 })

    // All four presets must be present.
    await expect(menu.locator('[data-testid="doc-margin-preset-normal"]')).toBeVisible()
    await expect(menu.locator('[data-testid="doc-margin-preset-narrow"]')).toBeVisible()
    await expect(menu.locator('[data-testid="doc-margin-preset-moderate"]')).toBeVisible()
    await expect(menu.locator('[data-testid="doc-margin-preset-wide"]')).toBeVisible()

    // Custom inputs are present.
    await expect(menu.locator('[data-testid="doc-margin-top"]')).toBeVisible()
    await expect(menu.locator('[data-testid="doc-margin-right"]')).toBeVisible()
    await expect(menu.locator('[data-testid="doc-margin-bottom"]')).toBeVisible()
    await expect(menu.locator('[data-testid="doc-margin-left"]')).toBeVisible()

    // Apply Narrow preset (0.5" all sides).
    await menu.locator('[data-testid="doc-margin-preset-narrow"]').click()
    // Picking a preset applies it and leaves the panel open, so close it
    // explicitly. The margins form is a ShellPanel on the office shell, which
    // owns its own close control — it is no longer a popover over a
    // `fixed inset-0 z-30` scrim, which is what this used to click.
    await window.waitForTimeout(300)
    await window.locator('[data-testid="doc-panel-margins-close"]').click()
    await expect(menu).not.toBeVisible({ timeout: 3_000 })

    // Verify saved body has the narrow preset margins.
    const body1 = await savedBody(window)
    const margin1 = (body1.page as Record<string, unknown>)?.margin as Record<string, number> | undefined
    expect(margin1?.top, 'Narrow preset top').toBe(0.5)
    expect(margin1?.right, 'Narrow preset right').toBe(0.5)
    expect(margin1?.bottom, 'Narrow preset bottom').toBe(0.5)
    expect(margin1?.left, 'Narrow preset left').toBe(0.5)

    // ── Custom margin: set top to 1.5" and verify visual + persistence ─────────
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-margins-btn"]').click()
    await expect(menu).toBeVisible({ timeout: 3_000 })

    const topInput = menu.locator('[data-testid="doc-margin-top"]')
    await topInput.fill('1.5')
    // Blur to commit — the onChange fires on input event, so fire blur to ensure.
    await topInput.press('Tab')
    await window.waitForTimeout(400)

    // Close the panel by its own control (same reason as above).
    await window.locator('[data-testid="doc-panel-margins-close"]').click()
    await expect(menu).not.toBeVisible({ timeout: 3_000 })

    // Saved body.page.margin.top must be 1.5.
    const body2 = await savedBody(window)
    const margin2 = (body2.page as Record<string, unknown>)?.margin as Record<string, number> | undefined
    expect(margin2?.top, 'custom top margin persisted').toBe(1.5)

    // Visual: the page content wrapper's paddingTop must reflect 1.5 * 96 = 144px.
    // (The margin is applied as padding on the flowing-content wrapper, not on the
    // doc-page frame, which only sizes the paper.)
    const sheet = window.locator('[data-testid="doc-page-content"]')
    await expect(sheet).toBeVisible()
    const paddingTopPx = await sheet.evaluate((el) => {
      return getComputedStyle(el).paddingTop
    })
    // Accept either the inline-style value or the computed value.
    const inlineTop = await sheet.evaluate((el) => (el as HTMLElement).style.paddingTop)
    // Either computed or inline must indicate ~144px (allowing 1px rounding).
    const px = Number.parseFloat(paddingTopPx.replace('px', ''))
    const inlinePx = Number.parseFloat(inlineTop.replace('px', ''))
    const effectivePx = Number.isFinite(inlinePx) && inlinePx > 0 ? inlinePx : px
    expect(effectivePx, `paddingTop should be 144px for 1.5in; got computed=${paddingTopPx} inline=${inlineTop}`).toBeCloseTo(144, 0)
  } finally {
    await dispose()
  }
})

// ── DPS-4: WYSIWYG export wiring — page flows into office.* IPC call ─────────

test('DPS-4 — export wiring: exportDocx and exportPdf receive the page setup in the IPC call', async () => {
  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await surface.type('Export wiring test')
    await window.waitForTimeout(200)

    await enterPageView(window)

    // Set landscape + A4 so we can assert the non-default page is forwarded.
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-orientation-btn"]').click()
    await expect(window.locator('[data-testid="doc-page"]')).toHaveAttribute('data-orientation', 'landscape', { timeout: 3_000 })
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-paper-btn"]').click()
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await expect(window.locator('[data-testid="doc-paper-btn"]')).toContainText('A4', { timeout: 3_000 })
    await window.waitForTimeout(300)

    // Install spy stubs for exportDocx and exportPdf that capture the page
    // argument into a process-global so we can read it back after triggering
    // the export. We must install the stubs BEFORE clicking export, but we
    // cannot use app.evaluate with a Promise return because app.evaluate
    // serializes the return value immediately — a pending Promise becomes
    // undefined before the handler is ever invoked (deadlock). Instead, store
    // the captured value in a process global and read it back afterward.
    await app.evaluate(({ ipcMain }) => {
      // @ts-ignore — attaching to global for test spy
      global.__dps4Docx = undefined
      // @ts-ignore
      global.__dps4Pdf = undefined
      ipcMain.removeHandler('office:exportDocx')
      ipcMain.removeHandler('office:exportPdf')
      ipcMain.handle('office:exportDocx', (_event: unknown, input: { page?: unknown }) => {
        // @ts-ignore
        global.__dps4Docx = input.page
        return { ok: true, path: '/tmp/test.docx' }
      })
      ipcMain.handle('office:exportPdf', (_event: unknown, input: { page?: unknown }) => {
        // @ts-ignore
        global.__dps4Pdf = input.page
        return { ok: true, path: '/tmp/test.pdf' }
      })
    })

    // Trigger exportDocx via the toolbar Office menu.
    await window.getByRole('button', { name: /Open or export Office files/i }).click()
    await expect(window.locator('text=Download Word (.docx)…')).toBeVisible({ timeout: 3_000 })
    await window.locator('text=Download Word (.docx)…').click()

    // Wait for the status message to confirm the IPC completed.
    await expect(window.locator('[data-testid="doc-office-status"]')).toContainText('test.docx', {
      timeout: 10_000
    })

    // Read back the captured docx page argument.
    const docxPage = await app.evaluate(() => (global as Record<string, unknown>).__dps4Docx) as Record<string, unknown> | undefined
    expect(docxPage, 'page must be forwarded to exportDocx').toBeTruthy()
    expect(docxPage?.size, 'exportDocx page.size').toBe('a4')
    expect(docxPage?.orientation, 'exportDocx page.orientation').toBe('landscape')

    // Dismiss the status bar.
    const statusDismiss = window.locator('[data-testid="doc-office-status"] button')
    if (await statusDismiss.isVisible().catch(() => false)) {
      await statusDismiss.click()
    }

    // Trigger exportPdf.
    await window.getByRole('button', { name: /Open or export Office files/i }).click()
    await expect(window.locator('text=Download PDF…')).toBeVisible({ timeout: 3_000 })
    await window.locator('text=Download PDF…').click()

    await expect(window.locator('[data-testid="doc-office-status"]')).toContainText('test.pdf', {
      timeout: 10_000
    })

    const pdfPage = await app.evaluate(() => (global as Record<string, unknown>).__dps4Pdf) as Record<string, unknown> | undefined
    expect(pdfPage, 'page must be forwarded to exportPdf').toBeTruthy()
    expect(pdfPage?.size, 'exportPdf page.size').toBe('a4')
    expect(pdfPage?.orientation, 'exportPdf page.orientation').toBe('landscape')
  } finally {
    await dispose()
  }
})

// ── DPS-5: No regression — heading styles still persist after a page-setup change

test('DPS-5 — heading styles survive a page-setup change (metaRef integrity: neither path clobbers the other)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await surface.type('Heading style + page test')
    await window.waitForTimeout(100)

    // Apply H2 via styles panel.
    await window.locator('[data-testid="doc-styles-btn"]').click()
    await expect(window.locator('[data-testid="doc-styles-panel"]')).toBeVisible({ timeout: 3_000 })
    await window.locator('[data-testid="doc-styles-panel"] [data-testid="doc-style-row-2"] button').first().click()
    await window.waitForTimeout(200)
    await surface.click({ position: { x: 5, y: 5 } })
    await expect(window.locator('[data-testid="doc-styles-panel"]')).not.toBeVisible({ timeout: 2_000 })

    // Set H2 custom size 36.
    await window.locator('[data-testid="doc-styles-btn"]').click()
    await expect(window.locator('[data-testid="doc-styles-panel"]')).toBeVisible({ timeout: 3_000 })
    const sizeInput = window.locator('[data-testid="doc-styles-panel"] [data-testid="doc-style-row-2"] input[type="number"]')
    await sizeInput.fill('36')
    await sizeInput.press('Tab')
    await window.waitForTimeout(400)
    await surface.click({ position: { x: 5, y: 5 } })
    await expect(window.locator('[data-testid="doc-styles-panel"]')).not.toBeVisible({ timeout: 2_000 })

    // Now change the page setup (orientation) — this calls updatePageSetup
    // which reads metaRef.current.headingStyles.
    await enterPageView(window)
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-orientation-btn"]').click()
    await expect(window.locator('[data-testid="doc-page"]')).toHaveAttribute('data-orientation', 'landscape', { timeout: 3_000 })

    // Wait for autosave.
    await window.waitForTimeout(1_600)

    // Verify saved body has BOTH headingStyles and page.
    const body = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const docs = await api.documents.list()
      const doc = await api.documents.get(docs[0].id)
      return doc?.body as Record<string, unknown>
    })

    const hs = body.headingStyles as Record<number, Record<string, unknown>> | undefined
    const page = body.page as Record<string, unknown> | undefined

    expect(hs, 'headingStyles must survive page-setup change').toBeTruthy()
    expect(hs?.[2]?.fontSize, 'headingStyles[2].fontSize must still be 36').toBe(36)
    expect(page?.orientation, 'page.orientation must be landscape').toBe('landscape')

    // Back at the editor, H2 must still render at 36px (heading CSS not clobbered).
    const h2El = surface.locator('h2').first()
    await expect(h2El).toBeVisible()
    const h2Fs = await h2El.evaluate((el) => window.getComputedStyle(el).fontSize)
    expect(h2Fs, 'H2 must still render at 36px after page-setup change').toBe('36px')

    // Type more text after the heading and confirm styles do not revert
    // (exercises the new meta ref flow under subsequent typing / onUpdate).
    await surface.click()
    await window.keyboard.press('End')
    await window.keyboard.press('Enter')
    await surface.type('Post-change paragraph')
    await window.waitForTimeout(600)

    // H2 still 36px.
    const h2FsAfter = await surface.locator('h2').first().evaluate((el) => window.getComputedStyle(el).fontSize)
    expect(h2FsAfter, 'H2 must remain 36px after subsequent typing').toBe('36px')
  } finally {
    await dispose()
  }
})
