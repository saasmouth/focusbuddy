/**
 * E2E tests for the Documents feature (doc / sheet / slides).
 *
 * Covers:
 *  1. App boots without console errors
 *  2. Sidebar "Documents" entry exists and opens the hub
 *  3. Hub shows Create-with-AI panel, three type chips, and "Or start blank"
 *  4. Start blank → Document: edit, back, confirm in Recent, re-open persisted
 *  5. Start blank → Spreadsheet: formula eval (SUM, multiply, #ERR)
 *  6. Start blank → Slides: rail, add slide, Present mode, keyboard nav + Esc
 *  7. Navigate away (Home/Calendar) and back — no errors, Recent intact
 *  8. No regressions: existing nav items still work
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// ── Helpers ──────────────────────────────────────────────────────────────────

// The object-based IA no longer has literal sidebar buttons for these
// destinations; navigation goes through the view store (same approach as
// documentTrash.spec.ts).
async function goView(
  window: import('@playwright/test').Page,
  fn: 'goHome' | 'goCalendar' | 'goVault' | 'goDocuments'
): Promise<void> {
  await window.evaluate((f) => {
    const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
    w.__fbView?.getState()[f]()
  }, fn)
  await window.waitForTimeout(300)
}

async function openDocumentsHub(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

/**
 * Click the blank-start button for a given type.
 * The "Or start blank:" span and its sibling buttons live inside a flex row.
 * We locate the span, step up to its parent <div>, then pick the right button.
 */
async function clickStartBlank(
  window: import('@playwright/test').Page,
  type: 'Document' | 'Spreadsheet' | 'Slides'
): Promise<void> {
  // The "Or start blank:" text is a <span> whose parent div contains the three type buttons.
  const blankRowContainer = window.locator('text=Or start blank:').locator('..')
  await blankRowContainer.locator('button', { hasText: type }).first().click()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('Step 1-3 — app boots clean, sidebar entry, hub renders Create-with-AI + chips + start-blank', async () => {
  const { window, dispose } = await launchApp()
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  try {
    await waitForReady(window)

    // Step 2: open the hub (via the view store — the IA has no literal
    // "Documents" sidebar button any more)
    await openDocumentsHub(window)

    // Step 3: Create-with-AI panel
    await expect(window.getByPlaceholder(/Describe the/i)).toBeVisible()
    await expect(window.getByRole('button', { name: /Create with AI/i })).toBeVisible()

    // Three type chips (their button texts contain icon glyph text + label + blurb text —
    // confirmed from DOM probe: "descriptionDocumentWriteups, briefs, proposals").
    // Match by partial label presence.
    await expect(window.locator('button', { hasText: /Writeups, briefs/i }).first()).toBeVisible()
    await expect(window.locator('button', { hasText: /Plans, budgets/i }).first()).toBeVisible()
    await expect(window.locator('button', { hasText: /Decks and presentations/i }).first()).toBeVisible()

    // "Or start blank:" label
    await expect(window.locator('text=Or start blank:')).toBeVisible()

    // Step 1: no real console errors
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('net::ERR_') &&
        !e.includes('Failed to load resource') &&
        !e.includes('WebSocket')
    )
    expect(realErrors, `Unexpected console errors: ${realErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await dispose()
  }
})

test('Step 4 — blank Document: edit text, back to hub, Recent shows its derived title, re-open persists text', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await clickStartBlank(window, 'Document')

    // Should be in the doc editor — back button + "Document" label in header
    await expect(window.locator('button[title="Back to Documents"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('span', { hasText: 'Document' }).last()).toBeVisible()

    // TipTap renders a contenteditable div
    const editor = window.locator('[contenteditable="true"]').first()
    await editor.waitFor({ state: 'visible', timeout: 5_000 })
    await editor.click()
    await editor.type('Hello autosave world')
    await expect(editor).toContainText('Hello autosave world')

    // Wait for autosave debounce (600 ms) + buffer
    await window.waitForTimeout(1_200)

    // Back to hub
    await window.locator('button[title="Back to Documents"]').click()
    await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 5_000 })

    // The Recent card carries the title the document NAMED ITSELF. A blank doc
    // is created as "Untitled document", but titleBackfill derives a real name
    // from the content on the way out (shared/titles.ts takes the heading or
    // the first real line), so by the time the hub renders, the card reads the
    // text that was typed. Asserting the derived title is the stronger check:
    // it proves the naming ran AND that the document reached Recent.
    //
    // Scoped to the card, because the save also raises a toast with the same
    // name — `text=` alone would match either, and matching the toast would
    // then click the wrong thing.
    const card = window.locator('[data-testid="doc-recent-card"]').filter({ hasText: 'Hello autosave world' })
    await expect(card.first()).toBeVisible({ timeout: 5_000 })

    // Re-open it by clicking the recent card
    await card.first().click()
    const editorAfter = window.locator('[contenteditable="true"]').first()
    await editorAfter.waitFor({ state: 'visible', timeout: 5_000 })
    await expect(editorAfter).toContainText('Hello autosave world', { timeout: 5_000 })
  } finally {
    await dispose()
  }
})

test('Step 5 — blank Spreadsheet: SUM formula, multiply, #DIV/0! for division by zero', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await clickStartBlank(window, 'Spreadsheet')

    // Formula bar confirms we're in the sheet editor
    await expect(window.locator('input[placeholder*="Select a cell"]')).toBeVisible({ timeout: 5_000 })

    // Current sheet model: cells are divs (data-testid cell-<r>-<c>); editing
    // mounts a floating input inside the cell. A=col0, B=col1, C=col2; rows
    // 0-indexed (A1 = cell-0-0).
    async function setCell(r: number, c: number, text: string): Promise<void> {
      const td = window.getByTestId(`cell-${r}-${c}`)
      await td.dblclick()
      const input = td.locator('input')
      await input.fill(text)
      await window.keyboard.press('Enter')
      await window.waitForTimeout(80)
    }
    const display = (r: number, c: number): Promise<string> =>
      window.getByTestId(`cell-${r}-${c}`).innerText().then((t) => t.trim())

    await setCell(0, 0, '10') // A1
    await setCell(1, 0, '20') // A2
    await setCell(2, 0, '=SUM(A1:A2)') // A3
    expect(await display(2, 0), 'A3 =SUM(A1:A2)').toBe('30')

    await setCell(0, 1, '=A1*3') // B1
    expect(await display(0, 1), 'B1 =A1*3').toBe('30')

    // Division by zero is a TYPED error, not the generic marker: sheetFormula
    // surfaces the error a spreadsheet user expects (#DIV/0!, #N/A, #VALUE!,
    // #NAME?, #NUM!, #REF!) and keeps #ERR only as the fallback for anything
    // else thrown. This asserted #ERR from before the typed errors landed.
    await setCell(0, 2, '=1/0') // C1 (avoids the =<op> formula menu)
    expect(await display(0, 2), 'C1 =1/0 (#DIV/0!)').toBe('#DIV/0!')
  } finally {
    await dispose()
  }
})

test('Step 6 — blank Slides: template gallery adds a slide, Present mode arrow nav + Esc exits', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await clickStartBlank(window, 'Slides')

    // "Present" button + element toolbar visible = the element-based editor loaded.
    const presentBtn = window.getByRole('button', { name: /Present/i })
    await expect(presentBtn).toBeVisible({ timeout: 5_000 })
    await expect(window.getByTestId('slides-toolbar')).toBeVisible()

    // The rail starts with one slide thumbnail (the blank starter slide).
    const railThumbs = window.locator('.w-40 button.overflow-hidden')
    await expect(railThumbs).toHaveCount(1, { timeout: 3_000 })

    // Open the starter-template gallery and insert an Agenda slide.
    await window.getByTestId('slides-add').click()
    await expect(window.getByTestId('slide-template-gallery')).toBeVisible({ timeout: 3_000 })
    await window.getByTestId('slide-template-agenda').click()
    await expect(window.getByTestId('slide-template-gallery')).not.toBeVisible({ timeout: 3_000 })

    // Two slides now in the rail, and the canvas renders elements.
    await expect(railThumbs).toHaveCount(2, { timeout: 3_000 })
    await expect(window.getByTestId('slide-element').first()).toBeVisible({ timeout: 3_000 })

    // Undo the insert (toolbar button) → back to one slide; redo → two again.
    await window.getByTestId('slides-undo').click()
    await expect(railThumbs).toHaveCount(1, { timeout: 3_000 })
    await window.getByTestId('slides-redo').click()
    await expect(railThumbs).toHaveCount(2, { timeout: 3_000 })

    // Start at slide 1, present, arrow to slide 2, Esc out.
    await railThumbs.first().click()
    await presentBtn.click()
    const overlay = window.getByTestId('present-overlay')
    await expect(overlay).toBeVisible({ timeout: 3_000 })
    await expect(overlay.locator('span.tabular-nums').first()).toContainText('1 / 2')

    await window.keyboard.press('ArrowRight')
    await expect(overlay.locator('span.tabular-nums').first()).toContainText('2 / 2', { timeout: 3_000 })

    await window.keyboard.press('Escape')
    await expect(overlay).not.toBeVisible({ timeout: 3_000 })

    // Editor still functional after exit
    await expect(presentBtn).toBeVisible()
  } finally {
    await dispose()
  }
})

test('Step 7 — navigate Home → Calendar → Documents, no errors, Recent list intact', async () => {
  const { window, dispose } = await launchApp()
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  try {
    await waitForReady(window)

    // Create a doc so Recent is non-empty
    await openDocumentsHub(window)
    await clickStartBlank(window, 'Document')
    await window.locator('[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 5_000 })
    await window.waitForTimeout(800) // autosave debounce
    await window.locator('button[title="Back to Documents"]').click()
    await expect(window.locator('text=Untitled document').first()).toBeVisible({ timeout: 5_000 })

    // Navigate away → Home → Calendar → back to Documents
    await goView(window, 'goHome')
    await goView(window, 'goCalendar')
    await goView(window, 'goDocuments')
    await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 5_000 })

    // Recent still intact
    await expect(window.locator('text=Untitled document').first()).toBeVisible({ timeout: 5_000 })

    // No real console errors
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('net::ERR_') &&
        !e.includes('Failed to load resource') &&
        !e.includes('WebSocket')
    )
    expect(realErrors, `Unexpected console errors: ${realErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await dispose()
  }
})

test('Step 8 — no regressions: Home, Calendar, Vault, Documents still route without error', async () => {
  const { window, dispose } = await launchApp()
  const consoleErrors: string[] = []
  window.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  try {
    await waitForReady(window)

    // Route through the core views via the store; each must render without
    // console errors, and the Documents hub must still open at the end.
    await goView(window, 'goHome')
    await goView(window, 'goCalendar')
    await goView(window, 'goVault')
    await openDocumentsHub(window)

    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('net::ERR_') &&
        !e.includes('Failed to load resource') &&
        !e.includes('WebSocket')
    )
    expect(realErrors, `Unexpected console errors: ${realErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await dispose()
  }})
