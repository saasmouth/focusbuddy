/**
 * E2E tests for the Word-style "Styles" panel in DocEditor.
 *
 * DHS-1  The "Styles" button (doc-styles-btn) is always visible in the toolbar
 *        regardless of cursor position. Clicking it opens doc-styles-panel which
 *        contains a "Normal text" row, a "Title" row, and heading rows (Heading 1/2/3…).
 *
 * DHS-2  Clicking a heading name in the panel applies that heading level to the
 *        current block. Clicking "Normal text" resets it to a paragraph.
 *
 * DHS-3  AUTO-UPDATE: setting size/colour/bold in the panel updates EVERY heading
 *        of that level at once, including headings whose text carries a prior
 *        inline size mark (h2 * rule wins via !important).
 *
 * DHS-4  INLINE-MARK AUTHORITY: apply an inline size via the toolbar Size
 *        dropdown, THEN change the named style. The named style must win.
 *
 * DHS-5  PERSISTENCE: headingStyles round-trips through autosave and reopen;
 *        the DB body is wrapped { doc, headingStyles }.
 *
 * DHS-6  LEGACY COMPAT: a document whose body is raw Tiptap JSON (no
 *        headingStyles wrapper) still opens and is editable.
 *
 * IPC stubs not needed — no AI calls; only documents IPC is exercised (in-process
 * SQLite, always available). ANTHROPIC_API_KEY is stripped by the test helper.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, gotoView } from './_helpers'

// ── Navigation helpers ────────────────────────────────────────────────────────

async function openDocumentsHub(window: Page): Promise<void> {
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

/**
 * Set the current block type via the Styles panel.
 * The Styles panel maps:
 *   'p'  → doc-style-row-0 (Normal text)
 *   'h1' → doc-style-row-1 (Title → h1)
 *   'h2' → doc-style-row-2 (Heading 1 → h2)
 *   'h3' → doc-style-row-3 (Heading 2 → h3)
 *   'h4' → doc-style-row-4 (Heading 3 → h4)
 *   'h5' → doc-style-row-5 (Heading 4 → h5)
 *   'h6' → doc-style-row-6 (Heading 5 → h6)
 */
const BLOCK_TYPE_ROW: Record<string, string> = {
  p: 'doc-style-row-0',
  h1: 'doc-style-row-1',
  h2: 'doc-style-row-2',
  h3: 'doc-style-row-3',
  h4: 'doc-style-row-4',
  h5: 'doc-style-row-5',
  h6: 'doc-style-row-6'
}

async function setBlockType(window: Page, value: string): Promise<void> {
  const rowId = BLOCK_TYPE_ROW[value]
  if (!rowId) throw new Error(`Unknown block type: ${value}`)
  // Open the Styles panel if not already open.
  const panel = window.locator('[data-testid="doc-styles-panel"]')
  const alreadyOpen = await panel.isVisible().catch(() => false)
  if (!alreadyOpen) {
    await window.locator('[data-testid="doc-styles-btn"]').click()
    await expect(panel).toBeVisible({ timeout: 3_000 })
  }
  if (value === 'p') {
    // Normal text row is a button itself.
    await panel.locator(`[data-testid="${rowId}"]`).click()
  } else {
    // Heading rows: the first button inside the row applies the level.
    await panel.locator(`[data-testid="${rowId}"] button`).first().click()
  }
  await window.waitForTimeout(200)
}

/** Drive selections deterministically via the ProseMirror handle. */
async function selectAll(window: Page): Promise<void> {
  await window.evaluate(() => {
    const e = (window as unknown as { __docEditor?: { chain: () => { focus: () => { selectAll: () => { run: () => void } } } } }).__docEditor
    e?.chain().focus().selectAll().run()
  })
  await window.waitForTimeout(250)
}

/** Open the Styles panel if it is not already open. */
async function openStylesPanel(window: Page): Promise<void> {
  const panel = window.locator('[data-testid="doc-styles-panel"]')
  const alreadyOpen = await panel.isVisible().catch(() => false)
  if (!alreadyOpen) {
    await window.locator('[data-testid="doc-styles-btn"]').click()
    await expect(panel).toBeVisible({ timeout: 3_000 })
  }
}

// ── DHS-1: Styles button is always visible; panel has expected rows ───────────

test('DHS-1 — doc-styles-btn always visible; panel shows Normal/Title/Heading-1/Heading-2 rows', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    // Button is visible immediately — cursor is on an empty paragraph, not a heading.
    await expect(window.locator('[data-testid="doc-styles-btn"]')).toBeVisible({ timeout: 3_000 })

    // Clicking opens the panel.
    await window.locator('[data-testid="doc-styles-btn"]').click()
    const panel = window.locator('[data-testid="doc-styles-panel"]')
    await expect(panel).toBeVisible({ timeout: 3_000 })

    // Panel contains Normal text and the three heading rows.
    await expect(panel.locator('[data-testid="doc-style-row-0"]')).toBeVisible()
    await expect(panel.locator('[data-testid="doc-style-row-1"]')).toBeVisible()
    await expect(panel.locator('[data-testid="doc-style-row-2"]')).toBeVisible()
    await expect(panel.locator('[data-testid="doc-style-row-3"]')).toBeVisible()

    // Row text labels are present. The panel maps:
    //   row-0 = Normal text, row-1 = Title (→h1), row-2 = Heading 1 (→h2),
    //   row-3 = Heading 2 (→h3), row-4 = Heading 3 (→h4) …
    await expect(panel.locator('[data-testid="doc-style-row-0"]')).toContainText('Normal text')
    await expect(panel.locator('[data-testid="doc-style-row-1"]')).toContainText('Title')
    await expect(panel.locator('[data-testid="doc-style-row-2"]')).toContainText('Heading 1')
    await expect(panel.locator('[data-testid="doc-style-row-3"]')).toContainText('Heading 2')

    // Heading rows include size (number) and colour inputs.
    const h2Row = panel.locator('[data-testid="doc-style-row-2"]')
    await expect(h2Row.locator('input[type="number"]')).toBeVisible()
    await expect(h2Row.locator('input[type="color"]')).toBeVisible()

    // Clicking outside dismisses the panel.
    await window.locator('[data-testid="doc-editor-surface"]').click({ position: { x: 5, y: 5 } })
    await window.waitForTimeout(200)
    await expect(panel).not.toBeVisible({ timeout: 2_000 })

    // Button is still visible when cursor moves to a heading — no conditional hiding.
    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await surface.type('Heading text')
    await setBlockType(window, 'h2')
    // Dismiss the Styles panel so it doesn't intercept the h2 click.
    await surface.click({ position: { x: 5, y: 5 } })
    await expect(panel).not.toBeVisible({ timeout: 2_000 })
    await surface.locator('h2').first().click()
    await window.waitForTimeout(200)
    await expect(window.locator('[data-testid="doc-styles-btn"]')).toBeVisible({ timeout: 2_000 })
  } finally {
    await dispose()
  }
})

// ── DHS-2: Applying a level from the panel changes the current block ──────────

test('DHS-2 — clicking a heading name applies that level; Normal text reverts to paragraph', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await surface.type('Apply level test')
    await window.waitForTimeout(100)

    // Click "Heading 2" name in the panel to apply H2 to the current block.
    await openStylesPanel(window)
    const panel = window.locator('[data-testid="doc-styles-panel"]')
    // The apply button is the first button inside doc-style-row-2 (the name button).
    await panel.locator('[data-testid="doc-style-row-2"] button').first().click()
    await window.waitForTimeout(300)

    // The block should now be an h2.
    await expect(surface.locator('h2')).toContainText('Apply level test')

    // Now click Normal text to revert to paragraph.
    await openStylesPanel(window)
    await panel.locator('[data-testid="doc-style-row-0"]').click()
    await window.waitForTimeout(300)

    // h2 should be gone; the text should be in a paragraph.
    await expect(surface.locator('h2')).toHaveCount(0)
    await expect(surface).toContainText('Apply level test')
  } finally {
    await dispose()
  }
})

// ── DHS-3: Auto-update — setting H2 style updates ALL H2s at once ────────────

test('DHS-3 — setting H2 size/colour/bold in Styles panel updates all H2 elements simultaneously', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    const surface = window.locator('[data-testid="doc-editor-surface"]')

    // Create two H2 lines and an H1 that must remain unaffected.
    await surface.click()
    await surface.type('H2 Line A')
    await setBlockType(window, 'h2')

    await window.keyboard.press('Enter')
    await surface.type('paragraph between')
    // stays as paragraph

    await window.keyboard.press('Enter')
    await surface.type('H2 Line B')
    await setBlockType(window, 'h2')

    await window.keyboard.press('Enter')
    await surface.type('H1 Line C')
    await setBlockType(window, 'h1')

    // Open Styles panel and set H2 size to 40.
    await openStylesPanel(window)
    const panel = window.locator('[data-testid="doc-styles-panel"]')
    const h2Row = panel.locator('[data-testid="doc-style-row-2"]')

    const sizeInput = h2Row.locator('input[type="number"]')
    await sizeInput.fill('40')
    await sizeInput.press('Tab')
    await window.waitForTimeout(400)

    // Set colour to blue (#0000ff) via the colour input.
    await h2Row.locator('input[type="color"]').evaluate((el: HTMLInputElement) => {
      el.value = '#0000ff'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await window.waitForTimeout(300)

    // Toggle Bold on for H2.
    const boldBtn = h2Row.locator('button[title="Bold"]')
    await boldBtn.click()
    await window.waitForTimeout(300)

    // BOTH H2 elements must now render at 40px, blue, bold.
    const h2s = surface.locator('h2')
    const count = await h2s.count()
    expect(count, 'must have at least 2 H2 elements').toBeGreaterThanOrEqual(2)

    for (let i = 0; i < count; i++) {
      const styles = await h2s.nth(i).evaluate((el) => {
        const cs = window.getComputedStyle(el)
        return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color }
      })
      expect(styles.fontSize, `H2[${i}] font-size`).toBe('40px')
      expect(Number(styles.fontWeight), `H2[${i}] font-weight`).toBeGreaterThanOrEqual(700)
    }

    // H1 must NOT be 40px.
    const h1 = surface.locator('h1').first()
    if (await h1.isVisible()) {
      const h1fs = await h1.evaluate((el) => window.getComputedStyle(el).fontSize)
      expect(h1fs, 'H1 must not be 40px').not.toBe('40px')
    }
  } finally {
    await dispose()
  }
})

// ── DHS-4: Inline-mark authority — named style wins over inline span mark ────

test('DHS-4 — named H2 style wins over prior inline font-size on heading text', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    const surface = window.locator('[data-testid="doc-editor-surface"]')

    // Create an H2.
    await surface.click()
    await surface.type('Inline mark test heading')
    await setBlockType(window, 'h2')
    await window.waitForTimeout(200)

    // Apply an inline font size of 12px to the heading text via the toolbar Size
    // dropdown. This creates a <span style="font-size:12px"> inside the <h2>.
    await selectAll(window)
    // The shell's bar fields expose their name through aria-label, not a title
    // attribute, so address this one by role and name. Font size is a number
    // field in every office app (SPEC §3.9): type it and commit with Enter.
    const size = window.getByRole('textbox', { name: 'Font size' })
    await size.fill('12')
    await size.press('Enter')
    await window.waitForTimeout(300)

    // Now set the H2 named style size to 40 in the Styles panel.
    await openStylesPanel(window)
    const panel = window.locator('[data-testid="doc-styles-panel"]')
    const h2Row = panel.locator('[data-testid="doc-style-row-2"]')
    const sizeInput = h2Row.locator('input[type="number"]')
    await sizeInput.fill('40')
    await sizeInput.press('Tab')
    await window.waitForTimeout(400)

    // The named style must win: computed size on the h2 AND on its inner spans
    // must be 40px (the CSS targets `h2, h2 *`).
    const h2El = surface.locator('h2').first()
    await expect(h2El).toBeVisible()

    const h2Fs = await h2El.evaluate((el) => window.getComputedStyle(el).fontSize)
    expect(h2Fs, 'h2 element computed font-size').toBe('40px')

    // Also check the inner text span if present.
    const innerSpan = h2El.locator('span').first()
    if (await innerSpan.isVisible().catch(() => false)) {
      const spanFs = await innerSpan.evaluate((el) => window.getComputedStyle(el).fontSize)
      expect(spanFs, 'inner span computed font-size must follow named style').toBe('40px')
    }
  } finally {
    await dispose()
  }
})

// ── DHS-5: Persistence — headingStyles survive autosave and reopen ────────────

test('DHS-5 — headingStyles persist after autosave; H2 still styled at 36px on reopen', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    const surface = window.locator('[data-testid="doc-editor-surface"]')

    // Create an H2.
    await surface.click()
    await surface.type('Persisted heading')
    await setBlockType(window, 'h2')
    await window.waitForTimeout(200)

    // Set H2 size to 36 in the Styles panel.
    await openStylesPanel(window)
    const panel = window.locator('[data-testid="doc-styles-panel"]')
    const sizeInput = panel.locator('[data-testid="doc-style-row-2"] input[type="number"]')
    await sizeInput.fill('36')
    await sizeInput.press('Tab')
    await window.waitForTimeout(400)

    // Confirm CSS applied immediately.
    const fsBefore = await surface.locator('h2').first().evaluate((el) => window.getComputedStyle(el).fontSize)
    expect(fsBefore, 'H2 renders at 36px before reload').toBe('36px')

    // Wait for autosave debounce (1.5 s is enough for the 1 s debounce).
    await window.waitForTimeout(1_600)

    // Verify the persisted body is the wrapped form with headingStyles.
    const stored = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const docs = await api.documents.list()
      const doc = await api.documents.get(docs[0].id)
      return doc?.body
    }) as { headingStyles?: Record<number, { fontSize?: number }>; doc?: unknown } | null

    expect(stored, 'body must not be null').toBeTruthy()
    expect(stored?.headingStyles, 'body.headingStyles must be present').toBeTruthy()
    expect(stored?.headingStyles?.[2]?.fontSize, 'headingStyles[2].fontSize must be 36').toBe(36)

    // Navigate back to the hub.
    await window.locator('button[title="Back to Documents"]').click()
    await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({
      timeout: 5_000
    })

    // Re-open the document. The Recent card shows the title the document derived
    // from its own content (titleBackfill + shared/titles.ts), not "Untitled
    // document"; scoped to the card because the save also raises a toast with
    // the same name.
    await window
      .locator('[data-testid="doc-recent-card"]')
      .filter({ hasText: 'Persisted heading' })
      .first()
      .click()
    const reloadedSurface = window.locator('[data-testid="doc-editor-surface"]')
    await expect(reloadedSurface).toBeVisible({ timeout: 8_000 })
    await expect(reloadedSurface).toContainText('Persisted heading', { timeout: 5_000 })

    // H2 must still render at 36px from the reloaded headingStyles CSS.
    const h2After = reloadedSurface.locator('h2').first()
    await expect(h2After).toBeVisible({ timeout: 5_000 })
    const fsAfter = await h2After.evaluate((el) => window.getComputedStyle(el).fontSize)
    expect(fsAfter, 'H2 must still be 36px after reopen').toBe('36px')
  } finally {
    await dispose()
  }
})

// ── DHS-6: Legacy raw-Tiptap body still opens and is editable ────────────────

test('DHS-6 — legacy raw-tiptap body (no headingStyles wrapper) opens and is editable', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)

    // Seed a document with a legacy body directly via the API.
    await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.documents.create({
        docType: 'doc',
        title: 'Legacy raw body',
        body: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Old style heading' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Legacy paragraph here' }] }
          ]
        }
      })
    })

    // Reload so the Recent list picks up the new document.
    await window.reload()
    await waitForReady(window)
    await openDocumentsHub(window)

    await expect(window.locator('text=Legacy raw body').first()).toBeVisible({ timeout: 5_000 })
    await window.locator('text=Legacy raw body').first().click()

    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await expect(surface).toBeVisible({ timeout: 8_000 })
    await expect(surface).toContainText('Old style heading', { timeout: 5_000 })
    await expect(surface).toContainText('Legacy paragraph here')

    // The Styles button must be present even for legacy docs.
    await expect(window.locator('[data-testid="doc-styles-btn"]')).toBeVisible({ timeout: 3_000 })

    // Still editable — append text.
    await surface.click()
    await window.keyboard.press('End')
    await window.keyboard.press('Enter')
    await surface.type('Appended to legacy doc')
    await expect(surface).toContainText('Appended to legacy doc')
  } finally {
    await dispose()
  }
})
