import { randomUUID } from 'crypto'
import { getDb } from './database'
import { getActiveOrgId } from './activeOrg'
import { deleteEmbedding } from './embeddings'
import type {
  DocBody,
  DocumentDraft,
  DocumentMeta,
  DocumentPatch,
  FbDocument,
  MapBody,
  SheetBody,
  SlidesBody
} from '@shared/types'
import { migrateSlidesBody } from '@shared/slidesMigrate'
import { normalizeMapBody, starterMapBody } from '@shared/mapGraph'
import { normalizeDesignBody, blankDesign, findDesignSize, type DesignBody } from '@shared/design'
import { normalizeDrawBody, blankDrawBody, findDrawSize, type DrawBody } from '@shared/draw'
import { brandHeadingStyles } from '@shared/brandKit'
import { getBrandKit, hasBrandKit } from './brandKit'

// Office documents store — CRUD for standalone doc / sheet / slides files. The
// body is persisted as a JSON string; the shape depends on doc_type and is
// validated only loosely here (the editors own the shape), so an older body
// schema never blocks a read.

interface DocumentRow {
  id: string
  doc_type: FbDocument['docType']
  title: string
  body: string
  archived: number
  created_at: number
  updated_at: number
  org_id: string | null
}

// Spreadsheet-style column label for a zero-based index: 0->A, 25->Z, 26->AA, …
function spreadsheetColumnLabel(index: number): string {
  let s = ''
  let i = index + 1
  while (i > 0) {
    const r = (i - 1) % 26
    s = String.fromCharCode(65 + r) + s
    i = Math.floor((i - 1) / 26)
  }
  return s
}

function parseBody(
  type: FbDocument['docType'],
  raw: string
): DocBody | SheetBody | SlidesBody | MapBody | DesignBody | DrawBody {
  try {
    const parsed = JSON.parse(raw)
    // Slides bodies are migrated to the v2 element model on read, so a legacy
    // deck always opens as editable elements without rewriting the file at rest.
    if (type === 'slides') return migrateSlidesBody(parsed as SlidesBody)
    // Maps are normalised on read so a malformed graph still opens cleanly.
    if (type === 'map') return normalizeMapBody(parsed)
    // Designs are normalised so a bad size or missing elements still opens.
    if (type === 'design') return normalizeDesignBody(parsed)
    // Artwork likewise: a body with no layers still opens with somewhere to draw.
    if (type === 'draw') return normalizeDrawBody(parsed)
    return parsed
  } catch {
    // Corrupt or empty — hand back a valid empty body for the type so the
    // editor still opens rather than throwing.
    return emptyBody(type)
  }
}

export function emptyBody(type: FbDocument['docType']): DocBody | SheetBody | SlidesBody | MapBody | DesignBody | DrawBody {
  if (type === 'sheet') {
    // A fresh spreadsheet opens at a generous 48 columns by 100 rows, like a real
    // spreadsheet, rather than a tiny starter grid.
    const columns = Array.from({ length: 48 }, (_, i) => spreadsheetColumnLabel(i))
    const rows = Array.from({ length: 100 }, () => columns.map(() => ''))
    return { columns, rows }
  }
  if (type === 'slides') {
    // Build a v1 starter slide and migrate it, so a fresh deck is already v2.
    return migrateSlidesBody({
      slides: [{ id: randomUUID(), title: 'Title slide', bullets: [], notes: '', layout: 'title' }]
    })
  }
  if (type === 'map') {
    // A fresh map opens with a single Start node to build out from.
    return starterMapBody()
  }
  if (type === 'design') {
    // A fresh design opens as a blank square social canvas, the most common size.
    return blankDesign(findDesignSize('ig-post')!)
  }
  if (type === 'draw') {
    // A fresh artwork opens on a landscape artboard with one empty vector layer.
    return blankDrawBody(findDrawSize('landscape-1920')!)
  }
  const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
  // When the org has a brand kit, a new document opens already on-brand: its
  // heading styles are seeded from the brand. Without a brand set, a plain
  // document, so default-brand users are unaffected. Existing docs never change.
  if (hasBrandKit()) {
    return { doc: emptyDoc, headingStyles: brandHeadingStyles(getBrandKit()) }
  }
  return emptyDoc
}

function rowToDoc(row: DocumentRow): FbDocument {
  return {
    id: row.id,
    docType: row.doc_type,
    title: row.title,
    body: parseBody(row.doc_type, row.body),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orgId: row.org_id ?? null
  }
}

function rowToMeta(row: Omit<DocumentRow, 'body'>): DocumentMeta {
  return {
    id: row.id,
    docType: row.doc_type,
    title: row.title,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** All non-archived, non-trashed documents, newest-edited first (metadata only). */
export function listDocuments(): DocumentMeta[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, doc_type, title, archived, created_at, updated_at
       FROM documents WHERE archived = 0 AND trashed_at IS NULL AND org_id = ? ORDER BY updated_at DESC`
    )
    .all(getActiveOrgId()) as Omit<DocumentRow, 'body'>[]
  return rows.map(rowToMeta)
}

/** Trashed documents for the active org, newest-deleted first. */
export function listTrashedDocuments(): DocumentMeta[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, doc_type, title, archived, created_at, updated_at
       FROM documents WHERE trashed_at IS NOT NULL AND org_id = ? ORDER BY trashed_at DESC`
    )
    .all(getActiveOrgId()) as Omit<DocumentRow, 'body'>[]
  return rows.map(rowToMeta)
}

export function getDocument(id: string): FbDocument | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as
    | DocumentRow
    | undefined
  return row ? rowToDoc(row) : null
}

export function createDocument(draft: DocumentDraft): FbDocument {
  const db = getDb()
  // WS01 lifecycle: honour a client-provided id (create-if-missing by primary key)
  // so a document create event materialises with the same id on another device.
  const id = draft.id ?? randomUUID()
  if (draft.id) {
    const existing = getDocument(draft.id)
    if (existing) return existing
  }
  const now = Date.now()
  const body = draft.body ?? emptyBody(draft.docType)
  db.prepare(
    `INSERT INTO documents (id, doc_type, title, body, archived, created_at, updated_at, org_id)
     VALUES (@id, @docType, @title, @body, 0, @now, @now, @orgId)`
  ).run({
    id,
    docType: draft.docType,
    title: draft.title || 'Untitled',
    body: JSON.stringify(body),
    orgId: getActiveOrgId(),
    now
  })
  return getDocument(id) as FbDocument
}

export function updateDocument(id: string, patch: DocumentPatch): FbDocument | null {
  const db = getDb()
  const existing = getDocument(id)
  if (!existing) return null
  const now = Date.now()
  const sets: string[] = ['updated_at = @now']
  const params: Record<string, unknown> = { id, now }
  if (patch.title !== undefined) {
    sets.push('title = @title')
    params.title = patch.title
  }
  if (patch.body !== undefined) {
    sets.push('body = @body')
    params.body = JSON.stringify(patch.body)
  }
  if (patch.archived !== undefined) {
    sets.push('archived = @archived')
    params.archived = patch.archived ? 1 : 0
  }
  db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = @id`).run(params)
  return getDocument(id)
}

// Insert-or-replace by an explicit id. Used by cloud-document sync to land a
// document from the server under its own id (the normal create() mints a fresh
// id, which would break id alignment across devices/apps). `updatedAt` lets the
// caller preserve the server's timestamp.
export function upsertDocument(input: {
  id: string
  docType: FbDocument['docType']
  title: string
  body: DocBody | SheetBody | SlidesBody | MapBody | DesignBody | DrawBody
  archived?: boolean
  updatedAt?: number
}): FbDocument {
  const db = getDb()
  const existing = getDocument(input.id)
  const now = input.updatedAt ?? Date.now()
  const bodyStr = JSON.stringify(input.body)
  const archived = input.archived ? 1 : 0
  if (existing) {
    db.prepare(
      `UPDATE documents SET doc_type = @docType, title = @title, body = @body,
         archived = @archived, updated_at = @now WHERE id = @id`
    ).run({ id: input.id, docType: input.docType, title: input.title, body: bodyStr, archived, now })
  } else {
    db.prepare(
      `INSERT INTO documents (id, doc_type, title, body, archived, created_at, updated_at, org_id)
       VALUES (@id, @docType, @title, @body, @archived, @now, @now, @orgId)`
    ).run({ id: input.id, docType: input.docType, title: input.title, body: bodyStr, archived, orgId: getActiveOrgId(), now })
  }
  return getDocument(input.id) as FbDocument
}

// Soft-delete: the document moves to the Documents Trash and disappears from
// every list, search index and Drive reference, but the row survives so the
// user can restore it. This is what the editors' "Move to trash" actually does.
export function trashDocument(id: string): boolean {
  const db = getDb()
  const info = db.prepare('UPDATE documents SET trashed_at = ? WHERE id = ? AND trashed_at IS NULL').run(Date.now(), id)
  // The semantic vector goes too so AI retrieval never surfaces trashed work;
  // restoreDocument re-embeds.
  if (info.changes > 0) deleteEmbedding('document', id)
  return info.changes > 0
}

/** Undo of trashDocument. The caller re-embeds (embedDocument) after restore. */
export function restoreDocument(id: string): boolean {
  const db = getDb()
  const info = db.prepare('UPDATE documents SET trashed_at = NULL WHERE id = ? AND trashed_at IS NOT NULL').run(id)
  return info.changes > 0
}

// Permanent delete, used by the Trash view's "Delete forever" and by cloud-sync
// driven removals. Also prunes any Drive reference to the document so no
// dangling fb_files row survives it.
export function deleteDocument(id: string): boolean {
  const db = getDb()
  const info = db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  if (info.changes > 0) {
    // Remove the document's semantic vector on the same path, so no delete route
    // leaves an orphaned embedding behind.
    deleteEmbedding('document', id)
    db.prepare("DELETE FROM fb_files WHERE kind = 'doc' AND doc_id = ?").run(id)
  }
  return info.changes > 0
}
