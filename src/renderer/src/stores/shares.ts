import { create } from 'zustand'
import type {
  ShareableKind,
  ShareLink,
  SharedItem,
  ShareScope
} from '@shared/types'
import { generateShareToken } from '../lib/shareTokens'
import { ShareService, type ShareRecipientDto } from '../lib/shareService'
import { signalConfig } from '../lib/signalConfig'
import { useAccountStore } from './account'
import { useNoticeStore } from './notice'

// ShareService singleton — null in local-mock dev mode (no server),
// instantiated in prod / when explicitly configured. Created lazily so
// the renderer doesn't open a connection until the user actually uses
// the feature.
let svc: ShareService | null = null
function getShareService(): ShareService | null {
  if (!signalConfig.useRemote) return null
  if (!svc) svc = new ShareService(signalConfig.httpUrl)
  return svc
}

// The desk or room a link is of, so deleting it ends the link (owner, 24 Nov
// 2026: deleting a desk or room ends its links at once; the signal does it when
// the desk's delete arrives). A desk or room: itself. Deleting a room trashes
// every desk under it, and each of those deletes ends that desk's own links. A
// widget: the desk it is on, which takes it when deleted. Documents, document
// folders and Drive files are not desks: none.
async function shareRootId(kind: ShareableKind, entityId: string): Promise<string | undefined> {
  if (kind === 'task' || kind === 'folder') return entityId
  if (kind !== 'widget') return undefined
  try {
    return (await window.api.widgets.get(entityId))?.taskId || undefined
  } catch {
    return undefined // not found: the link is still made, and ends at revoke or expiry
  }
}

// ── Ending a link on the server ────────────────────────────────────────────
// Up to 4.3.54 a revoke sent no session, the server (owner-only since 8 Sept
// 2026) refused it, and the app listed the link as off while it still opened.
// Now a link is listed as off only once the server has ended it.

export type LinkEndResult = { ok: true } | { ok: false; error: string }

type EndOutcome = 'ended' | 'local' | 'notOurs' | 'otherAccount' | 'refused' | 'unreachable' | 'signIn'

// Links whose end the server has confirmed (never asked again), and links
// already said to still work after a 404 (said once; still tried each launch,
// since the server may later let this account end them). Per device.
const REPAIRED_KEY = 'plexii.shares.revokeRepaired'
const STILL_OPEN_SAID_KEY = 'plexii.shares.revokeStillOpenSaid'

function readTokens(key: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
function writeTokens(key: string, tokens: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...tokens]))
  } catch {
    /* storage unavailable: the repair sends again next launch, which is harmless */
  }
}
function noteEnded(token: string): void {
  const done = readTokens(REPAIRED_KEY)
  done.add(token)
  writeTokens(REPAIRED_KEY, done)
}

async function endOnServer(link: Pick<ShareLink, 'token' | 'createdBy'>): Promise<EndOutcome> {
  const service = getShareService()
  if (!service) return 'local' // no server configured (local development): nothing hosted to end
  const { sessionToken, account } = useAccountStore.getState()
  // Made by another account on this computer: only that account can end it, and
  // asking as this one would get a 404 that looks like success. Wait for it.
  if (sessionToken && link.createdBy && account?.handle && link.createdBy !== account.handle) return 'otherAccount'
  const res = await service.revoke(link.token, sessionToken ?? null)
  if (res.ok) return 'ended'
  if (res.status === 0) return 'unreachable'
  if (res.status === 401) return 'signIn'
  if (res.status !== 404) return 'refused'
  const gone = await service.isGone(link.token)
  return gone === true ? 'ended' : gone === false ? 'notOurs' : 'unreachable'
}

function stillWorks(out: EndOutcome, link: Pick<ShareLink, 'expiresAt'>): string {
  switch (out) {
    case 'signIn':
      return 'Sign in to stop sharing this link. Until then it still works.'
    case 'otherAccount':
      return 'Another account on this computer made this link. Sign in as that account to turn it off. Until then it still works.'
    case 'unreachable':
      return 'Plexii could not reach the server, so this link still works. Try again when you are online.'
    case 'notOurs': {
      const until =
        link.expiresAt != null
          ? ` It stops working on ${new Date(link.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.`
          : ''
      return `This link can't be turned off from this account, so it still works.${until}`
    }
    default:
      return 'The server did not turn this link off, so it still works. Try again in a moment.'
  }
}

let repairing = false

/**
 * Re-send, signed in, the revokes the app made before 4.3.55, which the server
 * refused. Once per link: an ended link (200, or 404 with the link gone) is done;
 * any other answer is tried again next launch, never marked done. A link that
 * still opens after a 404 is not this account's to end: it is said once and not
 * retried. Runs at sign-in (App.tsx).
 */
export async function repairRevokedLinks(): Promise<void> {
  if (repairing || !getShareService() || !useAccountStore.getState().sessionToken) return
  repairing = true
  try {
    const rows = await window.api.shares.listAll()
    const done = readTokens(REPAIRED_KEY)
    const said = readTokens(STILL_OPEN_SAID_KEY)
    let stillOpen = 0
    for (const r of rows) {
      if (!r.revoked || done.has(r.token)) continue
      const out = await endOnServer(r)
      if (out === 'ended') done.add(r.token)
      else if (out === 'notOurs' && !said.has(r.token)) {
        said.add(r.token)
        stillOpen++
      } else if (out === 'signIn') break // this session no longer counts: the next sign-in tries again
      // anything else (refused, unreachable, another account's): tried again next launch
    }
    writeTokens(REPAIRED_KEY, done)
    writeTokens(STILL_OPEN_SAID_KEY, said)
    if (stillOpen > 0) {
      useNoticeStore.getState().show(
        {
          text:
            stillOpen === 1
              ? "1 link you turned off still works. The server won't let this account end it yet; Plexii tries again each time you open it."
              : `${stillOpen} links you turned off still work. The server won't let this account end them yet; Plexii tries again each time you open it.`,
          icon: 'link_off'
        },
        12_000
      )
    }
  } catch {
    /* nothing sent is marked done: the next launch tries again */
  } finally {
    repairing = false
  }
}

interface SharesStore {
  // Outgoing shares — links I've minted for my own entities.
  outgoing: ShareLink[]
  // Incoming — items shared with me by others (the "Shared with me" sidebar).
  inbox: SharedItem[]
  // Named recipients per shared entity id (for the owner-side avatars). Keyed
  // by node/widget id; merged across all of that entity's active share links.
  recipientsByEntity: Record<string, ShareRecipientDto[]>
  loaded: boolean
  refresh: () => Promise<void>
  // Pull recipient lists for all active outgoing shares from the server.
  refreshRecipients: () => Promise<void>
  // Invite someone to a share by email — records them + sends the email.
  invite: (token: string, email: string) => Promise<{ recipient: ShareRecipientDto; emailDelivered: boolean }>
  // Mint a new share link for one of my entities. Returns the created
  // link; the dialog then copies its URL. When the remote service is
  // configured, also posts the snapshot up so other users can resolve
  // the token from the wider internet.
  createFor: (input: {
    kind: ShareableKind
    entityId: string
    label: string
    scope: ShareScope
    expiresAt?: number | null
    // Snapshot of the entity at share-time. Posted to the server so the
    // viewer URL resolves to actual content. In local-mock mode this is
    // dropped on the floor — only the local outgoing table tracks it.
    snapshot?: unknown
    fromHandle?: string
    // The sharer's real handle, stamped on the share for "invited by X"
    // attribution. Distinct from fromHandle (the recipient-facing snapshot name).
    createdBy?: string | null
    // For a raw-file share (kind 'file'): the bytes to host publicly against the
    // minted token, so the viewer can preview/download the file. Uploaded after
    // the snapshot mint; a failure is non-fatal (the metadata still resolves).
    fileBlob?: { bytes: ArrayBuffer; mimeType: string; ext: string }
  }) => Promise<ShareLink>
  // Accept a pasted share link. Fetches the snapshot from the server (when
  // remote is configured) or treats the token as opaque (local-mock).
  // Adds the resolved item to the inbox + local DB.
  acceptByToken: (token: string) => Promise<SharedItem>
  // Turn a link off. Listed as off only once the server has ended it; otherwise
  // the link stays live and the result says why, in words to show.
  revoke: (id: string) => Promise<LinkEndResult>
  // Change a share's scope (e.g. downgrade a meeting-scoped collaborate grant to
  // read-only when the meeting ends). Updates the local row and, when the remote
  // snapshot + handle are supplied, re-upserts the same token on the server so
  // the change reaches recipients too.
  setScope: (id: string, scope: ShareScope, remote?: { snapshot: unknown; fromHandle: string }) => Promise<void>
  // Remove a link from the list. A live one is turned off first; one the server
  // will not end is not removed, since it would go on working out of sight.
  remove: (id: string) => Promise<LinkEndResult>
  removeFromInbox: (id: string) => Promise<void>
}

// The link by id, reading the list first if it has not been read yet.
async function findLink(id: string): Promise<ShareLink | null> {
  const st = useSharesStore.getState()
  let found = st.outgoing.find((s) => s.id === id) ?? null
  if (!found) {
    await st.refresh()
    found = useSharesStore.getState().outgoing.find((s) => s.id === id) ?? null
  }
  return found
}

export const useSharesStore = create<SharesStore>((set, get) => ({
  outgoing: [],
  inbox: [],
  recipientsByEntity: {},
  loaded: false,
  refresh: async () => {
    const [outgoing, inbox] = await Promise.all([
      window.api.shares.listAll(),
      window.api.shares.inbox()
    ])
    set({ outgoing, inbox, loaded: true })
    void get().refreshRecipients()
  },
  refreshRecipients: async () => {
    const service = getShareService()
    const sessionToken = useAccountStore.getState().sessionToken
    if (!service || !sessionToken) {
      set({ recipientsByEntity: {} })
      return
    }
    const active = get().outgoing.filter((s) => !s.revoked)
    const tokens = active.map((s) => s.token)
    if (tokens.length === 0) {
      set({ recipientsByEntity: {} })
      return
    }
    try {
      const byToken = await service.recipients(tokens, sessionToken)
      const byEntity: Record<string, ShareRecipientDto[]> = {}
      for (const s of active) {
        const recs = byToken[s.token] ?? []
        const list = byEntity[s.entityId] ?? (byEntity[s.entityId] = [])
        for (const r of recs) {
          if (!list.some((x) => x.email === r.email)) list.push(r)
        }
      }
      set({ recipientsByEntity: byEntity })
    } catch {
      /* best-effort — avatars just won't show */
    }
  },
  invite: async (token, email) => {
    const service = getShareService()
    if (!service) throw new Error('Sharing service not configured.')
    const sessionToken = useAccountStore.getState().sessionToken
    if (!sessionToken) throw new Error('Sign in to invite people by email.')
    const result = await service.invite(token, email, sessionToken)
    await get().refreshRecipients()
    return result
  },
  createFor: async ({
    kind,
    entityId,
    label,
    scope,
    expiresAt,
    snapshot,
    fromHandle,
    createdBy,
    fileBlob
  }) => {
    const token = generateShareToken()
    // Local persistence first — this is the audit-of-record for the
    // owner, and we want it to land even if the network call below fails.
    const created = await window.api.shares.create({
      token,
      kind,
      entityId,
      label,
      scope,
      expiresAt: expiresAt ?? null,
      createdBy: createdBy ?? null
    })
    set({ outgoing: [created, ...get().outgoing] })
    // Then push the snapshot to the hosted service (when configured) so
    // recipients can actually resolve the link. Failure here is non-fatal
    // — the local row stays valid; the user can retry later.
    const service = getShareService()
    if (service && snapshot !== undefined) {
      try {
        const rootId = await shareRootId(kind, entityId)
        await service.mint(
          {
            token,
            kind,
            snapshot,
            fromHandle: fromHandle ?? 'anonymous',
            scope,
            expiresAt: expiresAt ?? null,
            createdBy: createdBy ?? null,
            ...(rootId ? { rootId } : {})
          },
          useAccountStore.getState().sessionToken
        )
        // A raw-file share hosts its bytes publicly against the token so the
        // viewer can render/download them. Only after the snapshot mint
        // succeeded (the token now resolves); a failed upload is non-fatal.
        if (fileBlob && kind === 'file') {
          const sessionToken = useAccountStore.getState().sessionToken
          if (sessionToken) {
            await service.uploadFileBlob(token, fileBlob.bytes, fileBlob.mimeType, fileBlob.ext, sessionToken)
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[SharesStore] remote mint failed:', err)
      }
    }
    return created
  },
  acceptByToken: async (token) => {
    // Remote path: hit the server to get the actual snapshot the owner
    // shared. Local-mock path: insert a stub (the dev experience is "you
    // can paste your own link to see the inbox row land", not actual
    // cross-user resolution).
    const service = getShareService()
    let snapshot: unknown = { placeholder: true }
    let kind: ShareableKind = 'task'
    let fromHandle = 'someone'
    let scope: ShareScope = 'view'
    if (service) {
      const remote = await service.lookup(token)
      snapshot = remote.snapshot
      kind = remote.kind
      fromHandle = remote.fromHandle
      scope = remote.scope
    }
    const item = await window.api.shares.accept({
      token,
      kind,
      snapshot,
      fromHandle,
      scope
    })
    set({ inbox: [item, ...get().inbox] })
    return item
  },
  revoke: async (id) => {
    const target = await findLink(id)
    if (!target) return { ok: false, error: 'That link is no longer in the list.' }
    if (target.revoked) return { ok: true }
    const out = await endOnServer(target)
    if (out !== 'ended' && out !== 'local') return { ok: false, error: stillWorks(out, target) }
    if (out === 'ended') noteEnded(target.token)
    await window.api.shares.revoke(id)
    set({ outgoing: get().outgoing.map((s) => (s.id === id ? { ...s, revoked: true } : s)) })
    return { ok: true }
  },
  setScope: async (id, scope, remote) => {
    const updated = await window.api.shares.setScope(id, scope)
    if (!updated) return
    set({ outgoing: get().outgoing.map((s) => (s.id === id ? { ...s, scope } : s)) })
    // Best-effort remote re-upsert so recipients see the new scope. Re-minting
    // the SAME token updates the existing server record (scope = excluded.scope).
    const service = getShareService()
    if (service && remote) {
      try {
        await service.mint(
          {
            token: updated.token,
            kind: updated.kind,
            snapshot: remote.snapshot,
            fromHandle: remote.fromHandle,
            scope,
            expiresAt: updated.expiresAt
          },
          useAccountStore.getState().sessionToken
        )
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[SharesStore] remote scope update failed:', err)
      }
    }
  },
  remove: async (id) => {
    const target = await findLink(id)
    // Ask the server unless it has already confirmed this link ended: a live link,
    // or one listed as off by an app that never reached the server.
    if (target && !readTokens(REPAIRED_KEY).has(target.token)) {
      const out = await endOnServer(target)
      if (out === 'ended') noteEnded(target.token)
      // Already listed as off and not this account's to end: the row is all that goes.
      else if (!(out === 'local' || (out === 'notOurs' && target.revoked))) {
        return { ok: false, error: stillWorks(out, target) }
      }
    }
    await window.api.shares.delete(id)
    set({ outgoing: get().outgoing.filter((s) => s.id !== id) })
    return { ok: true }
  },
  removeFromInbox: async (id) => {
    await window.api.shares.removeInbox(id)
    set({ inbox: get().inbox.filter((s) => s.id !== id) })
  }
}))
