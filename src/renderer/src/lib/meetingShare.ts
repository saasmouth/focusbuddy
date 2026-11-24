import type { ShareableKind } from '@shared/types'
import { useSharesStore } from '../stores/shares'
import { useNoticeStore } from '../stores/notice'
import { useNodeStore } from '../stores/nodes'
import { useAccountStore } from '../stores/account'
import { useMeetingRoomStore } from '../stores/meetingRoom'
import { buildFolderSnapshot, generateAnonymousHandle } from './shareSnapshot'
import { buildDocumentSnapshot } from './officeShareSnapshot'
import { accessToShare, type MeetingAccessLevel } from './meetingAccess'
import {
  createLiveDoc,
  inviteToLiveDocByEmail,
  setLiveDocMemberRole,
  removeLiveDocMember
} from './docCollabClient'
import { shareDeskLive, revokeDeskAccess, revokeDeskInvite } from './deskShareClient'
import type { MeetingOrigin } from './startMeeting'

// Meeting origins whose artifact is a document: each becomes a live document of
// its own docType (a drawing is a 'map', a design is a 'design'), co-edited in
// the matching live editor.
const DOC_ORIGIN_KINDS = new Set(['doc', 'sheet', 'slides', 'draw', 'design'])
// Document origins that collaborate as a live document (co-edited via Yjs). A desk
// is handled separately: it collaborates by sharing the real desk on the CRDT
// substrate (see collaborateDeskViaSubstrate), not as a live document.
const COLLAB_LIVE_KINDS = DOC_ORIGIN_KINDS

// What happens to a collaborate grant once the meeting ends. Collaborate access
// is only meant to last for the meeting by default: attendees work on the
// artifact while the meeting is live, then it becomes read-only. The host can
// instead keep the access, or revoke it entirely, when they start the meeting.
export type MeetingAfterAccess = 'downgrade-view' | 'keep' | 'revoke'

// Collaborate shares waiting for the meeting to end so they can be downgraded or
// revoked. Held in memory for the life of the session; a downgrade that is
// pending when the app closes simply does not run (the collaborate share
// persists), which is a safe, non-destructive miss.
interface PendingDowngrade {
  shareId: string
  after: MeetingAfterAccess
  snapshot: unknown
  fromHandle: string
}
let pendingDowngrades: PendingDowngrade[] = []

// Live-doc collaborators waiting for the meeting to end. On end they are turned
// read-only (viewer), removed (revoke), or left as editors (keep).
interface PendingLiveDowngrade {
  token: string
  liveDocId: string
  memberAccountIds: string[]
  after: MeetingAfterAccess
}
let pendingLiveDowngrades: PendingLiveDowngrade[] = []
// Desk-ACL grants (a desk shared as a live canvas via the substrate) waiting for the
// meeting to end so they can be downgraded to view-only or revoked.
interface PendingDeskDowngrade {
  rootId: string
  accountIds: string[]
  emails: string[]
  after: MeetingAfterAccess
}
let pendingDeskDowngrades: PendingDeskDowngrade[] = []
let endWatcherInstalled = false

// Grants a meeting's attendees access to the artifact it was started from. This
// is the "trickle down" step: one share of the source artifact is minted at the
// level the host chose (view-once / view-always / collaborate), and every
// attendee is invited onto it, which records them as a recipient (so it lands in
// their PlexiDesk inbox) and emails them the link. Recording the recipient does
// not depend on email delivery, so an attendee still gets access in-app even
// when the notification email cannot be sent; the result reports both honestly.

export interface MeetingShareResult {
  shared: number // attendees granted access (recorded as recipients)
  emailed: number // of those, how many were emailed the link
  failed: string[] // attendees that could not be granted at all
}

// Resolve a meeting origin into the shareable artifact behind it, or null when
// the origin has no single artifact to share (chat, calendar, a plain start).
async function resolveArtifact(
  origin: MeetingOrigin,
  handle: string
): Promise<{ kind: ShareableKind; entityId: string; label: string; snapshot: unknown } | null> {
  if (origin.kind === 'desk') {
    const nodes = useNodeStore.getState().nodes
    const node = nodes.find((n) => n.id === origin.nodeId)
    if (!node) return null
    return {
      kind: 'folder', // a desk is a top-level folder node
      entityId: node.id,
      label: node.title || 'Desk',
      snapshot: await buildFolderSnapshot(node, nodes, handle)
    }
  }
  if (
    origin.kind === 'doc' ||
    origin.kind === 'sheet' ||
    origin.kind === 'slides' ||
    origin.kind === 'draw' ||
    origin.kind === 'design'
  ) {
    const doc = await window.api.documents.get(origin.id)
    if (!doc) return null
    return {
      kind: 'document',
      entityId: doc.id,
      label: doc.title || origin.title || 'Document',
      snapshot: buildDocumentSnapshot(doc, handle)
    }
  }
  return null
}

export async function shareArtifactWithAttendees(input: {
  origin: MeetingOrigin
  attendees: string[]
  level: MeetingAccessLevel
  // Only meaningful for the collaborate level. Defaults to downgrade-view.
  afterAccess?: MeetingAfterAccess
}): Promise<MeetingShareResult | null> {
  const emails = input.attendees.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'))
  if (emails.length === 0) return { shared: 0, emailed: 0, failed: [] }

  // Collaborate opens ONE shared object everyone edits together in real time —
  // genuine co-editing, not a copy each — consistently across every app: a
  // document / sheet / deck / drawing / design becomes a live document, and a
  // desk becomes a shared desk on the CRDT substrate. Only if the live object
  // cannot be created do we fall back to a copy share so attendees still get
  // access rather than nothing.
  const after = input.afterAccess ?? 'downgrade-view'
  // A desk collaborates by SHARING THE REAL DESK on the substrate (lock-free,
  // per-object, wires included). If the share fails it falls through to a copy
  // share below so attendees still get access rather than nothing.
  if (input.level === 'collaborate' && input.origin.kind === 'desk') {
    const desk = await collaborateDeskViaSubstrate(input.origin, emails, after)
    if (desk) return desk
  }
  if (input.level === 'collaborate' && COLLAB_LIVE_KINDS.has(input.origin.kind)) {
    const live = await collaborateLive(input.origin, emails, after)
    if (live) return live
  }

  return shareViaCopy(input.origin, emails, input.level, after)
}

// Desk collaborate on the substrate: share the real desk with the attendees by ACL
// (users become grants, non-users pending email invites), so its widgets, nodes,
// tables, rows and wires converge live across grantees with no check-out lock. The
// desk's existing wires are seeded onto the substrate by shareDeskLive. Returns null
// only when the desk node is gone, so a genuine share failure falls through to the
// copy-share path rather than silently doing nothing.
async function collaborateDeskViaSubstrate(
  origin: MeetingOrigin,
  emails: string[],
  after: MeetingAfterAccess
): Promise<MeetingShareResult | null> {
  if (origin.kind !== 'desk') return null
  const node = useNodeStore.getState().nodes.find((n) => n.id === origin.nodeId)
  if (!node) return null
  const res = await shareDeskLive(
    node.id,
    emails.map((email) => ({ email, permission: 'edit' as const })),
    'edit'
  )
  if (!res.ok || !res.access) return null
  const accountIds = res.access.grants.map((g) => g.accountId)
  const pendingEmails = res.access.pending.map((p) => p.email)
  if (after !== 'keep' && (accountIds.length > 0 || pendingEmails.length > 0)) {
    pendingDeskDowngrades.push({ rootId: node.id, accountIds, emails: pendingEmails, after })
    installMeetingEndDowngrade()
  }
  // Everyone the share resolved to (existing grants + pending invites). Per-email
  // delivery is not reported by the desk-share route, so emailed stays 0 rather than
  // asserting a delivery we did not observe.
  return { shared: accountIds.length + pendingEmails.length, emailed: 0, failed: [] }
}

// Create the live object for a meeting origin, seeded from its current content:
// a document-backed app (doc/sheet/slides/draw/design) becomes a live document
// of the SAME docType. Returns the live id, or null when the origin has no live
// document form or creation failed. A desk does NOT come through here: it shares
// the real desk on the substrate via collaborateDeskViaSubstrate.
async function createLiveForOrigin(origin: MeetingOrigin, token: string): Promise<string | null> {
  if (DOC_ORIGIN_KINDS.has(origin.kind) && 'id' in origin) {
    const doc = await window.api.documents.get(origin.id)
    if (!doc) return null
    // The live docType is the document's real type (a drawing is 'map', a design
    // is 'design'), so it opens in the matching live editor.
    const live = await createLiveDoc(token, {
      docType: doc.docType,
      title: doc.title || origin.title || 'Meeting document',
      body: JSON.stringify(doc.body ?? {})
    })
    return live?.id ?? null
  }
  return null
}

// Real co-editing: build the live object, add each attendee who is an existing
// user as an editor member, and remember them so the meeting's end can turn them
// read-only, remove them, or leave them. Attendees with no account cannot
// co-edit, so they get an editable-copy share instead.
async function collaborateLive(
  origin: MeetingOrigin,
  emails: string[],
  after: MeetingAfterAccess
): Promise<MeetingShareResult | null> {
  const token = useAccountStore.getState().sessionToken
  if (!token) return null
  const liveId = await createLiveForOrigin(origin, token)
  if (!liveId) return null

  const memberAccountIds: string[] = []
  const noAccount: string[] = []
  const failed: string[] = []
  for (const email of emails) {
    const r = await inviteToLiveDocByEmail(token, liveId, email)
    if (!r.ok) failed.push(email)
    else if (r.accountId) memberAccountIds.push(r.accountId)
    else noAccount.push(email) // not a user yet — copy-share them below
  }

  if (after !== 'keep' && memberAccountIds.length > 0) {
    pendingLiveDowngrades.push({ token, liveDocId: liveId, memberAccountIds, after })
    installMeetingEndDowngrade()
  }

  // Non-users still get the content via an editable copy so they are not shut
  // out of a meeting they were invited to.
  let shared = memberAccountIds.length
  let emailed = 0
  if (noAccount.length > 0) {
    const fb = await shareViaCopy(origin, noAccount, 'collaborate', after)
    if (fb) {
      shared += fb.shared
      emailed += fb.emailed
      failed.push(...fb.failed)
    }
  }
  return { shared, emailed, failed }
}

// The share-link path: mint one share of the artifact at the level's scope and
// invite each attendee onto it. Meeting-scoped levels (view-once, collaborate)
// are remembered so the meeting's end revokes or downgrades them precisely.
async function shareViaCopy(
  origin: MeetingOrigin,
  emails: string[],
  level: MeetingAccessLevel,
  after: MeetingAfterAccess
): Promise<MeetingShareResult | null> {
  const handle = generateAnonymousHandle()
  const artifact = await resolveArtifact(origin, handle)
  if (!artifact) return null

  // A live meeting has no set end; assume an hour so a view-once link stays
  // valid across the meeting plus the grace window in accessToShare.
  const endsAt = Date.now() + 60 * 60 * 1000
  const { scope, expiresAt } = accessToShare(level, endsAt)

  const shares = useSharesStore.getState()
  let token: string
  let shareId: string
  try {
    const link = await shares.createFor({
      kind: artifact.kind,
      entityId: artifact.entityId,
      label: artifact.label,
      scope,
      expiresAt,
      snapshot: artifact.snapshot,
      fromHandle: handle
    })
    token = link.token
    shareId = link.id
  } catch {
    return null
  }

  if (level === 'view-once') {
    pendingDowngrades.push({ shareId, after: 'revoke', snapshot: artifact.snapshot, fromHandle: handle })
    installMeetingEndDowngrade()
  } else if (level === 'collaborate' && after !== 'keep') {
    pendingDowngrades.push({ shareId, after, snapshot: artifact.snapshot, fromHandle: handle })
    installMeetingEndDowngrade()
  }

  let shared = 0
  let emailed = 0
  const failed: string[] = []
  for (const email of emails) {
    try {
      const { emailDelivered } = await shares.invite(token, email)
      shared += 1
      if (emailDelivered) emailed += 1
    } catch {
      failed.push(email)
    }
  }
  return { shared, emailed, failed }
}

// Apply the end-of-meeting behaviour to every pending collaborate grant:
// downgrade it to read-only, or revoke it. Runs when the meeting ends.
async function applyMeetingEndDowngrades(): Promise<void> {
  if (pendingDowngrades.length === 0 && pendingLiveDowngrades.length === 0 && pendingDeskDowngrades.length === 0) return

  // Share-link grants: revoke, or downgrade the copy to read-only view.
  const shareQueue = pendingDowngrades
  pendingDowngrades = []
  const shares = useSharesStore.getState()
  for (const p of shareQueue) {
    try {
      if (p.after === 'revoke') {
        // The meeting's link ends with it. If the server does not end it, say so:
        // it still works, and the person can turn it off in Share.
        const r = await shares.revoke(p.shareId)
        if (!r.ok) useNoticeStore.getState().show({ text: `A link from the meeting was not turned off. ${r.error}`, icon: 'link' }, 12_000)
      } else {
        await shares.setScope(p.shareId, 'view', { snapshot: p.snapshot, fromHandle: p.fromHandle })
      }
    } catch {
      /* a failed downgrade leaves the grant in place — non-destructive */
    }
  }

  // Live-doc collaborators: turn read-only (viewer), remove (revoke), or keep.
  const liveQueue = pendingLiveDowngrades
  pendingLiveDowngrades = []
  for (const p of liveQueue) {
    for (const accountId of p.memberAccountIds) {
      try {
        if (p.after === 'revoke') await removeLiveDocMember(p.token, p.liveDocId, accountId)
        else if (p.after === 'downgrade-view') await setLiveDocMemberRole(p.token, p.liveDocId, accountId, 'viewer')
      } catch {
        /* a failed change leaves the collaborator's access in place — non-destructive */
      }
    }
  }

  // Shared-desk grants: revoke each grant + pending invite, or re-grant everyone at
  // view-only. Same non-destructive stance — a failed change leaves access as it was.
  const deskQueue = pendingDeskDowngrades
  pendingDeskDowngrades = []
  for (const p of deskQueue) {
    try {
      if (p.after === 'revoke') {
        for (const accountId of p.accountIds) await revokeDeskAccess(p.rootId, accountId)
        for (const email of p.emails) await revokeDeskInvite(p.rootId, email)
      } else if (p.after === 'downgrade-view') {
        await shareDeskLive(
          p.rootId,
          [
            ...p.accountIds.map((accountId) => ({ accountId, permission: 'view' as const })),
            ...p.emails.map((email) => ({ email, permission: 'view' as const }))
          ],
          'view'
        )
      }
    } catch {
      /* non-destructive: a failed downgrade/revoke leaves the desk access in place */
    }
  }
}

// Watch the meeting room and run the downgrades the moment a meeting ends (the
// room status leaves 'in'). Installed lazily the first time a meeting-scoped
// collaborate grant is created, and only once per session.
export function installMeetingEndDowngrade(): void {
  if (endWatcherInstalled) return
  endWatcherInstalled = true
  let wasIn = useMeetingRoomStore.getState().status === 'in'
  useMeetingRoomStore.subscribe((state) => {
    const isIn = state.status === 'in'
    if (wasIn && !isIn) void applyMeetingEndDowngrades()
    wasIn = isIn
  })
}
