/**
 * E2E: Track Changes (suggesting mode) on a local document.
 *
 * Toggle Suggesting, type into the document, and confirm the typed text is
 * recorded as an insertion (rendered with the tc-insert mark), then Accept all
 * keeps the text but clears the marks. A second pass proves Reject all removes a
 * suggested insertion. Runs on a plain local doc, so no account/live session.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, selectBarTab } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openDocumentsHub(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

async function startBlankDoc(window: Page): Promise<void> {
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Document' }).first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })
}

async function insertAtEnd(window: Page, text: string): Promise<void> {
  await window.evaluate((t) => {
    const e = (window as unknown as {
      __docEditor?: { chain: () => { focus: (p: string) => { insertContent: (s: string) => { run: () => void } } } }
    }).__docEditor
    e?.chain().focus('end').insertContent(t).run()
  }, text)
  await window.waitForTimeout(150)
}

test('DTC-1 — suggesting records an insertion; accept keeps it, reject removes it', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDocumentsHub(window)
  await startBlankDoc(window)

  const surface = window.locator('[data-testid="doc-editor-surface"]')
  await surface.click()
  await window.keyboard.type('The plan is ready.')
  await window.waitForTimeout(200)

  // Turn on Suggesting through the real toolbar toggle, then insert an addition.
  // Text is inserted via the editor command (not raw keystrokes) so the assertion
  // isn't racing keyboard focus; the insertion still flows through the same
  // capture path that live typing does.
  await selectBarTab(window, 'doc-toolbar', 'review')
  await window.locator('[data-testid="doc-suggest-toggle"]').click()
  await insertAtEnd(window, ' Absolutely')

  // The suggested text is rendered as a tracked insertion.
  await expect(window.locator('.ProseMirror .tc-insert')).toHaveCount(1, { timeout: 4_000 })
  await expect(window.locator('.ProseMirror .tc-insert')).toContainText('Absolutely')

  // Accept all keeps the text but clears the tracking mark.
  await selectBarTab(window, 'doc-toolbar', 'review')
  await window.locator('[data-testid="doc-accept-all"]').click()
  await window.waitForTimeout(200)
  await expect(window.locator('.ProseMirror .tc-insert')).toHaveCount(0)
  await expect(surface).toContainText('The plan is ready. Absolutely')

  // A second suggestion, then Reject all removes it.
  await insertAtEnd(window, ' maybe')
  await expect(window.locator('.ProseMirror .tc-insert')).toHaveCount(1, { timeout: 4_000 })
  await selectBarTab(window, 'doc-toolbar', 'review')
  await window.locator('[data-testid="doc-reject-all"]').click()
  await window.waitForTimeout(200)
  await expect(window.locator('.ProseMirror .tc-insert')).toHaveCount(0)
  await expect(surface).not.toContainText('maybe')
  await expect(surface).toContainText('The plan is ready. Absolutely')
})
