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

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

/**
 * Open the All Rooms index, where these badges live now.
 *
 * 24a61f93d removed the sidebar's inline trees; the rows this spec probed as
 * [role="treeitem"] are cards in RoomsView. Each card carries the node's id as
 * a testid built from its node id (index-card-<id>), so the shared and
 * unshared ones are told apart by identity rather than by text — stricter
 * than the old filter({ hasText }). The `id` PROP on GalleryCard is not the
 * DOM id; it only feeds that testid, which cost me a run to find out.
 */
async function openRoomsIndex(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goRooms: () => void } } }
    w.__fbView?.getState().goRooms()
  })
  await expect(window.locator('[data-testid="rooms-index-view"]')).toBeVisible({ timeout: 8_000 })
}

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

  // Step 5: both rooms are cards on the All Rooms index.
  await openRoomsIndex(window)
  await expect(window.locator(`[data-testid="index-card-${sharedFolderId}"]`)).toBeVisible({ timeout: 10_000 })
  await expect(window.locator(`[data-testid="index-card-${unsharedFolderId}"]`)).toBeVisible()

  // Step 5 assertion: shared-out-badge is visible and has correct tooltip.
  const badge = window.locator('[data-testid="shared-out-badge"]')
  await expect(badge).toBeVisible({ timeout: 5_000 })
  // The SharedBadge sets `title` to the label prop ("Shared with others").
  await expect(badge).toHaveAttribute('title', 'Shared with others')

  // Step 6 assertion: exactly one shared-out-badge exists (only the shared
  // folder). The unshared folder must not produce one. Since the sidebar rows
  // have no id attribute we assert the total count is exactly 1.
  await expect(badge).toHaveCount(1)

  // And it is on the shared room's card, not the other one — by id, so this
  // cannot pass on a title that happens to appear somewhere else.
  await expect(
    window.locator(`[data-testid="index-card-${sharedFolderId}"] [data-testid="shared-out-badge"]`)
  ).toBeVisible()
  await expect(
    window.locator(`[data-testid="index-card-${unsharedFolderId}"] [data-testid="shared-out-badge"]`)
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

  await openRoomsIndex(window)
  await expect(window.locator(`[data-testid="index-card-${folderId}"] [data-testid="shared-out-badge"]`)).toBeVisible({
    timeout: 8_000
  })

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

  // The card must be on screen before an absence means anything — otherwise
  // "no badge" is just as true of a page that never rendered the room.
  await openRoomsIndex(window)
  await expect(window.locator(`[data-testid="index-card-${folderId}"]`)).toBeVisible({ timeout: 8_000 })

  // Badge must be gone after revocation.
  const badge = window.locator('[data-testid="shared-out-badge"]')
  await expect(badge).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Negative: a link that has EXPIRED does not read as shared either
// ---------------------------------------------------------------------------
test('an expired share link shows no shared-out badge', async () => {
  // The same shape as revoke, and for the same reason: `outgoing` keeps the
  // link either way. An expired link no longer grants anyone access, so the
  // room is not shared with others (owner's ruling, 2026-10-24).
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { liveId, expiredId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const live = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Still Shared Room' })
    const expired = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Expired Share Room' })
    await api.shares.create({
      token: 'tok-live-xyz', kind: 'folder', entityId: (live as { id: string }).id,
      label: 'Still Shared Room', scope: 'view', expiresAt: null
    })
    await api.shares.create({
      token: 'tok-expired-xyz', kind: 'folder', entityId: (expired as { id: string }).id,
      label: 'Expired Share Room', scope: 'view',
      // An hour ago.
      expiresAt: Date.now() - 60 * 60 * 1000
    })
    return { liveId: (live as { id: string }).id, expiredId: (expired as { id: string }).id }
  })

  await window.reload()
  await waitForReady(window)
  await openRoomsIndex(window)

  // POSITIVE CONTROL: the room whose link is still good IS badged, so an
  // absence below means expiry and not a page that never rendered.
  await expect(
    window.locator(`[data-testid="index-card-${liveId}"] [data-testid="shared-out-badge"]`)
  ).toBeVisible({ timeout: 8_000 })

  await expect(window.locator(`[data-testid="index-card-${expiredId}"]`)).toBeVisible()
  await expect(
    window.locator(`[data-testid="index-card-${expiredId}"] [data-testid="shared-out-badge"]`)
  ).toHaveCount(0)
})
