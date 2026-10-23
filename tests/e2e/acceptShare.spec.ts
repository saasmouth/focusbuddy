/**
 * acceptShare.spec.ts — E2E coverage for the "accept shared item" flow.
 *
 * Flow under test:
 *   1. Boot the app with an isolated userData dir (hermetic — no network).
 *   2. Seed the "Shared with me" inbox via window.api.shares.accept (IPC → main → SQLite).
 *   3. Reload the renderer so the sidebar's useEffect fires refreshShares() from scratch
 *      and reads the now-populated DB row.
 *   4. Click "Add to my workspace" (title="Add to my workspace") on the copy-scope row.
 *   5. Assert reconstruction: window.api.nodes.list() contains the expected hierarchy
 *      ("Shared with me" folder → "Shared Roadmap" folder → "Design" task) and
 *      the Design task's sticky widget contains "hello from share".
 *   6. Assert the shared-badge (data-testid="shared-badge") appears in the sidebar tree.
 *   7. Assert navigation: the view store moved to project-dashboard for the new folder.
 *
 * The test drives via IPC (window.api) so it exercises the real DB + acceptShare lib,
 * not a mocked renderer path. No remote network calls are made.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ---------------------------------------------------------------------------
// The full folder-share acceptance flow
// ---------------------------------------------------------------------------
/**
 * Open "Shared with me".
 *
 * 24a61f93d removed the sidebar's inline Rooms/Desks and Shared trees and put
 * a Shared index under the Rooms nav instead. The inbox row these tests probed
 * for — a sidebar div carrying title="Shared by <handle>" — is gone with the
 * tree; the same items are cards in SharedView now, and "Add to my workspace"
 * went with them. Nothing about what is being tested changed, only where to
 * look.
 */
async function openSharedView(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goShared: () => void } } }
    w.__fbView?.getState().goShared()
  })
  await expect(window.locator('[data-testid="shared-view"]')).toBeVisible({ timeout: 8_000 })
}

test('accept copy-scope folder share reconstructs nodes + widgets + navigates', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const pageErrors: string[] = []
  window.on('pageerror', (err) => pageErrors.push(err.message))

  await waitForReady(window)

  // Step 2: Seed the inbox via IPC — this is the same call the store's
  // acceptByToken would make after resolving the snapshot from the server.
  // In hermetic mode we skip the server and drive the IPC directly.
  const folderSnapshot = {
    _version: 1,
    kind: 'folder',
    fromHandle: 'swift-otter',
    capturedAt: Date.now(),
    folder: {
      id: 'f1',
      kind: 'folder',
      title: 'Shared Roadmap',
      description: 'Q3 plan',
      status: 'open',
      priority: 3,
      importance: 3,
      interest: 3,
      createdAt: 0,
      updatedAt: 0,
      completedAt: null,
      dueDate: null,
      estimateMinutes: null
    },
    tasks: [
      {
        id: 't1',
        kind: 'task',
        title: 'Design',
        description: '',
        status: 'open',
        priority: 3,
        importance: 3,
        interest: 3,
        createdAt: 0,
        updatedAt: 0,
        completedAt: null,
        dueDate: null,
        estimateMinutes: null,
        widgets: [
          {
            id: 'w1',
            kind: 'sticky',
            title: 'note',
            content: 'hello from share',
            x: 80,
            y: 80,
            width: 240,
            height: 160,
            color: null
          }
        ]
      }
    ]
  }

  // Insert the shared item into the DB via IPC.
  await window.evaluate(async (snap) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.shares.accept({
      token: 'test-token-abc123',
      kind: 'folder',
      snapshot: snap,
      fromHandle: 'swift-otter',
      scope: 'copy'
    })
  }, folderSnapshot)

  // Step 3: Reload the renderer so the sidebar's useEffect fires refreshShares()
  // from scratch (sharesLoaded=false) and reads the now-populated DB row.
  // This is the same technique used in liveWires.spec.ts.
  await window.reload()
  await waitForReady(window)

  // Step 4: the shared item shows as a card in "Shared with me", from the
  // handle that sent it.
  await openSharedView(window)
  const card = window.locator('[data-testid^="shared-card-"]').filter({ hasText: 'swift-otter' })
  await expect(card).toHaveCount(1, { timeout: 8_000 })

  // "Add to my workspace" is on copy-scope cards only — still the gate this
  // test and the view-scope one below are about.
  const addBtn = card.locator('[data-testid^="shared-accept-"]')
  await expect(addBtn).toBeVisible({ timeout: 5_000 })
  await expect(addBtn).toContainText('Add to my workspace')
  await addBtn.click()

  // Step 5: Wait for reconstruction. acceptShareIntoWorkspace creates nodes
  // async — poll the node list until the expected titles appear.
  await window.waitForFunction(
    async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const nodes = await api.nodes.list()
      const titles = (nodes as Array<{ title: string }>).map((n) => n.title)
      return (
        titles.includes('Shared with me') &&
        titles.includes('Shared Roadmap') &&
        titles.includes('Design')
      )
    },
    { timeout: 10_000 }
  )

  // Verify the full hierarchy and sharedFromHandle stamps.
  const hierarchy = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    type N = { id: string; title: string; parentId: string | null; sharedFromHandle?: string | null }
    const all = nodes as N[]
    const sharedWithMe = all.find((n) => n.title === 'Shared with me' && n.parentId === null)
    if (!sharedWithMe) return null
    const sharedRoadmap = all.find((n) => n.title === 'Shared Roadmap' && n.parentId === sharedWithMe.id)
    if (!sharedRoadmap) return null
    const designTask = all.find((n) => n.title === 'Design' && n.parentId === sharedRoadmap.id)
    if (!designTask) return null
    return {
      sharedWithMeId: sharedWithMe.id,
      sharedRoadmapId: sharedRoadmap.id,
      designTaskId: designTask.id,
      sharedRoadmapHandle: sharedRoadmap.sharedFromHandle ?? null,
      designHandle: designTask.sharedFromHandle ?? null
    }
  })

  expect(hierarchy).not.toBeNull()
  expect(hierarchy!.sharedRoadmapHandle).toBe('swift-otter')
  expect(hierarchy!.designHandle).toBe('swift-otter')

  // Verify the sticky widget on the Design task contains "hello from share".
  const widgetContent = await window.evaluate(
    async ({ taskId }: { taskId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(taskId)
      const sticky = (widgets as Array<{ kind: string; content: string }>).find(
        (w) => w.kind === 'sticky'
      )
      return sticky ? sticky.content : null
    },
    { taskId: hierarchy!.designTaskId }
  )

  expect(widgetContent).toBe('hello from share')

  // Step 7: Assert navigation. acceptIntoWorkspace calls goProject(rootNodeId)
  // for a folder share, which sets the view store to
  // { kind: 'project-dashboard', projectId: <sharedRoadmapId> }.
  // The view store persists its state to localStorage['fb.view.last'].
  const storedView = await window.evaluate(() => {
    const raw = localStorage.getItem('fb.view.last')
    if (!raw) return null
    try {
      return JSON.parse(raw) as { kind: string; projectId?: string }
    } catch {
      return null
    }
  })

  expect(storedView).not.toBeNull()
  expect(storedView!.kind).toBe('project-dashboard')
  expect(storedView!.projectId).toBe(hierarchy!.sharedRoadmapId)

  // No page errors during the flow.
  expect(pageErrors).toHaveLength(0)

  // Step 6: the reconstructed room keeps the name it was copied from.
  //
  // This asked for [data-testid="shared-badge"], the RECIPIENT badge, which
  // belongs to a LIVE share (sharedRootId). A copy-scope accept makes the room
  // yours — acceptShare.ts sets sharedFromHandle and no sharedRootId — so the
  // right marker is the copied-from one the owner ruled on (2026-10-24):
  // "Copied from <handle>", restored in RoomsView/DesksView alongside the
  // owner's shared-out badge. Before that ruling there was no badge at all and
  // sharedFromHandle was written for a reader that no longer existed.
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goRooms?: () => void } } }
    w.__fbView?.getState().goRooms?.()
  })
  const copied = window.locator('[data-testid="shared-copied-badge"]').first()
  await expect(copied).toBeVisible({ timeout: 8_000 })
  await expect(copied).toHaveAttribute('title', 'Copied from swift-otter')
  // And NOT the live-share badge: this is a copy, not a shared room.
  await expect(window.locator('[data-testid="shared-badge"]')).toHaveCount(0)

})

// ---------------------------------------------------------------------------
// Regression: inbox row only shows "Add to my workspace" for scope=copy, not scope=view
// ---------------------------------------------------------------------------
test('view-scope inbox row does NOT show "Add to my workspace" button', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Seed a view-scope item.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.shares.accept({
      token: 'view-token-xyz',
      kind: 'folder',
      snapshot: {
        kind: 'folder',
        fromHandle: 'red-eagle',
        folder: { title: 'Viewable Folder' },
        tasks: []
      },
      fromHandle: 'red-eagle',
      scope: 'view'
    })
  })

  // Reload so the sidebar refreshes from the DB.
  await window.reload()
  await waitForReady(window)

  // The card appears in "Shared with me".
  await openSharedView(window)
  const card = window.locator('[data-testid^="shared-card-"]').filter({ hasText: 'red-eagle' })
  await expect(card).toHaveCount(1, { timeout: 8_000 })

  // POSITIVE CONTROL FIRST. "no button" passes just as well when nothing
  // rendered at all, which is exactly how this spec could rot unnoticed, so
  // assert the card really is the view-scope one before asserting an absence.
  await expect(card).toContainText('view only')

  // And then the gate: SharedView renders the accept button only when
  // item.scope === 'copy'.
  await expect(card.locator('[data-testid^="shared-accept-"]')).toHaveCount(0)
  await expect(card).not.toContainText('Add to my workspace')
})
