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
  isStandaloneWidgetKind,
  makeWidgetFileBody,
  parseWidgetFileBody,
  placeholderWidgetFileTitle,
  widgetFileGroupId,
  widgetFileIdFromGroup,
  type WidgetFileExport
} from '@shared/widgetFiles'
import type {
  FbDocument,
  Widget,
  WidgetDraft,
  WidgetFile,
  WidgetFileBody,
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
  return doc ? widgetFileFromDocument(doc) : null
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
}

export function createWidgetFile(draft: WidgetFileDraft, opts: CreateWidgetFileOptions = {}): WidgetFile {
  if (!isStandaloneWidgetKind(draft.kind)) {
    throw new Error(`A ${draft.kind} widget only works on a desk, so it cannot be a file.`)
  }
  const content =
    draft.content !== undefined ? draft.content : defaultWidgetFileContent(draft.kind, opts.defaultContent ?? '')
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
  if (patch.title !== undefined) {
    const next = patch.title.trim()
    if (next && !isUntitled(next)) {
      title = next.slice(0, 200)
      titleSource = 'user'
      titleChanged = title !== file.title
    }
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

// ── Trash ───────────────────────────────────────────────────────────────────

/**
 * Move a file to the Documents Trash. Its desk instances keep working with
 * their own copy of the content; restoring the file relinks nothing because
 * nothing was unlinked.
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
