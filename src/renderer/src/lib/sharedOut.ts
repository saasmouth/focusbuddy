import type { ShareLink } from '@shared/types'

// Which of my own things are shared OUT, for the badge on the Rooms and Desks
// indexes.
//
// `outgoing` is not a list of live shares. A revoke is a SOFT delete —
// ShareLink.revoked is a flag so the share manager can still show who you had
// shared with — and expiry is a timestamp that simply passes. Mapping the list
// straight to ids therefore marked a room "Shared with others" after its link
// was revoked (caught by ownerSharedBadge's revoke test) and would have gone
// on doing it after a link expired (owner's ruling, 2026-10-24: an expired
// link is not shared with others).
//
// `now` is passed in rather than read here so the rule can be tested at a
// chosen moment instead of whenever the suite happens to run.

/** True while the link still grants access: not revoked, not past its expiry. */
export function isLiveShare(link: Pick<ShareLink, 'revoked' | 'expiresAt'>, now: number): boolean {
  if (link.revoked) return false
  // null = never expires (types.ts). A link expiring exactly now has expired.
  if (link.expiresAt !== null && link.expiresAt <= now) return false
  return true
}

/** The entity ids with at least one live outgoing link. */
export function activeSharedOutIds(
  outgoing: ReadonlyArray<Pick<ShareLink, 'entityId' | 'revoked' | 'expiresAt'>>,
  now: number
): Set<string> {
  const out = new Set<string>()
  for (const l of outgoing) if (isLiveShare(l, now)) out.add(l.entityId)
  return out
}
