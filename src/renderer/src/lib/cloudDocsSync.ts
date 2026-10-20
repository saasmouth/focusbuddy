// Cloud-document sync orchestration (PlexiOffice split, Phase 0). Bridges the
// local document store (window.api.documents, SQLite) with the account's cloud
// documents on the signal server, so the same docs are available in PlexiDesk and
// the standalone PlexiOffice app.
//
// Default-ON with an opt-out flag (Settings > Documents sync): with the flag
// off, nothing here runs and documents are local-only. With it on (the default)
// and a signed-in account, the store pulls on refresh and pushes on save, which
// is also what feeds the mobile web app's Documents tab. The local SQLite stays
// the offline source of truth; the cloud is the cross-app/device mirror.
//
// Sync contract (mirrors the server): last-write-wins with a per-document `rev`.
// We track the rev we last saw per id; a push sends it as baseRev so a stale
// write is rejected as a conflict, in which case the server copy wins and is
// applied locally (single-user multi-device — conflicts are rare and server-wins
// + re-pull is the safe resolution).

import type { DocType, FbDocument } from '@shared/types'
import { initPreviewGuard, previewSyncBlocked } from './previewGuard'
import { localOnlyMode } from './localOnlyMode'
import {
  syncCloudDocs,
  putCloudDoc,
  deleteCloudDoc,
  type CloudDocument,
  type CloudDocType
} from './cloudDocsClient'
import { useAccountStore } from '../stores/account'
import { useOrgStore, PERSONAL_ORG_ID } from '../stores/org'

const FLAG_KEY = 'fb.clouddocs.enabled'
const CURSOR_KEY = 'fb.clouddocs.cursor'
const REVS_KEY = 'fb.clouddocs.revs'

// Default-ON with explicit opt-out (flipped 2026-07-08 for the mobile web app,
// which reads personal documents from the cloud copy). Only a stored '0' — the
// user unticking the Settings toggle — disables it; absent means on.
export function cloudDocsEnabled(): boolean {
  try {
    if (previewSyncBlocked()) return false
    // "Keep this device local" pauses the personal documents mirror too.
    if (localOnlyMode()) return false
    return localStorage.getItem(FLAG_KEY) !== '0'
  } catch {
    return false
  }
}
export function setCloudDocsEnabled(on: boolean): void {
  try {
    localStorage.setItem(FLAG_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

function token(): string | null {
  return useAccountStore.getState().sessionToken
}

// Cloud-docs is the personal-scope document mirror (PlexiDesk <-> standalone
// PlexiOffice). Org documents sync through the org workspace loop instead, so
// when a real org is active this whole path goes dormant to avoid double-syncing
// an org document. Documents shown/edited are always in the active org (the store
// is org-scoped), so "active org is personal" is exactly "these docs are
// personal". Personal scope keeps its existing behavior unchanged.
function docScopeIsPersonal(): boolean {
  try {
    return (useOrgStore.getState().activeOrgId || PERSONAL_ORG_ID) === PERSONAL_ORG_ID
  } catch {
    return true
  }
}
// Sync only runs when the flag is on AND the user is signed in (cloud docs are
// account-scoped).
export function cloudSyncActive(): boolean {
  return cloudDocsEnabled() && !!token()
}

function getCursor(): number {
  try {
    return Number(localStorage.getItem(CURSOR_KEY) ?? '0') || 0
  } catch {
    return 0
  }
}
function setCursor(n: number): void {
  try {
    localStorage.setItem(CURSOR_KEY, String(n))
  } catch {
    /* noop */
  }
}

function readRevs(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(REVS_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}
function writeRevs(map: Record<string, number>): void {
  try {
    localStorage.setItem(REVS_KEY, JSON.stringify(map))
  } catch {
    /* noop */
  }
}
export function knownRev(id: string): number | undefined {
  return readRevs()[id]
}
function recordRev(id: string, rev: number): void {
  const m = readRevs()
  m[id] = rev
  writeRevs(m)
}
function forgetRev(id: string): void {
  const m = readRevs()
  delete m[id]
  writeRevs(m)
}

// PURE: turn a batch of cloud changes into local apply actions. Tombstones become
// deletes, live docs become upserts. Exported so the merge can be unit-tested
// without touching the store or the network.
export type SyncAction =
  | { kind: 'delete'; id: string }
  | { kind: 'upsert'; doc: CloudDocument }

export function planFromChanges(changes: CloudDocument[]): SyncAction[] {
  return changes.map((d) =>
    d.deleted ? { kind: 'delete', id: d.id } : { kind: 'upsert', doc: d }
  )
}

// Apply one cloud document to the local store + rev map.
async function applyLocal(action: SyncAction): Promise<void> {
  if (action.kind === 'delete') {
    await window.api.documents.delete(action.id)
    forgetRev(action.id)
    return
  }
  const d = action.doc
  await window.api.documents.upsert({
    id: d.id,
    docType: d.docType as DocType,
    title: d.title,
    body: d.body,
    updatedAt: d.updatedAt
  })
  recordRev(d.id, d.rev)
}

// Pull every change since our cursor and apply it locally. Returns the number of
// documents applied (0 when nothing changed or sync is inactive/offline).
export async function pullCloudDocs(): Promise<number> {
  const t = token()
  if (!cloudDocsEnabled() || !t || !docScopeIsPersonal()) return 0
  const res = await syncCloudDocs(t, getCursor())
  if (!res) return 0 // offline / transport failure — keep cursor, retry later
  for (const action of planFromChanges(res.documents)) await applyLocal(action)
  setCursor(res.now)
  return res.documents.length
}

// Push one local document up. On a rev conflict the server copy wins and is
// applied locally (and returned so the caller can refresh its view).
export async function pushCloudDoc(doc: FbDocument): Promise<{ conflictedTo?: FbDocument }> {
  const t = token()
  if (!cloudDocsEnabled() || !t || !docScopeIsPersonal()) return {}
  const res = await putCloudDoc(t, {
    id: doc.id,
    docType: doc.docType as CloudDocType,
    title: doc.title,
    body: doc.body,
    baseRev: knownRev(doc.id)
  })
  if (res.ok) {
    recordRev(doc.id, res.document.rev)
    return {}
  }
  if (res.conflict) {
    // Server is newer — take it (server-wins) and apply locally.
    await applyLocal({ kind: 'upsert', doc: res.document })
    const local = await window.api.documents.get(doc.id)
    return { conflictedTo: local ?? undefined }
  }
  return {}
}

// Mirror a local delete to the cloud (tombstone).
export async function pushCloudDelete(id: string): Promise<void> {
  const t = token()
  if (!cloudDocsEnabled() || !t || !docScopeIsPersonal()) return
  await deleteCloudDoc(t, id)
  forgetRev(id)
}

initPreviewGuard()
