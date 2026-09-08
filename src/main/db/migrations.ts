// Everything that turns an empty SQLite database into the current one: the
// declarative schema, then the accumulated migrations.
//
// This was inside getDb, which is where it had always lived and where it could
// not be reused. The cloud runtime opens a database of its own, and the
// assumption that a fresh database is complete after db.exec(SCHEMA) is simply
// false -- 135 ensureColumn calls follow it, adding columns the app requires
// and, more to the point, columns that ride in workspace sync bodies:
// widgets.trashed_at, widgets.pinned, nodes.org_id, nodes.archived and the
// rest. A browser database built from SCHEMA alone accepted rows from the
// desktop and silently dropped every one of those columns, because applyRemote
// writes the intersection of the body and the local table.
//
// So both runtimes run this, in this order, and neither owns it. The desktop
// additionally takes a backup first and stamps user_version; that part stayed
// behind because it is about a file on disk that may predate any of this.
import type Database from 'better-sqlite3'
import { SCHEMA } from './schema'
import { migrateNodesKindCheckV2, type NodesKindMigrationResult } from './migrateNodesKind'
import { migrateIntentTaxonomyV2 } from './migrateIntentTaxonomy'
import { repairBrowsingHistoryCounts } from './migrateBrowsingHistoryCounts'
import { ensureWorkItemSchema } from './workItems'
import { ensureNotificationSchema } from '../notifications/substrate'


// primaries + the intent_sub reserved column (migrateIntentTaxonomyV2).
const MIGRATION_VERSION = 3

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

/**
 * Apply the schema and every migration to `db`, in the order they must run.
 *
 * Idempotent: each step either creates something that does not exist or
 * declines. Returns the nodes-kind migration result, which the desktop reports
 * through nodesKindMigrationStatus().
 */
export function applySchemaAndMigrations(db: Database.Database): NodesKindMigrationResult | null {
  let nodesKindMigration: NodesKindMigrationResult | null = null
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
  // Taxonomy alignment: rewrite legacy intent_class values to the eight
  // primaries (pre-imaged in wi_intent_taxonomy_backup; idempotent; re-run
  // every startup so peer-pushed legacy values converge). After BOTH ensure
  // calls above — it touches nodes.intent_class and wi_notifications.queue.
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

  const taxonomy = migrateIntentTaxonomyV2(db)
  if (taxonomy.ran && Object.keys(taxonomy.renamed).length > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[migrateIntentTaxonomyV2] renamed ${JSON.stringify(taxonomy.renamed)}; ` +
        `${taxonomy.notificationsRemapped} notification rows remapped`
    )
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
  // DEC-052 — the scheduling + external-sync FOUNDATION (Analysis 24 §4/§5c).
  // Laid now so the planner and, later, the Google/Graph connector layer in
  // without a migration. Sync columns are db-only until Track C builds: the
  // row mapper deliberately does not surface them yet.
  ensureColumn(db, 'time_blocks', 'origin', "TEXT NOT NULL DEFAULT 'manual'")
  ensureColumn(db, 'time_blocks', 'locked', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'time_blocks', 'push_policy', "TEXT NOT NULL DEFAULT 'local'")
  ensureColumn(db, 'time_blocks', 'transparency', 'TEXT')
  ensureColumn(db, 'time_blocks', 'visibility', 'TEXT')
  ensureColumn(db, 'time_blocks', 'external_event_id', 'TEXT')
  ensureColumn(db, 'time_blocks', 'external_calendar_id', 'TEXT')
  ensureColumn(db, 'time_blocks', 'external_etag', 'TEXT')
  ensureColumn(db, 'time_blocks', 'sync_state', 'TEXT')
  ensureColumn(db, 'time_blocks', 'last_synced_at', 'INTEGER')
  migrateTimeBlocksStatusCheck(db)
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
  // M2b — the Record (SPEC-003 §3.4): provenance-tiered spans, JSON.
  ensureColumn(db, 'fb_meetings', 'record_json', 'TEXT')
  // M2c (S3-DEC-020) — the meeting's desk node, when one was minted.
  ensureColumn(db, 'fb_meetings', 'desk_node_id', 'TEXT')
  // M5 (SPEC-003 P5) — series identity: a meeting born from a booked calendar
  // block remembers its block and its series, which is what makes "carried
  // from last time" a cheap indexed lookup instead of a title-match guess.
  ensureColumn(db, 'fb_meetings', 'series_id', 'TEXT')
  ensureColumn(db, 'fb_meetings', 'block_id', 'TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_fb_meetings_series ON fb_meetings(series_id, created_at)')
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
  // Collect index statistics once, on a database that has never had them.
  //
  // Without sqlite_stat1 the planner falls back to fixed guesses about how many
  // rows an index will match, which is exactly where it picks a scan over the
  // right index on tables that have grown large and skewed. That does not
  // reproduce on a small test database — it only appears after months of real
  // use, as "the app got slower the more I put in it". analysis_limit above
  // keeps this bounded; PRAGMA optimize in closeDb keeps it current afterwards.
  try {
    const hasStats = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'")
      .get() != null
    if (!hasStats) {
      // Deferred on purpose. Measured against the real 225 MB database this is
      // ~700 ms of synchronous work — once, on the first launch after upgrade —
      // and launch is the one path the user actually waits on. Running it a few
      // seconds in costs nothing anybody notices. Once sqlite_stat1 exists this
      // branch never runs again; PRAGMA optimize in closeDb (1 ms) keeps the
      // statistics current from then on.
      setTimeout(() => {
        try {
          db?.exec('ANALYZE')
        } catch (err) {
          console.warn('[db] deferred ANALYZE failed:', err)
        }
      }, 15_000).unref?.()
    }
  } catch (err) {
    // Statistics are an optimisation, never a correctness requirement: a
    // database that cannot collect them still works, just less well.
    console.warn('[db] could not check for planner statistics:', err)
  }
  return nodesKindMigration
}

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

// time_blocks shipped with CHECK (status IN ('planned','done')). DEC-052 adds
// 'missed' and 'skipped' (replan-undone needs to know a slot passed unworked),
// and rather than migrate the CHECK each time the union grows, this drops it —
// the TimeBlockStatus TS union is the guard, the same call migrateShareKindChecks
// made for share kinds. Rebuild is DYNAMIC over the live column list because,
// unlike the documents rebuild, existing DBs already carry post-create columns
// (org_id, recurrence, sync bookkeeping, the DEC-052 set) that a hard-coded
// copy would silently drop. Idempotent; a no-op once the CHECK is gone.
function migrateTimeBlocksStatusCheck(d: Database.Database): void {
  const row = d
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='time_blocks'")
    .get() as { sql?: string } | undefined
  if (!row?.sql || !/CHECK\s*\(\s*status\s+IN/i.test(row.sql)) return
  const cols = d.prepare('PRAGMA table_info(time_blocks)').all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>
  const defs = cols
    .map((c) => {
      // PRAGMA table_info carries no FK clauses — restate task_id's by hand,
      // or the rebuild would silently drop the ON DELETE CASCADE.
      if (c.name === 'task_id') return 'task_id TEXT REFERENCES nodes(id) ON DELETE CASCADE'
      let def = `${c.name} ${c.type || 'TEXT'}`
      if (c.pk) def += ' PRIMARY KEY'
      if (c.notnull && !c.pk) def += ' NOT NULL'
      if (c.dflt_value != null) def += ` DEFAULT ${c.dflt_value}`
      return def
    })
    .join(',\n      ')
  const names = cols.map((c) => c.name).join(', ')
  d.exec(`
    PRAGMA foreign_keys=off;
    BEGIN;
    DROP TRIGGER IF EXISTS time_blocks_mark_dirty;
    CREATE TABLE time_blocks_new (
      ${defs}
    );
    INSERT INTO time_blocks_new (${names}) SELECT ${names} FROM time_blocks;
    DROP TABLE time_blocks;
    ALTER TABLE time_blocks_new RENAME TO time_blocks;
    CREATE INDEX IF NOT EXISTS idx_time_blocks_start ON time_blocks (start_ms);
    CREATE INDEX IF NOT EXISTS idx_time_blocks_task ON time_blocks (task_id);
    CREATE INDEX IF NOT EXISTS idx_time_blocks_series ON time_blocks(series_id);
    CREATE TRIGGER IF NOT EXISTS time_blocks_mark_dirty AFTER UPDATE ON time_blocks
    WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
    BEGIN UPDATE time_blocks SET needs_sync = 1 WHERE id = NEW.id; END;
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
