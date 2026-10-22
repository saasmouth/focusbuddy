/**
 * E2E: comments on local documents (src/main/db/docComments equivalent,
 * exposed via window.api.documents.{listComments,addComment}).
 *
 * Flow: create a blank Document, type a paragraph, select it via the
 * __docEditor debug handle (ProseMirror selectAll — the same technique
 * docEditor.spec.ts uses, since synthetic DOM selection / Meta+A are
 * unreliable in Electron), open the Comments panel, add a comment through
 * the shared PromptDialog, assert the thread renders and the amber
 * [data-comment-id] mark exists in the editor DOM, then close and reopen the
 * document and assert the comment persisted (round-tripped through SQLite).
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, selectBarTab, chooseCloudAiSource, showDocPane } from './_helpers'

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

async function selectAllInEditor(window: Page): Promise<void> {
  await window.evaluate(() => {
    const e = (window as unknown as { __docEditor?: { chain: () => { focus: () => { selectAll: () => { run: () => void } } } } })
      .__docEditor
    e?.chain().focus().selectAll().run()
  })
  await window.waitForTimeout(200)
}

test('add a comment on selected text, see the thread + highlight, and it persists across a reopen', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  // Clear the first-run local-AI cards. local-ai-intro is fixed bottom-centre at
  // z-225 and swallows clicks on whatever is under it — with the comments pane
  // on the right its Add button lands in that band, and the click then never
  // arrives while the button reports visible, enabled and stable throughout.
  await chooseCloudAiSource(window)

  await openDocumentsHub(window)
  await startBlankDoc(window)

  // Type a paragraph into the editor.
  const surface = window.locator('[data-testid="doc-editor-surface"]')
  await surface.click()
  await window.keyboard.type('This passage needs review before we ship it.')
  await window.waitForTimeout(300)

  // Select the whole paragraph deterministically.
  await selectAllInEditor(window)

  // Open the Comments panel.
  await selectBarTab(window, 'doc-toolbar', 'review')
  await showDocPane(window, 'comments')
  await expect(window.locator('[data-testid="doc-comments-tab"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="doc-comments-empty"]')).toBeVisible()

  // Add a comment via the shared prompt dialog.
  await window.locator('[data-testid="doc-comments-add"]').click()
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="prompt-dialog-input"]').fill('Please double-check the numbers here.')
  await window.locator('[data-testid="prompt-dialog-confirm"]').click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })

  // The thread renders in the panel.
  await expect(window.locator('[data-testid="doc-comments-list"]')).toContainText(
    'Please double-check the numbers here.',
    { timeout: 5_000 }
  )
  await expect(window.locator('[data-testid="doc-comments-empty"]')).toHaveCount(0)

  // The amber anchor mark exists in the editor DOM.
  const markCount = await window.locator('[data-comment-id]').count()
  expect(markCount).toBeGreaterThan(0)

  // ── Persistence: close and reopen the document, comment survives. ───────
  await window.locator('button[title="Back to Documents"]').click()
  // The Recent card carries the name the document gave ITSELF: titleBackfill
  // derives one from the content (shared/titles.ts takes the heading or the
  // first real line), so it is the typed sentence, not "Untitled document".
  // Without the full stop — cleanTitle strips a trailing colon or full stop,
  // because it "reads oddly as a name".
  // Scoped to the card because the save also raises a toast with the same name.
  const recent = window
    .locator('[data-testid="doc-recent-card"]')
    .filter({ hasText: 'This passage needs review before we ship it' })
  await expect(recent.first()).toBeVisible({ timeout: 5_000 })
  await recent.first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })

  await selectBarTab(window, 'doc-toolbar', 'review')
  await showDocPane(window, 'comments')
  await expect(window.locator('[data-testid="doc-comments-list"]')).toContainText(
    'Please double-check the numbers here.',
    { timeout: 5_000 }
  )
})

test('reply with an @mention: the autocomplete offers a real participant and the mention renders highlighted', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  // Clear the first-run local-AI cards. local-ai-intro is fixed bottom-centre at
  // z-225 and swallows clicks on whatever is under it — with the comments pane
  // on the right its Add button lands in that band, and the click then never
  // arrives while the button reports visible, enabled and stable throughout.
  await chooseCloudAiSource(window)

  await openDocumentsHub(window)
  await startBlankDoc(window)

  const surface = window.locator('[data-testid="doc-editor-surface"]')
  await surface.click()
  await window.keyboard.type('The revenue figure in this section looks off.')
  await window.waitForTimeout(300)
  await selectAllInEditor(window)

  await selectBarTab(window, 'doc-toolbar', 'review')
  await showDocPane(window, 'comments')
  await expect(window.locator('[data-testid="doc-comments-tab"]')).toBeVisible({ timeout: 5_000 })

  // Seed a comment so its author becomes a real @mention candidate.
  await window.locator('[data-testid="doc-comments-add"]').click()
  const dialog = window.locator('[data-testid="prompt-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="prompt-dialog-input"]').fill('Can someone verify this?')
  await window.locator('[data-testid="prompt-dialog-confirm"]').click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })

  // The reply box is the mention-aware input. Type "@" — the autocomplete offers
  // the real participant (the comment author), never an invented name.
  const replyInput = window.locator('input[data-testid^="doc-comment-reply-"]')
  await expect(replyInput).toBeVisible({ timeout: 5_000 })
  await replyInput.click()
  await replyInput.type('@')
  const menu = window.locator('[data-testid$="-mentions"]')
  await expect(menu).toBeVisible({ timeout: 4_000 })
  const option = window.locator('[data-testid$="-mention-option"]').first()
  await expect(option).toBeVisible()

  // Choosing the option completes the handle; finish the reply and submit.
  await option.click()
  await expect(replyInput).toHaveValue(/@\w+ $/)
  await replyInput.type('please check this figure')
  await window.keyboard.press('Enter')

  // The posted reply renders the @mention as a highlighted chip, not plain text.
  await expect(window.locator('[data-testid="doc-comments-list"]')).toContainText('please check this figure', {
    timeout: 5_000
  })
  await expect(window.locator('[data-testid="doc-comments-list"] [data-testid="mention"], [data-testid="doc-comments-list"] [data-testid="mention-me"]')).toHaveCount(1, {
    timeout: 5_000
  })
})
