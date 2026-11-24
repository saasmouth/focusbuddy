// Deleting a desk on a device that keeps its workspace local ends its links
// (4.3.56).
//
// The owner, 24 Nov 2026: deleting a desk or room ends its links at once. The
// signal does that when the desk's delete arrives (endLinksOfDeletedNode), for
// every kind of link: copy/read links that name the desk (rootId, 4.3.56), "use"
// links and live desks. On a device set to "Keep this device local"
// (lib/localOnlyMode) the personal workspace never syncs, so for a personal desk
// no delete ever arrives, and its links would go on working for anyone who has
// them. This app made those links, so it ends them itself, through the same
// routes a person's own "turn off" uses.
//
// Org workspaces and desks shared by name still sync on such a device, and a
// device that syncs sends the delete: in both the server ends the links, and
// this sends nothing. As on the server, a restore does not bring a link back.

import type { FbNode, ShareLink } from '@shared/types'
import { localOnlyMode } from './localOnlyMode'
import { listEphemeralShares, revokeEphemeralShare } from './ephemeralShareClient'
import { useSharesStore } from '../stores/shares'
import { useOrgStore, PERSONAL_ORG_ID } from '../stores/org'
import { useNoticeStore } from '../stores/notice'

export interface DeskLinksEnded {
  /** Copy/read links turned off. */
  copies: number
  /** "Use" links turned off. */
  useLinks: number
  /** Why a link was not turned off, one line each, in words to show. */
  failed: string[]
}

/** True when the delete reaches the server, which then ends the links itself. */
export function serverEndsLinks(target: Pick<FbNode, 'sharedRootId'>): boolean {
  if (!localOnlyMode()) return true
  if (target.sharedRootId) return true // a desk shared by name syncs on its own loop
  return (useOrgStore.getState().activeOrgId || PERSONAL_ORG_ID) !== PERSONAL_ORG_ID
}

/**
 * End the links of a desk or room just deleted, and of everything deleted with
 * it (`ids`, as nodes.delete returned them), when nothing else will. Returns
 * null when the server ends them itself.
 */
export async function endLinksOfDeletedDesks(
  target: Pick<FbNode, 'title' | 'sharedRootId'>,
  ids: readonly string[]
): Promise<DeskLinksEnded | null> {
  if (!ids.length || serverEndsLinks(target)) return null
  const gone = new Set(ids)
  const failed: string[] = []

  // Copy/read links: of a desk or room deleted, or of a widget on one.
  const shares = useSharesStore.getState()
  if (!shares.loaded) await shares.refresh()
  const mine: ShareLink[] = []
  for (const l of useSharesStore.getState().outgoing) {
    if (l.revoked) continue
    if ((l.kind === 'task' || l.kind === 'folder') && gone.has(l.entityId)) mine.push(l)
    else if (l.kind === 'widget') {
      const w = await window.api.widgets.get(l.entityId).catch(() => null)
      if (w && gone.has(w.taskId)) mine.push(l)
    }
  }
  let copies = 0
  for (const l of mine) {
    const r = await useSharesStore.getState().revoke(l.id)
    if (r.ok) copies++
    else failed.push(r.error)
  }

  // "Use" links: the server lists them with the desk they were made from.
  let useLinks = 0
  for (const s of await listEphemeralShares()) {
    if (!gone.has(s.rootId)) continue
    if (await revokeEphemeralShare(s.token)) useLinks++
    else failed.push('A link people can use in a browser was not turned off, so it still works.')
  }

  // A live desk: a no-op for a desk that has none.
  for (const id of ids) {
    const r = await window.api.liveDesk.stop(id).catch(() => ({ ok: false, error: 'Could not reach the server.' }))
    if (!r.ok) failed.push(`Its live view was not stopped (${r.error ?? 'no answer'}), so it still works.`)
  }

  if (failed.length) {
    useNoticeStore.getState().show(
      { text: `A link to “${target.title || 'this desk'}” still works. ${failed[0]} Turn it off in Share.`, icon: 'link' },
      12_000
    )
  }
  return { copies, useLinks, failed }
}
