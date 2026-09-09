import { signalConfig } from './signalConfig'
import { rootsToPrune } from '@shared/sharedDesks'
import { initPreviewGuard, previewSyncBlocked } from './previewGuard'
import { useSyncStatus } from '../stores/syncStatus'
import { useAccountStore } from '../stores/account'
import { useNodeStore } from '../stores/nodes'
import { useWorkItemStore } from '../stores/workItems'
import { useWidgetStore } from '../stores/widgets'
import { useTimeBlockStore } from '../stores/timeBlocks'
import { useDocumentsStore } from '../stores/documents'
import { useTablesStore } from '../stores/tables'
import { useFileManagerStore } from '../stores/fileManager'
import { useOrgStore, PERSONAL_ORG_ID } from '../stores/org'
import { setOrgWorkspaceChangedHandler, setSharedWorkspaceChangedHandler } from './messagingSocket'
import { registerSyncNudge } from './syncNudge'
import { syncWakeCoalescer } from './syncWakeCoalescer'

// Every item type carried over the sync transport. The personal loop has always
// carried node and widget; rung 2 added document, table and row alongside the
// rung-1 timeblock, and rung 3 routes node and widget down the org loop too. The
// transport is type-agnostic (a JSON body plus this discriminator), so the union
// already covers every type either loop sends.
type SyncItemType = 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'

// Renderer half of multi-device workspace sync. It owns the network (it has the
// signal URL + session token); the main process owns the local SQLite and exposes
// it over window.api.workspace. Each cycle pushes locally-changed rows, then pulls
// everything changed on the server since our cursor and applies it, then refreshes
// the stores so the UI reflects the merged state.
//
// Model mirrors cloud-documents: per-item monotonic rev with last-write-wins
// (server wins on a conflict), tombstones for deletes, an updated_at cursor.
// Default-on for any signed-in account; a flag lets it be turned off.

const FLAG_KEY = 'fb.workspace.sync'
const SYNC_INTERVAL_MS = 20_000
// How many consecutive fruitless retries of the same window before giving up on
// it. Small: the case this exists for -- a child whose parent is later in the
// same batch -- is fixed by ordering, so a persistent failure here is a genuine
// problem to surface rather than to keep retrying quietly.
const MAX_APPLY_STALLS = 3
let applyStalls = 0

function enabled(): boolean {
  if (previewSyncBlocked()) return false
  return localStorage.getItem(FLAG_KEY) !== '0'
}
export function setWorkspaceSyncEnabled(on: boolean): void {
  localStorage.setItem(FLAG_KEY, on ? '1' : '0')
}

function urlFor(path: string): string {
  return signalConfig.httpUrl.replace(/\/+$/, '') + path
}

interface ServerItem {
  id: string
  itemType: SyncItemType
  body: Record<string, unknown> | null
  rev: number
  deleted: boolean
  teamId?: string | null
  rootId?: string | null
}

async function pullChanges(token: string, since: number): Promise<{ items: ServerItem[]; now: number } | null> {
  try {
    const res = await fetch(urlFor(`/workspace/sync?since=${since}`), {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) {
      noteServerError()
      return null
    }
    const json = (await res.json()) as { ok: boolean; items?: ServerItem[]; now?: number }
    if (!json.ok) {
      noteServerError()
      return null
    }
    return { items: json.items ?? [], now: json.now ?? since }
  } catch {
    noteOffline()
    return null
  }
}

type PutResult =
  | { ok: true; rev: number }
  | { ok: false; conflict: true; item: ServerItem }
  | { ok: false; conflict: false }

async function putItem(
  token: string,
  id: string,
  itemType: SyncItemType,
  body: Record<string, unknown>,
  baseRev: number
): Promise<PutResult> {
  try {
    const res = await fetch(urlFor(`/workspace/items/${id}`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemType, body, baseRev: baseRev || undefined })
    })
    if (res.status === 409) {
      const json = (await res.json()) as { item?: ServerItem }
      if (json.item) return { ok: false, conflict: true, item: json.item }
      return { ok: false, conflict: false }
    }
    if (!res.ok) {
      noteServerError()
      return { ok: false, conflict: false }
    }
    const json = (await res.json()) as { ok: boolean; item?: { rev: number } }
    return json.ok && json.item ? { ok: true, rev: json.item.rev } : { ok: false, conflict: false }
  } catch {
    noteOffline()
    return { ok: false, conflict: false }
  }
}

async function deleteItem(token: string, id: string): Promise<{ ok: boolean; rev: number }> {
  try {
    const res = await fetch(urlFor(`/workspace/items/${id}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    })
    if (res.status === 404) return { ok: true, rev: 0 } // server never had it; treat as done
    if (!res.ok) {
      noteServerError()
      return { ok: false, rev: 0 }
    }
    const json = (await res.json()) as { ok: boolean; item?: { rev: number } }
    return { ok: !!json.ok, rev: json.item?.rev ?? 0 }
  } catch {
    noteOffline()
    return { ok: false, rev: 0 }
  }
}

// ── Org-shared transport (cross-member time blocks) ──────────────────────────
// Same fetch shapes as the personal helpers above, but against /workspace/org/*
// and carrying the active org in x-plexi-org. The global signal-header
// interceptor also stamps this header; setting it explicitly keeps these calls
// correct even if that interceptor is not installed (tests, early boot). The
// server independently re-checks membership, so the header can only narrow scope.
function orgHeaders(token: string, orgId: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'x-plexi-org': orgId }
}

async function pullChangesOrg(
  token: string,
  orgId: string,
  since: number
): Promise<{ items: ServerItem[]; now: number } | null> {
  try {
    const res = await fetch(urlFor(`/workspace/org/sync?since=${since}`), {
      headers: orgHeaders(token, orgId)
    })
    if (!res.ok) {
      noteServerError()
      return null
    }
    const json = (await res.json()) as { ok: boolean; items?: ServerItem[]; now?: number }
    if (!json.ok) {
      noteServerError()
      return null
    }
    return { items: json.items ?? [], now: json.now ?? since }
  } catch {
    noteOffline()
    return null
  }
}

async function putItemOrg(
  token: string,
  orgId: string,
  id: string,
  itemType: SyncItemType,
  body: Record<string, unknown>,
  baseRev: number,
  teamId?: string | null
): Promise<PutResult> {
  try {
    const res = await fetch(urlFor(`/workspace/org/items/${id}`), {
      method: 'PUT',
      headers: { ...orgHeaders(token, orgId), 'Content-Type': 'application/json' },
      // Omit teamId entirely when undefined so the server preserves the item's
      // existing scope (a plain edit must never widen a team item to the whole org).
      body: JSON.stringify({ itemType, body, baseRev: baseRev || undefined, ...(teamId !== undefined ? { teamId } : {}) })
    })
    if (res.status === 409) {
      const json = (await res.json()) as { item?: ServerItem }
      if (json.item) return { ok: false, conflict: true, item: json.item }
      return { ok: false, conflict: false }
    }
    if (!res.ok) {
      noteServerError()
      return { ok: false, conflict: false }
    }
    const json = (await res.json()) as { ok: boolean; item?: { rev: number } }
    return json.ok && json.item ? { ok: true, rev: json.item.rev } : { ok: false, conflict: false }
  } catch {
    noteOffline()
    return { ok: false, conflict: false }
  }
}

async function deleteItemOrg(
  token: string,
  orgId: string,
  id: string
): Promise<{ ok: boolean; rev: number }> {
  try {
    const res = await fetch(urlFor(`/workspace/org/items/${id}`), {
      method: 'DELETE',
      headers: orgHeaders(token, orgId)
    })
    if (res.status === 404) return { ok: true, rev: 0 } // server never had it; treat as done
    if (!res.ok) {
      noteServerError()
      return { ok: false, rev: 0 }
    }
    const json = (await res.json()) as { ok: boolean; item?: { rev: number } }
    return { ok: !!json.ok, rev: json.item?.rev ?? 0 }
  } catch {
    noteOffline()
    return { ok: false, rev: 0 }
  }
}

// ── Org file bytes (cross-member Drive files) ────────────────────────────────
// A file's metadata rides the org item loop; its bytes move here. Every call is
// member-gated server-side via the same x-plexi-org resolution. Bytes are read
// from / written to the local files store through main (window.api.workspaceSync).

// Does the server already hold this file's bytes? Used to skip re-uploading a blob
// on a metadata-only change (rename/move); a missing/failed probe returns false so
// we err toward (re)uploading rather than stranding a file with no bytes.
async function orgBlobExists(token: string, orgId: string, id: string): Promise<boolean> {
  try {
    const res = await fetch(urlFor(`/workspace/org/files/${id}?meta=1`), { headers: orgHeaders(token, orgId) })
    if (!res.ok) return false
    const json = (await res.json()) as { ok?: boolean; exists?: boolean }
    return !!json.exists
  } catch {
    return false
  }
}

async function uploadOrgBlob(
  token: string,
  orgId: string,
  id: string,
  ext: string,
  mime: string,
  bytes: Uint8Array
): Promise<boolean> {
  try {
    const qs = `?ext=${encodeURIComponent(ext || '')}&mime=${encodeURIComponent(mime || 'application/octet-stream')}`
    // Copy into a fresh ArrayBuffer-backed view so the body is a clean octet-stream.
    const body = new Uint8Array(bytes)
    const res = await fetch(urlFor(`/workspace/org/files/${id}${qs}`), {
      method: 'PUT',
      headers: { ...orgHeaders(token, orgId), 'Content-Type': 'application/octet-stream' },
      body
    })
    if (!res.ok) {
      noteServerError()
      return false
    }
    return true
  } catch {
    noteOffline()
    return false
  }
}

async function downloadOrgBlob(token: string, orgId: string, id: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(urlFor(`/workspace/org/files/${id}`), { headers: orgHeaders(token, orgId) })
    if (res.status === 404) return null // bytes not on the server yet; a later cycle retries
    if (!res.ok) {
      noteServerError()
      return null
    }
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    noteOffline()
    return null
  }
}

async function deleteOrgBlob(token: string, orgId: string, id: string): Promise<void> {
  try {
    await fetch(urlFor(`/workspace/org/files/${id}`), { method: 'DELETE', headers: orgHeaders(token, orgId) })
  } catch {
    // best-effort; an orphaned blob is harmless (member-gated) and prunes on org delete
  }
}

// After a file's metadata pushes, make sure its bytes are on the server. Only real
// files (kind 'file') have bytes; folders don't. Skips the upload when the server
// already has the blob (metadata-only change), so a rename doesn't re-ship bytes.
async function ensureOrgBlobUploaded(
  token: string,
  orgId: string,
  id: string,
  body: Record<string, unknown>
): Promise<void> {
  if (body.kind !== 'file') return
  if (await orgBlobExists(token, orgId, id)) return
  const local = await window.api.workspaceSync.fileBytesForPush(id)
  if (!local || !local.bytes || local.bytes.length === 0) return
  await uploadOrgBlob(token, orgId, id, local.ext, local.mimeType, local.bytes)
}

// After a batch of org items applies, fetch the bytes for any pulled file we don't
// have locally yet, so the file actually opens (and the brain can read it).
async function fetchMissingOrgBlobs(token: string, orgId: string, items: ServerItem[]): Promise<void> {
  for (const it of items) {
    if (it.itemType !== 'file' || it.deleted || !it.body) continue
    if (it.body.kind !== 'file') continue
    if (await window.api.workspaceSync.hasLocalFileBytes(it.id)) continue
    const bytes = await downloadOrgBlob(token, orgId, it.id)
    if (bytes && bytes.length > 0) await window.api.workspaceSync.writeSyncedFileBytes(it.id, bytes)
  }
}

// One full push+pull cycle against the ORG endpoint for the active shared org.
// Mirrors the personal cycle. As of rung 3 the org-shared set is nodes, widgets,
// time blocks, documents, tables and rows, so every surface the personal loop
// refreshes is refreshed here too when a pull lands.
async function syncOrgWorkspaceOnce(token: string, orgId: string): Promise<number> {
  // ── Push local changes ──
  const pending = await window.api.workspaceSync.pendingOrg(orgId)
  for (const u of pending.upserts) {
    const res = await putItemOrg(token, orgId, u.id, u.itemType, u.body, u.baseRev, u.teamId)
    if (res.ok) {
      await window.api.workspaceSync.markPushed(u.itemType, u.id, res.rev)
      // A file's metadata is now on the server; make sure its bytes are too.
      if (u.itemType === 'file') await ensureOrgBlobUploaded(token, orgId, u.id, u.body)
    } else if (res.conflict) {
      // Server is newer: take its copy (last-write-wins, server wins).
      await window.api.workspaceSync.applyRemoteOrg(
        [
          {
            id: res.item.id,
            itemType: res.item.itemType,
            body: res.item.body,
            rev: res.item.rev,
            deleted: res.item.deleted,
            teamId: res.item.teamId
          }
        ],
        orgId
      )
      if (res.item.itemType === 'file') await fetchMissingOrgBlobs(token, orgId, [res.item])
      // F010: floor baseRev to the server's after a conflict-apply.
      await window.api.workspaceSync.advanceBaseRev(res.item.itemType, res.item.id, res.item.rev)
    }
  }
  for (const d of pending.deletes) {
    const res = await deleteItemOrg(token, orgId, d.id)
    if (res.ok) {
      await window.api.workspaceSync.markPushed(d.itemType, d.id, res.rev || d.baseRev)
      // Reclaim the server blob when a file is tombstoned (best-effort).
      if (d.itemType === 'file') await deleteOrgBlob(token, orgId, d.id)
    }
  }

  // ── Pull remote changes ──
  const since = await window.api.workspaceSync.getCursorOrg(orgId)
  const pulled = await pullChangesOrg(token, orgId, since)
  if (!pulled) {
    if (currentCycleFailure() === 'server') useSyncStatus.getState().setError('The server rejected a sync request.')
    else useSyncStatus.getState().setOffline()
    return 0
  }
  let applied = 0
  if (pulled.items.length > 0) {
    const r = await window.api.workspaceSync.applyRemoteOrg(pulled.items, orgId)
    applied = r.applied
    // Metadata for pulled files has landed; fetch the bytes for any we don't have
    // yet so the file opens and the brain can read it on the next ingest.
    await fetchMissingOrgBlobs(token, orgId, pulled.items)
  }
  await window.api.workspaceSync.setCursorOrg(orgId, pulled.now)

  const verdict = currentCycleFailure()
  if (verdict === 'server') useSyncStatus.getState().setError('The server rejected a sync request.')
  else if (verdict === 'offline') useSyncStatus.getState().setOffline()
  else useSyncStatus.getState().setOk()

  // Rung 3 shares nodes and widgets on top of time blocks, documents and tables
  // (with rows), so refresh each affected surface when anything landed. Nodes and
  // widgets are refreshed exactly as the personal loop does: reload the node tree
  // and, if a task is open, its widgets. applyRemoteOrg writes tables/rows straight
  // to the DB (bypassing the notifyRowsChanged event the store listens for), so the
  // cached tables/rows are re-fetched here explicitly.
  if (applied > 0) {
    await useNodeStore.getState().refresh()
    // P1 shared-refresh widening (15 §6 #5): work_items ride org pulls too —
    // the Attention surface reads its own store, so reload it alongside.
    await useWorkItemStore.getState().refresh()
    const activeTaskId = useNodeStore.getState().activeTaskId
    if (activeTaskId) await useWidgetStore.getState().loadForTask(activeTaskId, { refresh: true })
    await useTimeBlockStore.getState().reload()
    await useDocumentsStore.getState().refresh().catch(() => {})
    await refreshCachedTables()
    // Refresh the Drive view when files/folders were among the pulled items, so a
    // teammate's file appears without reopening the manager.
    if (pulled.items.some((it) => it.itemType === 'file')) {
      await useFileManagerStore.getState().refresh().catch(() => {})
    }
  }
  return applied
}

// Re-fetch whatever the tables store currently has cached (tables + their rows),
// so pulled org changes to tables and rows show without an app restart. A table
// that has been tombstoned locally now reads as null and is dropped from cache.
async function refreshCachedTables(): Promise<void> {
  const ts = useTablesStore.getState()
  for (const id of Object.keys(ts.tables)) {
    const t = await window.api.tables.get(id)
    const cur = useTablesStore.getState().tables
    if (t) useTablesStore.setState({ tables: { ...cur, [id]: t } })
    else {
      const next = { ...cur }
      delete next[id]
      useTablesStore.setState({ tables: next })
    }
  }
  for (const tableId of Object.keys(ts.rows)) {
    const rows = await window.api.tables.listRows(tableId)
    useTablesStore.setState({ rows: { ...useTablesStore.getState().rows, [tableId]: rows } })
  }
}

// ── Per-desk shared transport (desks shared with named individuals) ──────────
// The ACL-scoped sibling of the org transport. Auth is the plain account bearer
// token (no x-plexi-org): the server resolves the caller's desks from resource_acls
// grants, so access rides the grant, not org membership. Each write names the desk
// root id it belongs to; the server binds and authorizes on it.
async function pullChangesShared(
  token: string,
  since: number
): Promise<{ items: ServerItem[]; now: number; roots: string[]; owned: string[]; ownerHandles: Record<string, string> } | null> {
  try {
    const res = await fetch(urlFor(`/workspace/shared/sync?since=${since}`), {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) {
      noteServerError()
      return null
    }
    const json = (await res.json()) as {
      ok: boolean
      items?: ServerItem[]
      now?: number
      roots?: string[]
      owned?: string[]
      ownerHandles?: Record<string, string>
    }
    if (!json.ok) {
      noteServerError()
      return null
    }
    return {
      items: json.items ?? [],
      now: json.now ?? since,
      roots: json.roots ?? [],
      owned: json.owned ?? [],
      ownerHandles: json.ownerHandles ?? {}
    }
  } catch {
    noteOffline()
    return null
  }
}

async function putItemShared(
  token: string,
  id: string,
  itemType: SyncItemType,
  body: Record<string, unknown>,
  baseRev: number,
  rootId: string
): Promise<PutResult> {
  try {
    const res = await fetch(urlFor(`/workspace/shared/items/${id}`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemType, body, baseRev: baseRev || undefined, rootId })
    })
    if (res.status === 409) {
      const json = (await res.json()) as { item?: ServerItem }
      if (json.item) return { ok: false, conflict: true, item: json.item }
      return { ok: false, conflict: false }
    }
    if (!res.ok) {
      noteServerError()
      return { ok: false, conflict: false }
    }
    const json = (await res.json()) as { ok: boolean; item?: { rev: number } }
    return json.ok && json.item ? { ok: true, rev: json.item.rev } : { ok: false, conflict: false }
  } catch {
    noteOffline()
    return { ok: false, conflict: false }
  }
}

async function deleteItemShared(token: string, id: string, rootId: string): Promise<{ ok: boolean; rev: number }> {
  try {
    const res = await fetch(urlFor(`/workspace/shared/items/${id}?rootId=${encodeURIComponent(rootId)}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    })
    if (res.status === 404) return { ok: true, rev: 0 } // server never had it; treat as done
    if (!res.ok) {
      noteServerError()
      return { ok: false, rev: 0 }
    }
    const json = (await res.json()) as { ok: boolean; item?: { rev: number } }
    return { ok: !!json.ok, rev: json.item?.rev ?? 0 }
  } catch {
    noteOffline()
    return { ok: false, rev: 0 }
  }
}

// One full push+pull cycle for every desk shared with this account by name. Pushes
// locally-changed shared-desk rows (each tagged with its desk id), pulls the
// ACL-scoped delta and materializes it, then prunes any desk the server no longer
// lists in the caller's granted set (a revoke). Returns rows applied locally.
async function syncSharedWorkspaceOnce(token: string): Promise<number> {
  // ── Push local changes ──
  const pending = await window.api.workspaceSync.pendingShared()
  for (const u of pending.upserts) {
    if (!u.rootId) continue
    const res = await putItemShared(token, u.id, u.itemType, u.body, u.baseRev, u.rootId)
    if (res.ok) await window.api.workspaceSync.markPushed(u.itemType, u.id, res.rev)
    else if (res.conflict) {
      await window.api.workspaceSync.applyRemoteShared([
        {
          id: res.item.id,
          itemType: res.item.itemType,
          body: res.item.body,
          rev: res.item.rev,
          deleted: res.item.deleted,
          rootId: res.item.rootId
        }
      ])
      // F010: floor baseRev to the server's after a conflict-apply.
      await window.api.workspaceSync.advanceBaseRev(res.item.itemType, res.item.id, res.item.rev)
    }
  }
  for (const d of pending.deletes) {
    if (!d.rootId) continue
    const res = await deleteItemShared(token, d.id, d.rootId)
    if (res.ok) await window.api.workspaceSync.markPushed(d.itemType, d.id, res.rev || d.baseRev)
  }

  // ── Pull remote changes ──
  const since = await window.api.workspaceSync.getCursorShared()
  const pulled = await pullChangesShared(token, since)
  if (!pulled) return 0
  // Owner-side adoption BEFORE apply: a desk I own but still hold as an untagged
  // local copy (shared from my other device) is folded into shared scope so the
  // apply below reconciles it instead of refusing it as foreign. Only desks the
  // server confirmed I own are adopted.
  for (const root of pulled.owned) await window.api.workspaceSync.adoptSharedDesk(root)
  let applied = 0
  if (pulled.items.length > 0) {
    const r = await window.api.workspaceSync.applyRemoteShared(pulled.items, pulled.ownerHandles)
    applied = r.applied
  }
  await window.api.workspaceSync.setCursorShared(pulled.now)

  // Prune desks I no longer have access to: any locally-materialized shared desk the
  // server did not list in my granted set has been revoked. Only ever runs after a
  // successful pull, so an offline cycle never wrongly prunes.
  const local = await window.api.workspaceSync.localSharedRoots()
  let pruned = 0
  // The revoke diff is one tested function, not an inline loop restating it.
  for (const root of rootsToPrune(local, pulled.roots)) {
    pruned += await window.api.workspaceSync.pruneSharedDesk(root)
  }

  if (applied > 0 || pruned > 0) {
    await useNodeStore.getState().refresh()
    // P1 shared-refresh widening (15 §6 #5): a shared desk can carry
    // work_items — Attention reads its own store, so a shared pull (or a
    // prune's detach-and-revive) must reload it or the page shows stale.
    await useWorkItemStore.getState().refresh()
    const activeTaskId = useNodeStore.getState().activeTaskId
    if (activeTaskId) await useWidgetStore.getState().loadForTask(activeTaskId, { refresh: true })
    await refreshCachedTables()
  }
  return applied
}

// Which org scopes sync this cycle, in order. Every membership is included —
// the active org first (freshest on screen), then the rest. Personal is not in
// this list; the personal loop always runs after these. Pure so the coverage
// guarantee (no workspace stranded unsynced) is directly unit-testable.
export function orgSyncOrder(activeOrgId: string, memberOrgIds: string[]): string[] {
  const members = memberOrgIds.filter((id) => id && id !== PERSONAL_ORG_ID)
  const active = activeOrgId !== PERSONAL_ORG_ID && members.includes(activeOrgId) ? [activeOrgId] : []
  return [...active, ...members.filter((id) => id !== activeOrgId)]
}


// Per-cycle transport outcome, so the status store can tell "could not reach
// the server" (offline, transient, keep retrying quietly) from "the server
// rejected us" (a real error worth surfacing). Reset at the top of each cycle;
// the fetch helpers set 'offline' on a thrown fetch and 'server' on a non-ok
// HTTP status.
let cycleFailure: 'none' | 'offline' | 'server' = 'none'
function noteOffline(): void {
  if (cycleFailure === 'none') cycleFailure = 'offline'
}
function noteServerError(): void {
  cycleFailure = 'server' // server errors outrank offline for the cycle verdict
}
// Read through a function so TS control-flow analysis does not narrow the
// module-level let to its last literal assignment (the fetch helpers mutate it
// asynchronously, which TS cannot see).
function currentCycleFailure(): 'none' | 'offline' | 'server' {
  return cycleFailure
}

// One full push+pull cycle. Returns the number of remote items applied locally.
export async function syncWorkspaceOnce(): Promise<number> {
  const token = useAccountStore.getState().sessionToken
  if (!enabled() || !token) {
    if (!token || previewSyncBlocked()) useSyncStatus.getState().setDisabled()
    return 0
  }
  if (!syncWakeCoalescer.enter()) {
    // A cycle is in flight. The wake is recorded; one coalesced follow-up runs
    // from the finally below — it is no longer silently dropped.
    return 0
  }
  cycleFailure = 'none'
  useSyncStatus.getState().setSyncing()
  try {
    // Scope selection: EVERY workspace syncs each cycle — the personal loop below
    // plus one org loop per membership. This replaced the original active-org-only
    // branch, which stranded content: a desk in a workspace the user had not
    // opened since sync shipped was never pushed at all, so other devices (and
    // the mobile web app) showed an incomplete workspace. Per-org cursors and the
    // per-row org_id scoping in collectPending/collectPendingOrg keep the loops
    // independent, so running them back-to-back cannot cross-contaminate scopes.
    // The active org runs first so the workspace on screen stays the freshest.
    const activeOrg = useOrgStore.getState().activeOrgId || PERSONAL_ORG_ID
    const memberOrgIds = useOrgStore.getState().orgs.map((o) => o.id)
    let orgApplied = 0
    for (const orgId of orgSyncOrder(activeOrg, memberOrgIds)) {
      orgApplied += await syncOrgWorkspaceOnce(token, orgId)
    }

    // Per-desk shared scope: desks shared with this account by name, independent of
    // org membership. Runs once per cycle alongside the org loops.
    const sharedApplied = await syncSharedWorkspaceOnce(token)

    // ── Push local changes (personal scope) ──
    const pending = await window.api.workspaceSync.pending()
    for (const u of pending.upserts) {
      const res = await putItem(token, u.id, u.itemType, u.body, u.baseRev)
      if (res.ok) await window.api.workspaceSync.markPushed(u.itemType, u.id, res.rev)
      else if (res.conflict) {
        // Server is newer: take its copy (last-write-wins, server wins).
        await window.api.workspaceSync.applyRemote([
          { id: res.item.id, itemType: res.item.itemType, body: res.item.body, rev: res.item.rev, deleted: res.item.deleted }
        ])
        // F010: the apply can no-op on a desynced local rev — floor baseRev to
        // the server's so this row can never 409 forever.
        await window.api.workspaceSync.advanceBaseRev(res.item.itemType, res.item.id, res.item.rev)
      }
    }
    for (const d of pending.deletes) {
      const res = await deleteItem(token, d.id)
      if (res.ok) await window.api.workspaceSync.markPushed(d.itemType, d.id, res.rev || d.baseRev)
    }

    // ── Pull remote changes ──
    const since = await window.api.workspaceSync.getCursor()
    const pulled = await pullChanges(token, since)
    if (!pulled) {
      // No pull result: report the transport verdict so a persistent failure
      // stops being invisible.
      if (currentCycleFailure() === 'server') useSyncStatus.getState().setError('The server rejected a sync request.')
      else useSyncStatus.getState().setOffline()
      return 0
    }
    let applied = 0
    let failed = 0
    if (pulled.items.length > 0) {
      const r = await window.api.workspaceSync.applyRemote(pulled.items)
      applied = r.applied
      failed = r.failed ?? 0
    }
    // Only step the cursor past a window every item of which landed.
    //
    // It used to advance unconditionally, so a row that failed to apply -- a
    // child node whose parent was not in the local database yet, most often --
    // was skipped and then never offered again, because the cursor had moved
    // beyond it. The workspace was quietly missing pieces and nothing said so.
    //
    // Holding the cursor re-offers the same window next cycle, which is what
    // lets a row land once its parent has. But a row that can NEVER apply would
    // then freeze sync for good, which is worse than losing it, so after a few
    // fruitless attempts the cursor moves on and the failure is surfaced rather
    // than hidden.
    if (failed === 0) {
      applyStalls = 0
      await window.api.workspaceSync.setCursor(pulled.now)
    } else if (applied > 0 || applyStalls < MAX_APPLY_STALLS) {
      // Progress was made, or there is still patience left: keep the cursor so
      // the remainder is offered again.
      applyStalls = applied > 0 ? 0 : applyStalls + 1
      console.warn(`[sync] ${failed} item(s) did not apply; holding the cursor to retry them`)
    } else {
      applyStalls = 0
      await window.api.workspaceSync.setCursor(pulled.now)
      console.error(
        `[sync] ${failed} item(s) could not be applied after ${MAX_APPLY_STALLS} attempts; ` +
          'moving past them. Some of this workspace is missing locally.'
      )
      useSyncStatus.getState().setError(`${failed} item(s) could not be synced to this device.`)
    }

    // Cycle verdict: a push that hit a server error still lands here (the pull
    // may have succeeded), so honour any error/offline note from the push loop.
    const verdict = currentCycleFailure()
    if (verdict === 'server') useSyncStatus.getState().setError('The server rejected a sync request.')
    else if (verdict === 'offline') useSyncStatus.getState().setOffline()
    else useSyncStatus.getState().setOk()

    // Refresh the UI from the merged local DB if anything changed.
    if (applied > 0) {
      await useNodeStore.getState().refresh()
      // Work items live in their own store (S3) — refresh it alongside.
      await useWorkItemStore.getState().refresh()
      const activeTaskId = useNodeStore.getState().activeTaskId
      if (activeTaskId) await useWidgetStore.getState().loadForTask(activeTaskId, { refresh: true })
      // Calendar blocks sync too (rung 1): refresh whatever range is loaded.
      await useTimeBlockStore.getState().reload()
    }
    return applied + orgApplied + sharedApplied
  } finally {
    if (syncWakeCoalescer.exit()) {
      // At least one wake landed while this cycle ran. One follow-up, not N.
      void syncWorkspaceOnce()
    }
  }
}

let timer: number | null = null

// Near-live push: the server emits orgWorkspaceChanged whenever another member of
// an org mutates shared data. Rather than wait up to a full interval for the next
// poll, kick an immediate cycle. Debounced so a burst of edits from a teammate
// collapses into one pull. Since every membership now syncs each cycle, an event
// for ANY member org warrants the kick, not just the active one — the debounced
// cycle covers all scopes anyway.
let pushDebounce: number | null = null
function onOrgWorkspaceChanged(orgId: string): void {
  if (!useOrgStore.getState().orgs.some((o) => o.id === orgId)) return
  if (pushDebounce != null) return
  pushDebounce = window.setTimeout(() => {
    pushDebounce = null
    void syncWorkspaceOnce()
  }, 400)
}

// A desk shared with me by name changed → kick a (debounced) cycle. The shared
// loop inside it pulls the ACL-scoped delta, so the desk updates in ~1-2s. Shares
// the same debounce as the org nudge since a cycle covers every scope anyway.
function onSharedWorkspaceChanged(_rootId: string): void {
  if (pushDebounce != null) return
  pushDebounce = window.setTimeout(() => {
    pushDebounce = null
    void syncWorkspaceOnce()
  }, 400)
}

// Start the periodic sync loop (idempotent). Runs once immediately, then on an
// interval. Safe to call on every sign-in; stops cleanly on sign-out.
export function startWorkspaceSync(): void {
  initPreviewGuard()
  if (timer != null) return
  setOrgWorkspaceChangedHandler(onOrgWorkspaceChanged)
  setSharedWorkspaceChangedHandler(onSharedWorkspaceChanged)
  // Local edits nudge an immediate (debounced) push so a change reaches teammates
  // in ~1-2s instead of waiting up to a full poll interval. The interval below
  // stays as the backstop.
  registerSyncNudge(() => void syncWorkspaceOnce())
  void syncWorkspaceOnce()
  timer = window.setInterval(() => void syncWorkspaceOnce(), SYNC_INTERVAL_MS)
}

export function stopWorkspaceSync(): void {
  useSyncStatus.getState().setDisabled()
  setOrgWorkspaceChangedHandler(null)
  setSharedWorkspaceChangedHandler(null)
  registerSyncNudge(null)
  if (pushDebounce != null) {
    window.clearTimeout(pushDebounce)
    pushDebounce = null
  }
  if (timer != null) {
    window.clearInterval(timer)
    timer = null
  }
}
