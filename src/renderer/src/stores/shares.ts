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
  revoke: (id: string) => Promise<void>
  // Change a share's scope (e.g. downgrade a meeting-scoped collaborate grant to
  // read-only when the meeting ends). Updates the local row and, when the remote
  // snapshot + handle are supplied, re-upserts the same token on the server so
  // the change reaches recipients too.
  setScope: (id: string, scope: ShareScope, remote?: { snapshot: unknown; fromHandle: string }) => Promise<void>
  remove: (id: string) => Promise<void>
  removeFromInbox: (id: string) => Promise<void>
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
    const target = get().outgoing.find((s) => s.id === id) ?? null
    await window.api.shares.revoke(id)
    set({
      outgoing: get().outgoing.map((s) =>
        s.id === id ? { ...s, revoked: true } : s
      )
    })
    // Best-effort remote revoke. Local row is already marked revoked
    // either way; the share manager UI shows the audit trail.
    const service = getShareService()
    if (service && target) {
      try {
        await service.revoke(target.token)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[SharesStore] remote revoke failed:', err)
      }
    }
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
    await window.api.shares.delete(id)
    set({ outgoing: get().outgoing.filter((s) => s.id !== id) })
  },
  removeFromInbox: async (id) => {
    await window.api.shares.removeInbox(id)
    set({ inbox: get().inbox.filter((s) => s.id !== id) })
  }
}))
