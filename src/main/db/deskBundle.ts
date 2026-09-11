// One desk, packed into a file that can travel.
//
// workspaceExport.ts writes the WHOLE workspace and leaves file bytes on disk,
// which is right for "let me leave with everything" and wrong for "here is one
// desk, look at it in your browser". This is the desk-shaped sibling:
//
//   - scoped to a desk and its descendants, not the workspace
//   - file bytes travel INSIDE it, because the recipient has no access to the
//     sender's disk and a desk of blank image frames is not a shared desk
//   - readable by both runtimes, because the sender packs it on the desktop and
//     the recipient unpacks it in a Worker
//
// That last point is why this module imports neither electron nor node:fs. It
// reaches the database through getDb and the bytes through fileBlobs, both of
// which are swapped per runtime, so the same code runs on either side.
//
// Import is borrowed wholesale from workspaceExport's design, and deliberately
// so: additive, column-tolerant, foreign keys deferred to COMMIT. Those three
// properties were each paid for once already and there is no reason to learn
// them twice.
import { getDb } from './database'
import { fileBlobs } from './fileBlobs'

export const DESK_BUNDLE_FORMAT = 'plexii.desk'
export const DESK_BUNDLE_VERSION = 1

/** Total inlined bytes a bundle will carry before it starts leaving files out. */
export const DEFAULT_MAX_BUNDLE_BYTES = 80 * 1024 * 1024

export interface BundledFile {
  id: string
  ext: string
  mimeType: string
  sizeBytes: number
  /** base64 of the raw bytes. */
  data: string
}

export interface OmittedFile {
  id: string
  name: string
  sizeBytes: number
  why: string
}

export interface DeskBundle {
  format: typeof DESK_BUNDLE_FORMAT
  formatVersion: number
  exportedAt: string
  desk: { id: string; title: string }
  counts: Record<string, number>
  tables: Record<string, Array<Record<string, unknown>>>
  files: BundledFile[]
  filesOmitted: OmittedFile[]
}

/**
 * The tables a desk is made of, in an order that reads as the thing itself:
 * the nodes, what is on them, and what those things point at.
 */
const BUNDLED_TABLES = [
  'nodes',
  'widgets',
  'widget_links',
  'fb_tables',
  'fb_rows',
  'documents',
  'fb_files',
  'desk_layouts'
] as const

type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => unknown[]
    get: (...a: unknown[]) => unknown
    run: (...a: unknown[]) => { changes: number }
  }
  exec: (sql: string) => void
}

function columnsOf(db: Db, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((r) => r.name)
  } catch {
    return []
  }
}

const placeholders = (n: number): string => new Array(n).fill('?').join(', ')

/** The desk and everything filed under it. */
export function deskSubtreeIds(deskId: string): string[] {
  const rows = getDb()
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM nodes WHERE id = ?
         UNION
         SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
       )
       SELECT id FROM sub`
    )
    .all(deskId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * The file a widget is pointing at, as far as its stored content can say.
 *
 * Three shapes are in the wild for the same thing — a bare id, the desktop's
 * fb-file:// URL, and a JSON object — because three widgets learned to store a
 * file at three different times. Reading all three means a shared desk does not
 * lose its pictures depending on which widget put them there.
 *
 * What comes back is a CANDIDATE, not a verified id. Deciding by shape was the
 * first attempt and it was wrong: it tested bare content against a hex pattern,
 * so any id that did not look like a UUID was dropped without a word. The
 * fb_files table already knows which ids are real, so the caller asks it. Only
 * content that cannot be an id at all — empty, a URL, a data URI — is rejected
 * here.
 */
export function fileIdFromContent(content: string | null | undefined): string | null {
  const raw = (content ?? '').trim()
  if (!raw) return null
  if (raw.startsWith('fb-file://')) return raw.slice('fb-file://'.length).split(/[?#]/)[0] || null
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { fileId?: unknown }
      return typeof parsed.fileId === 'string' && parsed.fileId ? parsed.fileId : null
    } catch {
      return null
    }
  }
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return null
  return raw
}

/** Widget kinds whose content is a document id. */
const DOCUMENT_KINDS = new Set(['doc', 'sheet', 'slides', 'map', 'design'])
/** Widget kinds whose content points at a stored file. */
const FILE_KINDS = new Set(['file', 'image', 'video', 'pdf', 'audio'])

function selectIn(db: Db, table: string, column: string, ids: string[]): Array<Record<string, unknown>> {
  if (ids.length === 0 || columnsOf(db, table).length === 0) return []
  const out: Array<Record<string, unknown>> = []
  // Chunked so a large desk cannot exceed SQLite's variable limit.
  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400)
    try {
      out.push(
        ...(db
          .prepare(`SELECT * FROM "${table}" WHERE "${column}" IN (${placeholders(slice.length)})`)
          .all(...slice) as Array<Record<string, unknown>>)
      )
    } catch {
      return out
    }
  }
  return out
}

/** Pack a desk and everything on it. */
export async function buildDeskBundle(
  deskId: string,
  opts: { maxBytes?: number } = {}
): Promise<DeskBundle> {
  const db = getDb() as unknown as Db
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BUNDLE_BYTES

  const desk = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(deskId) as
    | { id: string; title: string }
    | undefined
  if (!desk) throw new Error(`no desk with id ${deskId}`)

  const nodeIds = deskSubtreeIds(deskId)
  const tables: Record<string, Array<Record<string, unknown>>> = {}

  tables.nodes = selectIn(db, 'nodes', 'id', nodeIds)
  tables.widgets = selectIn(db, 'widgets', 'task_id', nodeIds)
  tables.widget_links = selectIn(db, 'widget_links', 'task_id', nodeIds)
  tables.fb_tables = selectIn(db, 'fb_tables', 'task_id', nodeIds)
  tables.fb_rows = selectIn(
    db,
    'fb_rows',
    'table_id',
    tables.fb_tables.map((t) => String(t.id))
  )
  tables.desk_layouts = selectIn(db, 'desk_layouts', 'desk_id', nodeIds)

  // Documents and files are not filed under a desk; they are pointed at from it.
  const docIds: string[] = []
  const fileIds: string[] = []
  for (const w of tables.widgets) {
    const kind = String(w.kind ?? '')
    const content = w.content == null ? '' : String(w.content)
    if (DOCUMENT_KINDS.has(kind) && content) docIds.push(content)
    if (FILE_KINDS.has(kind)) {
      const id = fileIdFromContent(content)
      if (id) fileIds.push(id)
    }
  }
  tables.documents = selectIn(db, 'documents', 'id', [...new Set(docIds)])
  tables.fb_files = selectIn(db, 'fb_files', 'id', [...new Set(fileIds)])

  // Bytes, largest-last so a single huge file cannot crowd out everything small.
  const files: BundledFile[] = []
  const filesOmitted: OmittedFile[] = []
  const bySize = [...tables.fb_files].sort(
    (a, b) => Number(a.size_bytes ?? 0) - Number(b.size_bytes ?? 0)
  )
  let used = 0
  for (const row of bySize) {
    const id = String(row.id)
    const size = Number(row.size_bytes ?? 0)
    const name = String(row.display_name ?? row.original_name ?? id)
    if (used + size > maxBytes) {
      filesOmitted.push({ id, name, sizeBytes: size, why: 'the bundle is already at its size limit' })
      continue
    }
    let bytes: Uint8Array | null = null
    try {
      bytes = await fileBlobs.read(id, String(row.ext ?? ''))
    } catch {
      bytes = null
    }
    if (!bytes) {
      filesOmitted.push({ id, name, sizeBytes: size, why: 'the bytes are not on this device' })
      continue
    }
    files.push({
      id,
      ext: String(row.ext ?? ''),
      mimeType: String(row.mime_type ?? 'application/octet-stream'),
      sizeBytes: bytes.byteLength,
      data: toBase64(bytes)
    })
    used += bytes.byteLength
  }

  const counts: Record<string, number> = {}
  for (const [t, rows] of Object.entries(tables)) counts[t] = rows.length
  counts.fileBytes = used

  return {
    format: DESK_BUNDLE_FORMAT,
    formatVersion: DESK_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    desk: { id: desk.id, title: desk.title },
    counts,
    tables,
    files,
    filesOmitted
  }
}

export interface BundleImportResult {
  ok: boolean
  deskId?: string
  imported: number
  skipped: number
  filesWritten: number
  byTable: Record<string, { imported: number; skipped: number }>
  reason?: string
}

/**
 * Unpack a bundle into this runtime's database.
 *
 * Additive and column-tolerant, exactly as workspaceExport's importer is, and
 * for the same reasons: a row that already exists is skipped rather than
 * overwritten, and a column this build does not have is dropped rather than
 * thrown on. Foreign keys are deferred to COMMIT because rows arrive table by
 * table and a widget legitimately precedes nothing — its desk is in the same
 * transaction, just not yet written.
 */
export async function importDeskBundle(bundle: DeskBundle): Promise<BundleImportResult> {
  const empty = { ok: false, imported: 0, skipped: 0, filesWritten: 0, byTable: {} }
  if (bundle?.format !== DESK_BUNDLE_FORMAT) return { ...empty, reason: 'not a Plexii desk bundle' }
  if (bundle.formatVersion !== DESK_BUNDLE_VERSION) {
    return { ...empty, reason: `unsupported bundle version ${bundle.formatVersion}; this build reads version ${DESK_BUNDLE_VERSION}` }
  }

  const db = getDb() as unknown as Db
  const byTable: Record<string, { imported: number; skipped: number }> = {}
  let imported = 0
  let skipped = 0

  const run = (): void => {
    for (const table of BUNDLED_TABLES) {
      const rows = bundle.tables?.[table]
      if (!Array.isArray(rows) || rows.length === 0) continue
      const target = new Set(columnsOf(db, table))
      if (target.size === 0) continue
      const stat = { imported: 0, skipped: 0 }
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => target.has(c))
        if (cols.length === 0) continue
        const sql =
          `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
          `VALUES (${placeholders(cols.length)})`
        try {
          const info = db.prepare(sql).run(...cols.map((c) => row[c] as never))
          if (info.changes > 0) stat.imported++
          else stat.skipped++
        } catch {
          stat.skipped++
        }
      }
      byTable[table] = stat
      imported += stat.imported
      skipped += stat.skipped
    }
  }

  try {
    db.exec('BEGIN')
    db.exec('PRAGMA defer_foreign_keys = ON')
    run()
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already unwound */
    }
    return { ...empty, reason: `import failed and was rolled back: ${(e as Error).message}` }
  }

  // Bytes last, and outside the transaction: the blob store is not part of it,
  // and a desk whose rows landed is worth having even if one picture did not.
  let filesWritten = 0
  for (const f of bundle.files ?? []) {
    try {
      await fileBlobs.write(f.id, f.ext, fromBase64(f.data))
      filesWritten++
    } catch {
      /* the row is there; the widget will show it has no bytes */
    }
  }

  return { ok: true, deskId: bundle.desk?.id, imported, skipped, filesWritten, byTable }
}

// ── base64, without Buffer or a DOM ──────────────────────────────────────────
// btoa/atob are global in both modern Node and every browser this ships to, so
// one implementation serves both runtimes. Chunked because a single spread of a
// few hundred thousand arguments overflows the call limit.

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
