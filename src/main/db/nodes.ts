import { randomUUID } from 'crypto'
import { WORK_ITEM_COLUMNS } from '@shared/workItems'
import { getDb } from './database'
import { getActiveOrgId, PERSONAL_ORG_ID } from './activeOrg'
import { emitAutomationEvent } from './automationEvents'
import {
  assertNotSharedRoot,
  assertNotWorkItemRoot,
  assertParentAcceptsChildren,
  collectActiveSubtree,
  detachAndReviveWorkItemDescendants,
  listTrashedRoots,
  purgeDeskPermanently,
  purgeExpiredTrash,
  restoreTrashedTree,
  type TrashedRoot
} from './nodeLifecycle'
import { purgeMemoryForSubjects, type MemoryPurgeSummary } from './memoryPurge'
import { nodesTableAcceptsWorkItems } from './migrateNodesKind'
import { workItemDetachHook } from './workItems'
import { isWorkItemsEnabled } from '../workItemsPref'
import type { FbNode, NodeDraft, NodePatch } from '@shared/types'

/** §2.6 + R006: work_item creation is triple-gated at the db chokepoint —
 *  capability flag ON, personal scope only while the exposure switch is OFF,
 *  and the local DDL must actually accept the kind (same-device guard). */
export class WorkItemCreationRefusedError extends Error {
  readonly code: 'WORK_ITEMS_DISABLED' | 'WORK_ITEMS_PERSONAL_ONLY' | 'WORK_ITEMS_NOT_MIGRATED'
  constructor(code: WorkItemCreationRefusedError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'WorkItemCreationRefusedError'
  }
}

interface NodeRow {
  id: string
  parent_id: string | null
  kind: FbNode['kind']
  title: string
  description: string
  status: FbNode['status']
  priority: number
  interest: number
  importance: number
  sort_order: number
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
  estimate_minutes: number | null
  extensions_minutes: number | null
  resume_markdown: string | null
  resume_updated_at: number | null
  due_date: number | null
  planned_start_at: number | null
  assignee: string | null
  depends_on: string | null
  lag_days: number | null
  attachments_json: string | null
  archived: number | null
  is_plan: number | null
  shared_from_handle: string | null
  shared_root_id: string | null
  work_item_state: string | null
  intent_class: string | null
  intent_sub: string | null
  group_id: string | null
  tags: string | null
  mentions: string | null
  originator_id: string | null
  recipient_id: string | null
  due_at: string | null
  wi_urgency: string | null
  source_ref: string | null
  source_type: string | null
  confidence: number | null
  approval_state: string | null
  reason_code: string | null
  wi_origin: string | null
  schema_epoch: number | null
}

// Exported for the workItems module (S3): work_item rows share the nodes
// table and map through the same shape.
export function mapNodeRow(row: NodeRow): FbNode {
  return rowToNode(row)
}
export type { NodeRow }

function rowToNode(row: NodeRow): FbNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority as FbNode['priority'],
    interest: row.interest as FbNode['interest'],
    importance: row.importance as FbNode['importance'],
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    estimateMinutes: row.estimate_minutes,
    extensionsMinutes: row.extensions_minutes ?? 0,
    resumeMarkdown: row.resume_markdown,
    resumeUpdatedAt: row.resume_updated_at,
    dueDate: row.due_date,
    plannedStartAt: row.planned_start_at ?? null,
    assignee: row.assignee ?? null,
    dependsOn: row.depends_on ?? null,
    lagDays: row.lag_days ?? null,
    attachmentsJson: row.attachments_json ?? null,
    archived: row.archived === 1,
    isPlan: row.is_plan === 1,
    sharedFromHandle: row.shared_from_handle ?? null,
    sharedRootId: row.shared_root_id ?? null,
    // work_item fields (S2): undefined-collapsed to null; only meaningful on
    // kind='work_item' rows.
    //
    // DEC-064 — READ FROM THE MANIFEST, not from a hand-kept list. This block
    // used to name all seventeen columns by hand, so adding one to
    // WORK_ITEM_COLUMNS gave it DDL, sync and emit but NOT a way back out: the
    // value stored fine and read as undefined forever. `source_url` (DEC-052)
    // had been in exactly that state since it shipped — write-only, unnoticed
    // only because nothing had stored one yet. The manifest is the single
    // source of truth or it is decoration.
    ...workItemAttrsOf(row)
  } as FbNode
}

/** Every manifest column, under its attribute name, null-collapsed. */
function workItemAttrsOf(row: NodeRow): Record<string, unknown> {
  const r = row as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const def of WORK_ITEM_COLUMNS) out[def.attr] = r[def.column] ?? null
  return out
}

let purgedTrashThisSession = false

export function listNodes(): FbNode[] {
  const db = getDb()
  if (!purgedTrashThisSession) {
    purgedTrashThisSession = true
    try {
      purgeTrashedNodes()
    } catch {
      /* best-effort */
    }
  }
  // work_item exclusion (S1, the census's highest-leverage single fix): this
  // query feeds useNodeStore and through it every desk/room surface. Work
  // items are listed by their own query (workItems:list, S3), never here.
  const rows = db
    .prepare(
      "SELECT * FROM nodes WHERE trashed_at IS NULL AND kind != 'work_item' AND org_id = ? ORDER BY sort_order ASC, created_at ASC"
    )
    .all(getActiveOrgId()) as NodeRow[]
  return rows.map(rowToNode)
}

export function getNode(id: string): FbNode | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined
  return row ? rowToNode(row) : null
}

function nextSortOrder(parentId: string | null): number {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM nodes WHERE parent_id IS ? AND org_id = ?'
    )
    .get(parentId, getActiveOrgId()) as { next: number }
  return row.next
}

export function createNode(draft: NodeDraft): FbNode {
  const db = getDb()
  if (draft.kind === 'work_item') {
    if (!isWorkItemsEnabled())
      throw new WorkItemCreationRefusedError('WORK_ITEMS_DISABLED', 'Work items are not enabled.')
    if (!nodesTableAcceptsWorkItems(db))
      throw new WorkItemCreationRefusedError(
        'WORK_ITEMS_NOT_MIGRATED',
        'This device has not migrated for work items yet.'
      )
    if (getActiveOrgId() !== PERSONAL_ORG_ID)
      throw new WorkItemCreationRefusedError(
        'WORK_ITEMS_PERSONAL_ONLY',
        'Work items are personal-scope only while the sharing switch is off.'
      )
  }
  // Leaf invariant (§2.5.5): nothing is ever parented under a work_item.
  assertParentAcceptsChildren(db, draft.parentId)
  // WS01 lifecycle: honour a client-provided id so a node created on one device
  // materialises with the SAME id when its create event is applied on another
  // (create-if-missing by primary key). Local creates pass no id → fresh one.
  const id = draft.id ?? randomUUID()
  if (draft.id) {
    const existing = getNode(draft.id)
    if (existing) return existing
  }
  const now = Date.now()
  db.prepare(
    `INSERT INTO nodes (id, parent_id, kind, title, description, status, priority, interest, importance, sort_order, created_at, updated_at, estimate_minutes, extensions_minutes, due_date, is_plan, shared_from_handle, org_id)
     VALUES (@id, @parentId, @kind, @title, @description, 'open', @priority, @interest, @importance, @sortOrder, @now, @now, @estimateMinutes, 0, @dueDate, @isPlan, @sharedFromHandle, @orgId)`
  ).run({
    id,
    parentId: draft.parentId,
    kind: draft.kind,
    title: draft.title,
    description: draft.description ?? '',
    priority: draft.priority ?? 3,
    interest: draft.interest ?? 3,
    importance: draft.importance ?? 3,
    sortOrder: nextSortOrder(draft.parentId),
    estimateMinutes: draft.estimateMinutes ?? null,
    dueDate: draft.dueDate ?? null,
    isPlan: draft.isPlan ? 1 : 0,
    sharedFromHandle: draft.sharedFromHandle ?? null,
    orgId: getActiveOrgId(),
    now
  })
  const created = getNode(id)
  if (!created) throw new Error('Node creation failed post-insert')
  return created
}

// The recipient-side top-level "Shared with me" folder that materialized shared
// desks hang under. Created once in the PERSONAL org (a per-desk share always lives
// in the recipient's personal bucket) regardless of which org is active when the
// shared sync runs, so it mirrors the renderer's ensureSharedFolder. Idempotent.
export function ensureSharedContainer(): string {
  const db = getDb()
  const existing = db
    .prepare(
      `SELECT id FROM nodes WHERE parent_id IS NULL AND kind = 'folder' AND title = ? AND trashed_at IS NULL AND org_id = ? LIMIT 1`
    )
    .get('Shared with me', PERSONAL_ORG_ID) as { id: string } | undefined
  if (existing) return existing.id
  const id = randomUUID()
  const now = Date.now()
  const sortOrder = (
    db
      .prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM nodes WHERE parent_id IS NULL AND org_id = ?'
      )
      .get(PERSONAL_ORG_ID) as { next: number }
  ).next
  db.prepare(
    `INSERT INTO nodes (id, parent_id, kind, title, description, status, priority, interest, importance, sort_order, created_at, updated_at, extensions_minutes, is_plan, org_id)
     VALUES (@id, NULL, 'folder', @title, '', 'open', 3, 3, 3, @sortOrder, @now, @now, 0, 0, @orgId)`
  ).run({ id, title: 'Shared with me', sortOrder, now, orgId: PERSONAL_ORG_ID })
  return id
}

export function updateNode(id: string, patch: NodePatch): FbNode | null {
  const db = getDb()
  const existing = getNode(id)
  if (!existing) return null
  const fields: string[] = []
  const params: Record<string, unknown> = { id, now: Date.now() }
  const cols: Array<[keyof NodePatch, string]> = [
    ['title', 'title'],
    ['description', 'description'],
    ['status', 'status'],
    ['priority', 'priority'],
    ['interest', 'interest'],
    ['importance', 'importance'],
    ['parentId', 'parent_id'],
    ['sortOrder', 'sort_order'],
    ['estimateMinutes', 'estimate_minutes'],
    ['extensionsMinutes', 'extensions_minutes'],
    ['resumeMarkdown', 'resume_markdown'],
    ['resumeUpdatedAt', 'resume_updated_at'],
    ['dueDate', 'due_date'],
    ['plannedStartAt', 'planned_start_at'],
    ['assignee', 'assignee'],
    ['dependsOn', 'depends_on'],
    ['lagDays', 'lag_days'],
    ['attachmentsJson', 'attachments_json']
  ]
  // Leaf invariant (§2.5.5): the parentId patch column is a parent_id writer.
  if (patch.parentId !== undefined) assertParentAcceptsChildren(db, patch.parentId)
  // §2.3 (F008): status for work_items is a DERIVED projection — writable only
  // by the workItems module's state transitions, never patched directly.
  if (existing.kind === 'work_item' && patch.status !== undefined) {
    throw new Error('work_item status is derived from work_item_state — use workItems.setState')
  }
  for (const [key, col] of cols) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = @${key}`)
      params[key] = patch[key]
    }
  }
  if (patch.archived !== undefined) {
    fields.push('archived = @archived')
    params.archived = patch.archived ? 1 : 0
  }
  if (patch.isPlan !== undefined) {
    fields.push('is_plan = @isPlan')
    params.isPlan = patch.isPlan ? 1 : 0
  }
  if (patch.status === 'in_progress' && existing.status !== 'in_progress') {
    fields.push('started_at = @now')
  }
  if (patch.status === 'done' && existing.status !== 'done') {
    fields.push('completed_at = @now')
  }
  if (fields.length === 0) return existing
  fields.push('updated_at = @now')
  db.prepare(`UPDATE nodes SET ${fields.join(', ')} WHERE id = @id`).run(params)
  // Let PlexiFlow react to a task being completed (suppressed during flow runs).
  if (patch.status === 'done' && existing.status !== 'done' && existing.kind === 'task') {
    emitAutomationEvent({ name: 'task-completed', nodeId: id })
  }
  return getNode(id)
}

// Soft-delete a node and its whole subtree (children would otherwise be
// hard-cascaded along with all their widgets). Returns the trashed ids so the
// caller can offer a lossless undo. The rows and widgets are untouched on disk,
// just hidden, until purgeTrashedNodes removes them.
export function deleteNode(id: string): string[] {
  const db = getDb()
  // C2 (§2.5.2): a work_item is never trashed directly — its lifecycle is
  // dismissed/reclassified. Throws a typed error the caller renders.
  assertNotWorkItemRoot(db, id)
  // D1 (DEC-021): a shared desk is never trashed unilaterally — the menu
  // offers Archive-for-me / Leave-share; this typed refusal is the backstop.
  assertNotSharedRoot(db, id)
  const exists = db.prepare('SELECT id FROM nodes WHERE id = ? AND trashed_at IS NULL').get(id)
  if (!exists) return []
  // The sweep INCLUDES work_item children by design (§2.5.1): trash is
  // device-scoped and undo must restore bit-identically. The purge (below) is
  // where work_items are protected — never the trash.
  const ids = collectActiveSubtree(db, id)
  const now = Date.now()
  const stmt = db.prepare('UPDATE nodes SET trashed_at = ? WHERE id = ?')
  db.transaction(() => {
    for (const i of ids) stmt.run(now, i)
  })()
  return ids
}

// Re-scope a room/desk (and everything under it) into another org — the explicit
// "share this desk/room with the team" action. Sets org_id on the node and every
// descendant node, and marks those nodes AND their widgets needs_sync (with
// sync_rev reset, since the org store is a separate keyspace from the personal one)
// so the org sync loop pushes the whole subtree under the new org on its next
// cycle. Widgets carry no org_id of their own — they derive scope from the parent
// node — so only their sync bookkeeping is touched. Returns the affected node ids.
//
// Note: fb_tables referenced by table widgets keep their own org_id and are not
// re-scoped here; a table widget moved to the org still reads its table locally.
// Moving a desk that owns tables into an org is a follow-up.
export function moveNodeToOrg(rootId: string, orgId: string, teamId: string | null = null): string[] {
  const db = getDb()
  if (!orgId) return []
  const exists = db.prepare('SELECT id FROM nodes WHERE id = ? AND trashed_at IS NULL').get(rootId)
  if (!exists) return []
  // §2.6 scope invariant: a work_item may not enter a sync scope whose peers
  // are unconfirmed — the org sweep refuses to carry them. They are detached
  // (park-local) so the moved subtree never carries a cross-org parent link;
  // the count is surfaced by the caller's toast (S6) via the detached return.
  // P1: the confirmation gate exists (workItemsPref.workItemsOrgEnabled) —
  // the org-carry branch that consults it lands with the SPEC-027 pass, so
  // parking stays unconditional here until that architecture is ruled.
  const all = collectActiveSubtree(db, rootId)
  const kindOf = db.prepare('SELECT kind FROM nodes WHERE id = ?')
  const ids = all.filter((i) => (kindOf.get(i) as { kind: string } | undefined)?.kind !== 'work_item')
  const parkedCount = detachAndReviveWorkItemDescendants(db, [rootId], workItemDetachHook(db))
  if (parkedCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[moveNodeToOrg] ${parkedCount} work item(s) stayed personal (park-local)`)
  }
  // Tables backing any table widget on the moved desks must travel too, or the
  // widget lands on the other member pointing at a table that never synced (blank
  // "Loading table…"). A table widget stores its fb_tables id in widget.content.
  const tableIds = (
    db
      .prepare(
        `SELECT DISTINCT content AS id FROM widgets
         WHERE task_id IN (${ids.map(() => '?').join(',')})
           AND kind = 'table' AND content IS NOT NULL AND content != ''`
      )
      .all(...ids) as Array<{ id: string }>
  ).map((r) => r.id)

  // teamId scopes the subtree to a group (null = whole org). Nodes + tables carry
  // team_id; widgets/rows inherit it from their parent at push time.
  const setNode = db.prepare('UPDATE nodes SET org_id = ?, team_id = ?, needs_sync = 1, sync_rev = 0 WHERE id = ?')
  const setWidgets = db.prepare('UPDATE widgets SET needs_sync = 1, sync_rev = 0 WHERE task_id = ?')
  const setTable = db.prepare('UPDATE fb_tables SET org_id = ?, team_id = ?, needs_sync = 1, sync_rev = 0 WHERE id = ?')
  const setRows = db.prepare('UPDATE fb_rows SET needs_sync = 1, sync_rev = 0 WHERE table_id = ?')
  db.transaction(() => {
    for (const i of ids) {
      setNode.run(orgId, teamId, i)
      setWidgets.run(i)
    }
    for (const t of tableIds) {
      setTable.run(orgId, teamId, t)
      setRows.run(t)
    }
  })()
  return ids
}

// Restore trashed nodes (undo of a delete, or redo of a create-undo).
export function restoreNodes(ids: string[]): boolean {
  if (!ids.length) return false
  const db = getDb()
  const stmt = db.prepare('UPDATE nodes SET trashed_at = NULL WHERE id = ?')
  db.transaction(() => {
    for (const i of ids) stmt.run(i)
  })()
  return true
}

// Permanently remove nodes trashed longer than maxAgeMs (default 7 days). The
// hard DELETE cascades their descendants + widgets. Runs once per session.
export function purgeTrashedNodes(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const db = getDb()
  const cutoff = Date.now() - maxAgeMs
  // Delegated to the lifecycle module (§2.5.2/§2.5.3): work_items are never
  // purge targets, their descendants are detached-and-revived before any
  // delete, and every delete re-checks liveness per id in-statement.
  const result = db.transaction(() => purgeExpiredTrash(db, cutoff, workItemDetachHook(db)))()
  if (result.revived > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[purgeTrashedNodes] revived ${result.revived} work item(s) at purge (detached)`)
  }
}

// DEC-021 (D2): the operator's "Delete everything permanently" choice — the
// desk subtree hard-deletes immediately (no trash window) and its MEMORY dies
// with it. Work items detach-and-revive (R008: no work_item hard-delete), the
// dialog copy states both, and a summary is logged + returned for the toast.
export function deleteNodePermanent(id: string): {
  purgedNodes: number
  revived: number
  memory: MemoryPurgeSummary
} {
  const db = getDb()
  const result = db.transaction(() => {
    const purge = purgeDeskPermanently(db, id, workItemDetachHook(db))
    const memory = purgeMemoryForSubjects(db, {
      nodeIds: purge.nodeIds,
      widgetIds: purge.widgetIds
    })
    return { purgedNodes: purge.purgedNodes, revived: purge.revived, memory }
  })()
  // eslint-disable-next-line no-console
  console.log(
    `[purge] permanent delete of ${id}: ${result.purgedNodes} node(s), ` +
      `${result.revived} work item(s) revived, memory: ${result.memory.memoryRows} fact(s), ` +
      `${result.memory.chunkRows} chunk(s), ${result.memory.reviewPoints} review point(s)`
  )
  return result
}

// ── Trash surfacing (lifecycle track L1) ────────────────────────────────────

export interface TrashEntry {
  id: string
  kind: string
  title: string
  trashedAt: number
  /** Epoch ms when the 7-day purge claims it. */
  purgeAt: number
}

const PURGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function listTrash(): TrashEntry[] {
  const db = getDb()
  return listTrashedRoots(db, getActiveOrgId()).map((r: TrashedRoot) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    trashedAt: r.trashed_at,
    purgeAt: r.trashed_at + PURGE_WINDOW_MS
  }))
}

/** Restore a trashed root and its whole trashed subtree (lossless, §2.5.1). */
export function restoreTree(rootId: string): string[] {
  const db = getDb()
  return db.transaction(() => restoreTrashedTree(db, rootId))()
}

// Returns true if `candidateId` is a descendant of `ancestorId` (or equal). Used to prevent
// drag-and-drop from creating a cycle (dropping a parent into its own child).
function isDescendantOrSelf(ancestorId: string, candidateId: string): boolean {
  if (ancestorId === candidateId) return true
  const db = getDb()
  let cur: string | null = candidateId
  // Walk up parent chain; if we hit ancestorId, it's a descendant.
  for (let i = 0; i < 1000; i++) {
    const row = db
      .prepare('SELECT parent_id FROM nodes WHERE id = ?')
      .get(cur) as { parent_id: string | null } | undefined
    if (!row || row.parent_id === null) return false
    if (row.parent_id === ancestorId) return true
    cur = row.parent_id
  }
  return false
}

/**
 * Atomic move: reparent + reorder in one operation.
 *
 *   id           the node being moved
 *   newParentId  destination parent (null = top level)
 *   beforeId     sibling under newParentId to insert before; null = append to end
 *
 * Renumbers all siblings under newParentId sequentially after the move.
 * Returns the updated node, or null if the move was rejected (cycle, missing).
 */
export function moveNode(
  id: string,
  newParentId: string | null,
  beforeId: string | null
): FbNode | null {
  if (id === newParentId) return null
  if (newParentId !== null && isDescendantOrSelf(id, newParentId)) return null

  const db = getDb()
  // Leaf invariant (§2.5.5): moveNode is a parent_id writer.
  assertParentAcceptsChildren(db, newParentId)
  const existing = getNode(id)
  if (!existing) return null

  // Same-parent move: skip the cross-parent dance, just renumber siblings
  const tx = db.transaction(() => {
    // Get siblings under destination parent, excluding the moving node
    const siblings = (
      db
        .prepare(
          'SELECT id, sort_order FROM nodes WHERE parent_id IS ? AND id != ? ORDER BY sort_order ASC, created_at ASC'
        )
        .all(newParentId, id) as Array<{ id: string; sort_order: number }>
    ).map((r) => r.id)

    // Figure out the insert position
    let insertIdx: number
    if (beforeId === null) {
      insertIdx = siblings.length // append
    } else {
      const idx = siblings.indexOf(beforeId)
      insertIdx = idx >= 0 ? idx : siblings.length
    }
    const ordered = [...siblings.slice(0, insertIdx), id, ...siblings.slice(insertIdx)]

    // Write parent_id on the moving node first
    db.prepare('UPDATE nodes SET parent_id = @p, updated_at = @now WHERE id = @id').run({
      p: newParentId,
      now: Date.now(),
      id
    })

    // Renumber every sibling under the destination parent (cheap; usually < 50 siblings)
    const renumber = db.prepare(
      'UPDATE nodes SET sort_order = @order WHERE id = @id'
    )
    ordered.forEach((nid, i) => {
      renumber.run({ order: i, id: nid })
    })
  })
  tx()

  return getNode(id)
}
