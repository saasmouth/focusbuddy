// PlexiOffice standalone-app smoke test. Boots the SAME built bundle as PlexiDesk
// but with PLEXI_APP=office, so the main process loads plexioffice.html and the
// PlexiOffice shell renders. Proves the second product launches into its own UI,
// reuses the shared editors via @office, and can create/open documents — the
// keystone of the lean split.

import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('PO-1 — boots into the PlexiOffice shell with new-document actions', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // The office shell, not the desk: its sidebar shows the PlexiOffice brand and
  // the new-document actions. (Scope to the sidebar — the footer also says
  // "PlexiOffice".)
  await expect(
    window.locator('aside').getByText('PlexiiOffice', { exact: true })
  ).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="office-new-doc"]')).toBeVisible()
  await expect(window.locator('[data-testid="office-new-sheet"]')).toBeVisible()
  await expect(window.locator('[data-testid="office-new-slides"]')).toBeVisible()

  // It must NOT be the desk shell — the canvas surface is absent.
  await expect(window.locator('[data-canvas-surface="true"]')).toHaveCount(0)
})

test('PO-2 — create a spreadsheet: the shared SheetEditor opens and the doc is listed', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  await window.locator('[data-testid="office-new-sheet"]').click()

  // The very same SheetEditor PlexiDesk uses (imported via @office) mounts — its
  // formula bar is the definitive signal.
  await expect(window.locator('input[placeholder*="Select a cell"]')).toBeVisible({ timeout: 10_000 })

  // Type a value so the editor is genuinely live, then go back to the list.
  await window.locator('[data-testid="cell-0-0"]').click()
  const bar = window.locator('input[placeholder*="Select a cell"]')
  await bar.click()
  await bar.fill('hello from PlexiiOffice')
  await window.locator('[data-testid="cell-1-0"]').click()
  await window.waitForTimeout(200)

  await window.getByRole('button', { name: /Back to list/i }).click()
  // The new spreadsheet appears in the sidebar list (createBlank titles a sheet
  // "Untitled sheet").
  await expect(
    window.locator('aside').getByText('Untitled sheet', { exact: true })
  ).toBeVisible({ timeout: 5_000 })
})

test('PO-4 — create a PlexiMap: the diagram editor opens with a starter node and accepts a shape', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  await window.locator('[data-testid="office-new-map"]').click()

  // The MapEditor toolbar mounts (its shape buttons are the definitive signal).
  await expect(window.locator('[data-testid="map-add-process"]')).toBeVisible({ timeout: 10_000 })
  // A fresh map seeds a single Start node (starterMapBody) — React Flow renders it.
  await expect(window.locator('.react-flow__node')).toHaveCount(1, { timeout: 5_000 })

  // Adding a process shape puts a second node on the canvas.
  await window.locator('[data-testid="map-add-process"]').click()
  await expect(window.locator('.react-flow__node')).toHaveCount(2, { timeout: 5_000 })

  // Back in the list, the new map is present (createBlank titles it "Untitled map").
  await window.getByRole('button', { name: /Back to list/i }).click()
  await expect(window.locator('aside').getByText('Untitled map', { exact: true })).toBeVisible({
    timeout: 5_000
  })
})

test('PO-4b — the stencil library is categorized; switching category reveals its shapes', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  await window.locator('[data-testid="office-new-map"]').click()
  await expect(window.locator('[data-testid="map-add-process"]')).toBeVisible({ timeout: 10_000 })

  // Flowchart is the default category, so its "process" shape is present and the
  // basic-shapes-only "star" is not yet in the palette.
  await expect(window.locator('[data-testid="map-add-star"]')).toHaveCount(0)

  // Switch to the Basic shapes category — its stencils appear.
  await window.locator('[data-testid="map-stencil-cat-basic-shapes"]').click()
  await expect(window.locator('[data-testid="map-add-star"]')).toBeVisible({ timeout: 4_000 })
  await expect(window.locator('[data-testid="map-add-triangle"]')).toBeVisible()

  // Adding a star drops it on the canvas (starter node + star = 2).
  await window.locator('[data-testid="map-add-star"]').click()
  await expect(window.locator('.react-flow__node')).toHaveCount(2, { timeout: 5_000 })

  // The Arrows category exposes the block arrow.
  await window.locator('[data-testid="map-stencil-cat-arrows"]').click()
  await expect(window.locator('[data-testid="map-add-arrow"]')).toBeVisible({ timeout: 4_000 })
})

test('PO-3 — the sidebar offers a sign-in surface so documents can sync with PlexiDesk', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // Signed out (no real account in the test env), the account bar invites sign-in.
  // This is the integration contract of the split: one account, shared documents.
  const signIn = window.locator('[data-testid="office-signin"]')
  await expect(signIn).toBeVisible({ timeout: 10_000 })

  // Opening it reveals the inline email/password form with a submit control.
  await signIn.click()
  await expect(window.getByPlaceholder('Email')).toBeVisible()
  await expect(window.getByPlaceholder('Password')).toBeVisible()
  await expect(window.locator('[data-testid="office-signin-submit"]')).toBeVisible()
})

test('PO-5 — the shell shows a version pill and updater affordance like PlexiDesk', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // The footer version pill is the user-visible signal that updates are wired
  // here too (clicking it triggers an update check; the UpdaterBanner beside it
  // reflects state). It must show a v-prefixed version.
  const pill = window.locator('[data-testid="office-version"]')
  await expect(pill).toBeVisible({ timeout: 10_000 })
  await expect(pill).toContainText('v')
})

test('PO-6 — Drive: create a folder, open it, make a doc inside, breadcrumb back', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // Create a folder; it appears in the Drive list (created as "New folder").
  await window.locator('[data-testid="office-new-folder"]').click()
  const folder = window.locator('[data-testid="office-folder-New folder"]')
  await expect(folder).toBeVisible({ timeout: 10_000 })

  // Open it — the breadcrumb now shows the folder, and it starts empty.
  await folder.locator('button').first().click()
  await expect(window.locator('aside').getByText('New folder', { exact: true })).toBeVisible()
  await expect(window.locator('aside').getByText('This folder is empty.')).toBeVisible({ timeout: 5_000 })

  // Create a document inside the folder; it lands here, not at the root.
  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 }) // editor mounted
  await window.getByRole('button', { name: /Back to list/i }).click()
  await expect(window.locator('aside').getByText('Untitled document', { exact: true })).toBeVisible({
    timeout: 5_000
  })

  // Breadcrumb home: the folder is listed at root, and the in-folder doc is not.
  await window.locator('[data-testid="office-crumb-home"]').click()
  await expect(window.locator('[data-testid="office-folder-New folder"]')).toBeVisible()
  await expect(window.locator('aside').getByText('Untitled document', { exact: true })).toHaveCount(0)
})

test('PO-7 — Share a document: create a view-only link', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // Open a new document, then share it.
  await window.locator('[data-testid="office-new-doc"]').click()
  await window.locator('[data-testid="office-share-btn"]').click()
  await expect(window.locator('[data-testid="office-share-dialog"]')).toBeVisible({ timeout: 10_000 })

  // Minting produces a viewer link (works offline — local token mint).
  await window.locator('[data-testid="office-share-create"]').click()
  const link = window.locator('[data-testid="office-share-link"]')
  await expect(link).toBeVisible({ timeout: 5_000 })
  await expect(link).toHaveValue(/\/share\/[a-z0-9]+/)
})

test('PO-8 — Share a Drive folder: copy-scope view-only link', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  await window.locator('[data-testid="office-new-folder"]').click()
  const folder = window.locator('[data-testid="office-folder-New folder"]')
  await expect(folder).toBeVisible({ timeout: 10_000 })

  // Hover reveals the folder share button; click it.
  await folder.hover()
  await window.locator('[data-testid="office-folder-share-New folder"]').click()
  await expect(window.locator('[data-testid="office-share-dialog"]')).toBeVisible({ timeout: 5_000 })

  // A folder share offers view/copy scope; pick copy, then mint the link.
  await window.getByText('Can copy', { exact: true }).click()
  await window.locator('[data-testid="office-share-create"]').click()
  const link = window.locator('[data-testid="office-share-link"]')
  await expect(link).toBeVisible({ timeout: 5_000 })
  await expect(link).toHaveValue(/\/share\/[a-z0-9]+/)
})

test('PO-9 — Drive exposes an "open a shared link" import affordance', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  await window.locator('[data-testid="office-import-link"]').click()
  await expect(window.locator('[data-testid="office-import-url"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="office-import-go"]')).toBeVisible()
})

test('PO-10 — Collaborate offers live editing; prompts sign-in when signed out', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  await window.locator('[data-testid="office-new-doc"]').click()
  // The Collaborate action is present in the document header.
  const collab = window.locator('[data-testid="office-collaborate-btn"]')
  await expect(collab).toBeVisible({ timeout: 10_000 })

  // Signed out (no account in the test env), it asks the user to sign in rather
  // than failing silently.
  await collab.click()
  await expect(window.getByText(/Sign in.*collaborate/i)).toBeVisible({ timeout: 5_000 })
})

test('PO-11 — Teams dialog opens from the sidebar', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  await window.locator('[data-testid="office-teams-btn"]').click()
  await expect(window.locator('[data-testid="office-teams-dialog"]')).toBeVisible({ timeout: 10_000 })
  // Signed out in the test env, it tells the user to sign in rather than erroring.
  await expect(window.getByText(/Sign in to create and manage teams/i)).toBeVisible({ timeout: 5_000 })
})

test('PO-12 — Drive: search finds an item, and delete → Trash → restore round-trips', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // A named entry to act on.
  await window.locator('[data-testid="office-new-folder"]').click()
  const folder = window.locator('[data-testid="office-folder-New folder"]')
  await expect(folder).toBeVisible({ timeout: 10_000 })

  // Drive-wide search surfaces it; clearing search returns to the listing.
  await window.locator('[data-testid="office-search"]').fill('New folder')
  const results = window.locator('[data-testid="office-search-results"]')
  await expect(results).toBeVisible({ timeout: 5_000 })
  await expect(results.locator('[data-testid="office-folder-New folder"]')).toBeVisible()
  await window.locator('[data-testid="office-search-clear"]').click()
  await expect(window.locator('[data-testid="office-search-results"]')).toHaveCount(0)

  // Delete it — it leaves the Drive listing (soft-deleted).
  await folder.hover()
  await folder.getByTitle('Delete folder').click()
  await expect(window.locator('[data-testid="office-folder-New folder"]')).toHaveCount(0, { timeout: 5_000 })

  // It now lives in Trash, recoverable.
  await window.locator('[data-testid="office-trash-toggle"]').click()
  const trashRow = window.locator('[data-testid="office-trash-row-New folder"]')
  await expect(trashRow).toBeVisible({ timeout: 5_000 })

  // Restore it and confirm it is back in the Drive listing.
  await trashRow.hover()
  await window.locator('[data-testid="office-trash-restore-New folder"]').click()
  await window.locator('[data-testid="office-trash-toggle"]').click()
  await expect(window.locator('[data-testid="office-folder-New folder"]')).toBeVisible({ timeout: 5_000 })
})

test('PO-13 — Drive: drag a document onto a folder moves it in (dataTransfer payload)', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // A target folder and a document at the root.
  await window.locator('[data-testid="office-new-folder"]').click()
  await expect(window.locator('[data-testid="office-folder-New folder"]')).toBeVisible({ timeout: 10_000 })
  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: /Back to list/i }).click()
  const doc = window.locator('[data-testid="office-doc-Untitled document"]')
  await expect(doc).toBeVisible({ timeout: 5_000 })

  // Drive the HTML5 drag with a shared DataTransfer (the way Playwright can
  // exercise drag-and-drop deterministically): dragstart writes the entry id,
  // drop reads it. If the payload is missing (the old bug), the move never fires.
  await window.evaluate(() => {
    const src = document.querySelector('[data-testid="office-doc-Untitled document"]')
    const tgt = document.querySelector('[data-testid="office-folder-New folder"]')
    if (!src || !tgt) throw new Error('drag source/target missing')
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })

  // The document leaves the root listing, then shows up inside the folder.
  await expect(doc).toHaveCount(0, { timeout: 5_000 })
  await window.locator('[data-testid="office-folder-New folder"]').locator('button').first().click()
  await expect(window.locator('[data-testid="office-doc-Untitled document"]')).toBeVisible({ timeout: 5_000 })
})

test('PO-14 — Drive facets: tag a document, then browse by tag across folders', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // A document at the root.
  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: /Back to list/i }).click()
  const doc = window.locator('[data-testid="office-doc-Untitled document"]')
  await expect(doc).toBeVisible({ timeout: 5_000 })

  // Open its tag editor and tag it "Acme".
  await doc.hover()
  await window.locator('[data-testid="office-tagbtn-Untitled document"]').click({ force: true })
  await expect(window.locator('[data-testid="office-tag-editor"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-tag-add-input"]').fill('Acme')
  await window.locator('[data-testid="office-tag-add"]').click()
  await expect(window.locator('[data-testid="office-tag-chip-Acme"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-tag-editor-close"]').click()

  // The tag now appears in the facet strip; clicking it shows the tagged doc.
  const chip = window.locator('[data-testid="office-tag-Acme"]')
  await expect(chip).toBeVisible({ timeout: 5_000 })
  await chip.click()
  await expect(window.locator('[data-testid="office-tag-view"]')).toBeVisible({ timeout: 4_000 })
  await expect(window.locator('[data-testid="office-tag-view"] [data-testid="office-doc-Untitled document"]')).toBeVisible({
    timeout: 4_000
  })
})

test('PO-15 — AI auto-filing: suggest tags for a document, accept one (suggest-only)', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { app, window } = launched

  // Stub the AI suggestion IPC so the test is headless and deterministic.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('files:suggestTags')
    ipcMain.handle('files:suggestTags', async () => ({
      ok: true,
      tags: [
        { name: 'Acme', isNew: true, reason: 'mentions the client Acme' },
        { name: 'Invoices', isNew: true, reason: 'reads like an invoice' }
      ]
    }))
  })

  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: /Back to list/i }).click()
  const doc = window.locator('[data-testid="office-doc-Untitled document"]')
  await expect(doc).toBeVisible({ timeout: 5_000 })

  // Open the tag editor and ask the AI to suggest tags.
  await doc.hover()
  await window.locator('[data-testid="office-tagbtn-Untitled document"]').click({ force: true })
  await window.locator('[data-testid="office-tag-suggest"]').click()
  await expect(window.locator('[data-testid="office-tag-suggestions"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="office-tag-suggestion-Acme"]')).toBeVisible()

  // Nothing is applied until accepted (suggest-only). Accept "Acme".
  await window.locator('[data-testid="office-tag-suggestion-Acme"]').click()
  await expect(window.locator('[data-testid="office-tag-chip-Acme"]')).toBeVisible({ timeout: 4_000 })

  // The accepted tag now exists as a real facet in the strip.
  await window.locator('[data-testid="office-tag-editor-close"]').click()
  await expect(window.locator('[data-testid="office-tag-Acme"]')).toBeVisible({ timeout: 5_000 })
})

test('PO-16 — smart folders: a saved tag-AND query shows only files with all the tags', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // A folder and a document at the root.
  await window.locator('[data-testid="office-new-folder"]').click()
  await expect(window.locator('[data-testid="office-folder-New folder"]')).toBeVisible({ timeout: 10_000 })
  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: /Back to list/i }).click()
  const doc = window.locator('[data-testid="office-doc-Untitled document"]')
  await expect(doc).toBeVisible({ timeout: 5_000 })

  // Tag the document with BOTH Acme and Invoices.
  await doc.hover()
  await window.locator('[data-testid="office-tagbtn-Untitled document"]').click({ force: true })
  await window.locator('[data-testid="office-tag-add-input"]').fill('Acme')
  await window.locator('[data-testid="office-tag-add"]').click()
  await expect(window.locator('[data-testid="office-tag-chip-Acme"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-tag-add-input"]').fill('Invoices')
  await window.locator('[data-testid="office-tag-add"]').click()
  await expect(window.locator('[data-testid="office-tag-chip-Invoices"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-tag-editor-close"]').click()

  // Tag the folder with ONLY Acme.
  const folder = window.locator('[data-testid="office-folder-New folder"]')
  await folder.hover()
  await window.locator('[data-testid="office-tagbtn-New folder"]').click({ force: true })
  await window.locator('[data-testid="office-tag-add-input"]').fill('Acme')
  await window.locator('[data-testid="office-tag-add"]').click()
  await expect(window.locator('[data-testid="office-tag-chip-Acme"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-tag-editor-close"]').click()

  // Build a smart folder requiring BOTH Acme and Invoices.
  await window.locator('[data-testid="office-smart-new"]').click()
  await expect(window.locator('[data-testid="office-smart-creator"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-smart-name"]').fill('Acme Invoices')
  await window.locator('[data-testid="office-smart-pick-Acme"]').click()
  await window.locator('[data-testid="office-smart-pick-Invoices"]').click()
  await window.locator('[data-testid="office-smart-save"]').click()

  // Open it: the document (both tags) is in; the folder (only Acme) is NOT.
  await window.locator('[data-testid="office-smart-Acme Invoices"]').click()
  const view = window.locator('[data-testid="office-smart-view"]')
  await expect(view).toBeVisible({ timeout: 4_000 })
  await expect(view.locator('[data-testid="office-doc-Untitled document"]')).toBeVisible({ timeout: 4_000 })
  await expect(view.locator('[data-testid="office-folder-New folder"]')).toHaveCount(0)
})

test('PO-17 — drag-anywhere: drop a file on a tag chip to tag it', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // A document tagged "Acme" (so the Acme chip exists), and a folder to drag.
  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: /Back to list/i }).click()
  const doc = window.locator('[data-testid="office-doc-Untitled document"]')
  await expect(doc).toBeVisible({ timeout: 5_000 })
  await doc.hover()
  await window.locator('[data-testid="office-tagbtn-Untitled document"]').click({ force: true })
  await window.locator('[data-testid="office-tag-add-input"]').fill('Acme')
  await window.locator('[data-testid="office-tag-add"]').click()
  await expect(window.locator('[data-testid="office-tag-chip-Acme"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-tag-editor-close"]').click()

  await window.locator('[data-testid="office-new-folder"]').click()
  await expect(window.locator('[data-testid="office-folder-New folder"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="office-tag-Acme"]')).toBeVisible({ timeout: 4_000 })

  // Drop the folder onto the Acme tag chip — the target decides the verb: tag it.
  await window.evaluate(() => {
    const src = document.querySelector('[data-testid="office-folder-New folder"]')
    const tgt = document.querySelector('[data-testid="office-tag-Acme"]')
    if (!src || !tgt) throw new Error('drag source/target missing')
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })

  // Open the Acme view; the folder is now tagged and shows up there.
  await window.locator('[data-testid="office-tag-Acme"]').click()
  const view = window.locator('[data-testid="office-tag-view"]')
  await expect(view).toBeVisible({ timeout: 4_000 })
  await expect(view.locator('[data-testid="office-folder-New folder"]')).toBeVisible({ timeout: 4_000 })
})

test('PO-18 — proactive auto-filing: unfiled banner; Review opens with AI suggestions ready', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { app, window } = launched

  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('files:suggestTags')
    ipcMain.handle('files:suggestTags', async () => ({
      ok: true,
      tags: [{ name: 'Acme', isNew: true, reason: 'mentions Acme' }]
    }))
  })

  // A fresh document arrives unfiled.
  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: /Back to list/i }).click()
  await expect(window.locator('[data-testid="office-doc-Untitled document"]')).toBeVisible({ timeout: 5_000 })

  // The Drive proactively flags it, and Review opens its tags with the AI
  // suggestion already run — no extra click.
  await expect(window.locator('[data-testid="office-unfiled-banner"]')).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="office-unfiled-review"]').click()
  await expect(window.locator('[data-testid="office-tag-editor"]')).toBeVisible({ timeout: 4_000 })
  await expect(window.locator('[data-testid="office-tag-suggestions"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="office-tag-suggestion-Acme"]')).toBeVisible()
})

test('PO-19 — smart folders with a search term: tag AND name must both match', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  // A folder and a document, both tagged "Acme".
  await window.locator('[data-testid="office-new-folder"]').click()
  const folder = window.locator('[data-testid="office-folder-New folder"]')
  await expect(folder).toBeVisible({ timeout: 10_000 })
  await folder.hover()
  await window.locator('[data-testid="office-tagbtn-New folder"]').click({ force: true })
  await window.locator('[data-testid="office-tag-add-input"]').fill('Acme')
  await window.locator('[data-testid="office-tag-add"]').click()
  await expect(window.locator('[data-testid="office-tag-chip-Acme"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-tag-editor-close"]').click()

  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: /Back to list/i }).click()
  const doc = window.locator('[data-testid="office-doc-Untitled document"]')
  await expect(doc).toBeVisible({ timeout: 5_000 })
  await doc.hover()
  await window.locator('[data-testid="office-tagbtn-Untitled document"]').click({ force: true })
  await window.locator('[data-testid="office-tag-add-input"]').fill('Acme')
  await window.locator('[data-testid="office-tag-add"]').click()
  await expect(window.locator('[data-testid="office-tag-chip-Acme"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-tag-editor-close"]').click()

  // Smart folder: tag Acme AND name contains "folder".
  await window.locator('[data-testid="office-smart-new"]').click()
  await window.locator('[data-testid="office-smart-name"]').fill('Acme Folders')
  await window.locator('[data-testid="office-smart-pick-Acme"]').click()
  await window.locator('[data-testid="office-smart-search"]').fill('folder')
  await window.locator('[data-testid="office-smart-save"]').click()

  // Only the folder qualifies (Acme + name "New folder"); the doc does not.
  await window.locator('[data-testid="office-smart-Acme Folders"]').click()
  const view = window.locator('[data-testid="office-smart-view"]')
  await expect(view).toBeVisible({ timeout: 4_000 })
  await expect(view.locator('[data-testid="office-folder-New folder"]')).toBeVisible({ timeout: 4_000 })
  await expect(view.locator('[data-testid="office-doc-Untitled document"]')).toHaveCount(0)
})

test('PO-20 — office app exposes AI · API keys settings (so a key can be added)', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  await expect(window.locator('[data-testid="office-settings-btn"]')).toBeVisible({ timeout: 10_000 })
  await window.locator('[data-testid="office-settings-btn"]').click()
  const modal = window.locator('[data-testid="office-settings-modal"]')
  await expect(modal).toBeVisible({ timeout: 4_000 })
  await expect(modal).toContainText(/Anthropic/i)
  await expect(modal.locator('input[type="password"]').first()).toBeVisible({ timeout: 4_000 })
})

test('PO-21 — ask your workspace: grounded answer with a clickable citation', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { app, window } = launched

  // A real document to cite.
  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  await window.getByRole('button', { name: /Back to list/i }).click()
  const docId = await window.evaluate(async () => {
    const api = (window as unknown as { api: { documents: { list: () => Promise<Array<{ id: string }>> } } }).api
    const docs = await api.documents.list()
    return docs[0]?.id
  })

  // Stub the grounded answer so the test is headless and deterministic.
  await app.evaluate(({ ipcMain }, id) => {
    ipcMain.removeHandler('workspace:ask')
    ipcMain.handle('workspace:ask', async () => ({
      ok: true,
      answer: 'Acme is $48k per year. [1]',
      citedDocIds: [id],
      sources: [{ docId: id, title: 'Untitled document', docType: 'doc', snippet: 'total $48k per year', cited: true }]
    }))
  }, docId)

  await window.locator('[data-testid="office-ask-btn"]').click()
  await expect(window.locator('[data-testid="office-ask-modal"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-ask-input"]').fill('what is acme pricing?')
  await window.locator('[data-testid="office-ask-submit"]').click()
  await expect(window.locator('[data-testid="office-ask-answer"]')).toContainText('Acme is $48k', { timeout: 5_000 })
  const source = window.locator('[data-testid="office-ask-source-Untitled document"]')
  await expect(source).toBeVisible({ timeout: 4_000 })
  // Clicking the citation opens the document (and closes the ask modal).
  await source.click()
  await expect(window.locator('[data-testid="office-ask-modal"]')).toHaveCount(0, { timeout: 4_000 })
})

test('PO-22 — ask: turn the answer into a real document', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { app, window } = launched

  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('workspace:ask')
    ipcMain.handle('workspace:ask', async () => ({
      ok: true,
      answer: 'Acme is $48k per year over three years.',
      citedDocIds: [],
      sources: []
    }))
  })

  await window.locator('[data-testid="office-ask-btn"]').click()
  await window.locator('[data-testid="office-ask-input"]').fill('acme pricing summary')
  await window.locator('[data-testid="office-ask-submit"]').click()
  await expect(window.locator('[data-testid="office-ask-answer"]')).toContainText('Acme is $48k', { timeout: 5_000 })
  await window.locator('[data-testid="office-ask-make-doc"]').click()
  // The ask modal closes and a new document with that title now exists.
  await expect(window.locator('[data-testid="office-ask-modal"]')).toHaveCount(0, { timeout: 5_000 })
  const made = await window.evaluate(async () => {
    const api = (window as unknown as { api: { documents: { list: () => Promise<Array<{ title: string }>> } } }).api
    const docs = await api.documents.list()
    return docs.some((d) => (d.title || '').toLowerCase().includes('acme pricing summary'))
  })
  expect(made).toBe(true)
})

test('PO-23 — related documents are found by real content overlap', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { window } = launched

  await waitForReady(window)
  const related = await window.evaluate(async () => {
    const api = (window as unknown as {
      api: {
        documents: { create: (d: unknown) => Promise<{ id: string }> }
        workspace: { related: (id: string) => Promise<Array<{ title: string }>> }
      }
    }).api
    const mk = (title: string, text: string) =>
      api.documents.create({ docType: 'doc', title, body: { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } } })
    await mk('Acme pricing notes', 'acme pricing agreement total 48000 per year for the supplier contract')
    const b = await mk('Acme proposal', 'acme pricing proposal supplier contract 48000 three year')
    await mk('Holiday plans', 'beach trip in july with the family and a boat')
    return api.workspace.related(b.id)
  })
  const titles = related.map((r) => r.title)
  expect(titles).toContain('Acme pricing notes')
  expect(titles).not.toContain('Holiday plans')
})

test('PO-24 — Related dropdown opens a related document', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { app, window } = launched

  await window.locator('[data-testid="office-new-doc"]').click()
  await expect(window.locator('input').first()).toBeVisible({ timeout: 10_000 })
  const otherId = await window.evaluate(async () => {
    const api = (window as unknown as { api: { documents: { create: (d: unknown) => Promise<{ id: string }> } } }).api
    const d = await api.documents.create({ docType: 'doc', title: 'Related thing', body: { doc: { type: 'doc', content: [] } } })
    return d.id
  })
  await app.evaluate(({ ipcMain }, id) => {
    ipcMain.removeHandler('workspace:related')
    ipcMain.handle('workspace:related', async () => [{ docId: id, title: 'Related thing', docType: 'doc', snippet: 'shared topic' }])
  }, otherId)

  await window.locator('[data-testid="office-related-btn"]').click()
  await expect(window.locator('[data-testid="office-related-panel"]')).toBeVisible({ timeout: 4_000 })
  await window.locator('[data-testid="office-related-item-Related thing"]').click()
  await expect(window.locator('header')).toContainText('Related thing', { timeout: 4_000 })
})

test('PO-25 — ask is conversational: a follow-up carries the thread', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'office' } })
  const { app, window } = launched

  // Echo the question + how many prior turns were passed, so we can prove the
  // thread accumulates and history flows to the backend.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('workspace:ask')
    ipcMain.handle('workspace:ask', async (_e, question: string, history?: unknown[]) => ({
      ok: true,
      answer: `A:${question} hist=${Array.isArray(history) ? history.length : 0}`,
      citedDocIds: [],
      sources: []
    }))
  })

  await window.locator('[data-testid="office-ask-btn"]').click()
  await expect(window.locator('[data-testid="office-ask-modal"]')).toBeVisible({ timeout: 4_000 })

  await window.locator('[data-testid="office-ask-input"]').fill('first question')
  await window.locator('[data-testid="office-ask-submit"]').click()
  await expect(window.locator('[data-testid="office-ask-answer"]').nth(0)).toContainText('A:first question hist=0', { timeout: 5_000 })

  await window.locator('[data-testid="office-ask-input"]').fill('second question')
  await window.locator('[data-testid="office-ask-submit"]').click()
  await expect(window.locator('[data-testid="office-ask-answer"]').nth(1)).toContainText('A:second question hist=1', { timeout: 5_000 })
  // Both turns remain in the thread.
  await expect(window.locator('[data-testid="office-ask-answer"]')).toHaveCount(2)
})
