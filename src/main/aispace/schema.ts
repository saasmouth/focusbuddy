// AI Space + Connections tables (docs/ai-space/DESIGN.md §Data).
//
// All tables are LOCAL-ONLY: none is in workspaceSync's TABLE list, none has
// sync columns, and none declares a foreign key into `nodes` (a Desk is a plain
// desk_id, so deleting a Desk never cascades into project history, and the
// ciDeleteSiteLock count stays where it is).
//
// Two tables are append-only, enforced by triggers the same way the event store
// is: output versions (a version is immutable once written; pointers move,
// versions never change) and the activity log (history the Impact "As of" view
// replays). Their only legal operation is INSERT.

import type { SqlDb } from '../db/eventStore'

export const AISPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ais_workspaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal','work')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ais_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES ais_workspaces(id),
  desk_id TEXT,
  room_id TEXT,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  brief_output_id TEXT,
  authority_json TEXT NOT NULL DEFAULT '{}',
  budget_limit_minor INTEGER,
  budget_currency TEXT NOT NULL DEFAULT 'USD',
  default_connection_id TEXT,
  default_model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS ais_projects_desk ON ais_projects(desk_id);
CREATE INDEX IF NOT EXISTS ais_projects_ws ON ais_projects(workspace_id);

CREATE TABLE IF NOT EXISTS ais_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES ais_projects(id),
  parent_task_id TEXT,
  branch_id TEXT,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  deliverable_kind TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  assignee TEXT,
  scheduled_at INTEGER,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ais_tasks_project ON ais_tasks(project_id, sort_order);

CREATE TABLE IF NOT EXISTS ais_task_deps (
  ai_task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (ai_task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS ais_agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES ais_projects(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  connection_id TEXT,
  model TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ais_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  workspace_id TEXT NOT NULL,
  ai_task_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  level TEXT NOT NULL,
  provider TEXT,
  original_url TEXT,
  captured_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ais_threads_project ON ais_threads(project_id);

CREATE TABLE IF NOT EXISTS ais_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES ais_threads(id),
  role TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ais_messages_thread ON ais_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS ais_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES ais_projects(id),
  ai_task_id TEXT,
  thread_id TEXT,
  agent_id TEXT,
  branch_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  external_id TEXT,
  last_confirmed_step TEXT NOT NULL DEFAULT '',
  last_confirmed_at INTEGER,
  handover_of TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS ais_runs_project ON ais_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS ais_runs_status ON ais_runs(status);

CREATE TABLE IF NOT EXISTS ais_run_steps (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS ais_outputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES ais_projects(id),
  ai_task_id TEXT,
  branch_id TEXT,
  kind TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'deliverable',
  title TEXT NOT NULL,
  latest_version_id TEXT,
  approved_version_id TEXT,
  published_version_id TEXT,
  domain TEXT,
  review_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ais_outputs_project ON ais_outputs(project_id, kind);

CREATE TABLE IF NOT EXISTS ais_versions (
  id TEXT PRIMARY KEY,
  output_id TEXT NOT NULL REFERENCES ais_outputs(id),
  n INTEGER NOT NULL,
  parent_version_id TEXT,
  branch_id TEXT,
  author TEXT NOT NULL,
  run_id TEXT,
  content TEXT NOT NULL,
  media_ref TEXT,
  media_width INTEGER,
  media_height INTEGER,
  content_hash TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  sources_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (output_id, n)
);
-- One version per (run, output): a duplicate completion event can't add a second.
CREATE UNIQUE INDEX IF NOT EXISTS ais_versions_run_output ON ais_versions(run_id, output_id) WHERE run_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS ais_versions_no_update BEFORE UPDATE ON ais_versions
BEGIN SELECT RAISE(ABORT, 'ais_versions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS ais_versions_no_delete BEFORE DELETE ON ais_versions
BEGIN SELECT RAISE(ABORT, 'ais_versions is immutable'); END;

CREATE TABLE IF NOT EXISTS ais_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES ais_projects(id),
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  value TEXT NOT NULL,
  previous_value TEXT,
  status TEXT NOT NULL,
  due_at INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  decided_by TEXT,
  decided_at INTEGER,
  supersedes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ais_decisions_project ON ais_decisions(project_id, topic);

CREATE TABLE IF NOT EXISTS ais_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  content TEXT NOT NULL DEFAULT '',
  provider TEXT,
  connection_id TEXT,
  run_id TEXT,
  original_location TEXT,
  captured_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ais_sources_project ON ais_sources(project_id);

CREATE TABLE IF NOT EXISTS ais_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ai_task_id TEXT,
  requested_by TEXT NOT NULL,
  recipient TEXT NOT NULL,
  question TEXT NOT NULL,
  topics_json TEXT NOT NULL DEFAULT '[]',
  can_proceed TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  supplied_source_id TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ais_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  from_actor TEXT NOT NULL,
  recipient TEXT NOT NULL,
  target_json TEXT NOT NULL,
  target_version_id TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  proposed_action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  dedupe_key TEXT NOT NULL UNIQUE,
  source_event_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS ais_branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ais_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_json TEXT,
  refs_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'project',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ais_events_project ON ais_events(project_id, seq);
CREATE INDEX IF NOT EXISTS ais_events_ws ON ais_events(workspace_id, seq);
CREATE TRIGGER IF NOT EXISTS ais_events_no_update BEFORE UPDATE ON ais_events
BEGIN SELECT RAISE(ABORT, 'ais_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ais_events_no_delete BEFORE DELETE ON ais_events
BEGIN SELECT RAISE(ABORT, 'ais_events is append-only'); END;

CREATE TABLE IF NOT EXISTS ais_view_marks (
  scope TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ais_shares (
  id TEXT PRIMARY KEY,
  from_workspace_id TEXT NOT NULL,
  to_workspace_id TEXT NOT NULL,
  output_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS ais_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES ais_workspaces(id),
  provider_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  alias TEXT NOT NULL,
  provider_org TEXT,
  identity TEXT,
  credential_owner TEXT NOT NULL,
  billed_to TEXT,
  region TEXT,
  endpoint TEXT,
  verified_origin TEXT,
  status TEXT NOT NULL,
  status_detail TEXT NOT NULL DEFAULT '',
  status_since INTEGER NOT NULL,
  paused_by TEXT,
  last_checked_at INTEGER,
  has_secret INTEGER NOT NULL DEFAULT 0,
  secret_hint TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  disconnected_at INTEGER,
  provider_action TEXT
);

CREATE TABLE IF NOT EXISTS ais_grants (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES ais_connections(id),
  project_id TEXT NOT NULL,
  agent_ids_json TEXT NOT NULL DEFAULT '["*"]',
  role TEXT NOT NULL DEFAULT 'use',
  actions_json TEXT NOT NULL DEFAULT '[]',
  data_filters_json TEXT NOT NULL DEFAULT '[]',
  approval TEXT NOT NULL DEFAULT 'ask_each_time',
  expires_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS ais_grants_conn ON ais_grants(connection_id, project_id);

CREATE TABLE IF NOT EXISTS ais_operations (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  adapter TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL,
  suggested_class TEXT,
  scope TEXT,
  destination TEXT NOT NULL,
  input_schema_json TEXT NOT NULL DEFAULT '{}',
  output_schema_json TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  schema_hash TEXT NOT NULL,
  rate_limit INTEGER NOT NULL DEFAULT 30,
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  retry TEXT NOT NULL DEFAULT 'never',
  review_state TEXT NOT NULL DEFAULT 'needs_review',
  origin TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ais_invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  project_id TEXT,
  connection_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  output_ref TEXT,
  approval_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  provider_request_id TEXT,
  idempotency_key TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS ais_invocations_conn ON ais_invocations(connection_id, started_at);

CREATE TABLE IF NOT EXISTS ais_usage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  connection_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  amount_micros INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  tokens_source TEXT NOT NULL,
  amount_source TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ais_usage_project ON ais_usage(project_id, state);
CREATE INDEX IF NOT EXISTS ais_usage_conn ON ais_usage(connection_id, created_at);

CREATE TABLE IF NOT EXISTS ais_fallbacks (
  from_connection_id TEXT NOT NULL,
  to_connection_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_connection_id, to_connection_id)
);

CREATE TABLE IF NOT EXISTS ais_connect_drafts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  workspace_id TEXT,
  step TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export function ensureAiSpaceSchema(db: SqlDb): void {
  db.exec(AISPACE_SCHEMA)
}
