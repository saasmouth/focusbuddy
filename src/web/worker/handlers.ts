// The cloud runtime's handler table: channel name -> the same function the
// desktop's ipcMain handler calls.
//
// Every entry here mirrors a registration in src/main/ipc/index.ts. They are
// written out rather than generated because the desktop's handlers are not all
// one-liners -- several also emit Context Engine and automation events -- and a
// generator would have had to either copy that machinery into the Worker or
// quietly drop it. Listing the calls makes the second choice visible: what the
// cloud runtime does NOT yet do is exactly the difference between these bodies
// and the desktop's, and that difference is recorded in PARITY below rather
// than left for someone to discover from behaviour.
//
// The functions themselves are imported straight from src/main/db. They are not
// reimplemented, adapted or wrapped. That is the whole point of the arrangement
// -- a node created here goes through the same createNode, writes the same
// columns, and therefore syncs to the desktop as a node the desktop recognises.
import {
  listNodes, getNode, createNode, updateNode, deleteNode, deleteNodePermanent,
  restoreNodes, listTrash, restoreTree, moveNodeToOrg
} from '../../main/db/nodes'
import {
  getWidget, listWidgetsByTask, listWidgetsByKind, createWidget,
  createWidgetIfTaskExists, updateWidget, deleteWidget, restoreWidget,
  bringToFront, widgetCountsByTask
} from '../../main/db/widgets'
import {
  listTables, getTable, createTable, updateTable, deleteTable, listRows,
  createRow, updateRow, deleteRow, restoreRow, reorderRows
} from '../../main/db/tables'
import {
  listDocuments, getDocument, createDocument, updateDocument, trashDocument,
  listTrashedDocuments, restoreDocument, deleteDocument
} from '../../main/db/documents'
import { listTemplates, deleteTemplate } from '../../main/db/templates'
import {
  listAllShareLinks, revokeShareLink, setShareLinkScope, deleteShareLink,
  listSharedWithMe, removeSharedItem
} from '../../main/db/shares'
import {
  listConnectedApps, createConnectedApp, deleteConnectedApp,
  reorderConnectedApps, touchConnectedApp, findConnectedAppByHostname
} from '../../main/db/connectedApps'
import { getVaultMeta, isUnlocked, lockVault, listEntries } from '../../main/db/vault'
import { getModelMode, setModelMode } from '../../main/ai/modelRouting'
import { noteCheck, liveDeskFor, allLiveDesks } from '../../main/livePublisher'
import { getRecentHistory, recordVisit } from '../../main/db/browsing'
import { recordActivity, getRecentActivity } from '../../main/db/activity'
import { listClustersForTask, saveCluster, deleteCluster } from '../../main/db/focusClusters'
import { listLinksByTask, createLink, updateLink, deleteLink } from '../../main/db/widgetLinks'
import {
  createSnapshot, listSnapshots, getSnapshot, restoreSnapshot, branchSnapshot
} from '../../main/db/canvasSnapshots'
import { createDeskLayoutStore } from '../../main/db/deskLayoutStore'
import {
  recordEvent, unsyncedEvents, markSynced, knownIds, eventsForObject
} from '../../main/db/changeLog'
import { refreshCredits, getAiStatus } from '../../main/ai/creditMode'
import { getDb } from '../../main/db/database'

// Memoised exactly as the desktop's registerIpcHandlers does: one store per
// database handle, built on first use.
let _deskLayoutStore: ReturnType<typeof createDeskLayoutStore> | null = null
function deskLayoutStore(): ReturnType<typeof createDeskLayoutStore> {
  if (!_deskLayoutStore) _deskLayoutStore = createDeskLayoutStore(getDb() as never)
  return _deskLayoutStore
}
import {
  collectPending, collectPendingOrg, collectPendingShared, markPushed,
  applyRemote, applyRemoteOrg, applyRemoteShared, advanceBaseRev,
  getSyncCursor, setSyncCursor, getSyncCursorOrg, setSyncCursorOrg,
  getSyncCursorShared, setSyncCursorShared, stampSharedDesk, adoptSharedDesk,
  pruneSharedDesk, listLocalSharedRoots
} from '../../main/db/workspaceSync'

/**
 * Behaviour the desktop's handlers have and these do not, stated once so it can
 * be answered rather than rediscovered. None of it affects what is written to a
 * row, so none of it affects what syncs; it is all downstream reaction.
 */
export const PARITY: ReadonlyArray<{ channel: string; missing: string }> = [
  { channel: 'nodes:create', missing: 'Context Engine ObjectCreated event' },
  { channel: 'nodes:update', missing: 'Context Engine DeskUpdated event' },
  { channel: 'nodes:delete', missing: 'Context Engine ObjectDeleted event' },
  { channel: 'widgets:create', missing: 'Context Engine WidgetCreated event' },
  { channel: 'widgets:update', missing: 'Context Engine WidgetUpdated event' },
  { channel: 'widgets:delete', missing: 'Context Engine ObjectDeleted event' },
  { channel: 'nodes:relate', missing: 'relation mirroring into the graph' },
  { channel: 'tables:update', missing: 'table-rename propagation to the desk widget' },
  { channel: 'documents:create', missing: 'embedding the new document for semantic search' },
  { channel: 'documents:update', missing: 'a named snapshot, and re-embedding' },
  { channel: 'documents:delete', missing: 'answer-cache invalidation' }
]

type Handler = (...args: never[]) => unknown

/* eslint-disable @typescript-eslint/no-explicit-any */
const h = (fn: (...a: any[]) => unknown): Handler => fn as Handler

export const HANDLERS: Record<string, Handler> = {
  // ── nodes ────────────────────────────────────────────────────────────────
  'nodes:list': h(() => listNodes()),
  'nodes:get': h((id: string) => getNode(id)),
  'nodes:create': h((draft: never) => createNode(draft)),
  'nodes:update': h((id: string, patch: never) => updateNode(id, patch)),
  'nodes:delete': h((id: string) => deleteNode(id)),
  'nodes:deletePermanent': h((id: string) => deleteNodePermanent(String(id || ''))),
  'nodes:restore': h((ids: string[]) => restoreNodes(ids)),
  'nodes:listTrash': h(() => listTrash()),
  'nodes:restoreTree': h((rootId: string) => restoreTree(rootId)),
  'nodes:moveToOrg': h((id: string, orgId: string, teamId?: string | null) =>
    moveNodeToOrg(String(id || ''), String(orgId || ''), teamId ?? null)),

  // ── widgets ──────────────────────────────────────────────────────────────
  'widgets:get': h((id: string) => getWidget(id)),
  'widgets:listByTask': h((taskId: string) => listWidgetsByTask(taskId)),
  'widgets:listByKind': h((kind: never) => listWidgetsByKind(kind)),
  'widgets:create': h((draft: never) => createWidget(draft)),
  'widgets:createOptional': h((draft: never) => createWidgetIfTaskExists(draft)),
  'widgets:update': h((id: string, patch: never) => updateWidget(id, patch)),
  'widgets:delete': h((id: string) => deleteWidget(id)),
  'widgets:restore': h((id: string) => restoreWidget(id)),
  'widgets:bringToFront': h((id: string) => bringToFront(id)),
  'widgets:countsByTask': h((taskIds: string[]) => widgetCountsByTask(taskIds)),

  // ── tables ───────────────────────────────────────────────────────────────
  'tables:list': h(() => listTables()),
  'tables:get': h((id: string) => getTable(id)),
  'tables:create': h((draft: never) => createTable(draft)),
  'tables:update': h((id: string, patch: never) => updateTable(id, patch)),
  'tables:delete': h((id: string) => deleteTable(id)),
  'tables:listRows': h((tableId: string) => listRows(tableId)),
  'tables:createRow': h((draft: never) => createRow(draft)),
  'tables:updateRow': h((id: string, patch: never) => updateRow(id, patch)),
  'tables:deleteRow': h((id: string) => deleteRow(id)),
  'tables:restoreRow': h((id: string) => restoreRow(id)),
  'tables:reorderRows': h((tableId: string, ids: string[]) => reorderRows(tableId, ids)),

  // ── workspace sync ───────────────────────────────────────────────────────
  // The half of sync that reads and writes local rows. The other half -- the
  // HTTP to Signal -- already runs in the renderer over fetch, unchanged from
  // the desktop, which is why the cloud runtime needed no new sync protocol.
  'workspace:pending': h(() => collectPending()),
  'workspace:pendingOrg': h((orgId: string) => collectPendingOrg(orgId)),
  'workspace:pendingShared': h(() => collectPendingShared()),
  'workspace:markPushed': h((itemType: never, id: string, rev: number) => markPushed(itemType, id, rev)),
  'workspace:applyRemote': h((items: never) => applyRemote(items)),
  'workspace:applyRemoteOrg': h((items: never, orgId: string) => applyRemoteOrg(items, orgId)),
  'workspace:applyRemoteShared': h((items: never, owners?: never) => applyRemoteShared(items, owners)),
  'workspace:advanceBaseRev': h((itemType: never, id: string, rev: number) => advanceBaseRev(itemType, id, rev)),
  'workspace:getCursor': h(() => getSyncCursor()),
  'workspace:setCursor': h((n: number) => setSyncCursor(n)),
  'workspace:getCursorOrg': h((orgId: string) => getSyncCursorOrg(orgId)),
  'workspace:setCursorOrg': h((orgId: string, n: number) => setSyncCursorOrg(orgId, n)),
  'workspace:getCursorShared': h(() => getSyncCursorShared()),
  'workspace:setCursorShared': h((n: number) => setSyncCursorShared(n)),
  'workspace:stampSharedDesk': h((rootId: string) => stampSharedDesk(rootId)),
  'workspace:adoptSharedDesk': h((rootId: string) => adoptSharedDesk(rootId)),
  'workspace:pruneSharedDesk': h((rootId: string) => pruneSharedDesk(rootId)),
  'workspace:localSharedRoots': h(() => listLocalSharedRoots()),

  // ── documents ────────────────────────────────────────────────────────────
  'documents:list': h(() => listDocuments()),
  'documents:get': h((id: string) => getDocument(id)),
  'documents:create': h((draft: never) => createDocument(draft)),
  'documents:update': h((id: string, patch: never) => updateDocument(id, patch)),
  'documents:delete': h((id: string) => trashDocument(id)),
  'documents:listTrashed': h(() => listTrashedDocuments()),
  'documents:restore': h((id: string) => restoreDocument(id)),
  'documents:purge': h((id: string) => deleteDocument(id)),

  // ── templates ────────────────────────────────────────────────────────────
  'templates:list': h(() => listTemplates()),
  'templates:delete': h((id: string) => deleteTemplate(id)),

  // ── shares ───────────────────────────────────────────────────────────────
  'shares:listAll': h(() => listAllShareLinks()),
  'shares:revoke': h((id: string) => revokeShareLink(id)),
  'shares:setScope': h((id: string, scope: 'view' | 'copy') => setShareLinkScope(id, scope)),
  'shares:delete': h((id: string) => deleteShareLink(id)),
  'shares:inbox': h(() => listSharedWithMe()),
  'shares:removeInbox': h((id: string) => removeSharedItem(id)),

  // ── connected apps ───────────────────────────────────────────────────────
  'connectedApps:list': h(() => listConnectedApps()),
  'connectedApps:create': h((draft: never) => createConnectedApp(draft)),
  'connectedApps:delete': h((id: string) => deleteConnectedApp(id)),
  'connectedApps:reorder': h((ids: string[]) => reorderConnectedApps(ids)),
  'connectedApps:touch': h((id: string) => touchConnectedApp(id)),
  'connectedApps:findByHostname': h((host: string) => findConnectedAppByHostname(host)),

  // ── vault ────────────────────────────────────────────────────────────────
  // Metadata only. The crypto refuses, for the reason set out in the browser
  // variant: its PBKDF2 and AES-GCM are synchronous and the browser's are not.
  'vault:meta': h(() => getVaultMeta()),
  'vault:isUnlocked': h(() => isUnlocked()),
  'vault:lock': h(() => lockVault()),
  'vault:listEntries': h(() => listEntries()),

  // ── model routing ────────────────────────────────────────────────────────
  'model:get': h(() => getModelMode()),
  'model:set': h((mode: never) => setModelMode(mode)),

  // ── live desks ───────────────────────────────────────────────────────────
  // The read side and the diagnostic note. Publishing stays on the desktop for
  // now: it captures widget markup from a live renderer, which is the desk the
  // owner has open, not a projection this runtime can rebuild on its own.
  'liveDesk:get': h((deskId: string) => liveDeskFor(deskId)),
  'liveDesk:list': h(() => allLiveDesks()),
  'liveDesk:note': h((deskId: string, skip: string | null) => noteCheck(deskId, skip)),

  // ── desk layout, snapshots, links, clusters ──────────────────────────────
  // The per-desk state the canvas writes as you use it: where the camera was,
  // what is linked to what, the snapshots you can go back to. Without these a
  // desk opens correctly and then forgets everything you did on it.
  'deskLayout:load': h((userId: string, deskId: string, deviceClass: never) =>
    deskLayoutStore().load(userId, deskId, deviceClass)),
  'deskLayout:save': h((layout: never) => deskLayoutStore().save(layout, new Date().toISOString())),

  // createSnapshot takes the widgets to snapshot, not just a label -- the
  // desktop handler reads them first, and so must this.
  'snapshots:create': h((taskId: string, label?: string) =>
    createSnapshot(taskId, listWidgetsByTask(taskId), label ?? '')),
  'snapshots:list': h((taskId: string) => listSnapshots(taskId)),
  'snapshots:get': h((id: string) => getSnapshot(id)),
  'snapshots:restore': h((id: string) => restoreSnapshot(id)),
  'snapshots:branch': h((id: string, title: string) => branchSnapshot(id, title)),

  'widgetLinks:listByTask': h((taskId: string) => listLinksByTask(taskId)),
  'widgetLinks:create': h((draft: never) => createLink(draft)),
  'widgetLinks:update': h((id: string, patch: never) => updateLink(id, patch)),
  'widgetLinks:delete': h((id: string) => deleteLink(id)),

  'clusters:list': h((taskId: string) => listClustersForTask(taskId)),
  'clusters:save': h((draft: never) => saveCluster(draft)),
  'clusters:delete': h((id: string) => deleteCluster(id)),

  // ── activity trail, browsing history, change log ─────────────────────────
  'trail:record': h((draft: never) => recordActivity(draft)),
  'trail:recent': h((taskId: string | null, sinceMs: number, limit: number) =>
    getRecentActivity({ taskId, sinceMs, limit })),
  'history:recent': h((limit: number, taskId?: string | null) => getRecentHistory(limit, taskId)),
  'history:record': h((url: string, title: string, taskId: string | null, countsAsVisit?: boolean) =>
    recordVisit(url, title, taskId, countsAsVisit ?? true)),

  'crdt:record': h((input: never) => recordEvent(input)),
  'crdt:unsynced': h((limit?: number) => unsyncedEvents(limit)),
  'crdt:markSynced': h((ids: string[]) => markSynced(ids)),
  'crdt:knownIds': h((ids: string[]) => knownIds(ids)),
  'crdt:eventsForObject': h((objectId: string) => eventsForObject(objectId)),

  // ── AI credits ───────────────────────────────────────────────────────────
  // Credits are the browser's AI path: with no keychain there is no BYOK here,
  // so the account balance is the whole story.
  'ai:refreshCredits': h(() => refreshCredits()),
  'ai:getStatus': h(() => getAiStatus())
}

/** Channels this runtime answers. The renderer asks before it calls. */
export function servedChannels(): string[] {
  return Object.keys(HANDLERS)
}
