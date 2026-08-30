import { getDb } from './database'
import { PERSONAL_ORG_ID } from './activeOrg'
import { emitObjectEvent } from '../context/engine'
import { pruneSharedRows } from './nodeLifecycle'
import { normalizeAppliedWorkItem, workItemDetachHook } from './workItems'

// ── Park-inbound (§2.1 receiver defensiveness; GAP-013 repair) ──────────────
// A row this build cannot materialize (its kind fails the local CHECK — e.g. a
// work_item arriving at an un-migrated device) is PARKED: remembered, surfaced,
// and excluded from the applied count — never silently swallowed into an
// infinite retry. The boot-time reapply sweep (S2's arrival router) drains the
// set once the local schema gains the kind. In-memory is correct here: the row
// stays on the server and re-offers every pull, so parking survives restarts by
// construction.
// [PLEXI-UPSTREAM] Isolated diff in the sync engine — flag to Caleb with the
// wake-coalescing fix.
export interface ParkedInboundRow {
  id: string
  itemType: string
  reason: string
  at: number
}
const parkedInbound = new Map<string, ParkedInboundRow>()
export function listParkedInbound(): ParkedInboundRow[] {
  return [...parkedInbound.values()]
}
function parkInbound(id: string, itemType: string, reason: string): void {
  if (parkedInbound.has(id)) return
  parkedInbound.set(id, { id, itemType, reason, at: Date.now() })
  // eslint-disable-next-line no-console
  console.warn(`[sync] park-inbound ${itemType} ${id}: ${reason}`)
}
// Classify an apply failure: a nodes CHECK rejection means the kind is unknown
// to this build — park it. Anything else (FK parent not yet synced) keeps the
// old behavior: the next cycle retries.
function maybeParkApplyFailure(
  err: unknown,
  table: string,
  item: { id: string; itemType: string; body?: unknown }
): void {
  const msg = err instanceof Error ? err.message : String(err)
  if (table === 'nodes' && /CHECK constraint failed/i.test(msg)) {
    const kind = (item.body as { kind?: unknown } | undefined)?.kind
    parkInbound(item.id, item.itemType, `kind '${String(kind)}' not accepted by local schema`)
  }
}

// Post-apply normalization for work_item rows on ALL poll arms (§2.3 F012 +
// §2.1): recompute the status projection locally, enforce the leaf invariant,
// park rows from a newer schema epoch.
function normalizeIfWorkItem(
  db: ReturnType<typeof getDb>,
  table: string,
  item: { id: string; itemType: string; body?: unknown }
): void {
  if (table !== 'nodes') return
  if ((item.body as { kind?: unknown } | undefined)?.kind !== 'work_item') return
  const verdict = normalizeAppliedWorkItem(db, item.id)
  if (verdict === 'parked-epoch') {
    parkInbound(
      item.id,
      item.itemType,
      `work_item from newer schema epoch ${String((item.body as { schema_epoch?: unknown }).schema_epoch)}`
    )
  }
}

/** F010 — the 409-loop fix: after a conflict where server-wins apply may have
 *  no-opped (echo-suppression on a desynced local rev), floor the local
 *  sync_rev to the server's so the next push carries an acceptable baseRev.
 *  A genuinely newer local edit then re-pushes ONCE and wins; without this, a
 *  conflicted row is permanently unroutable with no signal.
 *  [PLEXI-UPSTREAM] flagged with the wake-coalescing fix. */
export function advanceBaseRevCore(
  d: { prepare(sql: string): { run(...a: unknown[]): unknown } },
  table: string,
  id: string,
  rev: number
): void {
  if (!Number.isFinite(rev)) return
  // A floor, never a rewind: a local rev already at/above the server's stays.
  d.prepare(
    `UPDATE ${table} SET sync_rev = ? WHERE id = ? AND (sync_rev IS NULL OR sync_rev < ?)`
  ).run(rev, id, rev)
}

export function advanceBaseRev(itemType: string, id: string, rev: number): void {
  const table = TABLE[itemType as ItemType]
  if (!table) return
  // Structured 409 trail (P1 diagnostics): this path fires ONLY on push
  // conflicts, so a row appearing here repeatedly is a live 409 loop — the
  // exact signature the F010 fix exists to break. Greppable: "[sync-409]".
  // eslint-disable-next-line no-console
  console.warn(`[sync-409] conflict-floor ${itemType}/${id} -> rev ${rev}`)
  advanceBaseRevCore(getDb(), table, id, rev)
}

// Main-process half of multi-device workspace sync. The renderer owns the network
// (it has the signal URL + token); this layer owns the local SQLite. It collects
// rows that have local changes to push (needs_sync = 1), applies rows pulled from
// the server, and tracks the pull cursor. Per-row server rev lives in sync_rev;
// dirty state in needs_sync (set by the DB triggers in database.ts on any content
// write, cleared here after a push or an applied pull).

type SyncTable = 'nodes' | 'widgets' | 'time_blocks' | 'documents' | 'fb_tables' | 'fb_rows' | 'fb_files'
type ItemType = 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'
const TABLE: Record<ItemType, SyncTable> = {
  node: 'nodes',
  widget: 'widgets',
  timeblock: 'time_blocks',
  document: 'documents',
  table: 'fb_tables',
  row: 'fb_rows',
  file: 'fb_files'
}

// fb_files rows that are pointers to internal documents (kind 'doc') are NOT
// synced here — the document itself already travels as a 'document' item, and
// syncing the pointer would race the document and churn the Drive tree. Only real
// files and folders cross members over the org loop.
const SYNCED_FILE_KINDS = "('file','folder')"

export interface PendingUpsert {
  id: string
  itemType: ItemType
  body: Record<string, unknown>
  baseRev: number
  // Group scope carried alongside the body (not inside it): null/undefined = whole
  // org, a team id = that group only. widgets/rows inherit their parent's team.
  teamId?: string | null
  // Per-desk scope carried alongside the body: the desk root id this item belongs
  // to, for items on the ACL-scoped shared path. Absent for personal/org items.
  rootId?: string | null
}
export interface PendingDelete {
  id: string
  itemType: ItemType
  baseRev: number
  // Same per-desk scope as PendingUpsert — the shared DELETE route needs the desk
  // id to authorize and bind the tombstone.
  rootId?: string | null
}
export interface RemoteItem {
  id: string
  itemType: ItemType
  body: Record<string, unknown> | null
  rev: number
  deleted: boolean
  teamId?: string | null
  rootId?: string | null
}

// Tables that carry a shared_root_id column (the desk-scope discriminator). Used to
// keep the personal/org collects from double-pushing a shared-desk row, and to
// drive the shared collect. time_blocks/documents/fb_files never belong to a
// per-desk share, so they have no column and are excluded structurally.
const SHARED_COL_TABLES: ReadonlySet<SyncTable> = new Set(['nodes', 'widgets', 'fb_tables', 'fb_rows'])

// Pure decision for applying one pulled shared-desk item. Extracted so the
// security-critical rule is unit-tested without a DB:
//   - a shared item must name a desk (incomingRootId) or it is refused;
//   - if a local row with that id already exists but belongs to a DIFFERENT desk
//     (or to none — the recipient's own personal content), it is refused as
//     'skip-foreign' so a crafted id can never clobber the recipient's data;
//   - if the local row is at or ahead of the incoming rev, it is 'skip-echo';
//   - otherwise 'apply'.
export type SharedApplyVerdict = 'apply' | 'skip-foreign' | 'skip-echo'
export function sharedApplyVerdict(opts: {
  incomingRootId: string | null
  localExists: boolean
  localRootId: string | null
  localRev: number | null
  incomingRev: number
}): SharedApplyVerdict {
  if (!opts.incomingRootId) return 'skip-foreign'
  if (opts.localExists && (opts.localRootId ?? null) !== opts.incomingRootId) return 'skip-foreign'
  if (opts.localExists && (opts.localRev ?? -1) >= opts.incomingRev) return 'skip-echo'
  return 'apply'
}

// Which locally-materialized shared desks are no longer granted (a revoke): the
// local set minus the server's granted set. Pure so the prune diff is testable.
export function rootsToPrune(local: string[], granted: string[]): string[] {
  const g = new Set(granted)
  return local.filter((r) => !!r && !g.has(r))
}

// Columns we never round-trip through the server body (local-only sync bookkeeping,
// plus team_id which travels as its own scope field, and the __team_id alias the
// widget/row joins use to carry the parent's team).
const SYNC_COLS = new Set(['sync_rev', 'needs_sync', 'team_id', '__team_id', 'shared_root_id', '__shared_root_id'])

function tableCols(table: SyncTable): string[] {
  const db = getDb()
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

function bodyFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!SYNC_COLS.has(k)) body[k] = v
  return body
}

// ── Cursor ───────────────────────────────────────────────────────────────────
// Personal (per-account) cursor stays on its own key so the org path can never
// disturb it. Each org gets its own cursor under `workspace_cursor:<orgId>`.
const CURSOR_KEY = 'workspace_cursor'

function cursorKeyForOrg(orgId: string): string {
  return `${CURSOR_KEY}:${orgId}`
}

function readCursor(key: string): number {
  const db = getDb()
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? Number(row.value) || 0 : 0
}

function writeCursor(key: string, n: number): void {
  const db = getDb()
  db.prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(
    key,
    String(n),
    String(n)
  )
}

export function getSyncCursor(): number {
  return readCursor(CURSOR_KEY)
}

export function setSyncCursor(n: number): void {
  writeCursor(CURSOR_KEY, n)
}

// Per-org pull cursor. Independent of the personal cursor so switching scopes
// never re-pulls or skips.
export function getSyncCursorOrg(orgId: string): number {
  return readCursor(cursorKeyForOrg(orgId))
}

export function setSyncCursorOrg(orgId: string, n: number): void {
  writeCursor(cursorKeyForOrg(orgId), n)
}

// Shared-desk pull cursor. One cursor across all desks shared with this account
// (the server returns a single monotonic clock for the whole shared delta), kept
// separate from personal/org cursors so the scopes never disturb each other.
const SHARED_CURSOR_KEY = 'workspace_cursor:shared'
export function getSyncCursorShared(): number {
  return readCursor(SHARED_CURSOR_KEY)
}
export function setSyncCursorShared(n: number): void {
  writeCursor(SHARED_CURSOR_KEY, n)
}

// ── Collect local changes to push ────────────────────────────────────────────
// A dirty row that is trashed becomes a delete (tombstone); otherwise an upsert.
export function collectPending(): { upserts: PendingUpsert[]; deletes: PendingDelete[] } {
  const db = getDb()
  const upserts: PendingUpsert[] = []
  const deletes: PendingDelete[] = []

  const pushRow = (row: Record<string, unknown>, itemType: ItemType): void => {
    const id = String(row.id)
    const baseRev = Number(row.sync_rev) || 0
    if (row.trashed_at != null) deletes.push({ id, itemType, baseRev })
    else upserts.push({ id, itemType, body: bodyFromRow(row), baseRev })
  }

  // Anti-double-sync leak guard. Nodes and time blocks each carry org_id, so the
  // personal loop must take ONLY the rows scoped to the personal org. Now that
  // nodes can belong to a real org (and sync down the org endpoint), pushing them
  // here unscoped would double-push an org node to both the per-account store and
  // the org store — leaking org content into the owner's personal per-account
  // data and syncing it twice. Filtering by org_id = 'personal' keeps genuinely
  // personal content byte-for-byte as before while excluding org content entirely.
  // Tables joined the personal loop when the mobile web app learned to render
  // table and chart widgets: their data must reach the server to be drawable on
  // another device. fb_tables carries org_id directly, same as nodes.
  // A shared-desk row (shared_root_id set) syncs ONLY via the shared path, so it is
  // excluded here even though it still lives in the personal org locally — that is
  // what keeps the personal and shared scopes mutually exclusive (no double-push).
  for (const itemType of ['node', 'timeblock', 'table'] as ItemType[]) {
    const table = TABLE[itemType]
    const sharedGuard = SHARED_COL_TABLES.has(table) ? ' AND shared_root_id IS NULL' : ''
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE needs_sync = 1 AND org_id = ?${sharedGuard}`)
      .all(PERSONAL_ORG_ID) as Array<Record<string, unknown>>
    for (const row of rows) pushRow(row, itemType)
  }

  // Widgets have no org_id of their own; a widget derives its scope from its
  // parent node (the established precedent). So the personal loop takes only the
  // widgets whose parent node is personal, joining widgets to nodes on task_id.
  // A widget on an org node is excluded here and picked up by collectPendingOrg
  // instead, which is the mirror of the node filter above. Shared-desk widgets are
  // excluded by their own shared_root_id.
  const widgetRows = db
    .prepare(
      `SELECT w.* FROM widgets w
       JOIN nodes n ON w.task_id = n.id
       WHERE w.needs_sync = 1 AND n.org_id = ? AND w.shared_root_id IS NULL`
    )
    .all(PERSONAL_ORG_ID) as Array<Record<string, unknown>>
  for (const row of widgetRows) pushRow(row, 'widget')

  // Rows scope through their parent table, mirroring the org loop's join.
  const rowRows = db
    .prepare(
      `SELECT r.* FROM fb_rows r
       JOIN fb_tables t ON r.table_id = t.id
       WHERE r.needs_sync = 1 AND t.org_id = ? AND r.shared_root_id IS NULL`
    )
    .all(PERSONAL_ORG_ID) as Array<Record<string, unknown>>
  for (const row of rowRows) pushRow(row, 'row')

  return { upserts, deletes }
}

// Org-scoped collect: every org-shared row that belongs to the given real org and
// needs syncing. The mirror-image of the personal leak guard — an org row is
// never pushed up the personal endpoint, and a personal row is never pushed up
// the org endpoint. Rung 2 widens this beyond time blocks to documents, tables
// and table rows.
//
// nodes, time_blocks, documents and fb_tables each carry their own org_id, so
// they are filtered directly. fb_rows and widgets deliberately have NO org_id —
// each derives its org scope from a parent (a row from its fb_tables.org_id, a
// widget from its parent nodes.org_id, the widget-from-node precedent), so they
// are joined to that parent and filtered by the parent's org. Both bodies already
// carry the parent id (table_id / task_id), so they reattach on the other device.
export function collectPendingOrg(orgId: string): {
  upserts: PendingUpsert[]
  deletes: PendingDelete[]
} {
  const db = getDb()
  const upserts: PendingUpsert[] = []
  const deletes: PendingDelete[] = []
  if (!orgId || orgId === PERSONAL_ORG_ID) return { upserts, deletes }

  const pushRow = (row: Record<string, unknown>, itemType: ItemType): void => {
    const id = String(row.id)
    const baseRev = Number(row.sync_rev) || 0
    // Group scope: direct types carry team_id; widgets/rows inherit it from their
    // parent via the __team_id alias in the join below. Tagging every item at push
    // time means a team-shared object is never pushed org-wide first (no leak window).
    const teamId = (row.team_id ?? row.__team_id ?? null) as string | null
    if (row.trashed_at != null) deletes.push({ id, itemType, baseRev })
    else upserts.push({ id, itemType, body: bodyFromRow(row), baseRev, teamId })
  }

  // Types that carry org_id directly: filter by the column.
  const directTypes: Array<[ItemType, SyncTable]> = [
    ['node', TABLE.node],
    ['timeblock', TABLE.timeblock],
    ['document', TABLE.document],
    ['table', TABLE.table]
  ]
  // A shared-desk row lives in the personal org locally (org_id = 'personal') so it
  // never matches org_id = <realOrg> here anyway; the explicit shared_root_id guard
  // is future-proofing against ever sharing an org desk per-person (still one path).
  for (const [itemType, table] of directTypes) {
    const sharedGuard = SHARED_COL_TABLES.has(table) ? ' AND shared_root_id IS NULL' : ''
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE needs_sync = 1 AND org_id = ?${sharedGuard}`)
      .all(orgId) as Array<Record<string, unknown>>
    for (const row of rows) pushRow(row, itemType)
  }

  // Widgets: no org_id of their own, so join to the parent node and filter by the
  // node's org. The widget body still includes task_id for reattachment. This is
  // the mirror of the personal collectPending widget filter.
  const widgetRows = db
    .prepare(
      `SELECT w.*, n.team_id AS __team_id FROM widgets w
       JOIN nodes n ON w.task_id = n.id
       WHERE w.needs_sync = 1 AND n.org_id = ? AND w.shared_root_id IS NULL`
    )
    .all(orgId) as Array<Record<string, unknown>>
  for (const row of widgetRows) pushRow(row, 'widget')

  // Rows: no org_id of their own, so join to the parent table and filter by the
  // table's org. The row body still includes table_id for reattachment.
  const rows = db
    .prepare(
      `SELECT r.*, t.team_id AS __team_id FROM fb_rows r
       JOIN fb_tables t ON r.table_id = t.id
       WHERE r.needs_sync = 1 AND t.org_id = ? AND r.shared_root_id IS NULL`
    )
    .all(orgId) as Array<Record<string, unknown>>
  for (const row of rows) pushRow(row, 'row')

  // Drive files + folders (fb_files carries org_id directly). Doc-pointer rows are
  // excluded (their document syncs as a 'document'); a file's bytes are uploaded
  // separately by the renderer after its metadata pushes.
  const fileRows = db
    .prepare(`SELECT * FROM fb_files WHERE needs_sync = 1 AND org_id = ? AND kind IN ${SYNCED_FILE_KINDS}`)
    .all(orgId) as Array<Record<string, unknown>>
  for (const row of fileRows) pushRow(row, 'file')

  return { upserts, deletes }
}

// Shared-desk collect: every dirty row that belongs to a desk shared with named
// individuals (shared_root_id set), regardless of local org bucket. Each item
// carries its desk root id so the shared push route can authorize + bind it. This
// is the ONLY collect that emits shared-desk rows (they are excluded from both the
// personal and org collects), so a shared desk syncs down exactly one path.
export function collectPendingShared(): { upserts: PendingUpsert[]; deletes: PendingDelete[] } {
  const db = getDb()
  const upserts: PendingUpsert[] = []
  const deletes: PendingDelete[] = []

  // Tag any content added to a shared desk since it was shared (new notes, widgets,
  // child desks, tables, rows) so it actually pushes. Without this, only the
  // share-time snapshot and edits to it would ever sync. Cheap: only walks desks
  // that are actually shared locally, and only writes to still-untagged rows.
  for (const root of listLocalSharedRoots()) reconcileSharedDescendants(root)

  const pushRow = (row: Record<string, unknown>, itemType: ItemType): void => {
    const id = String(row.id)
    const baseRev = Number(row.sync_rev) || 0
    const rootId = (row.shared_root_id ?? null) as string | null
    if (!rootId) return
    if (row.trashed_at != null) deletes.push({ id, itemType, baseRev, rootId })
    else {
      // D1 (DEC-021): `archived` is SCOPE-LOCAL on shared rows — "Archive for
      // me" must never sync a shared desk out of the other participants'
      // views. Stripped here on emit and ignored on shared apply (both
      // directions, or one side silently overwrites the other's choice).
      const body = bodyFromRow(row)
      delete body.archived
      upserts.push({ id, itemType, body, baseRev, rootId })
    }
  }

  // Every desk-content table carries shared_root_id directly (stamped across the
  // whole subtree at share time), so no joins are needed.
  const typeToTable: Array<[ItemType, SyncTable]> = [
    ['node', TABLE.node],
    ['table', TABLE.table],
    ['widget', TABLE.widget],
    ['row', TABLE.row]
  ]
  for (const [itemType, table] of typeToTable) {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE needs_sync = 1 AND shared_root_id IS NOT NULL`)
      .all() as Array<Record<string, unknown>>
    for (const row of rows) pushRow(row, itemType)
  }
  return { upserts, deletes }
}

// Walk a desk's structural subtree: the root node, every descendant node (by
// parent_id, any depth), and the tables backed by table-widgets anywhere in it. The
// walk is by structure, NOT by shared_root_id, so it deliberately finds content that
// has NOT been tagged yet (a note added after the share). Returns node ids (root
// first) and the distinct backing-table ids.
function collectDeskSubtree(rootId: string): { nodeIds: string[]; tableIds: string[] } {
  const db = getDb()
  const exists = db.prepare('SELECT id FROM nodes WHERE id = ? AND trashed_at IS NULL').get(rootId)
  if (!exists) return { nodeIds: [], tableIds: [] }
  const nodeIds: string[] = []
  // §2.6 scope invariant: the shared collect cannot pick up work_items while
  // the exposure switch is OFF — they stay personal (self-routed items are
  // additionally exempt forever, §2.5.9; the stamp sweep honors this guard).
  const collect = (nid: string): void => {
    nodeIds.push(nid)
    const kids = db
      .prepare(
        "SELECT id FROM nodes WHERE parent_id = ? AND trashed_at IS NULL AND kind != 'work_item'"
      )
      .all(nid) as Array<{ id: string }>
    for (const k of kids) collect(k.id)
  }
  collect(rootId)
  const tableIds = (
    db
      .prepare(
        `SELECT DISTINCT content AS id FROM widgets
         WHERE task_id IN (${nodeIds.map(() => '?').join(',')})
           AND kind = 'table' AND content IS NOT NULL AND content != ''`
      )
      .all(...nodeIds) as Array<{ id: string }>
  ).map((r) => r.id)
  return { nodeIds, tableIds }
}

// Stamp a desk subtree with shared_root_id and reset sync_rev so it re-pushes fresh
// onto the shared path. Mirrors moveNodeToOrg's collection but for the ACL-shared
// scope. Run once at share time. Returns the stamped node ids (root first).
export function stampSharedDesk(rootId: string): string[] {
  const db = getDb()
  const { nodeIds, tableIds } = collectDeskSubtree(rootId)
  if (nodeIds.length === 0) return []
  const setNode = db.prepare('UPDATE nodes SET shared_root_id = ?, needs_sync = 1, sync_rev = 0 WHERE id = ?')
  const setWidgets = db.prepare('UPDATE widgets SET shared_root_id = ?, needs_sync = 1, sync_rev = 0 WHERE task_id = ?')
  const setTable = db.prepare('UPDATE fb_tables SET shared_root_id = ?, needs_sync = 1, sync_rev = 0 WHERE id = ?')
  const setRows = db.prepare('UPDATE fb_rows SET shared_root_id = ?, needs_sync = 1, sync_rev = 0 WHERE table_id = ?')
  db.transaction(() => {
    for (const i of nodeIds) {
      setNode.run(rootId, i)
      setWidgets.run(rootId, i)
    }
    for (const t of tableIds) {
      setTable.run(rootId, t)
      setRows.run(rootId, t)
    }
  })()
  return nodeIds
}

// Propagate a shared desk's tag DOWN to any descendant created after the share:
// stampSharedDesk only tags what existed at share time, and createNode/createWidget/
// createTable/createRow do not inherit shared_root_id, so a note added five minutes
// later would otherwise never sync. This re-walks the subtree and stamps only the
// still-untagged members (both the owner's and, on the other side, the recipient's
// new content), marking them dirty so the next collect pushes them. It touches ONLY
// rows whose shared_root_id IS NULL, so already-synced content is never re-dirtied.
// Returns how many rows it newly tagged. Called at the top of every shared collect,
// which is what makes "changes as they happen" actually hold for new content.
export function reconcileSharedDescendants(rootId: string): number {
  const db = getDb()
  const root = db.prepare('SELECT shared_root_id FROM nodes WHERE id = ? AND trashed_at IS NULL').get(rootId) as
    | { shared_root_id: string | null }
    | undefined
  if (!root || root.shared_root_id !== rootId) return 0 // only reconcile a genuine, still-shared root
  const { nodeIds, tableIds } = collectDeskSubtree(rootId)
  if (nodeIds.length === 0) return 0
  const inNodes = nodeIds.map(() => '?').join(',')
  const inTables = tableIds.length ? tableIds.map(() => '?').join(',') : null
  let changed = 0
  const tx = db.transaction(() => {
    changed += db
      .prepare(`UPDATE nodes SET shared_root_id = ?, needs_sync = 1 WHERE id IN (${inNodes}) AND shared_root_id IS NULL`)
      .run(rootId, ...nodeIds).changes as number
    changed += db
      .prepare(
        `UPDATE widgets SET shared_root_id = ?, needs_sync = 1 WHERE task_id IN (${inNodes}) AND shared_root_id IS NULL`
      )
      .run(rootId, ...nodeIds).changes as number
    if (inTables) {
      changed += db
        .prepare(`UPDATE fb_tables SET shared_root_id = ?, needs_sync = 1 WHERE id IN (${inTables}) AND shared_root_id IS NULL`)
        .run(rootId, ...tableIds).changes as number
      changed += db
        .prepare(
          `UPDATE fb_rows SET shared_root_id = ?, needs_sync = 1 WHERE table_id IN (${inTables}) AND shared_root_id IS NULL`
        )
        .run(rootId, ...tableIds).changes as number
    }
  })
  tx()
  return changed
}

// Distinct desk ids currently materialized locally as shared. Used to prune desks
// the account has lost access to: any local shared root the server no longer lists
// in the caller's granted set is removed (see pruneSharedDesk).
export function listLocalSharedRoots(): string[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT DISTINCT shared_root_id AS r FROM nodes WHERE shared_root_id IS NOT NULL')
    .all() as Array<{ r: string | null }>
  return rows.map((x) => x.r).filter((r): r is string => !!r)
}

// Clear the dirty flag and record the server rev after a successful push. Updating
// sync_rev means the dirty trigger does not re-fire (it guards on sync cols).
// (advanceBaseRevCore/advanceBaseRev live at the top of this module — the merge
// from main briefly duplicated them here; the single definition stands above.)

export function markPushed(itemType: ItemType, id: string, rev: number): void {
  const db = getDb()
  db.prepare(`UPDATE ${TABLE[itemType]} SET sync_rev = ?, needs_sync = 0 WHERE id = ?`).run(rev, id)
}

// ── Apply rows pulled from the server ────────────────────────────────────────
// Nodes are applied before widgets so a widget's task always exists first.
// A change applied from a remote pull, for the Context Health "changed while you
// were away" frame.
interface RemoteApplied {
  id: string
  itemType: ItemType
  deleted: boolean
  deskId: string | null
}

// The parent a health event should hang under: a widget's desk (task_id) or a
// node's parent (parent_id). Null for deletes (no body) and other types.
function deskIdOfRemote(it: RemoteItem): string | null {
  const b = it.body as Record<string, unknown> | null
  if (!b) return null
  const v = it.itemType === 'widget' ? b.task_id : it.itemType === 'node' ? b.parent_id : null
  return typeof v === 'string' ? v : null
}

// Emit a Context-Engine Object Event for each genuinely-new remote change, so a
// widget or desk changed on another device or by another member lights its "changed
// since your last visit" frame when the user returns. Only nodes and widgets carry
// that frame, so only they emit. MUST run AFTER the apply transaction commits: the
// event store's append opens its own db.transaction and better-sqlite3 forbids
// nesting (a nested attempt would be swallowed, silently dropping the signal).
// Deliberately does NOT advance the review point, so the change stays surfaced until
// the user actually opens the desk. Non-fatal (emitObjectEvent swallows failures).
// DEC-056 — which remote changes deserve an Event, as a pure decision so it can
// be pinned by a test. Two rules, both aimed at the same failure:
//
//   DELETIONS DO NOT EMIT. The only purpose of these Events is the "changed on
//   another device" frame a returning reader sees, and a deleted object has no
//   frame to light — its row is gone from the desk, so the Event could never be
//   read by anything. This was the dominant source of an unbounded Event table:
//   590,304 of 761,344 rows on the operator's machine were WidgetDeleted /
//   DeskDeleted that nothing consumed, because one cascade delete fans out an
//   Event per descendant widget. Events cannot be pruned afterwards
//   (PLX-EVT-030), so the only place to fix this is at the source.
//
//   UPDATES EMIT ONCE PER OBJECT. A sync pass that touches the same widget
//   twice is one change to the reader, not two.
export function changeEventsFor(
  changes: RemoteApplied[]
): { eventType: 'WidgetUpdated' | 'DeskUpdated'; objectId: string; deskId?: string | null }[] {
  const seen = new Set<string>()
  const out: { eventType: 'WidgetUpdated' | 'DeskUpdated'; objectId: string; deskId?: string | null }[] = []
  for (const c of changes) {
    if (c.itemType !== 'node' && c.itemType !== 'widget') continue
    if (c.deleted) continue
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push({
      eventType: c.itemType === 'widget' ? 'WidgetUpdated' : 'DeskUpdated',
      objectId: c.id,
      deskId: c.deskId
    })
  }
  return out
}

function emitRemoteChangeEvents(changes: RemoteApplied[], orgId?: string): void {
  const orgOpt = orgId && orgId !== PERSONAL_ORG_ID ? { organisationId: orgId } : {}
  for (const e of changeEventsFor(changes)) {
    emitObjectEvent({
      eventType: e.eventType,
      category: 'system',
      objectId: e.objectId,
      deskId: e.deskId,
      changeSummary: 'Changed on another device',
      ...orgOpt
    })
  }
}

// DEC-059 — should this tombstone be written, or do we already hold it?
//
// Extracted so the rule can be tested directly: the bug it fixes was invisible
// in `applyRemote` because the damage happened one layer down, in a trigger.
export function shouldApplyTombstone(
  local: { sync_rev: number | null; trashed_at: number | null } | undefined,
  itemRev: number
): boolean {
  if (!local) return false // a tombstone for a row this device never had
  // Already trashed at this rev or newer: re-writing it is a no-op UPDATE, and
  // a no-op UPDATE is what marks the row dirty and restarts the push loop.
  if ((local.sync_rev ?? -1) >= itemRev && local.trashed_at != null) return false
  return true
}

export function applyRemote(items: RemoteItem[]): { applied: number } {
  const db = getDb()
  // Nodes first: widgets and time blocks may reference them by foreign key.
  const rank = (t: ItemType): number => (t === 'node' ? 0 : 1)
  const ordered = [...items].sort((a, b) => rank(a.itemType) - rank(b.itemType))
  let applied = 0
  const changes: RemoteApplied[] = []
  const tx = db.transaction(() => {
    for (const item of ordered) {
      const table = TABLE[item.itemType]
      // Forward compatibility: an item type this build does not know is
      // skipped, never a crash (a newer device may sync richer types).
      if (!table) continue
      if (item.deleted) {
        // Soft-delete locally if the row exists; keep an existing trash timestamp.
        const local = db.prepare(`SELECT sync_rev, trashed_at FROM ${table} WHERE id = ?`).get(item.id) as
          | { sync_rev: number | null; trashed_at: number | null }
          | undefined
        // Nothing here to delete: a tombstone for a row this device never had.
        if (!shouldApplyTombstone(local, item.rev)) continue
        // DEC-059 — ECHO SUPPRESSION, the same guard the upsert below already
        // has, and its absence here was an unbounded sync loop.
        //
        // The pull window re-sends tombstones this device already holds. Writing
        // one again looks harmless — trashed_at is COALESCEd, sync_rev and
        // needs_sync are rewritten to the values they already have — but it is a
        // no-op UPDATE, and a no-op UPDATE is exactly what `widgets_mark_dirty`
        // fires on: its WHEN clause asks for NEW.needs_sync = OLD.needs_sync AND
        // NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0, which is precisely
        // true when re-applying an already-applied tombstone. The trigger is
        // right — it exists so local edits are pushed and sync writes are not —
        // but re-applying an echo is indistinguishable from a local edit.
        //
        // So the row was marked dirty, pushed as a delete, the server bumped its
        // rev, the next pull returned the tombstone at the new rev, and it went
        // round again: one server write per widget per cycle, forever. Measured
        // on the operator's machine before this fix: sync_rev 7,319 on one
        // minimap and 7,214 on one webview, both trashed and still flagged
        // needs_sync = 1, with 136 widgets past rev 1,000.
        db.prepare(
          `UPDATE ${table} SET trashed_at = COALESCE(trashed_at, ?), sync_rev = ?, needs_sync = 0 WHERE id = ?`
        ).run(Date.now(), item.rev, item.id)
        applied++
        changes.push({ id: item.id, itemType: item.itemType, deleted: true, deskId: null })
        continue
      }
      if (!item.body || typeof item.body !== 'object') continue
      // Echo/stale suppression: the pull window includes items this device just
      // pushed (the cursor only advances after the pull). Re-applying an echo is
      // what made the whole desk visibly reload every sync cycle, so skip any
      // item whose rev we already have locally.
      const local = db.prepare(`SELECT sync_rev FROM ${table} WHERE id = ?`).get(item.id) as
        | { sync_rev: number | null }
        | undefined
      if (local && (local.sync_rev ?? -1) >= item.rev) continue
      // Upsert every column present in both the body and the table; set the sync
      // bookkeeping to "clean at this rev" so we never re-push what we just pulled.
      const cols = tableCols(table)
      const present = cols.filter((c) => !SYNC_COLS.has(c) && c in item.body!)
      if (!present.includes('id')) continue
      const params: Record<string, unknown> = {}
      for (const c of present) params[c] = (item.body as Record<string, unknown>)[c]
      params.sync_rev = item.rev
      params.needs_sync = 0
      const allCols = [...present, 'sync_rev', 'needs_sync']
      const insertList = allCols.join(', ')
      const valueList = allCols.map((c) => `@${c}`).join(', ')
      const updateList = allCols.filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ')
      try {
        db.prepare(
          `INSERT INTO ${table} (${insertList}) VALUES (${valueList}) ON CONFLICT(id) DO UPDATE SET ${updateList}`
        ).run(params)
        applied++
        changes.push({ id: item.id, itemType: item.itemType, deleted: false, deskId: deskIdOfRemote(item) })
        normalizeIfWorkItem(db, table, item)
      } catch (err) {
        // One bad row (e.g. a foreign key whose parent has not synced yet)
        // must not abort the whole batch; the next cycle retries it — EXCEPT a
        // kind the local schema rejects, which is parked + surfaced (§2.1).
        maybeParkApplyFailure(err, table, item)
      }
    }
  })
  tx()
  // P1 diagnostics: pull + 409 conflict-applies both funnel through here.
  // Paired with [sync-mark]/[sync-409] this completes the trail of every
  // sync_rev writer in the personal loop. Greppable: "[sync-apply]".
  const widgetApplies = changes.filter((c) => c.itemType === 'widget')
  if (widgetApplies.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[sync-apply] widgets: ${widgetApplies.map((c) => `${c.id}${c.deleted ? ' (del)' : ''}`).join(', ')}`
    )
  }
  emitRemoteChangeEvents(changes)
  return { applied }
}

// Apply rows pulled from the ORG endpoint. Mirror of applyRemote, widened in
// rung 2 to time blocks, documents, tables and table rows. Two rules keep it
// correct across types:
//
//   1. Ordering: parents are applied before children. Nodes come before widgets
//      (a widget's task_id foreign key needs its node) and before rows, and tables
//      come before rows (a row's table_id foreign key needs its table). The rank
//      below encodes node < widget < row and table < row; other types are
//      order-independent.
//   2. org_id stamping: the active org's id is stamped onto any applied row whose
//      table actually has an org_id column (nodes, time blocks, documents, tables),
//      so a pulled row always lands in the correct org bucket regardless of what
//      its serialized body carried. fb_rows and widgets have no org_id column
//      (their scope derives from a parent), so they are never stamped.
//
// Kept separate from applyRemote so the personal path stays byte-for-byte
// unchanged. Each row is applied under its own try/catch so one bad foreign key
// (e.g. a row whose table has not synced yet) never aborts the batch.
// Order a pulled org batch so every parent inserts before its children in a single
// pass, which matters because the receiver applies the batch inside one FK-checked
// transaction. Two constraints stack:
//   1. Cross-type rank: node before widget (widgets.task_id -> nodes.id) and table
//      before row (fb_rows.table_id -> tables.id). Everything else is rank 0 and
//      order-independent. A stable sort preserves the server's order within a rank.
//   2. Node ancestry: nodes self-reference (parent_id REFERENCES nodes(id)), so a
//      Room and a Desk nested in it can arrive together. Rank keeps all nodes ahead
//      of widgets/rows but not in ancestry order, so the node items are additionally
//      topologically sorted: a node whose parent is also in the batch is emitted
//      only after that parent. A node whose parent is not in the batch (already in
//      the DB, or a genuine orphan the retry handles) keeps its rank position.
// Deletes carry no FK to satisfy, but ordering them costs nothing and keeps the
// function pure over the whole batch. Exported so it can be unit-tested without a DB.
export function orderOrgItemsForApply(items: RemoteItem[]): RemoteItem[] {
  const rank = (t: ItemType): number => (t === 'node' ? 0 : t === 'widget' ? 1 : t === 'row' ? 2 : 0)
  const ordered = [...items].sort((a, b) => rank(a.itemType) - rank(b.itemType))
  // Self-referential types carry a parent_id into the SAME table, so within their
  // rank slots each parent must be emitted before its children in a single pass:
  // nodes (parent_id -> nodes.id, a Room before a Desk nested in it) and Drive
  // files/folders (fb_files.parent_id -> fb_files.id, a folder before its files).
  // A file's parent is never a node, so the two groups sort independently.
  topoSortSelfReferential(ordered, 'node')
  topoSortSelfReferential(ordered, 'file')
  return ordered
}

// Reorder just the items of `itemType` so a parent (by body.parent_id, referencing
// the same table) always precedes its children, leaving every other item exactly
// where rank placed it. Pure over the batch; a node/file whose parent is not in the
// batch keeps its slot (the parent is already in the DB, or a genuine orphan the
// per-row retry handles).
function topoSortSelfReferential(ordered: RemoteItem[], itemType: ItemType): void {
  const slots: number[] = []
  const idToPos = new Map<string, number>()
  ordered.forEach((it, i) => {
    if (it.itemType !== itemType) return
    slots.push(i)
    if (typeof it.id === 'string') idToPos.set(it.id, i)
  })
  if (slots.length <= 1) return
  const parentOf = (i: number): string | null => {
    const b = ordered[i].body as Record<string, unknown> | null | undefined
    const p = b && typeof b === 'object' ? b['parent_id'] : null
    return typeof p === 'string' ? p : null
  }
  const emitted = new Set<number>()
  const out: number[] = []
  const visit = (i: number, stack: Set<number>): void => {
    if (emitted.has(i) || stack.has(i)) return
    stack.add(i)
    const p = parentOf(i)
    if (p != null) {
      const pi = idToPos.get(p)
      if (pi != null && pi !== i) visit(pi, stack)
    }
    stack.delete(i)
    if (!emitted.has(i)) {
      emitted.add(i)
      out.push(i)
    }
  }
  for (const i of slots) visit(i, new Set())
  // Snapshot the reordered items before writing so an overwritten slot is never read back.
  const reordered = out.map((i) => ordered[i])
  slots.forEach((slot, k) => {
    ordered[slot] = reordered[k]
  })
}

export function applyRemoteOrg(items: RemoteItem[], orgId: string): { applied: number } {
  const db = getDb()
  if (!orgId || orgId === PERSONAL_ORG_ID) return { applied: 0 }
  const ordered = orderOrgItemsForApply(items)
  let applied = 0
  const changes: RemoteApplied[] = []
  const tx = db.transaction(() => {
    for (const item of ordered) {
      const table = TABLE[item.itemType]
      // Forward compatibility: an item type this build does not know is skipped,
      // never a crash (a newer device may sync richer types).
      if (!table) continue
      if (item.deleted) {
        // Soft-delete locally if the row exists; keep an existing trash timestamp.
        const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(item.id)
        if (exists) {
          db.prepare(
            `UPDATE ${table} SET trashed_at = COALESCE(trashed_at, ?), sync_rev = ?, needs_sync = 0 WHERE id = ?`
          ).run(Date.now(), item.rev, item.id)
          applied++
          changes.push({ id: item.id, itemType: item.itemType, deleted: true, deskId: null })
        }
        continue
      }
      if (!item.body || typeof item.body !== 'object') continue
      // Echo/stale suppression: skip any item whose rev we already have locally.
      const local = db.prepare(`SELECT sync_rev FROM ${table} WHERE id = ?`).get(item.id) as
        | { sync_rev: number | null }
        | undefined
      if (local && (local.sync_rev ?? -1) >= item.rev) continue
      const cols = tableCols(table)
      const present = cols.filter((c) => !SYNC_COLS.has(c) && c in item.body!)
      if (!present.includes('id')) continue
      const params: Record<string, unknown> = {}
      for (const c of present) params[c] = (item.body as Record<string, unknown>)[c]
      // Stamp the active org only on types that actually have an org_id column, so
      // the row lands in the right bucket. fb_rows has no org_id, so skip it.
      const hasOrgIdCol = cols.includes('org_id')
      if (hasOrgIdCol) params.org_id = orgId
      // Stamp the group scope on types that have a team_id column (nodes/documents/
      // files/tables), so a receiver who later edits the object re-pushes it under
      // the same team. widgets/rows have no column — they re-derive from their parent.
      const hasTeamIdCol = cols.includes('team_id')
      if (hasTeamIdCol) params.team_id = item.teamId ?? null
      params.sync_rev = item.rev
      params.needs_sync = 0
      const allCols = [...present]
      if (hasOrgIdCol && !allCols.includes('org_id')) allCols.push('org_id')
      if (hasTeamIdCol && !allCols.includes('team_id')) allCols.push('team_id')
      allCols.push('sync_rev', 'needs_sync')
      const insertList = allCols.join(', ')
      const valueList = allCols.map((c) => `@${c}`).join(', ')
      const updateList = allCols.filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ')
      try {
        db.prepare(
          `INSERT INTO ${table} (${insertList}) VALUES (${valueList}) ON CONFLICT(id) DO UPDATE SET ${updateList}`
        ).run(params)
        applied++
        changes.push({ id: item.id, itemType: item.itemType, deleted: false, deskId: deskIdOfRemote(item) })
        normalizeIfWorkItem(db, table, item)
      } catch (err) {
        // A single bad row (e.g. a foreign key whose parent table has not synced
        // yet) must not abort the batch; the next cycle retries it — except an
        // unknown kind, which is parked + surfaced (§2.1).
        maybeParkApplyFailure(err, table, item)
      }
    }
  })
  tx()
  emitRemoteChangeEvents(changes, orgId)
  return { applied }
}

// Apply a batch pulled from the ACL-scoped shared endpoint (desks shared with this
// account by name). Materializes the desk into the recipient's PERSONAL bucket,
// preserving the server ids so the two sides converge, and tags every row with its
// desk id so the recipient's later edits re-push to the same desk. Three rules make
// it safe and coherent:
//
//   1. Integrity guard: a shared item is applied only when there is no local row
//      with that id, OR the local row already belongs to THIS desk (same
//      shared_root_id). A shared item can therefore never overwrite the recipient's
//      own personal content, nor another desk's, even if a malicious owner crafts an
//      item id equal to one the recipient already has.
//   2. Root anchoring: the desk ROOT node (id === rootId) is parented under the
//      local "Shared with me" container on first materialization and left wherever
//      it sits thereafter, so a later owner edit never re-orphans or moves it.
//   3. Local scoping: org_id is forced to the personal sentinel and shared_root_id
//      to the desk id, regardless of what the serialized body carried.
//
// Each row is applied under its own try/catch so one not-yet-synced foreign key
// never aborts the batch (the next cycle retries).
export function applyRemoteShared(
  items: RemoteItem[],
  opts: { sharedContainerId: string; ownerHandles?: Record<string, string> }
): { applied: number } {
  const db = getDb()
  const ordered = orderOrgItemsForApply(items)
  let applied = 0
  const changes: RemoteApplied[] = []
  const tx = db.transaction(() => {
    for (const item of ordered) {
      const table = TABLE[item.itemType]
      if (!table) continue
      const rootId = item.rootId ?? null
      if (!rootId) continue // a shared item must name its desk
      if (!SHARED_COL_TABLES.has(table)) continue // only desk-content tables carry the column

      // Single read of the local row's desk tag + rev, routed through the pure guard
      // so the security-critical decision (never overwrite a foreign row, suppress
      // echoes) is unit-tested in isolation.
      const localRow = db.prepare(`SELECT shared_root_id, sync_rev FROM ${table} WHERE id = ?`).get(item.id) as
        | { shared_root_id: string | null; sync_rev: number | null }
        | undefined
      const verdict = sharedApplyVerdict({
        incomingRootId: rootId,
        localExists: !!localRow,
        localRootId: localRow?.shared_root_id ?? null,
        localRev: localRow?.sync_rev ?? null,
        incomingRev: item.rev
      })

      if (item.deleted) {
        // Tombstone only when the local row exists AND belongs to this desk AND the
        // delete is not stale (verdict 'apply' encodes all three).
        if (verdict === 'apply' && localRow) {
          db.prepare(
            `UPDATE ${table} SET trashed_at = COALESCE(trashed_at, ?), sync_rev = ?, needs_sync = 0 WHERE id = ?`
          ).run(Date.now(), item.rev, item.id)
          applied++
          changes.push({ id: item.id, itemType: item.itemType, deleted: true, deskId: null })
        }
        continue
      }
      if (verdict !== 'apply') continue
      if (!item.body || typeof item.body !== 'object') continue

      const cols = tableCols(table)
      // D1 (DEC-021): `archived` is scope-local on shared rows — an inbound
      // shared apply never overwrites this device's "Archive for me" choice
      // (the emit side strips it too; see collectPendingShared).
      const present = cols.filter((c) => !SYNC_COLS.has(c) && c !== 'archived' && c in item.body!)
      if (!present.includes('id')) continue
      const params: Record<string, unknown> = {}
      for (const c of present) params[c] = (item.body as Record<string, unknown>)[c]
      // Rule 3: force local scoping.
      if (cols.includes('org_id')) params.org_id = PERSONAL_ORG_ID
      params.shared_root_id = rootId
      // Rule 2: anchor the desk root under the local container on first receipt,
      // else keep wherever it already sits.
      if (item.id === rootId && cols.includes('parent_id')) {
        const existing = db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(item.id) as
          | { parent_id: string | null }
          | undefined
        params.parent_id = existing ? existing.parent_id : opts.sharedContainerId
        // Attribution: stamp who shared it so the recipient sees "Shared by X" on the
        // desk. Only on the root node, only when the server supplied the owner name
        // (never for a desk this account owns). shared_from_handle rides the body, so
        // overriding params here is enough for it to persist.
        const ownerHandle = opts.ownerHandles?.[rootId]
        if (ownerHandle && cols.includes('shared_from_handle')) {
          params.shared_from_handle = ownerHandle
          if (!present.includes('shared_from_handle')) present.push('shared_from_handle')
        }
      }
      params.sync_rev = item.rev
      params.needs_sync = 0
      const allCols = [...present]
      if (cols.includes('org_id') && !allCols.includes('org_id')) allCols.push('org_id')
      if (!allCols.includes('shared_root_id')) allCols.push('shared_root_id')
      allCols.push('sync_rev', 'needs_sync')
      const insertList = allCols.join(', ')
      const valueList = allCols.map((c) => `@${c}`).join(', ')
      const updateList = allCols.filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ')
      try {
        db.prepare(
          `INSERT INTO ${table} (${insertList}) VALUES (${valueList}) ON CONFLICT(id) DO UPDATE SET ${updateList}`
        ).run(params)
        applied++
        changes.push({ id: item.id, itemType: item.itemType, deleted: false, deskId: deskIdOfRemote(item) })
        normalizeIfWorkItem(db, table, item)
      } catch (err) {
        // FK not present yet (a parent arriving in a later cycle) — retry next
        // cycle. An unknown kind is parked + surfaced instead (§2.1).
        maybeParkApplyFailure(err, table, item)
      }
    }
  })
  tx()
  emitRemoteChangeEvents(changes)
  return { applied }
}

// Owner-side adoption: when a desk this account OWNS is discovered as shared but a
// pre-existing local copy is still untagged (the classic "shared from my other
// device" case), fold that local copy into shared scope so it converges instead of
// diverging. Only ever called for desks the SERVER confirmed the caller owns, so a
// recipient can never adopt (and thus never absorb) a colliding local row. Returns
// true if it adopted (there was an untagged local copy), false otherwise. The
// caller applies the server delta straight after, so the local copy reconciles to
// the shared truth (last-write-wins) without losing rows the server didn't have.
export function adoptSharedDesk(rootId: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT shared_root_id FROM nodes WHERE id = ? AND trashed_at IS NULL').get(rootId) as
    | { shared_root_id: string | null }
    | undefined
  if (!row) return false // not on this device — applyRemoteShared materializes it fresh
  if (row.shared_root_id === rootId) return false // already shared here
  stampSharedDesk(rootId)
  return true
}

// Prune a desk that this account no longer has access to (revoked, or never
// re-granted). Removes the local materialized copy of the desk's rows. Only ever
// touches rows tagged with this desk id, so it can never delete personal content.
// Returns the number of rows removed.
export function pruneSharedDesk(rootId: string): number {
  const db = getDb()
  if (!rootId) return 0
  // Sanctioned hard-delete site 3/3 — the prune core lives in nodeLifecycle
  // (§2.5.3): work_items are detached-and-revived and excluded from the DELETE.
  const tx = db.transaction(() =>
    pruneSharedRows(db, rootId, ['fb_rows', 'widgets', 'fb_tables', 'nodes'], workItemDetachHook(db))
  )
  return tx()
}
