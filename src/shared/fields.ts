// ── Field type system ────────────────────────────────────────────────────────
//
// One typed value model used in three places:
//   1. Columns inside a Table widget (Airtable/Notion-style database)
//   2. Standalone Field widgets on the canvas (user's "free fields" idea)
//   3. Blocks inside a Page widget (future)
//
// The single registry means a "single-select with these options" looks and
// behaves identically whether it's a column in a table or a free widget on
// the desk. Adding a new type adds it everywhere at once.

export type FieldType =
  | 'text-short'
  | 'text-long'
  | 'text-rich' // formatted text (Tiptap)
  | 'number'
  | 'checkbox'
  | 'single-select'
  | 'multi-select'
  | 'date'
  | 'attachment' // references one or more fb_files entries
  | 'button' // programmable: runs a shell command or AI prompt
  | 'relation' // links to rows of another fb_tables table
  | 'doc-ref' // references one or more PlexiOffice documents (doc/sheet/slides/draw/design)

// Per-type config. Discriminated by `type` at runtime via a parent
// FieldDefinition so we never need to inspect this in isolation.
export interface SelectOption {
  id: string
  label: string
  // Tailwind-compatible accent for chip background. Optional — defaults pick from a palette.
  color?: string
}

export interface FieldConfigByType {
  'text-short': { placeholder?: string }
  'text-long': { placeholder?: string }
  'text-rich': { placeholder?: string }
  number: { precision?: number; prefix?: string; suffix?: string }
  checkbox: { label?: string }
  'single-select': { options: SelectOption[] }
  'multi-select': { options: SelectOption[] }
  date: { withTime?: boolean }
  attachment: { maxBytes?: number; acceptMime?: string[] }
  button: {
    action: 'shell' | 'ai-prompt'
    // For 'shell': a command line. For 'ai-prompt': the prompt template.
    payload: string
    // Display label on the button itself.
    label?: string
  }
  relation: {
    // The fb_tables.id this column links to. null = unbound (picker shows a
    // table-chooser instead of a row-chooser).
    tableId: string | null
    // Optional: which column of the linked table is the "primary" display
    // field (e.g. the row title). If null, the relation chip just shows the
    // row's short id.
    displayColumnId?: string | null
    // false = single-row, true = multi-row. We use a single value-shape
    // (string[]) for both so the storage layer stays uniform; UI enforces
    // the cardinality.
    multi?: boolean
  }
  'doc-ref': {
    // Optional restriction to a single office document kind (e.g. only sheets).
    // Empty = any office document may be referenced.
    docType?: string
    // false = one document, true = many. Stored as string[] either way.
    multi?: boolean
  }
}

// Type-safe field definition: the runtime value of `type` selects which
// shape of `config` we expect. TS narrows accordingly when you switch on
// `def.type`.
export type FieldDefinition = {
  [K in FieldType]: {
    id: string
    type: K
    label: string
    config: FieldConfigByType[K]
    // Display width hint for table columns. Ignored for standalone field
    // widgets, which size to their canvas dimensions.
    widthHint?: number
  }
}[FieldType]

// Value shapes — what gets stored as cells_json[colId] for each type.
export type FieldValueByType = {
  'text-short': string
  'text-long': string
  'text-rich': string // serialized Tiptap JSON
  number: number | null
  checkbox: boolean
  'single-select': string | null // SelectOption.id
  'multi-select': string[] // SelectOption.ids
  date: number | null // unix ms; if withTime=false, normalised to UTC midnight
  attachment: string[] // fb_files.id[]
  button: never // buttons don't store values; they have execution history elsewhere
  relation: string[] // fb_rows.id[] in the target table
  'doc-ref': string[] // documents.id[] (PlexiOffice documents)
}

export type FieldValue = FieldValueByType[FieldType]

// Sensible defaults so adding a new column / field doesn't require the user
// to configure everything before they can save.
export function defaultConfig<T extends FieldType>(type: T): FieldConfigByType[T] {
  switch (type) {
    case 'text-short':
    case 'text-long':
    case 'text-rich':
      return {} as FieldConfigByType[T]
    case 'number':
      return {} as FieldConfigByType[T]
    case 'checkbox':
      return {} as FieldConfigByType[T]
    case 'single-select':
    case 'multi-select':
      return { options: [] } as unknown as FieldConfigByType[T]
    case 'date':
      return { withTime: false } as unknown as FieldConfigByType[T]
    case 'attachment':
      return {} as FieldConfigByType[T]
    case 'button':
      return {
        action: 'shell',
        payload: '',
        label: 'Run'
      } as unknown as FieldConfigByType[T]
    case 'relation':
      return {
        tableId: null,
        displayColumnId: null,
        multi: true
      } as unknown as FieldConfigByType[T]
    case 'doc-ref':
      return { multi: true } as unknown as FieldConfigByType[T]
    default:
      return {} as FieldConfigByType[T]
  }
}

export function defaultValue<T extends FieldType>(type: T): FieldValueByType[T] {
  switch (type) {
    case 'text-short':
    case 'text-long':
    case 'text-rich':
      return '' as unknown as FieldValueByType[T]
    case 'number':
      return null as unknown as FieldValueByType[T]
    case 'checkbox':
      return false as unknown as FieldValueByType[T]
    case 'single-select':
      return null as unknown as FieldValueByType[T]
    case 'multi-select':
      return [] as unknown as FieldValueByType[T]
    case 'date':
      return null as unknown as FieldValueByType[T]
    case 'attachment':
      return [] as unknown as FieldValueByType[T]
    case 'button':
      return null as unknown as FieldValueByType[T]
    case 'relation':
      return [] as unknown as FieldValueByType[T]
    case 'doc-ref':
      return [] as unknown as FieldValueByType[T]
    default:
      return null as unknown as FieldValueByType[T]
  }
}

// Best-effort conversion of a stored cell value when a column's type changes.
// Keeps the value where the two shapes are compatible (plain text ↔ text,
// text ↔ number, date ↔ number) and otherwise resets to the new type's default
// rather than carrying a value the new type cannot interpret, such as a stale
// option id rendered as text. text-rich (Tiptap JSON) and the id-bearing types
// (selects, relation, attachment) never carry across a type change.
export function coerceFieldValue(from: FieldType, to: FieldType, value: unknown): unknown {
  if (from === to) return value
  if (value === null || value === undefined) return defaultValue(to)
  const plainText = (t: FieldType): boolean => t === 'text-short' || t === 'text-long'
  if (plainText(to)) {
    if (plainText(from) || from === 'number') return String(value)
    if (from === 'date' && typeof value === 'number') return new Date(value).toISOString().slice(0, 10)
    if (from === 'checkbox') return value ? 'true' : ''
    return defaultValue(to)
  }
  if (to === 'number') {
    if (from === 'number') return value
    if (plainText(from)) {
      const n = parseFloat(String(value))
      return Number.isFinite(n) ? n : null
    }
    if (from === 'date' && typeof value === 'number') return value
    if (from === 'checkbox') return value ? 1 : 0
    return null
  }
  if (to === 'date') {
    if (from === 'date' || (from === 'number' && typeof value === 'number')) return value
    if (plainText(from)) {
      const t = Date.parse(String(value))
      return Number.isNaN(t) ? null : t
    }
    return null
  }
  if (to === 'checkbox') {
    if (from === 'checkbox') return value
    if (from === 'number') return value !== 0
    if (plainText(from)) return String(value).trim().length > 0
    return false
  }
  // single-select, multi-select, attachment, relation, text-rich, button:
  // no safe carry-over from a different type — start clean.
  return defaultValue(to)
}

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  'text-short': 'Short text',
  'text-long': 'Long text',
  'text-rich': 'Rich text',
  number: 'Number',
  checkbox: 'Checkbox',
  'single-select': 'Single select',
  'multi-select': 'Multi-select',
  date: 'Date',
  attachment: 'Attachment',
  button: 'Button',
  relation: 'Related records',
  'doc-ref': 'Office file'
}

export const FIELD_TYPE_ICONS: Record<FieldType, string> = {
  'text-short': 'short_text',
  'text-long': 'subject',
  'text-rich': 'format_paragraph',
  number: 'numbers',
  checkbox: 'check_box',
  'single-select': 'radio_button_checked',
  'multi-select': 'checklist',
  date: 'calendar_today',
  attachment: 'attach_file',
  button: 'smart_button',
  relation: 'link',
  'doc-ref': 'description'
}

// ── Tables ──────────────────────────────────────────────────────────────────

export interface TableSchema {
  // Ordered list of column definitions. Order in this array == display order.
  columns: FieldDefinition[]
  // Display view. 'table' is the historic default and stays the implicit
  // fallback when this field is absent. Each non-table view can carry its
  // own configuration in `viewConfig` (which column drives kanban lanes,
  // calendar dates, etc.) — leaving viewConfig undefined uses auto-pick.
  viewMode?: TableViewMode
  viewConfig?: TableViewConfig
}

export type TableViewMode =
  | 'table'
  | 'list'
  | 'cards'
  | 'kanban'
  | 'calendar'
  | 'gantt'

export interface TableViewConfig {
  // Column shown as the title / primary label in card / list / kanban /
  // calendar / gantt views. Defaults to the first text-short column.
  titleColumnId?: string
  // For kanban: id of a single-select column used to group rows into lanes.
  // Each lane = one option of that select. If the column has no options or
  // the chosen column isn't a select, the view shows a configure hint.
  kanbanColumnId?: string
  // For calendar: id of a date column. Each row appears as an event on its
  // date. Multi-day support left for a later iteration.
  calendarColumnId?: string
  // For gantt: ids of start + end date columns. Bars span from start→end.
  ganttStartColumnId?: string
  ganttEndColumnId?: string
  // Row filtering. When present, only rows that satisfy the rule set are shown
  // across every view. Empty rules = no filtering. See tableFilter.ts for the
  // per-type operator catalogue and evaluation semantics.
  filter?: TableFilterConfig
  // Row grouping (table view). When columnId is set, the table view splits rows
  // into collapsible groups keyed by that column's value.
  group?: TableGroupConfig
}

// One predicate against one column. The shape of `value` depends on the
// operator + column type: a string for text/select-id, a number for
// number/date(ms), a string[] for the multi-select set operators, and absent
// for the no-argument operators (is-empty, is-checked, etc.).
export type FilterOperator =
  | 'is'
  | 'is-not'
  | 'contains'
  | 'not-contains'
  | 'is-empty'
  | 'is-not-empty'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'is-checked'
  | 'is-unchecked'
  | 'is-any-of'
  | 'has-all-of'
  | 'has-none-of'
  | 'before'
  | 'after'
  | 'on-or-before'
  | 'on-or-after'

export interface FilterRule {
  id: string
  columnId: string
  operator: FilterOperator
  value?: string | number | string[] | null
}

export interface TableFilterConfig {
  // 'and' = a row must satisfy every rule; 'or' = any one rule.
  conjunction: 'and' | 'or'
  rules: FilterRule[]
}

export interface TableGroupConfig {
  // Column whose value defines the groups. null/absent = no grouping.
  columnId: string | null
  // Group keys the user has collapsed (hidden rows for).
  collapsed?: string[]
  // Order of the groups themselves.
  direction?: 'asc' | 'desc'
}

export interface FbTable {
  id: string
  taskId: string | null
  title: string
  schema: TableSchema
  createdAt: number
  updatedAt: number
}

export interface FbTableDraft {
  // Optional client-provided id (WS01 sync substrate) so a create event is
  // idempotent by primary key across devices. Omitted for local creates.
  id?: string
  taskId: string | null
  title?: string
  schema?: TableSchema
}

export interface FbTablePatch {
  title?: string
  schema?: TableSchema
}

export interface FbRow {
  id: string
  tableId: string
  // cells maps a column id to its current value. Untouched columns are
  // missing keys, NOT null entries — that way we can add a new column without
  // having to backfill every existing row.
  cells: Record<string, unknown>
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface FbRowDraft {
  // Optional client-provided id (WS01 sync substrate) for idempotent create.
  id?: string
  tableId: string
  cells?: Record<string, unknown>
}

export interface FbRowPatch {
  cells?: Record<string, unknown>
  sortOrder?: number
}

// ── Files ───────────────────────────────────────────────────────────────────

export interface FbFile {
  id: string
  originalName: string
  mimeType: string
  sizeBytes: number
  ext: string
  // Absolute path on disk (read-only — main process owns the storage layout
  // under userData and is responsible for any future migrations).
  storedPath: string
  createdAt: number
}

// A single entry in the file/folder manager: a folder, an imported external
// file, or a reference to an internal document (doc/sheet/slides) filed into a
// folder. The manager lists these under a parent and the renderer renders them.
export interface FileEntry {
  id: string
  parentId: string | null
  kind: 'folder' | 'file' | 'doc'
  name: string
  ext?: string
  mimeType?: string
  sizeBytes?: number
  // For kind 'doc': the document it points at, resolved live so renames show.
  docId?: string
  docType?: 'doc' | 'sheet' | 'slides'
  // Number of immediate children (folders only) so the UI can show "3 items".
  childCount?: number
  createdAt: number
  updatedAt: number
}

export interface FbFileMetaOnly {
  // Same as FbFile but without the resolved storedPath. Used by ingest where
  // the renderer only needs to know "where is it filed" via id + ext.
  id: string
  originalName: string
  mimeType: string
  sizeBytes: number
  ext: string
  createdAt: number
}

// Broad classification used by the file widget to pick a renderer. We keep
// this in shared/ so renderer + main agree on the same buckets.
export type FileKind = 'image' | 'pdf' | 'video' | 'audio' | 'generic'

/**
 * The FileWidget's `widget.content` field can be either:
 *   - an `fb_files.id` (a UUID v4) — a locally ingested file, or
 *   - an external http(s) URL — a cloud link (Google Doc, Notion, Drive, etc.)
 *
 * No prefix, no migration: a UUID isn't a URL and a URL isn't a UUID, so we
 * discriminate by content shape. Empty content = uninitialised widget.
 */
export function isExternalUrlContent(content: string | null | undefined): boolean {
  if (!content) return false
  return /^https?:\/\//i.test(content.trim())
}

/**
 * Friendly hostname for a URL — used as the display label on cloud-link
 * widgets ("docs.google.com", "notion.so") in place of a filename. Returns
 * the raw string if URL parsing fails so the widget still has something to
 * show.
 */
export function hostnameForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function fileKindFromMime(mime: string, ext: string): FileKind {
  const e = ext.replace(/^\./, '').toLowerCase()
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(e)) {
    return 'image'
  }
  if (mime === 'application/pdf' || e === 'pdf') return 'pdf'
  if (mime.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v'].includes(e)) return 'video'
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(e)) return 'audio'
  return 'generic'
}

/**
 * The kind a File widget should RENDER a file as -- fileKindFromMime, except
 * that a PDF is only framed when its type AND its extension both say PDF.
 *
 * A PDF is the one kind shown in an <iframe>, which loads the bytes as a
 * document rather than as an image or a media stream. The two runtimes decide
 * what those bytes are differently: the desktop's fb-file:// protocol sends the
 * stored mime type, while the browser's file Service Worker (which has no
 * database) goes by the extension in the blob's name. A file from a share link
 * claiming `application/pdf` with an `.html` extension therefore arrived on the
 * share page as text/html -- a script-running page in the share site's own
 * origin, framed inside the desk. Requiring both to agree means whichever one a
 * runtime trusts, it is serving a PDF. Anything else falls back to the generic
 * preview, which never loads the bytes.
 */
export function fileRenderKind(mime: string, ext: string): FileKind {
  const kind = fileKindFromMime(mime, ext)
  if (kind !== 'pdf') return kind
  const e = ext.replace(/^\./, '').toLowerCase()
  return mime.toLowerCase() === 'application/pdf' && e === 'pdf' ? 'pdf' : 'generic'
}
