interface Db {
  prepare(sql: string): { run(...a: unknown[]): { changes?: number }; all(...a: unknown[]): unknown[] }
}

// Rows pointing at nodes that no longer exist.
//
// Every one of these tables declares ON DELETE CASCADE, and foreign keys are
// ON at runtime -- so in ordinary use they cannot be orphaned. They get that
// way during the nodes table REBUILD (migrateNodesKind), which must turn
// foreign keys off to swap the table and therefore performs no cascades while
// it runs.
//
// The damage is small -- a snapshot of a desk that no longer exists is only
// wasted space -- but `PRAGMA foreign_key_check` failing is the kind of thing
// that bites much later, when some future migration rebuilds a table with keys
// ON and refuses to start. Cheap to sweep, so it is swept.
//
// Deliberately narrow: only rows whose parent NODE is gone. It does not go
// looking for other kinds of inconsistency, because a cleanup that deletes
// things nobody asked it to look at is worse than the mess.
// Written out one statement per table rather than looped over a table name.
//
// A deletion whose table name is interpolated is stopped by the
// ci-delete-allowlist check, and rightly: a variable could resolve to `nodes`,
// and the sanctioned enumeration of node-deleting sites is closed at two
// files. Spelling each statement out keeps that enumeration closed, and makes
// it readable at a glance exactly which tables this touches -- the property
// that matters for something that removes rows on startup.
//
// (The check scans line by line, so even quoting the interpolated form in a
// comment trips it. This paragraph is worded to avoid that.)
//
// time_blocks.task_id is nullable: a generic focus block belongs to no task,
// so the IS NOT NULL guard is what stops this deleting somebody's calendar.
const SWEEPS: ReadonlyArray<{ table: string; sql: string }> = [
  {
    table: 'canvas_snapshots',
    sql: 'DELETE FROM canvas_snapshots WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM nodes)'
  },
  {
    table: 'widgets',
    sql: 'DELETE FROM widgets WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM nodes)'
  },
  {
    table: 'time_blocks',
    sql: 'DELETE FROM time_blocks WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM nodes)'
  },
  {
    table: 'contact_links',
    sql: 'DELETE FROM contact_links WHERE node_id IS NOT NULL AND node_id NOT IN (SELECT id FROM nodes)'
  }
]

export function reconcileNodeOrphans(db: Db): Record<string, number> {
  const removed: Record<string, number> = {}
  for (const { table, sql } of SWEEPS) {
    try {
      const n = db.prepare(sql).run().changes ?? 0
      if (n > 0) removed[table] = n
    } catch {
      // A table this database does not have yet is not a problem: the sweep is
      // best-effort and must never block startup.
    }
  }
  return removed
}
