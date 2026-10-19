/**
 * ownerSharedBadge.spec.ts — E2E coverage for the owner-side "shared-out" badge.
 *
 * When the OWNER has created an active (non-revoked) outgoing share link for
 * one of their own folders/tasks, the Sidebar tree row for that node shows a
 * SharedBadge with data-testid="shared-out-badge" and tooltip "Shared with
 * others".
 *
 * Flow:
 *   1. Boot the built app with an isolated userData dir (hermetic — no network).
 *   2. Create two top-level folders via window.api.nodes.create.
 *   3. Create an outgoing share link for folder A via window.api.shares.create.
 *   4. Reload the renderer so the sidebar's useEffect fires refreshShares() and
 *      loads the new outgoing link from the DB.
 *   5. Assert folder A's row shows [data-testid="shared-out-badge"] with
 *      title="Shared with others".
 *   6. Negative: folder B (no share link) must NOT show shared-out-badge.
 *   7. Negative: neither folder shows the recipient-side [data-testid="shared-badge"].
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('owner shared-out badge appears on shared folder and not on unshared folder', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Step 2: Create two top-level folders.
  const { sharedFolderId, unsharedFolderId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const sharedFolder = await api.nodes.create({
      parentId: null,
      kind: 'folder',
      title: 'My Shared Desk'
    })
    const unsharedFolder = await api.nodes.create({
      parentId: null,
      kind: 'folder',
      title: 'My Private Desk'
    })
    return {
      sharedFolderId: (sharedFolder as { id: string }).id,
      unsharedFolderId: (unsharedFolder as { id: string }).id
    }
  })

  // Step 3: Create an outgoing share link for folder A only.
  // The IPC handler 'shares:create' expects: {token, kind, entityId, label, scope, expiresAt}.
  await window.evaluate(
    async ({ folderId }: { folderId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.shares.create({
        token: 'tok-owner-test-abc123',
        kind: 'folder',
        entityId: folderId,
        label: 'My Shared Desk',
        scope: 'view',
        expiresAt: null
      })
    },
    { folderId: sharedFolderId }
  )

  // Step 4: Reload so the sidebar's mount effect re-runs refreshShares() from
  // scratch and populates useSharesStore.outgoing from the DB.
  await window.reload()
  await waitForReady(window)

  // Step 5: Wait for both folder rows to be visible in the Projects tree.
  // Top-level folders always appear in the sidebar without expanding a parent.
  // The sidebar renders rows as role="treeitem" divs; we wait for the text
  // content to appear anywhere in the tree.
  await window.waitForFunction(
    ({ sharedTitle, unsharedTitle }: { sharedTitle: string; unsharedTitle: string }) => {
      const rows = Array.from(document.querySelectorAll('[role="treeitem"]'))
      const titles = rows.map((r) => r.textContent ?? '')
      return (
        titles.some((t) => t.includes(sharedTitle)) &&
        titles.some((t) => t.includes(unsharedTitle))
      )
    },
    { sharedTitle: 'My Shared Desk', unsharedTitle: 'My Private Desk' },
    { timeout: 10_000 }
  )

  // Also wait for the shares store to finish loading (the badge renders only
  // after outgoing shares are populated from the DB).
  await window.waitForFunction(
    () => {
      // The badge renders once sharedOutIds is non-empty for at least one node.
      // We probe for the element directly so the wait self-resolves.
      return document.querySelector('[data-testid="shared-out-badge"]') !== null
    },
    { timeout: 8_000 }
  )

  // Step 5 assertion: shared-out-badge is visible and has correct tooltip.
  const badge = window.locator('[data-testid="shared-out-badge"]')
  await expect(badge).toBeVisible({ timeout: 5_000 })
  // The SharedBadge sets `title` to the label prop ("Shared with others").
  await expect(badge).toHaveAttribute('title', 'Shared with others')

  // Step 6 assertion: exactly one shared-out-badge exists (only the shared
  // folder). The unshared folder must not produce one. Since the sidebar rows
  // have no id attribute we assert the total count is exactly 1.
  await expect(badge).toHaveCount(1)

  // Also confirm the badge is inside a row whose text includes the shared
  // folder title — not the unshared one.
  const sharedRow = window
    .locator('[role="treeitem"]')
    .filter({ hasText: 'My Shared Desk' })
  await expect(sharedRow.locator('[data-testid="shared-out-badge"]')).toBeVisible()

  const unsharedRow = window
    .locator('[role="treeitem"]')
    .filter({ hasText: 'My Private Desk' })
  await expect(
    unsharedRow.locator('[data-testid="shared-out-badge"]')
  ).toHaveCount(0)

  // Step 7 (regression): neither folder was accepted from someone else, so
  // the recipient-side shared-badge (testid="shared-badge") must not appear
  // on any node row in the Projects tree.
  const recipientBadges = window.locator('[data-testid="shared-badge"]')
  await expect(recipientBadges).toHaveCount(0)

  // No unexpected page-level JS errors during the flow.
  expect(pageErrors).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Negative: creating a share then REVOKING it removes the badge
// ---------------------------------------------------------------------------
test('revoking the share link removes the shared-out badge', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)

  // Create a folder and mint a share link for it.
  const { folderId, shareId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const folder = await api.nodes.create({
      parentId: null,
      kind: 'folder',
      title: 'Soon Revoked Desk'
    })
    const link = await api.shares.create({
      token: 'tok-revoke-test-xyz',
      kind: 'folder',
      entityId: (folder as { id: string }).id,
      label: 'Soon Revoked Desk',
      scope: 'view',
      expiresAt: null
    })
    return {
      folderId: (folder as { id: string }).id,
      shareId: (link as { id: string }).id
    }
  })

  // Reload: badge should be visible.
  await window.reload()
  await waitForReady(window)

  await window.waitForFunction(
    () => document.querySelector('[data-testid="shared-out-badge"]') !== null,
    { timeout: 8_000 }
  )
  await expect(window.locator('[data-testid="shared-out-badge"]')).toBeVisible()

  // Now revoke the share link.
  await window.evaluate(
    async ({ id }: { id: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.shares.revoke(id)
    },
    { id: shareId }
  )

  // Reload again: the revoked link must not produce a badge.
  await window.reload()
  await waitForReady(window)

  // Wait for the folder row to be present (shares store loaded).
  // The row is role="treeitem" with the folder title as its text content.
  await window.waitForFunction(
    () => {
      const rows = Array.from(document.querySelectorAll('[role="treeitem"]'))
      return rows.some((r) => r.textContent?.includes('Soon Revoked Desk'))
    },
    { timeout: 8_000 }
  )

  // Badge must be gone after revocation.
  const badge = window.locator('[data-testid="shared-out-badge"]')
  await expect(badge).toHaveCount(0)
})
