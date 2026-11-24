// Tombstones that a hard delete still owes the server (4.3.55).
//
// The owner's rule (24 Nov 2026): what you delete is erased from our server 30
// days after you delete it; the signal counts from its tombstone. A soft delete
// sends its tombstone on the next sync cycle (a dirty trashed row is a DELETE in
// workspaceSync's collectors). A HARD delete removes the row first, so nothing
// was ever sent and the server item stayed live, content and all, for ever, and a
// new device's pull brought it back. The hard deletes a person makes ("Delete
// permanently", Drive's and Office's "Delete forever", the Trash ageing out, the
// AI's undo, and the widgets a desk takes with it by cascade) call
// queueTombstones first. It records, for each row the server still holds live,
// the kind, the id, where it syncs and the rev it was at: never content.
//
// workspaceSync sends them with the ordinary deletes, at that base rev, so a
// server copy restored or edited elsewhere since answers 409 and wins. markPushed
// clears an entry; a pull of the item clears it when the server already deleted it
// or holds a newer rev, and a pull at the rev we deleted never brings the row back.
// Personal entries go only on the personal loop, so a device set to keep its
// workspace local sends them only once sync is on. Pruning a shared desk you lost
// access to never calls this: that is not your delete.
//
// Electron-free (prepare only), like nodeLifecycle.ts, which calls it.

export interface QueueDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
}

export type TombstoneKind = 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'
export type TombstoneScope = 'personal' | 'org' | 'shared'

const TABLE: Record<TombstoneKind, string> = {
  node: 'nodes',
  widget: 'widgets',
  timeblock: 'time_blocks',
  document: 'documents',
  table: 'fb_tables',
  row: 'fb_rows',
  file: 'fb_files'
}
// Where it syncs: its own org, or its desk's (a widget), or its table's (a row).
const ORG_OF: Record<TombstoneKind, string> = {
  node: 'x.org_id',
  widget: '(SELECT n.org_id FROM nodes n WHERE n.id = x.task_id)',
  timeblock: 'x.org_id',
  document: 'x.org_id',
  table: 'x.org_id',
  row: '(SELECT t.org_id FROM fb_tables t WHERE t.id = x.table_id)',
  file: 'x.org_id'
}
const HAS_SHARED_ROOT = new Set<TombstoneKind>(['node', 'widget', 'table', 'row'])
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // an entry the server never takes stops retrying

// Table-guarded, as the memory purge is: a database without the sync columns or
// this table (a minimal test schema) has nothing that reached a server. The real
// schema always has both (migrations.ts).
function syncs(d: QueueDb, table: string): boolean {
  const has = (t: string, col?: string): boolean => {
    const cols = d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>
    return col ? cols.some((c) => c.name === col) : cols.length > 0
  }
  return has('pending_tombstones') && has(table, 'sync_rev') && has(table, 'needs_sync')
}

/**
 * Queue a tombstone for each of `ids` the server still holds live: on the server
 * (sync_rev > 0) and not a trash whose delete already went up. Call it BEFORE the
 * hard delete. Returns how many were queued.
 */
export function queueTombstones(d: QueueDb, kind: TombstoneKind, ids: readonly string[], now = Date.now()): number {
  if (!ids.length || !syncs(d, TABLE[kind])) return 0
  const root = HAS_SHARED_ROOT.has(kind) ? 'x.shared_root_id' : 'NULL'
  const sel = d.prepare(
    `SELECT x.sync_rev AS rev, ${ORG_OF[kind]} AS org, ${root} AS root FROM ${TABLE[kind]} x
     WHERE x.id = ? AND COALESCE(x.sync_rev, 0) > 0 AND (x.trashed_at IS NULL OR x.needs_sync = 1)`
  )
  const ins = d.prepare(
    `INSERT OR REPLACE INTO pending_tombstones (item_type, id, scope, org_id, root_id, base_rev, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  let n = 0
  for (const id of ids) {
    const r = sel.get(id) as { rev: number; org: string | null; root: string | null } | undefined
    if (!r) continue
    const scope: TombstoneScope = r.root ? 'shared' : r.org && r.org !== 'personal' ? 'org' : 'personal'
    ins.run(kind, id, scope, scope === 'org' ? r.org : null, scope === 'shared' ? r.root : null, r.rev, now)
    n++
  }
  return n
}

/** The tombstones owed in one scope (an org's, for scope 'org'), oldest first. */
export function pendingTombstones(
  d: QueueDb,
  scope: TombstoneScope,
  orgId?: string,
  now = Date.now()
): Array<{ itemType: TombstoneKind; id: string; baseRev: number; rootId: string | null }> {
  d.prepare('DELETE FROM pending_tombstones WHERE queued_at < ?').run(now - MAX_AGE_MS)
  const rows = d
    .prepare(
      `SELECT item_type, id, base_rev, root_id FROM pending_tombstones
       WHERE scope = ? AND (? IS NULL OR org_id = ?) ORDER BY queued_at`
    )
    .all(scope, orgId ?? null, orgId ?? null) as Array<{ item_type: TombstoneKind; id: string; base_rev: number; root_id: string | null }>
  return rows.map((r) => ({ itemType: r.item_type, id: r.id, baseRev: r.base_rev, rootId: r.root_id }))
}

/** The rev we deleted an item at, if a tombstone for it is still owed. */
export function queuedRev(d: QueueDb, kind: string, id: string): number | undefined {
  const r = d.prepare('SELECT base_rev FROM pending_tombstones WHERE item_type = ? AND id = ?').get(kind, id) as
    | { base_rev: number }
    | undefined
  return r?.base_rev
}

export function clearTombstone(d: QueueDb, kind: string, id: string): void {
  d.prepare('DELETE FROM pending_tombstones WHERE item_type = ? AND id = ?').run(kind, id)
}
