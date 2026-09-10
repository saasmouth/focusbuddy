import { randomUUID } from 'crypto'
import { extname } from 'path'
import { getDb } from './database'
import { fileBlobs } from './fileBlobs'
import { downsampleImage } from './imageDownsample'
import { getActiveOrgId } from './activeOrg'
import type { FbFile, FileEntry } from '@shared/fields'

interface FileRow {
  id: string
  original_name: string
  mime_type: string
  size_bytes: number
  ext: string
  created_at: number
}

function rowToFile(row: FileRow): FbFile {
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    ext: row.ext,
    storedPath: fileBlobs.locate(row.id, row.ext),
    createdAt: row.created_at
  }
}


/**
 * Ingest from raw bytes — e.g. when the renderer reads the file via the File
 * API and ships the ArrayBuffer over IPC. Used for HTML5 drag-drop of files
 * that don't expose a real .path (Electron 32+ removed File.path).
 */
export async function ingestFromBuffer(input: {
  buffer: Uint8Array
  originalName: string
  mimeType: string
  parentId?: string | null
}): Promise<FbFile> {
  const ext = extname(input.originalName).toLowerCase()
  const id = randomUUID()
  const mimeType = input.mimeType || mimeFromExt(ext)
  // Shrink an oversized image before it is stored, so the saving applies
  // everywhere at once: on this disk, on the wire, on the server's volume, and
  // on every other device that later pulls it. Doing it here rather than at
  // display time is the difference between paying for the pixels once and
  // paying for them on every device forever.
  //
  // Conservative by design, and it declines far more often than it acts -- see
  // ./imageDownsample.ts. A file it will not touch comes back byte-identical.
  const shrunk = await downsampleImage(input.buffer, mimeType, ext)
  const bytes = shrunk.bytes
  await fileBlobs.write(id, ext, bytes)
  return insertFileRow({
    id,
    originalName: input.originalName,
    mimeType,
    sizeBytes: bytes.length,
    ext,
    createdAt: Date.now(),
    parentId: input.parentId ?? null
  })
}

export function insertFileRow(meta: {
  id: string
  originalName: string
  mimeType: string
  sizeBytes: number
  ext: string
  createdAt: number
  parentId?: string | null
}): FbFile {
  const db = getDb()
  db.prepare(
    `INSERT INTO fb_files
       (id, original_name, mime_type, size_bytes, ext, created_at, parent_id, kind, display_name, updated_at, org_id)
     VALUES (@id, @originalName, @mimeType, @sizeBytes, @ext, @createdAt, @parentId, 'file', @originalName, @createdAt, @orgId)`
  ).run({ ...meta, parentId: meta.parentId ?? null, orgId: getActiveOrgId() })
  pokeFileChunks([meta.id])
  return rowToFile({
    id: meta.id,
    original_name: meta.originalName,
    mime_type: meta.mimeType,
    size_bytes: meta.sizeBytes,
    ext: meta.ext,
    created_at: meta.createdAt
  })
}

export function getFile(id: string): FbFile | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM fb_files WHERE id = ?').get(id) as
    | FileRow
    | undefined
  return row ? rowToFile(row) : null
}

// ── Chunk-index support (A2, #17) ────────────────────────────────────────────

// The slice of a file row the chunk index needs. Kept here so the retrieval
// layer never learns this module's schema.
export interface IndexableFile {
  id: string
  name: string
  ext: string
  sizeBytes: number
  updatedAt: number
}

const INDEXABLE_COLS = `id, COALESCE(NULLIF(display_name, ''), original_name) AS name, ext,
       size_bytes AS sizeBytes, COALESCE(updated_at, created_at) AS updatedAt`

// Every real (non-folder), non-trashed file of the active org.
export function listIndexableFiles(): IndexableFile[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT ${INDEXABLE_COLS} FROM fb_files
       WHERE kind = 'file' AND trashed_at IS NULL AND org_id = ?`
    )
    .all(getActiveOrgId()) as IndexableFile[]
}

export function getIndexableFile(id: string): IndexableFile | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT ${INDEXABLE_COLS} FROM fb_files
       WHERE id = ? AND kind = 'file' AND trashed_at IS NULL AND org_id = ?`
    )
    .get(id, getActiveOrgId()) as IndexableFile | undefined
  return row ?? null
}

// Chunk-index freshness (A2, #17): a file's text enters retrieval when it
// lands and leaves when it is trashed or purged, whichever path wrote it.
// Dynamically imported so the db layer never gains a static dependency on the
// retrieval layer; indexFileChunks itself decides index-vs-remove from the
// row's current state. Best-effort by design.
function pokeFileChunks(ids: string[], force = false): void {
  if (!ids.length) return
  void import('../chunkIndex')
    .then(async (m) => {
      for (const id of ids) await m.indexFileChunks(id, { force })
    })
    .catch(() => {})
}

export async function deleteFile(id: string): Promise<boolean> {
  const file = getFile(id)
  if (!file) return false
  await fileBlobs.remove(file.id, file.ext)
  const db = getDb()
  const r = db.prepare('DELETE FROM fb_files WHERE id = ?').run(id)
  if (r.changes > 0) pokeFileChunks([id]) // resolves to removal: the row is gone
  return r.changes > 0
}

/**
 * Read the file's bytes — used when the renderer needs the raw content (e.g.
 * to show an image via blob URL). We pass through the on-disk read; there's
 * no cache layer, but files are small enough and rare enough that it's fine.
 */
export async function readFileBytes(id: string): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
  const file = getFile(id)
  if (!file) return null
  const bytes = await fileBlobs.read(file.id, file.ext)
  return bytes ? { mimeType: file.mimeType, bytes } : null
}

// ── Cross-member sync byte helpers ───────────────────────────────────────────
// A file's metadata syncs over the org workspace loop like any other row; these
// move the actual bytes. readForSync ships a local file's bytes up to the org
// blob channel; hasBytes tells the pull side whether it still needs to fetch;
// writeSyncedBytes lands a pulled blob on disk under the same id+ext naming the
// rest of this module uses, so getFile/readFileBytes/extractFileText find it.

export async function hasFileBytes(id: string): Promise<boolean> {
  const file = getFile(id)
  if (!file) return false
  return fileBlobs.exists(file.id, file.ext)
}

export async function readFileBytesForSync(
  id: string
): Promise<{ ext: string; mimeType: string; bytes: Uint8Array } | null> {
  const file = getFile(id)
  if (!file) return null
  const bytes = await fileBlobs.read(file.id, file.ext)
  return bytes ? { ext: file.ext, mimeType: file.mimeType, bytes } : null
}

export async function writeSyncedFileBytes(id: string, bytes: Uint8Array): Promise<boolean> {
  const file = getFile(id)
  // The fb_files row is applied before its bytes are fetched, so it exists here
  // and gives us the canonical stored path (id + sanitised ext). If it somehow
  // doesn't, refuse rather than guess a path.
  if (!file) return false
  try {
    await fileBlobs.write(file.id, file.ext, bytes)
    // The bytes changed but the row (and so the cheap version stamp) did not —
    // force the re-extract.
    pokeFileChunks([id], true)
    return true
  } catch {
    return false
  }
}


// Share a personal file/folder/drive (and everything inside it) with an org — the
// Drive equivalent of moving a desk to the team. Re-scopes the fb_files subtree's
// org_id + sync bookkeeping (sync_rev reset for the org keyspace) so the org loop
// pushes the metadata and, for real files, uploads the bytes to every member.
// Passing the drive root's children shares the whole drive. Returns affected ids.
//
// Note: kind 'doc' pointers inside a shared folder are re-scoped but not pushed by
// the org loop (documents sync as their own 'document' item); share the document
// itself to bring it across. Real files and folders travel in full.
export function moveFileToOrg(rootId: string, orgId: string, teamId: string | null = null): string[] {
  const db = getDb()
  if (!orgId) return []
  const exists = db.prepare('SELECT id FROM fb_files WHERE id = ? AND trashed_at IS NULL').get(rootId)
  if (!exists) return []
  const ids: string[] = []
  const collect = (fid: string): void => {
    ids.push(fid)
    const kids = db.prepare('SELECT id FROM fb_files WHERE parent_id = ? AND trashed_at IS NULL').all(fid) as Array<{
      id: string
    }>
    for (const k of kids) collect(k.id)
  }
  collect(rootId)
  // teamId scopes the subtree to a group (null = whole org).
  const setFile = db.prepare('UPDATE fb_files SET org_id = ?, team_id = ?, needs_sync = 1, sync_rev = 0 WHERE id = ?')
  db.transaction(() => {
    for (const i of ids) setFile.run(orgId, teamId, i)
  })()
  return ids
}

// ── File/folder manager ──────────────────────────────────────────────────────
// fb_files doubles as the manager's tree: folders (kind 'folder'), imported
// external files (kind 'file'), and references to internal documents filed into
// a folder (kind 'doc', resolved live from the documents table so renames show).

interface EntryRow {
  id: string
  parent_id: string | null
  kind: 'folder' | 'file' | 'doc'
  original_name: string
  display_name: string | null
  mime_type: string
  size_bytes: number
  ext: string
  doc_id: string | null
  doc_type: string | null
  created_at: number
  updated_at: number | null
}

function childCount(id: string): number {
  const db = getDb()
  const r = db.prepare('SELECT COUNT(*) as n FROM fb_files WHERE parent_id = ? AND trashed_at IS NULL').get(id) as { n: number }
  return r.n
}

// Resolve a row into a FileEntry. Returns null for a doc reference whose
// document has been deleted or archived (a dangling reference), so the caller
// can clean it up rather than show a ghost.
function rowToEntry(row: EntryRow): FileEntry | null {
  const base = {
    id: row.id,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at
  }
  if (row.kind === 'folder') {
    return { ...base, kind: 'folder', name: row.display_name || row.original_name || 'Folder', childCount: childCount(row.id) }
  }
  if (row.kind === 'doc') {
    if (!row.doc_id) return null
    const db = getDb()
    const doc = db
      .prepare('SELECT title, doc_type, updated_at FROM documents WHERE id = ? AND archived = 0 AND trashed_at IS NULL')
      .get(row.doc_id) as { title: string; doc_type: string; updated_at: number } | undefined
    if (!doc) return null
    return {
      ...base,
      kind: 'doc',
      name: doc.title || 'Untitled',
      docId: row.doc_id,
      docType: doc.doc_type as FileEntry['docType'],
      updatedAt: doc.updated_at
    }
  }
  return {
    ...base,
    kind: 'file',
    name: row.display_name || row.original_name,
    ext: row.ext,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes
  }
}

const ENTRY_COLS =
  'id, parent_id, kind, original_name, display_name, mime_type, size_bytes, ext, doc_id, doc_type, created_at, updated_at'

let purgedThisSession = false

export function listEntries(parentId: string | null): FileEntry[] {
  const db = getDb()
  if (!purgedThisSession) {
    purgedThisSession = true
    try {
      purgeOldTrash()
    } catch {
      // best-effort cleanup
    }
  }
  const rows = (
    parentId == null
      ? db.prepare(`SELECT ${ENTRY_COLS} FROM fb_files WHERE parent_id IS NULL AND trashed_at IS NULL AND org_id = ?`).all(getActiveOrgId())
      : db.prepare(`SELECT ${ENTRY_COLS} FROM fb_files WHERE parent_id = ? AND trashed_at IS NULL AND org_id = ?`).all(parentId, getActiveOrgId())
  ) as EntryRow[]
  const out: FileEntry[] = []
  for (const row of rows) {
    const entry = rowToEntry(row)
    if (entry) out.push(entry)
    else if (row.kind === 'doc') db.prepare('DELETE FROM fb_files WHERE id = ?').run(row.id) // prune dangling
  }
  return out
}

export function getEntry(id: string): FileEntry | null {
  const db = getDb()
  const row = db.prepare(`SELECT ${ENTRY_COLS} FROM fb_files WHERE id = ? AND trashed_at IS NULL`).get(id) as
    | EntryRow
    | undefined
  return row ? rowToEntry(row) : null
}

// The folder chain from root to the given folder, for breadcrumbs.
export function folderPath(id: string | null): Array<{ id: string; name: string }> {
  if (!id) return []
  const db = getDb()
  const chain: Array<{ id: string; name: string }> = []
  let cur: string | null = id
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const row = db.prepare('SELECT id, parent_id, display_name, original_name, kind FROM fb_files WHERE id = ?').get(cur) as
      | { id: string; parent_id: string | null; display_name: string | null; original_name: string; kind: string }
      | undefined
    if (!row || row.kind !== 'folder') break
    chain.unshift({ id: row.id, name: row.display_name || row.original_name || 'Folder' })
    cur = row.parent_id
  }
  return chain
}

export function createFolder(parentId: string | null, name: string, explicitId?: string): FileEntry {
  const db = getDb()
  // WS01 lifecycle: honour a client-provided id (create-if-missing by primary key)
  // so a folder create event materialises with the same id on another device.
  const id = explicitId ?? randomUUID()
  if (explicitId) {
    const existing = getEntry(explicitId)
    if (existing && existing.kind === 'folder') return existing
  }
  const now = Date.now()
  const folderName = name.trim() || 'New folder'
  db.prepare(
    `INSERT INTO fb_files
       (id, original_name, mime_type, size_bytes, ext, created_at, parent_id, kind, display_name, updated_at, org_id)
     VALUES (@id, @name, '', 0, '', @now, @parentId, 'folder', @name, @now, @orgId)`
  ).run({ id, name: folderName, now, parentId, orgId: getActiveOrgId() })
  return { id, parentId, kind: 'folder', name: folderName, childCount: 0, createdAt: now, updatedAt: now }
}

export function renameEntry(id: string, name: string): FileEntry | null {
  const db = getDb()
  db.prepare('UPDATE fb_files SET display_name = ?, updated_at = ? WHERE id = ?').run(name.trim() || 'Untitled', Date.now(), id)
  return getEntry(id)
}

// Walk up from `nodeId`; true if `ancestorId` is on the path (so moving a
// folder into its own descendant can be refused).
function isDescendantOf(nodeId: string | null, ancestorId: string): boolean {
  const db = getDb()
  let cur = nodeId
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    const row = db.prepare('SELECT parent_id FROM fb_files WHERE id = ?').get(cur) as { parent_id: string | null } | undefined
    cur = row?.parent_id ?? null
  }
  return false
}

export function moveEntry(id: string, newParentId: string | null): boolean {
  if (id === newParentId) return false
  if (newParentId && isDescendantOf(newParentId, id)) return false
  const db = getDb()
  return db.prepare('UPDATE fb_files SET parent_id = ?, updated_at = ? WHERE id = ?').run(newParentId, Date.now(), id).changes > 0
}

// Soft-delete: mark the entry and its whole subtree as trashed (hidden from
// listings) and return the affected ids so the caller can offer undo. The blob
// stays on disk until purgeOldTrash removes it, so a restore is lossless. A doc
// reference is trashed too, but the underlying document is never touched.
export function deleteEntry(id: string): string[] {
  const db = getDb()
  const exists = db.prepare('SELECT id FROM fb_files WHERE id = ? AND trashed_at IS NULL').get(id)
  if (!exists) return []
  const ids: string[] = []
  const collect = (nid: string): void => {
    ids.push(nid)
    const kids = db.prepare('SELECT id FROM fb_files WHERE parent_id = ? AND trashed_at IS NULL').all(nid) as Array<{
      id: string
    }>
    for (const k of kids) collect(k.id)
  }
  collect(id)
  const now = Date.now()
  const stmt = db.prepare('UPDATE fb_files SET trashed_at = ? WHERE id = ?')
  db.transaction(() => {
    for (const i of ids) stmt.run(now, i)
  })()
  pokeFileChunks(ids) // trashed content stops grounding answers
  return ids
}

// Restore trashed entries (undo of a delete).
export function restoreEntries(ids: string[]): boolean {
  if (!ids.length) return false
  const db = getDb()
  const stmt = db.prepare('UPDATE fb_files SET trashed_at = NULL WHERE id = ?')
  db.transaction(() => {
    for (const i of ids) stmt.run(i)
  })()
  pokeFileChunks(ids) // restored content is retrievable again
  return true
}

// The roots of trashed subtrees, newest-deleted first, for the Drive's Trash
// view. A child of a trashed folder is omitted so the list shows what the user
// actually deleted rather than every descendant of it.
export function listTrashedEntries(): FileEntry[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLS} FROM fb_files
       WHERE trashed_at IS NOT NULL
         AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM fb_files WHERE trashed_at IS NOT NULL))
       ORDER BY trashed_at DESC`
    )
    .all() as EntryRow[]
  const out: FileEntry[] = []
  for (const row of rows) {
    const entry = rowToEntry(row)
    if (entry) out.push(entry)
  }
  return out
}

// A trashed entry plus its still-trashed descendants, so restoring or purging a
// folder takes its whole subtree with it.
function trashedSubtree(id: string): string[] {
  const db = getDb()
  const ids: string[] = []
  const collect = (nid: string): void => {
    ids.push(nid)
    const kids = db.prepare('SELECT id FROM fb_files WHERE parent_id = ? AND trashed_at IS NOT NULL').all(nid) as Array<{
      id: string
    }>
    for (const k of kids) collect(k.id)
  }
  collect(id)
  return ids
}

// Restore a trashed entry and everything trashed beneath it.
export function restoreEntryDeep(id: string): boolean {
  return restoreEntries(trashedSubtree(id))
}

// Permanently delete a trashed entry and its trashed descendants now, unlinking
// any stored blobs. This is the Trash view's "Delete forever".
export function purgeEntry(id: string): boolean {
  const db = getDb()
  const ids = trashedSubtree(id)
  if (!ids.length) return false
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, kind, ext FROM fb_files WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; kind: string; ext: string }>
  for (const r of rows) {
    if (r.kind === 'file') {
      void fileBlobs.remove(r.id, r.ext)
    }
  }
  const del = db.prepare('DELETE FROM fb_files WHERE id = ?')
  db.transaction(() => {
    for (const i of ids) del.run(i)
  })()
  pokeFileChunks(ids) // resolves to removal: the rows are gone
  return true
}

// Drive-wide search: folders and files by name, plus filed documents by title.
// Case-insensitive substring, newest-edited first. LIKE wildcards in the query
// are escaped so a literal % or _ is matched, not treated as a pattern.
export function searchEntries(query: string): FileEntry[] {
  const q = query.trim()
  if (!q) return []
  const db = getDb()
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLS} FROM fb_files
       WHERE trashed_at IS NULL
         AND (
           COALESCE(display_name, original_name) LIKE @like ESCAPE '\\'
           OR doc_id IN (SELECT id FROM documents WHERE archived = 0 AND trashed_at IS NULL AND title LIKE @like ESCAPE '\\')
         )
       ORDER BY updated_at DESC LIMIT 200`
    )
    .all({ like }) as EntryRow[]
  const out: FileEntry[] = []
  for (const row of rows) {
    const entry = rowToEntry(row)
    if (entry) out.push(entry)
  }
  return out
}

// Permanently remove entries trashed longer than maxAgeMs (default 7 days),
// unlinking their stored blobs. Runs once per session on first listing.
export function purgeOldTrash(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const db = getDb()
  const cutoff = Date.now() - maxAgeMs
  const rows = db
    .prepare('SELECT id, kind, ext FROM fb_files WHERE trashed_at IS NOT NULL AND trashed_at < ?')
    .all(cutoff) as Array<{ id: string; kind: string; ext: string }>
  if (!rows.length) return
  for (const r of rows) {
    if (r.kind === 'file') {
      void fileBlobs.remove(r.id, r.ext)
    }
  }
  const del = db.prepare('DELETE FROM fb_files WHERE id = ?')
  db.transaction(() => {
    for (const r of rows) del.run(r.id)
  })()
}

// ── Tags (facets) ────────────────────────────────────────────────────────────
// A file or filed document can carry many tags, so it appears in every matching
// tag view at once without being copied. Folders (parent_id) still work; tags are
// an additive layer. `source` distinguishes a person's tag from one the AI
// proposed, so the UI can show unconfirmed AI suggestions differently.

export interface FileTag {
  tag: string
  source: 'user' | 'ai'
}

export function tagsFor(fileId: string): FileTag[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT tag, source FROM fb_file_tags WHERE file_id = ? ORDER BY tag')
    .all(fileId) as Array<{ tag: string; source: string }>
  return rows.map((r) => ({ tag: r.tag, source: r.source === 'ai' ? 'ai' : 'user' }))
}

// Add tags to a file. A person's tag wins over an AI one on conflict (so
// confirming an AI suggestion promotes it). Returns the file's full tag list.
export function addTags(fileId: string, tags: string[], source: 'user' | 'ai' = 'user'): FileTag[] {
  const db = getDb()
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO fb_file_tags (file_id, tag, source, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(file_id, tag) DO UPDATE SET
       source = CASE WHEN excluded.source = 'user' THEN 'user' ELSE fb_file_tags.source END`
  )
  db.transaction(() => {
    for (const raw of tags) {
      const tag = raw.trim()
      if (tag) stmt.run(fileId, tag, source, now)
    }
  })()
  return tagsFor(fileId)
}

export function removeTag(fileId: string, tag: string): boolean {
  const db = getDb()
  return db.prepare('DELETE FROM fb_file_tags WHERE file_id = ? AND tag = ?').run(fileId, tag).changes > 0
}

// The whole tag vocabulary with how many live files carry each, so the UI offers
// existing tags and the auto-filing AI reuses them instead of inventing synonyms.
export function allTags(): Array<{ tag: string; count: number }> {
  const db = getDb()
  return db
    .prepare(
      `SELECT t.tag AS tag, COUNT(*) AS count
       FROM fb_file_tags t JOIN fb_files f ON f.id = t.file_id
       WHERE f.trashed_at IS NULL
       GROUP BY t.tag ORDER BY count DESC, t.tag ASC`
    )
    .all() as Array<{ tag: string; count: number }>
}

// Every live entry carrying a tag, newest-edited first. A tag view is a folder
// that spans the entire Drive, which is the whole point of facets over folders.
export function entriesByTag(tag: string): FileEntry[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLS} FROM fb_files
       WHERE trashed_at IS NULL AND id IN (SELECT file_id FROM fb_file_tags WHERE tag = ?)
       ORDER BY updated_at DESC`
    )
    .all(tag) as EntryRow[]
  const out: FileEntry[] = []
  for (const row of rows) {
    const entry = rowToEntry(row)
    if (entry) out.push(entry)
  }
  return out
}

// Files and filed documents that carry no tags yet — the "not filed" set the
// Drive surfaces so the AI can proactively suggest where they belong. Folders are
// excluded (they aren't filed by content), as are trashed items.
export function untaggedEntries(): FileEntry[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLS} FROM fb_files f
       WHERE f.trashed_at IS NULL AND f.kind != 'folder'
         AND NOT EXISTS (SELECT 1 FROM fb_file_tags t WHERE t.file_id = f.id)
       ORDER BY f.updated_at DESC`
    )
    .all() as EntryRow[]
  const out: FileEntry[] = []
  for (const row of rows) {
    const entry = rowToEntry(row)
    if (entry) out.push(entry)
  }
  return out
}

// ── Smart folders ────────────────────────────────────────────────────────────
// A smart folder is a saved query: a set of tags AND-ed together. Opening it runs
// the query live, so it always shows the right files without anyone refiling.

export interface SmartFolder {
  id: string
  name: string
  tags: string[]
  search: string
}

function safeTags(json: string): string[] {
  try {
    const a = JSON.parse(json)
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

// Every live entry carrying ALL of the given tags (an AND query), newest first.
// The engine behind a smart folder. An empty tag list matches nothing.
export function entriesByTags(tags: string[]): FileEntry[] {
  const clean = tags.map((t) => t.trim()).filter(Boolean)
  if (!clean.length) return []
  const db = getDb()
  const placeholders = clean.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLS} FROM fb_files
       WHERE trashed_at IS NULL AND id IN (
         SELECT file_id FROM fb_file_tags WHERE tag IN (${placeholders})
         GROUP BY file_id HAVING COUNT(DISTINCT tag) = ?
       )
       ORDER BY updated_at DESC`
    )
    .all(...clean, clean.length) as EntryRow[]
  const out: FileEntry[] = []
  for (const row of rows) {
    const entry = rowToEntry(row)
    if (entry) out.push(entry)
  }
  return out
}

export function listSmartFolders(): SmartFolder[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, name, tags_json, search FROM fb_smart_folders WHERE org_id = ? ORDER BY name')
    .all(getActiveOrgId()) as Array<{ id: string; name: string; tags_json: string; search: string }>
  return rows.map((r) => ({ id: r.id, name: r.name, tags: safeTags(r.tags_json), search: r.search ?? '' }))
}

export function createSmartFolder(name: string, tags: string[], search = ''): SmartFolder {
  const db = getDb()
  const id = randomUUID()
  const clean = tags.map((t) => t.trim()).filter(Boolean)
  const s = search.trim()
  const finalName = name.trim() || (clean.length ? clean.join(' + ') : s) || 'Smart folder'
  db.prepare(
    'INSERT INTO fb_smart_folders (id, name, tags_json, search, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, finalName, JSON.stringify(clean), s, Date.now(), getActiveOrgId())
  return { id, name: finalName, tags: clean, search: s }
}

// Resolve a smart folder live: files carrying ALL the tags AND whose name or
// document title matches the search. Either part may be empty; both empty
// matches nothing.
export function smartFolderEntries(tags: string[], search = ''): FileEntry[] {
  const cleanTags = tags.map((t) => t.trim()).filter(Boolean)
  const q = (search ?? '').trim()
  if (!cleanTags.length && !q) return []
  const db = getDb()
  const where: string[] = ['f.trashed_at IS NULL']
  const params: unknown[] = []
  if (cleanTags.length) {
    const ph = cleanTags.map(() => '?').join(',')
    where.push(
      `f.id IN (SELECT file_id FROM fb_file_tags WHERE tag IN (${ph}) GROUP BY file_id HAVING COUNT(DISTINCT tag) = ?)`
    )
    params.push(...cleanTags, cleanTags.length)
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    where.push(
      `(COALESCE(f.display_name, f.original_name) LIKE ? ESCAPE '\\' OR f.doc_id IN (SELECT id FROM documents WHERE archived = 0 AND trashed_at IS NULL AND title LIKE ? ESCAPE '\\'))`
    )
    params.push(like, like)
  }
  const rows = db
    .prepare(`SELECT ${ENTRY_COLS} FROM fb_files f WHERE ${where.join(' AND ')} ORDER BY f.updated_at DESC`)
    .all(...params) as EntryRow[]
  const out: FileEntry[] = []
  for (const row of rows) {
    const entry = rowToEntry(row)
    if (entry) out.push(entry)
  }
  return out
}

export function deleteSmartFolder(id: string): boolean {
  const db = getDb()
  return db.prepare('DELETE FROM fb_smart_folders WHERE id = ?').run(id).changes > 0
}

// File an internal document into a folder. A document lives in exactly one
// place, so re-filing moves its reference rather than duplicating it.
export function fileDocument(docId: string, parentId: string | null): FileEntry | null {
  const db = getDb()
  const doc = db.prepare('SELECT id, doc_type, title FROM documents WHERE id = ? AND archived = 0 AND trashed_at IS NULL').get(docId) as
    | { id: string; doc_type: string; title: string }
    | undefined
  if (!doc) return null
  const now = Date.now()
  const existing = db.prepare("SELECT id FROM fb_files WHERE kind = 'doc' AND doc_id = ?").get(docId) as
    | { id: string }
    | undefined
  if (existing) {
    db.prepare('UPDATE fb_files SET parent_id = ?, updated_at = ?, trashed_at = NULL WHERE id = ?').run(parentId, now, existing.id)
    return getEntry(existing.id)
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO fb_files
       (id, original_name, mime_type, size_bytes, ext, created_at, parent_id, kind, doc_id, doc_type, updated_at, org_id)
     VALUES (@id, @title, '', 0, '', @now, @parentId, 'doc', @docId, @docType, @now, @orgId)`
  ).run({ id, title: doc.title, now, parentId, docId, docType: doc.doc_type, orgId: getActiveOrgId() })
  return getEntry(id)
}

// Where an office document is filed: the fb_files 'doc' row plus the folder
// chain to it, so any surface can show "filed in Room > Folder" and offer to
// move it. Returns null when the document has never been filed (it is loose).
export function locateDocument(
  docId: string
): { entryId: string; parentId: string | null; path: Array<{ id: string; name: string }> } | null {
  const db = getDb()
  const row = db
    .prepare("SELECT id, parent_id FROM fb_files WHERE kind = 'doc' AND doc_id = ? AND trashed_at IS NULL")
    .get(docId) as { id: string; parent_id: string | null } | undefined
  if (!row) return null
  return { entryId: row.id, parentId: row.parent_id, path: folderPath(row.parent_id) }
}

// Documents not yet filed anywhere — offered in the "add existing document"
// picker so a doc isn't shown twice in the same view.
export function unfiledDocuments(): Array<{ id: string; title: string; docType: string }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, title, doc_type FROM documents
       WHERE archived = 0 AND trashed_at IS NULL AND id NOT IN (SELECT doc_id FROM fb_files WHERE kind = 'doc' AND doc_id IS NOT NULL)
       ORDER BY updated_at DESC`
    )
    .all() as Array<{ id: string; title: string; doc_type: string }>
  return rows.map((r) => ({ id: r.id, title: r.title, docType: r.doc_type }))
}

// Lightweight MIME guesser for the dozen extensions we actually care about.
// We don't want a full mime-types dependency for the handful of cases that
// matter for previews.
export function mimeFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  return map[e] ?? 'application/octet-stream'
}
