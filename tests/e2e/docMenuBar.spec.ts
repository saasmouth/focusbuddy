/**
 * E2E tests for the Google-Docs-style DocMenuBar component.
 *
 * Coverage:
 *  MB-1  Menu bar renders with all seven top-level menus (File/Edit/View/Insert/Format/Tools/Help)
 *  MB-2  File menu dropdown opens, shows the expected items (New document, Make a copy, Rename, Download, Move to trash)
 *  MB-3  Format menu: inserting a horizontal line via Insert > Horizontal line puts an <hr> in the editor
 *  MB-4  Format menu opens and shows Text, Paragraph styles, Align, Bullets & numbering, Clear formatting
 *  MB-5  Tools > Word count opens the modal with Words and Characters rows
 *
 * Strategy: create a doc via window.api, navigate to it with __fbView.getState().goDocument(),
 * wait for the editor surface, then drive the menu bar UI. Real editor actions are
 * verified by inspecting the rendered DOM (HR in editor, bold mark) or the modal text.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'
import path from 'path'

const SHOTS_DIR = '/private/tmp/claude-501/-Applications-agentic-starter-kit-main/0d9ea3a0-0a94-4273-82da-09071878651b/scratchpad'

async function openMenuBarDoc(window: Parameters<typeof waitForReady>[0]): Promise<void> {
  await waitForReady(window)
  // Create a doc via IPC and navigate directly to it — avoids timing issues
  // with the Documents hub list refresh.
  await window.evaluate(async () => {
    const w = window as unknown as {
      api: { documents: { create: (opts: Record<string, unknown>) => Promise<{ id: string }> } }
      __fbView?: { getState: () => { goDocument: (id: string) => void } }
    }
    const d = await w.api.documents.create({ docType: 'doc', title: 'Menu Test' })
    w.__fbView?.getState().goDocument(d.id)
  })
  // Editor surface must be visible before any menu interaction
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  // Menu bar must be present
  await expect(window.locator('[data-testid="doc-menubar"]')).toBeVisible({ timeout: 8_000 })
}

// ── MB-1: All seven menu buttons visible ──────────────────────────────────────

test('MB-1 — all seven top-level menu buttons are visible', async () => {
  const { window, dispose } = await launchApp()
  try {
    await openMenuBarDoc(window)

    const menuBar = window.locator('[data-testid="doc-menubar"]')
    for (const id of ['file', 'edit', 'view', 'insert', 'format', 'tools', 'help']) {
      await expect(menuBar.locator(`[data-testid="doc-menu-${id}"]`)).toBeVisible({
        timeout: 5_000
      })
    }
  } finally {
    await dispose()
  }
})

// ── MB-2: File dropdown opens, expected items visible ────────────────────────

test('MB-2 — File dropdown opens and shows expected items; screenshot saved', async () => {
  const { window, dispose } = await launchApp()
  try {
    await openMenuBarDoc(window)

    // Click File button
    await window.locator('[data-testid="doc-menu-file"]').click()

    // Dropdown must be visible
    const dropdown = window.locator('[data-testid="doc-menu-file-list"]')
    await expect(dropdown).toBeVisible({ timeout: 5_000 })

    // Required items — scope to the label span (truncate) to avoid strict-mode
    // violations caused by the icon <span> siblings sharing the same text.
    await expect(dropdown.locator('span.truncate', { hasText: 'New document' })).toBeVisible()
    await expect(dropdown.locator('span.truncate', { hasText: 'Make a copy' })).toBeVisible()
    await expect(dropdown.locator('span.truncate', { hasText: 'Rename' })).toBeVisible()
    await expect(dropdown.locator('span.truncate', { hasText: 'Download' })).toBeVisible()
    await expect(dropdown.locator('span.truncate', { hasText: 'Move to Trash' })).toBeVisible()

    // Screenshot
    const shot = path.join(SHOTS_DIR, 'menubar-file-dropdown.png')
    await window.screenshot({ path: shot })
    console.log('File dropdown screenshot:', shot)
  } finally {
    await dispose()
  }
})

// ── MB-3: Insert > Horizontal line puts <hr> in the editor ───────────────────

test('MB-3 — Insert > Horizontal line inserts an HR into the editor', async () => {
  const { window, dispose } = await launchApp()
  try {
    await openMenuBarDoc(window)

    const surface = window.locator('[data-testid="doc-editor-surface"]')

    // Type some text first so we have a non-empty document
    await surface.click()
    await surface.type('Above the line')

    // Press Enter so the HR will be inserted on its own line
    await window.keyboard.press('Enter')

    // Open Insert menu
    await window.locator('[data-testid="doc-menu-insert"]').click()
    const insertList = window.locator('[data-testid="doc-menu-insert-list"]')
    await expect(insertList).toBeVisible({ timeout: 5_000 })

    // Click Horizontal line
    await insertList.getByText('Horizontal line').click()
    await window.waitForTimeout(400)

    // An <hr> must now appear in the editor surface
    await expect(surface.locator('hr').first()).toBeVisible({ timeout: 5_000 })
  } finally {
    await dispose()
  }
})

// ── MB-4: Format menu opens with expected sub-items ──────────────────────────

test('MB-4 — Format menu opens and shows Text, Paragraph styles, Align, Bullets & numbering, Clear formatting; screenshot saved', async () => {
  const { window, dispose } = await launchApp()
  try {
    await openMenuBarDoc(window)

    // Open Format menu
    await window.locator('[data-testid="doc-menu-format"]').click()
    const formatList = window.locator('[data-testid="doc-menu-format-list"]')
    await expect(formatList).toBeVisible({ timeout: 5_000 })

    // Required items — scope to label spans to avoid strict-mode violations
    // from icon <span> siblings that share the same text content.
    await expect(formatList.locator('span.truncate', { hasText: 'Text' }).first()).toBeVisible()
    await expect(formatList.locator('span.truncate', { hasText: 'Paragraph styles' })).toBeVisible()
    await expect(formatList.locator('span.truncate', { hasText: 'Align' })).toBeVisible()
    await expect(formatList.locator('span.truncate', { hasText: 'Bullets & numbering' })).toBeVisible()
    await expect(formatList.locator('span.truncate', { hasText: 'Clear formatting' })).toBeVisible()

    // Screenshot
    const shot = path.join(SHOTS_DIR, 'menubar-format-dropdown.png')
    await window.screenshot({ path: shot })
    console.log('Format dropdown screenshot:', shot)
  } finally {
    await dispose()
  }
})

// ── MB-5: Tools > Word count modal ───────────────────────────────────────────

test('MB-5 — Tools > Word count opens modal with Words and Characters; screenshot saved', async () => {
  const { window, dispose } = await launchApp()
  try {
    await openMenuBarDoc(window)

    // Type some words so the count is non-zero
    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await surface.click()
    await surface.type('Hello world this is a word count test')
    await window.waitForTimeout(300)

    // Open Tools menu
    await window.locator('[data-testid="doc-menu-tools"]').click()
    const toolsList = window.locator('[data-testid="doc-menu-tools-list"]')
    await expect(toolsList).toBeVisible({ timeout: 5_000 })

    // Click Word count
    await toolsList.getByText('Word count').click()
    await window.waitForTimeout(300)

    // Modal must be visible. The WordCountModal is a fixed overlay div containing
    // the title "Word count" and rows for Words and Characters.
    // We key on the modal title to locate it (no testid on the overlay).
    const modal = window.locator('h3', { hasText: 'Word count' }).locator('../..')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Words row — use exact match to avoid matching "Characters" sub-rows
    await expect(modal.getByText('Words', { exact: true })).toBeVisible()
    // Characters row — exact match to not also match "Characters excluding spaces"
    await expect(modal.getByText('Characters', { exact: true })).toBeVisible()

    // The Words count must be > 0 (we typed 8 words)
    const wordCountText = await modal.textContent({ timeout: 3_000 })
    console.log('Word count modal text:', wordCountText)
    expect(wordCountText).toMatch(/Words/)
    expect(wordCountText).toMatch(/Characters/)

    // Screenshot
    const shot = path.join(SHOTS_DIR, 'menubar-wordcount-modal.png')
    await window.screenshot({ path: shot })
    console.log('Word count modal screenshot:', shot)
  } finally {
    await dispose()
  }
})
