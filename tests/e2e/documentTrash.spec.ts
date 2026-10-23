/**
 * E2E coverage for the Documents Trash (soft-delete) flow.
 *
 * Claim under test: deleting a document from the Documents hub or an editor's
 * File > Move to trash soft-deletes it. The Documents hub shows a
 * "Trash (n)" section with Restore and Delete forever, and an Undo toast
 * appears on delete. Backed by documents:delete (now trashes),
 * documents:listTrashed / restore / purge, and the documents.trashed_at column.
 *
 * Navigation note: the app's current IA reaches the Documents hub via
 * `useViewStore.getState().goDocuments()` (there is no longer a literal
 * "Documents" sidebar button — see documents.spec.ts staleness). We drive
 * navigation the same deterministic way docMenuBar.spec.ts does, through the
 * exposed __fbView store, so this spec is independent of that pre-existing
 * nav drift.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

type FbWindow = Window & {
  api: {
    documents: {
      create: (opts: Record<string, unknown>) => Promise<{ id: string }>
      list: () => Promise<Array<{ id: string; title: string }>>
      listTrashed: () => Promise<Array<{ id: string; title: string }>>
    }
  }
  __fbView?: { getState: () => { goDocuments: () => void; goDocument: (id: string) => void } }
}

async function goToDocumentsHub(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(() => {
    ;(window as unknown as FbWindow).__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

async function createDoc(window: import('@playwright/test').Page, title: string): Promise<string> {
  return window.evaluate(async (t) => {
    const w = window as unknown as FbWindow
    const d = await w.api.documents.create({ docType: 'doc', title: t })
    return d.id
  }, title)
}

test('TRASH-1 — hub delete icon soft-deletes: doc leaves Recent, appears under Trash (n), IPC confirms trashed_at set', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const title = 'Trash Me Doc'
    await createDoc(window, title)
    await goToDocumentsHub(window)

    await expect(window.locator('text=' + title).first()).toBeVisible({ timeout: 5_000 })

    // The row's delete (trash) icon has title "Move to trash (recoverable below)".
    const row = window.locator('div.group', { hasText: title }).first()
    await row.hover()
    await row.locator('button[title="Move to trash (recoverable below)"]').click()

    // Undo toast appears.
    const toast = window.locator('[data-testid="undo-toast"]')
    await expect(toast).toBeVisible({ timeout: 3_000 })
    await expect(toast).toContainText('Moved')
    await expect(toast.locator('[data-testid="undo-toast-undo"]')).toBeVisible()
    // Dismiss the toast — its label also contains the doc title, which would
    // otherwise confuse the "gone from Recent" check below.
    await toast.getByLabel('Dismiss').click()
    await expect(toast).not.toBeVisible({ timeout: 3_000 })

    // Recent list no longer shows it (soft-deleted).
    await expect(window.locator('text=' + title).first()).not.toBeVisible({ timeout: 5_000 })

    // Trash section shows count and, expanded, the trashed doc with Restore / Delete forever.
    const trashToggle = window.getByRole('button', { name: /^Trash \(\d+\)$/ })
    await expect(trashToggle).toBeVisible({ timeout: 5_000 })
    await expect(trashToggle).toContainText('Trash (1)')
    await trashToggle.click()
    await expect(window.locator('text=' + title).first()).toBeVisible({ timeout: 3_000 })
    await expect(window.locator('[data-testid="doc-restore"]').first()).toBeVisible()
    await expect(window.locator('[data-testid="doc-purge"]').first()).toBeVisible()

    // IPC round-trip: the doc is absent from list(), present in listTrashed().
    const { inList, inTrash } = await window.evaluate(async (t) => {
      const w = window as unknown as FbWindow
      const list = await w.api.documents.list()
      const trashed = await w.api.documents.listTrashed()
      return {
        inList: list.some((d) => d.title === t),
        inTrash: trashed.some((d) => d.title === t)
      }
    }, title)
    expect(inList, 'trashed doc must not appear in the live list').toBe(false)
    expect(inTrash, 'trashed doc must appear in listTrashed').toBe(true)
  } finally {
    await dispose()
  }
})

test('TRASH-2 — Undo toast restores the document back to Recent', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const title = 'Undo Me Doc'
    await createDoc(window, title)
    await goToDocumentsHub(window)

    const row = window.locator('div.group', { hasText: title }).first()
    await row.hover()
    await row.locator('button[title="Move to trash (recoverable below)"]').click()

    const toast = window.locator('[data-testid="undo-toast"]')
    await expect(toast).toBeVisible({ timeout: 3_000 })
    await toast.locator('[data-testid="undo-toast-undo"]').click()

    // Back in Recent, no longer in Trash.
    await expect(window.locator('text=' + title).first()).toBeVisible({ timeout: 5_000 })

    const { inList, inTrash } = await window.evaluate(async (t) => {
      const w = window as unknown as FbWindow
      const list = await w.api.documents.list()
      const trashed = await w.api.documents.listTrashed()
      return {
        inList: list.some((d) => d.title === t),
        inTrash: trashed.some((d) => d.title === t)
      }
    }, title)
    expect(inList, 'undo must restore the doc to the live list').toBe(true)
    expect(inTrash, 'undo must remove the doc from trash').toBe(false)
  } finally {
    await dispose()
  }
})

test('TRASH-3 — Restore from the Trash section brings a document back; Delete forever purges it permanently', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const restoreTitle = 'Restore Me Doc'
    const purgeTitle = 'Purge Me Doc'
    await createDoc(window, restoreTitle)
    await createDoc(window, purgeTitle)
    await goToDocumentsHub(window)

    for (const t of [restoreTitle, purgeTitle]) {
      const row = window.locator('div.group', { hasText: t }).first()
      await row.hover()
      await row.locator('button[title="Move to trash (recoverable below)"]').click()
      // Dismiss the toast between deletes so it doesn't obscure hover targets.
      await window.waitForTimeout(150)
    }

    const trashToggle = window.getByRole('button', { name: /^Trash \(\d+\)$/ })
    await expect(trashToggle).toContainText('Trash (2)', { timeout: 5_000 })
    await trashToggle.click()

    // Restore. Trashed rows carry a distinctive `border-dashed` class not used
    // elsewhere in the hub, so scoping on it (rather than a bare `div`) avoids
    // matching the shared outer grid container that wraps both trashed rows.
    const restoreRow = window.locator('div.border-dashed', { hasText: restoreTitle }).first()
    await restoreRow.locator('[data-testid="doc-restore"]').click()

    // Confirm via IPC: restored doc is live again; trash count dropped to 1.
    await window.waitForTimeout(300)
    const afterRestore = await window.evaluate(async (t) => {
      const w = window as unknown as FbWindow
      const list = await w.api.documents.list()
      const trashed = await w.api.documents.listTrashed()
      return { inList: list.some((d) => d.title === t), trashedCount: trashed.length }
    }, restoreTitle)
    expect(afterRestore.inList, 'restored doc must be back in the live list').toBe(true)
    expect(afterRestore.trashedCount, 'only the purge candidate remains trashed').toBe(1)

    // Delete forever the remaining trashed doc. Purge is gated behind the
    // app's styled confirm dialog (PromptDialog's confirmDialog helper), not
    // a native window.confirm() — Electron doesn't implement that anyway.
    const purgeRow = window.locator('div.border-dashed', { hasText: purgeTitle }).first()
    await purgeRow.locator('[data-testid="doc-purge"]').click()
    await window.locator('[data-testid="prompt-dialog-confirm"]').click()

    await window.waitForTimeout(300)
    const afterPurge = await window.evaluate(async (t) => {
      const w = window as unknown as FbWindow
      const trashed = await w.api.documents.listTrashed()
      return trashed.some((d) => d.title === t)
    }, purgeTitle)
    expect(afterPurge, 'purged doc must be gone from trash permanently').toBe(false)
  } finally {
    await dispose()
  }
})

test('TRASH-4 — editor File > Move to trash soft-deletes the open document and returns to the hub', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    const title = 'Editor Trash Doc'
    const id = await createDoc(window, title)
    await window.evaluate((docId) => {
      ;(window as unknown as FbWindow).__fbView?.getState().goDocument(docId)
    }, id)
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })

    // File > Move to trash now opens the styled confirmDialog (86821ed
    // replaced the native window.confirm() here with the same shared
    // PromptDialog-backed confirm the Documents-hub delete already used).
    // Confirm it via its own "Move to trash" button.
    await window.locator('[data-testid="doc-menu-file"]').click()
    const dropdown = window.locator('[data-testid="doc-menu-file-list"]')
    await expect(dropdown).toBeVisible({ timeout: 3_000 })
    await dropdown.locator('span.truncate', { hasText: 'Move to Trash' }).click()

    const confirmDialog = window.locator('[data-testid="prompt-dialog"]')
    await expect(confirmDialog).toBeVisible({ timeout: 3_000 })
    await expect(confirmDialog).toHaveAttribute('aria-label', /Move ".*" to trash\?/)
    await confirmDialog.locator('[data-testid="prompt-dialog-confirm"]').click()

    // Lands back on the Documents hub.
    await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })

    const { inList, inTrash } = await window.evaluate(async (t) => {
      const w = window as unknown as FbWindow
      const list = await w.api.documents.list()
      const trashed = await w.api.documents.listTrashed()
      return {
        inList: list.some((d) => d.title === t),
        inTrash: trashed.some((d) => d.title === t)
      }
    }, title)
    expect(inList, 'doc trashed via editor File menu must leave the live list').toBe(false)
    expect(inTrash, 'doc trashed via editor File menu must appear in the trash').toBe(true)
  } finally {
    await dispose()
  }
})
