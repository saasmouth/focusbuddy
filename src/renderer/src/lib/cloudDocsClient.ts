// Client for the personal cloud-documents service on the signal server (Phase 0
// of the PlexiOffice split — see docs/plexioffice-split-scope.md). These are the
// account-scoped, single-owner synced documents that both PlexiDesk and the
// standalone PlexiOffice app read/write, so the same docs are available in either.
//
// Same auth + transport convention as docCollabClient/messaging: the account
// session token goes on an Authorization: Bearer header. This module is the wire
// layer only; the store-level sync orchestration (merging cloud changes into the
// local document DB, conflict UX) lands in the next phase and builds on these.

import { signalConfig } from './signalConfig'

export type CloudDocType = 'doc' | 'sheet' | 'slides' | 'map'

export interface CloudDocument {
  id: string
  docType: CloudDocType
  title: string
  body: unknown
  rev: number
  deleted: boolean
  createdAt: number
  updatedAt: number
}

function urlFor(path: string): string {
  return signalConfig.httpUrl.replace(/\/+$/, '') + path
}

async function call<T>(
  method: 'GET' | 'PUT' | 'DELETE',
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

// Full snapshot of the account's non-deleted documents.
export async function listCloudDocs(token: string): Promise<CloudDocument[]> {
  const { json } = await call<{ ok: boolean; documents?: CloudDocument[] }>('GET', '/documents', token)
  return json?.ok ? json.documents ?? [] : []
}

// Delta sync: everything (including tombstones) changed after `since` (ms), plus
// the new cursor `now` to pass on the next call. Returns null on a transport
// failure so the caller can keep its current cursor and retry later.
export async function syncCloudDocs(
  token: string,
  since: number
): Promise<{ documents: CloudDocument[]; now: number } | null> {
  const { ok, json } = await call<{ ok: boolean; documents?: CloudDocument[]; now?: number }>(
    'GET',
    `/documents/sync?since=${encodeURIComponent(String(since))}`,
    token
  )
  if (!ok || !json?.ok || typeof json.now !== 'number') return null
  return { documents: json.documents ?? [], now: json.now }
}

export async function getCloudDoc(token: string, id: string): Promise<CloudDocument | null> {
  const { json } = await call<{ ok: boolean; document?: CloudDocument }>('GET', `/documents/${id}`, token)
  return json?.ok ? json.document ?? null : null
}

export type PutCloudDocResult =
  | { ok: true; document: CloudDocument }
  | { ok: false; conflict: true; document: CloudDocument }
  | { ok: false; conflict: false }

// Upsert by id. Pass the `baseRev` you last saw so a stale write is rejected as a
// conflict (409) carrying the server's current copy, rather than clobbering it.
export async function putCloudDoc(
  token: string,
  input: { id: string; docType: CloudDocType; title: string; body: unknown; baseRev?: number }
): Promise<PutCloudDocResult> {
  const { id, ...rest } = input
  const { status, json } = await call<{ ok: boolean; conflict?: boolean; document?: CloudDocument }>(
    'PUT',
    `/documents/${id}`,
    token,
    rest
  )
  if (status === 409 && json?.document) return { ok: false, conflict: true, document: json.document }
  if (json?.ok && json.document) return { ok: true, document: json.document }
  return { ok: false, conflict: false }
}

// Tombstone the document so the delete propagates to the account's other devices.
// Returns the tombstone's rev, or null when the delete did not go (offline, or
// refused). A restore goes up at that rev: the signal refuses a blind revive.
export async function deleteCloudDoc(token: string, id: string): Promise<number | null> {
  const { json } = await call<{ ok: boolean; document?: CloudDocument }>('DELETE', `/documents/${id}`, token)
  return json?.ok ? (json.document?.rev ?? 0) : null
}
