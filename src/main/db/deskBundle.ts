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
import { LINK_SHARE_BUNDLE_BUDGET, LINK_SHARE_LIMIT_WORDS, linkMegabytes, utf8Bytes } from '@shared/shareExpiry'

export const DESK_BUNDLE_FORMAT = 'plexii.desk'
export const DESK_BUNDLE_VERSION = 1

/** Total inlined bytes a bundle will carry before it starts leaving files out. */
export const DEFAULT_MAX_BUNDLE_BYTES = 80 * 1024 * 1024

/**
 * What a bundle is packed to unless the caller says otherwise: the link-share
 * budget, measured as the bundle will actually travel (see bundleBodyBytes).
 *
 * The default rather than an argument the share path passes, because the share
 * path is the only one there is: shares:buildDeskBundle is called by the link
 * mint and the link update and nothing else, and a default cannot be forgotten
 * by a future caller of that channel. tests/unit/shareLinkBudget.test.ts holds
 * the channel to that.
 */
export const DEFAULT_MAX_BODY_BYTES = LINK_SHARE_BUNDLE_BUDGET

/** Why a file was left out because the link could not carry it. */
export const OMITTED_FOR_SIZE = `a link can carry at most ${LINK_SHARE_LIMIT_WORDS}`
/** Why a file was left out because the raw-bytes budget (maxBytes) was spent. */
const OMITTED_AT_LIMIT = 'the bundle is already at its size limit'
/** Why a file was left out because its bytes are not here to send. */
const OMITTED_NOT_HERE = 'the bytes are not on this device'
/** The longest of the three, for reserving room to name a file that is left out. */
const LONGEST_OMISSION = [OMITTED_FOR_SIZE, OMITTED_AT_LIMIT, OMITTED_NOT_HERE].reduce((a, b) =>
  a.length >= b.length ? a : b
)

/**
 * How many bytes this bundle takes inside a link request.
 *
 * Not JSON.stringify(bundle).length. The renderer sends
 * JSON.stringify({ ..., bundle: JSON.stringify(bundle) }): the bundle is a JSON
 * string INSIDE another JSON document, so every quote and backslash in it is
 * escaped a second time, and the server counts UTF-8 bytes, not characters.
 * Measuring anything simpler undercounts a desk of rich text by a third.
 */
export function bundleBodyBytes(bundle: DeskBundle): number {
  return utf8Bytes(JSON.stringify(JSON.stringify(bundle)))
}

/**
 * What one array element adds to bundleBodyBytes, a separating comma included
 * (charged to the first element too, so the count errs high, never low).
 */
function elementBodyBytes(el: unknown): number {
  // The enclosing quotes of the outer stringify belong to the whole bundle, not
  // to this element: -2. The comma before it: +1.
  return utf8Bytes(JSON.stringify(JSON.stringify(el))) - 2 + 1
}

/** base64 of n bytes: four characters per three bytes, padded. Never escaped. */
const base64Length = (n: number): number => 4 * Math.ceil(n / 3)

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
// 'draw' belongs here for the same reason as 'design': a PlexiDraw widget's
// content IS a document id. Left out, a desk bundle carried the widget without
// the document behind it, so the drawing arrived empty on the other side.
const DOCUMENT_KINDS = new Set(['doc', 'sheet', 'slides', 'map', 'design', 'draw'])
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

/**
 * Pack a desk and everything on it.
 *
 * Two budgets, both optional:
 *   maxBytes      raw file bytes carried inline (DEFAULT_MAX_BUNDLE_BYTES)
 *   maxBodyBytes  the whole bundle as it travels in a link request
 *                 (bundleBodyBytes), DEFAULT_MAX_BODY_BYTES unless given
 *
 * Files are what give way: the smallest are packed first, so the ones left out
 * are the largest, each named in filesOmitted with the reason. A desk whose rows
 * alone are over maxBodyBytes cannot be helped by leaving files out, and is
 * refused with a sentence that says so rather than sent to be refused by the
 * server.
 */
export async function buildDeskBundle(
  deskId: string,
  opts: { maxBytes?: number; maxBodyBytes?: number } = {}
): Promise<DeskBundle> {
  const db = getDb() as unknown as Db
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BUNDLE_BYTES
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  const desk = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(deskId) as
    | { id: string; title: string }
    | undefined
  if (!desk) throw new Error(`no desk with id ${deskId}`)

  const nodeIds = deskSubtreeIds(deskId)
  const tables: Record<string, Array<Record<string, unknown>>> = {}

  // The shared desk arrives at the top level of the recipient's workspace.
  //
  // Its parent_id points at a folder in the SENDER's tree, and nodes.parent_id
  // is a real foreign key -- so a nested desk (half of them are) produced a
  // bundle that imported cleanly row by row and then failed at COMMIT with a
  // constraint error naming nothing in particular. Descendants keep their
  // parents, which are all in the bundle; only the root is re-homed.
  tables.nodes = selectIn(db, 'nodes', 'id', nodeIds).map((n) =>
    n.id === deskId ? { ...n, parent_id: null } : n
  )
  tables.widgets = selectIn(db, 'widgets', 'task_id', nodeIds)

  // A link is only carried when BOTH of its ends are. Its endpoints are foreign
  // keys onto widgets, and a link reaching a widget on a desk that is not being
  // shared would fail the same way -- at COMMIT, after everything looked fine.
  const widgetIds = new Set(tables.widgets.map((w) => String(w.id)))
  tables.widget_links = selectIn(db, 'widget_links', 'task_id', nodeIds).filter(
    (l) => widgetIds.has(String(l.source_widget_id)) && widgetIds.has(String(l.target_widget_id))
  )
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

  const counts: Record<string, number> = {}
  for (const [t, rows] of Object.entries(tables)) counts[t] = rows.length
  counts.fileBytes = 0

  const bundle: DeskBundle = {
    format: DESK_BUNDLE_FORMAT,
    formatVersion: DESK_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    desk: { id: desk.id, title: desk.title },
    counts,
    tables,
    files: [],
    filesOmitted: []
  }
  const { files, filesOmitted } = bundle

  // ── Fitting the files into the link ──
  //
  // `body` is what the bundle will weigh in the request (bundleBodyBytes), kept
  // as a running total that never undercounts: every array element is charged
  // a separating comma, the first included.
  //
  // Every file starts out with room RESERVED to name it in filesOmitted, at the
  // longest it could take. Deciding a file releases its reservation and spends
  // either the file or its (no larger) omitted entry. So a file that is left out
  // can always be named -- the sender is never told less than what was dropped.
  const bySize = [...tables.fb_files].sort(
    (a, b) => Number(a.size_bytes ?? 0) - Number(b.size_bytes ?? 0)
  )
  const rowFacts = bySize.map((row) => {
    const id = String(row.id)
    const name = String(row.display_name ?? row.original_name ?? id)
    return {
      id,
      name,
      size: Number(row.size_bytes ?? 0),
      ext: String(row.ext ?? ''),
      mimeType: String(row.mime_type ?? 'application/octet-stream'),
      reserved: elementBodyBytes({ id, name, sizeBytes: Number.MAX_SAFE_INTEGER, why: LONGEST_OMISSION })
    }
  })

  // fileBytes is measured at its widest, so filling it in cannot tip the scale.
  counts.fileBytes = Number.MAX_SAFE_INTEGER
  let body = bundleBodyBytes(bundle) + rowFacts.reduce((n, f) => n + f.reserved, 0)
  counts.fileBytes = 0
  if (body > maxBodyBytes) {
    throw new Error(
      `This desk is too large to send as a link, even without its files: the rest of it comes to ` +
        `${linkMegabytes(body)}, more than the ${linkMegabytes(maxBodyBytes)} of desk a link can carry ` +
        `(${LINK_SHARE_LIMIT_WORDS} in all). Move some of it to another desk and try again.`
    )
  }

  let used = 0
  for (const f of rowFacts) {
    body -= f.reserved
    const omit = (why: string, sizeBytes: number): void => {
      const entry: OmittedFile = { id: f.id, name: f.name, sizeBytes, why }
      filesOmitted.push(entry)
      body += elementBodyBytes(entry)
    }
    // What carrying n bytes of this file adds to the body.
    const cost = (n: number): number =>
      elementBodyBytes({ id: f.id, ext: f.ext, mimeType: f.mimeType, sizeBytes: n, data: '' }) + base64Length(n)

    // Judged first on what the row says it weighs, so a desk with a 2 GB video
    // does not read the video to find out it is too big...
    if (used + f.size > maxBytes) {
      omit(OMITTED_AT_LIMIT, f.size)
      continue
    }
    if (body + cost(f.size) > maxBodyBytes) {
      omit(OMITTED_FOR_SIZE, f.size)
      continue
    }
    let bytes: Uint8Array | null = null
    try {
      bytes = await fileBlobs.read(f.id, f.ext)
    } catch {
      bytes = null
    }
    if (!bytes) {
      omit(OMITTED_NOT_HERE, f.size)
      continue
    }
    // ...and then on the bytes, because the row is a record and the bytes are
    // the truth.
    const n = bytes.byteLength
    if (used + n > maxBytes) {
      omit(OMITTED_AT_LIMIT, n)
      continue
    }
    if (body + cost(n) > maxBodyBytes) {
      omit(OMITTED_FOR_SIZE, n)
      continue
    }
    files.push({ id: f.id, ext: f.ext, mimeType: f.mimeType, sizeBytes: n, data: toBase64(bytes) })
    body += cost(n)
    used += n
  }
  counts.fileBytes = used

  // The running total is built never to undercount; this measures the real
  // thing once, to prove it. If the two ever disagree, the largest file carried
  // gives way until they do not.
  while (bundleBodyBytes(bundle) > maxBodyBytes && files.length > 0) {
    let largest = 0
    for (let i = 1; i < files.length; i++) if (files[i].sizeBytes > files[largest].sizeBytes) largest = i
    const [gone] = files.splice(largest, 1)
    used -= gone.sizeBytes
    counts.fileBytes = used
    const name = rowFacts.find((f) => f.id === gone.id)?.name ?? gone.id
    filesOmitted.push({ id: gone.id, name, sizeBytes: gone.sizeBytes, why: OMITTED_FOR_SIZE })
  }
  if (bundleBodyBytes(bundle) > maxBodyBytes) {
    throw new Error(`This desk is too large to send as a link: ${OMITTED_FOR_SIZE}.`)
  }

  return bundle
}

/**
 * References in the bundle that point at something it does not contain.
 *
 * Deferring foreign keys to COMMIT is what lets rows arrive table by table, but
 * it also means a reference pointing OUT of the bundle surfaces as
 * "SQLITE_CONSTRAINT_FOREIGNKEY" at the very end, naming no table, no row and
 * no column. That message was a real dead end for a real recipient. This walks
 * the same three relationships SQLite would and says which row is unsatisfied.
 */
export function danglingReferences(bundle: DeskBundle): string[] {
  const t = bundle.tables ?? {}
  const ids = (table: string): Set<string> =>
    new Set((t[table] ?? []).map((r) => String(r.id)))
  const nodeIds = ids('nodes')
  const widgetIds = ids('widgets')
  const tableIds = ids('fb_tables')
  const out: string[] = []

  for (const n of t.nodes ?? []) {
    if (n.parent_id != null && !nodeIds.has(String(n.parent_id))) {
      out.push(`node ${n.id} ("${String(n.title ?? '')}") is filed under ${n.parent_id}, which is not in the bundle`)
    }
  }
  for (const w of t.widgets ?? []) {
    if (!nodeIds.has(String(w.task_id))) out.push(`widget ${w.id} belongs to desk ${w.task_id}, which is not in the bundle`)
  }
  for (const l of t.widget_links ?? []) {
    for (const end of ['source_widget_id', 'target_widget_id'] as const) {
      if (!widgetIds.has(String(l[end]))) out.push(`link ${l.id} reaches widget ${l[end]}, which is not in the bundle`)
    }
  }
  for (const r of t.fb_rows ?? []) {
    if (!tableIds.has(String(r.table_id))) out.push(`row ${r.id} belongs to table ${r.table_id}, which is not in the bundle`)
  }
  return out
}

// ── What a file from a bundle may be called ─────────────────────────────────
//
// A bundle is data from whoever made the link, and two of its fields are not
// just data: a file's `ext` becomes part of a NAME -- the blob's on OPFS, and on
// the desktop a real path, join(userData/files, id + ext) -- and its type is
// what the app decides how to show it by. A link that said `ext: '.html'`
// planted <id>.html in a visitor's browser, and the file Service Worker served
// that as a page of the share site's own origin (public/fb-file-sw.js). A
// `../` in an id or ext walks out of the files directory on the desktop.
//
// So on the way in, a file is held to a list. An extension the list knows keeps
// its name, and keeps the type it came with only when that type agrees with
// the name; otherwise it is given the name's own type. An extension the list
// does not know (.html, .js, .exe, .command, anything with a slash), or none at
// all, is renamed to the extension of its type when the type is one the list
// knows, and to .bin, application/octet-stream, when it is not -- except that
// a row with neither (a folder, a document) keeps neither, and an extensionless
// file of an unknown type stays extensionless, which the Service Worker can
// only ever serve as a download. A file whose id could be part of a path is
// not imported at all.

/**
 * Extensions a bundled file may keep, each with the types that agree with it.
 * The first type is the one a file is given when the type it came with does
 * not agree.
 */
export const BUNDLE_FILE_TYPES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['.png', ['image/png']],
  ['.jpg', ['image/jpeg', 'image/pjpeg']],
  ['.jpeg', ['image/jpeg', 'image/pjpeg']],
  ['.gif', ['image/gif']],
  ['.webp', ['image/webp']],
  ['.avif', ['image/avif']],
  ['.bmp', ['image/bmp', 'image/x-ms-bmp']],
  ['.ico', ['image/x-icon', 'image/vnd.microsoft.icon']],
  ['.heic', ['image/heic']],
  ['.heif', ['image/heif']],
  ['.tif', ['image/tiff']],
  ['.tiff', ['image/tiff']],
  // An SVG is kept: an <img> renders one without running it, and the file
  // Service Worker serves it as an attachment, so opening its URL downloads it.
  ['.svg', ['image/svg+xml']],
  ['.pdf', ['application/pdf']],
  ['.mp4', ['video/mp4']],
  ['.m4v', ['video/x-m4v', 'video/mp4']],
  ['.mov', ['video/quicktime']],
  ['.webm', ['video/webm', 'audio/webm']],
  ['.ogv', ['video/ogg']],
  ['.mp3', ['audio/mpeg', 'audio/mp3']],
  ['.wav', ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']],
  ['.ogg', ['audio/ogg', 'video/ogg', 'application/ogg']],
  ['.oga', ['audio/ogg']],
  ['.opus', ['audio/ogg', 'audio/opus']],
  ['.m4a', ['audio/mp4', 'audio/x-m4a', 'audio/m4a']],
  ['.aac', ['audio/aac', 'audio/x-aac']],
  ['.flac', ['audio/flac', 'audio/x-flac']],
  ['.weba', ['audio/webm']],
  ['.txt', ['text/plain']],
  ['.md', ['text/markdown', 'text/x-markdown', 'text/plain']],
  ['.csv', ['text/csv', 'application/vnd.ms-excel', 'text/plain']],
  ['.tsv', ['text/tab-separated-values', 'text/plain']],
  ['.json', ['application/json']],
  ['.rtf', ['application/rtf', 'text/rtf']],
  ['.doc', ['application/msword']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.xls', ['application/vnd.ms-excel']],
  ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['.ppt', ['application/vnd.ms-powerpoint']],
  ['.pptx', ['application/vnd.openxmlformats-officedocument.presentationml.presentation']],
  ['.odt', ['application/vnd.oasis.opendocument.text']],
  ['.ods', ['application/vnd.oasis.opendocument.spreadsheet']],
  ['.odp', ['application/vnd.oasis.opendocument.presentation']],
  ['.key', ['application/vnd.apple.keynote', 'application/x-iwork-keynote-sffkey']],
  ['.pages', ['application/vnd.apple.pages', 'application/x-iwork-pages-sffpages']],
  ['.numbers', ['application/vnd.apple.numbers', 'application/x-iwork-numbers-sffnumbers']],
  ['.epub', ['application/epub+zip']],
  ['.zip', ['application/zip', 'application/x-zip-compressed']]
])

/**
 * The extension a file of this type is renamed to: the first that has it as its
 * own (first) type, else the first that accepts it at all -- so
 * application/vnd.ms-excel is an .xls, not the .csv that also accepts it.
 */
const EXT_FOR_TYPE: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>()
  for (const [ext, types] of BUNDLE_FILE_TYPES) if (!out.has(types[0])) out.set(types[0], ext)
  for (const [ext, types] of BUNDLE_FILE_TYPES) for (const t of types) if (!out.has(t)) out.set(t, ext)
  return out
})()

/** What a file whose name and type are both unknown becomes. */
export const FALLBACK_FILE_EXT = '.bin'
export const FALLBACK_FILE_TYPE = 'application/octet-stream'

/**
 * What a file id may be. Every path that makes one makes a UUID; this admits
 * any id of letters, digits, '-' and '_' and nothing that could be part of a
 * path ('/', '\', '.') or confuse the Service Worker's "<id>." prefix match.
 */
export const SAFE_FILE_ID = /^[A-Za-z0-9_-]{1,200}$/

/** "Image/PNG; charset=x" is image/png. Parameters and case are not the type. */
function bareType(raw: unknown): string {
  return typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : ''
}

/**
 * The extension and type a file from a bundle is stored under.
 *
 * Pure, and the one place the rule lives: importDeskBundle applies it to every
 * fb_files row before the row is written, and names the bytes by the result.
 */
export function safeBundledFileType(ext: unknown, mimeType: unknown): { ext: string; mimeType: string } {
  const e = typeof ext === 'string' ? ext.trim().toLowerCase() : ''
  const type = bareType(mimeType)
  const agrees = e === '' ? undefined : BUNDLE_FILE_TYPES.get(e)
  if (agrees) return { ext: e, mimeType: agrees.includes(type) ? type : agrees[0] }
  // No extension, or one the list does not know. The type, if the list knows
  // it, says what the file claims to be, and the name follows the type: the
  // bytes are only ever served as that type, never as what the old name said.
  const renamed = EXT_FOR_TYPE.get(type)
  if (renamed) return { ext: renamed, mimeType: type }
  // Folders and documents have neither a name nor a type, and keep neither.
  if (e === '' && type === '') return { ext: '', mimeType: '' }
  // An extensionless file of a type the list does not know stays extensionless
  // -- nothing after the id can only ever be served as a download -- and is
  // typed as what it is to this app: bytes.
  if (e === '') return { ext: '', mimeType: FALLBACK_FILE_TYPE }
  return { ext: FALLBACK_FILE_EXT, mimeType: FALLBACK_FILE_TYPE }
}

/**
 * An fb_files row as it may be written: its ext and mime_type held to the list,
 * or null when its id is not one a file may have (the row is skipped, and its
 * widget shows a file that is not here).
 */
function safeFileRow(row: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof row.id !== 'string' || !SAFE_FILE_ID.test(row.id)) return null
  const safe = safeBundledFileType(row.ext, row.mime_type)
  return { ...row, ext: safe.ext, mime_type: safe.mimeType }
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
  // The fb_files rows this import wrote, as opposed to rows that were already
  // here and were left alone (INSERT OR IGNORE).
  const newFiles = new Set<string>()

  const run = (): void => {
    for (const table of BUNDLED_TABLES) {
      const rows = bundle.tables?.[table]
      if (!Array.isArray(rows) || rows.length === 0) continue
      const target = new Set(columnsOf(db, table))
      if (target.size === 0) continue
      const stat = { imported: 0, skipped: 0 }
      for (const raw of rows) {
        // A file's name and type are held to the list before the row is
        // written (safeBundledFileType); a file whose id could be a path is
        // not written at all.
        const row = table === 'fb_files' ? safeFileRow(raw) : raw
        if (!row) {
          stat.skipped++
          continue
        }
        const cols = Object.keys(row).filter((c) => target.has(c))
        if (cols.length === 0) continue
        const sql =
          `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
          `VALUES (${placeholders(cols.length)})`
        try {
          const info = db.prepare(sql).run(...cols.map((c) => row[c] as never))
          if (info.changes > 0) {
            stat.imported++
            if (table === 'fb_files') newFiles.add(String(row.id))
          } else stat.skipped++
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
    // Say what is actually wrong. The raw constraint error names nothing.
    const dangling = danglingReferences(bundle)
    const detail = dangling.length
      ? ` — ${dangling.length} reference${dangling.length === 1 ? '' : 's'} point outside this desk: ${dangling.slice(0, 3).join('; ')}${dangling.length > 3 ? `; and ${dangling.length - 3} more` : ''}`
      : ''
    return { ...empty, reason: `import failed and was rolled back: ${(e as Error).message}${detail}` }
  }

  // Bytes last, and outside the transaction: the blob store is not part of it,
  // and a desk whose rows landed is worth having even if one picture did not.
  //
  // Named by the ROW, not by the bundle's own `ext` beside the bytes: the row is
  // row.ext)), and it has been held to the list on the way in. So bytes are
  // written only for a file that has a row here, under a name that passes the
  // list -- never for a file the bundle does not describe, and never under a
  // name an older import let through.
  //
  // And bytes already here are not replaced. A row that was here before this
  // import is left alone by INSERT OR IGNORE, and so are its bytes: on the
  // desktop that row is the recipient's OWN file, and a desk file carrying its
  // id must not be able to swap what is in it. Only a missing blob is filled.
  const fileRow = (id: string): { ext: unknown; mime_type: unknown } | undefined => {
    try {
      return db.prepare('SELECT ext, mime_type FROM fb_files WHERE id = ?').get(id) as
        | { ext: unknown; mime_type: unknown }
        | undefined
    } catch {
      return undefined
    }
  }
  let filesWritten = 0
  for (const f of bundle.files ?? []) {
    try {
      if (typeof f?.id !== 'string' || !SAFE_FILE_ID.test(f.id)) continue
      const row = fileRow(f.id)
      if (!row || typeof row.ext !== 'string') continue
      if (safeBundledFileType(row.ext, row.mime_type).ext !== row.ext) continue
      if (!newFiles.has(f.id) && (await fileBlobs.exists(f.id, row.ext))) continue
      await fileBlobs.write(f.id, row.ext, fromBase64(f.data))
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
