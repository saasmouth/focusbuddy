/**
 * E2E: comments on local documents (src/main/db/docComments equivalent,
 * exposed via window.api.documents.{listComments,addComment}).
 *
 * Flow: create a blank Document, type a paragraph, select it via the
 * __docEditor debug handle (ProseMirror selectAll — the same technique
 * docEditor.spec.ts uses, since synthetic DOM selection / Meta+A are
 * unreliable in Electron), open the Comments panel, add a comment through
 * the shared PromptDialog, assert the thread renders and the amber
 * [data-comment-id] highlight exists in the editor DOM, then close and reopen
 * the document and assert the comment persisted (round-tripped through SQLite).
 *
 * THE HIGHLIGHT IS NO LONGER A MARK, and the DOM cannot tell the difference —
 * which is why this file now also asserts what the DOCUMENT holds. A comment's
 * anchor used to be a CommentMark applied to the body, so leaving a comment was
 * a document write; that is why a viewer of a shared document could never
 * comment, and why resolving one edited the document. The anchor is now stored
 * with the comment and drawn as a ProseMirror decoration, which renders the
 * same `fb-comment` class and the same data-comment-id attribute. A DOM
 * assertion therefore passes either way and proves nothing about the change.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, selectBarTab, chooseCloudAiSource, showDocPane } from './_helpers'
import { signInWithFakeSignal } from './_fakeSignal'

// COMMENTING REQUIRES AN ACCOUNT, ON A LOCAL DOCUMENT TOO (owner's ruling,
// 4.3.41, enforced in DocumentEditorView). That is why these two tests went red
// on the account-names merge 96bd8b8d, and the product is the right one: a
// comment is attributed to a person, and a local document can be shared at any
// time carrying its comments with it. So the FIXTURE changed, not the gate —
// and the gate itself is now asserted directly, in the third test below.
//
// The account must be NAMED. An account with no first and last name is held by
// the un-skippable "Add your name" wall (LaunchSignInModal, z-280) which covers
// the app, so a nameless seed would swap one invisible button for another.
const AS = { firstName: 'Dana', lastName: 'Reed' }

/** Signed in as a named person, with nothing reaching the real signal server. */
async function signInNamed(window: Page): Promise<void> {
  await signInWithFakeSignal(window, { name: AS })
  // The wall is gone — which is the precondition for everything below, and
  // worth failing on here rather than as a mystery timeout 40 lines later.
  await expect(window.locator('[data-testid="add-your-name"]')).toHaveCount(0)
}

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
  await signInNamed(window)

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

  // The amber highlight exists in the editor DOM. Says nothing about HOW —
  // a mark and a decoration are indistinguishable here — so the next assertion
  // is the one that matters.
  const markCount = await window.locator('[data-comment-id]').count()
  expect(markCount).toBeGreaterThan(0)

  // AND THE DOCUMENT WAS NOT WRITTEN TO. This is the whole point of the anchor
  // work: before it, the body carried a `comment` mark and leaving a comment
  // was an edit. A viewer could not make that edit, so a viewer could not
  // comment at all; resolving a thread edited the document too.
  //
  // Read from SQLite rather than the DOM, because only the stored body can tell
  // a decoration from a mark.
  //
  // PAST THE AUTOSAVE FIRST. The body is persisted on a 600ms debounce, so a
  // read taken straight after commenting sees the body as it was BEFORE any
  // mark could have been written — and then "no mark" is true of a stale row
  // rather than of the feature. Verified: with the mark deliberately restored,
  // this assertion passed until the wait was added.
  await window.waitForTimeout(1_500)
  const stored = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const metas = await api.documents.list()
    const newest = metas[0]
    if (!newest) return { body: null as unknown, anchors: 0 }
    const doc = await api.documents.get(newest.id)
    const comments = await api.documents.listComments(newest.id)
    return {
      body: doc?.body ?? null,
      anchors: comments.filter((c) => c.anchor != null).length
    }
  })
  // POSITIVE CONTROL. The body we are about to inspect must be the SAVED one:
  // if it does not even contain the sentence that was typed, the read came too
  // early and the negative assertion below means nothing.
  expect(JSON.stringify(stored.body)).toContain('This passage needs review')
  // A mark would appear as {"type":"comment"} inside the body's mark arrays.
  expect(JSON.stringify(stored.body)).not.toContain('"type":"comment"')
  // And the comment really does carry an anchor, or the highlight above came
  // from a mark after all and the assertion above is the vacuous one.
  expect(stored.anchors).toBeGreaterThan(0)

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
  await signInNamed(window)

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

  // Seed a comment so there is a thread to reply INTO — the reply box is the
  // mention-aware input, and it only exists under a thread.
  //
  // It used to be seeded "so its author becomes a real @mention candidate",
  // which was true only by accident: before names, a comment's author string
  // WAS the handle, so the author pool happened to be handle-shaped. With a
  // real name it is "Dana Reed", and a mention resolves against a handle. The
  // candidate is now the signed-in account's handle, which is the same thing
  // the live-doc panel offers (LiveDocEditorView's mentionHandles).
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

test('signed OUT: the action is replaced by "Sign in to comment", and comments already written stay readable', async () => {
  // THE GATE, kept honest. The two tests above sign in, so without this one
  // the requirement they were red on would no longer be covered anywhere, and
  // a regression that let a nameless nobody comment would look like progress.
  //
  // Two halves, both of them product rulings (4.3.41):
  //   - commenting needs an account, on a LOCAL document too; and
  //   - the action is REPLACED rather than hidden, and existing comments stay
  //     readable, so nobody is left wondering whether this document supports
  //     comments at all.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  // Deliberately NOT signed in. The harness permits that; a real launch does
  // not, which is why this is the one place the signed-out panel can be seen.

  // A document that already carries a comment, written through the same IPC
  // the panel writes through.
  const docId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const doc = await api.documents.create({ docType: 'doc', title: 'Signed-out comments' } as never)
    await api.documents.addComment({
      docId: doc.id,
      body: 'Written while signed in, read while signed out.',
      author: 'Dana Reed'
    })
    return doc.id
  })
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
    w.__fbView?.getState().goDocument(id)
  }, docId)
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })

  await selectBarTab(window, 'doc-toolbar', 'review')
  await showDocPane(window, 'comments')
  await expect(window.locator('[data-testid="doc-comments-tab"]')).toBeVisible({ timeout: 5_000 })

  // Readable: the comment is there to be read, signed out.
  await expect(window.locator('[data-testid="doc-comments-list"]')).toContainText(
    'Written while signed in, read while signed out.',
    { timeout: 5_000 }
  )

  // Replaced, not hidden.
  const signIn = window.locator('[data-testid="doc-comments-signin"]')
  await expect(signIn).toBeVisible()
  await expect(signIn).toContainText('Sign in to comment')
  await expect(window.locator('[data-testid="doc-comments-add"]'), 'the Add action must be gone, not merely disabled').toHaveCount(0)

  // And no reply box either: replying is commenting.
  await expect(window.locator('input[data-testid^="doc-comment-reply-"]')).toHaveCount(0)
})
