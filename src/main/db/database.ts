import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { migrateNodesKindCheckV2, type NodesKindMigrationResult } from './migrateNodesKind'
import { repairBrowsingHistoryCounts } from './migrateBrowsingHistoryCounts'
import { ensureWorkItemSchema } from './workItems'
import { ensureNotificationSchema } from '../notifications/substrate'

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
const MIGRATION_VERSION = 2

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'task', 'task-item', 'work_item')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 3,
  interest INTEGER NOT NULL DEFAULT 3,
  importance INTEGER NOT NULL DEFAULT 3,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL DEFAULT 50,
  y INTEGER NOT NULL DEFAULT 50,
  width INTEGER NOT NULL DEFAULT 320,
  height INTEGER NOT NULL DEFAULT 240,
  z_index INTEGER NOT NULL DEFAULT 1,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_task_id TEXT,
  widgets_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS browsing_history (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  first_visited_at INTEGER NOT NULL,
  last_visited_at INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT '5min',
  planned_seconds INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  actual_seconds INTEGER,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS connected_apps (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'apps',
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_layouts (
  dashboard_key TEXT PRIMARY KEY,
  card_ids TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt TEXT NOT NULL,
  verifier_iv TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_entries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  username TEXT,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS energy_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('low', 'medium', 'high'))
);

-- ── Uploaded files (attachments, image/PDF/video/audio widgets) ──────────────
-- We copy any file the user drops onto PlexiDesk into userData/files/<id>.<ext>
-- so it survives moves of the original. fb_files holds the metadata; the
-- on-disk path is reconstructed from id + ext at read time.
CREATE TABLE IF NOT EXISTS fb_files (
  id TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  ext TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ── Notion/Airtable-style database tables ────────────────────────────────────
-- Each fb_table is a logical "database": user-named, scoped to a task or
-- global. Schema (columns) lives as JSON in schema_json so we don't need a
-- migration per column-type change. Rows live in fb_rows, one row per record,
-- with cells_json mapping columnId → value.
CREATE TABLE IF NOT EXISTS fb_tables (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  title TEXT NOT NULL DEFAULT 'Untitled',
  schema_json TEXT NOT NULL DEFAULT '{"columns":[]}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fb_rows (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES fb_tables(id) ON DELETE CASCADE,
  cells_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_rows_table_sort ON fb_rows(table_id, sort_order ASC);

-- ── PlexiBrain knowledge base ────────────────────────────────────────────────
-- Curated company knowledge that both people and the AI read from. tags_json is
-- a JSON string array; pinned entries sort first and are surfaced first to the
-- assistant's grounding.
CREATE TABLE IF NOT EXISTS fb_knowledge (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled entry',
  body TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_knowledge_updated ON fb_knowledge(pinned DESC, updated_at DESC);

-- ── PlexiMeet meetings ───────────────────────────────────────────────────────
-- Recorded or noted meetings with transcript, AI summary and extracted action
-- items (action_items_json is a JSON string array).
CREATE TABLE IF NOT EXISTS fb_meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled meeting',
  transcript TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  action_items_json TEXT NOT NULL DEFAULT '[]',
  duration_sec INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_meetings_created ON fb_meetings(created_at DESC);

-- ── PlexiBuild apps ──────────────────────────────────────────────────────────
-- No-code apps: a named component stack (components_json) built and run in-app.
CREATE TABLE IF NOT EXISTS fb_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Untitled app',
  icon TEXT NOT NULL DEFAULT 'widgets',
  components_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_apps_updated ON fb_apps(updated_at DESC);

-- ── PlexiForms forms ─────────────────────────────────────────────────────────
-- A form points at a backing fb_tables table (fields = columns, responses =
-- rows). table_id references that table.
CREATE TABLE IF NOT EXISTS fb_forms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled form',
  description TEXT NOT NULL DEFAULT '',
  table_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_forms_updated ON fb_forms(updated_at DESC);

-- ── PlexiSign signature requests ─────────────────────────────────────────────
-- One signature request ("envelope"): the agreement body, an ordered set of
-- signers (JSON), an append-ordered audit trail (JSON, ordering maintained by the
-- engine, not a cryptographic chain), and a completion certificate (sha256 over
-- body + signatures). Self-contained, local-first.
CREATE TABLE IF NOT EXISTS fb_sign_requests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled agreement',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  signers TEXT NOT NULL DEFAULT '[]',
  audit TEXT NOT NULL DEFAULT '[]',
  certificate TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fb_sign_updated ON fb_sign_requests(updated_at DESC);

-- ── Semantic-retrieval embeddings ────────────────────────────────────────────
-- A vector store keyed by (item_type, item_id): one table for knowledge,
-- document and future embeddings. vector_json is a JSON float array; dim + model
-- are recorded so a model change can be reindexed. Powers semantic search and AI
-- grounding; populated only when an embedding key is configured.
CREATE TABLE IF NOT EXISTS fb_embeddings (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);

-- ── AI-enriched document metadata ────────────────────────────────────────────
-- A distilled, structured description of a document, generated at rest by the
-- LOCAL model (Ollama) so it costs no cloud credit. Feeds two things: the
-- embedding text (so a long doc's whole gist is indexed, not just its head) and
-- the grounding header the workspace-ask answer sends the model (title +
-- category + date + entities + summary before the body). Entities/dates/keywords
-- are JSON arrays of strings. Nullable + additive: a doc with no row simply falls
-- back to the pre-enrichment behaviour, and enrichment never fabricates — an
-- unreachable local model leaves the row unwritten rather than inventing a summary.
CREATE TABLE IF NOT EXISTS fb_document_metadata (
  doc_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  entities_json TEXT NOT NULL DEFAULT '[]',
  dates_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  enriched_at INTEGER NOT NULL
);

-- ── Self-building memory ─────────────────────────────────────────────────────
-- Durable things the assistant knows about the user and their work, so it stops
-- starting cold. Two sources: 'user' (things stated explicitly / "remember this")
-- and 'extracted' (facts + commitments the LOCAL model distilled from the user's
-- own documents/chats — grounded, never invented). kind is fact / preference /
-- commitment. subject is the entity it concerns (person/org/project) when there
-- is one; due carries a commitment's deadline phrase verbatim. dedup_key is a
-- normalised form of the text so the same memory isn't stored twice. active lets
-- a memory be forgotten without losing the audit row.
CREATE TABLE IF NOT EXISTS fb_memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'fact',
  text TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  due TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'user',
  source_ref TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  dedup_key TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_memory_active ON fb_memory(active, updated_at DESC);

-- ── PlexiProjects task dependencies ──────────────────────────────────────────
-- Finish-to-start links between task nodes that drive the Gantt schedule and the
-- critical path. pred_id must finish before succ_id can start. Both reference
-- nodes; the row is removed when either task is deleted. UNIQUE prevents a
-- duplicate edge in the same direction.
CREATE TABLE IF NOT EXISTS fb_task_deps (
  id TEXT PRIMARY KEY,
  pred_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  succ_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dep_type TEXT NOT NULL DEFAULT 'FS',
  lag_days INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (pred_id, succ_id)
);
CREATE INDEX IF NOT EXISTS idx_fb_task_deps_succ ON fb_task_deps(succ_id);
CREATE INDEX IF NOT EXISTS idx_fb_task_deps_pred ON fb_task_deps(pred_id);

-- PlexiProjects 2.0: a per-project working calendar (which weekdays are working,
-- plus holiday dates). Absent row = the Mon-Fri default.
CREATE TABLE IF NOT EXISTS fb_project_calendars (
  project_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  working_days TEXT NOT NULL DEFAULT '[false,true,true,true,true,true,false]',
  holidays_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- PlexiProjects 2.0: baseline snapshots of a plan, for planned-vs-actual variance.
-- tasks_json is a map of taskId -> { startMs, endMs } captured at the time.
CREATE TABLE IF NOT EXISTS fb_project_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tasks_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_baselines_project ON fb_project_baselines(project_id, created_at DESC);

-- ── PlexiReports ─────────────────────────────────────────────────────────────
-- A report is a saved selection of tables plus a schedule and recipients. Its
-- last generated output (Markdown) is cached with a flag recording whether it was
-- an AI narrative or the plain data summary, so a deterministic summary is never
-- shown as a written narrative. next_run_at advances when the report is generated.
CREATE TABLE IF NOT EXISTS fb_reports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_table_ids TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL DEFAULT 'manual',
  recipients TEXT NOT NULL DEFAULT '[]',
  last_run_at INTEGER,
  last_output TEXT,
  last_output_is_ai INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── PlexiFlow ────────────────────────────────────────────────────────────────
-- A flow is a trigger plus an ordered list of actions (create task, add table
-- row, send email, write knowledge, run an AI step). trigger_json and actions_json
-- hold the typed shapes; last_log caches the most recent honest per-step result.
-- next_run_at advances when a scheduled flow runs.
CREATE TABLE IF NOT EXISTS fb_flows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_json TEXT NOT NULL DEFAULT '{"kind":"manual"}',
  actions_json TEXT NOT NULL DEFAULT '[]',
  last_run_at INTEGER,
  last_status TEXT,
  last_log TEXT,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── PlexiAPI ─────────────────────────────────────────────────────────────────
-- Local REST API access. Tokens are stored only as a sha256 hash, so the raw
-- token is shown once at creation and never persisted. scopes_json is a JSON
-- array, e.g. ["read","write"]. fb_api_config is a single row holding whether the
-- local server is enabled and on which port; it is off by default and only ever
-- binds to 127.0.0.1.
CREATE TABLE IF NOT EXISTS fb_api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '["read"]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS fb_api_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  port INTEGER NOT NULL DEFAULT 8787
);

-- ── Inter-widget spatial links ───────────────────────────────────────────────
-- Obsidian-style backlinks but drawn as lines on the canvas. Each row is a
-- directed link (source → target). UNIQUE constraint prevents duplicates in
-- the same direction. Reverse direction (B → A) is allowed and treated as a
-- separate link so users can express asymmetric relationships. Cascade
-- delete on either endpoint drops the link automatically.
CREATE TABLE IF NOT EXISTS widget_links (
  id TEXT PRIMARY KEY,
  source_widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  target_widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(source_widget_id, target_widget_id)
);
CREATE INDEX IF NOT EXISTS idx_widget_links_task ON widget_links(task_id);
CREATE INDEX IF NOT EXISTS idx_widget_links_source ON widget_links(source_widget_id);
CREATE INDEX IF NOT EXISTS idx_widget_links_target ON widget_links(target_widget_id);

-- ── Desk time-travel snapshots ──────────────────────────────────────────────
-- A compact history of a task's canvas. Each row is the full widget set for the
-- task at a moment in time (payload = JSON Widget[]). Written debounced as the
-- desk changes; capped + pruned per task. Lets the user scrub the desk's
-- evolution, restore a past state, or branch a new task from one.
CREATE TABLE IF NOT EXISTS canvas_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  widget_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_task ON canvas_snapshots(task_id, at DESC);

-- ── Wire run history ─────────────────────────────────────────────────────────
-- One row per reactive-wire write into a text target (transform / mirror). Stores
-- the target's content before and after so the user can see what an automation
-- did and revert it in one click. Pruned to the most recent per wire.
CREATE TABLE IF NOT EXISTS wire_runs (
  id TEXT PRIMARY KEY,
  wire_id TEXT NOT NULL REFERENCES widget_links(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  target_widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  source_label TEXT NOT NULL DEFAULT '',
  wire_type TEXT NOT NULL,
  verb TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  prev_content TEXT NOT NULL,
  next_content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wire_runs_wire ON wire_runs(wire_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_wire_runs_task ON wire_runs(task_id, at DESC);

-- ── Outgoing share links ────────────────────────────────────────────────────
-- Each row is a link the local user minted to share one of their folders /
-- tasks / widgets. Tokens are opaque and URL-safe. revoked=1 soft-deletes
-- (server stops resolving but the row stays so the share-manager UI can
-- still surface the audit trail).
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  -- No kind CHECK: the ShareableKind TS union is the guard, so new share kinds
  -- (document, docfolder, …) never need a DB migration.
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'view' CHECK (scope IN ('view', 'copy')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_share_links_entity ON share_links(kind, entity_id);
CREATE INDEX IF NOT EXISTS idx_share_links_created ON share_links(created_at DESC);

-- ── Incoming shared items (Shared with me) ──────────────────────────────────
-- v1 these get inserted when the user accepts a share invite. Production
-- will sync from the server. snapshot is the read-only view of the
-- entity at acceptance time so the user can browse it even offline.
CREATE TABLE IF NOT EXISTS shared_with_me (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  from_handle TEXT NOT NULL DEFAULT '',
  accepted_at INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'view' CHECK (scope IN ('view', 'copy'))
);
CREATE INDEX IF NOT EXISTS idx_shared_with_me_accepted ON shared_with_me(accepted_at DESC);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_widgets_task ON widgets(task_id);
CREATE INDEX IF NOT EXISTS idx_templates_created ON templates(created_at);
CREATE INDEX IF NOT EXISTS idx_history_last_visited ON browsing_history(last_visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_host ON browsing_history(host);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_task ON focus_sessions(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_completed ON focus_sessions(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_log(task_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_connected_apps_sort ON connected_apps(sort_order ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_vault_entries_sort ON vault_entries(sort_order ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_energy_log_ts ON energy_log(ts DESC);
`

function ensureColumn(
  d: Database.Database,
  table: string,
  col: string,
  ddl: string
): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.find((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
  }
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
  db.exec(SCHEMA)
  // Widen the nodes kind CHECK for the Attention layer (work_item). Pinned
  // TWO-SIDED (§2.1 F-M1): after db.exec(SCHEMA), before the nodes_mark_dirty
  // trigger creation below and before any work_item ensureColumn. Fresh
  // installs are born wide by the SCHEMA constant; this rebuild exists for
  // pre-existing DBs (both verified starting shapes, GAP-014) and no-ops after.
  nodesKindMigration = migrateNodesKindCheckV2(db)
  if (nodesKindMigration.ran === false && nodesKindMigration.reason === 'no-check-clause') {
    // Never fire vacuously on an unanticipated DDL shape — skip and surface.
    // eslint-disable-next-line no-console
    console.error(
      '[migrateNodesKindCheckV2] SKIPPED: nodes DDL carries no extractable kind CHECK; ' +
        'this device cannot hold work_items until inspected. DDL: ' +
        nodesKindMigration.ddl
    )
  }
  // work_item columns + satellite tables + orphan reconciliation (S2, §2.2/§2.4)
  // — strictly AFTER the kind migration above, per its two-sided pin.
  ensureWorkItemSchema(db)
  // The notification substrate's durable store (S4, §5).
  ensureNotificationSchema(db)
  // DEC-061 — repair browsing_history.visit_count from the navigation log.
  // Guarded and idempotent: a row is touched only when its raw browser_nav
  // count equals its stored visit_count, which is what proves the log is
  // complete for that URL. After a repair the two no longer match, so a second
  // run declines; where retention has already capped the log they never match,
  // and the row is left exactly as it is.
  try {
    const hist = repairBrowsingHistoryCounts(db as never)
    if (hist.repaired > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[migrateBrowsingHistoryCounts] repaired ${hist.repaired} rows ` +
          `(${hist.visitsRemoved} phantom visits removed, ` +
          `${hist.skippedNoEvidence} left alone for want of evidence)`
      )
    }
  } catch (err) {
    // Housekeeping must never take the app down with it.
    console.warn('[migrateBrowsingHistoryCounts] skipped (non-fatal):', (err as Error).message)
  }
  // Forward-compatible migrations for previously-created DBs
  // File/folder manager: fb_files grows from a flat attachment store into a
  // foldered library. parent_id nests entries (null = root), kind tells folder
  // vs file vs doc-reference, display_name is the editable name (falls back to
  // original_name), updated_at is the modified time, doc_id/doc_type link an
  // internal document filed into a folder. Existing rows default to a root-level
  // file, which is exactly what they were.
  ensureColumn(db, 'fb_files', 'parent_id', 'TEXT')
  ensureColumn(db, 'fb_files', 'kind', "TEXT NOT NULL DEFAULT 'file'")
  ensureColumn(db, 'fb_files', 'display_name', 'TEXT')
  ensureColumn(db, 'fb_files', 'updated_at', 'INTEGER')
  ensureColumn(db, 'fb_files', 'doc_id', 'TEXT')
  ensureColumn(db, 'fb_files', 'doc_type', 'TEXT')
  ensureColumn(db, 'fb_files', 'sort_order', 'INTEGER')
  // Soft-delete for the file manager: a trashed entry is hidden from listings
  // but recoverable (undo / within a grace window), then purged after 7 days.
  ensureColumn(db, 'fb_files', 'trashed_at', 'INTEGER')
  // Soft-delete for undoable task/folder deletion. Deleting a node hard-cascades
  // its whole subtree + every widget on those tasks, so we trash instead (hide +
  // recoverable), and purge old trash on launch. trashed_at null = live.
  ensureColumn(db, 'nodes', 'trashed_at', 'INTEGER')
  // Share attribution: who created the share, so a recipient view can show
  // "invited by X" and the growth loop can credit the inviter. Backfills to NULL
  // (unknown) for shares created before attribution existed.
  ensureColumn(db, 'share_links', 'created_by', 'TEXT')
  // Multi-org tenancy: each of these surfaces is scoped to the active
  // organisation. Existing rows predate multi-org, so the DEFAULT backfills them
  // into the reserved 'personal' org — switching to Personal shows exactly the
  // data the user already had, with no loss. New rows are stamped with whatever
  // org is active when they are created. Widgets inherit scope from their task
  // (widgets.task_id -> nodes), so they need no column of their own.
  // documents is created later in this migration block, so its org_id column is
  // added right after that CREATE (see below), not here.
  ensureColumn(db, 'nodes', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_files', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'connected_apps', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'dashboard_layouts', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nodes_org ON nodes(org_id);
    CREATE INDEX IF NOT EXISTS idx_fb_files_org ON fb_files(org_id);
    CREATE INDEX IF NOT EXISTS idx_connected_apps_org ON connected_apps(org_id);
  `)
  ensureColumn(db, 'nodes', 'estimate_minutes', 'INTEGER')
  ensureColumn(db, 'nodes', 'extensions_minutes', 'INTEGER NOT NULL DEFAULT 0')
  // Soft-delete for undoable widget removal. Deleting a widget hard-cascades its
  // connector links; we trash instead (hidden + recoverable, links survive and
  // the overlay skips trashed endpoints), purged after 7 days.
  ensureColumn(db, 'widgets', 'trashed_at', 'INTEGER')
  ensureColumn(db, 'widgets', 'status', 'TEXT')
  ensureColumn(db, 'widgets', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'widgets', 'pinned_screen_x', 'INTEGER')
  ensureColumn(db, 'widgets', 'pinned_screen_y', 'INTEGER')
  ensureColumn(db, 'widgets', 'parent_section_id', 'TEXT')
  ensureColumn(db, 'widgets', 'layout', 'TEXT')
  ensureColumn(db, 'nodes', 'resume_markdown', 'TEXT')
  ensureColumn(db, 'nodes', 'resume_updated_at', 'INTEGER')
  ensureColumn(db, 'nodes', 'due_date', 'INTEGER')
  // PlexiProjects planning fields. plan_start is the planned start date (due_date
  // is reused as the planned finish); is_milestone marks a zero-duration marker.
  ensureColumn(db, 'nodes', 'plan_start', 'INTEGER')
  ensureColumn(db, 'nodes', 'is_milestone', 'INTEGER NOT NULL DEFAULT 0')
  // PlexiProjects 2.0: who owns a task (free text) and manual progress 0-100.
  ensureColumn(db, 'nodes', 'assignee', 'TEXT')
  ensureColumn(db, 'nodes', 'progress_pct', 'REAL NOT NULL DEFAULT 0')
  // Constraints + cost: must-start-on, finish-no-later-than deadline, task cost.
  ensureColumn(db, 'nodes', 'must_start', 'INTEGER')
  ensureColumn(db, 'nodes', 'deadline', 'INTEGER')
  ensureColumn(db, 'nodes', 'cost', 'REAL')
  // Rooms/Desks/Plans decoupling. A folder node is a Room (pure organisation) by
  // default; is_plan = 1 promotes it to a Plan, and only Plans appear in the
  // Plans portfolio / Gantt. This is what stops every Room-with-desks from
  // silently becoming a plan. Desks (task nodes) are never auto-added to a plan.
  // The one-time grandfather migration below (migratePlanFlag) sets is_plan = 1
  // on existing folders that already have task descendants, so no current plan
  // disappears when this ships.
  ensureColumn(db, 'nodes', 'is_plan', 'INTEGER NOT NULL DEFAULT 0')
  // Typed dependencies (FS/SS/FF/SF) + working-day lag on existing deps tables.
  ensureColumn(db, 'fb_task_deps', 'dep_type', "TEXT NOT NULL DEFAULT 'FS'")
  ensureColumn(db, 'fb_task_deps', 'lag_days', 'INTEGER NOT NULL DEFAULT 0')
  // Set on nodes reconstructed from a share someone sent you. Drives the
  // "Shared by <handle>" badge + avatar in the sidebar. Null = your own node.
  ensureColumn(db, 'nodes', 'shared_from_handle', 'TEXT')
  // Soft-archive flag for nodes — separate from task `status` so folders
  // can be put away without messing with the work-state of their tasks.
  ensureColumn(db, 'nodes', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'widgets', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  // Connected-app linkage: when a Connected App is dragged to the canvas, the
  // resulting webview widget shares that app's session partition + auto-fill binding.
  ensureColumn(db, 'widgets', 'source_app_id', 'TEXT')
  // Live-wire fields on widget links. Existing links become passive 'context'
  // wires; type/verb/enabled let a wire become reactive (transform / mirror).
  ensureColumn(db, 'widget_links', 'type', "TEXT NOT NULL DEFAULT 'context'")
  ensureColumn(db, 'widget_links', 'verb', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'widget_links', 'enabled', 'INTEGER NOT NULL DEFAULT 1')
  // Durable run state for a reactive wire, so freshness (live / stale / errored)
  // and last-ran survive a reload and feed both the wire badge and the desk
  // Automations panel from one source of truth. Null until the wire first runs.
  ensureColumn(db, 'widget_links', 'last_run_at', 'INTEGER')
  ensureColumn(db, 'widget_links', 'last_error', 'TEXT')
  // Provenance for brain entries auto-ingested from the workspace (a desk,
  // document, widget or file). Null = a manually-authored entry. The pair is the
  // idempotency key so re-syncing updates in place instead of duplicating, and
  // lets a future "clear synced entries" leave hand-written ones untouched.
  ensureColumn(db, 'fb_knowledge', 'source_kind', 'TEXT')
  ensureColumn(db, 'fb_knowledge', 'source_id', 'TEXT')
  // Render mode for local-app-launcher widgets: 'launcher' (icon + click-to-open)
  // vs 'mirror' (punch-through live view of the real native app window). Null for
  // any other widget kind.
  ensureColumn(db, 'widgets', 'mode', 'TEXT')
  // Pin zone — tl/tr/bl/br for auto-docked pinned widgets. Legacy pinned
  // widgets without a zone fall back to pinnedScreenX/Y free positioning.
  ensureColumn(db, 'widgets', 'pinned_zone', 'TEXT')
  // Living-page fields. Only meaningful for kind='page'. When living_query
  // is non-null the page auto-regenerates its `content` (Tiptap JSON) from
  // the rest of the task's widgets. living_paused stops the auto loop
  // without losing the query string. living_generated_at drives the
  // freshness badge in the UI.
  ensureColumn(db, 'widgets', 'living_query', 'TEXT')
  ensureColumn(db, 'widgets', 'living_generated_at', 'INTEGER')
  ensureColumn(db, 'widgets', 'living_paused', 'INTEGER NOT NULL DEFAULT 0')
  // Linked duplicates: widgets sharing a sync_group_id mirror content/title/colour.
  ensureColumn(db, 'widgets', 'sync_group_id', 'TEXT')
  // Multi-device sync. sync_rev is the server rev this row was last reconciled at
  // (0 = never synced); needs_sync = 1 means this row has local changes to push.
  // Every local write sets needs_sync = 1; a push or an applied pull clears it.
  ensureColumn(db, 'nodes', 'sync_rev', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'nodes', 'needs_sync', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'widgets', 'sync_rev', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'widgets', 'needs_sync', 'INTEGER NOT NULL DEFAULT 1')
  // Small key/value store for sync bookkeeping (the pull cursor).
  db.exec('CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  // Crash telemetry (WS03 reliability). Captures uncaught errors + unhandled
  // rejections from BOTH processes with a stack + app version, so a failure is
  // seen instead of vanishing into the console. Aggregate/technical data only,
  // never document content. Pruned to the most recent rows so it can't grow
  // unbounded.
  db.exec(`
    CREATE TABLE IF NOT EXISTS crash_events (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      component_stack TEXT,
      app_version TEXT,
      context TEXT,
      forwarded INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_crash_events_ts ON crash_events(ts DESC);
  `)
  // Migration for DBs created before crash forwarding: add the flag if missing.
  ensureColumn(db, 'crash_events', 'forwarded', 'INTEGER NOT NULL DEFAULT 0')

  // WS01 sync substrate — the local end of the append-only change log. It is both
  // the offline queue (events emitted while the socket is down, `synced = 0`, are
  // flushed on reconnect) and the local record of applied events. `id` is the
  // client-generated UUIDv7 and PRIMARY KEY, so re-recording an event is an
  // idempotent no-op (SYN-010). `seq` is null until the server acks with its
  // authoritative sequence. This coexists with the workspace poll and does nothing
  // until the `fb.sync.crdt.widgets` renderer flag is on.
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_log (
      id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      seq INTEGER,
      occurred_at TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      field TEXT NOT NULL,
      data_class TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_change_log_unsynced ON change_log(synced, created_at);
    CREATE INDEX IF NOT EXISTS idx_change_log_object ON change_log(object_id, created_at);
  `)
  // Mark a row dirty on any content update so the sync engine knows to push it.
  // The WHEN guard fires only on a content change (sync columns untouched) of a
  // currently-clean row, so a sync-bookkeeping write (which sets sync_rev /
  // needs_sync) never trips it and there is no recursion. New rows default
  // needs_sync = 1, so inserts are already marked.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS nodes_mark_dirty AFTER UPDATE ON nodes
    WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
    BEGIN UPDATE nodes SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS widgets_mark_dirty AFTER UPDATE ON widgets
    WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
    BEGIN UPDATE widgets SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  // Usage telemetry + favourites for Connected Apps. `use_count` and `last_used_at`
  // feed the recency × frequency sort that promotes apps into the Favourites strip;
  // `pinned` lets the user override. `vault_entry_id` binds an app to a vault entry
  // for auto-fill; `autofill_enabled` lets the user turn it off per app.
  ensureColumn(db, 'connected_apps', 'use_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'connected_apps', 'last_used_at', 'INTEGER')
  ensureColumn(db, 'connected_apps', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'connected_apps', 'vault_entry_id', 'TEXT')
  ensureColumn(db, 'connected_apps', 'autofill_enabled', 'INTEGER NOT NULL DEFAULT 1')
  // Local-app support: kind discriminator + macOS bundle path/id + cached real
  // icon (base64 PNG so the sidebar can render it without a per-paint IPC hit).
  ensureColumn(db, 'connected_apps', 'kind', "TEXT NOT NULL DEFAULT 'web'")
  ensureColumn(db, 'connected_apps', 'app_path', 'TEXT')
  ensureColumn(db, 'connected_apps', 'bundle_id', 'TEXT')
  ensureColumn(db, 'connected_apps', 'icon_png_base64', 'TEXT')
  // Agent invocation history + outcomes. Drives Phase 2 polish:
  // per-agent applied/refused stats, invocation log, "undo last
  // apply". One row per invocation; one row per outcome event
  // (proposal applied / dismissed / undone). Outcomes reference
  // invocations by id; deleting an invocation cascades.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_invocations (
      id TEXT PRIMARY KEY,
      agent_slug TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      node_id TEXT,
      node_label TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT '[]',
      reply TEXT NOT NULL DEFAULT '',
      proposals TEXT NOT NULL DEFAULT '[]',
      conversation_turn INTEGER NOT NULL DEFAULT 1,
      conversation_key TEXT NOT NULL DEFAULT '',
      invoked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_invocations_slug
      ON agent_invocations (agent_slug);
    CREATE INDEX IF NOT EXISTS idx_agent_invocations_node
      ON agent_invocations (node_id);
    CREATE INDEX IF NOT EXISTS idx_agent_invocations_conv
      ON agent_invocations (conversation_key);
    CREATE INDEX IF NOT EXISTS idx_agent_invocations_invoked_at
      ON agent_invocations (invoked_at DESC);

    CREATE TABLE IF NOT EXISTS agent_outcomes (
      id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL
        REFERENCES agent_invocations(id) ON DELETE CASCADE,
      agent_slug TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      proposal_kind TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('applied', 'dismissed', 'undone')),
      -- Pointer to the entity created by an applied proposal so undo
      -- knows what to delete. Format: "<kind>:<id>" e.g. "task:abc",
      -- "widget:xyz". Null for dismissed/undone outcomes.
      created_entity_ref TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_outcomes_inv
      ON agent_outcomes (invocation_id);
    CREATE INDEX IF NOT EXISTS idx_agent_outcomes_slug
      ON agent_outcomes (agent_slug);
    CREATE INDEX IF NOT EXISTS idx_agent_outcomes_action
      ON agent_outcomes (action);
    CREATE INDEX IF NOT EXISTS idx_agent_outcomes_at
      ON agent_outcomes (at DESC);

    -- Small key/value counters for local usage telemetry (e.g. cumulative AI
    -- call count). Aggregate numbers only, never content.
    CREATE TABLE IF NOT EXISTS usage_counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    -- Calendar time blocks — a booked stretch of time, optionally tied to a
    -- task. Deleting a task removes its blocks (ON DELETE CASCADE).
    CREATE TABLE IF NOT EXISTS time_blocks (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      start_ms INTEGER NOT NULL,
      duration_min INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_time_blocks_start ON time_blocks (start_ms);
    CREATE INDEX IF NOT EXISTS idx_time_blocks_task ON time_blocks (task_id);

    -- Office documents — standalone doc / sheet / slides files, each created
    -- and edited as a first-class artifact (not a canvas widget). The body is
    -- a JSON blob whose shape depends on doc_type: a Tiptap document for
    -- 'doc', a { columns, rows } grid for 'sheet', a { slides[] } deck for
    -- 'slides'. Keeping one table for all three keeps the Documents list,
    -- sharing and AI-create flow uniform.
    -- doc_type carries no CHECK: the DocType TS union is the guard, so a new
    -- document kind (map, design, …) never needs a table rebuild. See
    -- migrateDocumentsDocTypeCheck, which drops the legacy CHECK on older DBs.
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '{}',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (updated_at DESC);

    -- Facets: a file/doc can carry many tags, so it lives in every matching view
    -- at once instead of one folder. The folder hierarchy (fb_files.parent_id) is
    -- untouched and still works; tags are an additive layer. The source column
    -- records whether a tag was applied by a person or proposed by the AI.
    CREATE TABLE IF NOT EXISTS fb_file_tags (
      file_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (file_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON fb_file_tags (tag);
    CREATE INDEX IF NOT EXISTS idx_file_tags_file ON fb_file_tags (file_id);

    -- Smart folders: a saved query (a set of tags AND-ed together) that always
    -- shows the matching files live, wherever they sit. A folder you never have
    -- to refile, the payoff of facets over folders.
    CREATE TABLE IF NOT EXISTS fb_smart_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      search TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    -- The organization Brand Kit: one brand (logo, colors, fonts) the whole
    -- workspace inherits, so Docs, Sheets, Slides, Projects and PlexiDesign all
    -- present consistently. Stored local-first as a single row; the JSON is the
    -- OrgBrandKit shape. Server sync across devices is a later additive layer.
    CREATE TABLE IF NOT EXISTS fb_brand_kit (
      id TEXT PRIMARY KEY,
      kit_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  // A smart folder can also carry a free-text search alongside its tags. Added
  // after the table shipped tags-only, so back-fill the column on existing DBs.
  ensureColumn(db, 'fb_smart_folders', 'search', "TEXT NOT NULL DEFAULT ''")
  migrateDocumentsDocTypeCheck(db)
  migrateShareKindChecks(db)
  // Multi-org tenancy for documents. Added AFTER migrateDocumentsDocTypeCheck,
  // which rebuilds the documents table to drop a legacy CHECK — adding the column
  // last means the rebuild can never drop it. Existing docs backfill to the
  // reserved 'personal' org via the DEFAULT.
  ensureColumn(db, 'documents', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_org ON documents(org_id)')
  // Soft-delete for documents, mirroring the fb_files trash. NULL means live;
  // a timestamp means the document sits in the Documents Trash until the user
  // restores it or deletes it forever. Editors' "Move to trash" lands here, so
  // the menu label is finally truthful (it used to hard-DELETE the row).
  ensureColumn(db, 'documents', 'trashed_at', 'INTEGER')
  // Document version history, the same pattern as canvas_snapshots for desks:
  // periodic full-body snapshots per document, pruned to a per-doc cap, with
  // restore capturing a "Before restore" snapshot first so it is reversible.
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_snapshots (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doc_snapshots_doc ON doc_snapshots(doc_id, at DESC);
  `)
  // Comments on LOCAL documents. Live/collaborative docs keep their comments on
  // the signal server; this table gives ordinary local docs the same panel.
  // anchor_id is the Tiptap comment-mark id inside the body (nullable: a reply
  // has no own anchor). Single-user local docs, so author is the local display
  // name at write time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_comments (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      parent_id TEXT,
      anchor_id TEXT,
      author TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doc_comments_doc ON doc_comments(doc_id, created_at);
  `)
  // Focus-Mode split "clusters": a per-desk (task node) saved split layout. panes
  // and ratios are stored JSON-encoded (PaneSources by reference) so a saved
  // cluster resolves live content on load and degrades gracefully if a member
  // widget is gone. Org-scoped so a cluster only surfaces on the desk + org that
  // owns it. Backs window.api.clusters.* via db/focusClusters.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS focus_clusters (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL DEFAULT 'personal',
      shape TEXT NOT NULL,
      panes_json TEXT NOT NULL,
      ratios_json TEXT NOT NULL,
      active_pane_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_clusters_task ON focus_clusters(task_id, updated_at DESC);
  `)
  // Focus-Mode AI chat conversations + messages. For assistant turns we store the
  // JSON of any action proposals and which of them the user approved, so the green
  // "done" cards survive a restart. Backs window.api.aiChat.* via db/aiChat.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_conversations (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'personal',
      task_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_conv_updated ON ai_chat_conversations (org_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,
      proposals_json TEXT,
      applied_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_msg_conv ON ai_chat_messages (conversation_id, ts ASC);
  `)
  // Phase 4.5 — unification. The panel held four things per turn that the
  // persisted focus chat never did (citations, a follow-up question, the
  // retrieval trace, the @-mentions it was sent with). With ONE conversation
  // system behind both surfaces, leaving them out would make persistence a
  // regression against what the panel already showed. All additive: existing
  // rows stay valid, nothing is rewritten at rest, and a NULL simply means the
  // turn had none.
  ensureColumn(db, 'ai_chat_messages', 'sources_json', 'TEXT')
  ensureColumn(db, 'ai_chat_messages', 'question_json', 'TEXT')
  ensureColumn(db, 'ai_chat_messages', 'trace_json', 'TEXT')
  ensureColumn(db, 'ai_chat_messages', 'mentions_json', 'TEXT')
  // Plexii P4 — interactive UI blocks an assistant turn carried. Additive,
  // NULL means the turn had none (every pre-blocks row, honestly).
  ensureColumn(db, 'ai_chat_messages', 'blocks_json', 'TEXT')
  // Plexii P5 — desks a conversation produced/adopted (element 0 = primary).
  // NULL/absent means none yet; pre-P5 conversations honestly link nothing.
  ensureColumn(db, 'ai_chat_conversations', 'linked_desks_json', 'TEXT')
  // Plexii P6 — how a conversation talks ('chat' | 'discovery'). Every existing
  // row is a normal chat, which the DEFAULT states rather than infers.
  ensureColumn(db, 'ai_chat_conversations', 'mode', "TEXT NOT NULL DEFAULT 'chat'")
  // Plexii A4 (R21) — the conversation's web-search globe. Default on: web
  // search has been default-on since F4, so every existing row keeps its truth.
  ensureColumn(db, 'ai_chat_conversations', 'web_search', 'INTEGER NOT NULL DEFAULT 1')
  // Plexii A5 (M4) — memory becomes org-scoped (#23, the privacy defect) in
  // the SAME change that turns automatic extraction on, per the audit's law.
  // Existing rows backfill to the reserved 'personal' org via the DEFAULT
  // (fb_memory is empty on real profiles today, per the 2026-08-21 audit).
  // superseded_by records which newer memory replaced an archived one (#25,
  // R23: newest wins, history kept). The dedup key becomes per-org so the
  // same stated fact may exist independently in two orgs.
  ensureColumn(db, 'fb_memory', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_memory', 'superseded_by', 'TEXT')
  db.exec('DROP INDEX IF EXISTS idx_fb_memory_dedup')
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_memory_dedup_org ON fb_memory(org_id, dedup_key)'
  )
  // What screen a conversation was started from, so it can say so later. The
  // assistant used to re-thread per screen; after unification a conversation
  // REMEMBERS its context instead of being replaced by it (plan D4).
  ensureColumn(db, 'ai_chat_conversations', 'context_json', 'TEXT')
  // Multi-org tenancy for the remaining user-data surfaces so switching org
  // isolates the calendar, vault, knowledge and tables too, not just desks and
  // documents. Added at the end where every table exists; existing rows backfill
  // to the reserved 'personal' org via the DEFAULT (no data loss).
  ensureColumn(db, 'time_blocks', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  // Repeating time blocks: recurrence ('daily'|'weekly'|'monthly', NULL = one
  // off) plus series_id grouping the occurrences (the first block's id). Each
  // occurrence is a real row so range queries, drags and per-occurrence edits
  // need no special casing; the materialiser in timeBlocks.ts extends series
  // forward on a rolling horizon.
  ensureColumn(db, 'time_blocks', 'recurrence', 'TEXT')
  ensureColumn(db, 'time_blocks', 'series_id', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_time_blocks_series ON time_blocks(series_id)')
  // Calendar sync (sync-ladder rung 1). trashed_at makes deletes tombstones so
  // they propagate across devices instead of resurrecting on the next pull;
  // sync_rev/needs_sync mirror the nodes/widgets bookkeeping, with the same
  // guarded dirty trigger. New rows default needs_sync = 1.
  ensureColumn(db, 'time_blocks', 'trashed_at', 'INTEGER')
  ensureColumn(db, 'time_blocks', 'sync_rev', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'time_blocks', 'needs_sync', 'INTEGER NOT NULL DEFAULT 1')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS time_blocks_mark_dirty AFTER UPDATE ON time_blocks
    WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
    BEGIN UPDATE time_blocks SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  // A calendar block can be a video meeting; its room + invitee list ride along
  // as JSON. Nullable, so every existing focus block stays a plain focus block.
  ensureColumn(db, 'time_blocks', 'meeting_json', 'TEXT')
  ensureColumn(db, 'vault_entries', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_knowledge', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_tables', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  // Cross-member org sync rung 2: documents and tables (and table rows) get the
  // same sync bookkeeping time_blocks got, so they can flow through the org
  // workspace store. Documents and fb_tables already carry org_id; fb_rows
  // deliberately does NOT (a row derives its org scope from its parent table at
  // push time, the same way a widget derives from its parent node), but it still
  // needs rev/dirty tracking to be delta-synced as its own item. trashed_at
  // makes deletes tombstones that propagate. Guarded dirty triggers mirror the
  // time_blocks one; new rows default needs_sync = 1.
  ensureColumn(db, 'documents', 'sync_rev', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'documents', 'needs_sync', 'INTEGER NOT NULL DEFAULT 1')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_mark_dirty AFTER UPDATE ON documents
    WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
    BEGIN UPDATE documents SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  ensureColumn(db, 'fb_tables', 'trashed_at', 'INTEGER')
  ensureColumn(db, 'fb_tables', 'sync_rev', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'fb_tables', 'needs_sync', 'INTEGER NOT NULL DEFAULT 1')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS fb_tables_mark_dirty AFTER UPDATE ON fb_tables
    WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
    BEGIN UPDATE fb_tables SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  ensureColumn(db, 'fb_rows', 'trashed_at', 'INTEGER')
  ensureColumn(db, 'fb_rows', 'sync_rev', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'fb_rows', 'needs_sync', 'INTEGER NOT NULL DEFAULT 1')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS fb_rows_mark_dirty AFTER UPDATE ON fb_rows
    WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
    BEGIN UPDATE fb_rows SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_fb_rows_needs_sync ON fb_rows(needs_sync)')

  // Drive files + folders join cross-member org sync (metadata over the org loop;
  // a file's BYTES ride the separate org-file-blob channel). Same guarded dirty
  // trigger as the other synced tables; new rows default needs_sync = 1 so a file
  // uploaded today is picked up on the next org cycle.
  ensureColumn(db, 'fb_files', 'sync_rev', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'fb_files', 'needs_sync', 'INTEGER NOT NULL DEFAULT 1')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS fb_files_mark_dirty AFTER UPDATE ON fb_files
    WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
    BEGIN UPDATE fb_files SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_fb_files_needs_sync ON fb_files(needs_sync)')

  // Group/team scope for shared objects. NULL = whole org (or personal); a team id
  // narrows an org-shared object to that group. Widgets and rows have no column of
  // their own — they inherit their parent node/table's team at push time (mirroring
  // how they inherit org scope). The server's changesSince is the isolation point.
  ensureColumn(db, 'nodes', 'team_id', 'TEXT')
  ensureColumn(db, 'documents', 'team_id', 'TEXT')
  ensureColumn(db, 'fb_files', 'team_id', 'TEXT')
  ensureColumn(db, 'fb_tables', 'team_id', 'TEXT')

  // Per-desk sharing: the desk (root node id) this row belongs to when the desk is
  // shared with named individuals rather than a whole org. NULL for ordinary
  // personal/org content. A row with shared_root_id set syncs ONLY through the
  // ACL-scoped shared path (collectPendingShared / applyRemoteShared), never the
  // personal or org loops, so the scopes are mutually exclusive and nothing
  // double-pushes. Stamped on every row of the subtree at share time and preserved
  // on the recipient so their later edits re-push to the same desk. Every content
  // table a desk can contain gets the column so the collect needs no joins.
  ensureColumn(db, 'nodes', 'shared_root_id', 'TEXT')
  ensureColumn(db, 'widgets', 'shared_root_id', 'TEXT')
  ensureColumn(db, 'fb_tables', 'shared_root_id', 'TEXT')
  ensureColumn(db, 'fb_rows', 'shared_root_id', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_shared_root ON nodes(shared_root_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_widgets_shared_root ON widgets(shared_root_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_fb_tables_shared_root ON fb_tables(shared_root_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_fb_rows_shared_root ON fb_rows(shared_root_id)')

  // Remaining top-level user-content surfaces get the same per-org scoping so
  // switching organisation shows only that org's automations, reports, apps,
  // forms, meetings, signature requests and saved file views. Existing rows
  // backfill to the reserved 'personal' org via the DEFAULT (no data loss).
  ensureColumn(db, 'fb_flows', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_reports', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_apps', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_forms', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_meetings', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_sign_requests', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'fb_smart_folders', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  // Semantic-search vectors and the activity / focus / browsing logs are scoped
  // too, so search results and "recent" panels only reflect the active org.
  ensureColumn(db, 'fb_embeddings', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'activity_log', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'focus_sessions', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  ensureColumn(db, 'browsing_history', 'org_id', "TEXT NOT NULL DEFAULT 'personal'")
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_time_blocks_org ON time_blocks(org_id);
    CREATE INDEX IF NOT EXISTS idx_vault_entries_org ON vault_entries(org_id);
    CREATE INDEX IF NOT EXISTS idx_fb_knowledge_org ON fb_knowledge(org_id);
    CREATE INDEX IF NOT EXISTS idx_fb_tables_org ON fb_tables(org_id);
  `)
  // User-driven desk relatedness. Two desks are related only because the user
  // says so, never because they share an org. The brain uses these edges to
  // scope what it reads for a desk (this desk + explicitly related desks),
  // instead of treating the whole org as one flat pile. Undirected: a single
  // row (node_a < node_b, ordered) expresses the relation both ways.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fb_node_relations (
      id TEXT PRIMARY KEY,
      node_a TEXT NOT NULL,
      node_b TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'personal',
      created_at INTEGER NOT NULL,
      UNIQUE(node_a, node_b)
    );
    CREATE INDEX IF NOT EXISTS idx_node_relations_a ON fb_node_relations(node_a);
    CREATE INDEX IF NOT EXISTS idx_node_relations_b ON fb_node_relations(node_b);
    CREATE INDEX IF NOT EXISTS idx_node_relations_org ON fb_node_relations(org_id);
  `)
  migratePlanFlag(db)
  // Migrations completed successfully — stamp the version so the next launch
  // knows this database is already at the current schema and skips the
  // pre-upgrade snapshot until MIGRATION_VERSION is bumped again.
  db.pragma(`user_version = ${MIGRATION_VERSION}`)
  return db
}

// One-time grandfather for the Rooms/Desks/Plans split. Before this change, the
// Plans portfolio treated EVERY folder that contained tasks as a plan. Now a
// folder is a plan only when is_plan = 1. To preserve every existing user's
// current plans, we set is_plan = 1 on any folder that already has a task
// descendant AND is not itself marked done — but only once, guarded by a marker
// row so a later manual "this Room is not a Plan" choice is never undone on the
// next boot. New folders keep the is_plan = 0 default.
function migratePlanFlag(d: Database.Database): void {
  const MARKER = 'plan_flag_grandfathered_v1'
  const already = d
    .prepare('SELECT value FROM sync_meta WHERE key = ?')
    .get(MARKER) as { value: string } | undefined
  if (already) return
  // A folder becomes a plan if any descendant is a task. Direct children cover
  // the overwhelming majority; a recursive CTE catches nested plans too.
  d.exec(`
    UPDATE nodes SET is_plan = 1
    WHERE kind = 'folder' AND id IN (
      WITH RECURSIVE subtree(root, id) AS (
        SELECT f.id, f.id FROM nodes f WHERE f.kind = 'folder'
        UNION ALL
        SELECT s.root, n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
      )
      SELECT DISTINCT s.root FROM subtree s
      JOIN nodes t ON t.id = s.id
      WHERE t.kind = 'task'
    )
  `)
  d.prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)').run(MARKER, '1')
}

// The documents table shipped with a CHECK constraint listing the known doc
// types, and SQLite can't ALTER a CHECK in place. Rather than migrate it every
// time a new kind lands (map, design, …), this drops the doc_type CHECK entirely
// the same way the share tables drop their kind CHECK: the DocType TS union is the
// guard. Rebuilds the table (copying every row) only while its live schema still
// carries a CHECK. Idempotent; a no-op once migrated or on a fresh DB.
function migrateDocumentsDocTypeCheck(d: Database.Database): void {
  const row = d
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'")
    .get() as { sql?: string } | undefined
  if (!row?.sql || !row.sql.includes('CHECK')) return
  d.exec(`
    PRAGMA foreign_keys=off;
    BEGIN;
    CREATE TABLE documents_new (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '{}',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO documents_new (id, doc_type, title, body, archived, created_at, updated_at)
      SELECT id, doc_type, title, body, archived, created_at, updated_at FROM documents;
    DROP TABLE documents;
    ALTER TABLE documents_new RENAME TO documents;
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (updated_at DESC);
    COMMIT;
    PRAGMA foreign_keys=on;
  `)
}

// The share tables shipped with a CHECK on `kind` (folder/task/widget). Office
// sharing keeps adding kinds (document, docfolder, …), so rather than migrate the
// CHECK each time, this drops the kind CHECK entirely — the ShareableKind TS union
// is the guard. Rebuilds a share table (copying rows) only while its live schema
// still carries a `kind` CHECK. Idempotent; a no-op once migrated or on a fresh DB.
function migrateShareKindChecks(d: Database.Database): void {
  const hasKindCheck = (name: string): boolean => {
    const row = d
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { sql?: string } | undefined
    return !!row?.sql && /CHECK\s*\(\s*kind\s+IN/i.test(row.sql)
  }
  if (hasKindCheck('share_links')) {
    d.exec(`
      PRAGMA foreign_keys=off;
      BEGIN;
      CREATE TABLE share_links_new (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'view' CHECK (scope IN ('view', 'copy')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        view_count INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO share_links_new SELECT id, token, kind, entity_id, label, scope, created_at, expires_at, view_count, revoked FROM share_links;
      DROP TABLE share_links;
      ALTER TABLE share_links_new RENAME TO share_links;
      CREATE INDEX IF NOT EXISTS idx_share_links_entity ON share_links(kind, entity_id);
      CREATE INDEX IF NOT EXISTS idx_share_links_created ON share_links(created_at DESC);
      COMMIT;
      PRAGMA foreign_keys=on;
    `)
  }
  if (hasKindCheck('shared_with_me')) {
    d.exec(`
      PRAGMA foreign_keys=off;
      BEGIN;
      CREATE TABLE shared_with_me_new (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        from_handle TEXT NOT NULL DEFAULT '',
        accepted_at INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT 'view' CHECK (scope IN ('view', 'copy'))
      );
      INSERT INTO shared_with_me_new SELECT id, token, kind, snapshot_json, from_handle, accepted_at, scope FROM shared_with_me;
      DROP TABLE shared_with_me;
      ALTER TABLE shared_with_me_new RENAME TO shared_with_me;
      CREATE INDEX IF NOT EXISTS idx_shared_with_me_accepted ON shared_with_me(accepted_at DESC);
      COMMIT;
      PRAGMA foreign_keys=on;
    `)
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
