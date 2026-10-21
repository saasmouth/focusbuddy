// Node lifecycle mechanics — the single owner of trash/restore/purge/detach
// semantics for the nodes table (Attention layer S1; ARCHITECTURE §2.5).
//
// Why this module exists: the FK is `parent_id … ON DELETE CASCADE` and a
// cascade cannot be kind-filtered, so every hard-delete path must detach (and
// revive) work_item descendants BEFORE deleting, or a desk purge silently
// destroys them. The four sanctioned hard-delete sites (purgeTrashedNodes,
// agentHistory undo, pruneSharedDesk, and DEC-021's operator purge) all route
// through here, and the CI delete-site lock
// (tests/unit/ciDeleteSiteLock.test.ts) fails the build on any new DELETE
// against nodes that does not.
//
// Electron-free: production passes better-sqlite3, tests pass node:sqlite —
// both satisfy LifecycleDb structurally. Callers own transactions.

export interface LifecycleDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
}

// ── Typed refusals ───────────────────────────────────────────────────────────

/** §2.5.2 (validator C2): work_items are never trashed/deleted directly —
 *  dismissed/reclassified is their lifecycle. deleteNode refuses roots. */
export class WorkItemDeleteRefusedError extends Error {
  readonly code = 'WORK_ITEM_DELETE_REFUSED'
  constructor() {
    super('Tasks in Focus are dismissed or reclassified, never deleted directly.')
    this.name = 'WorkItemDeleteRefusedError'
  }
}

/** §2.5.5 (F-M3″): work_items are LEAF nodes at v1 — nothing may be parented
 *  under one, enforced at every parent_id writer. */
export class WorkItemParentRefusedError extends Error {
  readonly code = 'WORK_ITEM_PARENT_REFUSED'
  constructor() {
    super('Nothing can be placed under a task in Focus.')
    this.name = 'WorkItemParentRefusedError'
  }
}

export function nodeKind(d: LifecycleDb, id: string): string | null {
  const row = d.prepare('SELECT kind FROM nodes WHERE id = ?').get(id) as
    | { kind: string }
    | undefined
  return row?.kind ?? null
}

/** Throws when the proposed parent is a work_item (leaf invariant). A null
 *  parent (top level) always passes. */
export function assertParentAcceptsChildren(d: LifecycleDb, parentId: string | null): void {
  if (parentId === null || parentId === undefined) return
  if (nodeKind(d, parentId) === 'work_item') throw new WorkItemParentRefusedError()
}

/** Throws when a direct delete/trash targets a work_item root (C2). */
export function assertNotWorkItemRoot(d: LifecycleDb, id: string): void {
  if (nodeKind(d, id) === 'work_item') throw new WorkItemDeleteRefusedError()
}

/** D1 (DEC-021): a shared desk is never trashed or purged unilaterally in v1 —
 *  the menu offers "Archive for me" / "Leave share" instead, and renders this
 *  refusal's message when anything still reaches the db layer. */
export class SharedDeskTrashRefusedError extends Error {
  readonly code = 'SHARED_DESK_TRASH_REFUSED'
  constructor() {
    super('This desk is shared — leave the share or archive it for yourself instead.')
    this.name = 'SharedDeskTrashRefusedError'
  }
}

export function assertNotSharedRoot(d: LifecycleDb, id: string): void {
  const row = d.prepare('SELECT shared_root_id FROM nodes WHERE id = ?').get(id) as
    | { shared_root_id: string | null }
    | undefined
  if (row?.shared_root_id != null) throw new SharedDeskTrashRefusedError()
}

// ── Subtree walks ────────────────────────────────────────────────────────────

/** Recursive child collection over ACTIVE rows (trashed excluded) — the
 *  deleteNode / moveNodeToOrg shape. Includes work_items: trash deliberately
 *  sweeps them with their desk so undo stays bit-lossless (§2.5.1). */
export function collectActiveSubtree(d: LifecycleDb, rootId: string): string[] {
  const ids: string[] = []
  const kids = d.prepare('SELECT id FROM nodes WHERE parent_id = ? AND trashed_at IS NULL')
  const walk = (nid: string): void => {
    ids.push(nid)
    for (const k of kids.all(nid) as Array<{ id: string }>) walk(k.id)
  }
  walk(rootId)
  return ids
}

/** Descendant walk that TRAVERSES trashed rows too — purge targets are whole
 *  trashed subtrees, and a work_item may sit under a trashed room chain. */
function collectDescendantsIncludingTrashed(d: LifecycleDb, rootId: string): string[] {
  const ids: string[] = []
  const kids = d.prepare('SELECT id FROM nodes WHERE parent_id = ?')
  const walk = (nid: string): void => {
    for (const k of kids.all(nid) as Array<{ id: string }>) {
      ids.push(k.id)
      walk(k.id)
    }
  }
  walk(rootId)
  return ids
}

// ── Detach-and-revive (§2.5.3) ───────────────────────────────────────────────

export interface DetachHook {
  /** S2 records `wi_local.detached_from_id` here; S1 has no satellite table
   *  yet, so the default is a no-op seam. */
  onDetached?(workItemId: string, detachedFromParentId: string | null): void
}

/**
 * Before any hard delete of the given roots: find every work_item in their
 * subtrees, detach it (`parent_id = NULL`) and revive it (`trashed_at = NULL`),
 * so the FK cascade that follows cannot take it. Returns the detached count.
 * Reviving a non-trashed row is a no-op by construction.
 */
export function detachAndReviveWorkItemDescendants(
  d: LifecycleDb,
  rootIds: string[],
  hook?: DetachHook
): number {
  if (!rootIds.length) return 0
  const detach = d.prepare(
    "UPDATE nodes SET parent_id = NULL, trashed_at = NULL, updated_at = ? WHERE id = ? AND kind = 'work_item'"
  )
  const kindOf = d.prepare('SELECT kind, parent_id FROM nodes WHERE id = ?')
  let count = 0
  const now = Date.now()
  for (const root of rootIds) {
    for (const id of collectDescendantsIncludingTrashed(d, root)) {
      const row = kindOf.get(id) as { kind: string; parent_id: string | null } | undefined
      if (row?.kind !== 'work_item') continue
      detach.run(now, id)
      count++
      try {
        hook?.onDetached?.(id, row.parent_id)
      } catch {
        // The detach itself must never fail on bookkeeping (F-m3): log-and-
        // continue is the caller's job via its own hook wrapper.
      }
    }
  }
  return count
}

// ── Trash surfacing (lifecycle track L1) ────────────────────────────────────

export interface TrashedRoot {
  id: string
  kind: string
  title: string
  trashed_at: number
  parent_id: string | null
}

/** Trashed ROOTS: trashed rows whose parent is missing, live, or itself not
 *  trashed — the entries a Trash surface lists (their subtrees restore with
 *  them). Work_items are excluded from the listing: they are never trashed
 *  directly (C2) and travel with their desk. */
export function listTrashedRoots(d: LifecycleDb, orgId: string): TrashedRoot[] {
  return d
    .prepare(
      `SELECT n.id, n.kind, n.title, n.trashed_at, n.parent_id FROM nodes n
       LEFT JOIN nodes p ON p.id = n.parent_id
       WHERE n.trashed_at IS NOT NULL AND n.org_id = ? AND n.kind != 'work_item'
         AND (n.parent_id IS NULL OR p.id IS NULL OR p.trashed_at IS NULL)
       ORDER BY n.trashed_at DESC`
    )
    .all(orgId) as TrashedRoot[]
}

/** Restore a trashed root AND its trashed subtree (bit-lossless, §2.5.1 —
 *  work_item children included). Returns the restored ids. */
export function restoreTrashedTree(d: LifecycleDb, rootId: string): string[] {
  const root = d
    .prepare('SELECT id FROM nodes WHERE id = ? AND trashed_at IS NOT NULL')
    .get(rootId) as { id: string } | undefined
  if (!root) return []
  const ids: string[] = [rootId]
  const kids = d.prepare('SELECT id FROM nodes WHERE parent_id = ? AND trashed_at IS NOT NULL')
  const walk = (nid: string): void => {
    for (const k of kids.all(nid) as Array<{ id: string }>) {
      ids.push(k.id)
      walk(k.id)
    }
  }
  walk(rootId)
  const restore = d.prepare('UPDATE nodes SET trashed_at = NULL WHERE id = ?')
  for (const id of ids) restore.run(id)
  return ids
}

// ── Purge (§2.5.2 — F-C1″ target-vs-victim fix) ─────────────────────────────

/**
 * Hard-delete rows trashed before `cutoffMs`. Work_items are NEVER direct purge
 * targets (the SELECT excludes them); they are only reachable through a
 * parent's cascade, which the detach step above intercepts first. The DELETE
 * re-checks liveness per id in-statement, so a row revived mid-set (a detached
 * work_item, or anything else) can never be deleted regardless of ordering.
 */
/**
 * The prune core (§2.5.3 site 3/3): remove the local materialized copy of a
 * shared desk. Un-stamped work_items under it are detached-and-revived (the
 * cascade cannot be kind-filtered), AND the nodes DELETE excludes work_items
 * outright — at P1 routed items are STAMPED and match shared_root_id directly,
 * where child-detach alone is inert (F-M1″). Both exposure states covered.
 * Caller owns the transaction.
 */
export function pruneSharedRows(
  d: LifecycleDb,
  rootId: string,
  tables: string[],
  hook?: DetachHook
): number {
  let removed = 0
  detachAndReviveWorkItemDescendants(
    d,
    (
      d.prepare('SELECT id FROM nodes WHERE shared_root_id = ?').all(rootId) as Array<{
        id: string
      }>
    ).map((r) => r.id),
    hook
  )
  for (const table of tables) {
    // ci-delete-allowlist: pruneSharedRows (§2.5.3 lock — sanctioned site 3/4)
    const sql =
      table === 'nodes'
        ? `DELETE FROM ${table} WHERE shared_root_id = ? AND kind != 'work_item'`
        : `DELETE FROM ${table} WHERE shared_root_id = ?`
    const r = d.prepare(sql).run(rootId) as { changes?: number }
    removed += r?.changes ?? 0
  }
  return removed
}

export function purgeExpiredTrash(
  d: LifecycleDb,
  cutoffMs: number,
  hook?: DetachHook
): { purged: number; revived: number } {
  const targets = d
    .prepare(
      "SELECT id FROM nodes WHERE trashed_at IS NOT NULL AND trashed_at < ? AND kind != 'work_item'"
    )
    .all(cutoffMs) as Array<{ id: string }>
  if (!targets.length) return { purged: 0, revived: 0 }
  const rootIds = targets.map((t) => t.id)
  const revived = detachAndReviveWorkItemDescendants(d, rootIds, hook)
  // ci-delete-allowlist: purgeExpiredTrash (§2.5.3 lock — sanctioned site 1/4)
  const del = d.prepare('DELETE FROM nodes WHERE id = ? AND trashed_at IS NOT NULL')
  let purged = 0
  for (const t of targets) {
    const res = del.run(t.id) as { changes?: number }
    if ((res?.changes ?? 0) > 0) purged++
  }
  return { purged, revived }
}

/** Recursive child collection over ALL rows, trashed included — the operator
 *  purge shape: "delete everything permanently" must take the whole subtree
 *  regardless of trash state, or a half-trashed desk leaks orphans. */
export function collectSubtreeAll(d: LifecycleDb, rootId: string): string[] {
  const ids: string[] = []
  const kids = d.prepare('SELECT id FROM nodes WHERE parent_id = ?')
  const walk = (nid: string): void => {
    ids.push(nid)
    for (const k of kids.all(nid) as Array<{ id: string }>) walk(k.id)
  }
  walk(rootId)
  return ids
}

/**
 * DEC-021 (D2) — the operator's "Delete everything permanently" choice: an
 * immediate hard-delete of one desk/room subtree, skipping the trash window
 * the operator just opted out of. Refusals first (C2: never a work_item root;
 * D1: never a shared desk). Work_item descendants DETACH AND REVIVE — R008
 * ratified no-hard-delete for work items, so even the permanent purge
 * preserves them (the dialog copy states it). Returns the subtree's widget
 * ids, captured BEFORE the delete cascades them away, so the caller can purge
 * their memory derivations (db/memoryPurge.ts).
 */
export function purgeDeskPermanently(
  d: LifecycleDb,
  rootId: string,
  hook?: DetachHook
): { purgedNodes: number; revived: number; nodeIds: string[]; widgetIds: string[] } {
  assertNotWorkItemRoot(d, rootId)
  assertNotSharedRoot(d, rootId)
  const exists = d.prepare('SELECT id FROM nodes WHERE id = ?').get(rootId)
  if (!exists) return { purgedNodes: 0, revived: 0, nodeIds: [], widgetIds: [] }
  const all = collectSubtreeAll(d, rootId)
  const revived = detachAndReviveWorkItemDescendants(d, [rootId], hook)
  // Detached work items left the subtree above (alive, parent NULL) — they are
  // excluded from both the delete and the memory purge. Widget ids first: the
  // delete destroys the task_id linkage.
  const remaining = all.filter((id) => nodeKind(d, id) !== 'work_item')
  const widgetIds: string[] = []
  const widgetsOf = d.prepare('SELECT id FROM widgets WHERE task_id = ?')
  for (const id of remaining) {
    for (const w of widgetsOf.all(id) as Array<{ id: string }>) widgetIds.push(w.id)
  }
  // Explicit per-row delete, leaves first — never trusts the FK cascade
  // (foreign_keys pragma state differs across connections), and is idempotent
  // when the pragma IS on and the root delete already cascaded.
  // ci-delete-allowlist: purgeDeskPermanently (§2.5.3 lock — sanctioned site 4/4, DEC-021)
  const del = d.prepare('DELETE FROM nodes WHERE id = ?')
  let purgedNodes = 0
  for (const id of [...remaining].reverse()) {
    const res = del.run(id) as { changes?: number }
    if ((res?.changes ?? 0) > 0) purgedNodes++
  }
  return { purgedNodes, revived, nodeIds: remaining, widgetIds }
}
