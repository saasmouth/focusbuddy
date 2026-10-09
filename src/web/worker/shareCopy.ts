// One link's desk in a visitor's browser: is it here, take it out, put a newer
// version in its place -- without touching any other link's desk.
//
// A visitor's browser holds one database, and every link they open unpacks into
// it (importDeskBundle, which is additive: INSERT OR IGNORE). So "this link's
// copy" is not a file that can be deleted on its own. It is a set of rows: the
// desk the link names, everything filed under it, and whatever only that desk
// points at. This module is the only place that set is worked out, and the
// share page reaches it through the 'shareCopy:*' channels (SHARE_COPY_HANDLERS),
// which exist in the browser runtime only -- the desktop has no visitors.
//
// Why not just empty the whole database, as the first version did: because a
// prospect who was sent two links has two desks here, and replacing or removing
// one of them must never take the other (or the visitor's edits to it) along.
//
// THE NODES DELETE BELOW IS NOT A FIFTH §2.5.3 SITE. The closed set of hard
// deletes on `nodes` (tests/unit/ciDeleteSiteLock.test.ts) governs src/main: a
// user's own workspace, where work items must be revived rather than destroyed.
// This database is a visitor's throwaway copy of someone else's desk; until now
// the only way its rows ever left was the whole OPFS store being emptied, which
// is strictly more destructive than this. It is pinned on its own terms by
// tests/unit/shareCopyRows.test.ts: this file is the only src/web file that
// deletes from `nodes`, and only for a subtree it was asked for by root.
import { getDb } from '../../main/db/database'
import {
  importDeskBundle, danglingReferences, fileIdFromContent, DESK_BUNDLE_FORMAT, DESK_BUNDLE_VERSION,
  type DeskBundle, type BundleImportResult
} from '../../main/db/deskBundle'
import { fileBlobs } from '../../main/db/fileBlobs'

interface Stmt {
  all: (...a: unknown[]) => unknown[]
  get: (...a: unknown[]) => unknown
  run: (...a: unknown[]) => { changes: number }
}
export interface CopyDb {
  prepare: (sql: string) => Stmt
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T
}

/** What was taken out for one desk. `files` are the byte files to delete as well. */
export interface RemovedDesk {
  rootId: string
  nodes: number
  widgets: number
  documents: number
  files: Array<{ id: string; ext: string }>
}

export type ReplaceOutcome =
  // The new version is in, and only the named desks' old rows went.
  | { ok: true; removed: RemovedDesk[]; imported: BundleImportResult }
  // Refused BEFORE anything was removed: the old copy is exactly as it was.
  | { ok: false; removed: null; reason: string }
  // Removed, then the import failed. The old rows are gone; nothing of the new
  // version is in. The caller must forget the link so the next visit unpacks
  // it from scratch rather than opening an empty desk.
  | { ok: false; removed: RemovedDesk[]; reason: string }

const CHUNK = 400

function tableExists(db: CopyDb, table: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as unknown[]).length > 0
  } catch {
    return false
  }
}

/** Rows of a `... IN (?, ?, ...)` query over `ids`, chunked for SQLite's variable limit. */
function selectIn<T>(db: CopyDb, sql: (marks: string) => string, ids: string[]): T[] {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    out.push(...(db.prepare(sql(slice.map(() => '?').join(', '))).all(...slice) as T[]))
  }
  return out
}

function runIn(db: CopyDb, sql: (marks: string) => string, ids: string[]): number {
  let changed = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    changed += db.prepare(sql(slice.map(() => '?').join(', '))).run(...slice).changes
  }
  return changed
}

/** Does this browser hold rows for the desk `rootId`? */
export function deskPresent(db: CopyDb, rootId: string): boolean {
  if (!rootId) return false
  return db.prepare('SELECT 1 AS here FROM nodes WHERE id = ?').get(rootId) !== undefined
}

/**
 * The top-level nodes in this browser's database: one per desk a link brought
 * (a visitor's copy has no workspace of its own). Trashed ones included -- a
 * trashed desk is still somebody's copy.
 */
export function rootDesks(db: CopyDb): string[] {
  return (db.prepare('SELECT id FROM nodes WHERE parent_id IS NULL').all() as Array<{ id: string }>).map((r) => r.id)
}

/** The desk and everything filed under it, parents before children. Trashed rows included. */
export function subtreeIds(db: CopyDb, rootId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT id, 0 FROM nodes WHERE id = ?
         UNION
         SELECT n.id, sub.depth + 1 FROM nodes n JOIN sub ON n.parent_id = sub.id
       )
       SELECT id FROM sub ORDER BY depth`
    )
    .all(rootId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * The rows that are this desk's and no other desk's.
 *
 * Nodes, widgets, links, tables, rows and layouts are filed under the desk, so
 * the subtree decides them. Documents and files are not filed anywhere: a
 * widget points at them. They belong to this desk only when no widget OUTSIDE
 * it points at them too -- a document two links' desks both show stays, so
 * that removing one link's desk never blanks a widget on another's.
 *
 * Which widget kinds hold document or file ids is deliberately not consulted:
 * a document or file is a candidate when ANY widget's content names its id,
 * and it is kept when any widget elsewhere does. Reading the kind would be one
 * more list to keep in step with deskBundle, and the cost of being kind-blind
 * is only ever keeping a row, never removing one in use.
 */
export function deskRows(db: CopyDb, rootId: string): {
  nodeIds: string[]
  widgetIds: string[]
  documentIds: string[]
  files: Array<{ id: string; ext: string }>
} {
  const nodeIds = subtreeIds(db, rootId)
  if (nodeIds.length === 0) return { nodeIds, widgetIds: [], documentIds: [], files: [] }
  const inDesk = new Set(nodeIds)
  const widgets = db.prepare('SELECT id, task_id, content FROM widgets').all() as Array<{
    id: string
    task_id: string
    content: string | null
  }>
  const mine = widgets.filter((w) => inDesk.has(w.task_id))
  const elsewhere = new Set<string>()
  for (const w of widgets) {
    if (inDesk.has(w.task_id)) continue
    const raw = (w.content ?? '').trim()
    if (raw) elsewhere.add(raw)
    const fid = fileIdFromContent(w.content)
    if (fid) elsewhere.add(fid)
  }
  const docCandidates = new Set<string>()
  const fileCandidates = new Set<string>()
  for (const w of mine) {
    const raw = (w.content ?? '').trim()
    if (raw && !elsewhere.has(raw)) docCandidates.add(raw)
    const fid = fileIdFromContent(w.content)
    if (fid && !elsewhere.has(fid)) fileCandidates.add(fid)
  }
  const documentIds = docCandidates.size
    ? selectIn<{ id: string }>(db, (m) => `SELECT id FROM documents WHERE id IN (${m})`, [...docCandidates]).map((r) => r.id)
    : []
  const files = fileCandidates.size
    ? selectIn<{ id: string; ext: string }>(db, (m) => `SELECT id, ext FROM fb_files WHERE id IN (${m})`, [...fileCandidates])
    : []
  return { nodeIds, widgetIds: mine.map((w) => w.id), documentIds, files }
}

/**
 * Take one desk's rows out, in one transaction: all of them or none.
 *
 * Children are explicit rather than left to ON DELETE CASCADE, because two of
 * them have no foreign key to cascade along (fb_tables.task_id and
 * desk_layouts.desk_id) -- left behind, a re-import would INSERT OR IGNORE
 * straight past them and show last version's tables under this version's desk.
 * The cascades that do exist (snapshots, clusters and the like) still fire.
 */
export function removeDeskRows(db: CopyDb, rootId: string): RemovedDesk {
  return db.transaction(() => {
    const rows = deskRows(db, rootId)
    const out: RemovedDesk = { rootId, nodes: 0, widgets: 0, documents: 0, files: rows.files }
    if (rows.nodeIds.length === 0) return out
    const nodes = rows.nodeIds
    const widgets = rows.widgetIds
    const tableIds = selectIn<{ id: string }>(db, (m) => `SELECT id FROM fb_tables WHERE task_id IN (${m})`, nodes).map((r) => r.id)
    runIn(db, (m) => `DELETE FROM fb_rows WHERE table_id IN (${m})`, tableIds)
    runIn(db, (m) => `DELETE FROM fb_tables WHERE id IN (${m})`, tableIds)
    if (tableExists(db, 'desk_layouts')) runIn(db, (m) => `DELETE FROM desk_layouts WHERE desk_id IN (${m})`, nodes)
    runIn(db, (m) => `DELETE FROM widget_links WHERE task_id IN (${m})`, nodes)
    // A link filed on another desk but reaching one of these widgets would
    // otherwise go by cascade without being counted; say it here instead.
    runIn(db, (m) => `DELETE FROM widget_links WHERE source_widget_id IN (${m})`, widgets)
    runIn(db, (m) => `DELETE FROM widget_links WHERE target_widget_id IN (${m})`, widgets)
    out.widgets = runIn(db, (m) => `DELETE FROM widgets WHERE id IN (${m})`, widgets)
    // share-copy-delete: one visitor's copy of one desk, leaves first (see the header).
    const del = db.prepare('DELETE FROM nodes WHERE id = ?')
    for (const id of [...nodes].reverse()) out.nodes += del.run(id).changes
    out.documents = runIn(db, (m) => `DELETE FROM documents WHERE id IN (${m})`, rows.documentIds)
    runIn(db, (m) => `DELETE FROM fb_files WHERE id IN (${m})`, rows.files.map((f) => f.id))
    return out
  })()
}

async function removeBytes(files: Array<{ id: string; ext: string }>): Promise<void> {
  for (const f of files) {
    try {
      await fileBlobs.remove(f.id, f.ext)
    } catch {
      /* an orphan file nothing points at; it costs space, not correctness */
    }
  }
}

/** Remove one desk and the file bytes only it used. */
export async function removeDesk(rootId: string): Promise<RemovedDesk> {
  const removed = removeDeskRows(getDb() as unknown as CopyDb, rootId)
  await removeBytes(removed.files)
  return removed
}

/**
 * Why this bundle cannot be unpacked, or null when it can.
 *
 * The same checks importDeskBundle makes, plus the one it can only make by
 * failing at COMMIT. Asked BEFORE anything is removed: a version that would
 * not import must leave the visitor's copy exactly as it was.
 */
export function cannotImport(bundle: DeskBundle | null | undefined): string | null {
  if (!bundle || typeof bundle !== 'object') return 'not a Plexii desk bundle'
  if (bundle.format !== DESK_BUNDLE_FORMAT) return 'not a Plexii desk bundle'
  if (bundle.formatVersion !== DESK_BUNDLE_VERSION) {
    return `unsupported bundle version ${bundle.formatVersion}; this build reads version ${DESK_BUNDLE_VERSION}`
  }
  const dangling = danglingReferences(bundle)
  if (dangling.length) return `${dangling.length} reference(s) point outside the desk: ${dangling.slice(0, 2).join('; ')}`
  return null
}

/**
 * Put a newer version of a link's desk in place of the old one.
 *
 * `rootIds` are the desks the old version occupies (normally one: the link's
 * desk). Each is removed, then the bundle is unpacked. Rows of OTHER desks are
 * not touched, and neither are documents or files another desk still points at
 * (deskRows). File bytes of removed files go too, except for files the new
 * version still lists: those bytes are the same file, and keeping them keeps a
 * picture the sender left out of the new bundle for size.
 */
export async function replaceDesk(rootIds: string[], bundle: DeskBundle): Promise<ReplaceOutcome> {
  const refused = cannotImport(bundle)
  if (refused) return { ok: false, removed: null, reason: refused }
  const db = getDb() as unknown as CopyDb
  const roots = [...new Set([...rootIds, bundle.desk?.id].filter((r): r is string => typeof r === 'string' && r !== ''))]
  const removed = roots.map((r) => removeDeskRows(db, r))
  const stillListed = new Set((bundle.tables?.fb_files ?? []).map((f) => String(f.id)))
  await removeBytes(removed.flatMap((r) => r.files).filter((f) => !stillListed.has(f.id)))
  const imported = await importDeskBundle(bundle)
  if (!imported.ok) return { ok: false, removed, reason: imported.reason ?? 'the new version could not be unpacked' }
  return { ok: true, removed, imported }
}

type Handler = (...args: never[]) => unknown
const h = (fn: (...a: never[]) => unknown): Handler => fn

/**
 * The share page's own channels. Served by the Worker alongside HANDLERS, but
 * kept out of that table on purpose: HANDLERS mirrors the desktop's IPC
 * channels one for one (tests/unit/webHandlerChannels.test.ts), and these have
 * no desktop counterpart.
 */
export const SHARE_COPY_HANDLERS: Record<string, Handler> = {
  'shareCopy:deskPresent': h((rootId: string) => deskPresent(getDb() as unknown as CopyDb, String(rootId ?? ''))),
  'shareCopy:rootDesks': h(() => rootDesks(getDb() as unknown as CopyDb)),
  'shareCopy:removeDesk': h((rootId: string) => removeDesk(String(rootId ?? ''))),
  'shareCopy:replaceDesk': h((rootIds: string[], bundle: DeskBundle) =>
    replaceDesk(Array.isArray(rootIds) ? rootIds.map(String) : [], bundle))
}
