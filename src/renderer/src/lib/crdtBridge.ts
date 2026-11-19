import type { Widget, FbNode, TimeBlock, FbDocument, WidgetLink } from '@shared/types'
import type { FbRow, FbTable, FileEntry } from '@shared/fields'
import type { FolderEntry } from './liveFolder'

// WS01 sync substrate — the seam between the widgets store and the sync engine.
//
// The store must tell the engine "this widget's geometry/membership just changed
// locally" without importing the engine (which imports the store), so this tiny
// registry breaks the cycle. The engine registers its implementation at init, and
// only when the fb.sync.crdt.widgets flag is on; until then every call here is a
// no-op and the store behaves exactly as before.

export interface CrdtEmit {
  geom: (w: Widget) => void
  membership: (widgetId: string, from: string | null, to: string | null) => void
  widgetCreate: (w: Widget) => void
  widgetDelete: (widgetId: string) => void
  widgetRestore: (widgetId: string) => void
  widgetFields: (widgetId: string, patch: { content?: string; title?: string; color?: string | null; status?: string | null; zIndex?: number }) => void
  nodeTitle: (nodeId: string, title: string) => void
  nodeParent: (nodeId: string, parentId: string | null) => void
  nodeCreate: (node: FbNode) => void
  nodeDelete: (nodeIds: string[]) => void
  nodeRestore: (nodeIds: string[]) => void
  nodeAttrs: (nodeId: string, attrs: Record<string, unknown>) => void
  rowCells: (rowId: string, cells: Record<string, unknown>) => void
  rowOrder: (rowId: string, sortOrder: number) => void
  rowCreate: (row: FbRow) => void
  rowDelete: (rowId: string) => void
  tableCreate: (table: FbTable) => void
  tableDelete: (tableId: string) => void
  tableAttrs: (tableId: string, attrs: Record<string, unknown>) => void
  timeBlock: (blockId: string, patch: { startMs?: number; durationMin?: number; title?: string; status?: string }) => void
  timeBlockCreate: (block: TimeBlock) => void
  timeBlockDelete: (blockId: string) => void
  fileName: (entryId: string, name: string) => void
  fileParent: (entryId: string, parentId: string | null) => void
  fileCreate: (entry: FileEntry) => void
  fileDelete: (entryId: string) => void
  documentCreate: (doc: FbDocument) => void
  documentDelete: (docId: string) => void
  documentAttrs: (docId: string, attrs: Record<string, unknown>) => void
  // Live-folder tree entries. A folder is opened/closed to (un)subscribe its room;
  // create/delete/rename/move each emit a CRDT event so grantees converge lock-free.
  liveFolderOpen: (folderId: string, baseline: FolderEntry[]) => void
  liveFolderClose: (folderId: string) => void
  folderEntryCreate: (folderId: string, entry: FolderEntry) => void
  folderEntryDelete: (folderId: string, entryIds: string[]) => void
  folderEntryName: (folderId: string, entryId: string, name: string) => void
  folderEntryParent: (folderId: string, entryId: string, parentId: string | null) => void
  // Widget links (wires). create carries the whole link; delete/attrs by id. The
  // task id is on the link (create) or passed alongside (delete/attrs) so the
  // engine can resolve the wire's shared root for routing.
  linkCreate: (link: WidgetLink) => void
  linkDelete: (linkId: string, taskId: string) => void
  linkAttrs: (linkId: string, taskId: string, patch: { type?: string; verb?: string; enabled?: boolean }) => void
  // Seed the desk partition with a create for every existing wire on a desk when it
  // is shared. The poll's shared cycle carries widgets/nodes/tables/rows (they are
  // stamped with shared_root_id) but NOT widget_links, so without this a grantee
  // would see a shared desk's widgets but none of its pre-existing connectors.
  seedDeskLinks: (rootId: string) => void
}

let impl: CrdtEmit | null = null

export function registerCrdtEmit(e: CrdtEmit | null): void {
  impl = e
}

export function crdtEmitGeom(w: Widget): void {
  impl?.geom(w)
}

export function crdtEmitMembership(widgetId: string, from: string | null, to: string | null): void {
  impl?.membership(widgetId, from, to)
}

export function crdtEmitWidgetCreate(w: Widget): void {
  impl?.widgetCreate(w)
}
export function crdtEmitWidgetDelete(widgetId: string): void {
  impl?.widgetDelete(widgetId)
}
// A widget brought back out of the trash (Undo of a delete). Without it the log
// ends "delete" and other devices keep the widget deleted.
export function crdtEmitWidgetRestore(widgetId: string): void {
  impl?.widgetRestore(widgetId)
}
export function crdtEmitWidgetFields(
  widgetId: string,
  patch: { content?: string; title?: string; color?: string | null; status?: string | null; zIndex?: number }
): void {
  impl?.widgetFields(widgetId, patch)
}

export function crdtEmitNodeTitle(nodeId: string, title: string): void {
  impl?.nodeTitle(nodeId, title)
}

export function crdtEmitNodeParent(nodeId: string, parentId: string | null): void {
  impl?.nodeParent(nodeId, parentId)
}
export function crdtEmitNodeCreate(node: FbNode): void {
  impl?.nodeCreate(node)
}
// A node delete can cascade (a folder + its descendants); the store passes every
// removed id so each is tombstoned on other devices.
export function crdtEmitNodeDelete(nodeIds: string[]): void {
  impl?.nodeDelete(nodeIds)
}
// Desks/rooms brought back out of the trash (Undo, the Trash view).
export function crdtEmitNodeRestore(nodeIds: string[]): void {
  impl?.nodeRestore(nodeIds)
}
export function crdtEmitNodeAttrs(nodeId: string, attrs: Record<string, unknown>): void {
  impl?.nodeAttrs(nodeId, attrs)
}

export function crdtEmitRowCells(rowId: string, cells: Record<string, unknown>): void {
  impl?.rowCells(rowId, cells)
}
export function crdtEmitRowOrder(rowId: string, sortOrder: number): void {
  impl?.rowOrder(rowId, sortOrder)
}
export function crdtEmitRowCreate(row: FbRow): void {
  impl?.rowCreate(row)
}
export function crdtEmitRowDelete(rowId: string): void {
  impl?.rowDelete(rowId)
}
export function crdtEmitTableCreate(table: FbTable): void {
  impl?.tableCreate(table)
}
export function crdtEmitTableDelete(tableId: string): void {
  impl?.tableDelete(tableId)
}
export function crdtEmitTableAttrs(tableId: string, attrs: Record<string, unknown>): void {
  impl?.tableAttrs(tableId, attrs)
}

export function crdtEmitTimeBlock(
  blockId: string,
  patch: { startMs?: number; durationMin?: number; title?: string; status?: string }
): void {
  impl?.timeBlock(blockId, patch)
}

export function crdtEmitFileName(entryId: string, name: string): void {
  impl?.fileName(entryId, name)
}

export function crdtEmitFileParent(entryId: string, parentId: string | null): void {
  impl?.fileParent(entryId, parentId)
}
export function crdtEmitTimeBlockCreate(block: TimeBlock): void {
  impl?.timeBlockCreate(block)
}
export function crdtEmitTimeBlockDelete(blockId: string): void {
  impl?.timeBlockDelete(blockId)
}
export function crdtEmitFileCreate(entry: FileEntry): void {
  impl?.fileCreate(entry)
}
export function crdtEmitFileDelete(entryId: string): void {
  impl?.fileDelete(entryId)
}
export function crdtEmitDocumentCreate(doc: FbDocument): void {
  impl?.documentCreate(doc)
}
export function crdtEmitDocumentDelete(docId: string): void {
  impl?.documentDelete(docId)
}
export function crdtEmitDocumentAttrs(docId: string, attrs: Record<string, unknown>): void {
  impl?.documentAttrs(docId, attrs)
}

export function crdtLiveFolderOpen(folderId: string, baseline: FolderEntry[]): void {
  impl?.liveFolderOpen(folderId, baseline)
}
export function crdtLiveFolderClose(folderId: string): void {
  impl?.liveFolderClose(folderId)
}
export function crdtEmitFolderEntryCreate(folderId: string, entry: FolderEntry): void {
  impl?.folderEntryCreate(folderId, entry)
}
export function crdtEmitFolderEntryDelete(folderId: string, entryIds: string[]): void {
  impl?.folderEntryDelete(folderId, entryIds)
}
export function crdtEmitFolderEntryName(folderId: string, entryId: string, name: string): void {
  impl?.folderEntryName(folderId, entryId, name)
}
export function crdtEmitFolderEntryParent(folderId: string, entryId: string, parentId: string | null): void {
  impl?.folderEntryParent(folderId, entryId, parentId)
}

export function crdtEmitLinkCreate(link: WidgetLink): void {
  impl?.linkCreate(link)
}
export function crdtEmitLinkDelete(linkId: string, taskId: string): void {
  impl?.linkDelete(linkId, taskId)
}
export function crdtEmitLinkAttrs(
  linkId: string,
  taskId: string,
  patch: { type?: string; verb?: string; enabled?: boolean }
): void {
  impl?.linkAttrs(linkId, taskId, patch)
}
export function crdtSeedDeskLinks(rootId: string): void {
  impl?.seedDeskLinks(rootId)
}
