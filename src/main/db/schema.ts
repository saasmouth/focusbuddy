// The complete SQLite schema, as one idempotent script of CREATE TABLE IF NOT
// EXISTS / CREATE INDEX IF NOT EXISTS statements.
//
// It lives in its own module because two runtimes now build the same database:
// the desktop, against better-sqlite3 on a file in userData, and the browser
// cloud runtime, against SQLite compiled to WebAssembly on OPFS. Both call
// db.exec(SCHEMA), so a table added here appears on both without anyone having
// to remember the second one.
//
// That matters beyond convenience. A workspace item's sync body is the table
// row minus its sync columns, and the receiving side upserts whatever columns
// it recognises. Two runtimes with drifting schemas therefore do not fail
// loudly -- they quietly drop the columns the other one added. Sharing this
// constant is what keeps a desk edited in the browser identical when it lands
// on the desktop.

export const SCHEMA = `
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

-- M2 (SPEC-003 S3-DEC-021) — the transcript as SEGMENTS, not a string:
-- speaker-attributed (per-track capture makes attribution exact), offset on
-- the recording clock, with the engine's own confidence where it gives one
-- (cloud logprobs) and an honest NULL where it does not (local). Every
-- provenance tier, moment anchor and Recall citation resolves against these.
CREATE TABLE IF NOT EXISTS fb_transcript_segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  speaker_account_id TEXT,
  speaker_name TEXT NOT NULL DEFAULT '',
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_segments_meeting ON fb_transcript_segments(meeting_id, start_ms);

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
-- SQLite indexes the PARENT side of a foreign key automatically and the child
-- side never, so without these two every widget delete has to scan all of
-- wire_runs once per row to enforce the ON DELETE CASCADE.
CREATE INDEX IF NOT EXISTS idx_wire_runs_source_widget ON wire_runs(source_widget_id);
CREATE INDEX IF NOT EXISTS idx_wire_runs_target_widget ON wire_runs(target_widget_id);

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
