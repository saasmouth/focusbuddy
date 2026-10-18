// Widget files — the main-process store. See docs/widget-files.md.
//
// A widget file is a `documents` row with doc_type 'widget'; this module is the
// only writer of that body shape. Its desk placements are ordinary widgets in
// the sync group `wf:<file id>`, and the two directions of propagation live
// here so neither re-enters the other:
//
//   file → instances   updateWidgetFile() writes the document, then the widgets
//   instance → file    syncWidgetFileFromInstance(), called by updateWidget()
//                      after its own fan-out to the other copies
//
// Both are direct DB writes, as the existing linked-duplicate fan-out is.

import { createHash } from 'crypto'
import { getDb } from './database'
import { getActiveOrgId } from './activeOrg'
import { createDocument, getDocument, trashDocument } from './documents'
import { fileDocument } from './files'
import { createTable, createRow, getTable, listRows } from './tables'
// A deliberate import cycle (widgets.ts calls syncWidgetFileFromInstance):
// both sides only call each other at runtime, never at module init.
import { createWidget, getWidget } from './widgets'
import { isUntitled } from '@shared/titles'
import {
  buildWidgetFileExport,
  defaultWidgetFileContent,
  deriveWidgetFileTitle,
  isPlaceholderWidgetFileTitle,
  isStandaloneWidgetKind,
  meaningfulWidgetTitle,
  makeWidgetFileBody,
  parseWidgetFileBody,
  placeholderWidgetFileTitle,
  WIDGET_FILE_TYPES,
  widgetFileGroupId,
  widgetFileIdFromGroup,
  type WidgetFileExport,
  type WidgetFilePlacement
} from '@shared/widgetFiles'
import type {
  FbDocument,
  Widget,
  WidgetDraft,
  WidgetFile,
  WidgetFileBody,
  WidgetFileDesk,
  WidgetFileDraft,
  WidgetFilePatch,
  WidgetFileTitleSource,
  WidgetKind
} from '@shared/types'
import type { WidgetTextResolvers } from '@shared/widgetText'

// ── Side effects kept out of the db layer's static imports ─────────────────
// Same discipline as db/widgets.ts pokeChunkIndex: the retrieval layer is
// imported lazily so this module never gains a static dependency on it.

function reindexFile(id: string): void {
  void import('../documentRetrieval')
    .then((m) => m.embedDocument(id))
    .catch(() => {})
}

function reindexWidget(widgetId: string): void {
  void import('../chunkIndex')
    .then((m) => m.reindexWidgetChunks(widgetId))
    .catch(() => {})
}

let resolverFactory: (() => WidgetTextResolvers) | null = null
/** Lets main/index wire the DB-backed resolvers without a static import cycle. */
export function setWidgetFileResolvers(factory: () => WidgetTextResolvers): void {
  resolverFactory = factory
}
function resolvers(): WidgetTextResolvers {
  try {
    return resolverFactory ? resolverFactory() : tableOnlyResolvers()
  } catch {
    return tableOnlyResolvers()
  }
}
// Enough to name and read a table or chart even before index.ts wires the full
// set (and in unit tests, which never boot index.ts).
function tableOnlyResolvers(): WidgetTextResolvers {
  return {
    table: (id) => {
      const t = getTable(id)
      if (!t) return null
      return {
        title: t.title,
        columns: t.schema.columns.map((c) => ({ id: c.id, label: c.label, type: c.type })),
        rows: listRows(id).map((r) => r.cells)
      }
    }
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

export function widgetFileFromDocument(doc: FbDocument): WidgetFile | null {
  if (doc.docType !== 'widget') return null
  const body = parseWidgetFileBody(doc.body)
  if (!body) return null
  return {
    id: doc.id,
    kind: body.kind,
    title: doc.title,
    titleSource: body.titleSource,
    content: body.content,
    color: body.color,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    orgId: doc.orgId
  }
}

export function getWidgetFile(id: string): WidgetFile | null {
  const doc = getDocument(id)
  const file = doc ? widgetFileFromDocument(doc) : null
  if (file && isTrashed(id)) file.trashed = true
  return file
}

function isTrashed(id: string): boolean {
  const row = getDb().prepare('SELECT trashed_at FROM documents WHERE id = ?').get(id) as
    | { trashed_at: number | null }
    | undefined
  return !row || row.trashed_at !== null
}

/** Live widget files in the active org, newest-edited first. */
export function listWidgetFiles(): WidgetFile[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM documents
       WHERE doc_type = 'widget' AND archived = 0 AND trashed_at IS NULL AND org_id = ?
       ORDER BY updated_at DESC`
    )
    .all(getActiveOrgId()) as Array<{ id: string }>
  const out: WidgetFile[] = []
  for (const r of rows) {
    const f = getWidgetFile(r.id)
    if (f) out.push(f)
  }
  return out
}

/** The desk instances of a file (live ones), for "placed on" and fan-out. */
export function listWidgetFileInstances(fileId: string): Widget[] {
  const rows = getDb()
    .prepare('SELECT id FROM widgets WHERE sync_group_id = ? AND trashed_at IS NULL')
    .all(widgetFileGroupId(fileId)) as Array<{ id: string }>
  return rows.map((r) => getWidget(r.id)).filter((w): w is Widget => !!w)
}

/**
 * The desks each of these files sits on (live instances on live desks), by
 * file id, desks sorted by name. One query for a whole Files listing, so the
 * "All work widgets" view can say where each one lives without asking per row.
 * A file on no desk maps to an empty list.
 */
export function listWidgetFilePlacements(fileIds: readonly string[]): Record<string, WidgetFileDesk[]> {
  const out: Record<string, WidgetFileDesk[]> = {}
  const ids = [...new Set(fileIds.filter((id) => typeof id === 'string' && id))]
  for (const id of ids) out[id] = []
  if (ids.length === 0) return out
  const db = getDb()
  // SQLite's default variable limit is 999; chunk well under it.
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400)
    const rows = db
      .prepare(
        `SELECT DISTINCT w.sync_group_id AS sgid, n.id AS deskId, n.title AS deskTitle
           FROM widgets w JOIN nodes n ON n.id = w.task_id
          WHERE w.sync_group_id IN (${chunk.map(() => '?').join(',')})
            AND w.trashed_at IS NULL AND n.trashed_at IS NULL`
      )
      .all(...chunk.map((id) => widgetFileGroupId(id))) as Array<{ sgid: string; deskId: string; deskTitle: string }>
    for (const r of rows) {
      const fileId = widgetFileIdFromGroup(r.sgid)
      if (fileId && out[fileId]) out[fileId].push({ deskId: r.deskId, deskTitle: r.deskTitle || 'Untitled desk' })
    }
  }
  for (const id of ids) out[id].sort((a, b) => a.deskTitle.localeCompare(b.deskTitle))
  return out
}

// ── Writing ─────────────────────────────────────────────────────────────────

function writeDoc(id: string, title: string, body: WidgetFileBody): void {
  getDb()
    .prepare('UPDATE documents SET title = @title, body = @body, updated_at = @now WHERE id = @id')
    .run({ id, title, body: JSON.stringify(body), now: Date.now() })
}

/** Push synced fields to every desk instance except `exceptId`. */
function fanOutToInstances(
  fileId: string,
  fields: { content?: string; title?: string; color?: string | null },
  exceptId: string | null = null
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { sgid: widgetFileGroupId(fileId), except: exceptId ?? '', now: Date.now() }
  if (fields.content !== undefined) {
    sets.push('content = @content')
    params.content = fields.content
  }
  if (fields.title !== undefined) {
    sets.push('title = @title')
    params.title = fields.title
  }
  if (fields.color !== undefined) {
    sets.push('color = @color')
    params.color = fields.color
  }
  if (sets.length === 0) return
  sets.push('updated_at = @now')
  const db = getDb()
  db.prepare(`UPDATE widgets SET ${sets.join(', ')} WHERE sync_group_id = @sgid AND id != @except`).run(params)
  if (fields.content !== undefined || fields.title !== undefined) {
    const ids = db
      .prepare('SELECT id FROM widgets WHERE sync_group_id = ? AND id != ?')
      .all(widgetFileGroupId(fileId), exceptId ?? '') as Array<{ id: string }>
    for (const r of ids) reindexWidget(r.id)
  }
}

/** Name a new file: chosen title, else its content, else a dated placeholder. */
function initialTitle(
  kind: WidgetKind,
  content: string,
  chosen: string | undefined
): { title: string; source: WidgetFileTitleSource } {
  const given = (chosen ?? '').trim()
  if (given && !isUntitled(given)) return { title: given.slice(0, 200), source: 'user' }
  const derived = safeDerive(kind, content)
  if (derived) return { title: derived, source: 'derived' }
  return { title: placeholderWidgetFileTitle(kind), source: 'placeholder' }
}

function safeDerive(kind: WidgetKind, content: string): string | null {
  try {
    return deriveWidgetFileTitle(kind, content, resolvers())
  } catch {
    return null
  }
}

export interface CreateWidgetFileOptions {
  /** Default content for the kind (the catalogue's), when the draft has none. */
  defaultContent?: string
  /** Set by "Save as file" so a widget's own name is kept as a user name. */
  titleSource?: WidgetFileTitleSource
  /** Skip filing into Files (imports file themselves). */
  noFile?: boolean
  /**
   * Made to be placed on a desk straight away (the side-menu drag, "Add to
   * this desk", the palette's "Add … to desk"). Only changes the empty default
   * of a task list: on a desk it is a lens over that desk's tasks, the same as
   * one added from the canvas, so desk subtasks keep showing.
   */
  placement?: WidgetFilePlacement
}

export function createWidgetFile(draft: WidgetFileDraft, opts: CreateWidgetFileOptions = {}): WidgetFile {
  if (!isStandaloneWidgetKind(draft.kind)) {
    throw new Error(`A ${draft.kind} work widget only works on a desk, so it cannot be a file.`)
  }
  const content =
    draft.content !== undefined
      ? draft.content
      : defaultWidgetFileContent(draft.kind, opts.defaultContent ?? '', opts.placement ?? 'none')
  const named = initialTitle(draft.kind, content, draft.title)
  const source = opts.titleSource && draft.title && !isUntitled(draft.title) ? opts.titleSource : named.source
  const doc = createDocument({
    docType: 'widget',
    title: named.title,
    body: makeWidgetFileBody(
      draft.kind,
      content,
      draft.color !== undefined ? draft.color : draft.kind === 'sticky' ? '#fef08a' : null,
      source
    )
  })
  // A file nobody can find is not a file: it goes into Files straight away,
  // at the root unless a folder was named.
  if (!opts.noFile) {
    try {
      fileDocument(doc.id, draft.parentId ?? null)
    } catch {
      /* Files self-heals unfiled widget files on the next root listing */
    }
  }
  reindexFile(doc.id)
  return widgetFileFromDocument(getDocument(doc.id)!)!
}

/**
 * Apply a patch to a file and to every desk instance of it.
 *
 * A title in the patch is a rename by a person and makes the name theirs. A
 * content change while the name is still a placeholder tries to name the file
 * from what it now holds — once: after that the name is left alone.
 */
export function updateWidgetFile(
  id: string,
  patch: WidgetFilePatch,
  opts: { fromInstanceId?: string | null } = {}
): WidgetFile | null {
  const file = getWidgetFile(id)
  if (!file) return null
  let title = file.title
  let titleSource = file.titleSource
  const content = patch.content !== undefined ? patch.content : file.content
  const color = patch.color !== undefined ? patch.color : file.color
  let titleChanged = false
  // A patch that only re-sends the current name is not a rename: widget code
  // writes `{ content, title: widget.title }` together (a table provisioning
  // its backing table did), and treating that as the user's name froze a
  // placeholder for good. Likewise a blank, "Untitled" or placeholder-shaped
  // title echoed back from an instance is not a name anyone chose.
  const renamed = patch.title !== undefined ? patch.title.trim() : ''
  const isRename =
    !!renamed && renamed !== file.title && !isUntitled(renamed) && !isPlaceholderWidgetFileTitle(renamed)
  if (isRename) {
    title = renamed.slice(0, 200)
    titleSource = 'user'
    titleChanged = title !== file.title
  } else if (patch.content !== undefined && titleSource === 'placeholder') {
    const derived = safeDerive(file.kind, content)
    if (derived && derived !== title) {
      title = derived
      titleSource = 'derived'
      titleChanged = true
    }
  }
  writeDoc(id, title, makeWidgetFileBody(file.kind, content, color, titleSource))
  // The instance that originated the edit already holds the content (and its
  // own fan-out reached its siblings), so it is skipped for content — but a
  // title this function just derived is new to every instance, it included.
  const fromInstance = opts.fromInstanceId ?? null
  if (fromInstance) {
    if (titleChanged) fanOutToInstances(id, { title }, null)
  } else {
    fanOutToInstances(id, {
      content: patch.content,
      color: patch.color,
      title: titleChanged ? title : undefined
    })
  }
  reindexFile(id)
  return getWidgetFile(id)
}

/**
 * The instance → file half of the link. Called by db/widgets.updateWidget after
 * it has mirrored the patch to the other widgets in the group.
 */
export function syncWidgetFileFromInstance(
  syncGroupId: string,
  instanceId: string,
  patch: { content?: string; title?: string; color?: string | null }
): void {
  const fileId = widgetFileIdFromGroup(syncGroupId)
  if (!fileId) return
  if (patch.content === undefined && patch.title === undefined && patch.color === undefined) return
  if (!getWidgetFile(fileId)) return
  updateWidgetFile(fileId, patch, { fromInstanceId: instanceId })
}

/** Set a title chosen by the naming pass. Never overrides a user's name. */
export function setWidgetFileTitle(id: string, title: string, source: 'derived' | 'model'): boolean {
  const file = getWidgetFile(id)
  if (!file || file.titleSource === 'user') return false
  const next = title.trim()
  if (!next || isUntitled(next)) return false
  writeDoc(id, next, makeWidgetFileBody(file.kind, file.content, file.color, source))
  fanOutToInstances(id, { title: next })
  reindexFile(id)
  return true
}

// ── Tables behind table files ───────────────────────────────────────────────
// A table file's content is only a table id; its words live in fb_rows. So a
// row edit changes what the file SAYS without touching the file — which would
// leave the index reading stale rows and a placeholder name waiting for a
// launch. Row and schema writes call this; coalesced per table, because a
// person typing in a cell writes on every keystroke.

const pendingTables = new Map<string, ReturnType<typeof setTimeout>>()

export function onTableChanged(tableId: string | null | undefined, delayMs = 1500): void {
  if (!tableId) return
  const prev = pendingTables.get(tableId)
  if (prev) clearTimeout(prev)
  pendingTables.set(
    tableId,
    setTimeout(() => {
      pendingTables.delete(tableId)
      try {
        refreshTableFiles(tableId)
      } catch {
        /* best-effort: the launch pass and the next edit catch up */
      }
    }, delayMs)
  )
}

/** Re-index (and, while still placeholder-named, name) the files over a table. */
export function refreshTableFiles(tableId: string): number {
  const rows = getDb()
    .prepare(
      `SELECT id FROM documents
       WHERE doc_type = 'widget' AND trashed_at IS NULL
         -- CASE, not AND: SQLite does not promise to short-circuit, and
         -- json_extract on malformed JSON raises rather than returning NULL.
         AND CASE
           WHEN NOT json_valid(body) THEN 0
           WHEN json_extract(body, '$.kind') = 'table' THEN json_extract(body, '$.content') = @t
           -- a chart file reads the same rows, so what it says changes with them
           WHEN json_extract(body, '$.kind') = 'chart' THEN
             CASE WHEN json_valid(json_extract(body, '$.content'))
               THEN json_extract(json_extract(body, '$.content'), '$.tableId') = @t
               ELSE 0 END
           ELSE 0
         END`
    )
    .all({ t: tableId }) as Array<{ id: string }>
  for (const r of rows) {
    const f = getWidgetFile(r.id)
    if (!f) continue
    // A table file's derived name carries its row count ("Supplier · 12
    // rows"), so it is re-derived as rows come and go — but only while the name
    // is ours (placeholder or derived). A name the user typed is never touched.
    if (f.kind === 'table' && (f.titleSource === 'placeholder' || f.titleSource === 'derived')) {
      const derived = safeDerive(f.kind, f.content)
      if (derived && derived !== f.title) {
        setWidgetFileTitle(f.id, derived, 'derived')
        continue // setWidgetFileTitle reindexes
      }
    } else if (f.titleSource === 'placeholder') {
      const derived = safeDerive(f.kind, f.content)
      if (derived) {
        setWidgetFileTitle(f.id, derived, 'derived')
        continue
      }
    }
    reindexFile(f.id)
  }
  return rows.length
}

// ── Placement ───────────────────────────────────────────────────────────────

export interface PlacementDraft {
  taskId: string
  x?: number
  y?: number
  width?: number
  height?: number
}

/** A desk instance of a file: an ordinary widget in the file's sync group. */
export function instanceDraftFor(file: WidgetFile, at: PlacementDraft): WidgetDraft {
  return {
    taskId: at.taskId,
    kind: file.kind,
    title: file.title,
    content: file.content,
    x: at.x,
    y: at.y,
    width: at.width,
    height: at.height,
    color: file.color,
    syncGroupId: widgetFileGroupId(file.id)
  }
}

export function placeWidgetFile(id: string, at: PlacementDraft): Widget | null {
  const file = getWidgetFile(id)
  if (!file || isTrashed(id)) return null
  return createWidget(instanceDraftFor(file, at))
}

/**
 * A NEW file placed on a desk in one step: the side-menu drag, "Add to this
 * desk", the palette's "Add … to desk". Placed on a desk, so a task list starts
 * as that desk's tasks (`placement: 'desk'`), exactly like one added from the
 * canvas. The desktop IPC and the web worker both call this.
 */
export function createAndPlaceWidgetFile(
  draft: WidgetFileDraft,
  at: PlacementDraft,
  opts: { defaultContent?: string } = {}
): { file: WidgetFile; widget: Widget | null } {
  const file = createWidgetFile(draft, { defaultContent: opts.defaultContent, placement: 'desk' })
  return { file, widget: placeWidgetFile(file.id, at) }
}

/**
 * "Save as file": turn a desk widget into a widget file and link it (and any
 * synced copies it already had) to the new file. Idempotent: a widget that is
 * already an instance returns its file.
 */
export function promoteWidgetToFile(widgetId: string): WidgetFile | null {
  const w = getWidget(widgetId)
  if (!w) return null
  const existing = widgetFileIdFromGroup(w.syncGroupId)
  if (existing) {
    const f = getWidgetFile(existing)
    if (f && !isTrashed(existing)) return f
  }
  if (!isStandaloneWidgetKind(w.kind)) return null
  const file = createWidgetFile(
    { kind: w.kind, title: w.title, content: w.content, color: w.color },
    { titleSource: 'user' }
  )
  const db = getDb()
  const sgid = widgetFileGroupId(file.id)
  if (w.syncGroupId) {
    db.prepare('UPDATE widgets SET sync_group_id = ?, updated_at = ? WHERE sync_group_id = ?').run(
      sgid,
      Date.now(),
      w.syncGroupId
    )
  }
  db.prepare('UPDATE widgets SET sync_group_id = ?, updated_at = ? WHERE id = ?').run(sgid, Date.now(), w.id)
  // The file took the widget's title as-is; when that was blank, let the
  // instances share the name the file was given.
  if (isUntitled(w.title)) fanOutToInstances(file.id, { title: file.title })
  return getWidgetFile(file.id)
}

// ── Every work widget is a file ─────────────────────────────────────────────
// The owner's rule (4.3.32): a work widget is a file in its own right; a desk
// is only where it is placed. So every widget of a standalone kind on a desk
// is an instance of a widget file — not only the ones made from the side menu.
// db/widgets.createWidget calls adoptWidgetAsFile for every locally born
// widget, and the launch backfill below does the same for what already exists.
// docs/widget-files.md, "Every work widget is a file", is the contract.

const FILE_ID_NAMESPACE = 'plexii.widget-file'

/**
 * A file id derived from what it is the file OF, so two devices converting the
 * same synced desk mint the same document id and sync merges them instead of
 * filing everything twice. Shaped like a v5 UUID, as every other id is a UUID.
 */
export function widgetFileIdForSeed(seed: string): string {
  const h = createHash('sha1').update(`${FILE_ID_NAMESPACE}:${seed}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
/** The file a lone desk widget becomes. */
export const widgetFileIdForWidget = (widgetId: string): string => widgetFileIdForSeed(`widget:${widgetId}`)
/** The one file a whole linked-duplicate group becomes. */
export const widgetFileIdForGroup = (syncGroupId: string): string => widgetFileIdForSeed(`group:${syncGroupId}`)

/**
 * Whether widgets on this desk may become files, and in which workspace.
 *
 * Only a desk in the user's own workspace. A desk shared with named people
 * (shared_root_id, either direction) syncs on the per-desk path, which never
 * carries documents — a file made there would exist for one person only, and
 * each member converting the same widget would mint their own. A desk that
 * arrived as a share from someone else (shared_from_handle) is theirs. Null
 * for both, and for a desk that does not exist.
 */
export function deskFileScope(taskId: string): { orgId: string } | null {
  const db = getDb()
  let row: { org_id?: string | null; shared_root_id?: string | null; shared_from_handle?: string | null } | undefined
  try {
    row = db.prepare('SELECT org_id, shared_root_id, shared_from_handle FROM nodes WHERE id = ?').get(taskId) as
      | typeof row
      | undefined
  } catch {
    // A schema without the sharing columns has no shared desks.
    row = db.prepare('SELECT id FROM nodes WHERE id = ?').get(taskId) as typeof row
  }
  if (!row) return null
  if (row.shared_root_id || row.shared_from_handle) return null
  return { orgId: row.org_id || getActiveOrgId() }
}

/** The kind's own words, which a menu stamps on a new widget and nobody chose. */
function kindLabels(kind: WidgetKind): string[] {
  return [kind.replace(/-/g, ' ')]
}

interface FileSource {
  kind: WidgetKind
  title: string
  content: string
  color: string | null
  createdAt: number
}

/**
 * Create the file a desk widget (or group) becomes, under a known id. When a
 * document with that id already exists — another device converted the same
 * desk and it synced first, or an earlier run got this far — it is reused
 * as-is: the id is the agreement, and the first writer's name stands.
 */
function createFileUnderId(
  fileId: string,
  src: FileSource,
  scope: { orgId: string },
  opts: { reindex: boolean }
): { file: WidgetFile; created: boolean } | null {
  const existing = getDocument(fileId)
  if (existing) {
    const f = widgetFileFromDocument(existing)
    return f ? { file: f, created: false } : null
  }
  const kept = meaningfulWidgetTitle(src.kind, src.title, kindLabels(src.kind))
  let title: string
  let source: WidgetFileTitleSource
  if (kept) {
    title = kept
    source = 'user'
  } else {
    const derived = safeDerive(src.kind, src.content)
    if (derived) {
      title = derived
      source = 'derived'
    } else {
      // Dated by when the WIDGET was made, not by this run: findable among the
      // user's own chronology, and the same string on every device.
      title = placeholderWidgetFileTitle(src.kind, new Date(src.createdAt || Date.now()))
      source = 'placeholder'
    }
  }
  createDocument({
    id: fileId,
    docType: 'widget',
    title,
    body: makeWidgetFileBody(src.kind, src.content, src.color, source)
  })
  // The workspace is the desk's, whichever one is active right now, and the
  // file is as old as the widget it was.
  getDb()
    .prepare('UPDATE documents SET org_id = ?, created_at = ? WHERE id = ?')
    .run(scope.orgId, src.createdAt || Date.now(), fileId)
  // Into Files at the root (the convention every widget file follows). A file
  // in another workspace is filed when that workspace is next listed —
  // ensureWidgetFilesFiled runs per active org and pointers do not sync.
  if (scope.orgId === getActiveOrgId()) {
    try {
      fileDocument(fileId, null)
    } catch {
      /* the root listing self-heals */
    }
  }
  if (opts.reindex) reindexFile(fileId)
  const file = getWidgetFile(fileId)
  return file ? { file, created: true } : null
}

export interface AdoptOptions {
  /** Re-index the new file now. The backfill does it once, at the end. */
  reindex?: boolean
  /**
   * Which name the instances take when they have none of their own:
   * 'always' — the file's, placeholder included, exactly as a side-menu
   *   placement does (new widgets);
   * 'named' — only a real name (derived or the user's), so converting a
   *   workspace does not stamp a date on every untitled sticky (backfill).
   */
  instanceTitle?: 'always' | 'named'
}

/**
 * Make a desk widget an instance of a widget file, if it should be one.
 *
 * - a desk-only kind, an existing instance, or a widget on a desk outside the
 *   user's own workspace: untouched, returns null;
 * - a lone widget: a new file under widgetFileIdForWidget(id), and the widget
 *   joins its group;
 * - a member of an ordinary linked-duplicate group: the whole group becomes
 *   ONE file under widgetFileIdForGroup(group), shared by every member.
 *
 * Returns the widget as it now is, or null when nothing changed. Idempotent.
 */
export function adoptWidgetAsFile(widgetId: string, opts: AdoptOptions = {}): Widget | null {
  const w = getWidget(widgetId)
  if (!w) return null
  if (!isStandaloneWidgetKind(w.kind)) return null
  if (widgetFileIdFromGroup(w.syncGroupId)) return null
  const scope = deskFileScope(w.taskId)
  if (!scope) return null
  const db = getDb()
  const now = Date.now()
  const oldGroup = w.syncGroupId
  let fileId: string
  let src: FileSource
  if (oldGroup) {
    fileId = widgetFileIdForGroup(oldGroup)
    // Members mirror content, title and colour; the name to keep is the first
    // real one among them, the date the oldest member's.
    const members = db
      .prepare('SELECT id FROM widgets WHERE sync_group_id = ? ORDER BY created_at ASC')
      .all(oldGroup) as Array<{ id: string }>
    const ws = members.map((m) => getWidget(m.id)).filter((x): x is Widget => !!x)
    const named = ws.find((m) => meaningfulWidgetTitle(m.kind, m.title, kindLabels(m.kind)))
    src = {
      kind: w.kind,
      title: named?.title ?? w.title,
      content: w.content,
      color: w.color,
      createdAt: ws[0]?.createdAt ?? w.createdAt
    }
  } else {
    fileId = widgetFileIdForWidget(w.id)
    // Content is kept exactly as the widget holds it. A task list added on a
    // desk is a lens over that desk's tasks, and stays one as a file (as "Save
    // as file" always kept it); a side-menu task list is its own list.
    src = { kind: w.kind, title: w.title, content: w.content, color: w.color, createdAt: w.createdAt }
  }
  const made = createFileUnderId(fileId, src, scope, { reindex: opts.reindex !== false })
  if (!made) return null
  const sgid = widgetFileGroupId(fileId)
  if (oldGroup) {
    db.prepare('UPDATE widgets SET sync_group_id = ?, updated_at = ? WHERE sync_group_id = ?').run(sgid, now, oldGroup)
  } else {
    db.prepare('UPDATE widgets SET sync_group_id = ?, updated_at = ? WHERE id = ?').run(sgid, now, w.id)
  }
  const file = made.file
  const share = (opts.instanceTitle ?? 'always') === 'always' || file.titleSource !== 'placeholder'
  if (share) {
    db.prepare(
      "UPDATE widgets SET title = ?, updated_at = ? WHERE sync_group_id = ? AND (title IS NULL OR trim(title) = '')"
    ).run(file.title, now, sgid)
  }
  return getWidget(w.id)
}

// ── Launch backfill ─────────────────────────────────────────────────────────
// What existed before the rule: every standalone-kind widget on a desk in the
// user's own workspace becomes a file, once per workspace, recorded in the
// device-local sync_meta. Ids are derived (above), so two devices that each
// convert the same synced desk agree on every file id, and whichever device's
// documents reach the server second merge into the first's.
//
// Skipped, by rule: trashed widgets (restoreWidget files one if it comes
// back), widgets on a trashed desk, desks outside the user's own workspace
// (deskFileScope), and widgets already in a `wf:` group — including one whose
// file has not arrived from another device yet; that file is on its way as a
// document and must not be minted twice.

export const WIDGET_FILE_BACKFILL_KEY = 'widgetFiles.backfill.v1'

export interface WidgetFileBackfillSummary {
  /** Workspaces converted on this run. */
  orgs: string[]
  /** Widgets that became (or joined) a file. */
  widgets: number
  /** Files created on this run (a group or a reused id counts once / not at all). */
  files: number
}

function backfillDone(orgId: string): boolean {
  try {
    const row = getDb()
      .prepare('SELECT value FROM sync_meta WHERE key = ?')
      .get(`${WIDGET_FILE_BACKFILL_KEY}:${orgId}`) as { value: string } | undefined
    return !!row
  } catch {
    return false
  }
}

function markBackfillDone(orgId: string, summary: { widgets: number; files: number }): void {
  try {
    getDb()
      .prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)')
      .run(`${WIDGET_FILE_BACKFILL_KEY}:${orgId}`, JSON.stringify({ at: Date.now(), ...summary }))
  } catch {
    /* without the marker the next launch repeats an idempotent pass */
  }
}

/** The workspaces with desks that have not been converted on this device. */
export function pendingBackfillOrgs(): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT COALESCE(org_id, 'personal') AS org FROM nodes")
    .all() as Array<{ org: string }>
  return rows.map((r) => r.org).filter((o) => !backfillDone(o))
}

/** The widgets in one workspace that should be files and are not yet. */
function backfillCandidates(orgId: string): string[] {
  const kinds = Object.keys(WIDGET_FILE_TYPES)
  const marks = kinds.map(() => '?').join(',')
  return (
    getDb()
      .prepare(
        `SELECT w.id FROM widgets w JOIN nodes n ON n.id = w.task_id
          WHERE w.trashed_at IS NULL AND n.trashed_at IS NULL
            AND COALESCE(n.org_id, 'personal') = ?
            AND n.shared_root_id IS NULL AND n.shared_from_handle IS NULL
            AND w.kind IN (${marks})
            AND (w.sync_group_id IS NULL OR w.sync_group_id NOT LIKE 'wf:%')
          ORDER BY w.created_at ASC, w.id ASC`
      )
      .all(orgId, ...kinds) as Array<{ id: string }>
  ).map((r) => r.id)
}

/**
 * Convert one workspace. Synchronous and idempotent; 200 widgets per
 * transaction. Returns the new file ids so the caller can index them.
 */
export function backfillWidgetFilesForOrg(orgId: string): { widgets: number; fileIds: string[] } {
  const db = getDb()
  const ids = backfillCandidates(orgId)
  const fileIds = new Set<string>()
  let widgets = 0
  const before = new Set(
    (db.prepare("SELECT id FROM documents WHERE doc_type = 'widget'").all() as Array<{ id: string }>).map((r) => r.id)
  )
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    db.transaction(() => {
      for (const id of chunk) {
        // A second member of a linked group joined the file with the first.
        const w = adoptWidgetAsFile(id, { reindex: false, instanceTitle: 'named' }) ?? getWidget(id)
        if (!w || !widgetFileIdFromGroup(w.syncGroupId)) continue
        widgets++
        const fid = widgetFileIdFromGroup(w.syncGroupId)
        if (fid && !before.has(fid)) fileIds.add(fid)
      }
    })()
  }
  return { widgets, fileIds: [...fileIds] }
}

/**
 * The launch pass: every workspace not yet converted on this device, then one
 * batched index of the new files. Detached from boot by the caller.
 */
export async function runWidgetFileBackfill(): Promise<WidgetFileBackfillSummary> {
  const summary: WidgetFileBackfillSummary = { orgs: [], widgets: 0, files: 0 }
  const created: string[] = []
  for (const org of pendingBackfillOrgs()) {
    const r = backfillWidgetFilesForOrg(org)
    markBackfillDone(org, { widgets: r.widgets, files: r.fileIds.length })
    summary.orgs.push(org)
    summary.widgets += r.widgets
    summary.files += r.fileIds.length
    created.push(...r.fileIds)
    // Yield between workspaces so a large conversion never holds the main
    // process for the whole run.
    await new Promise((res) => setImmediate(res))
  }
  if (created.length > 0) {
    try {
      const chunks = await import('../chunkIndex')
      for (let i = 0; i < created.length; i++) {
        chunks.reindexDocumentChunks(created[i])
        if (i % 50 === 49) await new Promise((res) => setImmediate(res))
      }
      // One batched embedding pass for whatever lacks a vector (a no-op
      // without a key), rather than one request per new file.
      const retrieval = await import('../documentRetrieval')
      await retrieval.reindexDocuments(false)
    } catch {
      /* best-effort: the files are created and filed either way */
    }
  }
  return summary
}

// ── Trash ───────────────────────────────────────────────────────────────────

/**
 * Delete a work widget: move the file to the Documents Trash, and with it its
 * Files entry and every desk instance on every desk (trashDocument does the
 * instances, stamped with the file's own trashed_at). Restoring the file from
 * Trash puts each instance back where it was (restoreDocument).
 */
export function trashWidgetFile(id: string): boolean {
  const ok = trashDocument(id)
  if (ok) {
    getDb()
      .prepare("UPDATE fb_files SET trashed_at = ? WHERE kind = 'doc' AND doc_id = ? AND trashed_at IS NULL")
      .run(Date.now(), id)
  }
  return ok
}

// ── Files ───────────────────────────────────────────────────────────────────
// ensureWidgetFilesFiled lives in db/files beside the listing that calls it.
export { ensureWidgetFilesFiled } from './files'

// ── Export / import ─────────────────────────────────────────────────────────

export function exportWidgetFile(id: string): WidgetFileExport | null {
  const file = getWidgetFile(id)
  if (!file) return null
  let table: WidgetFileExport['table']
  if (file.kind === 'table' && file.content) {
    const t = getTable(file.content)
    if (t) {
      table = {
        title: t.title,
        columns: t.schema.columns as unknown as Array<Record<string, unknown>>,
        rows: listRows(t.id).map((r) => r.cells as Record<string, unknown>)
      }
    }
  }
  return buildWidgetFileExport(file, { table })
}

/** Create a new file from an export. A table's rows are recreated, not shared. */
export function importWidgetFile(env: WidgetFileExport, parentId: string | null = null): WidgetFile {
  let content = env.content
  if (env.kind === 'table') {
    const t = createTable({
      taskId: null,
      title: env.table?.title ?? env.title ?? '',
      schema: { columns: (env.table?.columns ?? []) as never }
    })
    for (const cells of env.table?.rows ?? []) createRow({ tableId: t.id, cells: cells as never })
    content = t.id
  }
  return createWidgetFile({ kind: env.kind, title: env.title, content, color: env.color, parentId })
}
