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
  { channel: 'tables:update', missing: 'table-rename propagation to the desk widget' }
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
  'workspace:localSharedRoots': h(() => listLocalSharedRoots())
}

/** Channels this runtime answers. The renderer asks before it calls. */
export function servedChannels(): string[] {
  return Object.keys(HANDLERS)
}
