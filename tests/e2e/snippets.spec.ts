/**
 * Saved snippets, end to end in the real app.
 *
 * SN-1 save a selection as a snippet, then insert it back as a DUPLICATE
 * SN-2 insert as a LIVE instance, and prove it resolves from the master
 * SN-3 editing the master changes the live instance, and not the duplicate
 * SN-4 deleting the master makes the live instance show as missing, not blank
 *
 * SN-3 and SN-4 are the whole point of the feature: a duplicate is supposed to
 * stop tracking, a live instance is supposed to keep tracking, and a dangling
 * live instance is supposed to look dangling. All three are invisible unless
 * something checks them.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource } from './_helpers'

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

/** Type text into the document and select all of it. */
async function typeAndSelectAll(window: Page, text: string): Promise<void> {
  const surface = window.locator('[data-testid="doc-editor-surface"]')
  await surface.click()
  await surface.type(text)
  await window.waitForTimeout(150)
  await window.evaluate(() => (document.querySelector('.ProseMirror') as HTMLElement)?.focus())
  await window.keyboard.press('Meta+a')
  await window.waitForTimeout(100)
}

/** Tools › Save selection as snippet, then name and confirm. */
async function saveSelectionAsSnippet(window: Page, name: string): Promise<void> {
  await window.locator('[data-testid="doc-menu-tools"]').click()
  await window.locator('[data-testid="doc-menu-tools-list"]').getByText('Save selection as snippet').click()
  const dialog = window.locator('[data-testid="save-snippet-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  // The dialog must have something to save: an empty selection is refused here
  // rather than stored as an entry the user cannot tell apart.
  await expect(window.locator('[data-testid="save-snippet-empty"]')).toHaveCount(0)
  await window.locator('[data-testid="save-snippet-name"]').fill(name)
  await window.locator('[data-testid="save-snippet-confirm"]').click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })
}

/** Insert › Saved snippet, which opens the library. */
async function openSnippetLibrary(window: Page): Promise<void> {
  await window.locator('[data-testid="doc-menu-insert"]').click()
  await window.locator('[data-testid="doc-menu-insert-list"]').getByText('Saved snippet').click()
  await expect(window.locator('[data-testid="snippet-library"]')).toBeVisible({ timeout: 5_000 })
}

function rowFor(window: Page, name: string) {
  return window.locator('[data-testid="snippet-row"]').filter({ hasText: name })
}

test('SN-1 — save a selection as a snippet, then insert it back as a duplicate', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    await typeAndSelectAll(window, 'Payment is due net 30 from the invoice date.')
    await saveSelectionAsSnippet(window, 'Payment terms')

    // It is in the library, under Mine, with its content searchable.
    await openSnippetLibrary(window)
    await expect(window.locator('[data-testid="snippet-tab-personal"]')).toHaveAttribute('aria-selected', 'true')
    await expect(rowFor(window, 'Payment terms')).toBeVisible()
    await window.locator('[data-testid="snippet-search"]').fill('net 30')
    await expect(rowFor(window, 'Payment terms')).toBeVisible()
    await window.locator('[data-testid="snippet-search"]').fill('')
    await window.locator('[data-testid="snippet-library-close"]').click()
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })

    // Collapse the selection to the end before inserting. Insertion REPLACES
    // the selection, the way a paste does, and everything is still selected
    // from the save — so inserting now would swap the original for the copy and
    // the count below would prove nothing.
    await window.locator('[data-testid="doc-editor-surface"]').click()
    await window.keyboard.press('Meta+ArrowDown')
    await window.keyboard.press('Enter')

    // Insert a duplicate: ordinary content, carrying no reference back.
    await openSnippetLibrary(window)
    await rowFor(window, 'Payment terms').locator('[data-testid="snippet-insert-duplicate"]').click()
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })

    const surface = window.locator('[data-testid="doc-editor-surface"]')
    // The phrase now appears twice: the original text and the inserted copy.
    const occurrences = await surface.evaluate(
      (el) => (el.textContent ?? '').split('Payment is due net 30').length - 1
    )
    expect(occurrences, 'the duplicate was inserted as real content').toBeGreaterThanOrEqual(2)
    // A duplicate is NOT an embed — no live node should have been created.
    await expect(surface.locator('[data-testid="snippet-embed"]')).toHaveCount(0)
  } finally {
    await dispose()
  }
})

test('SN-2 — insert a live instance, which resolves from the saved master', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    await typeAndSelectAll(window, 'Arbitration takes place in Adelaide.')
    await saveSelectionAsSnippet(window, 'Arbitration clause')

    await openSnippetLibrary(window)
    await rowFor(window, 'Arbitration clause').locator('[data-testid="snippet-insert-live"]').click()
    await expect(window.locator('[data-testid="snippet-library"]')).toBeHidden({ timeout: 5_000 })

    // The live node resolved: it renders the master's content and says it is live.
    const embed = window.locator('[data-testid="snippet-embed"]')
    await expect(embed).toBeVisible({ timeout: 8_000 })
    await expect(embed).toContainText('Arbitration takes place in Adelaide')
    // It carries the id and revision it resolved, which is how a host can tell
    // that what it drew is current.
    await expect(embed).toHaveAttribute('data-snippet-revision', '1')
  } finally {
    await dispose()
  }
})

test('SN-3 — editing the master updates the live instance but not the duplicate', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    await typeAndSelectAll(window, 'Original wording here.')
    await saveSelectionAsSnippet(window, 'Clause')

    // One of each, in the same document.
    await openSnippetLibrary(window)
    await rowFor(window, 'Clause').locator('[data-testid="snippet-insert-duplicate"]').click()
    await openSnippetLibrary(window)
    await rowFor(window, 'Clause').locator('[data-testid="snippet-insert-live"]').click()
    await expect(window.locator('[data-testid="snippet-embed"]')).toBeVisible({ timeout: 8_000 })

    // Edit the master through the same API the library uses.
    const updated = await window.evaluate(async () => {
      const api = (window as unknown as { api: { snippets: {
        list: () => Promise<{ id: string; name: string }[]>
        update: (id: string, patch: unknown) => Promise<{ ok: boolean }>
      } } }).api
      const all = await api.snippets.list()
      const target = all.find((s) => s.name === 'Clause')
      if (!target) return false
      const res = await api.snippets.update(target.id, {
        body: {
          kind: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Revised wording here.' }] }],
          text: 'Revised wording here.'
        }
      })
      return res.ok
    })
    expect(updated, 'the master was updated').toBe(true)

    // Reopen the document so the live instance resolves again. That is the
    // contract: a live instance resolves on mount, so the master's current
    // content is what shows.
    await openDocumentsHub(window)
    await window.locator('[data-testid="doc-recent-card"]').first().click()
    const surface = window.locator('[data-testid="doc-editor-surface"]')
    await expect(surface).toBeVisible({ timeout: 8_000 })

    const embed = window.locator('[data-testid="snippet-embed"]')
    await expect(embed).toContainText('Revised wording here', { timeout: 8_000 })
    await expect(embed).toHaveAttribute('data-snippet-revision', '2')

    // The duplicate kept the original wording: it stopped tracking when it
    // landed, which is the difference being tested.
    const text = (await surface.textContent()) ?? ''
    expect(text, 'the duplicate still has the original wording').toContain('Original wording here')
  } finally {
    await dispose()
  }
})

test('SN-4 — deleting the master makes the live instance show as missing, not blank', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    await typeAndSelectAll(window, 'Temporary clause.')
    await saveSelectionAsSnippet(window, 'Doomed')

    await openSnippetLibrary(window)
    await rowFor(window, 'Doomed').locator('[data-testid="snippet-insert-live"]').click()
    await expect(window.locator('[data-testid="snippet-embed"]')).toBeVisible({ timeout: 8_000 })

    // Delete the master from the library.
    await openSnippetLibrary(window)
    await rowFor(window, 'Doomed').locator('[data-testid="snippet-delete"]').click()
    await expect(rowFor(window, 'Doomed')).toHaveCount(0, { timeout: 5_000 })
    await window.locator('[data-testid="snippet-library-close"]').click()

    // Reopen, and the dangling reference looks dangling rather than vanishing.
    await openDocumentsHub(window)
    await window.locator('[data-testid="doc-recent-card"]').first().click()
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="snippet-embed-missing"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="snippet-embed-missing"]')).toContainText('no longer exists')
  } finally {
    await dispose()
  }
})

test('SN-5 — the personal workspace says there is no shared library rather than showing an empty one', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)

    await openSnippetLibrary(window)
    await window.locator('[data-testid="snippet-tab-org"]').click()
    // An empty list here would read as "the org has nothing", which is a
    // different and wrong statement when there is no org at all.
    await expect(window.locator('[data-testid="snippet-org-unavailable"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="snippet-org-unavailable"]')).toContainText('personal workspace')
  } finally {
    await dispose()
  }
})
