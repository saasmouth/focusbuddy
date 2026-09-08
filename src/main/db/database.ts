import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { NodesKindMigrationResult } from './migrateNodesKind'
import { applySchemaAndMigrations } from './migrations'

// The outcome of the nodes-kind widening on THIS boot, queryable by the sync
// status surface: a 'no-check-clause' skip means the local DB never became
// work_item-capable and must be surfaced loudly, not silently retried (§2.1).
let nodesKindMigration: NodesKindMigrationResult | null = null
export function nodesKindMigrationStatus(): NodesKindMigrationResult | null {
  return nodesKindMigration
}

let db: Database.Database | null = null

// Bump this whenever a schema migration is added. It gates the pre-upgrade
// safety backup (see getDb): the snapshot is taken once per version bump, not on
// every launch. It is NOT used to decide whether the idempotent migrations run —
// those still run every launch.
// v3: taxonomy alignment — intent_class values rewritten to the eight
// primaries + the intent_sub reserved column (migrateIntentTaxonomyV2).
const MIGRATION_VERSION = 3

// Synchronous, transactionally-consistent snapshot of the live database taken
// BEFORE any migration runs, via SQLite's VACUUM INTO. It produces one
// self-contained file with no WAL/SHM sidecars and does not modify the source.
// Throws on failure so the caller can refuse to migrate a database it could not
// first back up — a migration with no restore point is the exact risk this
// guards against.
function backupBeforeMigrating(d: Database.Database): void {
  const dir = join(app.getPath('userData'), 'backups')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  const dest = join(dir, `pre-migrate-${ts}.fbbackup`)
  // VACUUM INTO refuses to overwrite; the timestamped name avoids collisions.
  d.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
}


// The on-disk path of the live database. Single source of truth so the backup
// module and getDb never drift on where the data actually lives.
export function databaseFilePath(): string {
  return join(app.getPath('userData'), 'focusbuddy.db')
}

export function getDb(): Database.Database {
  if (db) return db
  const dbPath = databaseFilePath()
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Bound how much of each index ANALYZE samples. Without a limit, ANALYZE on a
  // large table is a full scan; with one, PRAGMA optimize on close is cheap
  // enough to run every session. 400 is SQLite's own suggested value.
  db.pragma('analysis_limit = 400')
  // Pre-upgrade safety backup. Before running any schema migration on an
  // existing database with real data, snapshot it so a failed migration always
  // has a restore point. Reading user_version and sqlite_master does not mutate
  // the database, so this happens strictly before the first migrating statement.
  // If the snapshot cannot be written we do NOT migrate — we throw and leave the
  // database untouched rather than migrate without a restore point.
  const priorMigrationVersion = Number(db.pragma('user_version', { simple: true })) || 0
  const hasExistingData =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get() != null
  if (hasExistingData && priorMigrationVersion < MIGRATION_VERSION) {
    backupBeforeMigrating(db)
  }
  // Schema + migrations, shared with the cloud runtime (see ./migrations.ts).
  nodesKindMigration = applySchemaAndMigrations(db)
  return db
}

// One-time grandfather for the Rooms/Desks/Plans split. Before this change, the
// Plans portfolio treated EVERY folder that contained tasks as a plan. Now a
// folder is a plan only when is_plan = 1. To preserve every existing user's
// current plans, we set is_plan = 1 on any folder that already has a task
// descendant AND is not itself marked done — but only once, guarded by a marker
// row so a later manual "this Room is not a Plan" choice is never undone on the
// next boot. New folders keep the is_plan = 0 default.

export function closeDb(): void {
  if (db) {
    // Refresh planner statistics on the way out. PRAGMA optimize re-ANALYZEs
    // only the tables that changed enough to matter, so this is cheap, and
    // shutdown is the one moment the cost is invisible to the user.
    try {
      db.pragma('optimize')
    } catch (err) {
      console.warn('[db] PRAGMA optimize on close failed:', err)
    }
    db.close()
    db = null
  }
}
