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
import { storageMode } from './database'
import {
  buildDeskBundle, importDeskBundle, danglingReferences, fileIdFromContent, fromBase64, DESK_BUNDLE_FORMAT, DESK_BUNDLE_VERSION,
  type DeskBundle, type BundleImportResult
} from '../../main/db/deskBundle'
import { fileBlobs } from '../../main/db/fileBlobs'
import { ensureDeskLayoutSchema } from '../../main/db/deskLayoutStore'
import { sitePictureId, readPresentation, VISITOR_LAYOUT_USER } from '../../shared/sitePresentation'
import type { BundledSitePicture } from '../../shared/sitePresentation'

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
  /**
   * The website pictures the desk's widgets may have (sitePresentation.ts),
   * deleted with it. Named from the widgets, so a widget that never had one
   * names a file that is not there, which removing ignores.
   */
  pictures: Array<{ id: string; ext: string }>
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
  pictures: Array<{ id: string; ext: string }>
} {
  const nodeIds = subtreeIds(db, rootId)
  if (nodeIds.length === 0) return { nodeIds, widgetIds: [], documentIds: [], files: [], pictures: [] }
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
  // Website pictures (sitePresentation.ts) are named after their widget, not
  // pointed at from it, so they are this desk's exactly when the widget is.
  const pictures: Array<{ id: string; ext: string }> = []
  for (const w of mine) {
    const pic = sitePictureId(w.id)
    if (pic) pictures.push({ id: pic, ext: SITE_PICTURE_EXT })
  }
  return { nodeIds, widgetIds: mine.map((w) => w.id), documentIds, files, pictures }
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
    const out: RemovedDesk = { rootId, nodes: 0, widgets: 0, documents: 0, files: rows.files, pictures: rows.pictures }
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
  await removeBytes([...removed.files, ...removed.pictures])
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
  // Pictures always go: the new version brings its own (adoptPresentation).
  await removeBytes(removed.flatMap((r) => r.pictures))
  layoutTableFirst(db)
  const imported = await importDeskBundle(bundle)
  if (!imported.ok) return { ok: false, removed, reason: imported.reason ?? 'the new version could not be unpacked' }
  await adoptPresentation(db, bundle)
  return { ok: true, removed, imported }
}

// ── What a link carries beyond rows: the sender's presentation ─────────────

/** Website pictures are always JPEGs (main/sitePreview.ts encodes them). */
export const SITE_PICTURE_EXT = '.jpg'

/** What adoptPresentation did, for the page and for tests. */
export interface AdoptedPresentation {
  pictures: number
  layouts: number
}

/**
 * Make a freshly unpacked desk look the way its sender shared it.
 *
 * Two things the rows alone do not do:
 *
 *   - Website pictures travel inside the presentation, not as Drive files (they
 *     are not the sender's files and must not appear as the visitor's). Each is
 *     written to the file store under the id derived from its widget, where the
 *     share page's file server serves it -- and only for a widget this bundle
 *     brings, as a JPEG, within the size a picture is ever packed at.
 *   - Layouts are stored per account (desk_layouts.user_id) and the visitor has
 *     none, so the sender's row would never be read: the workcentre came up
 *     auto-arranged, with the tiles the sender hid showing. The sender's row is
 *     copied to the visitor's id -- the arrangement, never the sender's camera:
 *     the canvas opens at the top-left of the desk's content instead of wherever
 *     the sender last scrolled.
 */
export async function adoptPresentation(db: CopyDb, bundle: DeskBundle): Promise<AdoptedPresentation> {
  const out: AdoptedPresentation = { pictures: 0, layouts: 0 }
  const widgets = (bundle.tables?.widgets ?? []) as Array<Record<string, unknown>>
  const widgetIds = new Set(widgets.map((w) => String(w.id)))
  const raw = (bundle as { presentation?: { sites?: Record<string, { picture?: BundledSitePicture }>; layoutUserId?: unknown } })
    .presentation
  const presentation = readPresentation(raw, widgetIds)

  for (const [wid, site] of Object.entries(presentation?.sites ?? {})) {
    if (site.show !== 'picture' || !site.picture) continue
    const data = raw?.sites?.[wid]?.picture?.data
    if (typeof data !== 'string' || data.length > MAX_PICTURE_BASE64) continue
    let bytes: Uint8Array
    try {
      bytes = fromBase64(data)
    } catch {
      continue
    }
    // A JPEG starts FF D8 FF. Anything else is not what a picture entry means.
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) continue
    try {
      await fileBlobs.write(site.picture.id, SITE_PICTURE_EXT, bytes)
      out.pictures++
    } catch {
      /* the widget shows its link card instead */
    }
  }

  if (tableExists(db, 'desk_layouts')) {
    const rows = (bundle.tables?.desk_layouts ?? []) as Array<Record<string, unknown>>
    const sender = typeof raw?.layoutUserId === 'string' ? raw.layoutUserId : null
    // One row per desk and device class: the sender's when the bundle says
    // whose that is, otherwise the most recently saved.
    const better = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
      if (sender !== null && (a.user_id === sender) !== (b.user_id === sender)) return a.user_id === sender
      return String(a.updated_at ?? '') > String(b.updated_at ?? '')
    }
    const chosen = new Map<string, Record<string, unknown>>()
    for (const r of rows) {
      const key = `${String(r.desk_id)}\n${String(r.device_class)}`
      const have = chosen.get(key)
      if (!have || better(r, have)) chosen.set(key, r)
    }
    // REPLACE, not IGNORE: this runs straight after the desk was unpacked (a
    // replacement removes the desk's layout rows first), so a visitor row for it
    // can only have come from the bundle -- a sender who once used the app
    // signed out carries a stale 'local' row, which must not win.
    const insert = db.prepare(
      `INSERT OR REPLACE INTO desk_layouts (user_id, desk_id, device_class, layout_json, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    for (const r of chosen.values()) {
      let layout: Record<string, unknown>
      try {
        layout = JSON.parse(String(r.layout_json)) as Record<string, unknown>
      } catch {
        continue
      }
      if (!layout || typeof layout !== 'object') continue
      const deskId = String(r.desk_id)
      const visitor = {
        ...layout,
        userId: VISITOR_LAYOUT_USER,
        deskId,
        scroll: contentTopLeft(widgets, deskId),
        zoom: 1,
        selectedObjectIds: []
      }
      out.layouts += insert.run(VISITOR_LAYOUT_USER, deskId, String(r.device_class), JSON.stringify(visitor), String(r.updated_at ?? new Date().toISOString())).changes
    }
  }
  return out
}

/** A picture is packed at most MAX_SITE_PICTURE_BYTES; base64 of that, with room to spare. */
const MAX_PICTURE_BASE64 = 1024 * 1024

/**
 * The camera that puts the top-left of a desk's content near the top-left of
 * the screen: the visitor's first look lands on the desk, not on empty canvas.
 */
function contentTopLeft(widgets: Array<Record<string, unknown>>, deskId: string): { x: number; y: number } {
  let minX = Infinity
  let minY = Infinity
  for (const w of widgets) {
    if (String(w.task_id) !== deskId || w.parent_section_id || w.trashed_at || w.pinned === 1) continue
    const x = Number(w.x)
    const y = Number(w.y)
    if (Number.isFinite(x)) minX = Math.min(minX, x)
    if (Number.isFinite(y)) minY = Math.min(minY, y)
  }
  const MARGIN = 40
  return {
    x: Number.isFinite(minX) ? Math.round(MARGIN - minX) : 0,
    y: Number.isFinite(minY) ? Math.round(MARGIN - minY) : 0
  }
}

/**
 * Unpack a link's desk into a browser that does not have it yet, presentation
 * and all. The desktop's own channel (shares:importBundle) stays the plain
 * import: a desk file opened on the desktop has no visitor to present to.
 */
export async function importDeskForShare(bundle: DeskBundle): Promise<BundleImportResult> {
  const db = getDb() as unknown as CopyDb
  layoutTableFirst(db)
  const imported = await importDeskBundle(bundle)
  if (imported.ok) await adoptPresentation(db, bundle)
  return imported
}

/**
 * desk_layouts is created on first use (deskLayoutStore), not with the rest of
 * the schema -- and importDeskBundle skips a table that does not exist. On a
 * visitor's first visit nothing has used it yet, so every layout the bundle
 * carried was dropped on the floor: the sender's Workcentre never arrived.
 * Created before the import so the rows have somewhere to go.
 */
function layoutTableFirst(db: CopyDb): void {
  ensureDeskLayoutSchema(db as unknown as Parameters<typeof ensureDeskLayoutSchema>[0])
}

/**
 * Make every row in this browser the visitor's own, unshared workspace.
 *
 * A desk in a TEAM workspace travels with its team's org id on every row
 * (nodes, tables, documents, files…). The app lists only the active
 * workspace's rows -- for a visitor, 'personal' -- so such a desk was
 * imported in full and then filtered out of sight: the page opened on the
 * app's Home with no desk at all (measured 2026-11-07 on the owner's live
 * "Lesson Planning" link, org_777a…). This database only ever holds visitors'
 * copies of shared desks (the share page has no workspace of its own), so
 * re-homing all of it is safe, and running it at every open also repairs
 * copies unpacked before this existed. Returns how many rows moved.
 */
export function adoptVisitorScope(db: CopyDb): number {
  let moved = 0
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  for (const { name } of tables) {
    let cols: string[]
    try {
      cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((c) => c.name)
    } catch {
      continue
    }
    if (!cols.includes('org_id')) continue
    const team = cols.includes('team_id') ? ', team_id = NULL' : ''
    try {
      moved += db.prepare(`UPDATE "${name}" SET org_id = 'personal'${team} WHERE org_id IS NOT NULL AND org_id <> 'personal'`).run().changes
    } catch {
      /* a table this build cannot write: left as it is */
    }
  }
  return moved
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
    replaceDesk(Array.isArray(rootIds) ? rootIds.map(String) : [], bundle)),
  'shareCopy:importDesk': h((bundle: DeskBundle) => importDeskForShare(bundle)),
  // Durable (OPFS) or this page only (memory): decides what the page promises.
  'shareCopy:storageMode': h(() => storageMode()),
  // Every row the visitor's own workspace's, so a team desk is not hidden.
  'shareCopy:adoptVisitorScope': h(() => adoptVisitorScope(getDb() as unknown as CopyDb)),
  // "Download this desk on Plexii": the visitor's copy, as it is now (with what
  // they dragged onto it), packed the way the desktop packs a link -- the same
  // builder and the same size budget Signal accepts -- to be handed to the app
  // (shared/deskHandoff.ts).
  'shareCopy:exportDesk': h(async (rootId: string) => JSON.stringify(await buildDeskBundle(String(rootId ?? ''))))
}
