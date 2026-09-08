// The cloud runtime's replacement for src/main/db/database.ts.
//
// It exports the same four functions the rest of the data layer imports --
// getDb above all, which 50 modules use -- so those modules compile and run
// here untouched. The web build swaps this in by module path (see
// vite.web.config.ts); nothing in src/main/db knows there are two of these.
//
// What differs from the desktop is only where the bytes live. Both runtimes
// call applySchemaAndMigrations, and that matters more than it looks: a first
// version of this file ran db.exec(SCHEMA) alone, on the reasoning that a
// database created here is born at the current schema and has nothing to
// migrate. That was wrong. 135 ensureColumn calls follow SCHEMA, and among the
// columns they add are widgets.trashed_at, widgets.pinned and nodes.org_id --
// all of which travel in sync bodies. Because applyRemote writes the
// intersection of the body and the local table, the browser accepted desk rows
// from the desktop and dropped those columns without an error anywhere. The
// symptom would have been widgets quietly losing their pinned state and
// deletions failing to stick, seen only after a round trip.
import { applySchemaAndMigrations } from '../../main/db/migrations'
import { initSqlite, openDatabase, type SqliteDb } from './sqlite'

const DB_NAME = 'plexii.db'

let db: SqliteDb | null = null

/**
 * Load WASM and open the database. Must be awaited once before getDb is
 * reachable -- the Worker entry does this before it will answer any call.
 */
export async function openWorkspaceDatabase(): Promise<void> {
  if (db) return
  await initSqlite()
  const handle = await openDatabase(DB_NAME)
  handle.pragma('foreign_keys = ON')
  // WAL is deliberately not set: the OPFS pool VFS is single-connection, so WAL
  // buys nothing here and its sidecar files are not free in that VFS.
  applySchemaAndMigrations(handle as never)
  db = handle
}

/**
 * The live database handle.
 *
 * Synchronous, like its desktop counterpart, which is what lets the data layer
 * run unchanged. That is only sound because opening is awaited before the
 * Worker accepts its first message; a caller that reaches this first has found
 * a real ordering bug, so it throws rather than opening something empty.
 */
export function getDb(): SqliteDb {
  if (!db) throw new Error('getDb() before openWorkspaceDatabase() resolved')
  return db
}

/** Present for parity with the desktop module; OPFS holds one named database. */
export function databaseFilePath(): string {
  return `opfs:/${DB_NAME}`
}

export function closeDb(): void {
  db?.close()
  db = null
}

/**
 * The desktop reports the nodes-kind widening here. The browser applies the
 * same migration through applySchemaAndMigrations but has no status surface to
 * report it to yet, so this stays null rather than inventing a result.
 */
export function nodesKindMigrationStatus(): null {
  return null
}
