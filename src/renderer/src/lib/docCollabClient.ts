// REST client for live (collaborative) documents on the signal server. Lives in
// the renderer because it's pure fetch — main doesn't proxy network calls. Auth
// is the account session token as a Bearer header, like accountClient/messaging.

import { signalConfig } from './signalConfig'

export interface LiveDocMeta {
  id: string
  ownerAccountId: string
  docType: 'doc' | 'sheet' | 'slides' | 'map' | 'design' | 'draw' | 'canvas' | 'folder'
  title: string
  version: number
  updatedBy: string | null
  createdAt: number
  updatedAt: number
}
// A member of a live document/folder (the co-editor list). Historically named for
// the old lock holder; it is now just the member shape.
export interface LockHolder {
  accountId: string
  handle: string
  firstName?: string | null
  lastName?: string | null
  /**
   * The member's access. Returned by the server as of signal v123; absent
   * from an older server, and an absent role means EDITOR — every member
   * could write before roles existed, so treating a missing role as a viewer
   * would lock the existing population out of their own documents.
   */
  role?: 'owner' | 'editor' | 'viewer'
}
export interface LiveDocFull extends LiveDocMeta {
  body: string
  members: LockHolder[]
  /**
   * THIS account's access to the document (signal v123). Until it existed
   * nothing exposed a role at all, so every member — viewers included — was
   * handed a full editor. Optional for the same reason as above: against an
   * older server it is absent, and absent means editor.
   */
  myRole?: 'owner' | 'editor' | 'viewer'
}

/** Is this account allowed to change the document? Absent role means yes. */
export function canEditLiveDoc(role: LiveDocFull['myRole']): boolean {
  return role !== 'viewer'
}

/**
 * What this account may do with a live document, from its own role.
 *
 * A separate function rather than two lines in the view because the view can
 * only render an editor once the Yjs engine has produced a body, so a test
 * that mounts it cannot reach the props it passes down. This decision is the
 * part that must be right, so it is testable on its own — the same reason
 * yjsDocAuth.ts exists on the server.
 */
export function liveDocAccess(meta: Pick<LiveDocFull, 'docType' | 'myRole'> | null): {
  viewerOnly: boolean
  canComment: boolean
} {
  const viewerOnly = !!meta && !canEditLiveDoc(meta.myRole)
  return {
    viewerOnly,
    // Comments are a document-only feature for now, and not for a viewer: a
    // comment ANCHOR is a mark in the body, so a viewer's thread would be
    // created over REST while the server dropped its anchor — a thread
    // pointing at a span nobody else can see. Real viewer comments need an
    // anchor that is not a body write.
    canComment: !!meta && meta.docType === 'doc' && !viewerOnly
  }
}
export type LiveDocListItem = LiveDocMeta

function urlFor(path: string): string {
  return signalConfig.httpUrl.replace(/\/+$/, '') + path
}

// Returns the parsed JSON plus ok/status so callers can branch on 409 (locked).
async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  token: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; json: T | null }> {
  try {
    const res = await fetch(urlFor(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    let json: T | null = null
    try {
      json = (await res.json()) as T
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json }
  } catch {
    return { ok: false, status: 0, json: null }
  }
}

export async function createLiveDoc(
  token: string,
  input: { docType: string; title: string; body: string }
): Promise<LiveDocMeta | null> {
  const { json } = await call<{ ok: boolean; doc?: LiveDocMeta }>('POST', '/livedocs', token, input)
  return json?.ok ? json.doc ?? null : null
}

// Ensure a CRDT room exists for an org-shared document, reusing the document's own
// id as the live-doc id. Idempotent on the server. Sends x-plexi-org so the server
// resolves the doc's org and grants the whole org edit access. Returns the room
// meta on success, or null if this account cannot make the doc live (not an org
// member, offline, etc.) so the caller can fall back to the plain LWW editor.
export async function ensureOrgLiveDoc(
  token: string,
  id: string,
  orgId: string,
  input: { docType: string; title: string; body: string }
): Promise<LiveDocMeta | null> {
  try {
    const res = await fetch(urlFor(`/livedocs/${id}/ensure-org`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-plexi-org': orgId
      },
      body: JSON.stringify(input)
    })
    if (!res.ok) return null
    const json = (await res.json()) as { ok: boolean; doc?: LiveDocMeta }
    return json?.ok ? json.doc ?? null : null
  } catch {
    return null
  }
}

export async function listLiveDocs(token: string): Promise<LiveDocListItem[]> {
  const { json } = await call<{ ok: boolean; docs?: LiveDocListItem[] }>('GET', '/livedocs', token)
  return json?.ok ? json.docs ?? [] : []
}

export async function getLiveDoc(token: string, id: string): Promise<LiveDocFull | null> {
  const { json } = await call<{ ok: boolean; doc?: LiveDocFull }>('GET', `/livedocs/${id}`, token)
  return json?.ok ? json.doc ?? null : null
}


// Persist a CRDT snapshot of the body (co-editing path). Lock-free; the server
// stores it without notifying anyone, so the live editors aren't disrupted.
export async function snapshotLiveBody(token: string, id: string, body: string): Promise<void> {
  await call('PUT', `/livedocs/${id}/snapshot`, token, { body })
}

// ── Comments ────────────────────────────────────────────────────────────────
export interface DocComment {
  id: string
  docId: string
  authorAccountId: string
  parentId: string | null
  body: string
  resolved: boolean
  createdAt: number
}

export async function listComments(token: string, docId: string): Promise<DocComment[]> {
  const { json } = await call<{ ok: boolean; comments?: DocComment[] }>('GET', `/livedocs/${docId}/comments`, token)
  return json?.comments ?? []
}

export async function addComment(
  token: string,
  docId: string,
  body: string,
  opts?: { id?: string; parentId?: string }
): Promise<DocComment | null> {
  const { json } = await call<{ ok: boolean; comment?: DocComment }>('POST', `/livedocs/${docId}/comments`, token, {
    body,
    id: opts?.id,
    parentId: opts?.parentId
  })
  return json?.comment ?? null
}

export async function resolveComment(token: string, commentId: string, resolved: boolean): Promise<void> {
  await call('POST', `/livedocs/comments/${commentId}/resolve`, token, { resolved })
}

export async function deleteComment(token: string, commentId: string): Promise<void> {
  await call('DELETE', `/livedocs/comments/${commentId}`, token)
}

export async function renameLiveDoc(token: string, id: string, title: string): Promise<void> {
  await call('POST', `/livedocs/${id}/title`, token, { title })
}

export async function inviteToLiveDoc(
  token: string,
  id: string,
  handle: string
): Promise<{ ok: boolean; member?: LockHolder; error?: string }> {
  const { json } = await call<{ ok: boolean; member?: LockHolder; error?: string }>(
    'POST',
    `/livedocs/${id}/invite`,
    token,
    { handle }
  )
  return { ok: !!json?.ok, member: json?.member, error: json?.error }
}

// Invite by email (the meeting-collaborate flow, whose attendees are emails).
// Returns the invited account id when the email belongs to an existing user
// (they become a co-editor), or null when there is no account yet.
export async function inviteToLiveDocByEmail(
  token: string,
  id: string,
  email: string
): Promise<{ ok: boolean; accountId: string | null; error?: string }> {
  const { json } = await call<{ ok: boolean; accountId?: string | null; error?: string }>(
    'POST',
    `/livedocs/${id}/invite-email`,
    token,
    { email }
  )
  return { ok: !!json?.ok, accountId: json?.accountId ?? null, error: json?.error }
}

// Downgrade (viewer) or restore (editor) a member's access. Used to turn a
// meeting's collaborators read-only when the meeting ends.
export async function setLiveDocMemberRole(
  token: string,
  id: string,
  accountId: string,
  role: 'editor' | 'viewer'
): Promise<boolean> {
  const { json } = await call<{ ok: boolean }>('POST', `/livedocs/${id}/members/${accountId}/role`, token, { role })
  return !!json?.ok
}

// Remove a member entirely (revoke access).
export async function removeLiveDocMember(token: string, id: string, accountId: string): Promise<boolean> {
  const { json } = await call<{ ok: boolean }>('DELETE', `/livedocs/${id}/members/${accountId}`, token)
  return !!json?.ok
}
