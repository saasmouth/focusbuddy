import { unstable_batchedUpdates as batchedUpdates } from 'react-dom'
import { plexiId } from '@shared/plexiId'
import { lwwMerge, type LWWRegister } from '@shared/crdt'
import {
  geomRegisterOf,
  resolvedSection,
  registerOf,
  type ChangeEvent,
  type CrdtField,
  type CrdtDataClass,
  type WidgetGeom,
  type GeomPayload,
  type MembersPayload,
  type RegisterPayload,
  type CellPayload,
  type AttrPayload,
  type CreatePayload,
  type DeletePayload
} from '@shared/crdtWidgetMerge'
import { useAccountStore } from '../stores/account'
import { useWidgetStore } from '../stores/widgets'
import { useNodeStore } from '../stores/nodes'
import { useWorkItemStore } from '../stores/workItems'
import { useTablesStore } from '../stores/tables'
import { useTimeBlockStore } from '../stores/timeBlocks'
import { useFileManagerStore } from '../stores/fileManager'
import { useDocumentsStore } from '../stores/documents'
import { useLinksStore } from '../stores/links'
import { useOrgStore } from '../stores/org'
import { useLiveFolderEntriesStore } from '../stores/liveFolderEntries'
import {
  sendSocketMessage,
  setCrdtSocketHandler,
  setCrdtOpenHandler,
  type CrdtSocketEvent
} from './messagingSocket'
import { registerCrdtEmit } from './crdtBridge'
import {
  crdtWidgetsEnabled,
  crdtNodesEnabled,
  crdtTablesEnabled,
  crdtTimeBlocksEnabled,
  crdtFilesEnabled,
  crdtDocumentsEnabled,
  crdtLinksEnabled,
  crdtLiveFoldersEnabled,
  deviceId,
  crdtScopeSuffix,
  crdtObjectScope,
  liveFolderPartition
} from './syncFlags'
import type { Widget, FbNode, TimeBlock, FbDocument, WidgetLink, WireType } from '@shared/types'
import { WORK_ITEM_COLUMNS } from '@shared/workItems'
import type { FbRow, FbTable, FileEntry } from '@shared/fields'
import type { FolderEntry } from './liveFolder'

// The node scalar attributes carried as generic 'attr' registers. title + parent
// have their own fields/apply (parent uses move()); ordering (sortOrder) and the
// resume text stay on the poll (ordering + text-class are separate design steps).
const NODE_ATTR_KEYS = [
  'description',
  'status',
  'priority',
  'interest',
  'importance',
  'dueDate',
  'estimateMinutes',
  'isPlan',
  // Ordering as an LWW-per-item register (not a fractional index). A single
  // reparent/reorder converges on the moved item's rank deterministically; a full
  // concurrent list reshuffle may interleave before the poll reconciles siblings.
  'sortOrder',
  'extensionsMinutes',
  // Resume/standup markdown is a plain scalar field (LWW is fine; it is not a
  // collaborative rich-text body — those go through the Yjs text class).
  'resumeMarkdown',
  'resumeUpdatedAt',
  // work_item routing columns (Attention S2, GAP-015): every renderer-emitted
  // manifest attr joins the allowlist so the LIVE path carries them — without
  // this, a routed item would arrive stripped of exactly its routing fields.
  // schema_epoch is main-process-written and deliberately absent (F-m2″).
  ...WORK_ITEM_COLUMNS.filter((c) => c.rendererEmitted).map((c) => c.attr)
] as const

// WS01 sync substrate — the client sync engine.
//
// Every migrated type routes through the one CRDT change log: a local edit becomes
// a ChangeEvent, persisted to the local log (the offline queue) and sent over the
// existing websocket; incoming events are merged and applied. Widgets were first
// (geometry as an LWW register, section membership as an OR-Set); nodes are second
// (title + parent as LWW registers). Each type has its own flag and its own
// partition, and runs ALONGSIDE the twenty-second poll, so nothing regresses while
// a flag is off and the poll stays the safety net for a dropped frame. The merge
// algebra lives in @shared/crdtWidgetMerge and @shared/crdtNodeMerge and is proven
// directly by the convergence tests.

let accountId = ''
let widgetPart: string | null = null
let nodePart: string | null = null
let rowPart: string | null = null
let tbPart: string | null = null
let filePart: string | null = null
let docPart: string | null = null
let linkPart: string | null = null
let actor = ''
let started = false

// Widget in-memory state: the current geometry LWW register per widget, and the
// section-membership OR-Set (add tags + remove tombstones) per widget.
const geomRegs = new Map<string, LWWRegister<WidgetGeom>>()
interface MemberState {
  adds: Map<string, string> // tag -> section
  removes: Set<string>
}
const memberStates = new Map<string, MemberState>()
function memberState(id: string): MemberState {
  let st = memberStates.get(id)
  if (!st) {
    st = { adds: new Map(), removes: new Set() }
    memberStates.set(id, st)
  }
  return st
}
function liveSections(st: MemberState): string[] {
  const live = new Set<string>()
  for (const [tag, section] of st.adds) if (!st.removes.has(tag)) live.add(section)
  return [...live]
}

// Node in-memory state: one LWW register per (field, node), keyed `${field}:${id}`.
const nodeRegs = new Map<string, LWWRegister<unknown>>()
// Generic per-attribute registers, keyed `${objectType}:${id}:${attr}`.
const attrRegs = new Map<string, LWWRegister<unknown>>()

// Row in-memory state: one LWW register per (row, column), keyed `${rowId}:${column}`.
const rowRegs = new Map<string, LWWRegister<unknown>>()

// Widget scalar-field registers (content/title/color/status), keyed `${field}:${id}`.
const widgetFieldRegs = new Map<string, LWWRegister<unknown>>()
// Lifecycle tombstones: object ids that have seen a delete event. Remove-wins, so a
// create is never applied for a tombstoned id (no resurrection). Spans all types
// (ids are globally unique UUIDs).
const tombstoned = new Set<string>()

// Timeblock + file in-memory state: one LWW register per (field, id), keyed
// `${field}:${id}` (ids are UUIDs so there is no cross-type collision).
const tbRegs = new Map<string, LWWRegister<unknown>>()
const fileRegs = new Map<string, LWWRegister<unknown>>()

// Live-folder in-memory state. Live folders are their OWN rooms (one per folder id),
// not a single scoped partition, so they are tracked separately: which folders are
// open (joined), the name/parent LWW registers keyed `${folderId}::${field}::${id}`,
// and remove-wins tombstones keyed `${folderId}:${id}` (a folder entry id is only
// unique WITHIN its folder, so its tombstone must be folder-qualified — unlike the
// globally-unique ids in the `tombstoned` set).
let liveFoldersOn = false
const openLiveFolders = new Set<string>()
const folderRegs = new Map<string, LWWRegister<unknown>>()
const folderTombstoned = new Set<string>()

// Extract the folder id from a `lfe:folder:<folderId>` partition key, or null.
function liveFolderIdOf(partitionKey: string): string | null {
  const prefix = 'lfe:folder:'
  return partitionKey.startsWith(prefix) ? partitionKey.slice(prefix.length) : null
}
function ensureLiveFolderJoined(folderId: string): void {
  if (openLiveFolders.has(folderId)) return
  openLiveFolders.add(folderId)
  sendSocketMessage({ type: 'crdtJoin', payload: { partitionKey: liveFolderPartition(folderId) } })
}

function geomOf(w: Widget): WidgetGeom {
  return { x: w.x, y: w.y, width: w.width, height: w.height }
}

function mkEvent(
  partitionKey: string,
  objectType: 'widget' | 'node' | 'row' | 'table' | 'timeblock' | 'file' | 'document' | 'folderentry' | 'link',
  objectId: string,
  field: CrdtField,
  dataClass: CrdtDataClass,
  payload:
    | GeomPayload
    | MembersPayload
    | RegisterPayload
    | CellPayload
    | AttrPayload
    | CreatePayload
    | DeletePayload
): ChangeEvent {
  return {
    id: plexiId(),
    ts: new Date().toISOString(),
    partitionKey,
    objectType,
    objectId,
    field: field as CrdtField,
    dataClass,
    actor,
    payload: payload as ChangeEvent['payload']
  }
}

// Persist an emitted/received event to the local change log. `synced` false for a
// locally-originated edit (it must flush), true for one received from the server.
function recordLocal(ev: ChangeEvent, synced: boolean): void {
  void window.api.crdt.record({
    id: ev.id,
    partitionKey: ev.partitionKey,
    ts: ev.ts,
    objectType: ev.objectType,
    objectId: ev.objectId,
    field: ev.field,
    dataClass: ev.dataClass,
    actor: ev.actor,
    payload: ev.payload,
    synced,
    seq: ev.seq ?? null
  })
}

function send(ev: ChangeEvent): void {
  sendSocketMessage({ type: 'crdtEvent', payload: { event: ev } })
}

// ── Per-object partition routing (shared-desk aware) ──────────────────────────
// An object under a shared desk (its node carries shared_root_id) must route to the
// desk partition so grantees converge; everything else routes to the active-scope
// partition. crdtObjectScope encodes the precedence (desk > org > account); these
// helpers resolve the shared root per type (nodes carry it directly; widgets and
// other task-bound objects inherit it from their task node).
function nodeSharedRoot(nodeId: string): string | null {
  const n = useNodeStore.getState().nodes.find((x) => x.id === nodeId)
  if (n) return n.sharedRootId ?? null
  // P1 partition fix (ARCHITECTURE §3 note): work_items never enter
  // useNodeStore, so a shared desk's items resolved null here and their
  // attr/delete emits misrouted to the personal partition. Fall through to
  // the work-item store so they ride the same desk partition as their desk.
  return useWorkItemStore.getState().items.find((x) => x.id === nodeId)?.sharedRootId ?? null
}
function widgetSharedRoot(widgetId: string): string | null {
  const w = useWidgetStore.getState().widgets.find((x) => x.id === widgetId)
  return w ? nodeSharedRoot(w.taskId) : null
}
// A table inherits its shared root from the task node it lives on; a row from its
// table. (These are the other two shared-desk content types alongside node+widget.)
function tableSharedRoot(tableId: string): string | null {
  const t = useTablesStore.getState().tables[tableId]
  return t?.taskId ? nodeSharedRoot(t.taskId) : null
}
function rowSharedRoot(rowId: string): string | null {
  const rows = useTablesStore.getState().rows
  for (const [tableId, list] of Object.entries(rows)) {
    if (list.some((r) => r.id === rowId)) return tableSharedRoot(tableId)
  }
  return null
}
// A widget link inherits its shared root from the task node it lives on (its wires
// belong to the same desk as its widgets), so a shared desk's wires route to the
// desk partition alongside the widgets they connect.
function linkSharedRoot(taskId: string): string | null {
  return nodeSharedRoot(taskId)
}
function partitionFor(prefix: string, sharedRootId: string | null): string {
  return `${prefix}:${crdtObjectScope(sharedRootId, useOrgStore.getState().activeOrgId, accountId)}`
}

// Desk partitions this socket has joined so it RECEIVES shared-desk events. Joining
// replays the partition's log, so a grantee catches up on backlog when it joins.
const joinedDeskParts = new Set<string>()
function ensureDeskJoined(partitionKey: string): void {
  if (!partitionKey.includes(':desk:') || joinedDeskParts.has(partitionKey)) return
  joinedDeskParts.add(partitionKey)
  sendSocketMessage({ type: 'crdtJoin', payload: { partitionKey } })
}
// Join the desk partitions for every shared desk among the loaded nodes, for each
// enabled type, so this device receives edits other grantees make. Called on scope
// change + whenever the node set changes (a shared desk appearing/loading).
function refreshDeskJoins(): void {
  if (!started) return
  const roots = new Set<string>()
  for (const n of useNodeStore.getState().nodes) if (n.sharedRootId) roots.add(n.sharedRootId)
  for (const root of roots) {
    if (widgetPart) ensureDeskJoined(`w:desk:${root}`)
    if (nodePart) ensureDeskJoined(`n:desk:${root}`)
    if (rowPart) ensureDeskJoined(`r:desk:${root}`) // rows + tables share the r: partition
    if (linkPart) ensureDeskJoined(`l:desk:${root}`)
  }
}

// ── Emit (local edits) ───────────────────────────────────────────────────────

function emitGeom(w: Widget): void {
  if (!widgetPart) return
  const pk = partitionFor('w', nodeSharedRoot(w.taskId))
  ensureDeskJoined(pk)
  const geom = geomOf(w)
  const at = Date.now()
  geomRegs.set(w.id, { value: geom, timestamp: at, actor })
  const ev = mkEvent(pk, 'widget', w.id, 'geom', 'register', { geom, at })
  recordLocal(ev, false)
  send(ev)
}

function emitMembership(widgetId: string, from: string | null, to: string | null): void {
  if (!widgetPart) return
  const pk = partitionFor('w', widgetSharedRoot(widgetId))
  ensureDeskJoined(pk)
  const st = memberState(widgetId)
  const events: ChangeEvent[] = []
  if (from) {
    // Remove the live tags that currently place this widget in `from`. Tags added
    // before the substrate was on aren't tracked here, so a first move off a
    // pre-existing section emits an empty remove — harmless, and correct once the
    // add for that section has also flowed through the log.
    const tags = [...st.adds].filter(([t, s]) => s === from && !st.removes.has(t)).map(([t]) => t)
    for (const t of tags) st.removes.add(t)
    events.push(mkEvent(pk, 'widget', widgetId, 'members', 'set', { op: 'remove', section: from, tags }))
  }
  if (to) {
    const tag = plexiId()
    st.adds.set(tag, to)
    events.push(mkEvent(pk, 'widget', widgetId, 'members', 'set', { op: 'add', section: to, tags: [tag] }))
  }
  for (const ev of events) {
    recordLocal(ev, false)
    send(ev)
  }
}

function emitWidgetCreate(w: Widget): void {
  if (!widgetPart) return
  const pk = partitionFor('w', nodeSharedRoot(w.taskId))
  ensureDeskJoined(pk)
  const at = Date.now()
  const snapshot: Record<string, unknown> = {
    id: w.id,
    taskId: w.taskId,
    kind: w.kind,
    title: w.title,
    content: w.content,
    x: w.x,
    y: w.y,
    width: w.width,
    height: w.height,
    color: w.color ?? null,
    // Create-time metadata that must survive materialisation on another device: a
    // connected-app binding, a duplicate sync-group, launcher/mirror mode, and pin
    // state. Omitting these made a connected-app or linked widget materialise wrong.
    sourceAppId: w.sourceAppId ?? null,
    syncGroupId: w.syncGroupId ?? null,
    mode: w.mode ?? null,
    pinned: w.pinned,
    pinnedZone: w.pinnedZone ?? null
  }
  const ev = mkEvent(pk, 'widget', w.id, 'create', 'set', { snapshot, at })
  recordLocal(ev, false)
  send(ev)
}

// Called BEFORE the store removes the widget, so its task's shared root is still
// resolvable and the tombstone routes to the same partition its edits did.
function emitWidgetDelete(widgetId: string): void {
  if (!widgetPart) return
  const pk = partitionFor('w', widgetSharedRoot(widgetId))
  ensureDeskJoined(pk)
  tombstoned.add(widgetId)
  const ev = mkEvent(pk, 'widget', widgetId, 'delete', 'set', { at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}

function emitWidgetFields(
  widgetId: string,
  patch: { content?: string; title?: string; color?: string | null; status?: string | null; zIndex?: number }
): void {
  if (!widgetPart) return
  const pk = partitionFor('w', widgetSharedRoot(widgetId))
  ensureDeskJoined(pk)
  const at = Date.now()
  const fields: Array<[CrdtField, unknown]> = []
  if (patch.content !== undefined) fields.push(['content', patch.content])
  if (patch.title !== undefined) fields.push(['title', patch.title])
  if (patch.color !== undefined) fields.push(['color', patch.color])
  if (patch.status !== undefined) fields.push(['status', patch.status])
  // zIndex is stacking order — an LWW-per-item register, like sortOrder elsewhere.
  if (patch.zIndex !== undefined) fields.push(['order', patch.zIndex])
  for (const [field, value] of fields) {
    widgetFieldRegs.set(`${field}:${widgetId}`, { value, timestamp: at, actor })
    const ev = mkEvent(pk, 'widget', widgetId, field, 'register', { value, at })
    recordLocal(ev, false)
    send(ev)
  }
}

function emitNodeRegister(nodeId: string, field: 'title' | 'parent', value: unknown): void {
  if (!nodePart) return
  const pk = partitionFor('n', nodeSharedRoot(nodeId))
  ensureDeskJoined(pk)
  const at = Date.now()
  nodeRegs.set(`${field}:${nodeId}`, { value, timestamp: at, actor })
  const ev = mkEvent(pk, 'node', nodeId, field, 'register', { value, at })
  recordLocal(ev, false)
  send(ev)
}

function emitNodeTitle(nodeId: string, title: string): void {
  emitNodeRegister(nodeId, 'title', title)
}
function emitNodeParent(nodeId: string, parentId: string | null): void {
  emitNodeRegister(nodeId, 'parent', parentId)
}

function emitNodeCreate(node: FbNode): void {
  if (!nodePart) return
  const pk = partitionFor('n', node.sharedRootId ?? null)
  ensureDeskJoined(pk)
  const snapshot: Record<string, unknown> = {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    description: node.description,
    priority: node.priority,
    interest: node.interest,
    importance: node.importance,
    estimateMinutes: node.estimateMinutes,
    dueDate: node.dueDate,
    isPlan: node.isPlan
  }
  if (node.kind === 'work_item') {
    // The full manifest rides the create snapshot (GAP-015) — a routed item
    // arriving without its routing columns is the failure this prevents.
    for (const def of WORK_ITEM_COLUMNS) {
      if (!def.rendererEmitted) continue
      snapshot[def.attr] = (node as unknown as Record<string, unknown>)[def.attr] ?? null
    }
  }
  const ev = mkEvent(pk, 'node', node.id, 'create', 'set', { snapshot, at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}

// Called BEFORE the store removes the nodes, so each removed node's shared root is
// still resolvable and its tombstone routes to the same partition its edits did.
function emitNodeDelete(nodeIds: string[]): void {
  if (!nodePart) return
  for (const id of nodeIds) {
    const pk = partitionFor('n', nodeSharedRoot(id))
    ensureDeskJoined(pk)
    tombstoned.add(id)
    const ev = mkEvent(pk, 'node', id, 'delete', 'set', { at: Date.now() })
    recordLocal(ev, false)
    send(ev)
  }
}

// Emit the node's scalar attributes present in a patch as generic 'attr' registers.
function emitNodeAttrs(nodeId: string, patch: Record<string, unknown>): void {
  if (!nodePart) return
  const pk = partitionFor('n', nodeSharedRoot(nodeId))
  ensureDeskJoined(pk)
  const at = Date.now()
  for (const attr of NODE_ATTR_KEYS) {
    if (!(attr in patch)) continue
    const value = patch[attr]
    attrRegs.set(`node:${nodeId}:${attr}`, { value, timestamp: at, actor })
    const ev = mkEvent(pk, 'node', nodeId, 'attr', 'register', { attr, value, at })
    recordLocal(ev, false)
    send(ev)
  }
}

function emitRowCells(rowId: string, cells: Record<string, unknown>): void {
  if (!rowPart) return
  const pk = partitionFor('r', rowSharedRoot(rowId))
  ensureDeskJoined(pk)
  const at = Date.now()
  for (const [column, value] of Object.entries(cells)) {
    rowRegs.set(`${rowId}:${column}`, { value, timestamp: at, actor })
    const ev = mkEvent(pk, 'row', rowId, 'cell', 'register', { column, value, at })
    recordLocal(ev, false)
    send(ev)
  }
}

function emitRowOrder(rowId: string, sortOrder: number): void {
  if (!rowPart) return
  const pk = partitionFor('r', rowSharedRoot(rowId))
  ensureDeskJoined(pk)
  const at = Date.now()
  attrRegs.set(`row:${rowId}:sortOrder`, { value: sortOrder, timestamp: at, actor })
  const ev = mkEvent(pk, 'row', rowId, 'attr', 'register', { attr: 'sortOrder', value: sortOrder, at })
  recordLocal(ev, false)
  send(ev)
}

function emitRowCreate(row: FbRow): void {
  if (!rowPart) return
  const pk = partitionFor('r', tableSharedRoot(row.tableId))
  ensureDeskJoined(pk)
  const snapshot: Record<string, unknown> = { id: row.id, tableId: row.tableId, cells: row.cells }
  const ev = mkEvent(pk, 'row', row.id, 'create', 'set', { snapshot, at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
// Called BEFORE the store prunes the row, so its table's shared root is resolvable.
function emitRowDelete(rowId: string): void {
  if (!rowPart) return
  const pk = partitionFor('r', rowSharedRoot(rowId))
  ensureDeskJoined(pk)
  tombstoned.add(rowId)
  const ev = mkEvent(pk, 'row', rowId, 'delete', 'set', { at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitTableCreate(table: FbTable): void {
  if (!rowPart) return
  const pk = partitionFor('r', table.taskId ? nodeSharedRoot(table.taskId) : null)
  ensureDeskJoined(pk)
  const snapshot: Record<string, unknown> = {
    id: table.id,
    taskId: table.taskId,
    title: table.title,
    schema: table.schema
  }
  const ev = mkEvent(pk, 'table', table.id, 'create', 'set', { snapshot, at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitTableDelete(tableId: string): void {
  if (!rowPart) return
  const pk = partitionFor('r', tableSharedRoot(tableId))
  ensureDeskJoined(pk)
  tombstoned.add(tableId)
  const ev = mkEvent(pk, 'table', tableId, 'delete', 'set', { at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitTableAttrs(tableId: string, attrs: Record<string, unknown>): void {
  if (!rowPart) return
  const pk = partitionFor('r', tableSharedRoot(tableId))
  ensureDeskJoined(pk)
  const at = Date.now()
  for (const attr of ['title', 'schema'] as const) {
    if (!(attr in attrs)) continue
    const value = attrs[attr]
    attrRegs.set(`table:${tableId}:${attr}`, { value, timestamp: at, actor })
    const ev = mkEvent(pk, 'table', tableId, 'attr', 'register', { attr, value, at })
    recordLocal(ev, false)
    send(ev)
  }
}

function emitTimeBlock(
  blockId: string,
  patch: { startMs?: number; durationMin?: number; title?: string; status?: string }
): void {
  if (!tbPart) return
  const at = Date.now()
  const fields: Array<[CrdtField, unknown]> = []
  if (patch.startMs !== undefined) fields.push(['start', patch.startMs])
  if (patch.durationMin !== undefined) fields.push(['duration', patch.durationMin])
  if (patch.title !== undefined) fields.push(['title', patch.title])
  if (patch.status !== undefined) fields.push(['status', patch.status])
  for (const [field, value] of fields) {
    tbRegs.set(`${field}:${blockId}`, { value, timestamp: at, actor })
    const ev = mkEvent(tbPart, 'timeblock', blockId, field, 'register', { value, at })
    recordLocal(ev, false)
    send(ev)
  }
}

function emitFileRegister(entryId: string, field: 'name' | 'parent', value: unknown): void {
  if (!filePart) return
  const at = Date.now()
  fileRegs.set(`${field}:${entryId}`, { value, timestamp: at, actor })
  const ev = mkEvent(filePart, 'file', entryId, field, 'register', { value, at })
  recordLocal(ev, false)
  send(ev)
}
function emitFileName(entryId: string, name: string): void {
  emitFileRegister(entryId, 'name', name)
}
function emitFileParent(entryId: string, parentId: string | null): void {
  emitFileRegister(entryId, 'parent', parentId)
}

function emitTimeBlockCreate(block: TimeBlock): void {
  if (!tbPart) return
  // A single occurrence; a recurring series' expansion stays on the poll.
  const snapshot: Record<string, unknown> = {
    id: block.id,
    taskId: block.taskId,
    title: block.title,
    startMs: block.startMs,
    durationMin: block.durationMin
  }
  const ev = mkEvent(tbPart, 'timeblock', block.id, 'create', 'set', { snapshot, at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitTimeBlockDelete(blockId: string): void {
  if (!tbPart) return
  tombstoned.add(blockId)
  const ev = mkEvent(tbPart, 'timeblock', blockId, 'delete', 'set', { at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}

function emitFileCreate(entry: FileEntry): void {
  if (!filePart) return
  // Folders are pure metadata; file-blob entries' bytes ride the poll + blob sync,
  // so only the folder create is emitted here (name/parent still sync for all).
  if (entry.kind !== 'folder') return
  const snapshot: Record<string, unknown> = { id: entry.id, parentId: entry.parentId, name: entry.name }
  const ev = mkEvent(filePart, 'file', entry.id, 'create', 'set', { snapshot, at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitFileDelete(entryId: string): void {
  if (!filePart) return
  tombstoned.add(entryId)
  const ev = mkEvent(filePart, 'file', entryId, 'delete', 'set', { at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}

function emitDocumentCreate(doc: FbDocument): void {
  if (!docPart) return
  // Metadata only — the body is carried by Yjs (org) / the poll (personal) until
  // the text-class fold. A create materialises an empty doc of the right type; the
  // body then flows through its own channel.
  const snapshot: Record<string, unknown> = { id: doc.id, docType: doc.docType, title: doc.title }
  const ev = mkEvent(docPart, 'document', doc.id, 'create', 'set', { snapshot, at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitDocumentDelete(docId: string): void {
  if (!docPart) return
  tombstoned.add(docId)
  const ev = mkEvent(docPart, 'document', docId, 'delete', 'set', { at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitDocumentAttrs(docId: string, attrs: Record<string, unknown>): void {
  if (!docPart) return
  const at = Date.now()
  for (const attr of ['title', 'archived'] as const) {
    if (!(attr in attrs)) continue
    const value = attrs[attr]
    attrRegs.set(`document:${docId}:${attr}`, { value, timestamp: at, actor })
    const ev = mkEvent(docPart, 'document', docId, 'attr', 'register', { attr, value, at })
    recordLocal(ev, false)
    send(ev)
  }
}

// ── Live folders (their own per-folder room) ──────────────────────────────────

// Open a live folder: lay the frozen body_json baseline into the store, then join
// the folder's room so the change log replays the deltas on top. Idempotent.
function liveFolderOpen(folderId: string, baseline: FolderEntry[]): void {
  if (!liveFoldersOn) return
  useLiveFolderEntriesStore.getState().seed(folderId, baseline)
  ensureLiveFolderJoined(folderId)
}
function liveFolderClose(folderId: string): void {
  if (openLiveFolders.has(folderId)) {
    openLiveFolders.delete(folderId)
    sendSocketMessage({ type: 'crdtLeave', payload: { partitionKey: liveFolderPartition(folderId) } })
  }
  useLiveFolderEntriesStore.getState().clear(folderId)
  for (const key of [...folderRegs.keys()]) if (key.startsWith(`${folderId}::`)) folderRegs.delete(key)
}

function emitFolderEntryCreate(folderId: string, entry: FolderEntry): void {
  if (!liveFoldersOn) return
  ensureLiveFolderJoined(folderId)
  const ev = mkEvent(
    liveFolderPartition(folderId),
    'folderentry',
    entry.id,
    'create',
    'set',
    { snapshot: { ...entry } as Record<string, unknown>, at: Date.now() }
  )
  recordLocal(ev, false)
  send(ev)
}
// Called with EVERY doomed id (a folder delete cascades to its whole subtree, per
// removeEntry), so each descendant is tombstoned on other grantees too.
function emitFolderEntryDelete(folderId: string, entryIds: string[]): void {
  if (!liveFoldersOn) return
  ensureLiveFolderJoined(folderId)
  for (const id of entryIds) {
    folderTombstoned.add(`${folderId}:${id}`)
    const ev = mkEvent(liveFolderPartition(folderId), 'folderentry', id, 'delete', 'set', { at: Date.now() })
    recordLocal(ev, false)
    send(ev)
  }
}
function emitFolderEntryRegister(folderId: string, entryId: string, field: 'name' | 'parent', value: unknown): void {
  if (!liveFoldersOn) return
  ensureLiveFolderJoined(folderId)
  const at = Date.now()
  folderRegs.set(`${folderId}::${field}::${entryId}`, { value, timestamp: at, actor })
  const ev = mkEvent(liveFolderPartition(folderId), 'folderentry', entryId, field, 'register', { value, at })
  recordLocal(ev, false)
  send(ev)
}
function emitFolderEntryName(folderId: string, entryId: string, name: string): void {
  emitFolderEntryRegister(folderId, entryId, 'name', name)
}
function emitFolderEntryParent(folderId: string, entryId: string, parentId: string | null): void {
  emitFolderEntryRegister(folderId, entryId, 'parent', parentId)
}

// ── Widget links (wires) ──────────────────────────────────────────────────────
// A wire routes with its task node's shared root, so a shared desk's wires converge
// alongside its widgets. Existence is create/delete; type/verb/enabled are generic
// LWW attr registers. Run-state (lastRunAt/lastError) is local engine output and
// never emitted.
function linkSnapshot(link: WidgetLink): Record<string, unknown> {
  return {
    id: link.id,
    sourceWidgetId: link.sourceWidgetId,
    targetWidgetId: link.targetWidgetId,
    taskId: link.taskId,
    type: link.type,
    verb: link.verb,
    enabled: link.enabled
  }
}
function sendLinkCreate(pk: string, link: WidgetLink): void {
  ensureDeskJoined(pk)
  const ev = mkEvent(pk, 'link', link.id, 'create', 'set', { snapshot: linkSnapshot(link), at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitLinkCreate(link: WidgetLink): void {
  if (!linkPart) return
  sendLinkCreate(partitionFor('l', linkSharedRoot(link.taskId)), link)
}

// Seed a newly-shared desk's EXISTING wires onto its desk partition. Routed
// explicitly to `l:desk:<rootId>` (not via linkSharedRoot, whose shared_root_id may
// not have propagated to the renderer node store yet at share time), walking the
// desk's node subtree by parent so it never depends on the stamp having landed.
// Idempotent: create-if-missing by link id + the server's dedup make a re-share a
// no-op. No-op when the substrate is off.
function seedDeskLinks(rootId: string): void {
  if (!linkPart) return
  const pk = `l:desk:${rootId}`
  void (async () => {
    for (const taskId of subtreeNodeIds(rootId)) {
      let links: WidgetLink[] = []
      try {
        links = await window.api.widgetLinks.listByTask(taskId)
      } catch {
        continue
      }
      for (const l of links) sendLinkCreate(pk, l)
    }
  })()
}
// rootId + every descendant node id, resolved from the renderer node store by
// walking parentId (independent of shared_root_id, so no stamp-timing dependency).
function subtreeNodeIds(rootId: string): string[] {
  const nodes = useNodeStore.getState().nodes
  const byParent = new Map<string, string[]>()
  for (const n of nodes) {
    if (!n.parentId) continue
    const arr = byParent.get(n.parentId) ?? []
    arr.push(n.id)
    byParent.set(n.parentId, arr)
  }
  const out = [rootId]
  const stack = [rootId]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const child of byParent.get(cur) ?? []) {
      out.push(child)
      stack.push(child)
    }
  }
  return out
}
// Called BEFORE the store prunes the link, so its task's shared root is resolvable.
function emitLinkDelete(linkId: string, taskId: string): void {
  if (!linkPart) return
  const pk = partitionFor('l', linkSharedRoot(taskId))
  ensureDeskJoined(pk)
  tombstoned.add(linkId)
  const ev = mkEvent(pk, 'link', linkId, 'delete', 'set', { at: Date.now() })
  recordLocal(ev, false)
  send(ev)
}
function emitLinkAttrs(linkId: string, taskId: string, patch: { type?: string; verb?: string; enabled?: boolean }): void {
  if (!linkPart) return
  const pk = partitionFor('l', linkSharedRoot(taskId))
  ensureDeskJoined(pk)
  const at = Date.now()
  for (const attr of ['type', 'verb', 'enabled'] as const) {
    const value = patch[attr]
    if (value === undefined) continue
    attrRegs.set(`link:${linkId}:${attr}`, { value, timestamp: at, actor })
    const ev = mkEvent(pk, 'link', linkId, 'attr', 'register', { attr, value, at })
    recordLocal(ev, false)
    send(ev)
  }
}

// ── Apply (remote events) ─────────────────────────────────────────────────────

// DEC-059 — every window.api write below passes 'sync' as its origin. These
// appliers reuse the user-facing IPC (that is the point: one code path, so the
// main-side cascades and hooks fire identically), but the write is a replay of
// something that already happened elsewhere, not something the person at the
// keyboard just did. Without the marker, main cannot tell the difference and
// mints a permanent "user did this" Object Event for each one — 811 per boot
// across 28 widgets, in a store that PLX-EVT-030 forbids ever pruning.

// ── Pass-scoped commit coalescing ─────────────────────────────────────────────
// A crdtJoin replays the partition's whole log in one crdtSync frame, and every
// applier used to reflect its event into the renderer stores the moment its IPC
// settled — one setState per event, staggered across the replay's IPC responses.
// Each landed as its own React update, often interleaving a render in flight, and
// a large enough burst tripped React's nested-update guard on every reload
// ("Maximum update depth exceeded" via forceStoreRerender ← zustand setState).
//
// VERIFIED 2026-08-28, after an earlier claim was retracted. The first attempt
// measured a hot-swap artifact: path-stashing this module makes the FIRST
// reload log a burst whichever version is loaded, so a clean 27 → 0 was
// measuring the swap. A later attempt found 0 in both arms — also wrong, and
// wrong in the more dangerous direction: the sidebar was collapsed, which
// unmounts the node-store subscriber, and forceStoreRerender only fires for a
// MOUNTED subscriber. The bug cannot appear on a view that is not listening,
// so that run proved the harness was idle, not that the code was sound.
//
// The conditions matter as much as the fix, so they are recorded here. Sidebar
// EXPANDED (localStorage fb.sidebar.minimized = '0', which survives reload) so
// the tree and SyncIndicator are mounted; then one reload discarded to clear
// the swap artifact, and the SECOND reload measured. Under those conditions,
// identical in both arms:
//
//   without this coalescer   14 × "Maximum update depth exceeded"
//   with it                   0   (0 again on a re-run after restoring)
//
//
// During a sync pass every applier therefore still runs its full per-id path —
// the work_item trash router, and each window.api write (whose main-side cascade
// + detach hooks, workItemDetachHook / normalizeAppliedWorkItem, are per call) —
// but its STORE reflection is deferred into the pass. Each reflect queues as an
// updater against its store, node removals union into one Set, and refresh-style
// appliers dedupe to one reload each. When every tracked applier has settled the
// flush replays the queue: ONE setState per touched store (updaters compose in
// arrival order, so the result is what the sequential writes produced), all
// inside one unstable_batchedUpdates block so the whole pass is a single React
// render. A live single event (a plain crdtEvent frame — no pass open) commits
// directly, exactly as before.
type StoreState = Record<string, unknown>
interface StoreLike {
  setState: (updater: (s: never) => object) => void
  getState: () => unknown
}
type Updater = (s: StoreState) => object

interface ApplyPass {
  removedNodes: Set<string> // node deletes (cascades included), applied last
  updates: Map<StoreLike, Updater[]> // per-store updater queue — ONE setState each
  actions: Array<() => void> // reflects that are store ACTIONS, not setState
  reloads: Map<string, () => void> // refresh-style reflects, deduped per pass
  settles: Promise<void>[] // appliers the flush waits for before committing
}
// Non-null from the moment a sync frame opens a pass until its flush has drained
// every tracked applier; frames arriving meanwhile append to the same pass, so at
// most one pass is ever open.
let currentPass: ApplyPass | null = null

// Track an applier the open pass must wait for (no pass open: fire-and-forget).
function track(p: Promise<void>): void {
  if (currentPass) currentPass.settles.push(p)
}
// Queue an updater onto a specific pass (used by the flush itself, after
// currentPass has already been cleared).
function deferUpdateInto<T>(
  pass: ApplyPass,
  store: { setState: (u: (s: T) => object) => void; getState: () => T },
  updater: (s: T) => object
): void {
  const s = store as unknown as StoreLike
  const queue = pass.updates.get(s)
  if (queue) queue.push(updater as Updater)
  else pass.updates.set(s, [updater as Updater])
}

// Queue a store reflect into the open pass; with no pass open, apply it now. The
// updater receives live state when it runs, so a deferred reflect never acts on a
// stale snapshot. An applier resolving after its pass flushed finds currentPass
// null and commits directly — the straggler behaviour it always had.
function deferUpdate<T>(store: { setState: (u: (s: T) => object) => void; getState: () => T }, updater: (s: T) => object): void {
  if (currentPass) deferUpdateInto(currentPass, store, updater)
  else store.setState(updater)
}
// A reflect that goes through a store ACTION (not a setState updater we can
// compose) — still deferred into the pass so it lands inside the one batch.
function deferAction(fn: () => void): void {
  if (currentPass) currentPass.actions.push(fn)
  else fn()
}
// Refresh-style reflects (whole-list reloads) collapse to one call per pass.
function deferReload(key: string, fn: () => void): void {
  if (currentPass) {
    if (!currentPass.reloads.has(key)) currentPass.reloads.set(key, fn)
  } else fn()
}

// Compose a store's queued updaters into ONE setState. zustand merges each
// updater's partial into the state, so folding them in arrival order reproduces
// exactly what the same updaters applied one setState at a time would have.
function applyQueuedUpdaters(store: StoreLike, updaters: Updater[]): void {
  store.setState((prev: never) => {
    let next = prev as StoreState
    for (const u of updaters) {
      try {
        next = { ...next, ...u(next) }
      } catch {
        /* one bad reflect must not drop the rest of the pass */
      }
    }
    return next
  })
}

async function flushApplyPass(pass: ApplyPass): Promise<void> {
  // Drain until quiescent: frames arriving mid-flush append more settles.
  let seen = 0
  while (seen < pass.settles.length) {
    const batch = pass.settles.slice(seen)
    seen = pass.settles.length
    await Promise.allSettled(batch)
  }
  currentPass = null
  // Removals are the pass's last word on the node store (remove-wins), so they
  // ride the node store's own single setState after its queued updaters.
  if (pass.removedNodes.size) {
    const removed = pass.removedNodes
    deferUpdateInto(pass, useNodeStore, (s) => ({
      nodes: (s.nodes as FbNode[]).filter((n) => !removed.has(n.id))
    }))
  }
  // One batch for the whole pass: every store write below collapses into a single
  // React render, which is what keeps the nested-update guard out of reach. React 18
  // also batches automatically; the explicit block ties the guarantee to this code
  // rather than to the host React's heuristics.
  batchedUpdates(() => {
    for (const [store, updaters] of pass.updates) applyQueuedUpdaters(store, updaters)
    for (const fn of pass.actions) {
      try {
        fn()
      } catch {
        /* one bad reflect must not drop the rest of the pass */
      }
    }
  })
  for (const fn of pass.reloads.values()) {
    try {
      fn()
    } catch {
      /* reloads are best-effort; the poll remains the safety net */
    }
  }
}

// ── Cross-type create ordering: pending-create buffer ─────────────────────────
// A create event can arrive before the parent it references exists locally — a
// widget before its task's node, a row before its table, a subtask before its
// parent — because each type syncs in its own partition and events race. The
// window.api.*.create then fails a FOREIGN KEY check. Dropping the create there
// (the old `catch { return }`) was silent data loss; instead we buffer the attempt
// and retry it: immediately when any create succeeds (a freshly-arrived parent may
// unblock a dependent) and on a short backstop timer (covers a parent that lands
// via the poll rather than the log). Attempts are idempotent (create-if-missing)
// and bounded, and the poll remains the ultimate safety net.
interface PendingCreate {
  attempt: () => Promise<boolean> // resolves true when it succeeded (or is moot)
  tries: number
}
const pendingCreates = new Map<string, PendingCreate>()
let drainTimer: ReturnType<typeof setTimeout> | null = null

function armDrain(): void {
  if (drainTimer || pendingCreates.size === 0) return
  drainTimer = setTimeout(() => {
    drainTimer = null
    void drainPending()
  }, 1500)
}
async function drainPending(): Promise<void> {
  for (const [key, p] of [...pendingCreates.entries()]) {
    const ok = await p.attempt().catch(() => false)
    if (ok) pendingCreates.delete(key)
    else if (++p.tries >= 40) pendingCreates.delete(key) // ~60s; give up, the poll backstops
  }
  if (pendingCreates.size) armDrain()
}
// Run a create attempt; on failure buffer it for retry so it is never dropped. On
// success, poke the buffer in case the new object unblocks a waiting dependent.
// Returns the first attempt's settle so a sync pass can wait for it (buffered
// retries stay fire-and-forget — they are the long tail the poll backstops).
function applyCreateGuarded(key: string, attempt: () => Promise<boolean>): Promise<void> {
  return attempt().then((ok) => {
    if (ok) {
      if (pendingCreates.size) void drainPending()
    } else if (!pendingCreates.has(key)) {
      pendingCreates.set(key, { attempt, tries: 0 })
      armDrain()
    }
  })
}

// Persist a remotely-won value and reflect it in the store WITHOUT going through
// the store's own mutation (which would re-emit and loop). The window.api.* write
// hits the base row (and marks it for the poll — the intended dual-write); setState
// updates the open view in place.
async function applyGeomToWidget(id: string, geom: WidgetGeom): Promise<void> {
  try {
    await window.api.widgets.update(id, geom, 'sync')
  } catch {
    /* not on this device's open task; the base write still lands */
  }
  deferUpdate(useWidgetStore, (s) => ({
    widgets: s.widgets.map((w) => (w.id === id ? { ...w, ...geom } : w))
  }))
}

function applyWidgetCreate(snapshot: Record<string, unknown>): void {
  const id = snapshot.id as string
  if (!id || tombstoned.has(id)) return
  track(applyCreateGuarded(`widget:${id}`, () => tryCreateWidget(snapshot)))
}
async function tryCreateWidget(snapshot: Record<string, unknown>): Promise<boolean> {
  const id = snapshot.id as string
  if (tombstoned.has(id)) return true // deleted meanwhile — nothing to create
  let created: Widget | null = null
  try {
    // create-if-missing by id (main honours the provided id + returns the existing
    // row if it is already there), so a replayed/echoed create never duplicates.
    created = await window.api.widgets.create(snapshot as never, 'sync')
  } catch {
    return false // parent task not present locally yet — keep buffered, retry
  }
  if (!created) return false
  // Reflect only if the widget's task is already loaded in the store (its desk is
  // open); otherwise it materialises when that desk is next opened. The base write
  // above is what makes it durable regardless. The presence check lives inside the
  // updater, so a deferred reflect tests the store as it is at commit time.
  const w = created
  deferUpdate(useWidgetStore, (s) =>
    s.widgets.some((x) => x.taskId === w.taskId) && !s.widgets.some((x) => x.id === w.id)
      ? { widgets: [...s.widgets, w] }
      : {}
  )
  return true
}

async function applyWidgetDelete(id: string): Promise<void> {
  tombstoned.add(id)
  try {
    await window.api.widgets.delete(id, 'sync') // soft-delete (recoverable), matches local remove()
  } catch {
    /* not present locally — the tombstone still guards against a later create */
  }
  deferUpdate(useWidgetStore, (s) => ({ widgets: s.widgets.filter((w) => w.id !== id) }))
}

async function applyWidgetField(id: string, field: CrdtField, value: unknown): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (field === 'content') patch.content = value
  else if (field === 'title') patch.title = value
  else if (field === 'color') patch.color = value
  else if (field === 'status') patch.status = value
  else if (field === 'order') patch.zIndex = value
  try {
    await window.api.widgets.update(id, patch, 'sync')
  } catch {
    /* not on this device's open task; base write still lands */
  }
  deferUpdate(useWidgetStore, (s) => ({
    widgets: s.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w))
  }))
}

async function applyMemberToWidget(id: string, section: string | null): Promise<void> {
  try {
    await window.api.widgets.update(id, { parentSectionId: section }, 'sync')
  } catch {
    /* not on the open task; base write still lands */
  }
  deferUpdate(useWidgetStore, (s) => ({
    widgets: s.widgets.map((w) => (w.id === id ? { ...w, parentSectionId: section } : w))
  }))
}

async function applyNodeTitle(id: string, title: string): Promise<void> {
  try {
    await window.api.nodes.update(id, { title }, 'sync')
  } catch {
    /* best effort; the poll remains the safety net */
  }
  deferUpdate(useNodeStore, (s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, title } : n)) }))
}

async function applyNodeParent(id: string, parentId: string | null): Promise<void> {
  try {
    // move() is the validated reparent path (rejects cycles); beforeId null appends
    // at the end since sibling ordering isn't part of this slice.
    await window.api.nodes.move(id, parentId, null)
  } catch {
    /* rejected (cycle/missing) or not present locally — leave state as is */
  }
  deferUpdate(useNodeStore, (s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, parentId } : n)) }))
}

// ── The work_item ARRIVAL ROUTER (§3 D1, Attention S2) ─────────────────────
// The plumbing below this block would DESTROY inbound work_item events:
// nodes.create refuses the kind at the protocol boundary, nodes.delete refuses
// work_item roots (C2), and both refresh useNodeStore, which excludes them.
// kind==='work_item' events therefore route to the workItems db-module
// functions via their own internal channel (full column set, projection
// recomputed main-side, leaf invariant enforced).
const workItemIds = new Set<string>()
async function isWorkItemId(id: string): Promise<boolean> {
  if (workItemIds.has(id)) return true
  // Known desk/room? The store holds every non-work_item node — cheap and
  // covers the entire desk hot path without an IPC round trip.
  if (useNodeStore.getState().nodes.some((n) => n.id === id)) return false
  try {
    const kind = await window.api.workItems.kindOf(id)
    if (kind === 'work_item') {
      workItemIds.add(id)
      return true
    }
  } catch {
    /* unknown id — treat as not-a-work-item; the poll reconciles */
  }
  return false
}

function applyNodeCreate(snapshot: Record<string, unknown>): void {
  const id = snapshot.id as string
  if (!id || tombstoned.has(id)) return
  if (snapshot.kind === 'work_item') {
    workItemIds.add(id)
    void window.api.workItems.applySyncEvent({ type: 'create', snapshot }).catch(() => {
      /* un-migrated / disabled device: the main side parks it (§2.1) */
    })
    return
  }
  track(applyCreateGuarded(`node:${id}`, () => tryCreateNode(snapshot)))
}
async function tryCreateNode(snapshot: Record<string, unknown>): Promise<boolean> {
  const id = snapshot.id as string
  if (tombstoned.has(id)) return true
  let created: FbNode | null = null
  try {
    created = await window.api.nodes.create(snapshot as never, 'sync')
  } catch {
    return false // parent node not present yet — keep buffered
  }
  if (!created) return false
  const node = created
  deferUpdate(useNodeStore, (s) =>
    s.nodes.some((n) => n.id === node.id) ? {} : { nodes: [...s.nodes, node] }
  )
  return true
}

async function applyNodeDelete(id: string): Promise<void> {
  // Router branch (§3 D1): a work_item delete event is its desk's trash sweep
  // propagating (§2.5.1) — soft-trash via the workItems path, never the
  // C2-guarded user delete, and never tombstoned (a purge on the origin
  // device revives it later).
  if (await isWorkItemId(id)) {
    void window.api.workItems
      .applySyncEvent({ type: 'trash', id, trashed: true })
      .catch(() => {})
    return
  }
  tombstoned.add(id)
  let removed: string[] = [id]
  try {
    removed = (await window.api.nodes.delete(id, 'sync')) ?? [id]
  } catch {
    /* not present locally — tombstone still guards a later create */
  }
  for (const r of removed) tombstoned.add(r)
  if (currentPass) {
    for (const r of removed) currentPass.removedNodes.add(r)
    return
  }
  useNodeStore.setState((s) => ({ nodes: s.nodes.filter((n) => !removed.includes(n.id)) }))
}

async function applyNodeAttr(id: string, attr: string, value: unknown): Promise<void> {
  // Router branch (§3 D1): manifest attrs land through the workItems module
  // (projection recomputed main-side; a wire 'status' for a work_item is
  // ignored there — the projection is derived, never written from the wire).
  if (await isWorkItemId(id)) {
    void window.api.workItems.applySyncEvent({ type: 'attr', id, attr, value }).catch(() => {})
    return
  }
  try {
    await window.api.nodes.update(id, { [attr]: value } as never, 'sync')
  } catch {
    /* not present locally — the poll reconciles it */
  }
  deferUpdate(useNodeStore, (s) => ({
    nodes: s.nodes.map((n) => (n.id === id ? ({ ...n, [attr]: value } as typeof n) : n))
  }))
}

async function applyCellToRow(rowId: string, column: string, value: unknown): Promise<void> {
  try {
    await window.api.tables.updateRow(rowId, { cells: { [column]: value } })
  } catch {
    /* the row may not exist on this device yet (creation rides the poll) — the base
       write is skipped and the poll reconciles it; no data is lost */
  }
  deferUpdate(useTablesStore, (s) => {
    let changed = false
    const next: Record<string, FbRow[]> = {}
    for (const [tableId, list] of Object.entries(s.rows)) {
      const idx = list.findIndex((r) => r.id === rowId)
      if (idx === -1) {
        next[tableId] = list
        continue
      }
      const copy = [...list]
      copy[idx] = { ...copy[idx], cells: { ...copy[idx].cells, [column]: value } }
      next[tableId] = copy
      changed = true
    }
    return changed ? { rows: next } : {}
  })
}

function applyRowCreate(snapshot: Record<string, unknown>): void {
  const id = snapshot.id as string
  if (!id || tombstoned.has(id)) return
  track(applyCreateGuarded(`row:${id}`, () => tryCreateRow(snapshot)))
}
async function tryCreateRow(snapshot: Record<string, unknown>): Promise<boolean> {
  const id = snapshot.id as string
  const tableId = snapshot.tableId as string
  if (tombstoned.has(id)) return true
  let created: FbRow | null = null
  try {
    created = await window.api.tables.createRow(snapshot as never)
  } catch {
    return false // parent table not present yet — keep buffered
  }
  if (!created) return false
  // Reflect only if that table's rows are already loaded in the store.
  const row = created
  deferUpdate(useTablesStore, (s) =>
    s.rows[tableId] && !s.rows[tableId].some((r) => r.id === id)
      ? { rows: { ...s.rows, [tableId]: [...s.rows[tableId], row] } }
      : {}
  )
  return true
}

async function applyRowAttr(id: string, attr: string, value: unknown): Promise<void> {
  try {
    await window.api.tables.updateRow(id, { [attr]: value } as never)
  } catch {
    /* not present locally — the poll reconciles it */
  }
  deferUpdate(useTablesStore, (s) => {
    const next: Record<string, FbRow[]> = {}
    let changed = false
    for (const [tid, list] of Object.entries(s.rows)) {
      const idx = list.findIndex((r) => r.id === id)
      if (idx === -1) {
        next[tid] = list
        continue
      }
      const copy = [...list]
      copy[idx] = { ...copy[idx], [attr]: value } as FbRow
      next[tid] = copy
      changed = true
    }
    return changed ? { rows: next } : {}
  })
}

async function applyRowDelete(id: string): Promise<void> {
  tombstoned.add(id)
  try {
    await window.api.tables.deleteRow(id)
  } catch {
    /* not present locally — tombstone still guards a later create */
  }
  deferUpdate(useTablesStore, (s) => {
    const next: Record<string, FbRow[]> = {}
    let changed = false
    for (const [tid, list] of Object.entries(s.rows)) {
      const filtered = list.filter((r) => r.id !== id)
      next[tid] = filtered
      if (filtered.length !== list.length) changed = true
    }
    return changed ? { rows: next } : {}
  })
}

function applyTableCreate(snapshot: Record<string, unknown>): void {
  const id = snapshot.id as string
  if (!id || tombstoned.has(id)) return
  track(applyCreateGuarded(`table:${id}`, () => tryCreateTable(snapshot)))
}
async function tryCreateTable(snapshot: Record<string, unknown>): Promise<boolean> {
  if (tombstoned.has(snapshot.id as string)) return true
  try {
    const created = await window.api.tables.create(snapshot as never)
    if (!created) return false
    deferUpdate(useTablesStore, (s) => ({ tables: { ...s.tables, [created.id]: created } }))
    return true
  } catch {
    return false // parent task not present yet — keep buffered
  }
}

async function applyTableDelete(id: string): Promise<void> {
  tombstoned.add(id)
  try {
    await window.api.tables.delete(id)
  } catch {
    /* not present locally / no-op */
  }
  deferUpdate(useTablesStore, (s) => {
    const tables = { ...s.tables }
    delete tables[id]
    const rows = { ...s.rows }
    delete rows[id]
    return { tables, rows }
  })
}

async function applyTableAttr(id: string, attr: string, value: unknown): Promise<void> {
  try {
    await window.api.tables.update(id, { [attr]: value } as never)
  } catch {
    /* not present locally — the poll reconciles it */
  }
  deferUpdate(useTablesStore, (s) => {
    const t = s.tables[id]
    if (!t) return {}
    return { tables: { ...s.tables, [id]: { ...t, [attr]: value } as typeof t } }
  })
}

async function applyTimeBlock(id: string, field: CrdtField, value: unknown): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (field === 'start') patch.startMs = value
  else if (field === 'duration') patch.durationMin = value
  else if (field === 'title') patch.title = value
  else if (field === 'status') patch.status = value
  try {
    await window.api.timeBlocks.update(id, patch)
  } catch {
    /* not present locally — the poll reconciles it */
  }
  // Reload the visible range so a moved/retitled block reflects; low-frequency
  // (remote edits only), so a full range reload is fine.
  deferReload('timeblocks', () => void useTimeBlockStore.getState().reload())
}

async function applyFile(id: string, field: CrdtField, value: unknown): Promise<void> {
  try {
    if (field === 'name') await window.api.fileManager.rename(id, value as string)
    else await window.api.fileManager.move(id, value as string | null)
  } catch {
    /* rejected or not present locally — the poll reconciles it */
  }
  deferReload('files', () => void useFileManagerStore.getState().refresh())
}

function applyTimeBlockCreate(snapshot: Record<string, unknown>): void {
  const id = snapshot.id as string
  if (!id || tombstoned.has(id)) return
  track(applyCreateGuarded(`timeblock:${id}`, () => tryCreateTimeBlock(snapshot)))
}
async function tryCreateTimeBlock(snapshot: Record<string, unknown>): Promise<boolean> {
  if (tombstoned.has(snapshot.id as string)) return true
  try {
    await window.api.timeBlocks.create(snapshot as never)
  } catch {
    return false // linked task not present yet — keep buffered
  }
  deferReload('timeblocks', () => void useTimeBlockStore.getState().reload())
  return true
}
async function applyTimeBlockDelete(id: string): Promise<void> {
  tombstoned.add(id)
  try {
    await window.api.timeBlocks.delete(id, 'one')
  } catch {
    /* not present locally — tombstone still guards a later create */
  }
  deferReload('timeblocks', () => void useTimeBlockStore.getState().reload())
}

function applyFileCreate(snapshot: Record<string, unknown>): void {
  const id = snapshot.id as string
  if (!id || tombstoned.has(id)) return
  track(applyCreateGuarded(`file:${id}`, () => tryCreateFile(snapshot)))
}
async function tryCreateFile(snapshot: Record<string, unknown>): Promise<boolean> {
  if (tombstoned.has(snapshot.id as string)) return true
  try {
    await window.api.fileManager.createFolder(
      (snapshot.parentId as string | null) ?? null,
      snapshot.name as string,
      snapshot.id as string
    )
  } catch {
    return false // parent folder not present yet — keep buffered
  }
  deferReload('files', () => void useFileManagerStore.getState().refresh())
  return true
}
async function applyFileDelete(id: string): Promise<void> {
  tombstoned.add(id)
  try {
    await window.api.fileManager.delete(id)
  } catch {
    /* not present locally — tombstone still guards a later create */
  }
  deferReload('files', () => void useFileManagerStore.getState().refresh())
}

function applyDocumentCreate(snapshot: Record<string, unknown>): void {
  const id = snapshot.id as string
  if (!id || tombstoned.has(id)) return
  track(applyCreateGuarded(`document:${id}`, () => tryCreateDocument(snapshot)))
}
async function tryCreateDocument(snapshot: Record<string, unknown>): Promise<boolean> {
  if (tombstoned.has(snapshot.id as string)) return true
  try {
    await window.api.documents.create(snapshot as never)
  } catch {
    return false
  }
  deferReload('documents', () => void useDocumentsStore.getState().refresh())
  return true
}
async function applyDocumentDelete(id: string): Promise<void> {
  tombstoned.add(id)
  try {
    await window.api.documents.delete(id)
  } catch {
    /* not present locally — tombstone still guards a later create */
  }
  deferReload('documents', () => void useDocumentsStore.getState().refresh())
}
async function applyDocumentAttr(id: string, attr: string, value: unknown): Promise<void> {
  try {
    await window.api.documents.update(id, { [attr]: value } as never)
  } catch {
    /* not present locally — the poll reconciles it */
  }
  deferReload('documents', () => void useDocumentsStore.getState().refresh())
}

// Reflect a link change into the open canvas: reload the links store only when the
// affected task is the one currently on screen (low-frequency remote edits, so a
// reload is fine); otherwise the base write landed and it shows on next open. The
// active-task check runs inside the deferred thunk, against flush-time state.
function reflectLinks(taskId: string): void {
  deferReload(`links:${taskId}`, () => {
    if (useNodeStore.getState().activeTaskId === taskId) {
      void useLinksStore.getState().loadForTask(taskId)
    }
  })
}
function applyLinkCreate(snapshot: Record<string, unknown>): void {
  const id = snapshot.id as string
  if (!id || tombstoned.has(id)) return
  track(applyCreateGuarded(`link:${id}`, () => tryCreateLink(snapshot)))
}
async function tryCreateLink(snapshot: Record<string, unknown>): Promise<boolean> {
  const id = snapshot.id as string
  if (tombstoned.has(id)) return true
  try {
    // create-if-missing by id, so a replayed/echoed create never duplicates.
    const created = await window.api.widgetLinks.create(
      snapshot.sourceWidgetId as string,
      snapshot.targetWidgetId as string,
      snapshot.taskId as string,
      (snapshot.type as WireType) || undefined,
      id
    )
    if (!created) return false
    // Carry non-default behaviour fields from the snapshot (createLink defaults verb
    // to '' and enabled to true).
    const verb = snapshot.verb as string | undefined
    if ((verb && verb !== '') || snapshot.enabled === false) {
      await window.api.widgetLinks.update(id, { verb, enabled: snapshot.enabled as boolean })
    }
  } catch {
    return false // buffer + retry (e.g. endpoints not present yet)
  }
  reflectLinks(snapshot.taskId as string)
  return true
}
async function applyLinkDelete(id: string): Promise<void> {
  tombstoned.add(id)
  try {
    await window.api.widgetLinks.delete(id)
  } catch {
    /* not present locally — tombstone still guards a later create */
  }
  deferUpdate(useLinksStore, (s) => ({ links: s.links.filter((l) => l.id !== id) }))
}
async function applyLinkAttr(id: string, attr: string, value: unknown): Promise<void> {
  try {
    await window.api.widgetLinks.update(id, { [attr]: value })
  } catch {
    /* not present locally — the poll/next open reconciles it */
  }
  deferUpdate(useLinksStore, (s) => ({
    links: s.links.map((l) => (l.id === id ? ({ ...l, [attr]: value } as typeof l) : l))
  }))
}

function applyEvent(ev: ChangeEvent): void {
  // Record it locally (idempotent) so a reload can re-fold and it survives offline.
  recordLocal(ev, true)
  if (ev.objectType === 'widget') {
    if (ev.field === 'create') {
      void applyWidgetCreate((ev.payload as CreatePayload).snapshot)
    } else if (ev.field === 'delete') {
      track(applyWidgetDelete(ev.objectId))
    } else if (
      ev.field === 'content' ||
      ev.field === 'title' ||
      ev.field === 'color' ||
      ev.field === 'status' ||
      ev.field === 'order'
    ) {
      const remote = registerOf(ev)
      const key = `${ev.field}:${ev.objectId}`
      const local = widgetFieldRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      widgetFieldRegs.set(key, merged)
      if (merged === remote) track(applyWidgetField(ev.objectId, ev.field, remote.value))
    } else if (ev.field === 'geom' && (ev.payload as GeomPayload).geom !== undefined) {
      const remote = geomRegisterOf(ev)
      const local = geomRegs.get(ev.objectId) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      geomRegs.set(ev.objectId, merged)
      if (merged === remote) track(applyGeomToWidget(ev.objectId, remote.value))
    } else if (ev.field === 'members' && (ev.payload as MembersPayload).op !== undefined) {
      const p = ev.payload as MembersPayload
      const st = memberState(ev.objectId)
      if (p.op === 'add') {
        for (const t of p.tags) st.adds.set(t, p.section)
      } else {
        for (const t of p.tags) st.removes.add(t)
      }
      const next = resolvedSection({ geom: null, sections: liveSections(st) })
      const cur = useWidgetStore.getState().widgets.find((w) => w.id === ev.objectId)?.parentSectionId ?? null
      if (next !== cur) track(applyMemberToWidget(ev.objectId, next))
    }
  } else if (ev.objectType === 'node') {
    if (ev.field === 'create') {
      void applyNodeCreate((ev.payload as CreatePayload).snapshot)
    } else if (ev.field === 'delete') {
      track(applyNodeDelete(ev.objectId))
    } else if (ev.field === 'attr' && (ev.payload as AttrPayload).at !== undefined) {
      const p = ev.payload as AttrPayload
      const remote = registerOf(ev)
      const key = `node:${ev.objectId}:${p.attr}`
      const local = attrRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      attrRegs.set(key, merged)
      if (merged === remote) track(applyNodeAttr(ev.objectId, p.attr, remote.value))
    } else if ((ev.field === 'title' || ev.field === 'parent') && (ev.payload as RegisterPayload).at !== undefined) {
      const remote = registerOf(ev)
      const key = `${ev.field}:${ev.objectId}`
      const local = nodeRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      nodeRegs.set(key, merged)
      if (merged === remote) {
        if (ev.field === 'title') track(applyNodeTitle(ev.objectId, remote.value as string))
        else track(applyNodeParent(ev.objectId, remote.value as string | null))
      }
    }
  } else if (ev.objectType === 'row') {
    if (ev.field === 'create') {
      void applyRowCreate((ev.payload as CreatePayload).snapshot)
    } else if (ev.field === 'delete') {
      track(applyRowDelete(ev.objectId))
    } else if (ev.field === 'cell' && typeof (ev.payload as CellPayload).column === 'string' && (ev.payload as CellPayload).at !== undefined) {
      const p = ev.payload as CellPayload
      const remote = registerOf(ev)
      const key = `${ev.objectId}:${p.column}`
      const local = rowRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      rowRegs.set(key, merged)
      if (merged === remote) track(applyCellToRow(ev.objectId, p.column, remote.value))
    } else if (ev.field === 'attr' && (ev.payload as AttrPayload).at !== undefined) {
      const p = ev.payload as AttrPayload
      const remote = registerOf(ev)
      const key = `row:${ev.objectId}:${p.attr}`
      const local = attrRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      attrRegs.set(key, merged)
      if (merged === remote) track(applyRowAttr(ev.objectId, p.attr, remote.value))
    }
  } else if (ev.objectType === 'table') {
    if (ev.field === 'create') {
      void applyTableCreate((ev.payload as CreatePayload).snapshot)
    } else if (ev.field === 'delete') {
      track(applyTableDelete(ev.objectId))
    } else if (ev.field === 'attr' && (ev.payload as AttrPayload).at !== undefined) {
      const p = ev.payload as AttrPayload
      const remote = registerOf(ev)
      const key = `table:${ev.objectId}:${p.attr}`
      const local = attrRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      attrRegs.set(key, merged)
      if (merged === remote) track(applyTableAttr(ev.objectId, p.attr, remote.value))
    }
  } else if (ev.objectType === 'timeblock') {
    const f = ev.field
    if (f === 'create') {
      void applyTimeBlockCreate((ev.payload as CreatePayload).snapshot)
    } else if (f === 'delete') {
      track(applyTimeBlockDelete(ev.objectId))
    } else if (
      (f === 'start' || f === 'duration' || f === 'title' || f === 'status') &&
      (ev.payload as RegisterPayload).at !== undefined
    ) {
      const remote = registerOf(ev)
      const key = `${f}:${ev.objectId}`
      const local = tbRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      tbRegs.set(key, merged)
      if (merged === remote) track(applyTimeBlock(ev.objectId, f, remote.value))
    }
  } else if (ev.objectType === 'file') {
    const f = ev.field
    if (f === 'create') {
      void applyFileCreate((ev.payload as CreatePayload).snapshot)
    } else if (f === 'delete') {
      track(applyFileDelete(ev.objectId))
    } else if ((f === 'name' || f === 'parent') && (ev.payload as RegisterPayload).at !== undefined) {
      const remote = registerOf(ev)
      const key = `${f}:${ev.objectId}`
      const local = fileRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      fileRegs.set(key, merged)
      if (merged === remote) track(applyFile(ev.objectId, f, remote.value))
    }
  } else if (ev.objectType === 'document') {
    if (ev.field === 'create') {
      void applyDocumentCreate((ev.payload as CreatePayload).snapshot)
    } else if (ev.field === 'delete') {
      track(applyDocumentDelete(ev.objectId))
    } else if (ev.field === 'attr' && (ev.payload as AttrPayload).at !== undefined) {
      const p = ev.payload as AttrPayload
      const remote = registerOf(ev)
      const key = `document:${ev.objectId}:${p.attr}`
      const local = attrRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      attrRegs.set(key, merged)
      if (merged === remote) track(applyDocumentAttr(ev.objectId, p.attr, remote.value))
    }
  } else if (ev.objectType === 'link') {
    if (ev.field === 'create') {
      void applyLinkCreate((ev.payload as CreatePayload).snapshot)
    } else if (ev.field === 'delete') {
      track(applyLinkDelete(ev.objectId))
    } else if (ev.field === 'attr' && (ev.payload as AttrPayload).at !== undefined) {
      const p = ev.payload as AttrPayload
      const remote = registerOf(ev)
      const key = `link:${ev.objectId}:${p.attr}`
      const local = attrRegs.get(key) ?? null
      const merged = local ? lwwMerge(local, remote) : remote
      attrRegs.set(key, merged)
      if (merged === remote) track(applyLinkAttr(ev.objectId, p.attr, remote.value))
    }
  } else if (ev.objectType === 'folderentry') {
    applyFolderEntry(ev)
  }
}

// Apply a live-folder tree event into the materialised store. No window.api write:
// the live folder has no local table, so this renderer store IS its local copy (the
// change log on the signal server is the durable record). Create is remove-wins
// against a folder-qualified tombstone; name/parent are LWW registers.
function applyFolderEntry(ev: ChangeEvent): void {
  const folderId = liveFolderIdOf(ev.partitionKey)
  if (!folderId) return
  const tkey = `${folderId}:${ev.objectId}`
  if (ev.field === 'create') {
    if (folderTombstoned.has(tkey)) return
    const snap = (ev.payload as CreatePayload).snapshot as unknown as FolderEntry
    if (snap && typeof snap.id === 'string') {
      deferAction(() => useLiveFolderEntriesStore.getState().applyCreate(folderId, snap))
    }
  } else if (ev.field === 'delete') {
    folderTombstoned.add(tkey)
    deferAction(() => useLiveFolderEntriesStore.getState().applyDelete(folderId, ev.objectId))
  } else if ((ev.field === 'name' || ev.field === 'parent') && (ev.payload as RegisterPayload).at !== undefined) {
    const remote = registerOf(ev)
    const key = `${folderId}::${ev.field}::${ev.objectId}`
    const local = folderRegs.get(key) ?? null
    const merged = local ? lwwMerge(local, remote) : remote
    folderRegs.set(key, merged)
    if (merged === remote) {
      deferAction(() => {
        const store = useLiveFolderEntriesStore.getState()
        if (ev.field === 'name') store.applyName(folderId, ev.objectId, remote.value as string)
        else store.applyParent(folderId, ev.objectId, remote.value as string | null)
      })
    }
  }
}

// ── Socket lifecycle ──────────────────────────────────────────────────────────

function onCrdt(e: CrdtSocketEvent): void {
  if (e.type === 'crdtSync') {
    const events = e.payload.events as ChangeEvent[]
    // Coalesce this replay's store commits into one render pass. A second sync
    // frame arriving while the first is still draining joins that open pass
    // rather than starting a competing one (a join replays several partitions,
    // one frame each — exactly the reload burst this exists to flatten).
    const opened = !currentPass
    const pass: ApplyPass =
      currentPass ?? {
        removedNodes: new Set(),
        updates: new Map(),
        actions: [],
        reloads: new Map(),
        settles: []
      }
    currentPass = pass
    try {
      for (const ev of events) applyEvent(ev)
    } catch (err) {
      // A throw must not strand the pass open — every later commit would then
      // queue behind a flush that never runs.
      if (opened) currentPass = null
      throw err
    }
    if (opened) void flushApplyPass(pass)
    // Everything in the replay is on the server, so any of our own queued events
    // present here are now synced.
    if (events.length) {
      void window.api.crdt.markSynced(events.map((ev) => ({ id: ev.id, seq: ev.seq ?? null })))
    }
  } else {
    applyEvent(e.payload.event as ChangeEvent)
  }
}

function onReauth(): void {
  // Join each enabled active-scope partition (the server relays only to joined
  // sockets), plus the desk partitions for any shared desks currently loaded, then
  // flush the shared offline queue. Re-joining is idempotent on reconnect; the
  // joinedDeskParts set is cleared here so desk rooms are re-joined after a drop.
  joinedDeskParts.clear()
  const parts = [widgetPart, nodePart, rowPart, tbPart, filePart, docPart, linkPart]
  for (const pk of parts) {
    if (pk) sendSocketMessage({ type: 'crdtJoin', payload: { partitionKey: pk } })
  }
  refreshDeskJoins()
  // Re-join every open live-folder room (they are scope-independent, so they persist
  // across an org switch; a reconnect must re-join them to resume receiving deltas).
  for (const folderId of openLiveFolders) {
    sendSocketMessage({ type: 'crdtJoin', payload: { partitionKey: liveFolderPartition(folderId) } })
  }
  if (parts.some(Boolean) || liveFoldersOn) void flushUnsynced()
}

async function flushUnsynced(): Promise<void> {
  try {
    const pending = await window.api.crdt.unsynced(1000)
    if (!pending.length) return
    for (const e of pending) {
      send({
        id: e.id,
        ts: e.ts,
        partitionKey: e.partitionKey,
        objectType: e.objectType as 'widget' | 'node' | 'row' | 'table' | 'timeblock' | 'file' | 'document' | 'folderentry' | 'link',
        objectId: e.objectId,
        field: e.field as CrdtField,
        dataClass: e.dataClass as CrdtDataClass,
        actor: e.actor,
        payload: e.payload as GeomPayload | MembersPayload | RegisterPayload | CellPayload,
        seq: e.seq ?? undefined
      } as ChangeEvent)
    }
    // Optimistic mark: the frames went out over an open socket, the server dedupes
    // by id, and the base data also rides the workspace poll — so marking these
    // synced now cannot lose data even if a frame drops (at worst the log entry
    // reappears on the next join replay). It stops us re-flushing forever.
    await window.api.crdt.markSynced(pending.map((e) => ({ id: e.id })))
  } catch {
    /* best effort — the poll remains the safety net */
  }
}

// The partition scope suffix for the CURRENTLY ACTIVE workspace. The renderer is
// single-org-at-a-time — the main DB scopes every read by getActiveOrgId(), and
// widgets/rows derive scope from their parent, so every in-memory object belongs to
// the active workspace. That makes routing correct without any per-object lookup:
//   - active org is a real org  → `org:<orgId>`  (all members converge; server
//     authorises via orgs.isMember)
//   - active org is personal    → `acct:<accountId>` (this account's devices)
// A shared-desk under the personal scope still rides the poll's shared cycle for
// now; `desk:<id>` routing is a later slice.
function scopeSuffix(accountId: string): string {
  return crdtScopeSuffix(useOrgStore.getState().activeOrgId, accountId)
}

// (Re)compute the per-type partition keys from the flags + the active scope.
function computePartitions(accountId: string): void {
  const s = scopeSuffix(accountId)
  widgetPart = crdtWidgetsEnabled() ? `w:${s}` : null
  nodePart = crdtNodesEnabled() ? `n:${s}` : null
  rowPart = crdtTablesEnabled() ? `r:${s}` : null
  tbPart = crdtTimeBlocksEnabled() ? `t:${s}` : null
  filePart = crdtFilesEnabled() ? `f:${s}` : null
  docPart = crdtDocumentsEnabled() ? `d:${s}` : null
  linkPart = crdtLinksEnabled() ? `l:${s}` : null
  // Live folders have no scoped partition (each is its own room), so this is a plain
  // on/off gate rather than a partition key.
  liveFoldersOn = crdtLiveFoldersEnabled()
}

function currentParts(): (string | null)[] {
  return [widgetPart, nodePart, rowPart, tbPart, filePart, docPart, linkPart]
}

// Re-scope when the active org changes: leave the old scope's rooms, recompute the
// partitions for the new scope, and join them. Registered once and kept across
// stop/start so an org switch always re-routes. In-memory registers are cleared
// because they belong to the previous scope's objects.
let orgUnsub: (() => void) | null = null
let nodeUnsub: (() => void) | null = null
function applyScopeChange(): void {
  if (!started) return
  for (const pk of currentParts()) {
    if (pk) sendSocketMessage({ type: 'crdtLeave', payload: { partitionKey: pk } })
  }
  // Leave the old scope's desk rooms too; onReauth re-joins the ones still loaded.
  for (const pk of joinedDeskParts) sendSocketMessage({ type: 'crdtLeave', payload: { partitionKey: pk } })
  joinedDeskParts.clear()
  geomRegs.clear()
  memberStates.clear()
  nodeRegs.clear()
  attrRegs.clear()
  rowRegs.clear()
  tbRegs.clear()
  fileRegs.clear()
  widgetFieldRegs.clear()
  const acct = useAccountStore.getState().account
  if (!acct) return
  computePartitions(acct.id)
  onReauth()
}

// Start the engine for the signed-in account. Idempotent. No-op (and unregisters
// any prior wiring) when every type flag is off, so toggling the flags off and
// reloading returns the app to pure-poll behaviour.
export function initCrdtSync(): void {
  const wEnabled = crdtWidgetsEnabled()
  const nEnabled = crdtNodesEnabled()
  const tEnabled = crdtTablesEnabled()
  const tbEnabled = crdtTimeBlocksEnabled()
  const fEnabled = crdtFilesEnabled()
  const dEnabled = crdtDocumentsEnabled()
  const lEnabled = crdtLinksEnabled()
  const lfEnabled = crdtLiveFoldersEnabled()
  if (!wEnabled && !nEnabled && !tEnabled && !tbEnabled && !fEnabled && !dEnabled && !lEnabled && !lfEnabled) {
    stopCrdtSync()
    return
  }
  const acct = useAccountStore.getState().account
  if (!acct) return // called again by App once signed in
  accountId = acct.id
  actor = `${acct.id}:${deviceId()}`
  computePartitions(acct.id)
  // Re-route on org switch (subscribe once; survives stop/start).
  if (!orgUnsub) {
    orgUnsub = useOrgStore.subscribe((st, prev) => {
      if (st.activeOrgId !== prev.activeOrgId) applyScopeChange()
    })
  }
  // Join a shared desk's partitions as soon as its nodes appear locally (via the
  // poll or CRDT), so a grantee receives edits other grantees make. Subscribe once.
  if (!nodeUnsub) {
    nodeUnsub = useNodeStore.subscribe((st, prev) => {
      if (st.nodes !== prev.nodes) refreshDeskJoins()
    })
  }
  if (!started) {
    setCrdtSocketHandler(onCrdt)
    setCrdtOpenHandler(onReauth)
    registerCrdtEmit({
      geom: emitGeom,
      membership: emitMembership,
      widgetCreate: emitWidgetCreate,
      widgetDelete: emitWidgetDelete,
      widgetFields: emitWidgetFields,
      nodeTitle: emitNodeTitle,
      nodeParent: emitNodeParent,
      nodeCreate: emitNodeCreate,
      nodeDelete: emitNodeDelete,
      nodeAttrs: emitNodeAttrs,
      rowCells: emitRowCells,
      rowOrder: emitRowOrder,
      rowCreate: emitRowCreate,
      rowDelete: emitRowDelete,
      tableCreate: emitTableCreate,
      tableDelete: emitTableDelete,
      tableAttrs: emitTableAttrs,
      timeBlock: emitTimeBlock,
      timeBlockCreate: emitTimeBlockCreate,
      timeBlockDelete: emitTimeBlockDelete,
      fileName: emitFileName,
      fileParent: emitFileParent,
      fileCreate: emitFileCreate,
      fileDelete: emitFileDelete,
      documentCreate: emitDocumentCreate,
      documentDelete: emitDocumentDelete,
      documentAttrs: emitDocumentAttrs,
      liveFolderOpen,
      liveFolderClose,
      folderEntryCreate: emitFolderEntryCreate,
      folderEntryDelete: emitFolderEntryDelete,
      folderEntryName: emitFolderEntryName,
      folderEntryParent: emitFolderEntryParent,
      linkCreate: emitLinkCreate,
      linkDelete: emitLinkDelete,
      linkAttrs: emitLinkAttrs,
      seedDeskLinks
    })
    started = true
  }
  // If the socket is already authenticated, onReauth won't fire again on its own —
  // join now. If it isn't, the join is idempotent when onReauth fires on connect.
  onReauth()
}

export function stopCrdtSync(): void {
  for (const pk of [widgetPart, nodePart, rowPart, tbPart, filePart, docPart, linkPart]) {
    if (pk) sendSocketMessage({ type: 'crdtLeave', payload: { partitionKey: pk } })
  }
  for (const pk of joinedDeskParts) sendSocketMessage({ type: 'crdtLeave', payload: { partitionKey: pk } })
  joinedDeskParts.clear()
  for (const folderId of openLiveFolders) {
    sendSocketMessage({ type: 'crdtLeave', payload: { partitionKey: liveFolderPartition(folderId) } })
  }
  openLiveFolders.clear()
  folderRegs.clear()
  folderTombstoned.clear()
  liveFoldersOn = false
  registerCrdtEmit(null)
  setCrdtSocketHandler(null)
  setCrdtOpenHandler(null)
  geomRegs.clear()
  memberStates.clear()
  nodeRegs.clear()
  attrRegs.clear()
  rowRegs.clear()
  tbRegs.clear()
  fileRegs.clear()
  widgetFieldRegs.clear()
  tombstoned.clear()
  pendingCreates.clear()
  // Drop any open apply pass: its queued reflects belong to the scope being torn
  // down, and leaving it open would make every later commit queue behind a flush
  // that never runs.
  currentPass = null
  if (drainTimer) {
    clearTimeout(drainTimer)
    drainTimer = null
  }
  widgetPart = null
  nodePart = null
  rowPart = null
  tbPart = null
  filePart = null
  docPart = null
  linkPart = null
  actor = ''
  started = false
}
